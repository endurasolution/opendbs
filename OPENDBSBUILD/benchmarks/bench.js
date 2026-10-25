// Same workloads against OpenDBS, PostgreSQL, MySQL, MongoDB and SQLite.
// Runs inside a node:22 container on the same Docker network as the servers.
//   node bench.js <opendbs|postgres|mysql|mongo|sqlite>
'use strict';
const { performance } = require('perf_hooks');

const N = Number(process.env.ROWS || 100000);      // rows loaded
const CONC = Number(process.env.CONC || 16);       // concurrent clients for single operations
const CITIES = Array.from({ length: 50 }, (_, i) => `city${String(i).padStart(2, '0')}`);

// Deterministic data
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const row = (i) => ({
    id: i, name: `user${i}`, email: `user${i}@example.com`, city: CITIES[i % 50],
    age: 18 + Math.floor(rnd() * 63), score: Math.round(rnd() * 100000) / 100,
});
const ROWS = Array.from({ length: N }, (_, i) => row(i + 1));

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const median = (arr) => pct(arr, 50);

/** Run `total` operations with `conc` workers; returns ops/s and latency percentiles (ms). */
async function concurrent(total, conc, op) {
    const lat = [];
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: conc }, async () => {
        for (;;) {
            const i = next++;
            if (i >= total) return;
            const s = performance.now();
            await op(i);
            lat.push(performance.now() - s);
        }
    }));
    const sec = (performance.now() - t0) / 1000;
    return { ops: Math.round(total / sec), p50: +pct(lat, 50).toFixed(2), p99: +pct(lat, 99).toFixed(2) };
}

// ── Adapters ────────────────────────────────────────────────────────────────

const adapters = {
    async opendbs() {
        const { OpenDBS } = require('../drivers/nodejs');
        const url = 'http://opendbs:4402';
        const pw = process.env.OPENDBS_PASSWORD;
        const admin = new OpenDBS({ url, username: 'admin', password: pw });
        const key = (await admin.request('POST', '/api/admin/access-keys', { name: 'bench', permissions: { '*': ['read', 'write', 'delete'] }, allowedIps: ['*'] })).key;
        const c = new OpenDBS({ url, apiKey: key });
        await c.createDatabase('bench');
        const db = c.database('bench');
        await db.createTable('people', {
            name: { type: 'string' }, email: { type: 'string' }, city: { type: 'string' },
            age: { type: 'integer' }, score: { type: 'number' }, n: { type: 'integer' },
        });
        const t = db.table('people');
        const ids = [];
        const strip = ({ id, ...r }) => ({ ...r, n: id });
        return {
            name: 'OpenDBS 1.0.1',
            async bulk(rows) { ids.push(...(await t.insertMany(rows.map(strip)))); },
            async index() { await t.createIndex(['city', 'age']); },
            insertOne: (r) => t.insert(strip(r)),
            get: (i) => t.get(ids[i % ids.length]),
            query: (city, age) => t.find({ city, age: { $gte: age } }, { sort: { field: 'age', order: 'asc' }, limit: 50 }),
            groupBy: () => db.sql('SELECT city, COUNT(*) AS n, AVG(score) AS avg_score FROM people GROUP BY city'),
            update: (i, score) => t.patch(ids[i % ids.length], { score }),
            async close() {},
        };
    },

    async postgres() {
        const { Pool } = require('pg');
        const pool = new Pool({ host: 'postgres', user: 'bench', password: 'bench', database: 'bench', max: CONC });
        await pool.query('DROP TABLE IF EXISTS people');
        await pool.query('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, email TEXT, city TEXT, age INTEGER, score DOUBLE PRECISION)');
        const cols = ['id', 'name', 'email', 'city', 'age', 'score'];
        return {
            name: 'PostgreSQL 16',
            async bulk(rows) {
                const vals = []; const ph = rows.map((r, j) => `(${cols.map((_, k) => `$${j * 6 + k + 1}`).join(',')})`);
                for (const r of rows) vals.push(r.id, r.name, r.email, r.city, r.age, r.score);
                await pool.query(`INSERT INTO people (${cols}) VALUES ${ph.join(',')}`, vals);
            },
            async index() { await pool.query('CREATE INDEX people_city_age ON people (city, age)'); await pool.query('ANALYZE people'); },
            insertOne: (r) => pool.query('INSERT INTO people (id, name, email, city, age, score) VALUES ($1,$2,$3,$4,$5,$6)', [r.id, r.name, r.email, r.city, r.age, r.score]),
            get: (i) => pool.query('SELECT * FROM people WHERE id = $1', [(i % N) + 1]),
            query: (city, age) => pool.query('SELECT * FROM people WHERE city = $1 AND age >= $2 ORDER BY age LIMIT 50', [city, age]),
            groupBy: () => pool.query('SELECT city, COUNT(*) AS n, AVG(score) AS avg_score FROM people GROUP BY city'),
            update: (i, score) => pool.query('UPDATE people SET score = $1 WHERE id = $2', [score, (i % N) + 1]),
            close: () => pool.end(),
        };
    },

    async mysql() {
        const mysql = require('mysql2/promise');
        const pool = mysql.createPool({ host: 'mysql', user: 'root', password: 'bench', database: 'bench', connectionLimit: CONC });
        await pool.query('DROP TABLE IF EXISTS people');
        await pool.query('CREATE TABLE people (id INT PRIMARY KEY, name VARCHAR(64), email VARCHAR(128), city VARCHAR(16), age INT, score DOUBLE) ENGINE=InnoDB');
        return {
            name: 'MySQL 8.4',
            bulk: (rows) => pool.query('INSERT INTO people (id, name, email, city, age, score) VALUES ?', [rows.map((r) => [r.id, r.name, r.email, r.city, r.age, r.score])]),
            async index() { await pool.query('CREATE INDEX people_city_age ON people (city, age)'); await pool.query('ANALYZE TABLE people'); },
            insertOne: (r) => pool.execute('INSERT INTO people (id, name, email, city, age, score) VALUES (?,?,?,?,?,?)', [r.id, r.name, r.email, r.city, r.age, r.score]),
            get: (i) => pool.execute('SELECT * FROM people WHERE id = ?', [(i % N) + 1]),
            query: (city, age) => pool.execute('SELECT * FROM people WHERE city = ? AND age >= ? ORDER BY age LIMIT 50', [city, age]),
            groupBy: () => pool.query('SELECT city, COUNT(*) AS n, AVG(score) AS avg_score FROM people GROUP BY city'),
            update: (i, score) => pool.execute('UPDATE people SET score = ? WHERE id = ?', [score, (i % N) + 1]),
            close: () => pool.end(),
        };
    },

    async mongo() {
        const { MongoClient } = require('mongodb');
        // j:true = acknowledged after the journal is on disk, like the others' default fsync-on-commit.
        const client = new MongoClient('mongodb://mongo:27017', { maxPoolSize: CONC, writeConcern: { w: 1, j: true } });
        await client.connect();
        const db = client.db('bench');
        await db.collection('people').drop().catch(() => {});
        const col = db.collection('people');
        const doc = ({ id, ...r }) => ({ _id: id, ...r });
        return {
            name: 'MongoDB 7.0',
            bulk: (rows) => col.insertMany(rows.map(doc), { ordered: true }),
            index: () => col.createIndex({ city: 1, age: 1 }),
            insertOne: (r) => col.insertOne(doc(r)),
            get: (i) => col.findOne({ _id: (i % N) + 1 }),
            query: (city, age) => col.find({ city, age: { $gte: age } }).sort({ age: 1 }).limit(50).toArray(),
            groupBy: () => col.aggregate([{ $group: { _id: '$city', n: { $sum: 1 }, avg_score: { $avg: '$score' } } }]).toArray(),
            update: (i, score) => col.updateOne({ _id: (i % N) + 1 }, { $set: { score } }),
            close: () => client.close(),
        };
    },

    async sqlite() {
        const Database = require('better-sqlite3');
        const fs = require('fs');
        fs.rmSync('/data/bench.db', { force: true }); fs.rmSync('/data/bench.db-wal', { force: true }); fs.rmSync('/data/bench.db-shm', { force: true });
        const db = new Database('/data/bench.db');
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL'); // fsync on every commit, like the servers
        db.pragma('cache_size = -1048576'); // 1 GB
        db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, email TEXT, city TEXT, age INTEGER, score REAL)');
        const ins = db.prepare('INSERT INTO people (id, name, email, city, age, score) VALUES (@id, @name, @email, @city, @age, @score)');
        const insMany = db.transaction((rows) => { for (const r of rows) ins.run(r); });
        const get = db.prepare('SELECT * FROM people WHERE id = ?');
        const q = db.prepare('SELECT * FROM people WHERE city = ? AND age >= ? ORDER BY age LIMIT 50');
        const g = db.prepare('SELECT city, COUNT(*) AS n, AVG(score) AS avg_score FROM people GROUP BY city');
        const up = db.prepare('UPDATE people SET score = ? WHERE id = ?');
        return {
            name: 'SQLite 3 (embedded)',
            embedded: true,
            async bulk(rows) { insMany(rows); },
            async index() { db.exec('CREATE INDEX people_city_age ON people (city, age); ANALYZE'); },
            async insertOne(r) { ins.run(r); },
            async get(i) { return get.get((i % N) + 1); },
            async query(city, age) { return q.all(city, age); },
            async groupBy() { return g.all(); },
            async update(i, score) { up.run(score, (i % N) + 1); },
            async close() { db.close(); },
        };
    },
};

