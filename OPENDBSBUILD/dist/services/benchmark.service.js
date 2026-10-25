"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BenchmarkService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const engine_1 = require("../engine");
const config_1 = require("../config");
const SIZES = [1_000, 10_000, 50_000, 100_000];
/**
 * Write/read speed test. Runs against a throwaway engine in
 * <DB_PATH>/.bench-* -- the same disk as the real data, so the numbers are
 * representative -- using the server's current persistence settings.
 * Nothing touches real databases; the temp directory is deleted afterwards.
 */
class BenchmarkService {
    dataPath;
    running = false;
    constructor(dataPath) {
        this.dataPath = dataPath;
    }
    async run(requestedSize) {
        if (this.running)
            throw new Error('A speed test is already running');
        const size = SIZES.includes(requestedSize) ? requestedSize : 10_000;
        this.running = true;
        const dir = path_1.default.join(this.dataPath, `.bench-${crypto_1.default.randomBytes(4).toString('hex')}`);
        const started = Date.now();
        const results = [];
        const engines = [];
        // Yield between phases so the server keeps answering other requests.
        const tick = () => new Promise((r) => setImmediate(r));
        const time = (name, detail, ops, fn, bytes) => {
            const t0 = process.hrtime.bigint();
            fn();
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            results.push({
                name, detail, ops,
                ms: round(ms),
                opsPerSec: Math.round(ops / Math.max(ms, 0.001) * 1000),
                avgMs: round(ms / ops, 4),
                mbPerSec: bytes !== undefined ? round(bytes / 1048576 / (Math.max(ms, 0.001) / 1000)) : undefined,
            });
        };
        const pushTimed = (name, detail, ops, t0) => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            results.push({ name, detail, ops, ms: round(ms), opsPerSec: Math.round(ops / Math.max(ms, 0.001) * 1000), avgMs: round(ms / ops, 4) });
        };
        try {
            fs_1.default.mkdirSync(dir, { recursive: true });
            const engine = new engine_1.OpenDBSEngine(path_1.default.join(dir, 'wal'), { quiet: true });
            engines.push(engine);
            engine.createDatabase('bench');
            engine.createRack('bench', 'items');
            const doc = (i) => ({
                sku: `SKU-${i}`, name: `Item ${i}`, price: i % 1000, qty: i % 37,
                category: ['books', 'games', 'music', 'tools'][i % 4], tags: i % 2 ? ['a', 'b'] : ['c'],
                active: i % 3 === 0, created: new Date(1_700_000_000_000 + i * 1000).toISOString(),
            });
            const docs = Array.from({ length: size }, (_, i) => doc(i));
            const approxBytes = Buffer.byteLength(JSON.stringify(docs));
            time('Bulk insert', `${size.toLocaleString()} documents in one batch`, size, () => {
                engine.insertMany('bench', 'items', docs);
            }, approxBytes);
            await tick();
            const singles = Math.min(size, 5_000);
            time('Single inserts', `${singles.toLocaleString()} separate writes, before the group commit`, singles, () => {
                for (let i = 0; i < singles; i++)
                    engine.insert('bench', 'items', doc(size + i));
            });
            await tick();
            const updates = Math.min(size, 5_000);
            time('Updates', `${updates.toLocaleString()} partial updates`, updates, () => {
                for (let i = 1; i <= updates; i++)
                    engine.patch('bench', 'items', String(i), { qty: i });
            });
            await tick();
            const reads = 20_000;
            time('Get by id', `${reads.toLocaleString()} primary-key lookups`, reads, () => {
                for (let i = 0; i < reads; i++)
                    engine.getDocument('bench', 'items', String((i % size) + 1));
            });
            await tick();
            const scans = 20;
            time('Query without index', `${scans} full scans of ${size.toLocaleString()} docs (cache off)`, scans, () => {
                for (let i = 0; i < scans; i++)
                    engine.query('bench', 'items', { price: { $gte: 990 + (i % 5) }, category: 'games' }, { limit: 50, skip: i });
            });
            await tick();
            engine.createIndex('bench', 'items', 'price');
            engine.createIndex('bench', 'items', 'category');
            const iq = 2_000;
            time('Indexed equality query', `${iq.toLocaleString()} queries on an index`, iq, () => {
                for (let i = 0; i < iq; i++)
                    engine.query('bench', 'items', { price: i % 1000, category: 'books' }, { skip: i });
            });
            time('Indexed range query', `${(iq / 4).toLocaleString()} range queries ($gte/$lt)`, iq / 4, () => {
                for (let i = 0; i < iq / 4; i++)
                    engine.query('bench', 'items', { price: { $gte: i % 900, $lt: (i % 900) + 10 } }, { limit: 20, skip: i });
            });
            await tick();
            const disk = engine.storageInfo().engine === 'disk';
            time(disk ? 'Flush to disk' : 'Snapshot to disk', disk ? 'commit all pending writes to the B-tree + fsync' : 'compress + write the whole rack', 1, () => engine.flushAll());
            const bytes = engine.storageInfo().fileBytes;
            if (!disk)
                results[results.length - 1].mbPerSec = round(bytes / 1048576 / (results[results.length - 1].ms / 1000));
            results[results.length - 1].detail += ` (${(bytes / 1048576).toFixed(2)} MB on disk)`;
            await tick();
            // Durable writes: same workload with fsync after every write.
            const durable = new engine_1.OpenDBSEngine(path_1.default.join(dir, 'fsync'), { quiet: true, walFsync: true });
            engines.push(durable);
            durable.createDatabase('bench');
            durable.createRack('bench', 'items');
            // One client, one write at a time: every write waits for its own fsync (worst case).
            const fsyncWrites = 200;
            let t0 = process.hrtime.bigint();
            for (let i = 0; i < fsyncWrites; i++) {
                durable.insert('bench', 'items', doc(i));
                await durable.syncWal();
            }
            pushTimed('Durable writes, 1 client', `${fsyncWrites} sequential writes, each fsynced before the next`, fsyncWrites, t0);
            // Many clients at once: group commit shares one fsync across all writes in flight.
            const concurrent = 2_000;
            t0 = process.hrtime.bigint();
            const waits = [];
            for (let i = 0; i < concurrent; i++) {
                durable.insert('bench', 'items', doc(fsyncWrites + i));
                waits.push(durable.syncWal());
                if (i % 50 === 49)
                    await Promise.all(waits.splice(0)); // 50 concurrent writers
            }
            await Promise.all(waits);
            pushTimed('Durable writes, 50 clients', `${concurrent.toLocaleString()} writes from 50 concurrent writers (group commit)`, concurrent, t0);
            await tick();
            // Raw sequential disk throughput on the data volume.
            const chunk = crypto_1.default.randomBytes(1024 * 1024);
            const mb = 64;
            const raw = path_1.default.join(dir, 'disk.bin');
            time('Disk sequential write', `${mb} MB written + fsync on the data drive`, mb, () => {
                const fd = fs_1.default.openSync(raw, 'w');
                try {
                    for (let i = 0; i < mb; i++)
                        fs_1.default.writeSync(fd, chunk);
                    fs_1.default.fsyncSync(fd);
                }
                finally {
                    fs_1.default.closeSync(fd);
                }
            }, mb * 1048576);
            return {
                size,
                settings: { storageEngine: engine.storageInfo().engine, walFsync: config_1.config.walFsync, persistDebounceMs: config_1.config.persistDebounceMs, queryCache: config_1.config.queryCacheEntries },
                results,
                totalMs: Date.now() - started,
            };
        }
        finally {
            for (const e of engines) {
                try {
                    e.close();
                }
                catch { /* ignore */ }
            }
            fs_1.default.rmSync(dir, { recursive: true, force: true });
            this.running = false;
        }
    }
}
exports.BenchmarkService = BenchmarkService;
function round(n, digits = 2) {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}
//# sourceMappingURL=benchmark.service.js.map