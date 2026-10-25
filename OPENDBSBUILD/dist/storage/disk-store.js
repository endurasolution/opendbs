"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiskIndexStore = exports.DiskDocMap = exports.BULK_OP_DROP = exports.BULK_OP_PUT = exports.DiskStorage = exports.lsnOf = exports.CLUSTER_TABLE = exports.REPL_TABLE = exports.STORE_FILE = exports.STORE_DIR = exports.MemoryIndexStore = exports.MemoryDocStore = void 0;
exports.encodeId = encodeId;
exports.decodeId = decodeId;
exports.encodeIndexKey = encodeIndexKey;
exports.forEachOp = forEachOp;
exports.diskStorageAvailable = diskStorageAvailable;
exports.storeFilePath = storeFilePath;
exports.lsnKey = lsnKey;
exports.packDoc = packDoc;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const msgpackr_1 = require("msgpackr");
const native_search_service_1 = require("../services/native-search.service");
// ───────────────────────────── memory ─────────────────────────────
class MemoryDocStore extends Map {
    add(id, doc) {
        this.set(id, doc);
    }
    getMany(ids) {
        return ids.map((id) => this.get(id));
    }
}
exports.MemoryDocStore = MemoryDocStore;
const EMPTY = new Set();
function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < v)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
function upperBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= v)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
/**
 * Hash index (key → ids) with lazily built sorted key arrays that serve
 * range queries via binary search.
 */
class MemoryIndexStore {
    map = new Map();
    sortedNums = null;
    sortedStrs = null;
    invalidate(k) {
        if (typeof k === 'number')
            this.sortedNums = null;
        else if (typeof k === 'string')
            this.sortedStrs = null;
    }
    get(k) {
        return this.map.get(k) ?? EMPTY;
    }
    add(k, id) {
        let set = this.map.get(k);
        if (!set) {
            set = new Set();
            this.map.set(k, set);
            this.invalidate(k);
        }
        set.add(id);
    }
    remove(k, id) {
        const set = this.map.get(k);
        if (!set)
            return;
        set.delete(id);
        if (set.size === 0) {
            this.map.delete(k);
            this.invalidate(k);
        }
    }
    sorted(type) {
        if (type === 'number') {
            if (!this.sortedNums) {
                this.sortedNums = [];
                for (const k of this.map.keys())
                    if (typeof k === 'number')
                        this.sortedNums.push(k);
                this.sortedNums.sort((a, b) => a - b);
            }
            return this.sortedNums;
        }
        if (!this.sortedStrs) {
            this.sortedStrs = [];
            for (const k of this.map.keys())
                if (typeof k === 'string')
                    this.sortedStrs.push(k);
            this.sortedStrs.sort();
        }
        return this.sortedStrs;
    }
    range(type, lo, hi) {
        const arr = this.sorted(type);
        let a = 0, b = arr.length;
        if (lo)
            a = lo.incl ? lowerBound(arr, lo.v) : upperBound(arr, lo.v);
        if (hi)
            b = hi.incl ? upperBound(arr, hi.v) : lowerBound(arr, hi.v);
        const out = new Set();
        for (let i = a; i < b; i++)
            for (const id of this.map.get(arr[i]))
                out.add(id);
        return out;
    }
    info() {
        return { distinctKeys: this.map.size };
    }
    clear() {
        this.map.clear();
        this.sortedNums = null;
        this.sortedStrs = null;
    }
    drop() {
        this.clear();
    }
    beginBuild() { }
    endBuild() { }
    abortBuild() { this.clear(); }
}
exports.MemoryIndexStore = MemoryIndexStore;
// ───────────────────────────── key encoding ─────────────────────────────
const ID_NUM = 0x01;
const ID_STR = 0x02;
const NUMERIC_ID = /^(0|[1-9]\d{0,14})$/;
/** Document ids → B-tree keys. Engine ids are integers, stored big-endian so key order = numeric order. */
function encodeId(id) {
    if (NUMERIC_ID.test(id)) {
        const n = Number(id);
        const b = Buffer.allocUnsafe(9);
        b[0] = ID_NUM;
        b.writeUInt32BE(Math.floor(n / 0x100000000), 1);
        b.writeUInt32BE(n >>> 0, 5);
        return b;
    }
    const s = Buffer.from(id, 'utf8');
    const b = Buffer.allocUnsafe(1 + s.length);
    b[0] = ID_STR;
    s.copy(b, 1);
    return b;
}
function decodeId(b) {
    if (b[0] === ID_NUM)
        return String(b.readUInt32BE(1) * 0x100000000 + b.readUInt32BE(5));
    return b.toString('utf8', 1);
}
const K_BOOL = 0x01;
const K_NUM = 0x02;
const K_STR = 0x03;
/**
 * Index keys → bytes whose byte order matches JavaScript's ordering of the
 * values, and which are prefix-free so a document id can follow:
 *   numbers: order-preserving IEEE-754 (9 bytes)
 *   strings: UTF-16 code units (the order of the `<` operator) in a compact
 *            variable-length form, 0x00 escaped as 00 FF, terminated by 00
 */