// ── Workloads ───────────────────────────────────────────────────────────────

(async () => {
    const which = process.argv[2];
    const a = await adapters[which]();
    const conc = a.embedded ? 1 : CONC; // an embedded library runs in the caller's thread
    const res = { db: a.name, rows: N, concurrency: conc };

    // 1. Bulk load, 1,000 rows per request / statement
    let t0 = performance.now();
    for (let i = 0; i < N; i += 1000) await a.bulk(ROWS.slice(i, i + 1000));
    res.bulkInsertRowsPerSec = Math.round(N / ((performance.now() - t0) / 1000));

    t0 = performance.now();
    await a.index();
    res.indexBuildMs = Math.round(performance.now() - t0);

    // 2. Point reads by primary key
    await concurrent(1000, conc, (i) => a.get(i * 7));
    res.pointRead = await concurrent(20000, conc, (i) => a.get(i * 13 + 5));

    // 3. Indexed query: city = ? AND age >= ? ORDER BY age LIMIT 50
    const qa = (i) => a.query(CITIES[i % 50], 18 + (i % 40));
    await concurrent(200, conc, qa);
    res.indexedQuery = await concurrent(5000, conc, qa);

    // 4. Single-row inserts, each its own durable commit
    res.singleInsert = await concurrent(5000, conc, (i) => a.insertOne(row(N + 1 + i)));

    // 5. Updates by primary key
    res.update = await concurrent(5000, conc, (i) => a.update(i * 17, i / 10));

    // 6. GROUP BY over the whole table (sequential, median of 10)
    await a.groupBy();
    const gb = [];
    for (let i = 0; i < 10; i++) { const s = performance.now(); await a.groupBy(); gb.push(performance.now() - s); }
    res.groupByMs = +median(gb).toFixed(1);

    await a.close();
    console.log('RESULT ' + JSON.stringify(res));
})().catch((e) => { console.error(e); process.exit(1); });
