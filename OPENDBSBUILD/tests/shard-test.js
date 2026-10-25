// Sharding test: a router + 3 shard servers (real processes). Every result on the
// sharded rack is compared with an unsharded copy of the same data on the router.
// Usage: node shard-test.js <dist/index.js>
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ENTRY = path.resolve(process.argv[2]);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'opendbs-shard-'));
const BASE = 48000 + Math.floor(Math.random() * 400) * 4;
const [R, S1, S2, S3] = [BASE, BASE + 1, BASE + 2, BASE + 3];
const url = (p) => `http://127.0.0.1:${p}`;
const PW = 'Adm1nPassw0rd!';
const procs = {};
let passed = 0, failed = 0;
const check = (ok, name, extra) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✔' : '✘'} ${name}${!ok && extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startNode(port) {
    const dir = path.join(ROOT, `n${port}`);
    fs.mkdirSync(dir, { recursive: true });
    const env = {
        ...process.env, NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'data'),
        BACKUP_PATH: path.join(dir, 'backups'), BACKUP_ENABLED: 'false', ADMIN_PASSWORD: PW, WEB_INTERFACE_ENABLED: 'false',
        ADMIN_PANEL_ENABLED: 'true', LOG_LEVEL: 'warn', RATE_LIMIT_MAX: '100000', JWT_SECRET: '', CLUSTER_ENABLED: 'false',
    };
    const p = spawn(process.execPath, [ENTRY], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(dir, 'server.log'), { flags: 'a' });
    p.stdout.pipe(log); p.stderr.pipe(log);
    procs[port] = p;
}

const tokens = {};
async function api(port, method, p, body, headers = {}) {
    try {
        const r = await fetch(url(port) + p, {
            method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(tokens[port] ? { authorization: `Bearer ${tokens[port]}` } : {}), ...headers },
            body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000),
        });
        let data = null;
        try { data = await r.json(); } catch { /* empty */ }
        return { status: r.status, data };
    } catch (e) {
        return { status: 0, data: { error: e.message } };
    }
}
async function waitFor(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
    throw new Error(`timeout waiting for ${what}`);
}
async function up(port) {
    await waitFor(async () => (await api(port, 'GET', '/health')).status === 200, 30000, `node ${port}`);
    tokens[port] = (await api(port, 'POST', '/api/auth/login', { username: 'admin', password: PW })).data?.token;
}

const strip = (rows) => rows.map((r) => { const c = { ...r }; delete c.id; delete c._metadata; return c; });
const byN = (a, b) => a.n - b.n;
// Floating-point sums depend on addition order (per shard, then merged): compare to ~1e-9.
const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(10)) : Array.isArray(v) ? v.map(round) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);
const same = (a, b) => JSON.stringify(round(a)) === JSON.stringify(round(b));
const sql = (query, params) => api(R, 'POST', '/api/sql/query', { query, database: 'shop', params });
async function sqlBoth(q, name, { sort } = {}) {
    const a = await sql(q.replace(/\{T\}/g, 'orders'));
    const b = await sql(q.replace(/\{T\}/g, 'orders_ref'));
    const ra = strip(a.data?.result ?? a.data?.results?.[0]?.result ?? []);
    const rb = strip(b.data?.result ?? b.data?.results?.[0]?.result ?? []);
    if (sort) { ra.sort(sort); rb.sort(sort); }
    check(a.status === 200 && b.status === 200 && same(ra, rb), name, { a: a.status === 200 ? ra.slice(0, 3) : a.data, b: b.status === 200 ? rb.slice(0, 3) : b.data });
    return ra;
}