function encodeIndexKey(k) {
    if (typeof k === 'boolean')
        return Buffer.from([K_BOOL, k ? 1 : 0]);
    if (typeof k === 'number') {
        const b = Buffer.allocUnsafe(9);
        b[0] = K_NUM;
        b.writeDoubleBE(k === 0 ? 0 : k, 1); // -0 and 0 are the same key
        if (b[1] & 0x80) {
            for (let i = 1; i < 9; i++)
                b[i] = ~b[i] & 0xff;
        }
        else {
            b[1] |= 0x80;
        }
        return b;
    }
    const out = Buffer.allocUnsafe(2 + k.length * 6);
    out[0] = K_STR;
    let p = 1;
    const put = (byte) => {
        out[p++] = byte;
        if (byte === 0)
            out[p++] = 0xff;
    };
    for (let i = 0; i < k.length; i++) {
        const u = k.charCodeAt(i);
        if (u < 0x80) {
            put(u);
        }
        else if (u < 0x4000) {
            put(0x80 | (u >> 8));
            put(u & 0xff);
        }
        else {
            put(0xc0);
            put(u >> 8);
            put(u & 0xff);
        }
    }
    out[p++] = 0x00;
    return out.subarray(0, p);
}
// ───────────────────────────── packed buffers ─────────────────────────────
const OP_PUT = 0;
const OP_DEL = 1;
const OP_DROP = 2;
/** Deletes keys in [key, value) — value empty = to the end. */
const OP_DEL_RANGE = 3;
/** Collects ops into the packed format the native store commits: [u8 kind][u32 table][u32 klen][key][u32 vlen][value]. */
class OpWriter {
    tables = [];
    tableIdx = new Map();
    buf = Buffer.allocUnsafe(64 * 1024);
    len = 0;
    count = 0;
    push(kind, table, key, value) {
        let ti = this.tableIdx.get(table);
        if (ti === undefined) {
            ti = this.tables.length;
            this.tables.push(table);
            this.tableIdx.set(table, ti);
        }
        const kl = key ? key.length : 0;
        const vl = value ? value.length : 0;
        const need = this.len + 13 + kl + vl;
        if (need > this.buf.length) {
            const nb = Buffer.allocUnsafe(Math.max(this.buf.length * 2, need));
            this.buf.copy(nb, 0, 0, this.len);
            this.buf = nb;
        }
        const b = this.buf;
        let p = this.len;
        b[p++] = kind;
        b.writeUInt32LE(ti, p);
        p += 4;
        b.writeUInt32LE(kl, p);
        p += 4;
        if (key) {
            key.copy(b, p);
            p += kl;
        }
        b.writeUInt32LE(vl, p);
        p += 4;
        if (value) {
            value.copy(b, p);
            p += vl;
        }
        this.len = p;
        this.count++;
    }
    get bytes() {
        return this.buf.subarray(0, this.len);
    }
}
/** [u32 len][bytes] ... → slices (no copies). */
function* unpackValues(buf) {
    let p = 0;
    while (p < buf.length) {
        const n = buf.readUInt32LE(p);
        p += 4;
        if (n === 0xffffffff) {
            yield null;
            continue;
        }
        yield buf.subarray(p, p + n);
        p += n;
    }
}
function* unpackEntries(buf) {
    let p = 0;
    while (p < buf.length) {
        const kl = buf.readUInt32LE(p);
        const key = buf.subarray(p + 4, p + 4 + kl);
        p += 4 + kl;
        const vl = buf.readUInt32LE(p);
        const value = buf.subarray(p + 4, p + 4 + vl);
        p += 4 + vl;
        yield [key, value];
    }
}
/** Calls `fn` for every op in a packed op buffer. */
function forEachOp(buf, tables, fn) {
    let p = 0;
    while (p < buf.length) {
        const kind = buf[p];
        const table = tables[buf.readUInt32LE(p + 1)];
        const kl = buf.readUInt32LE(p + 5);
        const key = buf.subarray(p + 9, p + 9 + kl);
        p += 9 + kl;
        const vl = buf.readUInt32LE(p);
        const value = buf.subarray(p + 4, p + 4 + vl);
        p += 4 + vl;
        fn(kind, table, key, value);
    }
}
function packKeys(keys) {
    let total = 0;
    for (const k of keys)
        total += 4 + k.length;
    const out = Buffer.allocUnsafe(total);
    let p = 0;
    for (const k of keys) {
        out.writeUInt32LE(k.length, p);
        k.copy(out, p + 4);
        p += 4 + k.length;
    }
    return out;
}
function diskStorageAvailable() {
    return Boolean((0, native_search_service_1.nativeAddon)()?.Store);
}
exports.STORE_DIR = '.storage';
exports.STORE_FILE = 'opendbs.odb';
function storeFilePath(dataPath) {
    return path.join(dataPath, exports.STORE_DIR, exports.STORE_FILE);
}
const packr = new msgpackr_1.Packr({ useRecords: false });
const MAX_U32 = 0xffffffff;
/** Replication log table (lsn → batch) and node-local cluster state (never replicated). */
exports.REPL_TABLE = 'repl';
exports.CLUSTER_TABLE = 'cluster';
function lsnKey(n) {
    const b = Buffer.allocUnsafe(8);
    b.writeUInt32BE(Math.floor(n / 0x100000000), 0);
    b.writeUInt32BE(n >>> 0, 4);
    return b;
}
const lsnOf = (key) => key.readUInt32BE(0) * 0x100000000 + key.readUInt32BE(4);
exports.lsnOf = lsnOf;
const SCAN_PAGE = 2000;
const BUILD_CHUNK = 50_000;
/** Without fsync-per-commit, still make everything durable at least this often. */
const LAZY_DURABLE_MS = 1000;
const EMPTY_BUF = Buffer.alloc(0);
/**
 * Owns the store file and the write pipeline: batches every write of a tick
 * into one atomic commit, tracks which batch each overlay entry belongs to,
 * and keeps the shared byte-budgeted document cache.
 */
