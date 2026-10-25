// Sharding router running as a 3-member cluster + one shard server.
// Usage: node router-cluster-test.js <dist/index.js>
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ENTRY = path.resolve(process.argv[2]);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'opendbs-rc-'));
const BASE = 45000 + Math.floor(Math.random() * 300) * 4;
const members = [BASE, BASE + 1, BASE + 2];
const SHARD = BASE + 3;
const url = (p) => `http://127.0.0.1:${p}`;
const PW = 'Adm1nPassw0rd!';
const KEY = 'b'.repeat(64);
const procs = {};
let passed = 0, failed = 0;
const check = (ok, name, extra) => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✔' : '✘'} ${name}${!ok && extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(port, cluster) {
    const dir = path.join(ROOT, `n${port}`);
    fs.mkdirSync(dir, { recursive: true });
    const env = {
        ...process.env, NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'data'), BACKUP_PATH: path.join(dir, 'backups'),
        BACKUP_ENABLED: 'false', ADMIN_PASSWORD: PW, WEB_INTERFACE_ENABLED: 'false', ADMIN_PANEL_ENABLED: 'true', LOG_LEVEL: 'warn', RATE_LIMIT_MAX: '100000',
        JWT_SECRET: 'j'.repeat(64), DB_ENCRYPTION_KEY: KEY, CLUSTER_ENABLED: cluster ? 'true' : 'false',
        ...(cluster ? {
            CLUSTER_SECRET: 'test-cluster-secret-0123456789abcdef0123456789', CLUSTER_ADVERTISE_URL: url(port), CLUSTER_NODE_ID: `r${port}`,
            CLUSTER_PEERS: members.filter((p) => p !== port).map(url).join(','), CLUSTER_ELECTION_TIMEOUT_MS: '2000', REPLICATION_SYNC: 'majority', CLUSTER_WRITE_TIMEOUT_MS: '4000',
        } : {}),
    };
    const p = spawn(process.execPath, [ENTRY], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(fs.createWriteStream(path.join(dir, 'server.log'), { flags: 'a' }));
    p.stderr.pipe(fs.createWriteStream(path.join(dir, 'server.err'), { flags: 'a' }));
    procs[port] = p;
}
async function api(port, method, p, { token, body } = {}) {
    try {
        const r = await fetch(url(port) + p, {
            method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
        });
        let data = null;
        try { data = await r.json(); } catch { /* empty */ }
        return { status: r.status, data };
    } catch (e) { return { status: 0, data: { error: e.message } }; }
}
async function waitFor(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); }
    throw new Error(`timeout: ${what}`);
}
// Login is rate limited (10 / 5 min per IP, counted on the primary): sign in once per server and reuse
// the token — the members share JWT_SECRET, so a token works on all of them.
const tokens = {};
const login = async (port) => {
    const k = port === SHARD ? 'shard' : 'router';
    if (!tokens[k]) tokens[k] = (await api(port, 'POST', '/api/auth/login', { body: { username: 'admin', password: PW } })).data?.token;
    return tokens[k];
};
const leaderOf = (alive) => waitFor(async () => {
    const st = await Promise.all(alive.map((p) => api(p, 'GET', '/api/cluster/status')));
    const l = alive.filter((p, i) => st[i].data?.primary);
    return l.length === 1 ? l[0] : null;
}, 30000, 'primary');