(async () => {
    try {
        console.log(`shard test: router ${R}, shards ${S1} ${S2} ${S3}`);
        [R, S1, S2, S3].forEach(startNode);
        await Promise.all([R, S1, S2, S3].map(up));
        const keys = {};
        for (const s of [S1, S2, S3]) {
            const k = await api(s, 'POST', '/api/admin/access-keys', { name: 'router', permissions: { '*': ['read', 'write', 'delete'] }, allowedIps: ['*'] });
            keys[s] = k.data?.key;
        }
        check(Object.values(keys).every(Boolean), 'access keys created on the shards');

        console.log('— setup');
        let r = await api(R, 'POST', '/api/admin/sharding/shards', { name: 's1', urls: url(S1), apiKey: 'x'.repeat(40) });
        check(r.status >= 400, 'adding a shard with a wrong key fails', r);
        for (const [n, p] of [['s1', S1], ['s2', S2], ['s3', S3]]) {
            r = await api(R, 'POST', '/api/admin/sharding/shards', { name: n, urls: url(p), apiKey: keys[p] });
            check(r.status === 200, `shard ${n} added`, r);
        }
        r = await api(R, 'POST', '/api/admin/sharding/racks', { database: 'shop', rack: 'orders', key: 'customer', shards: ['local', 's1', 's2'] });
        check(r.status === 200 && r.data.shards.length === 3, 'sharded rack shop/orders (key customer) on local, s1, s2', r);
        r = await api(R, 'POST', '/api/admin/sharding/racks', { database: 'shop', rack: 'orders', key: 'customer', shards: ['s1'] });
        check(r.status === 409, 'sharding the same rack twice is refused', r);
        await api(R, 'POST', '/api/databases/shop/racks', { name: 'orders_ref' });
        await sql('CREATE TABLE customers (cid INTEGER, name VARCHAR(40), tier VARCHAR(10))');
        await sql(`INSERT INTO customers (cid, name, tier) VALUES ${Array.from({ length: 100 }, (_, i) => `(${i}, 'cust${i}', '${i % 3 === 0 ? 'gold' : 'std'}')`).join(',')}`);

        const statuses = ['new', 'paid', 'shipped', 'cancelled'];
        const docs = Array.from({ length: 3000 }, (_, n) => ({
            n, customer: n % 100, amount: Math.round(((n * 7919) % 1000) / 10 * 100) / 100, status: statuses[n % 4],
            ...(n % 10 === 0 ? { tags: ['vip', `t${n % 7}`] } : {}), ...(n % 17 === 0 ? { note: null } : {}), ...(n % 250 === 0 ? { customer: undefined } : {}),
        })).map((d) => JSON.parse(JSON.stringify(d)));
        for (let i = 0; i < docs.length; i += 500) {
            const a = await api(R, 'POST', '/api/databases/shop/racks/orders/documents', docs.slice(i, i + 500));
            const b = await api(R, 'POST', '/api/databases/shop/racks/orders_ref/documents', docs.slice(i, i + 500));
            if (a.status !== 201 || b.status !== 201) { check(false, 'batch insert', { a: a.data, b: b.data }); break; }
        }
        r = await api(R, 'GET', '/api/databases/shop/racks/orders/count');
        check(r.data?.count === 3000, 'count over all shards = 3000', r.data);
        r = await api(R, 'GET', '/api/admin/sharding/racks/shop/orders');
        const per = Object.fromEntries((r.data?.shards ?? []).map((s) => [s.shard, s.documents]));
        check(per.local > 500 && per.s1 > 500 && per.s2 > 500 && per.local + per.s1 + per.s2 === 3000, 'documents spread over the 3 shards', per);
        const direct = await api(S1, 'GET', '/api/databases/shop/racks/orders/count');
        check(direct.data?.count === per.s1, 'shard s1 really holds its share', direct.data);

        console.log('— queries (vs unsharded copy)');
        const cmpQuery = async (name, body) => {
            const a = await api(R, 'POST', '/api/databases/shop/racks/orders/search', body);
            const b = await api(R, 'POST', '/api/databases/shop/racks/orders_ref/search', body);
            const ra = strip(a.data?.results ?? []), rb = strip(b.data?.results ?? []);
            if (!body.sort) { ra.sort(byN); rb.sort(byN); }
            check(a.status === 200 && same(ra, rb) && a.data.total === b.data.total, name, { a: a.data?.error ?? ra.slice(0, 2), b: rb.slice(0, 2), ta: a.data?.total, tb: b.data?.total });
        };
        await cmpQuery('filter', { query: { status: 'paid', amount: { $gt: 50 } } });
        await cmpQuery('sort desc + limit', { query: { status: 'paid' }, sort: { field: 'amount', order: 'desc' }, limit: 25 });
        await cmpQuery('sort + skip + limit (paging)', { query: {}, sort: { field: 'amount', order: 'asc' }, skip: 100, limit: 50 });
        await cmpQuery('sort on a field some docs lack', { query: {}, sort: { field: 'note', order: 'asc' }, limit: 30 });
        await cmpQuery('shard-key equality (one shard)', { query: { customer: 42 } });
        await cmpQuery('shard-key $in', { query: { customer: { $in: [1, 2, 3] } }, sort: { field: 'n', order: 'desc' } });
        await cmpQuery('missing shard key ($exists false)', { query: { customer: { $exists: false } } });
        await cmpQuery('array field', { query: { tags: 'vip' }, sort: { field: 'n', order: 'asc' }, limit: 40 });
        r = await api(R, 'GET', '/api/databases/shop/racks/orders/documents?status=new&_sort=amount&_order=desc&_limit=5');
        const r2 = await api(R, 'GET', '/api/databases/shop/racks/orders_ref/documents?status=new&_sort=amount&_order=desc&_limit=5');
        check(same(strip(r.data.results), strip(r2.data.results)) && r.data.total === r2.data.total, 'GET …/documents with query string', r.data);
        r = await api(R, 'POST', '/api/databases/shop/racks/orders/search/range', { field: 'amount', min: 10, max: 11 });
        check(r.status === 200 && r.data.count === docs.filter((d) => d.amount >= 10 && d.amount <= 11).length, 'range search', r.data?.count);
        const pipe = [{ $match: { status: 'shipped' } }, { $group: { _id: '$customer', total: { $sum: '$amount' }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }];
        const pa = await api(R, 'POST', '/api/databases/shop/racks/orders/aggregate', { pipeline: pipe });
        const pb = await api(R, 'POST', '/api/databases/shop/racks/orders_ref/aggregate', { pipeline: pipe });
        check(pa.status === 200 && same(pa.data.results, pb.data.results), 'aggregation pipeline', { a: pa.data?.results?.slice(0, 2) ?? pa.data, b: pb.data?.results?.slice(0, 2) });

        console.log('— documents by id');
        const one = (await api(R, 'POST', '/api/databases/shop/racks/orders/search', { query: { n: 1234 } })).data.results[0];
        r = await api(R, 'GET', `/api/databases/shop/racks/orders/documents/${one.id}`);
        check(r.status === 200 && r.data.n === 1234, 'get by id', r.data);
        r = await api(R, 'PATCH', `/api/databases/shop/racks/orders/documents/${one.id}`, { status: 'refunded' });
        check(r.status === 200, 'patch by id', r.data);
        r = await api(R, 'GET', `/api/databases/shop/racks/orders/documents/${one.id}`);
        check(r.data?.status === 'refunded', 'patched value read back', r.data);
        r = await api(R, 'PUT', `/api/databases/shop/racks/orders/documents/${one.id}`, { n: 1234, customer: one.customer, amount: 1, status: 'replaced' });
        check(r.status === 200 && r.data.upserted === false, 'put (replace) keeps the id', r.data);
        r = await api(R, 'PATCH', `/api/databases/shop/racks/orders/documents/${one.id}`, { customer: (one.customer + 1) % 100 });
        check(r.status === 400 && /shard key/.test(r.data?.error), 'changing the shard key is refused', r.data);
        r = await api(R, 'GET', '/api/databases/shop/racks/orders/documents/99999999');
        check(r.status === 404, 'missing id → 404', r);
        r = await api(R, 'POST', '/api/databases/shop/racks/orders/documents', { n: 9000, customer: 7, amount: 5, status: 'new' });
        const newId = r.data?.id;
        r = await api(R, 'DELETE', `/api/databases/shop/racks/orders/documents/${newId}`);
        check(r.status === 200, 'insert + delete by id', r.data);
        // Bring the reference copy to the same state.
        const refOne = (await api(R, 'POST', '/api/databases/shop/racks/orders_ref/search', { query: { n: 1234 } })).data.results[0];
        await api(R, 'PUT', `/api/databases/shop/racks/orders_ref/documents/${refOne.id}`, { n: 1234, customer: one.customer, amount: 1, status: 'replaced' });

        console.log('— SQL');
        await sqlBoth('SELECT customer, COUNT(*) AS c, SUM(amount) AS s, AVG(amount) AS a, MIN(amount) AS mn, MAX(amount) AS mx FROM {T} GROUP BY customer ORDER BY customer', 'GROUP BY over shards (partial aggregates)');
        await sqlBoth("SELECT status, COUNT(*) AS c, STDDEV(amount) AS sd FROM {T} WHERE amount > 20 AND status <> 'new' GROUP BY status ORDER BY status", 'GROUP BY with WHERE');
        await sqlBoth("SELECT status, COUNT(*) AS c FROM {T} WHERE LOWER(status) LIKE '%ped' OR amount BETWEEN 3 AND 4 GROUP BY status ORDER BY status", 'GROUP BY with a WHERE run on the shards');
        await sqlBoth('SELECT COUNT(*) AS c, COUNT(DISTINCT customer) AS dc FROM {T}', 'COUNT / COUNT DISTINCT');
        await sqlBoth('SELECT n, amount FROM {T} WHERE status = \'paid\' ORDER BY amount DESC, n LIMIT 15', 'ORDER BY + LIMIT');
        await sqlBoth('SELECT c.tier, COUNT(*) AS orders, ROUND(SUM(o.amount), 2) AS total FROM {T} o JOIN customers c ON c.cid = o.customer GROUP BY c.tier ORDER BY c.tier', 'JOIN sharded × unsharded');
        await sqlBoth('SELECT customer, GROUP_CONCAT(n ORDER BY n) AS ns FROM {T} WHERE customer IN (5, 6) GROUP BY customer ORDER BY customer', 'non-mergeable aggregate (GROUP_CONCAT)');
        await sqlBoth('SELECT n, amount, RANK() OVER (PARTITION BY customer ORDER BY amount DESC, n) AS rk FROM {T} WHERE customer = 9 ORDER BY n', 'window function');
        await sqlBoth('SELECT customer FROM {T} WHERE amount > 99 UNION SELECT customer FROM {T} WHERE amount < 0.5 ORDER BY customer', 'UNION');
        let a = await sql("UPDATE orders SET status = 'bulk' WHERE customer = 3 AND amount > 50");
        let b = await sql("UPDATE orders_ref SET status = 'bulk' WHERE customer = 3 AND amount > 50");
        check(a.status === 200 && a.data.result?.affectedRows === b.data.result?.affectedRows && b.data.result?.affectedRows > 0, 'UPDATE … WHERE', { a: a.data, b: b.data });
        a = await sql('DELETE FROM orders WHERE customer = 4 AND amount < 30');
        b = await sql('DELETE FROM orders_ref WHERE customer = 4 AND amount < 30');
        check(a.status === 200 && a.data.result?.affectedRows === b.data.result?.affectedRows && b.data.result?.affectedRows > 0, 'DELETE … WHERE', { a: a.data, b: b.data });
        a = await sql("INSERT INTO orders (n, customer, amount, status) VALUES (5000, 11, 12.5, 'sql'), (5001, 12, 13.5, 'sql'), (5002, 13, 14.5, 'sql') RETURNING n, customer");
        b = await sql("INSERT INTO orders_ref (n, customer, amount, status) VALUES (5000, 11, 12.5, 'sql'), (5001, 12, 13.5, 'sql'), (5002, 13, 14.5, 'sql')");
        check(a.status === 200 && a.data.result?.length === 3, 'INSERT … VALUES … RETURNING', a.data);
        a = await sql("INSERT INTO orders (n, customer, amount, status) SELECT n + 10000, customer, amount, 'copy' FROM orders WHERE customer = 20");
        b = await sql("INSERT INTO orders_ref (n, customer, amount, status) SELECT n + 10000, customer, amount, 'copy' FROM orders_ref WHERE customer = 20");
        check(a.status === 200 && a.data.result?.affectedRows === b.data.result?.affectedRows, 'INSERT … SELECT from the sharded table', a.data);
        await sqlBoth('SELECT status, COUNT(*) AS c, SUM(amount) AS s FROM {T} GROUP BY status ORDER BY status', 'state equal after SQL DML');
        a = await sql("BEGIN; INSERT INTO orders (n, customer) VALUES (1, 1); COMMIT");
        check(a.status === 400 && /sharded/.test(a.data?.error), 'BEGIN … COMMIT writing a sharded table is refused', a.data);
        a = await api(R, 'POST', '/api/transactions', { database: 'shop', operations: [{ op: 'insert', rack: 'orders', data: {} }] });
        check(a.status === 400 && /sharded/.test(a.data?.error), '/api/transactions on a sharded rack is refused', a.data);
        a = await sql('CREATE INDEX ON orders (status)');
        const ix = await api(S2, 'GET', '/api/databases/shop/racks/orders/indexes');
        check(a.status === 200 && ix.data?.indexes?.includes('status'), 'CREATE INDEX reaches every shard', { a: a.data, ix: ix.data });

        console.log('— SQL table sharded by id');
        r = await api(R, 'POST', '/api/admin/sharding/racks', { database: 'shop', rack: 'items', type: 'sql', schema: { sku: { type: 'string', required: true }, qty: { type: 'integer' } }, shards: ['s1', 's2', 's3'] });
        check(r.status === 200, 'sharded SQL table', r.data);
        a = await sql(`INSERT INTO items (sku, qty) VALUES ${Array.from({ length: 300 }, (_, i) => `('sku${i}', ${i})`).join(',')}`);
        check(a.status === 200 && a.data.result?.affectedRows === 300, 'bulk INSERT into a sharded SQL table', a.data);
        a = await sql('SELECT COUNT(*) AS c, SUM(qty) AS s FROM items');
        check(a.data?.result?.[0]?.c === 300 && a.data.result[0].s === 44850, 'SUM over a sharded SQL table', a.data);
        const s3items = await api(S3, 'GET', '/api/databases/shop/racks/items/count');
        check(s3items.data?.count > 50, 'items spread by id (s3 has its share)', s3items.data);
        a = await sql('ALTER TABLE items ADD COLUMN price DECIMAL(10,2)');
        const sch = await api(S1, 'GET', '/api/databases/shop/racks/items/schema');
        check(a.status === 200 && sch.data?.schema?.price, 'ALTER TABLE reaches every shard', { a: a.data, sch: sch.data });
        a = await sql("SELECT sku, qty FROM items WHERE qty >= 295 ORDER BY id");
        check(a.data?.result?.map((x) => x.qty).join(',') === '295,296,297,298,299', 'ORDER BY id keeps insert order', a.data);
        a = await sql("INSERT INTO items (qty) VALUES (1)");
        check(a.status === 400, 'shard validates the schema (required column)', a.data);

        console.log('— rebalance onto s3 under load');
        let stop = false, readErrors = 0, reads = 0, writesOk = 0, writes503 = 0;
        const reader = (async () => {
            while (!stop) {
                const x = await api(R, 'POST', '/api/databases/shop/racks/orders/search', { query: { status: 'shipped' }, limit: 1 });
                reads++;
                if (x.status !== 200) readErrors++;
            }
        })();
        const writer = (async () => {
            let i = 0;
            while (!stop) {
                const doc = { n: 20000 + i, customer: i % 100, amount: 1, status: 'live' };
                const x = await api(R, 'POST', '/api/databases/shop/racks/orders/documents', doc);
                if (x.status === 201) { writesOk++; await api(R, 'POST', '/api/databases/shop/racks/orders_ref/documents', doc); i++; } else if (x.status === 503) { writes503++; await sleep(50); } else { readErrors++; }
            }
        })();
        await sleep(300);
        r = await api(R, 'POST', '/api/admin/sharding/racks/shop/orders/rebalance', { shards: ['local', 's1', 's2', 's3'] });
        await sleep(300);
        stop = true;
        await Promise.all([reader, writer]);
        check(r.status === 200 && r.data.moved > 0 && r.data.removedFromOldShards === r.data.moved, 'rebalance moved buckets and cleaned up', r.data);
        check(readErrors === 0 && reads > 0 && writesOk > 0, `reads kept working (${reads} reads, ${writesOk} writes, ${writes503} paused writes)`, { readErrors });
        r = await api(R, 'GET', '/api/admin/sharding/racks/shop/orders');
        const per2 = Object.fromEntries((r.data?.shards ?? []).map((s) => [s.shard, s.documents]));
        const refCount = (await api(R, 'GET', '/api/databases/shop/racks/orders_ref/count')).data.count;
        check(Object.keys(per2).length === 4 && per2.s3 > 0 && Object.values(per2).reduce((x, y) => x + y, 0) === refCount, 'no duplicates or losses after the move', { per2, refCount });
        await sqlBoth('SELECT customer, COUNT(*) AS c, SUM(amount) AS s FROM {T} GROUP BY customer ORDER BY customer', 'GROUP BY equal after rebalance');
        await cmpQuery('sorted query equal after rebalance', { query: {}, sort: { field: 'amount', order: 'desc' }, limit: 100 });

        console.log('— rebalance off this server');
        r = await api(R, 'POST', '/api/admin/sharding/racks/shop/orders/rebalance', { shards: ['s1', 's2', 's3'] });
        check(r.status === 200, 'moved everything off "local"', r.data);
        const localScan = (await api(R, 'POST', '/api/shard/shop/orders/bucket-scan', { buckets: Array.from({ length: 4096 }, (_, i) => i), after: null, limit: 5000 })).data;
        const localCount = localScan?.done ? localScan.docs.length : -1;
        check(localCount === 0, 'router holds no documents now', localCount);
        await sqlBoth('SELECT status, COUNT(*) AS c, SUM(amount) AS s FROM {T} GROUP BY status ORDER BY status', 'results unchanged');

        console.log('— shard failure');
        procs[S2].kill('SIGKILL');
        await sleep(500);
        r = await api(R, 'POST', '/api/databases/shop/racks/orders/search', { query: {} , limit: 5 });
        check(r.status === 503 && /s2/.test(r.data?.error), 'a query needing a down shard fails clearly (503)', r.data);
        startNode(S2);
        await up(S2);
        r = await api(R, 'POST', '/api/databases/shop/racks/orders/search', { query: {}, limit: 5 });
        check(r.status === 200, 'works again after the shard restarts', r.data);
        r = await api(R, 'DELETE', '/api/admin/sharding/shards/s2');
        check(r.status === 409, 'a shard in use cannot be removed', r.data);

        console.log('— router restart');
        procs[R].kill('SIGINT');
        await new Promise((res) => procs[R].once('exit', res));
        startNode(R);
        await up(R);
        a = await api(R, 'POST', '/api/databases/shop/racks/orders/documents', { n: 30000, customer: 1, amount: 1, status: 'after-restart' });
        b = await api(R, 'POST', '/api/databases/shop/racks/orders/search', { query: { status: 'after-restart' } });
        check(a.status === 201 && b.data?.results?.[0]?.id === a.data.id, 'config survives a router restart; new ids never collide', { a: a.data, b: b.data });

        console.log('— drop');
        r = await api(R, 'DELETE', '/api/databases/shop');
        check(r.status === 409, 'deleting a database with sharded racks is refused', r.data);
        r = await sql('DROP TABLE items');
        const gone = await api(S1, 'GET', '/api/databases/shop/racks/items/count');
        check(r.status === 200 && gone.status === 404, 'DROP TABLE removes it from every shard', { r: r.data, gone: gone.status });
        r = await api(R, 'DELETE', '/api/databases/shop/racks/orders');
        const info = await api(R, 'GET', '/api/admin/sharding');
        check(r.status === 200 && info.data.racks.length === 0, 'rack deleted', { r: r.data, racks: info.data.racks });
    } catch (e) {
        failed++;
        console.log('FATAL', e);
    } finally {
        for (const p of Object.values(procs)) try { p.kill('SIGKILL'); } catch { /* gone */ }
        console.log(`\n${passed} passed, ${failed} failed  (logs: ${ROOT})`);
        process.exit(failed ? 1 : 0);
    }
})();