class DiskStorage {
    file;
    native;
    durable;
    pending = new OpWriter();
    pendingCleanups = [];
    /** Sequence number of the batch currently being collected. */
    batchSeq = 1;
    /** Every batch ≤ this is committed (and fsynced in durable mode). */
    committedSeq = 0;
    inFlight = null;
    inFlightCleanups = new Map();
    /** A batch whose commit failed; it is retried before anything newer. */
    retry = null;
    scheduled = false;
    cutting = false;
    waiters = [];
    lazyTimer = null;
    needsDurable = false;
    closed = false;
    /** Called right before a batch is cut, so the engine can append rack metadata. */
    beforeFlush = null;
    // ── replication ──
    /** Leader: every commit is also appended to the replication log (same atomic batch). */
    logging = false;
    /** Term stamped on new log entries. */
    term = 0;
    /** Highest LSN written to this node's log (or covered by a full sync). */
    lastLsn = 0;
    lastTerm = 0;
    /** Highest LSN known committed (durable when WAL_FSYNC). */
    committedLsn = 0;
    /** Set on replicas: local writes are refused with this message. */
    readOnly = null;
    applying = false;
    /** Called after a logged batch commits (wakes replication long-polls). */
    onLogCommitted = null;
    // Two-generation LRU approximation: hits are promoted to `young`; when
    // `young` fills half the budget it becomes `old` and the previous `old`
    // is dropped wholesale. O(1) per operation.
    young = new Map();
    old = new Map();
    youngBytes = 0;
    oldBytes = 0;
    cacheBudget;
    stats = { commits: 0, opsCommitted: 0, commitFailures: 0, cacheHits: 0, cacheMisses: 0, lastError: null };
    constructor(dataPath, options) {
        const addon = (0, native_search_service_1.nativeAddon)();
        if (!addon?.Store)
            throw new Error('Disk storage needs the native addon (opendbs-engine.*.node), which is missing for this platform');
        fs.mkdirSync(path.join(dataPath, exports.STORE_DIR), { recursive: true });
        this.file = storeFilePath(dataPath);
        // RAM split: half for decrypted B-tree pages (writes touch them too, so
        // this matters most for indexed writes), half for decoded hot documents.
        const total = Math.max(32, options.cacheMB);
        this.native = new addon.Store(this.file, options.keyHex ?? undefined, Math.max(16, Math.floor(total / 2)));
        this.cacheBudget = Math.floor(total / 2) * 1024 * 1024;
        this.durable = options.durable;
    }
    get currentSeq() {
        return this.batchSeq;
    }
    put(table, key, value, cleanup) {
        this.enqueue(OP_PUT, table, key, value, cleanup);
    }
    del(table, key, cleanup) {
        this.enqueue(OP_DEL, table, key, undefined, cleanup);
    }
    dropTable(table) {
        this.enqueue(OP_DROP, table);
    }
    enqueue(kind, table, key, value, cleanup) {
        if (this.closed)
            throw new Error('Storage is closed');
        if (this.readOnly && !this.applying)
            throw new Error(this.readOnly);
        this.pending.push(kind, table, key, value);
        if (cleanup)
            this.pendingCleanups.push(cleanup);
        this.schedule();
    }
    /** Ensures a flush runs this tick even if only metadata changed. */
    schedule() {
        if (this.scheduled || this.inFlight || this.closed || this.cutting)
            return;
        this.scheduled = true;
        setImmediate(() => this.flush());
    }
    hasPending() {
        return this.pending.count > 0 || this.scheduled || this.inFlight !== null || this.retry !== null;
    }
    cut() {
        if (this.retry) {
            const r = this.retry;
            this.retry = null;
            return r;
        }
        this.cutting = true;
        const wasApplying = this.applying;
        // Metadata of writes that were already accepted (so not subject to the replica guard).
        this.applying = true;
        try {
            this.beforeFlush?.();
        }
        finally {
            this.cutting = false;
            this.applying = wasApplying;
        }
        if (this.pending.count === 0)
            return null;
        const ops = this.pending;
        const seq = this.batchSeq++;
        const lsn = this.logBatch(ops);
        this.inFlightCleanups.set(seq, this.pendingCleanups);
        this.pending = new OpWriter();
        this.pendingCleanups = [];
        return { ops, seq, lsn };
    }
    /** Leader: appends the batch itself to the replication log (inside the same commit). Returns its LSN or 0. */
    logBatch(w) {
        if (!this.logging || w.count === 0)
            return 0;
        const lsn = ++this.lastLsn;
        this.lastTerm = this.term;
        const value = packr.pack({ t: this.term, tb: w.tables.slice(), ops: Buffer.from(w.bytes) });
        w.push(OP_PUT, exports.REPL_TABLE, lsnKey(lsn), value);
        return lsn;
    }
    logCommitted(lsn) {
        if (!lsn)
            return;
        if (lsn > this.committedLsn)
            this.committedLsn = lsn;
        this.onLogCommitted?.(lsn);
    }
    /** Starts (leader) or stops (replica) writing the replication log. */
    setLogging(on, term) {
        this.logging = on;
        this.term = term;
    }
    get isLogging() {
        return this.logging;
    }
    /** Reads the log state from disk (after open or a full sync). */
    loadLogState(base) {
        const last = this.native.edgeKey(exports.REPL_TABLE, true);
        if (last) {
            const lsn = (0, exports.lsnOf)(last);
            const entry = this.readLog(lsn - 1, 1)[0];
            this.lastLsn = Math.max(lsn, base.lsn);
            this.lastTerm = entry && lsn >= base.lsn ? entry.term : base.term;
        }
        else {
            this.lastLsn = base.lsn;
            this.lastTerm = base.term;
        }
        this.committedLsn = this.lastLsn;
    }
    /** Oldest LSN still in the log (0 = empty). */
    firstLsn() {
        const k = this.native.edgeKey(exports.REPL_TABLE, false);
        return k ? (0, exports.lsnOf)(k) : 0;
    }
    /** Log entries with LSN > after, up to maxEntries / ~maxBytes. */
    readLog(after, maxEntries, maxBytes = 8 * 1024 * 1024) {
        const out = [];
        const page = this.native.scanRange(exports.REPL_TABLE, lsnKey(after + 1), true, null, maxEntries);
        let bytes = 0;
        for (const [k, v] of unpackEntries(page)) {
            const e = packr.unpack(v);
            out.push({ lsn: (0, exports.lsnOf)(k), term: e.t, tables: e.tb, ops: Buffer.from(e.ops) });
            bytes += v.length;
            if (bytes >= maxBytes)
                break;
        }
        return out;
    }
    /** Replica: applies shipped log entries in one atomic commit (and keeps them in its own log). */
    applyEntries(entries, durable) {
        if (entries.length === 0)
            return;
        const w = new OpWriter();
        for (const e of entries) {
            if (e.lsn !== this.lastLsn + 1 && this.lastLsn !== 0)
                throw new Error(`Replication gap: expected LSN ${this.lastLsn + 1}, got ${e.lsn}`);
            forEachOp(e.ops, e.tables, (kind, table, key, value) => w.push(kind, table, key, value));
            w.push(OP_PUT, exports.REPL_TABLE, lsnKey(e.lsn), packr.pack({ t: e.term, tb: e.tables, ops: e.ops }));
            this.lastLsn = e.lsn;
            this.lastTerm = e.term;
        }
        this.native.commitSync(w.tables, w.bytes, durable);
        this.stats.commits++;
        this.stats.opsCommitted += w.count;
        this.committedLsn = this.lastLsn;
    }
    /** Deletes log entries below `lsn` (retention). */
    trimLog(lsn) {
        if (lsn <= 1)
            return;
        const w = new OpWriter();
        w.push(OP_DEL_RANGE, exports.REPL_TABLE, lsnKey(0), lsnKey(lsn));
        this.native.commitSync(w.tables, w.bytes, false);
    }
    /** Replica full resync: removes every table (data, indexes, metadata, log). */
    wipe() {
        this.flushSync();
        const w = new OpWriter();
        for (const t of this.native.listTables())
            if (t !== exports.CLUSTER_TABLE)
                w.push(OP_DROP, t);
        if (w.count)
            this.native.commitSync(w.tables, w.bytes, true);
        this.young.clear();
        this.old.clear();
        this.youngBytes = this.oldBytes = 0;
        this.lastLsn = 0;
        this.lastTerm = 0;
        this.committedLsn = 0;
    }
    /** Raw table copy for full resync (key/value pairs straight into the store). */
    writeRaw(table, entries) {
        if (entries.length === 0)
            return;
        const w = new OpWriter();
        for (const [k, v] of entries)
            w.push(OP_PUT, table, k, v);
        this.native.commitSync(w.tables, w.bytes, false);
    }
    /** Node-local key/value state (cluster term, vote) — not replicated, not logged. */
    getLocal(key) {
        const v = this.native.get(exports.CLUSTER_TABLE, Buffer.from(key));
        return v ? packr.unpack(v) : undefined;
    }
    setLocal(key, value) {
        const w = new OpWriter();
        w.push(OP_PUT, exports.CLUSTER_TABLE, Buffer.from(key), packr.pack(value));
        this.native.commitSync(w.tables, w.bytes, true);
    }
    /** Runs `fn` with the replica write guard lifted (applying replicated state). */
    asApplier(fn) {
        const was = this.applying;
        this.applying = true;
        try {
            return fn();
        }
        finally {
            this.applying = was;
        }
    }
    flush() {
        this.scheduled = false;
        if (this.inFlight || this.closed)
            return;
        const batch = this.cut();
        if (!batch) {
            this.markCommitted(this.batchSeq++); // nothing to write: the batch is trivially committed
            return;
        }
        const { ops, seq, lsn } = batch;
        this.inFlight = this.native.commit(ops.tables, ops.bytes, this.durable).then(() => {
            this.stats.commits++;
            this.stats.opsCommitted += ops.count;
            if (!this.durable)
                this.lazyDurable();
            this.markCommitted(seq);
            this.logCommitted(lsn);
        }, (err) => this.commitFailed(ops, seq, lsn, err)).finally(() => {
            this.inFlight = null;
            if (this.pending.count > 0 || this.retry)
                this.schedule();
        });
    }
    commitFailed(ops, seq, lsn, err) {
        this.stats.commitFailures++;
        this.stats.lastError = `${new Date().toISOString()} ${err.message}`;
        console.error(`❌ Disk commit failed (${ops.count} ops): ${err.message}`);
        // Waiters for this batch learn that their writes are not durable.
        const failed = this.waiters.filter((w) => w.seq <= seq);
        this.waiters = this.waiters.filter((w) => w.seq > seq);
        for (const w of failed)
            w.reject(new Error(`Write could not be saved to disk: ${err.message}`));
        if (this.committedSeq >= seq)
            return; // a later sync commit already superseded it
        // Keep the data (still visible via the overlay) and retry it before anything newer.
        this.retry = { ops, seq, lsn };
        setTimeout(() => this.schedule(), 1000).unref();
    }
    markCommitted(seq) {
        if (seq > this.committedSeq)
            this.committedSeq = seq;
        for (const [s, list] of this.inFlightCleanups) {
            if (s > this.committedSeq)
                break;
            for (const fn of list)
                fn();
            this.inFlightCleanups.delete(s);
        }
        if (this.waiters.length) {
            const ready = this.waiters.filter((w) => w.seq <= this.committedSeq);
            this.waiters = this.waiters.filter((w) => w.seq > this.committedSeq);
            for (const w of ready)
                w.resolve();
        }
    }
    lazyDurable() {
        this.needsDurable = true;
        if (this.lazyTimer)
            return;
        this.lazyTimer = setTimeout(() => {
            this.lazyTimer = null;
            if (!this.needsDurable || this.closed)
                return;
            this.needsDurable = false;
            this.native.commit([], EMPTY_BUF, true).catch((e) => console.error('❌ Disk sync failed:', e.message));
        }, LAZY_DURABLE_MS);
        this.lazyTimer.unref();
    }
    /** Resolves once every write made before the call is committed. */
    sync() {
        if (!this.hasPending())
            return Promise.resolve();
        const target = this.pending.count > 0 || this.scheduled ? this.batchSeq : this.batchSeq - 1;
        if (this.committedSeq >= target)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.waiters.push({ seq: target, resolve, reject });
            this.schedule();
        });
    }
    /** Commits everything pending now, durably, blocking until done. */
    flushSync() {
        if (this.closed)
            return;
        this.scheduled = false;
        for (;;) {
            const batch = this.cut();
            if (!batch) {
                // Commits are applied in order, so an empty durable commit waits for the in-flight batch.
                if (this.inFlight)
                    this.native.commitSync([], EMPTY_BUF, true);
                this.markCommitted(this.batchSeq++);
                return;
            }
            this.native.commitSync(batch.ops.tables, batch.ops.bytes, true);
            this.stats.commits++;
            this.stats.opsCommitted += batch.ops.count;
            this.needsDurable = false;
            this.markCommitted(batch.seq);
            this.logCommitted(batch.lsn);
        }
    }
    close() {
        if (this.closed)
            return;
        this.flushSync();
        this.closed = true;
        if (this.lazyTimer)
            clearTimeout(this.lazyTimer);
        this.native.close();
        this.young.clear();
        this.old.clear();
        this.youngBytes = this.oldBytes = 0;
    }
    // ── document cache ──
    rotate() {
        if (this.youngBytes <= this.cacheBudget / 2)
            return;
        this.old = this.young;
        this.oldBytes = this.youngBytes;
        this.young = new Map();
        this.youngBytes = 0;
    }
    cacheGet(key) {
        const y = this.young.get(key);
        if (y) {
            this.stats.cacheHits++;
            return y.doc;
        }
        const o = this.old.get(key);
        if (!o) {
            this.stats.cacheMisses++;
            return undefined;
        }
        this.stats.cacheHits++;
        this.old.delete(key);
        this.oldBytes -= o.bytes;
        this.young.set(key, o);
        this.youngBytes += o.bytes;
        this.rotate();
        return o.doc;
    }
    cacheSet(key, doc, packedBytes) {
        const bytes = packedBytes * 3 + 120; // rough in-memory size of the decoded object
        const prev = this.young.get(key);
        if (prev)
            this.youngBytes -= prev.bytes;
        const stale = this.old.get(key);
        if (stale) {
            this.old.delete(key);
            this.oldBytes -= stale.bytes;
        }
        this.young.set(key, { doc, bytes });
        this.youngBytes += bytes;
        this.rotate();
    }
    cacheDelete(key) {
        const y = this.young.get(key);
        if (y) {
            this.young.delete(key);
            this.youngBytes -= y.bytes;
        }
        const o = this.old.get(key);
        if (o) {
            this.old.delete(key);
            this.oldBytes -= o.bytes;
        }
    }
    cacheInfo() {
        return { entries: this.young.size + this.old.size, bytes: this.youngBytes + this.oldBytes, budgetBytes: this.cacheBudget };
    }
    // ── metadata table ──
    putMeta(key, value) {
        this.put('meta', Buffer.from(key), packr.pack(value));
    }
    deleteMeta(key) {
        this.del('meta', Buffer.from(key));
    }
    unpackValue(buf) {
        return packr.unpack(buf);
    }
    readAllMeta() {
        const out = [];
        for (const [k, v] of this.scanAll('meta'))
            out.push([k.toString(), packr.unpack(v)]);
        return out;
    }
    /** Every entry of a table in key order, one page per native call. */
    *scanAll(table) {
        let after = null;
        for (;;) {
            const page = this.native.scan(table, after, SCAN_PAGE);
            if (page.length === 0)
                return;
            let last = null;
            let n = 0;
            for (const e of unpackEntries(page)) {
                last = e[0];
                n++;
                yield e;
            }
            if (n < SCAN_PAGE || !last)
                return;
            after = Buffer.from(last); // copy: the page buffer is released after this
        }
    }
    // ── bulk writes (bypass the overlay; call flushSync() first) ──
    newChunk() {
        return new OpWriter();
    }
    writeChunk(ops, durable = false) {
        if (ops.count === 0 && !durable)
            return;
        if (this.readOnly && !this.applying)
            throw new Error(this.readOnly);
        const lsn = this.logBatch(ops);
        this.native.commitSync(ops.tables, ops.bytes, durable);
        this.stats.commits++;
        this.stats.opsCommitted += ops.count;
        this.logCommitted(lsn);
    }
}
exports.DiskStorage = DiskStorage;
exports.BULK_OP_PUT = OP_PUT;
exports.BULK_OP_DROP = OP_DROP;
// ───────────────────────────── disk documents ─────────────────────────────
function packDoc(doc) {
    return packr.pack(doc);
}
let nextCacheUid = 1;
/** A rack's documents on disk, with a Map-like API. */
class DiskDocMap {
    storage;
    table;
    overlay = new Map();
    /** The on-disk table is ignored until this batch commits (right after a clear/drop). */
    hiddenUntil;
    /**
     * Cache namespace, unique per map instance and renewed on clear(), so a
     * re-created or restored rack never sees cached documents of an old one.
     */
    uid = nextCacheUid++;
    count;
    constructor(storage, table, count, fresh) {
        this.storage = storage;
        this.table = table;
        this.count = count;
        this.hiddenUntil = fresh ? storage.currentSeq : 0;
    }
    hidden() {
        return this.storage.committedSeq < this.hiddenUntil;
    }
    ck(id) {
        return `${this.uid}\u0000${id}`;
    }
    get size() {
        return this.count;
    }
    /** For bulk loads that wrote documents with writeChunk(). */
    setCount(n) {
        this.count = n;
    }
    /** Replica: a document changed on disk underneath us — forget any cached copy. */
    invalidate(id) {
        this.overlay.delete(id);
        this.storage.cacheDelete(this.ck(id));
    }
    /** Replica: the table was dropped/replaced on disk — forget everything cached. */
    resetLocal(count) {
        this.overlay.clear();
        this.uid = nextCacheUid++;
        this.count = count;
        this.hiddenUntil = 0;
    }
    get(id) {
        const o = this.overlay.get(id);
        if (o)
            return o.doc ?? undefined;
        const key = this.ck(id);
        const cached = this.storage.cacheGet(key);
        if (cached)
            return cached;
        if (this.hidden())
            return undefined;
        const buf = this.storage.native.get(this.table, encodeId(id));
        if (!buf)
            return undefined;
        const doc = packr.unpack(buf);
        this.storage.cacheSet(key, doc, buf.length);
        return doc;
    }
    getMany(ids) {
        const out = new Array(ids.length);
        const missIdx = [];
        for (let i = 0; i < ids.length; i++) {
            const o = this.overlay.get(ids[i]);
            if (o) {
                out[i] = o.doc ?? undefined;
                continue;
            }
            const cached = this.storage.cacheGet(this.ck(ids[i]));
            if (cached) {
                out[i] = cached;
                continue;
            }
            missIdx.push(i);
        }
        if (missIdx.length > 0 && !this.hidden()) {
            const packed = this.storage.native.getMany(this.table, packKeys(missIdx.map((i) => encodeId(ids[i]))));
            let j = 0;
            for (const buf of unpackValues(packed)) {
                const i = missIdx[j++];
                if (!buf)
                    continue;
                const doc = packr.unpack(buf);
                this.storage.cacheSet(this.ck(ids[i]), doc, buf.length);
                out[i] = doc;
            }
        }
        return out;
    }
    has(id) {
        return this.get(id) !== undefined;
    }
    write(id, doc) {
        const seq = this.storage.currentSeq;
        this.overlay.set(id, { doc, seq });
        const cleanup = () => {
            const o = this.overlay.get(id);
            if (o && o.seq <= seq)
                this.overlay.delete(id);
        };
        if (doc) {
            const buf = packr.pack(doc);
            this.storage.cacheSet(this.ck(id), doc, buf.length);
            this.storage.put(this.table, encodeId(id), buf, cleanup);
        }
        else {
            this.storage.cacheDelete(this.ck(id));
            this.storage.del(this.table, encodeId(id), cleanup);
        }
    }
    set(id, doc) {
        const existed = this.has(id);
        this.write(id, doc);
        if (!existed)
            this.count++;
        return this;
    }
    add(id, doc) {
        this.write(id, doc);
        this.count++;
    }
    delete(id) {
        if (!this.has(id))
            return false;
        this.write(id, null);
        this.count--;
        return true;
    }
    clear() {
        this.storage.dropTable(this.table);
        this.overlay.clear();
        this.uid = nextCacheUid++;
        this.count = 0;
        this.hiddenUntil = this.storage.currentSeq;
    }
    /**
     * Key-ordered iteration: disk pages merged with uncommitted writes.
     * The overlay is snapshotted at the start, so writes made by the loop
     * body itself are not visited (same as building a list first).
     */
    *entries() {
        const ov = Array.from(this.overlay, ([id, e]) => ({ id, key: encodeId(id), doc: e.doc }))
            .sort((a, b) => Buffer.compare(a.key, b.key));
        let oi = 0;
        if (!this.hidden()) {
            for (const [key, value] of this.storage.scanAll(this.table)) {
                while (oi < ov.length && Buffer.compare(ov[oi].key, key) < 0) {
                    const o = ov[oi++];
                    if (o.doc)
                        yield [o.id, o.doc];
                }
                if (oi < ov.length && Buffer.compare(ov[oi].key, key) === 0) {
                    const o = ov[oi++];
                    if (o.doc)
                        yield [o.id, o.doc];
                    continue;
                }
                yield [decodeId(key), packr.unpack(value)];
            }
        }
        while (oi < ov.length) {
            const o = ov[oi++];
            if (o.doc)
                yield [o.id, o.doc];
        }
    }
    *keys() {
        for (const [id] of this.entries())
            yield id;
    }
    *values() {
        for (const [, doc] of this.entries())
            yield doc;
    }
    /** Committed documents with id > `after`, in key order (pagination for bulk exports; ignores the overlay). */
    *committedAfter(after) {
        let lo = after === null ? null : encodeId(after);
        let incl = after === null;
        for (;;) {
            const page = this.storage.native.scanRange(this.table, lo, incl, null, SCAN_PAGE);
            if (page.length === 0)
                return;
            let last = null, n = 0;
            for (const [k, v] of unpackEntries(page)) {
                last = k;
                n++;
                yield [decodeId(k), packr.unpack(v)];
            }
            if (n < SCAN_PAGE || !last)
                return;
            lo = Buffer.from(last);
            incl = false;
        }
    }
    [Symbol.iterator]() {
        return this.entries();
    }
}
exports.DiskDocMap = DiskDocMap;
// ───────────────────────────── disk indexes ─────────────────────────────
const FF = Buffer.from([0xff]);
/**
 * A field index as an ordinary B-tree table whose keys are
 * encodeIndexKey(value) + encodeId(docId) (value: the doc id). Inserts are
 * O(log n) no matter how many documents share a value; equality is a prefix
 * scan and ranges are key ranges.
 */
