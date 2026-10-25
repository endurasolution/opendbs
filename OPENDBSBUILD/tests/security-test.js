// Security test: attacks a live OpenDBS server (auth, permissions, injection,
// ReDoS / resource exhaustion, idempotency replay, sharding bypass, headers).
// Usage: node security-test.js <dist/index.js>
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ENTRY = path.resolve(process.argv[2]);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'opendbs-sec-'));
const PORT = 49000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'Adm1nPassw0rd!';
let passed = 0, failed = 0;
const check = (ok, name, extra) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✔' : '✘'} ${name}${!ok && extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, { token, key, body, headers = {}, raw } = {}) {
    const t0 = Date.now();
    try {
        const r = await fetch(BASE + p, {
            method,
            headers: {
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-api-key': key } : {}), ...headers,
            },
            body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
        });
        let data = null;
        const text = await r.text();
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: r.status, data, headers: r.headers, ms: Date.now() - t0 };
    } catch (e) {
        return { status: 0, data: { error: e.message }, ms: Date.now() - t0 };
    }
}
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

(async () => {
    const dir = path.join(ROOT, 'node');
    fs.mkdirSync(dir, { recursive: true });
    const proc = spawn(process.execPath, [ENTRY], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'data'), BACKUP_PATH: path.join(dir, 'backups'),
            BACKUP_ENABLED: 'false', ADMIN_PASSWORD: PW, WEB_INTERFACE_ENABLED: 'false', ADMIN_PANEL_ENABLED: 'true', LOG_LEVEL: 'warn',
            RATE_LIMIT_MAX: '100000', JWT_SECRET: '', TRUST_PROXY: 'false', BODY_LIMIT_MB: '2', CLUSTER_ENABLED: 'false',
        },
    });
    proc.stdout.pipe(fs.createWriteStream(path.join(dir, 'server.log')));
    proc.stderr.pipe(fs.createWriteStream(path.join(dir, 'server.err.log')));
    try {
        for (let i = 0; i < 120; i++) { if ((await api('GET', '/health')).status === 200) break; await sleep(250); }
        const admin = (await api('POST', '/api/auth/login', { body: { username: 'admin', password: PW } })).data.token;
        const A = { token: admin };
        await api('POST', '/api/databases', { ...A, body: { name: 'sec' } });
        await api('POST', '/api/databases', { ...A, body: { name: 'other' } });
        await api('POST', '/api/databases/sec/racks', { ...A, body: { name: 'notes' } });
        await api('POST', '/api/databases/other/racks', { ...A, body: { name: 'secret' } });
        await api('POST', '/api/databases/other/racks/secret/documents', { ...A, body: { flag: 'TOP-SECRET' } });
        await api('POST', '/api/databases/sec/racks/notes/documents', { ...A, body: [{ t: 'hello' }, { t: 'world' }, { t: 'a'.repeat(60000) }] });
        await api('POST', '/api/auth/register', { ...A, body: { username: 'bob', password: 'BobPassw0rd!1', role: 'user', permissions: { sec: ['read'] } } });
        await api('POST', '/api/auth/register', { ...A, body: { username: 'carol', password: 'CarolPassw0rd!1', role: 'user', permissions: { other: ['read', 'write', 'delete'] } } });
        const bob = (await api('POST', '/api/auth/login', { body: { username: 'bob', password: 'BobPassw0rd!1' } })).data.token;
        const carol = (await api('POST', '/api/auth/login', { body: { username: 'carol', password: 'CarolPassw0rd!1' } })).data.token;
        check(Boolean(admin && bob && carol), 'setup: admin, bob (read sec), carol (rwd other)');
        const B = { token: bob }, C = { token: carol };

        console.log('— authentication');
        check((await api('GET', '/api/databases/sec/racks/notes/documents')).status === 401, 'no credentials → 401');
        const [h, pl] = admin.split('.');
        const claims = JSON.parse(Buffer.from(pl, 'base64url').toString());
        check((await api('GET', '/api/databases', { token: `${b64u({ alg: 'none', typ: 'JWT' })}.${pl}.` })).status === 401, 'JWT alg=none rejected');
        const forged = `${h}.${b64u({ ...claims })}.${crypto.createHmac('sha256', 'guess').update(`${h}.${b64u(claims)}`).digest('base64url')}`;
        check((await api('GET', '/api/databases', { token: forged })).status === 401, 'JWT signed with another secret rejected');
        const bobClaims = JSON.parse(Buffer.from(bob.split('.')[1], 'base64url').toString());
        const tampered = `${bob.split('.')[0]}.${b64u({ ...bobClaims, role: 'admin' })}.${bob.split('.')[2]}`;
        check((await api('GET', '/api/admin/overview', { token: tampered })).status === 401, 'tampered JWT payload (role: admin) rejected');
        check((await api('GET', '/api/databases', { key: 'odbs_' + 'x'.repeat(40) })).status === 401, 'unknown API key rejected');
        check((await api('GET', '/api/databases/other/racks/secret/documents', { headers: { 'x-opendbs-internal': crypto.randomBytes(32).toString('hex') } })).status === 401, 'forged internal-router header rejected');
        const wrong = await api('POST', '/api/auth/login', { body: { username: 'bob', password: 'nope' } });
        const nouser = await api('POST', '/api/auth/login', { body: { username: 'nobody', password: 'nope' } });
        check(wrong.status === 401 && nouser.status === 401 && JSON.stringify(wrong.data) === JSON.stringify(nouser.data), 'login: same answer for wrong password and unknown user', { wrong: wrong.data, nouser: nouser.data });

        console.log('— authorization');
        check((await api('POST', '/api/databases/sec/racks/notes/documents', { ...B, body: { t: 'x' } })).status === 403, 'read-only user cannot insert');
        const someId = (await api('GET', '/api/databases/sec/racks/notes/documents', A)).data.results[0].id;
        check((await api('DELETE', `/api/databases/sec/racks/notes/documents/${someId}`, B)).status === 403, 'read-only user cannot delete');
        check((await api('GET', '/api/databases/other/racks/secret/documents', B)).status === 403, 'user cannot read another database');
        check((await api('POST', '/api/sql/query', { ...B, body: { database: 'sec', query: 'SELECT 1; DELETE FROM notes WHERE 1 = 1' } })).status === 403, 'SQL: a hidden DELETE after SELECT needs delete permission');
        check((await api('POST', '/api/sql/query', { ...B, body: { database: 'sec', query: 'SELECT * FROM notes; DROP TABLE notes' } })).status === 403, 'SQL: DROP after SELECT refused');
        const cte = await api('POST', '/api/sql/query', { ...B, body: { database: 'sec', query: 'WITH x AS (SELECT 1 AS a) INSERT INTO notes (t) SELECT a FROM x' } });
        check(cte.status === 403 || cte.status === 400, 'SQL: INSERT hidden behind WITH refused', cte.data);
        check((await api('POST', '/api/sql/query', { ...B, body: { database: 'other', query: 'SELECT * FROM secret' } })).status === 403, 'SQL: other database refused');
        const qual = await api('POST', '/api/sql/query', { ...B, body: { database: 'sec', query: 'SELECT * FROM other.secret' } });
        check(qual.status !== 200 || !JSON.stringify(qual.data).includes('TOP-SECRET'), 'SQL: db-qualified name cannot reach another database', qual.data);
        check((await api('GET', '/api/databases/_opendbs_system/racks/users/documents', B)).status === 403, 'system database hidden from users (REST)');
        check((await api('POST', '/api/sql/query', { ...B, body: { database: '_opendbs_system', query: 'SELECT * FROM users' } })).status === 403, 'system database hidden from users (SQL)');
        check((await api('GET', '/api/admin/overview', B)).status === 403, 'admin API refused for users');
        const tx = await api('POST', '/api/transactions', { ...C, body: { operations: [{ op: 'insert', database: 'other', rack: 'secret', data: {} }, { op: 'delete', database: 'sec', rack: 'notes', id: someId }] } });
        check(tx.status === 403, 'transaction touching a database without permission refused', tx.data);
        const ak = await api('POST', '/api/admin/access-keys', { ...A, body: { name: 'locked', permissions: { sec: ['read'] }, allowedIps: ['10.9.9.9'] } });
        const lockedKey = ak.data?.key;
        check((await api('GET', '/api/databases/sec/racks/notes/documents', { key: lockedKey })).status === 403, 'access key used from a non-allowed IP refused');
        check((await api('GET', '/api/databases/sec/racks/notes/documents', { key: lockedKey, headers: { 'x-forwarded-for': '10.9.9.9' } })).status === 403, 'X-Forwarded-For cannot fake the allowed IP (TRUST_PROXY off)');

        console.log('— injection');
        const trav = await api('GET', '/api/databases/..%2F..%2Fetc/racks/x/documents', A);
        check(trav.status === 400 || trav.status === 404, 'path traversal in a database name refused', trav.status);
        const proto = await api('POST', '/api/databases/sec/racks/notes/documents', { ...A, raw: '{"__proto__":{"polluted":"yes"},"t":"p"}', headers: { 'content-type': 'application/json' } });
        check(proto.status === 400, '__proto__ in a JSON body refused', proto.data);
        const ctor = await api('POST', '/api/databases/sec/racks/notes/documents', { ...A, body: { constructor: { prototype: { polluted: 'yes' } }, t: 'c' } });
        const after = await api('GET', '/api/databases/sec/racks/notes/documents', A);
        check(!JSON.stringify(after.data).includes('"polluted"') || ctor.status === 400, 'constructor.prototype pollution stripped', { ctor: ctor.data });
        const where = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { $where: 'sleep(10000)' } } });
        check(where.status === 400, '$where / unknown operators refused', where.data);
        const fn = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { t: { $function: 'x' } } } });
        check(fn.status === 400, '$function refused', fn.data);

        // SKIP_DOS=1: skip the denial-of-service section (lets the rest run against an unpatched build).
        if (!process.env.SKIP_DOS) {
        console.log('— ReDoS / resource exhaustion (each must fail fast and leave the server up)');
        for (const pat of ['(a+)+$', '(a*)*b', '(.*a){20}', '(a|aa)+$', '([a-z]+)*$', '(\\w+\\s?)*$', '(a+){2,}', '(?:a|a)*b', '\\1(a)']) {
            const r = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { t: { $regex: pat } } } });
            check(r.status === 400 && r.ms < 2000, `$regex ${pat} refused`, { s: r.status, ms: r.ms, d: r.data });
        }
        const ok = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { t: { $regex: '^h[a-z]+o$', $options: 'i' } } } });
        check(ok.status === 200 && ok.data.total === 1, 'a normal $regex still works', ok.data);
        const rx = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: "SELECT COUNT(*) AS c FROM notes WHERE t REGEXP '(a+)+b'" } });
        check(rx.status === 400 && rx.ms < 2000, 'SQL REGEXP with nested quantifier refused', { s: rx.status, ms: rx.ms });
        const rf = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: "SELECT REGEXP_LIKE(t, '(x+x+)+y') AS m FROM notes" } });
        check(rf.status === 400 && rf.ms < 2000, 'REGEXP_LIKE() with nested quantifier refused', { s: rf.status, ms: rf.ms });
        const likePat = '%a'.repeat(40) + '%b';
        const lk = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: `SELECT COUNT(*) AS c FROM notes WHERE t LIKE '${likePat}'` } });
        check(lk.status === 200 && lk.data.result[0].c === 0 && lk.ms < 3000, `LIKE with 40 wildcards on a 60 KB value is fast (${lk.ms} ms)`, { s: lk.status, d: lk.data, ms: lk.ms });
        const lk2 = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: "SELECT t FROM notes WHERE t LIKE 'H_ll%' ORDER BY t" } });
        check(lk2.status === 200 && lk2.data.result.length === 1 && lk2.data.result[0].t === 'hello', 'LIKE semantics kept (case-insensitive, _ and %)', lk2.data);
        const lk3 = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: "SELECT COUNT(*) AS c FROM notes WHERE t LIKE '%o%' AND t NOT LIKE 'w%'" } });
        check(lk3.data?.result?.[0]?.c === 1, 'LIKE / NOT LIKE results', lk3.data);
        for (const [q, name] of [
            ["SELECT LPAD('x', 1000000000) AS s", 'LPAD to 1 GB'],
            ["SELECT RPAD('x', 900000000, 'ab') AS s", 'RPAD to 900 MB'],
            ["SELECT REPEAT('abcdefghij', 100000000) AS s", 'REPEAT to 1 GB'],
            ["SELECT SPACE(2000000000) AS s", 'SPACE(2e9)'],
            ["SELECT LENGTH(REPLACE(REPEAT('a', 1000000), 'a', REPEAT('b', 1000))) AS n", 'REPLACE amplification'],
            ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r', 'endless recursive CTE'],
            ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n FROM r JOIN (SELECT 1 UNION ALL SELECT 2) AS d ON 1 = 1) SELECT COUNT(*) FROM r', 'exploding recursive CTE'],
        ]) {
            const r = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: q } });
            check(r.status === 400 && r.ms < 15000, `${name} refused (${r.ms} ms)`, { s: r.status, d: r.data });
        }
        check((await api('GET', '/health')).status === 200, 'server still healthy after the attacks');
        const big = await api('POST', '/api/databases/sec/racks/notes/documents', { ...A, raw: JSON.stringify({ t: 'x'.repeat(3 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } });
        check(big.status === 413, 'body over BODY_LIMIT_MB refused (413)', big.status);
        const deep = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, raw: '{"query":' + '{"$and":['.repeat(3000) + '{}' + ']}'.repeat(3000) + '}', headers: { 'content-type': 'application/json' } });
        check(deep.status === 400 && (await api('GET', '/health')).status === 200, 'deeply nested query refused, server up', deep.status);
        // Query array limits: long arrays of objects (compared one by one) are refused;
        // long $in lists of plain values (a Set lookup) are allowed, and SQL relies on them.
        const objs = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { t: { $in: Array.from({ length: 1001 }, (_, i) => ({ i })) } } } });
        check(objs.status === 400, '$in with 1,001 objects refused', objs.status);
        const all = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { t: { $all: Array.from({ length: 1001 }, (_, i) => `v${i}`) } } } });
        check(all.status === 400, '$all with 1,001 values refused', all.status);
        const setIn = await api('POST', '/api/databases/sec/racks/notes/search', { ...A, body: { query: { t: { $in: [...Array.from({ length: 4999 }, (_, i) => `v${i}`), 'hello'] } } } });
        check(setIn.status === 200 && setIn.data.total === 1, '$in with 5,000 plain values works', { s: setIn.status, d: setIn.data });
        await api('POST', '/api/databases/sec/racks', { ...A, body: { name: 'jl', type: 'nosql' } });
        await api('POST', '/api/databases/sec/racks', { ...A, body: { name: 'jr', type: 'nosql' } });
        const rIds = (await api('POST', '/api/databases/sec/racks/jr/documents', { ...A, body: Array.from({ length: 1500 }, (_, i) => ({ g: i % 3 })) })).data.ids;
        await api('POST', '/api/databases/sec/racks/jl/documents', { ...A, body: rIds.map((id) => ({ ref: id })) });
        const join = await api('POST', '/api/sql/query', { ...A, body: { database: 'sec', query: 'SELECT r.g, COUNT(*) AS n FROM jl l JOIN jr r ON l.ref = r.id GROUP BY r.g ORDER BY r.g' } });
        check(join.status === 200 && join.data.result?.map((x) => x.n).join() === '500,500,500', 'SQL JOIN over 1,500 distinct keys works', { s: join.status, d: join.data });
        }

        console.log('— idempotency (safe retries)');
        const K = crypto.randomUUID();
        const first = await api('POST', '/api/databases/other/racks/secret/documents', { ...C, body: { n: 1 }, headers: { 'idempotency-key': K } });
        const again = await api('POST', '/api/databases/other/racks/secret/documents', { ...C, body: { n: 1 }, headers: { 'idempotency-key': K } });
        check(first.status === 201 && again.data?.id === first.data.id && again.headers.get('idempotent-replay') === 'true', 'same caller + key → recorded response (no double write)', { first: first.data, again: again.data });
        const anon = await api('POST', '/api/databases/other/racks/secret/documents', { body: { n: 1 }, headers: { 'idempotency-key': K } });
        check(anon.status === 401 && !anon.headers.get('idempotent-replay'), 'replay without credentials refused (401, nothing replayed)', { s: anon.status, d: anon.data });
        const other = await api('POST', '/api/databases/other/racks/secret/documents', { ...B, body: { n: 1 }, headers: { 'idempotency-key': K } });
        check(other.status === 403 && !other.headers.get('idempotent-replay'), "another user can't replay someone else's key", { s: other.status, d: other.data });
        const KK = crypto.randomUUID();
        const k1 = await api('POST', '/api/admin/access-keys', { ...A, body: { name: 'idem', permissions: { sec: ['read'] }, allowedIps: ['*'] }, headers: { 'idempotency-key': KK } });
        const log = await api('POST', '/api/sql/query', { ...A, body: { database: '_opendbs_system', query: 'SELECT body FROM request_log' } });
        check(k1.status === 201 && log.status === 200 && !JSON.stringify(log.data).includes(k1.data.key), 'new API key secrets are never stored in the idempotency log', { log: log.data });
        const sqlRead = crypto.randomUUID();
        await api('POST', '/api/sql/query', { ...C, body: { database: 'other', query: 'SELECT * FROM secret' }, headers: { 'idempotency-key': sqlRead } });
        const log2 = await api('POST', '/api/sql/query', { ...A, body: { database: '_opendbs_system', query: "SELECT COUNT(*) AS c FROM request_log WHERE url = '/api/sql/query'" } });
        check(log2.data?.result?.[0]?.c === 0, 'read requests (SQL SELECT) are not recorded', log2.data);

        console.log('— sharding');
        const sr = await api('POST', '/api/admin/sharding/racks', { ...A, body: { database: 'sec', rack: 'sharded', key: 'id', shards: ['local'] } });
        check(sr.status === 200, 'sharded rack on this server', sr.data);
        const users = (await api('GET', '/api/auth/users', A)).data;
        const carolId = (users.users ?? users).find((u) => u.username === 'carol')?.id;
        const pr = await api('PUT', `/api/auth/users/${carolId}/permissions`, { ...A, body: { permissions: { other: ['read', 'write', 'delete'], sec: ['read', 'write', 'delete'] } } });
        check(pr.status === 200, 'carol granted rwd on sec', pr.data);
        const carol2 = (await api('POST', '/api/auth/login', { body: { username: 'carol', password: 'CarolPassw0rd!1' } })).data?.token;
        const C2 = { token: carol2 || carol };
        const byp = await api('POST', '/api/databases/sec/racks/sharded/documents', { ...C2, body: { x: 1 }, headers: { 'x-opendbs-shard-request': '1' } });
        check(byp.status === 201 && Number(byp.data.id) >= 4096, 'client header cannot bypass the router (id is router-assigned)', byp.data);
        const put = await api('POST', '/api/shard/sec/sharded/put', { ...C2, body: { docs: [{ id: '7', data: { evil: true } }] } });
        check(put.status === 403, 'internal shard write endpoint refused for a sharded rack', put.data);
        const del = await api('POST', '/api/shard/sec/sharded/delete', { ...C2, body: { ids: [byp.data.id] } });
        check(del.status === 403, 'internal shard delete endpoint refused for a sharded rack', del.data);
        // Store a document under exactly the id the rack would generate next, then insert normally.
        const probe = await api('POST', '/api/databases/sec/racks/notes/documents', { ...A, body: { t: 'probe' } });
        const nextId = String(Number(probe.data.id) + 1);
        const plain = await api('POST', '/api/shard/sec/notes/put', { ...A, body: { docs: [{ id: nextId, data: { t: 'placed' } }] } });
        const nextIns = await api('POST', '/api/databases/sec/racks/notes/documents', { ...A, body: { t: 'next' } });
        const kept = await api('GET', `/api/databases/sec/racks/notes/documents/${nextId}`, A);
        check(plain.status === 200 && nextIns.data.id !== nextId && kept.data?.t === 'placed', 'ids stored by id never get reused by a normal insert', { nextId, nextIns: nextIns.data, kept: kept.data });
        const hdr = await api('GET', '/api/admin/sharding', B);
        check(hdr.status === 403, 'sharding admin refused for users');
        const addShard = await api('POST', '/api/admin/sharding/shards', { ...A, body: { name: 'evil', urls: 'file:///etc/passwd', apiKey: 'x'.repeat(32) } });
        check(addShard.status === 400, 'shard URL must be http(s)', addShard.data);

        console.log('— headers');
        const hh = await api('GET', '/health');
        check(hh.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
        check(/frame-ancestors 'none'/.test(hh.headers.get('content-security-policy') || ''), "CSP frame-ancestors 'none'");
        check(!hh.headers.get('x-powered-by'), 'no X-Powered-By');
        const bk = await api('GET', '/api/backup/..%2F..%2F..%2Fwindows%2Fwin.ini/download', A);
        check(bk.status === 400 || bk.status === 404, 'backup download path traversal refused', bk.status);

        console.log('— brute force');
        let limited = false;
        for (let i = 0; i < 15; i++) {
            const r = await api('POST', '/api/auth/login', { body: { username: 'admin', password: `wrong${i}` } });
            if (r.status === 429) { limited = true; break; }
        }
        check(limited, 'login attempts are rate limited (429)');
    } catch (e) {
        failed++;
        console.log('FATAL', e);
    } finally {
        proc.kill('SIGKILL');
        console.log(`\n${passed} passed, ${failed} failed  (logs: ${dir})`);
        process.exit(failed ? 1 : 0);
    }
})();