(async () => {
    try {
        members.forEach((p) => start(p, true));
        start(SHARD, false);
        let L = await leaderOf(members);
        const reps = members.filter((p) => p !== L);
        // Replicas finished their first copy (they accept the primary-signed... shared JWT_SECRET anyway).
        await waitFor(async () => {
            const all = await Promise.all(members.map(async (p) => { const t = await login(p); const c = await api(p, 'GET', '/api/admin/cluster', { token: t }); return c.data?.lineage && c.data.synced; }));
            const lin = await Promise.all(members.map(async (p) => (await api(p, 'GET', '/api/admin/cluster', { token: await login(p) })).data?.lineage));
            return all.every(Boolean) && new Set(lin).size === 1;
        }, 40000, 'members synced with one lineage');
        check(true, 'router cluster formed (one lineage on all members)');
        await waitFor(async () => (await api(SHARD, 'GET', '/health')).status === 200, 30000, 'shard up');
        const ts = await login(SHARD);
        const key = (await api(SHARD, 'POST', '/api/admin/access-keys', { token: ts, body: { name: 'router', permissions: { '*': ['read', 'write', 'delete'] }, allowedIps: ['*'] } })).data.key;
        const tr = await login(reps[0]);
        // Admin changes sent to a replica are forwarded to the primary.
        let r = await api(reps[0], 'POST', '/api/admin/sharding/shards', { token: tr, body: { name: 's1', urls: url(SHARD), apiKey: key } });
        check(r.status === 200, 'add shard through a replica (forwarded)', r.data);
        r = await api(reps[0], 'POST', '/api/admin/sharding/racks', { token: tr, body: { database: 'app', rack: 'events', key: 'user', shards: ['local', 's1'] } });
        check(r.status === 200, 'create sharded rack through a replica', r.data);
        const docs = Array.from({ length: 400 }, (_, i) => ({ user: `u${i % 40}`, n: i, v: i % 7 }));
        r = await api(reps[1], 'POST', '/api/databases/app/racks/events/documents', { token: await login(reps[1]), body: docs });
        check(r.status === 201 && r.data.ids.length === 400, 'insert 400 through the other replica', r.data);
        const direct = (await api(SHARD, 'GET', '/api/databases/app/racks/events/count', { token: ts })).data?.count;
        check(direct > 100 && direct < 300, `shard s1 holds its share (${direct})`);
        for (const p of members) {
            const t = await login(p);
            const c = await waitFor(async () => { const x = await api(p, 'GET', '/api/databases/app/racks/events/count', { token: t }); return x.data?.count === 400 ? x : null; }, 15000, `count on ${p}`).catch(() => null);
            check(Boolean(c), `member ${p}${p === L ? ' (primary)' : ''}: sharded count = 400`);
            const g = await api(p, 'POST', '/api/sql/query', { token: t, body: { database: 'app', query: 'SELECT v, COUNT(*) AS c FROM events GROUP BY v ORDER BY v' } });
            check(g.status === 200 && g.data.result.reduce((s, x) => s + x.c, 0) === 400 && g.data.result.length === 7, `member ${p}: SQL GROUP BY over shards`, g.data);
        }
        // Failover of the router primary.
        procs[L].kill('SIGKILL');
        const alive = members.filter((p) => p !== L);
        const L2 = await leaderOf(alive);
        check(L2 !== L, `new router primary ${L2}`);
        const t2 = await login(L2);
        r = await waitFor(async () => { const x = await api(L2, 'POST', '/api/databases/app/racks/events/documents', { token: t2, body: { user: 'u1', n: 999, v: 0 } }); return x.status === 201 ? x : null; }, 20000, 'write after failover').catch((e) => ({ data: e.message }));
        check(r.status === 201 && Number(r.data.id) > 0, 'sharded writes continue after router failover', r.data);
        const ids = new Set();
        const all = await api(L2, 'POST', '/api/databases/app/racks/events/search', { token: t2, body: { query: {}, limit: 1000 } });
        for (const d of all.data?.results ?? []) ids.add(d.id);
        check(all.data?.total === 401 && ids.size === 401, 'no id collision after failover (new primary continues the id sequence)', { total: all.data?.total, distinct: ids.size });
    } catch (e) {
        failed++;
        console.log('FATAL', e.message);
    } finally {
        Object.values(procs).forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
        console.log(`\n${passed} passed, ${failed} failed  (logs: ${ROOT})`);
        process.exit(failed ? 1 : 0);
    }
})();