class DiskIndexStore {
    storage;
    table;
    /** Uncommitted changes, by encoded index key. */
    overlay = new Map();
    hiddenUntil;
    building = false;
    chunk = null;
    chunkKeys = new Map();
    constructor(storage, table, fresh) {
        this.storage = storage;
        this.table = table;
        this.hiddenUntil = fresh ? storage.currentSeq : 0;
    }
    hidden() {
        return this.storage.committedSeq < this.hiddenUntil;
    }
    diskIds(lo, hi, out) {
        if (this.hidden())
            return;
        for (const b of unpackValues(this.storage.native.rangeValues(this.table, lo, true, hi, false, MAX_U32)))
            out.add(decodeId(b));
    }
    get(k) {
        const prefix = encodeIndexKey(k);
        const token = prefix.toString('latin1');
        const out = new Set();
        this.diskIds(prefix, Buffer.concat([prefix, FF]), out);
        if (this.building) {
            for (const id of this.chunkKeys.get(token) ?? [])
                out.add(id);
            return out;
        }
        const o = this.overlay.get(token);
        if (o) {
            for (const [id, e] of o.ids) {
                if (e.present)
                    out.add(id);
                else
                    out.delete(id);
            }
        }
        return out;
    }
    write(k, id, present) {
        const prefix = encodeIndexKey(k);
        const token = prefix.toString('latin1');
        const idKey = encodeId(id);
        const key = Buffer.concat([prefix, idKey]);
        if (this.building) {
            let s = this.chunkKeys.get(token);
            if (!s)
                this.chunkKeys.set(token, (s = new Set()));
            s.add(id);
            this.chunk.push(OP_PUT, this.table, key, idKey);
            if (this.chunk.count >= BUILD_CHUNK)
                this.flushChunk(false);
            return;
        }
        let o = this.overlay.get(token);
        if (!o)
            this.overlay.set(token, (o = { prefix, ids: new Map() }));
        const seq = this.storage.currentSeq;
        o.ids.set(id, { present, seq });
        const entry = o;
        const cleanup = () => {
            const e = entry.ids.get(id);
            if (e && e.seq <= seq)
                entry.ids.delete(id);
            if (entry.ids.size === 0 && this.overlay.get(token) === entry)
                this.overlay.delete(token);
        };
        if (present)
            this.storage.put(this.table, key, idKey, cleanup);
        else
            this.storage.del(this.table, key, cleanup);
    }
    add(k, id) {
        this.write(k, id, true);
    }
    remove(k, id) {
        this.write(k, id, false);
    }
    range(type, lo, hi) {
        const tag = type === 'number' ? K_NUM : K_STR;
        // Half-open [loBuf, hiBuf): an id suffix always sorts below FF.
        const loBuf = lo ? (lo.incl ? encodeIndexKey(lo.v) : Buffer.concat([encodeIndexKey(lo.v), FF])) : Buffer.from([tag]);
        const hiBuf = hi ? (hi.incl ? Buffer.concat([encodeIndexKey(hi.v), FF]) : encodeIndexKey(hi.v)) : Buffer.from([tag + 1]);
        const out = new Set();
        if (Buffer.compare(loBuf, hiBuf) >= 0)
            return out;
        this.diskIds(loBuf, hiBuf, out);
        // Uncommitted additions in range. (Uncommitted removals are left in: a superset is fine.)
        for (const o of this.overlay.values()) {
            if (Buffer.compare(o.prefix, loBuf) >= 0 && Buffer.compare(o.prefix, hiBuf) < 0) {
                for (const [id, e] of o.ids)
                    if (e.present)
                        out.add(id);
            }
        }
        return out;
    }
    info() {
        return { entries: this.hidden() ? 0 : this.storage.native.count(this.table) };
    }
    clear() {
        this.storage.dropTable(this.table);
        this.overlay.clear();
        this.hiddenUntil = this.storage.currentSeq;
    }
    drop() {
        this.clear();
    }
    /** Bulk (re)build: writes straight to disk in chunks instead of through the overlay. */
    beginBuild() {
        this.storage.flushSync(); // order: earlier pending writes (and drops) land first
        const w = this.storage.newChunk();
        w.push(OP_DROP, this.table);
        this.storage.writeChunk(w);
        this.overlay.clear();
        this.hiddenUntil = 0;
        this.building = true;
        this.chunk = this.storage.newChunk();
        this.chunkKeys.clear();
    }
    flushChunk(durable) {
        this.storage.writeChunk(this.chunk, durable);
        this.chunk = this.storage.newChunk();
        this.chunkKeys.clear();
    }
    endBuild() {
        this.flushChunk(true);
        this.building = false;
        this.chunk = null;
    }
    abortBuild() {
        this.building = false;
        this.chunk = null;
        this.chunkKeys.clear();
        const w = this.storage.newChunk();
        w.push(OP_DROP, this.table);
        this.storage.writeChunk(w, true);
    }
}
exports.DiskIndexStore = DiskIndexStore;
//# sourceMappingURL=disk-store.js.map