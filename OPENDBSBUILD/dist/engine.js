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
exports.OpenDBSEngine = exports.FIELD_TYPES = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const security_middleware_1 = require("./middleware/security.middleware");
const native_search_service_1 = require("./services/native-search.service");
const store = __importStar(require("./storage/persistence"));
const encryption_1 = require("./storage/encryption");
const matcher_1 = require("./query/matcher");
const aggregate_1 = require("./query/aggregate");
const config_1 = require("./config");
const disk_store_1 = require("./storage/disk-store");
const query_pool_1 = require("./services/query-pool");
const agg_state_1 = require("./sql/agg-state");
const functions_1 = require("./sql/functions");
const executor_1 = require("./sql/executor");
exports.FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'array', 'object'];
/** SQL column names: plain identifiers, no dots (no nesting in a table). */
const COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const RESERVED_COLUMNS = new Set(['id', '_metadata', '__proto__', 'constructor', 'prototype']);
// Snapshot is forced at least this often while a rack keeps receiving
// writes, and whenever the WAL grows past MAX_WAL_ENTRIES -- bounds both
// WAL size and replay time after a crash.
const MAX_SNAPSHOT_DELAY_MS = 30_000;
const MAX_WAL_ENTRIES = 50_000;
const EMPTY_SET = new Set();
/** Documents per commit when bulk-loading a rack into disk storage. */
const BULK_CHUNK = 20_000;
/** Metadata key prefix for databases ('#' can't appear in identifiers, so no clash with "db/rack"). */
const DB_META_PREFIX = '#db/';
const hasOwn = Object.prototype.hasOwnProperty;
class OpenDBSEngine {
    databases;
    dataPath;
    nativeSearch;
    versionCounter = 0;
    persistDebounceMs;
    walFsync;
    queryCacheEntries;
    queryCache = new Map();
    /** Encrypts snapshots and WAL records at rest (null = plaintext). */
    cipher;
    /** Disk storage engine; null = in-memory engine with snapshots + WAL. */
    disk = null;
    /** Racks whose metadata (count, nextId, schema, indexes) must be written with the next disk batch. */
    metaDirty = new Set();
    migratedRacks = 0;
    /** Worker threads for parallel scans (disk engine); undefined until first needed. */
    pool;
    queryWorkers;
    /** Racks smaller than this are scanned on the main thread (parallelism doesn't pay off). */
    parallelMinDocs;
    // ── group commit ──
    // Writes append to the WAL synchronously (page cache); durability comes
    // from syncWal(), which fsyncs every dirty WAL once for *all* writes made
    // since the last sync. Concurrent requests therefore share one fsync.
    dirtyWalFds = new Set();
    syncingFds = new Set();
    writeSeq = 0;
    syncedSeq = 0;
    syncInFlight = null;
    stats = {
        cacheHits: 0,
        cacheMisses: 0,
        indexedQueries: 0,
        fullScans: 0,
        walWrites: 0,
        snapshots: 0,
        snapshotFailures: 0,
        lastSnapshotAt: null,
        lastSnapshotMs: 0,
        walRecordsReplayed: 0,
        filesEncrypted: 0,
        fsyncs: 0,
        transactions: 0,
        startedAt: new Date().toISOString(),
    };
    constructor(dbPath, options = {}) {
        this.dataPath = dbPath;
        this.databases = new Map();
        this.queryWorkers = options.queryWorkers ?? query_pool_1.QueryPool.defaultSize();
        this.parallelMinDocs = options.parallelMinDocs ?? 20_000;
        this.persistDebounceMs = options.persistDebounceMs ?? config_1.config.persistDebounceMs;
        this.walFsync = options.walFsync ?? config_1.config.walFsync;
        this.queryCacheEntries = options.queryCacheEntries ?? config_1.config.queryCacheEntries;
        this.cipher = options.cipher !== undefined ? options.cipher : (0, encryption_1.resolveEncryption)().cipher;
        this.nativeSearch = new native_search_service_1.NativeSearchService(this.dataPath);
        if (!fs.existsSync(this.dataPath)) {
            fs.mkdirSync(this.dataPath, { recursive: true });
        }
        let wanted = options.storage ?? config_1.config.storageEngine;
        if (wanted === 'disk' && !(0, disk_store_1.diskStorageAvailable)()) {
            console.warn('⚠️  STORAGE_ENGINE=disk needs the native addon, which is not built for this platform. Using the in-memory engine.');
            wanted = 'memory';
        }
        if (wanted === 'disk') {
            this.disk = this.openDiskStorage(options.cacheMB ?? config_1.config.cacheSizeMB, this.walFsync);
            this.disk.beforeFlush = () => this.writeDirtyMeta();
        }
        try {
            this.loadAll();
            this.recoverTransactions();
        }
        catch (err) {
            this.disk?.close();
            throw err;
        }
        if (!options.quiet) {
            if (this.disk) {
                console.log(`📦 OpenDBS Engine: disk storage at ${this.disk.file} (RAM cache ${options.cacheMB ?? config_1.config.cacheSizeMB} MB)` +
                    (this.migratedRacks ? ` — imported ${this.migratedRacks} rack file(s)` : ''));
                console.log(`⚡ Write mode: ACID B-tree, group commit${this.walFsync ? ' + fsync before every acknowledgement' : ' (fsync at most every 1s)'}`);
            }
            else {
                console.log(`📦 OpenDBS Engine: in-memory storage, persisted at ${this.dataPath} (.odbs + WAL)`);
                console.log(this.persistDebounceMs === 0
                    ? '⚡ Write mode: synchronous snapshot per write (PERSIST_DEBOUNCE_MS=0)'
                    : `⚡ Write mode: WAL${this.walFsync ? ' + fsync (group commit)' : ''}, background snapshots every ≤${this.persistDebounceMs}ms idle`);
            }
            console.log(this.cipher
                ? `🔐 Encryption at rest: ${this.disk ? 'AES-256-XTS (storage file) + AES-256-GCM (backups)' : 'AES-256-GCM'} (key ${this.cipher.fingerprint})${this.stats.filesEncrypted ? ` — encrypted ${this.stats.filesEncrypted} existing rack file(s)` : ''}`
                : '🔓 Encryption at rest: OFF (ENCRYPTION_AT_REST=false)');
            console.log(this.nativeSearch.available
                ? '🚀 Native search accelerator: enabled (Rust trigram + HNSW vector index)'
                : '🟡 Native search accelerator: unavailable, using pure-JS fuzzy/vector search');
        }
        // Persisting the native search index is a relatively expensive full
        // rewrite, so it isn't done on every single insert -- periodic flush
        // plus an explicit flush after bulk operations (see insertMany /
        // createTextIndex / createVectorIndex) keeps staleness bounded even
        // without a clean shutdown.
        this.nativeFlushTimer = setInterval(() => this.nativeSearch.flush(), 5 * 60 * 1000);
        this.nativeFlushTimer.unref();
    }
    nativeFlushTimer;
    /** Persists the native search index to disk. Call on graceful shutdown. */
    flushNativeSearch() {
        this.nativeSearch.flush();
    }
    // ───────────────────────────────────────────────────────────────────
    // Paths & loading
    // ───────────────────────────────────────────────────────────────────
    getDatabasePath(dbName) {
        if (!(0, security_middleware_1.validateIdentifier)(dbName))
            throw new Error(`Invalid database name '${dbName}'`);
        return path.join(this.dataPath, dbName);
    }
    getRackPath(dbName, rackName) {
        if (!(0, security_middleware_1.validateIdentifier)(rackName))
            throw new Error(`Invalid rack name '${rackName}'`);
        return path.join(this.getDatabasePath(dbName), `${rackName}.odbs`);
    }
    docTable(dbName, rackName) {
        return `d/${dbName}/${rackName}`;
    }
    indexTable(rack, indexName) {
        return `i/${rack.dbName}/${rack.name}/${indexName}`;
    }
    indexTableSeq = 0;
    /**
     * Every disk index build gets its own table (name recorded in the rack
     * metadata), so rebuilding an index never touches the one still in use
     * until the new one is complete.
     */
    newIndexStore(rack, indexName) {
        if (!this.disk || !(rack.documents instanceof disk_store_1.DiskDocMap))
            return new disk_store_1.MemoryIndexStore();
        const table = `${this.indexTable(rack, indexName)}#${Date.now().toString(36)}${(++this.indexTableSeq).toString(36)}`;
        return new disk_store_1.DiskIndexStore(this.disk, table, true);
    }
    loadAll() {
        try {
            // Disk engine: racks are listed in the storage file's metadata table.
            // Memory engine: a storage file left by the disk engine is converted back to .odbs files first.
            if (this.disk)
                this.loadFromDiskStore();
            else
                this.exportDiskStoreIfPresent();
            const items = fs.readdirSync(this.dataPath);
            for (const item of items) {
                // Only real database directories -- skips .search-index and
                // anything else that isn't a valid identifier.
                if (!(0, security_middleware_1.validateIdentifier)(item))
                    continue;
                const dbPath = path.join(this.dataPath, item);
                if (!fs.statSync(dbPath).isDirectory())
                    continue;
                if (!this.databases.has(item))
                    this.databases.set(item, { name: item, racks: new Map() });
                store.cleanupTempFiles(dbPath);
                for (const file of fs.readdirSync(dbPath)) {
                    if (!file.endsWith('.odbs'))
                        continue;
                    const rackName = path.basename(file, '.odbs');
                    if (!(0, security_middleware_1.validateIdentifier)(rackName))
                        continue;
                    this.loadRack(item, rackName);
                }
            }
        }
        catch (error) {
            if (error instanceof encryption_1.EncryptionKeyError) {
                throw new encryption_1.EncryptionKeyError(`${error.message}. Check DB_ENCRYPTION_KEY / DB_ENCRYPTION_KEY_FILE / opendbs.key ` +
                    `(this server's key fingerprint: ${this.cipher?.fingerprint ?? 'none — encryption disabled'}). No files were changed.`);
            }
            console.error('Failed to load data:', error);
        }
    }
    /**
     * `fresh`: a new, empty rack (its disk table is ignored until the current
     * batch commits, in case a dropped rack of the same name is still being
     * removed). `inMemory` forces RAM storage (temporary racks during import).
     */
    newRack(dbName, name, type, schema, opts = {}) {
        const fresh = opts.fresh ?? true;
        return {
            name,
            dbName,
            documents: this.disk && !opts.inMemory
                ? new disk_store_1.DiskDocMap(this.disk, this.docTable(dbName, name), opts.count ?? 0, fresh)
                : new disk_store_1.MemoryDocStore(),
            nextId: 1,
            indices: new Map(),
            textIndexedFields: new Set(),
            vectorIndexedFields: new Set(),
            type,
            schema,
            createdAt: new Date(),
            version: ++this.versionCounter,
            walGen: 0,
            walFd: null,
            walEntries: 0,
            dirty: false,
            firstDirtyAt: 0,
            timer: null,
            snapSeq: 0,
            inFlight: false,
            pendingAfterFlight: false,
            dropped: false,
        };
    }
    /** Builds an in-memory rack (documents + settings, no indexes) from decoded snapshot data. */
    rackFromSnapshot(dbName, rackName, data) {
        const rack = this.newRack(dbName, rackName, data.type || 'nosql', data.schema ?? undefined, { inMemory: true });
        rack.nextId = data.nextId || 1;
        rack.textIndexedFields = new Set(data.textIndexedFields || []);
        rack.vectorIndexedFields = new Set(data.vectorIndexedFields || []);
        rack.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
        rack.walGen = typeof data.walGen === 'number' ? data.walGen : 0;
        if (Array.isArray(data.documents)) {
            for (const doc of data.documents)
                rack.documents.set(doc.id, doc);
        }
        else if (data.documents && typeof data.documents === 'object') {
            for (const [id, doc] of Object.entries(data.documents))
                rack.documents.set(id, doc);
        }
        const indexDefs = Array.isArray(data.indexes)
            ? data.indexes
            : (Array.isArray(data.indexedFields) ? data.indexedFields : []).map((f) => ({ field: f }));
        return { rack, indexDefs };
    }
    /** Racks (and databases) recorded in the disk store's metadata table. */
    loadFromDiskStore() {
        for (const [key, meta] of this.disk.readAllMeta()) {
            if (key.startsWith(DB_META_PREFIX)) {
                this.ensureDatabaseLocal(key.slice(DB_META_PREFIX.length));
                continue;
            }
            const [dbName, rackName] = key.split('/');
            if (!(0, security_middleware_1.validateIdentifier)(dbName) || !(0, security_middleware_1.validateIdentifier)(rackName) || !meta)
                continue;
            const db = this.ensureDatabaseLocal(dbName);
            if (db)
                db.racks.set(rackName, this.rackFromMeta(dbName, rackName, meta));
        }
    }
    ensureDatabaseLocal(name) {
        if (!(0, security_middleware_1.validateIdentifier)(name))
            return null;
        let db = this.databases.get(name);
        if (!db) {
            db = { name, racks: new Map() };
            this.databases.set(name, db);
            fs.mkdirSync(path.join(this.dataPath, name), { recursive: true });
        }
        return db;
    }
    rackFromMeta(dbName, rackName, meta) {
        const rack = this.newRack(dbName, rackName, meta.type || 'nosql', meta.schema ?? undefined, { fresh: false, count: meta.count || 0 });
        this.applyRackMeta(rack, meta);
        return rack;
    }
    /** Copies stored rack settings (counters, schema, indexes) onto a rack object. */
    applyRackMeta(rack, meta) {
        const disk = this.disk;
        rack.type = meta.type || 'nosql';
        rack.schema = meta.schema ?? undefined;
        rack.nextId = meta.nextId || 1;
        rack.textIndexedFields = new Set(meta.textIndexedFields || []);
        rack.vectorIndexedFields = new Set(meta.vectorIndexedFields || []);
        rack.createdAt = meta.createdAt ? new Date(meta.createdAt) : new Date();
        const indices = new Map();
        for (const def of meta.indexes || []) {
            const fields = Array.isArray(def.fields) && def.fields.length > 1 ? def.fields : undefined;
            const name = fields ? fields.join('+') : def.field;
            const table = typeof def.table === 'string' ? def.table : this.indexTable(rack, name);
            const prev = rack.indices.get(name);
            indices.set(name, {
                field: name, fields, unique: Boolean(def.unique),
                store: prev?.store instanceof disk_store_1.DiskIndexStore && prev.store.table === table ? prev.store : new disk_store_1.DiskIndexStore(disk, table, false),
            });
        }
        rack.indices = indices;
    }
    // ───────────────────────────────────────────────────────────────────
    // Replication (disk engine)
    // ───────────────────────────────────────────────────────────────────
    /** The disk store (replication log access for the cluster layer), or null on the memory engine. */
    get replicationStore() {
        return this.disk;
    }
    /** True on a cluster replica: writes must go to the primary. */
    isReadOnly() {
        return Boolean(this.disk?.readOnly);
    }
    /** Documents in user databases (not the system database) — how much data a node holds. */
    userDocumentCount() {
        let n = 0;
        for (const [name, db] of this.databases) {
            if (name === '_opendbs_system')
                continue;
            for (const r of db.racks.values())
                n += r.documents.size;
        }
        return n;
    }
    /**
     * Replica: applies log entries shipped from the primary, then brings the
     * in-memory view (racks, schemas, indexes, caches, search indexes) in line.
     */
    applyReplicated(entries, durable) {
        const disk = this.disk;
        disk.asApplier(() => disk.applyEntries(entries, durable));
        const metaKeys = new Set();
        const docs = new Map();
        for (const e of entries) {
            (0, disk_store_1.forEachOp)(e.ops, e.tables, (kind, table, key) => {
                if (table === 'meta')
                    metaKeys.add(key.toString());
                else if (table.startsWith('d/')) {
                    if (kind === disk_store_1.BULK_OP_DROP)
                        docs.set(table, 'reset');
                    else {
                        const cur = docs.get(table);
                        if (cur === 'reset')
                            return;
                        if (!cur)
                            docs.set(table, new Set([(0, disk_store_1.decodeId)(key)]));
                        else
                            cur.add((0, disk_store_1.decodeId)(key));
                    }
                }
            });
        }
        const replaced = new Set();
        for (const k of metaKeys) {
            const r = this.refreshFromMeta(k);
            if (r)
                replaced.add(r);
        }
        for (const [table, change] of docs) {
            const [, dbName, rackName] = table.split('/');
            const rack = this.getRackObj(dbName, rackName);
            if (!rack || !(rack.documents instanceof disk_store_1.DiskDocMap))
                continue;
            const map = rack.documents;
            if (change === 'reset' || replaced.has(rack)) {
                map.resetLocal(map.size);
                if (rack.textIndexedFields.size || rack.vectorIndexedFields.size)
                    this.backfillNative(rack);
            }
            else {
                for (const id of change) {
                    map.invalidate(id);
                    if (rack.textIndexedFields.size || rack.vectorIndexedFields.size) {
                        const doc = map.get(id);
                        if (doc)
                            this.syncNativeIndexes(dbName, rackName, rack, id, doc.data);
                        else
                            this.removeFromNativeIndexes(dbName, rackName, rack, id);
                    }
                }
            }
            rack.version = ++this.versionCounter;
        }
    }
    /** Re-reads one metadata key after replication. Returns the rack if it was (re)created. */
    refreshFromMeta(key) {
        const raw = this.disk.native.get('meta', Buffer.from(key));
        const meta = raw ? this.disk.unpackValue(raw) : null;
        if (key.startsWith(DB_META_PREFIX)) {
            const name = key.slice(DB_META_PREFIX.length);
            if (meta)
                this.ensureDatabaseLocal(name);
            else if (this.databases.get(name)?.racks.size === 0) {
                this.databases.delete(name);
                fs.rmSync(path.join(this.dataPath, name), { recursive: true, force: true });
            }
            return null;
        }
        const [dbName, rackName] = key.split('/');
        if (!(0, security_middleware_1.validateIdentifier)(dbName) || !(0, security_middleware_1.validateIdentifier)(rackName))
            return null;
        const db = this.databases.get(dbName);
        const existing = db?.racks.get(rackName);
        if (!meta) {
            if (existing) {
                existing.dropped = true;
                db.racks.delete(rackName);
            }
            return null;
        }
        const target = this.ensureDatabaseLocal(dbName);
        if (!existing) {
            const rack = this.rackFromMeta(dbName, rackName, meta);
            target.racks.set(rackName, rack);
            if (rack.textIndexedFields.size || rack.vectorIndexedFields.size)
                this.backfillNative(rack);
            return rack;
        }
        const oldText = new Set(existing.textIndexedFields), oldVec = new Set(existing.vectorIndexedFields);
        this.applyRackMeta(existing, meta);
        existing.documents.setCount(meta.count || 0);
        existing.version = ++this.versionCounter;
        const textAdded = [...existing.textIndexedFields].some((f) => !oldText.has(f));
        const vecAdded = [...existing.vectorIndexedFields].some((f) => !oldVec.has(f));
        if (textAdded || vecAdded)
            this.backfillNative(existing);
        return null;
    }
    /** Rebuilds the native text/vector indexes of a rack from its documents (replicas). */
    backfillNative(rack) {
        for (const [id, doc] of rack.documents)
            this.syncNativeIndexes(rack.dbName, rack.name, rack, id, doc.data);
        this.nativeSearch.flush();
    }
    /** Replica after a full resync: rebuilds the whole in-memory view from the store. */
    reloadFromStore() {
        if (!this.disk)
            return;
        this.databases.clear();
        this.queryCache.clear();
        this.loadFromDiskStore();
        for (const db of this.databases.values()) {
            for (const rack of db.racks.values()) {
                if (rack.textIndexedFields.size || rack.vectorIndexedFields.size)
                    this.backfillNative(rack);
            }
        }
    }
    rackMeta(rack) {
        return {
            type: rack.type,
            schema: rack.schema ?? null,
            nextId: rack.nextId,
            count: rack.documents.size,
            indexes: Array.from(rack.indices.values()).map((i) => ({
                field: i.field,
                unique: i.unique,
                ...(i.fields ? { fields: i.fields } : {}),
                ...(i.store instanceof disk_store_1.DiskIndexStore ? { table: i.store.table } : {}),
            })),
            textIndexedFields: Array.from(rack.textIndexedFields),
            vectorIndexedFields: Array.from(rack.vectorIndexedFields),
            createdAt: rack.createdAt.toISOString(),
        };
    }
    /** Disk engine: appends the metadata of every rack changed this tick to the batch being committed. */
    writeDirtyMeta() {
        if (!this.disk || this.metaDirty.size === 0)
            return;
        for (const rack of this.metaDirty) {
            if (!rack.dropped)
                this.disk.putMeta(`${rack.dbName}/${rack.name}`, this.rackMeta(rack));
        }
        this.metaDirty.clear();
    }
    /** Disk engine: writes documents straight to the store in chunks (import, restore, duplicate). */
    bulkLoad(rack, docs) {
        const disk = this.disk;
        const map = rack.documents;
        disk.flushSync(); // pending drops of an earlier rack with the same name land first
        let chunk = disk.newChunk();
        let n = 0;
        for (const d of docs) {
            chunk.push(disk_store_1.BULK_OP_PUT, map.table, (0, disk_store_1.encodeId)(d.id), (0, disk_store_1.packDoc)(d));
            n++;
            if (chunk.count >= BULK_CHUNK) {
                disk.writeChunk(chunk);
                chunk = disk.newChunk();
            }
        }
        disk.writeChunk(chunk, true);
        map.setCount(n);
    }
    /**
     * Disk engine: replaces (or creates) a rack with the contents of an
     * in-memory rack -- used to import .odbs files and to restore backups.
     */
    importRack(db, src, indexDefs) {
        const existing = db.racks.get(src.name);
        if (existing) {
            this.dropRackState(db.name, existing);
            db.racks.delete(src.name);
        }
        const rack = this.newRack(db.name, src.name, src.type, src.schema);
        rack.nextId = src.nextId;
        rack.textIndexedFields = new Set(src.textIndexedFields);
        rack.vectorIndexedFields = new Set(src.vectorIndexedFields);
        rack.createdAt = src.createdAt;
        this.bulkLoad(rack, src.documents.values());
        for (const def of indexDefs) {
            const idx = this.buildIndex(rack, def.field, Boolean(def.unique), false, def.fields);
            rack.indices.set(idx.field, idx);
        }
        db.racks.set(rack.name, rack);
        rack.version = ++this.versionCounter;
        this.metaDirty.add(rack);
        this.disk.flushSync();
        return rack;
    }
    /**
     * Memory engine started on a data directory last used by the disk engine:
     * writes every rack back out as an .odbs snapshot, then retires the store file.
     */
    exportDiskStoreIfPresent() {
        const file = (0, disk_store_1.storeFilePath)(this.dataPath);
        if (!fs.existsSync(file))
            return;
        if (!(0, disk_store_1.diskStorageAvailable)()) {
            throw new Error(`${file} holds data written by the disk storage engine, but the native addon is missing here. ` +
                'Run with STORAGE_ENGINE=disk on a platform where the addon is built.');
        }
        const disk = this.openDiskStorage(64, true);
        try {
            let n = 0;
            for (const [key, meta] of disk.readAllMeta()) {
                const [dbName, rackName] = key.split('/');
                if (!(0, security_middleware_1.validateIdentifier)(dbName) || !(0, security_middleware_1.validateIdentifier)(rackName) || !meta)
                    continue;
                const docs = new disk_store_1.DiskDocMap(disk, this.docTable(dbName, rackName), meta.count || 0, false);
                const dbDir = path.join(this.dataPath, dbName);
                fs.mkdirSync(dbDir, { recursive: true });
                const data = {
                    documents: Array.from(docs.values()),
                    nextId: meta.nextId || 1,
                    indexedFields: (meta.indexes || []).map((i) => i.field),
                    indexes: meta.indexes || [],
                    textIndexedFields: meta.textIndexedFields || [],
                    vectorIndexedFields: meta.vectorIndexedFields || [],
                    type: meta.type || 'nosql',
                    schema: meta.schema ?? undefined,
                    createdAt: meta.createdAt,
                    walGen: 0,
                };
                // Older WAL files of this rack must not be replayed onto the exported snapshot.
                for (const [, p] of store.listWalFiles(dbDir, rackName))
                    fs.rmSync(p, { force: true });
                store.writeFileAtomicSync(path.join(dbDir, `${rackName}.odbs`), store.sealSnapshot(store.compressSync(store.encodeSnapshot(data).envelope), this.cipher));
                n++;
            }
            disk.close();
            fs.renameSync(file, `${file}.exported-${Date.now()}`);
            console.log(`♻️  STORAGE_ENGINE=memory: exported ${n} rack(s) from the disk store to .odbs files`);
        }
        catch (err) {
            try {
                disk.close();
            }
            catch { /* ignore */ }
            throw err;
        }
    }
    openDiskStorage(cacheMB, durable) {
        try {
            return new disk_store_1.DiskStorage(this.dataPath, { keyHex: this.cipher ? this.cipher.subkeyHex('disk-store-v1') : null, cacheMB, durable });
        }
        catch (err) {
            if (/wrong encryption key|not an OpenDBS encrypted/i.test(err?.message ?? '')) {
                throw new encryption_1.EncryptionKeyError(`Storage file ${(0, disk_store_1.storeFilePath)(this.dataPath)}: ${err.message}. Check DB_ENCRYPTION_KEY / ` +
                    `DB_ENCRYPTION_KEY_FILE / opendbs.key (this server's key fingerprint: ${this.cipher?.fingerprint ?? 'none — encryption disabled'}). No files were changed.`);
            }
            throw err;
        }
    }
    /**
     * Reads a rack's .odbs snapshot and replays its WAL into an in-memory
     * rack (not registered anywhere). Corrupt files are quarantined (null).
     */
    readRackFiles(dbName, rackName, buildIndexes) {
        const filePath = this.getRackPath(dbName, rackName);
        const dbDir = this.getDatabasePath(dbName);
        if (!fs.existsSync(filePath))
            return null;
        let data;
        let wasEncrypted = false;
        try {
            const opened = store.openSnapshot(fs.readFileSync(filePath), this.cipher);
            wasEncrypted = opened.encrypted;
            data = store.decodeSnapshot(opened.body);
        }
        catch (error) {
            // A wrong/missing key is a configuration problem, not corruption:
            // stop instead of quarantining every file.
            if (error instanceof encryption_1.EncryptionKeyError)
                throw error;
            // Quarantine instead of silently skipping: a later createRack with
            // the same name would otherwise overwrite the only copy.
            const quarantine = `${filePath}.corrupt-${Date.now()}`;
            try {
                fs.renameSync(filePath, quarantine);
            }
            catch { /* ignore */ }
            console.error(`❌ Failed to load ${dbName}/${rackName}.odbs (${error?.message}). File moved to ${path.basename(quarantine)}`);
            return null;
        }
        const { rack, indexDefs } = this.rackFromSnapshot(dbName, rackName, data);
        // ── WAL replay ──
        let replayed = 0;
        let plaintextWal = false;
        for (const [gen, walPath] of store.listWalFiles(dbDir, rackName)) {
            if (gen < rack.walGen) {
                // Already folded into the snapshot (crash after snapshot rename).
                try {
                    fs.unlinkSync(walPath);
                }
                catch { /* ignore */ }
                continue;
            }
            try {
                const { records, skipped, plaintext } = store.readWal(walPath, this.cipher);
                if (plaintext)
                    plaintextWal = true;
                if (skipped > 0) {
                    console.warn(`⚠️  ${dbName}/${rackName}: skipped ${skipped} unreadable WAL record(s) in ${path.basename(walPath)}`);
                }
                for (const r of records) {
                    if (r.o === 'p' && r.d && typeof r.d.id === 'string') {
                        rack.documents.set(r.d.id, r.d);
                        const n = Number(r.d.id);
                        if (Number.isInteger(n) && n >= rack.nextId)
                            rack.nextId = n + 1;
                    }
                    else if (r.o === 'd') {
                        rack.documents.delete(r.i);
                    }
                    else if (r.o === 'c') {
                        rack.documents.clear();
                    }
                }
                replayed += records.length;
            }
            catch (err) {
                if (err instanceof encryption_1.EncryptionKeyError)
                    throw err;
                console.error(`❌ Failed to replay WAL ${walPath}:`, err);
            }
            rack.walGen = Math.max(rack.walGen, gen);
        }
        if (buildIndexes) {
            for (const def of indexDefs) {
                const idx = this.buildIndex(rack, def.field, Boolean(def.unique), false, def.fields);
                rack.indices.set(idx.field, idx);
            }
        }
        if (replayed > 0) {
            this.stats.walRecordsReplayed += replayed;
            console.log(`♻️  ${dbName}/${rackName}: recovered ${replayed} write(s) from WAL`);
        }
        // Plaintext files from before encryption was enabled must be rewritten encrypted.
        const needsRewrite = this.cipher !== null && (!wasEncrypted || plaintextWal);
        return { rack, indexDefs, replayed, needsRewrite };
    }
    loadRack(dbName, rackName) {
        const db = this.databases.get(dbName);
        if (!db)
            return;
        const loaded = this.readRackFiles(dbName, rackName, !this.disk);
        if (!loaded)
            return;
        if (this.disk) {
            // Import into the disk store, then retire the files (kept as .odbs.migrated, still encrypted).
            this.importRack(db, loaded.rack, loaded.indexDefs);
            const file = this.getRackPath(dbName, rackName);
            fs.renameSync(file, `${file}.migrated`);
            for (const [, p] of store.listWalFiles(this.getDatabasePath(dbName), rackName))
                fs.rmSync(p, { force: true });
            this.migratedRacks++;
            return;
        }
        db.racks.set(rackName, loaded.rack);
        // Fold the WAL into a fresh snapshot right away (and encrypt legacy plaintext files).
        if (loaded.replayed > 0 || loaded.needsRewrite) {
            if (loaded.needsRewrite)
                this.stats.filesEncrypted++;
            this.snapshotSync(dbName, loaded.rack);
        }
    }
    // ───────────────────────────────────────────────────────────────────
    // Persistence
    // ───────────────────────────────────────────────────────────────────
    serializeRack(rack, walGen) {
        return {
            documents: Array.from(rack.documents.values()),
            nextId: rack.nextId,
            // indexedFields kept for readers of the V1 layout.
            indexedFields: Array.from(rack.indices.keys()),
            indexes: Array.from(rack.indices.values()).map((i) => (i.fields
                ? { field: i.field, unique: i.unique, fields: i.fields }
                : { field: i.field, unique: i.unique })),
            textIndexedFields: Array.from(rack.textIndexedFields),
            vectorIndexedFields: Array.from(rack.vectorIndexedFields),
            type: rack.type,
            schema: rack.schema,
            createdAt: rack.createdAt.toISOString(),
            walGen,
        };
    }
    closeWal(rack) {
        if (rack.walFd !== null) {
            // Unsynced records must reach the disk before the fd goes away -- including
            // an fd whose async fsync is queued but may not have run yet.
            if (this.dirtyWalFds.delete(rack.walFd) || this.syncingFds.has(rack.walFd)) {
                try {
                    fs.fsyncSync(rack.walFd);
                    this.stats.fsyncs++;
                }
                catch { /* ignore */ }
            }
            try {
                fs.closeSync(rack.walFd);
            }
            catch { /* ignore */ }
            rack.walFd = null;
        }
    }
    /**
     * Group commit: resolves once every write made before the call is on
     * stable storage. A single fsync per dirty WAL covers all writes that
     * happened since the previous sync, so N concurrent requests cost one
     * fsync instead of N. No-op when WAL_FSYNC is off.
     */
    async syncWal() {
        if (!this.walFsync)
            return;
        if (this.disk)
            return this.disk.sync();
        const target = this.writeSeq;
        while (this.syncedSeq < target) {
            if (this.syncInFlight) {
                await this.syncInFlight;
                continue;
            }
            const upTo = this.writeSeq;
            const fds = Array.from(this.dirtyWalFds);
            this.dirtyWalFds.clear();
            for (const fd of fds)
                this.syncingFds.add(fd);
            this.syncInFlight = (async () => {
                try {
                    await Promise.all(fds.map((fd) => new Promise((resolve, reject) => {
                        fs.fsync(fd, (err) => {
                            // EBADF: the WAL was rotated and closed meanwhile; closeWal already synced it.
                            if (err && err.code !== 'EBADF')
                                reject(err);
                            else
                                resolve();
                        });
                    })));
                    this.stats.fsyncs++;
                    this.syncedSeq = Math.max(this.syncedSeq, upTo);
                    // Every journaled transaction is now also durable in the rack WALs:
                    // the journal can be emptied (only if nothing was written meanwhile).
                    if (this.journalFd !== null && this.writeSeq === upTo) {
                        try {
                            fs.ftruncateSync(this.journalFd, 0);
                        }
                        catch { /* ignore */ }
                    }
                }
                catch (err) {
                    for (const fd of fds)
                        this.dirtyWalFds.add(fd); // retry next time
                    throw err;
                }
                finally {
                    for (const fd of fds)
                        this.syncingFds.delete(fd);
                    this.syncInFlight = null;
                }
            })();
            await this.syncInFlight;
        }
    }
    hasUnsyncedWrites() {
        if (this.disk)
            return this.walFsync && this.disk.hasPending();
        return this.walFsync && this.syncedSeq < this.writeSeq;
    }
    /** Rotates the WAL and packs the rack's current state (synchronously, so it is a consistent point-in-time view). */
    captureSnapshot(rack) {
        this.closeWal(rack);
        if (rack.timer) {
            clearTimeout(rack.timer);
            rack.timer = null;
        }
        const newGen = rack.walGen + 1;
        rack.walGen = newGen;
        rack.walEntries = 0;
        rack.dirty = false;
        return { envelope: store.encodeSnapshot(this.serializeRack(rack, newGen)).envelope, newGen };
    }
    deleteWalsBelow(dbName, rackName, gen) {
        for (const [g, p] of store.listWalFiles(this.getDatabasePath(dbName), rackName)) {
            if (g < gen) {
                try {
                    fs.unlinkSync(p);
                }
                catch { /* ignore */ }
            }
        }
    }
    snapshotSync(dbName, rack) {
        if (rack.dropped)
            return;
        if (this.disk) {
            // Disk engine: there are no snapshots; the rack's metadata rides along with the next batch.
            this.metaDirty.add(rack);
            this.disk.schedule();
            return;
        }
        const started = Date.now();
        const dbDir = this.getDatabasePath(dbName);
        if (!fs.existsSync(dbDir))
            fs.mkdirSync(dbDir, { recursive: true });
        const { envelope, newGen } = this.captureSnapshot(rack);
        rack.snapSeq++; // supersedes any in-flight async snapshot
        try {
            store.writeFileAtomicSync(this.getRackPath(dbName, rack.name), store.sealSnapshot(store.compressSync(envelope), this.cipher));
            this.deleteWalsBelow(dbName, rack.name, newGen);
            this.stats.snapshots++;
            this.stats.lastSnapshotAt = new Date().toISOString();
            this.stats.lastSnapshotMs = Date.now() - started;
        }
        catch (error) {
            // WAL files for older generations are still on disk, so nothing is lost.
            this.stats.snapshotFailures++;
            rack.dirty = true;
            console.error(`Failed to save rack ${rack.name}:`, error);
        }
    }
    snapshotAsync(dbName, rack) {
        if (rack.dropped || !rack.dirty)
            return;
        if (rack.inFlight) {
            rack.pendingAfterFlight = true;
            return;
        }
        const started = Date.now();
        let file;
        try {
            file = this.getRackPath(dbName, rack.name);
        }
        catch {
            return;
        }
        const { envelope, newGen } = this.captureSnapshot(rack);
        const seq = ++rack.snapSeq;
        rack.inFlight = true;
        (async () => {
            let tmp = null;
            try {
                // Brotli runs on the libuv thread pool -- the event loop keeps serving requests.
                const compressed = store.sealSnapshot(await store.compressAsync(envelope), this.cipher);
                tmp = await store.writeTempFile(file, compressed, String(seq));
                const stillCurrent = !rack.dropped &&
                    rack.snapSeq === seq &&
                    this.databases.get(dbName)?.racks.get(rack.name) === rack;
                if (!stillCurrent)
                    return;
                // Check + rename in the same tick: no sync snapshot can interleave.
                fs.renameSync(tmp, file);
                tmp = null;
                this.deleteWalsBelow(dbName, rack.name, newGen);
                this.stats.snapshots++;
                this.stats.lastSnapshotAt = new Date().toISOString();
                this.stats.lastSnapshotMs = Date.now() - started;
            }
            catch (error) {
                this.stats.snapshotFailures++;
                console.error(`Failed to save rack ${rack.name}:`, error);
                if (!rack.dropped) {
                    rack.dirty = true;
                    this.scheduleSnapshot(dbName, rack);
                }
            }
            finally {
                if (tmp)
                    fs.promises.unlink(tmp).catch(() => undefined);
                rack.inFlight = false;
                if (rack.pendingAfterFlight) {
                    rack.pendingAfterFlight = false;
                    this.snapshotAsync(dbName, rack);
                }
            }
        })();
    }
    scheduleSnapshot(dbName, rack) {
        if (rack.dropped)
            return;
        if (this.persistDebounceMs === 0) {
            this.snapshotSync(dbName, rack);
            return;
        }
        const now = Date.now();
        const overdue = now - rack.firstDirtyAt >= MAX_SNAPSHOT_DELAY_MS || rack.walEntries >= MAX_WAL_ENTRIES;
        if (rack.timer)
            clearTimeout(rack.timer);
        rack.timer = setTimeout(() => {
            rack.timer = null;
            this.snapshotAsync(dbName, rack);
        }, overdue ? 0 : this.persistDebounceMs);
        rack.timer.unref();
    }
    /**
     * Durably records a write *before* it is applied in memory, so a failed
     * disk write surfaces as a failed request instead of an acknowledged
     * write that is silently lost.
     */
    logWrite(dbName, rack, records) {
        if (this.persistDebounceMs === 0)
            return; // snapshot-per-write mode
        if (this.disk)
            return; // the document store itself records the write (same atomic batch)
        if (rack.walFd === null) {
            const dbDir = this.getDatabasePath(dbName);
            if (!fs.existsSync(dbDir))
                fs.mkdirSync(dbDir, { recursive: true });
            rack.walFd = fs.openSync(path.join(dbDir, store.walFileName(rack.name, rack.walGen)), 'a');
        }
        fs.writeSync(rack.walFd, store.encodeWal(records, this.cipher));
        if (this.walFsync) {
            // Made durable by syncWal() (group commit) before the request is acknowledged.
            this.dirtyWalFds.add(rack.walFd);
            this.writeSeq++;
        }
        rack.walEntries += records.length;
        this.stats.walWrites++;
    }
    /** Call after an in-memory mutation has been applied. */
    touched(dbName, rack) {
        rack.version = ++this.versionCounter;
        if (this.disk) {
            this.metaDirty.add(rack);
            this.disk.schedule();
            return;
        }
        if (!rack.dirty) {
            rack.dirty = true;
            rack.firstDirtyAt = Date.now();
        }
        this.scheduleSnapshot(dbName, rack);
    }
    /** Index/schema changes are rare and must not depend on WAL replay. */
    metaChanged(dbName, rack) {
        rack.version = ++this.versionCounter;
        this.snapshotSync(dbName, rack);
    }
    dropRackState(dbName, rack) {
        rack.dropped = true;
        if (this.disk) {
            this.metaDirty.delete(rack);
            rack.documents.clear();
            for (const idx of rack.indices.values())
                idx.store.drop();
            this.disk.deleteMeta(`${dbName}/${rack.name}`);
            return;
        }
        if (rack.timer) {
            clearTimeout(rack.timer);
            rack.timer = null;
        }
        this.closeWal(rack);
        try {
            for (const [, p] of store.listWalFiles(this.getDatabasePath(dbName), rack.name)) {
                try {
                    fs.unlinkSync(p);
                }
                catch { /* ignore */ }
            }
        }
        catch { /* ignore */ }
    }
    /** Synchronously snapshots every rack with pending writes. Safe to call any time (e.g. before a backup). */
    flushAll() {
        if (this.disk) {
            this.disk.flushSync();
            return;
        }
        for (const [dbName, db] of this.databases) {
            for (const rack of db.racks.values()) {
                if (rack.dirty || rack.inFlight || rack.walEntries > 0)
                    this.snapshotSync(dbName, rack);
            }
        }
    }
    /** Flushes everything and releases file handles. Call on graceful shutdown. */
    close() {
        clearInterval(this.nativeFlushTimer);
        this.flushAll();
        for (const db of this.databases.values()) {
            for (const rack of db.racks.values()) {
                if (rack.timer) {
                    clearTimeout(rack.timer);
                    rack.timer = null;
                }
                this.closeWal(rack);
            }
        }
        // Every transaction is folded into the snapshots now; the journal is no longer needed.
        if (this.journalFd !== null) {
            try {
                fs.closeSync(this.journalFd);
            }
            catch { /* ignore */ }
            this.journalFd = null;
        }
        fs.rmSync(this.journalPath(), { force: true });
        this.nativeSearch.flush();
        if (this.pool) {
            void this.pool.close();
            this.pool = null;
        }
        this.disk?.close();
    }
    /**
     * Detaches all in-memory state from disk so external code (backup
     * restore) can replace files safely; follow with reloadFromDisk().
     */
    suspendForRestore() {
        this.flushAll();
        for (const db of this.databases.values()) {
            for (const rack of db.racks.values()) {
                rack.dropped = true;
                if (rack.timer) {
                    clearTimeout(rack.timer);
                    rack.timer = null;
                }
                this.closeWal(rack);
            }
        }
        this.databases.clear();
        this.queryCache.clear();
    }
    /**
     * Throws unless `content` is a rack file this server can read (right
     * encryption key, intact). Used to vet backups before restoring them.
     */
    verifySnapshot(content) {
        const opened = store.openSnapshot(content, this.cipher);
        store.decodeSnapshot(opened.body);
    }
    reloadFromDisk() {
        this.databases.clear();
        this.queryCache.clear();
        this.loadAll();
    }
    // ───────────────────────────────────────────────────────────────────
    // Index maintenance
    // ───────────────────────────────────────────────────────────────────
    indexKeys(v) {
        if (v === null || v === undefined)
            return [];
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean')
            return [v];
        if (Array.isArray(v)) {
            const out = new Set();
            for (const e of v) {
                const te = typeof e;
                if (te === 'string' || te === 'number' || te === 'boolean')
                    out.add(e);
            }
            return Array.from(out);
        }
        return [];
    }
    /**
     * Keys a document contributes to an index. Compound indexes use one key
     * per document: the JSON tuple of its field values (all must be scalars).
     */
    keysFor(idx, data) {
        if (!idx.fields)
            return this.indexKeys((0, matcher_1.getPath)(data, idx.field));
        const vals = [];
        for (const f of idx.fields) {
            const v = (0, matcher_1.getPath)(data, f);
            const t = typeof v;
            if (t !== 'string' && t !== 'number' && t !== 'boolean')
                return [];
            vals.push(v);
        }
        return [JSON.stringify(vals)];
    }
    addToIndexes(rack, id, data) {
        for (const idx of rack.indices.values()) {
            for (const k of this.keysFor(idx, data))
                idx.store.add(k, id);
        }
    }
    removeFromIndexes(rack, id, data) {
        for (const idx of rack.indices.values()) {
            for (const k of this.keysFor(idx, data))
                idx.store.remove(k, id);
        }
    }
    /**
     * Builds an index over the rack's current documents. On the disk engine
     * this replaces any stored index of the same name and is written in
     * chunks, so it works on racks far larger than RAM.
     */
    buildIndex(rack, field, unique, strict, fields) {
        const compound = fields && fields.length > 1 ? fields : undefined;
        const name = compound ? compound.join('+') : field;
        const idx = { field: name, fields: compound, unique, store: this.newIndexStore(rack, name) };
        idx.store.beginBuild();
        try {
            for (const [id, doc] of rack.documents) {
                for (const k of this.keysFor(idx, doc.data)) {
                    if (unique && strict && idx.store.get(k).size > 0) {
                        throw new Error(`Cannot create unique index on '${idx.field}': duplicate value ${typeof k === 'string' && compound ? k : JSON.stringify(k)}`);
                    }
                    idx.store.add(k, id);
                }
            }
        }
        catch (err) {
            idx.store.abortBuild();
            throw err;
        }
        idx.store.endBuild();
        return idx;
    }
    /** Releases an index's storage after it has been removed from a rack. */
    dropIndex(idx) {
        idx?.store.drop();
    }
    /**
     * Throws if `data` would violate a unique index. `batch` tracks keys
     * claimed earlier in the same insertMany so in-batch duplicates are
     * caught before anything is written.
     */
    checkUnique(rack, id, data, batch) {
        for (const idx of rack.indices.values()) {
            if (!idx.unique)
                continue;
            for (const k of this.keysFor(idx, data)) {
                const existing = idx.store.get(k);
                if (existing.size > 1 || (existing.size === 1 && !existing.has(id))) {
                    throw new Error(`Duplicate value for unique ${idx.fields ? 'fields' : 'field'} '${idx.field}': ${idx.fields ? k : JSON.stringify(k)}`);
                }
                if (batch) {
                    let claimed = batch.get(idx.field);
                    if (!claimed)
                        batch.set(idx.field, (claimed = new Set()));
                    if (claimed.has(k)) {
                        throw new Error(`Duplicate value for unique field '${idx.field}' within batch: ${JSON.stringify(k)}`);
                    }
                    claimed.add(k);
                }
            }
        }
    }
    // ───────────────────────────────────────────────────────────────────
    // Databases & racks
    // ───────────────────────────────────────────────────────────────────
    requireRack(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            throw new Error(`Rack '${rack}' not found in database '${database}'`);
        return rackObj;
    }
    getRackObj(database, rack) {
        return this.databases.get(database)?.racks.get(rack);
    }
    createDatabase(name) {
        if (!(0, security_middleware_1.validateIdentifier)(name))
            throw new Error(`Invalid database name '${name}'`);
        if (this.databases.has(name))
            return false;
        this.databases.set(name, { name, racks: new Map() });
        const dbPath = this.getDatabasePath(name);
        if (!fs.existsSync(dbPath)) {
            fs.mkdirSync(dbPath, { recursive: true });
        }
        // Disk engine: databases are recorded in the store too (so they replicate).
        this.disk?.putMeta(DB_META_PREFIX + name, { createdAt: new Date().toISOString() });
        return true;
    }
    createRack(database, rack, type = 'nosql', schema) {
        if (!(0, security_middleware_1.validateIdentifier)(rack))
            throw new Error(`Invalid rack name '${rack}'`);
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        if (db.racks.has(rack))
            return false;
        if (type !== 'sql' && type !== 'nosql')
            throw new Error('Type must be "sql" or "nosql"');
        // SQL racks are tables: a typed column list is mandatory and enforced
        // strictly. NoSQL racks hold free-form JSON (a schema is optional).
        let clean;
        if (type === 'sql') {
            if (!schema || !(0, security_middleware_1.isPlainObject)(schema) || Object.keys(schema).length === 0) {
                throw new Error('SQL racks need at least one column, e.g. { "name": { "type": "string", "required": true } }');
            }
            clean = this.normalizeSchema(schema);
        }
        else if (schema !== undefined && schema !== null && !((0, security_middleware_1.isPlainObject)(schema) && Object.keys(schema).length === 0)) {
            clean = this.normalizeSchema(schema);
        }
        const rackObj = this.newRack(database, rack, type, clean);
        for (const [col, def] of Object.entries(clean ?? {})) {
            if (def.unique)
                rackObj.indices.set(col, this.buildIndex(rackObj, col, true, true));
        }
        db.racks.set(rack, rackObj);
        this.snapshotSync(database, rackObj);
        return true;
    }
    /** Validates a schema definition and returns a copy with only known properties. */
    normalizeSchema(schema) {
        if (!(0, security_middleware_1.isPlainObject)(schema))
            throw new Error('Schema must be an object of { column: { type, required?, unique?, defaultValue? } }');
        const entries = Object.entries(schema);
        if (entries.length > 256)
            throw new Error('A rack can have at most 256 columns');
        const out = {};
        for (const [field, def] of entries)
            out[field] = this.normalizeColumn(field, def);
        return out;
    }
    normalizeColumn(field, def) {
        if (!COLUMN_RE.test(field) || RESERVED_COLUMNS.has(field)) {
            throw new Error(`Invalid column name '${field}' (letters, numbers and _, must not start with a digit; 'id' is reserved)`);
        }
        if (!(0, security_middleware_1.isPlainObject)(def) || !exports.FIELD_TYPES.includes(def.type)) {
            throw new Error(`Column '${field}' needs a type of: ${exports.FIELD_TYPES.join(', ')}`);
        }
        const col = { type: def.type };
        if (def.required)
            col.required = true;
        if (def.unique)
            col.unique = true;
        if (def.defaultValue !== undefined && def.defaultValue !== null && def.defaultValue !== '') {
            const err = OpenDBSEngine.typeError(def.defaultValue, def.type);
            if (err)
                throw new Error(`Default for '${field}': ${err}`);
            if (col.unique)
                throw new Error(`Column '${field}' can't be unique and have a default value`);
            col.defaultValue = (0, security_middleware_1.sanitizeDocument)(def.defaultValue);
        }
        return col;
    }
    /** null when `value` matches `type`, otherwise a human-readable reason. */
    static typeError(value, type) {
        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        switch (type) {
            case 'integer':
                return Number.isInteger(value) ? null : `must be an integer, got ${actual === 'number' ? value : actual}`;
            case 'number':
                return typeof value === 'number' && Number.isFinite(value) ? null : `must be a number, got ${actual}`;
            case 'date':
                // ISO strings or epoch millis
                return (typeof value === 'string' && !isNaN(Date.parse(value))) || (typeof value === 'number' && Number.isFinite(value))
                    ? null : 'must be an ISO date string or epoch milliseconds';
            case 'object':
                return actual === 'object' ? null : `must be a JSON object, got ${actual}`;
            default:
                return actual === type ? null : `must be ${type}, got ${actual}`;
        }
    }
    getRackSchema(database, rack) {
        const r = this.requireRack(database, rack);
        return { type: r.type, schema: r.schema ? structuredClone(r.schema) : null };
    }
    /**
     * ALTER TABLE ADD COLUMN. Existing rows get the default value (if any);
     * a required column without a default can only be added to an empty rack.
     */
    addColumn(database, rack, column, def) {
        const rackObj = this.requireRack(database, rack);
        if (rackObj.type !== 'sql')
            throw new Error('Columns can only be managed on SQL racks');
        if (rackObj.schema && hasOwn.call(rackObj.schema, column))
            throw new Error(`Column '${column}' already exists`);
        const col = this.normalizeColumn(column, def);
        if (Object.keys(rackObj.schema ?? {}).length >= 256)
            throw new Error('A rack can have at most 256 columns');
        if (col.required && col.defaultValue === undefined && rackObj.documents.size > 0) {
            throw new Error(`Column '${column}' is required but has no default, and the rack already has rows`);
        }
        let uniqueIdx = null;
        if (col.unique)
            uniqueIdx = this.buildIndex(rackObj, column, true, true); // throws on existing duplicates
        if (col.defaultValue !== undefined) {
            this.rewriteAll(database, rackObj, (data) => {
                if (data[column] !== undefined && data[column] !== null)
                    return null;
                return { ...data, [column]: structuredClone(col.defaultValue) };
            });
        }
        rackObj.schema = { ...(rackObj.schema ?? {}), [column]: col };
        if (uniqueIdx) {
            // Rebuilt over the rewritten rows (defaults filled in).
            this.dropIndex(uniqueIdx);
            this.dropIndex(rackObj.indices.get(column));
            rackObj.indices.set(column, this.buildIndex(rackObj, column, true, true));
        }
        this.metaChanged(database, rackObj);
        return true;
    }
    /** Converts an existing value to a new column type, or throws if it can't be represented. */
    static convertValue(v, to) {
        if (v === null || v === undefined)
            return v;
        if (OpenDBSEngine.typeError(v, to) === null)
            return v;
        switch (to) {
            case 'string':
                return typeof v === 'object' ? JSON.stringify(v) : String(v);
            case 'integer': {
                const n = typeof v === 'boolean' ? Number(v) : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
                if (Number.isInteger(n))
                    return n;
                if (typeof v === 'number' && Number.isFinite(v))
                    return Math.round(v);
                break;
            }
            case 'number': {
                const n = typeof v === 'boolean' ? Number(v) : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
                if (Number.isFinite(n))
                    return n;
                break;
            }
            case 'boolean':
                if (v === 1 || v === 0)
                    return v === 1;
                if (typeof v === 'string' && /^(true|false|1|0|yes|no)$/i.test(v))
                    return /^(true|1|yes)$/i.test(v);
                break;
            case 'date':
                if (typeof v === 'string' && !isNaN(Date.parse(v)))
                    return v;
                break;
            case 'array':
            case 'object':
                if (typeof v === 'string') {
                    try {
                        const parsed = JSON.parse(v);
                        if (OpenDBSEngine.typeError(parsed, to) === null)
                            return (0, security_middleware_1.sanitizeDocument)(parsed);
                    }
                    catch { /* fall through */ }
                }
                break;
        }
        throw new Error(`value ${JSON.stringify(v).slice(0, 40)} can't be converted to ${to}`);
    }
    /**
     * ALTER TABLE MODIFY / RENAME COLUMN. `changes.name` renames; type changes
     * convert existing values (the whole change is refused if any row can't
     * be converted); required/unique/defaultValue are validated against the
     * existing data before anything is written.
     */
    alterColumn(database, rack, column, changes) {
        const rackObj = this.requireRack(database, rack);
        if (rackObj.type !== 'sql')
            throw new Error('Columns can only be managed on SQL racks');
        if (!rackObj.schema || !hasOwn.call(rackObj.schema, column))
            throw new Error(`Column '${column}' not found`);
        if (!(0, security_middleware_1.isPlainObject)(changes))
            throw new Error('changes must be an object');
        const current = rackObj.schema[column];
        const newName = changes.name !== undefined && changes.name !== column ? changes.name : column;
        if (newName !== column && hasOwn.call(rackObj.schema, newName))
            throw new Error(`Column '${newName}' already exists`);
        // Merge and validate the resulting definition (normalizeColumn checks name, type and default).
        const merged = {
            type: changes.type ?? current.type,
            required: changes.required ?? current.required,
            unique: changes.unique ?? current.unique,
            defaultValue: hasOwn.call(changes, 'defaultValue') ? changes.defaultValue : current.defaultValue,
        };
        const col = this.normalizeColumn(newName, merged);
        // Compute every row's new value up front: nothing is written unless all rows convert.
        const typeChanged = col.type !== current.type;
        const updates = [];
        for (const doc of rackObj.documents.values()) {
            const data = (0, security_middleware_1.isPlainObject)(doc.data) ? doc.data : {};
            const had = hasOwn.call(data, column);
            let value = data[column];
            if (typeChanged && had) {
                try {
                    value = OpenDBSEngine.convertValue(value, col.type);
                }
                catch (e) {
                    throw new Error(`Row ${doc.id}: ${e.message}`);
                }
            }
            if ((value === undefined || value === null) && col.required) {
                if (col.defaultValue === undefined) {
                    throw new Error(`Row ${doc.id} has no value for '${column}'; add a default to make it required`);
                }
                value = structuredClone(col.defaultValue);
            }
            const renamed = newName !== column;
            const changed = renamed || value !== data[column] || (!had && value !== undefined);
            if (!changed)
                continue;
            const next = { ...data };
            delete next[column];
            if (value !== undefined)
                next[newName] = value;
            updates.push({ doc, data: next });
        }
        // Unique check over the post-change values.
        if (col.unique) {
            const seen = new Map();
            const byId = new Map(updates.map((u) => [u.doc.id, u.data]));
            for (const doc of rackObj.documents.values()) {
                const data = byId.get(doc.id) ?? doc.data;
                for (const k of this.indexKeys((0, matcher_1.getPath)(data, newName))) {
                    if (seen.has(k))
                        throw new Error(`Cannot make '${newName}' unique: rows ${seen.get(k)} and ${doc.id} share ${JSON.stringify(k)}`);
                    seen.set(k, doc.id);
                }
            }
        }
        // Commit.
        if (updates.length > 0) {
            const now = new Date().toISOString();
            const docs = updates.map(({ doc, data }) => ({ id: doc.id, data, createdAt: doc.createdAt, updatedAt: now }));
            this.logWrite(database, rackObj, docs.map((d) => ({ o: 'p', d })));
            for (const next of docs) {
                const prev = rackObj.documents.get(next.id);
                this.removeFromIndexes(rackObj, next.id, prev.data);
                rackObj.documents.set(next.id, next);
                this.addToIndexes(rackObj, next.id, next.data);
            }
            this.touched(database, rackObj);
        }
        const schema = {};
        for (const [name, def] of Object.entries(rackObj.schema)) {
            if (name === column)
                schema[newName] = col; // keep column order
            else
                schema[name] = def;
        }
        rackObj.schema = schema;
        const oldIdx = rackObj.indices.get(column);
        rackObj.indices.delete(column);
        this.dropIndex(oldIdx);
        if (col.unique)
            rackObj.indices.set(newName, this.buildIndex(rackObj, newName, true, false));
        else if (oldIdx && !current.unique)
            rackObj.indices.set(newName, this.buildIndex(rackObj, newName, false, false));
        for (const set of [rackObj.textIndexedFields, rackObj.vectorIndexedFields]) {
            if (newName !== column && set.delete(column))
                set.add(newName);
        }
        this.metaChanged(database, rackObj);
        return true;
    }
    /** ALTER TABLE DROP COLUMN: removes the column, its data and any index on it. */
    dropColumn(database, rack, column) {
        const rackObj = this.requireRack(database, rack);
        if (rackObj.type !== 'sql')
            throw new Error('Columns can only be managed on SQL racks');
        if (!rackObj.schema || !hasOwn.call(rackObj.schema, column))
            return false;
        if (Object.keys(rackObj.schema).length <= 1)
            throw new Error('A SQL rack must keep at least one column');
        this.rewriteAll(database, rackObj, (data) => {
            if (!hasOwn.call(data, column))
                return null;
            const next = { ...data };
            delete next[column];
            return next;
        });
        const schema = { ...rackObj.schema };
        delete schema[column];
        rackObj.schema = schema;
        this.dropIndex(rackObj.indices.get(column));
        rackObj.indices.delete(column);
        if (rackObj.textIndexedFields.delete(column) || rackObj.vectorIndexedFields.delete(column)) {
            for (const id of rackObj.documents.keys())
                this.removeFromNativeIndexes(database, rack, rackObj, id);
        }
        this.metaChanged(database, rackObj);
        return true;
    }
    /** Applies `fn` to every document's data (null = unchanged) as one WAL batch. */
    rewriteAll(database, rackObj, fn) {
        const now = new Date().toISOString();
        const changed = [];
        for (const doc of rackObj.documents.values()) {
            const next = fn((0, security_middleware_1.isPlainObject)(doc.data) ? doc.data : {});
            if (next)
                changed.push({ id: doc.id, data: next, createdAt: doc.createdAt, updatedAt: now });
        }
        if (changed.length === 0)
            return;
        this.logWrite(database, rackObj, changed.map((d) => ({ o: 'p', d })));
        for (const next of changed) {
            const prev = rackObj.documents.get(next.id);
            this.removeFromIndexes(rackObj, next.id, prev.data);
            rackObj.documents.set(next.id, next);
            this.addToIndexes(rackObj, next.id, next.data);
        }
        this.touched(database, rackObj);
    }
    getRackType(database, rack) {
        return this.getRackObj(database, rack)?.type ?? null;
    }
    /** Changes whenever the rack is written to; -1 if it doesn't exist. Lets callers cache derived views. */
    getRackVersion(database, rack) {
        return this.getRackObj(database, rack)?.version ?? -1;
    }
    /**
     * Applies defaults and checks types. `strict` (SQL racks) additionally
     * rejects fields that aren't declared columns.
     */
    validateSchema(data, schema, strict) {
        if (!schema)
            return { valid: true, errors: [] };
        const errors = [];
        if (strict) {
            for (const key of Object.keys(data)) {
                if (key === 'id') {
                    delete data[key];
                    continue;
                } // ids are assigned by the engine
                if (!hasOwn.call(schema, key))
                    errors.push(`Unknown column '${key}'`);
            }
        }
        for (const [field, fieldSchema] of Object.entries(schema)) {
            let value = data[field];
            if (value === undefined || value === null) {
                if (fieldSchema.defaultValue !== undefined) {
                    data[field] = value = structuredClone(fieldSchema.defaultValue);
                }
                else if (fieldSchema.required) {
                    errors.push(`Column '${field}' is required`);
                    continue;
                }
            }
            if (value !== undefined && value !== null) {
                const err = OpenDBSEngine.typeError(value, fieldSchema.type);
                if (err)
                    errors.push(`Column '${field}' ${err}`);
            }
        }
        return { valid: errors.length === 0, errors };
    }
    duplicateRack(sourceDb, sourceRack, targetDb, targetRack) {
        if (!(0, security_middleware_1.validateIdentifier)(targetRack))
            throw new Error(`Invalid rack name '${targetRack}'`);
        const sDb = this.databases.get(sourceDb);
        if (!sDb)
            throw new Error(`Source Database '${sourceDb}' not found`);
        const sRack = sDb.racks.get(sourceRack);
        if (!sRack)
            throw new Error(`Source Rack '${sourceRack}' not found`);
        const tDb = this.databases.get(targetDb);
        if (!tDb)
            throw new Error(`Target Database '${targetDb}' not found`);
        if (tDb.racks.has(targetRack))
            return false;
        const target = this.newRack(targetDb, targetRack, sRack.type, sRack.schema ? structuredClone(sRack.schema) : undefined);
        if (this.disk) {
            this.bulkLoad(target, sRack.documents.values());
        }
        else {
            for (const [id, doc] of sRack.documents)
                target.documents.add(id, structuredClone(doc));
        }
        target.nextId = sRack.nextId;
        target.textIndexedFields = new Set(sRack.textIndexedFields);
        target.vectorIndexedFields = new Set(sRack.vectorIndexedFields);
        for (const idx of sRack.indices.values()) {
            target.indices.set(idx.field, this.buildIndex(target, idx.fields ? idx.fields[0] : idx.field, idx.unique, false, idx.fields));
        }
        tDb.racks.set(targetRack, target);
        // Backfill the native search index for the new rack's copy of the data.
        for (const field of sRack.textIndexedFields) {
            for (const [id, doc] of target.documents) {
                const val = (0, matcher_1.getPath)(doc.data, field);
                if (typeof val === 'string' && val.length > 0) {
                    this.nativeSearch.indexText(targetDb, targetRack, field, id, val);
                }
            }
        }
        for (const field of sRack.vectorIndexedFields) {
            const items = [];
            for (const [id, doc] of target.documents) {
                const val = (0, matcher_1.getPath)(doc.data, field);
                if (Array.isArray(val) && val.every((v) => typeof v === 'number')) {
                    items.push({ docId: id, vector: val });
                }
            }
            this.nativeSearch.addVectorsBatch(targetDb, targetRack, field, items);
        }
        if (sRack.textIndexedFields.size > 0 || sRack.vectorIndexedFields.size > 0) {
            this.nativeSearch.flush();
        }
        this.snapshotSync(targetDb, target);
        return true;
    }
    /**
     * `field` may be one field or several (compound index, e.g. ['city', 'age']).
     * A compound index answers queries with equality on all of its fields and
     * can enforce uniqueness of the combination.
     */
    createIndex(database, rack, field, options = {}) {
        const fields = Array.isArray(field) ? field : [field];
        if (fields.length === 0 || fields.length > 8)
            throw new Error('An index covers 1 to 8 fields');
        for (const f of fields)
            if (!(0, security_middleware_1.validateFieldName)(f))
                throw new Error(`Invalid field name '${f}'`);
        if (new Set(fields).size !== fields.length)
            throw new Error('Duplicate field in index');
        const rackObj = this.requireRack(database, rack);
        const unique = Boolean(options.unique);
        const name = fields.join('+');
        const existing = rackObj.indices.get(name);
        if (existing && existing.unique === unique)
            return true;
        // strict: a unique index over existing duplicates is refused (the existing index stays).
        const idx = this.buildIndex(rackObj, fields[0], unique, true, fields.length > 1 ? fields : undefined);
        rackObj.indices.set(idx.field, idx);
        this.dropIndex(existing);
        this.metaChanged(database, rackObj);
        return true;
    }
    getIndexes(database, rack) {
        return Array.from(this.requireRack(database, rack).indices.keys());
    }
    getIndexDetails(database, rack) {
        const r = this.requireRack(database, rack);
        const out = [];
        for (const idx of r.indices.values()) {
            out.push({ field: idx.field, type: idx.unique ? 'unique' : 'hash', ...idx.store.info(), ...(idx.fields ? { fields: idx.fields } : {}) });
        }
        for (const f of r.textIndexedFields)
            out.push({ field: f, type: 'text' });
        for (const f of r.vectorIndexedFields)
            out.push({ field: f, type: 'vector' });
        return out;
    }
    deleteIndex(database, rack, field) {
        const rackObj = this.requireRack(database, rack);
        const idx = rackObj.indices.get(field);
        if (!idx)
            return false;
        rackObj.indices.delete(field);
        this.dropIndex(idx);
        this.metaChanged(database, rackObj);
        return true;
    }
    /** Applies the current value of every text/vector-indexed field on a
     * document to the native search index (add/update), and removes the
     * field's entry when it's absent or the wrong type. Used uniformly by
     * insert/update/patch so the native index always reflects the
     * document's current data regardless of which write path touched it. */
    syncNativeIndexes(database, rack, rackObj, id, data) {
        for (const field of rackObj.textIndexedFields) {
            const val = (0, matcher_1.getPath)(data, field);
            if (typeof val === 'string' && val.length > 0) {
                this.nativeSearch.indexText(database, rack, field, id, val);
            }
            else {
                this.nativeSearch.removeText(database, rack, field, id);
            }
        }
        for (const field of rackObj.vectorIndexedFields) {
            const val = (0, matcher_1.getPath)(data, field);
            if (Array.isArray(val) && val.length > 0 && val.every((v) => typeof v === 'number')) {
                this.nativeSearch.addVector(database, rack, field, id, val);
            }
            else {
                this.nativeSearch.removeVector(database, rack, field, id);
            }
        }
    }
    removeFromNativeIndexes(database, rack, rackObj, id) {
        for (const field of rackObj.textIndexedFields) {
            this.nativeSearch.removeText(database, rack, field, id);
        }
        for (const field of rackObj.vectorIndexedFields) {
            this.nativeSearch.removeVector(database, rack, field, id);
        }
    }
    /** Marks a field as full-text/fuzzy indexed and backfills any existing
     * documents into the native trigram index. Mirrors createIndex()'s
     * opt-in-per-field pattern for exact-match indices. */
    createTextIndex(database, rack, field) {
        if (!(0, security_middleware_1.validateFieldName)(field))
            throw new Error(`Invalid field name '${field}'`);
        const rackObj = this.requireRack(database, rack);
        if (rackObj.textIndexedFields.has(field))
            return true;
        for (const [id, doc] of rackObj.documents) {
            const val = (0, matcher_1.getPath)(doc.data, field);
            if (typeof val === 'string' && val.length > 0) {
                this.nativeSearch.indexText(database, rack, field, id, val);
            }
        }
        rackObj.textIndexedFields.add(field);
        this.nativeSearch.flush();
        this.metaChanged(database, rackObj);
        return true;
    }
    getTextIndexes(database, rack) {
        return Array.from(this.requireRack(database, rack).textIndexedFields);
    }
    deleteTextIndex(database, rack, field) {
        const rackObj = this.requireRack(database, rack);
        if (!rackObj.textIndexedFields.has(field))
            return false;
        for (const id of rackObj.documents.keys())
            this.nativeSearch.removeText(database, rack, field, id);
        rackObj.textIndexedFields.delete(field);
        this.metaChanged(database, rackObj);
        return true;
    }
    /** Marks a field as vector-indexed and backfills any existing documents
     * (via the batched native insert path, since this can be a large
     * one-time operation on an already-populated rack). */
    createVectorIndex(database, rack, field) {
        if (!(0, security_middleware_1.validateFieldName)(field))
            throw new Error(`Invalid field name '${field}'`);
        const rackObj = this.requireRack(database, rack);
        if (rackObj.vectorIndexedFields.has(field))
            return true;
        const items = [];
        for (const [id, doc] of rackObj.documents) {
            const val = (0, matcher_1.getPath)(doc.data, field);
            if (Array.isArray(val) && val.length > 0 && val.every((v) => typeof v === 'number')) {
                items.push({ docId: id, vector: val });
            }
        }
        this.nativeSearch.addVectorsBatch(database, rack, field, items);
        rackObj.vectorIndexedFields.add(field);
        this.nativeSearch.flush();
        this.metaChanged(database, rackObj);
        return true;
    }
    getVectorIndexes(database, rack) {
        return Array.from(this.requireRack(database, rack).vectorIndexedFields);
    }
    deleteVectorIndex(database, rack, field) {
        const rackObj = this.requireRack(database, rack);
        if (!rackObj.vectorIndexedFields.has(field))
            return false;
        for (const id of rackObj.documents.keys())
            this.nativeSearch.removeVector(database, rack, field, id);
        rackObj.vectorIndexedFields.delete(field);
        this.metaChanged(database, rackObj);
        return true;
    }
    getVectorIndexStats(database, rack, field) {
        return this.nativeSearch.vectorStats(database, rack, field);
    }
    rebuildVectorIndex(database, rack, field) {
        this.nativeSearch.rebuildVectorIndex(database, rack, field);
    }
    // ───────────────────────────────────────────────────────────────────
    // Writes
    // ───────────────────────────────────────────────────────────────────
    parseDocumentInput(data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (!(0, security_middleware_1.isPlainObject)(parsed))
            throw new Error('Document must be a JSON object');
        // Shallow copy: validation fills defaults and must not mutate the caller's object.
        return { ...(0, security_middleware_1.sanitizeDocument)(parsed) };
    }
    assertValid(rackObj, data, label = '') {
        if (!rackObj.schema)
            return;
        const validation = this.validateSchema(data, rackObj.schema, rackObj.type === 'sql');
        if (!validation.valid) {
            throw new Error(`Schema validation failed${label}: ${validation.errors.join(', ')}`);
        }
    }
    /**
     * `operationType` is accepted for API compatibility. SQL racks take writes
     * from any interface (REST, SQL, admin panel); what makes them SQL is that
     * every write is checked strictly against the declared columns.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    insert(database, rack, data, operationType) {
        const rackObj = this.requireRack(database, rack);
        const parsedData = this.parseDocumentInput(data);
        this.assertValid(rackObj, parsedData);
        const id = String(rackObj.nextId);
        this.checkUnique(rackObj, id, parsedData);
        const now = new Date().toISOString();
        const document = { id, data: parsedData, createdAt: now, updatedAt: now };
        this.logWrite(database, rackObj, [{ o: 'p', d: document }]);
        rackObj.nextId++;
        rackObj.documents.add(id, document);
        this.addToIndexes(rackObj, id, parsedData);
        this.syncNativeIndexes(database, rack, rackObj, id, parsedData);
        this.touched(database, rackObj);
        return id;
    }
    insertMany(database, rack, dataItems) {
        const rackObj = this.requireRack(database, rack);
        if (!Array.isArray(dataItems))
            throw new Error('insertMany expects an array');
        // Validate the whole batch before writing anything: a bad item in the
        // middle no longer leaves a half-inserted batch behind.
        const now = new Date().toISOString();
        const docs = [];
        const claimed = new Map();
        let nextId = rackObj.nextId;
        dataItems.forEach((raw, i) => {
            const item = this.parseDocumentInput(raw);
            this.assertValid(rackObj, item, ` on item ${i}`);
            const id = String(nextId++);
            this.checkUnique(rackObj, id, item, claimed);
            docs.push({ id, data: item, createdAt: now, updatedAt: now });
        });
        if (docs.length === 0)
            return [];
        this.logWrite(database, rackObj, docs.map((d) => ({ o: 'p', d })));
        rackObj.nextId = nextId;
        // Vector fields are batched into one native call per field after the
        // loop (parallel_insert on the Rust side) instead of one NAPI call
        // per document -- roughly two orders of magnitude faster for bulk
        // loads, which is what insertMany is for.
        const vectorBatches = new Map();
        for (const doc of docs) {
            rackObj.documents.add(doc.id, doc);
            this.addToIndexes(rackObj, doc.id, doc.data);
            for (const field of rackObj.textIndexedFields) {
                const val = (0, matcher_1.getPath)(doc.data, field);
                if (typeof val === 'string' && val.length > 0) {
                    this.nativeSearch.indexText(database, rack, field, doc.id, val);
                }
            }
            for (const field of rackObj.vectorIndexedFields) {
                const val = (0, matcher_1.getPath)(doc.data, field);
                if (Array.isArray(val) && val.length > 0 && val.every((v) => typeof v === 'number')) {
                    if (!vectorBatches.has(field))
                        vectorBatches.set(field, []);
                    vectorBatches.get(field).push({ docId: doc.id, vector: val });
                }
            }
        }
        for (const [field, items] of vectorBatches) {
            this.nativeSearch.addVectorsBatch(database, rack, field, items);
        }
        if (rackObj.textIndexedFields.size > 0 || vectorBatches.size > 0) {
            this.nativeSearch.flush();
        }
        this.touched(database, rackObj);
        return docs.map((d) => d.id);
    }
    /**
     * Sharding: stores documents under ids chosen by the shard router (which
     * keeps them unique across all shards). `replace` overwrites existing
     * documents (used when moving data between shards).
     */
    insertWithIds(database, rack, docs, replace = false) {
        const rackObj = this.requireRack(database, rack);
        if (!Array.isArray(docs))
            throw new Error('docs must be an array');
        const now = new Date().toISOString();
        const prepared = [];
        const claimed = new Map();
        const seen = new Set();
        for (const [i, raw] of docs.entries()) {
            const id = String(raw?.id ?? '');
            if (!/^(0|[1-9]\d{0,15})$/.test(id))
                throw new Error(`Item ${i}: id must be a whole number`);
            if (seen.has(id))
                throw new Error(`Item ${i}: duplicate id ${id}`);
            seen.add(id);
            const data = this.parseDocumentInput(raw.data ?? {});
            this.assertValid(rackObj, data, ` on item ${i}`);
            const prev = rackObj.documents.get(id);
            if (prev && !replace)
                throw new Error(`Item ${i}: a document with id ${id} already exists`);
            this.checkUnique(rackObj, id, data, claimed);
            const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : prev?.createdAt ?? now;
            const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : now;
            prepared.push({ doc: { id, data, createdAt, updatedAt }, prev });
        }
        if (prepared.length === 0)
            return [];
        this.logWrite(database, rackObj, prepared.map((p) => ({ o: 'p', d: p.doc })));
        for (const { doc, prev } of prepared) {
            if (prev)
                this.removeFromIndexes(rackObj, doc.id, prev.data);
            rackObj.documents.set(doc.id, doc);
            this.addToIndexes(rackObj, doc.id, doc.data);
            this.syncNativeIndexes(database, rack, rackObj, doc.id, doc.data);
            // Generated ids must never land on an id stored here (insert() would overwrite it).
            const n = Number(doc.id);
            if (n >= rackObj.nextId)
                rackObj.nextId = n + 1;
        }
        this.touched(database, rackObj);
        return prepared.map((p) => p.doc.id);
    }
    /** Deletes many documents by id; returns how many existed. */
    deleteMany(database, rack, ids) {
        let n = 0;
        for (const id of ids)
            if (this.delete(database, rack, String(id)))
                n++;
        return n;
    }
    /**
     * Sharding (rebalance): documents whose numeric id falls in one of the
     * given buckets (id mod `buckets`), after `after`, at most `limit`.
     */
    documentsInBuckets(database, rack, bucketSet, bucketCount, after, limit) {
        const rackObj = this.requireRack(database, rack);
        const docs = [];
        let last = null;
        const source = rackObj.documents instanceof disk_store_1.DiskDocMap
            ? rackObj.documents.committedAfter(after)
            : (function* (m) {
                const all = Array.from(m.keys()).sort((a, b) => Number(a) - Number(b));
                for (const id of all)
                    if (after === null || Number(id) > Number(after))
                        yield [id, m.get(id)];
            })(rackObj.documents);
        let scanned = 0;
        for (const [id, doc] of source) {
            last = id;
            scanned++;
            const n = Number(id);
            if (Number.isSafeInteger(n) && bucketSet.has(n % bucketCount))
                docs.push(doc);
            if (docs.length >= limit || scanned >= limit * 20)
                return { docs, last, done: false };
        }
        return { docs, last, done: true };
    }
    /**
     * Partial (unfinished) GROUP BY states for a rack — the shard side of a
     * distributed aggregation; the router merges states from every shard.
     */
    async aggregatePartial(database, rack, query, groups, aggs, sqlWhere) {
        const rackObj = this.requireRack(database, rack);
        const queryObj = (0, security_middleware_1.sanitizeObject)(query ?? {});
        if (!(0, security_middleware_1.isPlainObject)(queryObj))
            throw new Error('Query must be an object');
        const parallel = this.parallelRack(database, rack);
        if (parallel && this.plan(rackObj, queryObj) === null && this.exactPlan(rackObj, queryObj) === null) {
            const pool = this.queryPool();
            await this.disk.sync();
            const table = rackObj.documents.table;
            try {
                const parts = await pool.runAll(this.scanChunks(rackObj, pool.size * 4).map((c) => ({ kind: 'agg', table, lo: c.lo, hi: c.hi, query: queryObj, groups, aggs, sqlWhere })));
                return (0, agg_state_1.mergePartials)(parts.flatMap((p) => p.groups));
            }
            catch (err) {
                this.workerFailed(err);
            }
        }
        // Main thread: same accumulators as the workers.
        const match = (0, matcher_1.compileQuery)(queryObj);
        const pred = sqlWhere ? (0, executor_1.compileRowPredicate)(sqlWhere) : null;
        const readers = groups.map(agg_state_1.fieldReader);
        const defs = aggs.map((a) => {
            const read = a.field === null ? null : (0, agg_state_1.fieldReader)(a.field);
            return { name: a.name, star: a.field === null, distinct: false, args: read ? [(doc) => read(doc)] : [] };
        });
        const out = new Map();
        // Index candidates when the query has usable indexes, else one sequential pass (streamed, not loaded).
        const candidates = this.exactPlan(rackObj, queryObj) ?? this.plan(rackObj, queryObj);
        for (const [id, doc] of this.scanSource(rackObj, candidates)) {
            if (!match(doc.data ?? {}, id))
                continue;
            if (pred && !pred({ ...(doc.data ?? {}), id: (0, functions_1.canonicalNumber)(id) ?? id }))
                continue;
            const key = readers.map((f) => f(doc));
            const k = key.map(functions_1.valueKey).join('\u0001');
            let g = out.get(k);
            if (!g)
                out.set(k, (g = { key, states: defs.map(agg_state_1.newAggState) }));
            for (let i = 0; i < defs.length; i++)
                (0, agg_state_1.addAgg)(g.states[i], defs[i], doc, null);
        }
        return Array.from(out.values()).map((g) => ({ key: g.key, states: g.states.map(agg_state_1.serializeState) }));
    }
    clearRack(database, rack) {
        const rackObj = this.getRackObj(database, rack);
        if (!rackObj)
            return false;
        this.logWrite(database, rackObj, [{ o: 'c' }]);
        if (rackObj.textIndexedFields.size > 0 || rackObj.vectorIndexedFields.size > 0) {
            for (const id of rackObj.documents.keys()) {
                this.removeFromNativeIndexes(database, rack, rackObj, id);
            }
            this.nativeSearch.flush();
        }
        rackObj.documents.clear();
        for (const index of rackObj.indices.values())
            index.store.clear();
        this.touched(database, rackObj);
        return true;
    }
    deleteRack(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return false;
        if (rackObj.textIndexedFields.size > 0 || rackObj.vectorIndexedFields.size > 0) {
            for (const id of rackObj.documents.keys())
                this.removeFromNativeIndexes(database, rack, rackObj, id);
        }
        this.dropRackState(database, rackObj);
        db.racks.delete(rack);
        const filePath = this.getRackPath(database, rack);
        fs.rmSync(filePath, { force: true });
        fs.rmSync(`${filePath}.migrated`, { force: true }); // pre-disk-engine copy
        return true;
    }
    deleteDatabase(database) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        for (const rack of db.racks.values()) {
            if (rack.textIndexedFields.size > 0 || rack.vectorIndexedFields.size > 0) {
                for (const id of rack.documents.keys())
                    this.removeFromNativeIndexes(database, rack.name, rack, id);
            }
            this.dropRackState(database, rack);
        }
        this.disk?.deleteMeta(DB_META_PREFIX + database);
        this.databases.delete(database);
        const dbPath = this.getDatabasePath(database);
        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { recursive: true, force: true });
        }
        return true;
    }
    update(database, rack, id, data) {
        const rackObj = this.getRackObj(database, rack);
        if (!rackObj)
            return false;
        const doc = rackObj.documents.get(String(id));
        if (!doc)
            return false;
        const newData = this.parseDocumentInput(data);
        this.assertValid(rackObj, newData);
        this.checkUnique(rackObj, doc.id, newData);
        return this.replaceDocument(database, rack, rackObj, doc, newData);
    }
    patch(database, rack, id, partialData) {
        const rackObj = this.getRackObj(database, rack);
        if (!rackObj)
            return false;
        const doc = rackObj.documents.get(String(id));
        if (!doc)
            return false;
        const updates = this.parseDocumentInput(partialData);
        const oldData = (0, security_middleware_1.isPlainObject)(doc.data) ? doc.data : {};
        const mergedData = { ...oldData, ...updates };
        this.assertValid(rackObj, mergedData);
        this.checkUnique(rackObj, doc.id, mergedData);
        return this.replaceDocument(database, rack, rackObj, doc, mergedData);
    }
    replaceDocument(database, rack, rackObj, doc, newData) {
        const next = {
            id: doc.id,
            data: newData,
            createdAt: doc.createdAt,
            updatedAt: new Date().toISOString(),
        };
        this.logWrite(database, rackObj, [{ o: 'p', d: next }]);
        this.removeFromIndexes(rackObj, doc.id, doc.data);
        rackObj.documents.set(doc.id, next);
        this.addToIndexes(rackObj, doc.id, newData);
        this.syncNativeIndexes(database, rack, rackObj, doc.id, newData);
        this.touched(database, rackObj);
        return true;
    }
    delete(database, rack, id) {
        const rackObj = this.getRackObj(database, rack);
        if (!rackObj)
            return false;
        const key = String(id);
        const doc = rackObj.documents.get(key);
        if (!doc)
            return false;
        this.logWrite(database, rackObj, [{ o: 'd', i: key }]);
        this.removeFromIndexes(rackObj, key, doc.data);
        this.removeFromNativeIndexes(database, rack, rackObj, key);
        rackObj.documents.delete(key);
        this.touched(database, rackObj);
        return true;
    }
    // ───────────────────────────────────────────────────────────────────
    // Transactions
    // ───────────────────────────────────────────────────────────────────
    txSeq = 0;
    journalFd = null;
    journalPath() {
        return path.join(this.dataPath, '_txn.journal');
    }
    journalAppend(entry, durable) {
        if (this.journalFd === null)
            this.journalFd = fs.openSync(this.journalPath(), 'a');
        fs.writeSync(this.journalFd, store.encodeWal([entry], this.cipher));
        if (durable) {
            fs.fsyncSync(this.journalFd);
            this.stats.fsyncs++;
        }
    }
    /**
     * Crash recovery for transactions: a transaction is journaled (and
     * fsynced) before it touches any rack, and marked done afterwards. Any
     * journaled transaction without a done marker is re-applied here.
     * Puts and deletes are idempotent, so re-applying is always safe.
     */
    recoverTransactions() {
        const file = this.journalPath();
        if (!fs.existsSync(file))
            return;
        const { records } = store.readWal(file, this.cipher);
        const done = new Set(records.filter((r) => r.done).map((r) => r.done));
        let recovered = 0;
        for (const r of records) {
            if (!r.tx || done.has(r.tx))
                continue;
            for (const op of r.ops) {
                const rackObj = this.getRackObj(op.db, op.rack);
                if (!rackObj)
                    continue;
                const prev = rackObj.documents.get(op.o === 'p' ? op.d.id : op.i);
                this.logWrite(op.db, rackObj, [op.o === 'p' ? { o: 'p', d: op.d } : { o: 'd', i: op.i }]);
                if (prev)
                    this.removeFromIndexes(rackObj, prev.id, prev.data);
                if (op.o === 'p') {
                    rackObj.documents.set(op.d.id, op.d);
                    this.addToIndexes(rackObj, op.d.id, op.d.data);
                    const n = Number(op.d.id);
                    if (Number.isInteger(n) && n >= rackObj.nextId)
                        rackObj.nextId = n + 1;
                }
                else {
                    rackObj.documents.delete(op.i);
                }
                this.touched(op.db, rackObj);
            }
            recovered++;
        }
        if (recovered)
            console.log(`♻️  Recovered ${recovered} interrupted transaction(s) from the journal`);
        this.flushAll();
        fs.rmSync(file, { force: true });
    }
    /**
     * Starts a multi-rack (and multi-database) transaction. Reads see the
     * transaction's own uncommitted changes; nothing is visible to anyone
     * else until commit(), which applies everything or nothing.
     *
     * Isolation: optimistic. If another write changed a rack this
     * transaction touched between its first read/write and commit(),
     * commit() fails with a conflict and the caller may retry.
     */
    beginTransaction() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const engine = this;
        const stages = new Map();
        let state = 'open';
        let opCount = 0;
        const open = () => {
            if (state !== 'open')
                throw new Error(`Transaction already ${state}`);
            if (++opCount > 10_000)
                throw new Error('Transaction too large (max 10,000 operations)');
        };
        const stage = (db, rack) => {
            const key = `${db}\u0000${rack}`;
            let s = stages.get(key);
            if (!s) {
                const rackObj = engine.requireRack(db, rack);
                s = { db, rack, rackObj, version: rackObj.version, docs: new Map(), nextId: rackObj.nextId };
                stages.set(key, s);
            }
            return s;
        };
        const current = (s, id) => {
            if (s.docs.has(id))
                return s.docs.get(id) ?? undefined;
            return s.rackObj.documents.get(id);
        };
        const tx = {
            get(db, rack, id) {
                open();
                const s = stage(db, rack);
                const doc = current(s, String(id));
                return doc ? engine.materialize(engine.databases.get(db), doc, false) : null;
            },
            query(db, rack, query, options = {}) {
                open();
                const s = stage(db, rack);
                if (s.docs.size === 0)
                    return engine.query(db, rack, query, options);
                // Committed matches minus documents this transaction changed, plus its own versions.
                const q = (0, security_middleware_1.sanitizeObject)(typeof query === 'string' ? JSON.parse(query) : query ?? {});
                const matcher = (0, matcher_1.compileQuery)(q);
                const base = engine.query(db, rack, q, { sort: options.sort }).results.filter((r) => !s.docs.has(r.id));
                const dbObj = engine.databases.get(db);
                for (const doc of s.docs.values()) {
                    if (doc && matcher(doc.data ?? {}, doc.id))
                        base.push(engine.materialize(dbObj, doc, Boolean(options.populate)));
                }
                if (options.sort) {
                    const dir = options.sort.order === 'desc' ? -1 : 1;
                    const f = options.sort.field;
                    base.sort((a, b) => {
                        const av = f === 'id' ? Number(a.id) : (0, matcher_1.getPath)(a, f);
                        const bv = f === 'id' ? Number(b.id) : (0, matcher_1.getPath)(b, f);
                        const an = av === undefined || av === null, bn = bv === undefined || bv === null;
                        if (an || bn)
                            return an && bn ? 0 : an ? 1 : -1;
                        return dir * (0, matcher_1.compareValues)(av, bv);
                    });
                }
                else {
                    base.sort((a, b) => Number(a.id) - Number(b.id));
                }
                const skip = options.skip ?? 0;
                const end = options.limit ? skip + options.limit : undefined;
                return { results: base.slice(skip, end), total: base.length };
            },
            insert(db, rack, data) {
                open();
                const s = stage(db, rack);
                const parsed = engine.parseDocumentInput(data);
                engine.assertValid(s.rackObj, parsed);
                const id = String(s.nextId++);
                const now = new Date().toISOString();
                s.docs.set(id, { id, data: parsed, createdAt: now, updatedAt: now });
                return id;
            },
            update(db, rack, id, data) {
                open();
                const s = stage(db, rack);
                const cur = current(s, String(id));
                if (!cur)
                    return false;
                const parsed = engine.parseDocumentInput(data);
                engine.assertValid(s.rackObj, parsed);
                s.docs.set(cur.id, { id: cur.id, data: parsed, createdAt: cur.createdAt, updatedAt: new Date().toISOString() });
                return true;
            },
            patch(db, rack, id, data) {
                open();
                const s = stage(db, rack);
                const cur = current(s, String(id));
                if (!cur)
                    return false;
                const merged = { ...((0, security_middleware_1.isPlainObject)(cur.data) ? cur.data : {}), ...engine.parseDocumentInput(data) };
                engine.assertValid(s.rackObj, merged);
                s.docs.set(cur.id, { id: cur.id, data: merged, createdAt: cur.createdAt, updatedAt: new Date().toISOString() });
                return true;
            },
            delete(db, rack, id) {
                open();
                const s = stage(db, rack);
                const cur = current(s, String(id));
                if (!cur)
                    return false;
                s.docs.set(cur.id, null);
                return true;
            },
            commit() {
                if (state !== 'open')
                    throw new Error(`Transaction already ${state}`);
                const list = Array.from(stages.values()).filter((s) => s.docs.size > 0);
                // Optimistic concurrency + racks dropped meanwhile.
                for (const s of list) {
                    if (engine.getRackObj(s.db, s.rack) !== s.rackObj || s.rackObj.version !== s.version) {
                        state = 'rolled-back';
                        throw new Error(`Transaction conflict: ${s.db}/${s.rack} was changed by another write. Retry the transaction.`);
                    }
                }
                // Unique constraints against the final state.
                for (const s of list) {
                    for (const idx of s.rackObj.indices.values()) {
                        if (!idx.unique)
                            continue;
                        const claimed = new Map();
                        for (const doc of s.docs.values()) {
                            if (!doc)
                                continue;
                            for (const k of engine.keysFor(idx, doc.data)) {
                                const other = claimed.get(k);
                                const holders = Array.from(idx.store.get(k)).filter((h) => h !== doc.id && !s.docs.has(h));
                                if ((other && other !== doc.id) || holders.length > 0) {
                                    state = 'rolled-back';
                                    throw new Error(`Duplicate value for unique field '${idx.field}' in ${s.rack}: ${typeof k === 'string' && idx.fields ? k : JSON.stringify(k)}`);
                                }
                                claimed.set(k, doc.id);
                            }
                        }
                    }
                }
                const txId = `${Date.now().toString(36)}-${++engine.txSeq}`;
                const ops = [];
                for (const s of list) {
                    for (const [id, doc] of s.docs)
                        ops.push(doc ? { db: s.db, rack: s.rack, o: 'p', d: doc } : { db: s.db, rack: s.rack, o: 'd', i: id });
                }
                // 1. Journal the whole transaction durably before touching any rack.
                //    (Disk engine: not needed -- everything below lands in one atomic batch.)
                if (!engine.disk)
                    engine.journalAppend({ tx: txId, ops }, engine.walFsync);
                // 2. Apply to each rack's WAL and memory.
                for (const s of list) {
                    const records = [];
                    for (const [id, doc] of s.docs)
                        records.push(doc ? { o: 'p', d: doc } : { o: 'd', i: id });
                    engine.logWrite(s.db, s.rackObj, records);
                    for (const [id, doc] of s.docs) {
                        const prev = s.rackObj.documents.get(id);
                        if (prev)
                            engine.removeFromIndexes(s.rackObj, id, prev.data);
                        if (doc) {
                            s.rackObj.documents.set(id, doc);
                            engine.addToIndexes(s.rackObj, id, doc.data);
                            engine.syncNativeIndexes(s.db, s.rack, s.rackObj, id, doc.data);
                        }
                        else {
                            engine.removeFromNativeIndexes(s.db, s.rack, s.rackObj, id);
                            s.rackObj.documents.delete(id);
                        }
                    }
                    s.rackObj.nextId = Math.max(s.rackObj.nextId, s.nextId);
                    engine.touched(s.db, s.rackObj);
                }
                // 3. Mark done (made durable by the next group commit / journal fsync).
                if (!engine.disk)
                    engine.journalAppend({ done: txId }, false);
                // Without WAL_FSYNC there is no durability point to wait for; keep the journal small.
                if (!engine.walFsync && engine.journalFd !== null && fs.fstatSync(engine.journalFd).size > 1024 * 1024) {
                    fs.ftruncateSync(engine.journalFd, 0);
                }
                engine.stats.transactions++;
                state = 'committed';
                return { txId, changes: ops.length };
            },
            rollback() {
                if (state === 'open')
                    state = 'rolled-back';
                stages.clear();
            },
        };
        return tx;
    }
    // ───────────────────────────────────────────────────────────────────
    // Reads
    // ───────────────────────────────────────────────────────────────────
    materialize(db, doc, populate, extraMeta) {
        const data = (0, security_middleware_1.isPlainObject)(doc.data) ? doc.data : {};
        const result = { id: doc.id };
        Object.assign(result, data);
        result.id = doc.id; // the envelope id is authoritative
        result._metadata = { createdAt: doc.createdAt, updatedAt: doc.updatedAt, ...extraMeta };
        if (populate) {
            for (const key of Object.keys(result)) {
                const value = result[key];
                if (typeof value === 'string' && /^[a-zA-Z0-9_-]+:[0-9]+$/.test(value)) {
                    const [refRack, refId] = value.split(':');
                    const refDoc = db.racks.get(refRack)?.documents.get(refId);
                    if (refDoc) {
                        const refData = (0, security_middleware_1.isPlainObject)(refDoc.data) ? refDoc.data : {};
                        result[key] = { ...refData, id: refDoc.id };
                    }
                }
            }
        }
        return result;
    }
    /** O(1) primary-key lookup. */
    getDocument(database, rack, id, populate = false) {
        const db = this.databases.get(database);
        const doc = db?.racks.get(rack)?.documents.get(String(id));
        return doc ? this.materialize(db, doc, populate) : null;
    }
    static isPrimitiveKey(v) {
        const t = typeof v;
        return t === 'string' || t === 'number' || t === 'boolean';
    }
    static union(sets) {
        const out = new Set();
        for (const s of sets)
            for (const id of s)
                out.add(id);
        return out;
    }
    static intersect(a, b) {
        const [small, large] = a.size <= b.size ? [a, b] : [b, a];
        const out = new Set();
        for (const id of small)
            if (large.has(id))
                out.add(id);
        return out;
    }
    /** Candidate ids for one field condition using an index, or null if the index can't serve it. */
    indexCandidates(idx, cond) {
        if (idx.fields)
            return null; // compound keys are only used through plan()'s full-equality match
        if (OpenDBSEngine.isPrimitiveKey(cond))
            return idx.store.get(cond);
        if (!(0, security_middleware_1.isPlainObject)(cond))
            return null;
        const keys = Object.keys(cond);
        if (keys.length === 0 || !keys.every((k) => k.startsWith('$')))
            return null;
        if (hasOwn.call(cond, '$eq') && OpenDBSEngine.isPrimitiveKey(cond.$eq)) {
            return idx.store.get(cond.$eq);
        }
        if (hasOwn.call(cond, '$in') && Array.isArray(cond.$in) && cond.$in.every(OpenDBSEngine.isPrimitiveKey)) {
            return OpenDBSEngine.union(cond.$in.map((v) => idx.store.get(v)));
        }
        const rangeOps = ['$gt', '$gte', '$lt', '$lte'].filter((op) => hasOwn.call(cond, op));
        if (rangeOps.length > 0) {
            const t = typeof cond[rangeOps[0]];
            if ((t !== 'number' && t !== 'string') || !rangeOps.every((op) => typeof cond[op] === t))
                return null;
            // Tightest bound on each side (e.g. {$gt: 5, $gte: 7} → ≥ 7).
            let lo = null;
            let hi = null;
            for (const op of rangeOps) {
                const v = cond[op];
                if (op === '$gt' || op === '$gte') {
                    const incl = op === '$gte';
                    if (!lo || v > lo.v || (v === lo.v && !incl))
                        lo = { v, incl };
                }
                else {
                    const incl = op === '$lte';
                    if (!hi || v < hi.v || (v === hi.v && !incl))
                        hi = { v, incl };
                }
            }
            return idx.store.range(t, lo, hi);
        }
        return null;
    }
    /**
     * Query planner: returns a superset of matching ids drawn from indexes
     * (primary key, hash, range), or null when a full scan is required.
     * The compiled matcher still runs on every candidate, so the planner
     * only has to be conservative, never exact.
     */
    plan(rack, q) {
        let result = null;
        const add = (s) => {
            if (s === null)
                return;
            result = result === null ? s : OpenDBSEngine.intersect(result, s);
        };
        for (const key of Object.keys(q)) {
            const cond = q[key];
            if (key === '$and' && Array.isArray(cond)) {
                for (const sub of cond)
                    if ((0, security_middleware_1.isPlainObject)(sub))
                        add(this.plan(rack, sub));
            }
            else if (key === '$or' && Array.isArray(cond) && cond.length > 0) {
                const branches = cond.map((sub) => ((0, security_middleware_1.isPlainObject)(sub) ? this.plan(rack, sub) : null));
                if (branches.every((b) => b !== null))
                    add(OpenDBSEngine.union(branches));
            }
            else if (key.startsWith('$')) {
                continue;
            }
            else if (key === 'id') {
                if (OpenDBSEngine.isPrimitiveKey(cond)) {
                    const id = String(cond);
                    add(rack.documents.has(id) ? new Set([id]) : EMPTY_SET);
                }
                else if ((0, security_middleware_1.isPlainObject)(cond) && Array.isArray(cond.$in) && Object.keys(cond).length === 1) {
                    add(new Set(cond.$in.map(String).filter((id) => rack.documents.has(id))));
                }
            }
            else {
                const idx = rack.indices.get(key);
                if (idx)
                    add(this.indexCandidates(idx, cond));
            }
            if (result !== null && result.size === 0)
                return result;
        }
        // Compound indexes: usable when every indexed field has an equality condition.
        for (const idx of rack.indices.values()) {
            if (!idx.fields)
                continue;
            const vals = [];
            for (const f of idx.fields) {
                const c = q[f];
                const v = OpenDBSEngine.isPrimitiveKey(c) ? c
                    : (0, security_middleware_1.isPlainObject)(c) && OpenDBSEngine.isPrimitiveKey(c.$eq) ? c.$eq : undefined;
                if (v === undefined)
                    break;
                vals.push(v);
            }
            if (vals.length === idx.fields.length) {
                add(idx.store.get(JSON.stringify(vals)));
                if (result !== null && result.size === 0)
                    return result;
            }
        }
        return result;
    }
    /**
     * The exact set of matching ids when every condition is an equality or
     * $in on primitives over a single-field index (or on id) -- the index
     * then has exactly the matcher's semantics (value equal, or array
     * containing it). null for anything else (ranges, compound indexes,
     * operators, unindexed fields).
     */
    exactPlan(rack, q) {
        const keys = Object.keys(q);
        if (keys.length === 0)
            return null;
        const prim = (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
        let result = null;
        for (const key of keys) {
            const cond = q[key];
            let values;
            if (prim(cond))
                values = [cond];
            else if ((0, security_middleware_1.isPlainObject)(cond) && Object.keys(cond).length === 1 && hasOwn.call(cond, '$eq') && prim(cond.$eq))
                values = [cond.$eq];
            else if ((0, security_middleware_1.isPlainObject)(cond) && Object.keys(cond).length === 1 && Array.isArray(cond.$in) && cond.$in.length <= 1000 && cond.$in.every(prim))
                values = cond.$in;
            else
                return null;
            let set;
            if (key === 'id') {
                set = new Set(values.map(String).filter((id) => rack.documents.has(id)));
            }
            else {
                if (key.startsWith('$'))
                    return null;
                const idx = rack.indices.get(key);
                if (!idx || idx.fields)
                    return null;
                set = values.length === 1 ? idx.store.get(values[0]) : OpenDBSEngine.union(values.map((v) => idx.store.get(v)));
            }
            result = result === null ? set : OpenDBSEngine.intersect(result, set);
            if (result.size === 0)
                return result;
        }
        return result;
    }
    /** Natural order: numeric ids ascending (typed-array sort), then any others. */
    static sortIds(ids) {
        const nums = new Float64Array(ids.size);
        const other = [];
        let n = 0;
        for (const id of ids) {
            const v = Number(id);
            if (Number.isSafeInteger(v) && String(v) === id)
                nums[n++] = v;
            else
                other.push(id);
        }
        const sorted = nums.subarray(0, n).sort();
        const out = new Array(n);
        for (let i = 0; i < n; i++)
            out[i] = String(sorted[i]);
        if (other.length)
            out.push(...other.sort());
        return out;
    }
    sortValue(doc, field) {
        if (field === 'id') {
            const n = Number(doc.id);
            return Number.isFinite(n) ? n : doc.id;
        }
        const v = (0, matcher_1.getPath)(doc.data, field);
        if (v === undefined && (field === 'createdAt' || field === 'updatedAt'))
            return doc[field];
        return v;
    }
    /**
     * Documents to run the matcher over: index candidates in natural (id)
     * order, fetched in batches, or the whole rack in one sequential scan.
     */
    *scanSource(rackObj, candidates) {
        if (!candidates) {
            yield* rackObj.documents.entries();
            return;
        }
        const ids = Array.from(candidates).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0));
        for (let i = 0; i < ids.length; i += 512) {
            const chunk = ids.slice(i, i + 512);
            const docs = rackObj.documents.getMany(chunk);
            for (let j = 0; j < chunk.length; j++) {
                const d = docs[j];
                if (d)
                    yield [chunk[j], d];
            }
        }
    }
    execute(rackObj, cacheKey, queryObj, options) {
        if (cacheKey !== null) {
            const hit = this.queryCache.get(cacheKey);
            if (hit && hit.version === rackObj.version) {
                this.stats.cacheHits++;
                // refresh LRU position
                this.queryCache.delete(cacheKey);
                this.queryCache.set(cacheKey, hit);
                return hit;
            }
            this.stats.cacheMisses++;
        }
        const { skip = 0, limit, sort } = options;
        // Unfiltered, unsorted page: no matching needed, stop as soon as the page is full.
        if (!sort && Object.keys(queryObj).length === 0) {
            const ids = [];
            const max = limit != null && limit > 0 ? limit : Infinity;
            let i = 0;
            for (const id of rackObj.documents.keys()) {
                if (i++ < skip)
                    continue;
                if (ids.length >= max)
                    break;
                ids.push(id);
            }
            return this.storeCache(cacheKey, { version: rackObj.version, ids, total: rackObj.documents.size });
        }
        // Fully index-answered (equality / $in on indexed fields): the id set *is*
        // the result, so only the requested page of documents is ever read.
        if (!sort) {
            const exact = this.exactPlan(rackObj, queryObj);
            if (exact) {
                this.stats.indexedQueries++;
                const all = OpenDBSEngine.sortIds(exact);
                const end = limit != null && limit > 0 ? skip + limit : undefined;
                return this.storeCache(cacheKey, { version: rackObj.version, ids: all.slice(skip, end), total: all.length });
            }
        }
        const matcher = (0, matcher_1.compileQuery)(queryObj);
        const candidates = this.plan(rackObj, queryObj);
        if (candidates)
            this.stats.indexedQueries++;
        else
            this.stats.fullScans++;
        const source = this.scanSource(rackObj, candidates);
        let ids;
        let total = 0;
        if (!sort) {
            ids = [];
            const max = limit != null && limit > 0 ? limit : Infinity;
            for (const [id, doc] of source) {
                if (!matcher(doc.data ?? {}, id))
                    continue;
                if (total >= skip && ids.length < max)
                    ids.push(id);
                total++;
            }
        }
        else {
            const matched = [];
            for (const [id, doc] of source) {
                if (matcher(doc.data ?? {}, id))
                    matched.push(doc);
            }
            total = matched.length;
            const dir = sort.order === 'desc' ? -1 : 1;
            const keyed = matched.map((d) => ({ d, v: this.sortValue(d, sort.field) }));
            keyed.sort((a, b) => {
                const an = a.v === undefined || a.v === null;
                const bn = b.v === undefined || b.v === null;
                if (an || bn)
                    return an && bn ? 0 : an ? 1 : -1; // missing values last in both directions
                return dir * (0, matcher_1.compareValues)(a.v, b.v);
            });
            const end = limit != null && limit > 0 ? skip + limit : undefined;
            ids = keyed.slice(skip, end).map((k) => k.d.id);
        }
        return this.storeCache(cacheKey, { version: rackObj.version, ids, total });
    }
    storeCache(cacheKey, entry) {
        if (cacheKey !== null) {
            this.queryCache.set(cacheKey, entry);
            if (this.queryCache.size > this.queryCacheEntries) {
                const oldest = this.queryCache.keys().next().value;
                if (oldest !== undefined)
                    this.queryCache.delete(oldest);
            }
        }
        return entry;
    }
    /**
     * Object-returning query API (preferred). Returns the requested page and
     * the total number of matches.
     */
    query(database, rack, query, options = {}) {
        const db = this.databases.get(database);
        const rackObj = db?.racks.get(rack);
        if (!db || !rackObj)
            return { results: [], total: 0 };
        const raw = typeof query === 'string' ? JSON.parse(query) : query ?? {};
        const queryObj = (0, security_middleware_1.sanitizeObject)(raw); // strip __proto__ / constructor pollution
        if (!(0, security_middleware_1.isPlainObject)(queryObj))
            throw new Error('Query must be an object');
        if (options.sort && !(0, security_middleware_1.validateFieldName)(options.sort.field))
            throw new Error('Invalid sort field');
        const cacheKey = this.queryCacheEntries > 0
            ? `${database}\u0000${rack}\u0000${JSON.stringify(queryObj)}\u0000${options.skip ?? 0}|${options.limit ?? ''}|${options.sort ? options.sort.field + ':' + options.sort.order : ''}`
            : null;
        const { ids, total } = this.execute(rackObj, cacheKey, queryObj, options);
        const populate = Boolean(options.populate);
        const results = [];
        for (const id of ids) {
            const doc = rackObj.documents.get(id);
            if (doc)
                results.push(this.materialize(db, doc, populate));
        }
        return { results, total };
    }
    // ───────────────────────────────────────────────────────────────────
    // Parallel scans (disk engine, worker threads)
    // ───────────────────────────────────────────────────────────────────
    queryPool() {
        if (!this.disk)
            return null;
        if (this.pool === undefined) {
            this.pool = null;
            if (this.queryWorkers > 0) {
                try {
                    this.pool = new query_pool_1.QueryPool(this.disk.native.handle, this.queryWorkers);
                }
                catch (err) {
                    console.warn(`⚠️  Parallel query workers unavailable: ${err?.message}`);
                }
            }
        }
        return this.pool && this.pool.alive ? this.pool : null;
    }
    /** Key ranges covering a rack's documents (by id), one task each. */
    scanChunks(rack, parts) {
        const max = Math.max(1, rack.nextId);
        const n = Math.max(1, Math.min(parts, Math.ceil(max / 5000)));
        const step = Math.ceil(max / n);
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push({
                lo: i === 0 ? null : (0, disk_store_1.encodeId)(String(i * step)),
                hi: i === n - 1 ? null : (0, disk_store_1.encodeId)(String((i + 1) * step)), // string ids sort after numbers: last range
            });
        }
        return out;
    }
    parallelRack(database, rack) {
        const rackObj = this.getRackObj(database, rack);
        if (!rackObj || !(rackObj.documents instanceof disk_store_1.DiskDocMap) || rackObj.documents.size < this.parallelMinDocs)
            return null;
        return this.queryPool() ? rackObj : null;
    }
    /**
     * Same as query(), but a full scan of a large rack is split across the
     * worker threads (all CPU cores). Index-served and small queries run
     * here directly. Results reflect all writes acknowledged before the call.
     */
    async queryAsync(database, rack, query, options = {}) {
        const rackObj = this.parallelRack(database, rack);
        if (!rackObj)
            return this.query(database, rack, query, options);
        const raw = typeof query === 'string' ? JSON.parse(query) : query ?? {};
        const queryObj = (0, security_middleware_1.sanitizeObject)(raw);
        if (!(0, security_middleware_1.isPlainObject)(queryObj))
            throw new Error('Query must be an object');
        if (options.sort && !(0, security_middleware_1.validateFieldName)(options.sort.field))
            throw new Error('Invalid sort field');
        const { skip = 0, limit, sort } = options;
        const unfiltered = Object.keys(queryObj).length === 0;
        if ((!sort && unfiltered) || (!sort && this.exactPlan(rackObj, queryObj)) || this.plan(rackObj, queryObj) !== null) {
            return this.query(database, rack, queryObj, options);
        }
        const cacheKey = this.queryCacheEntries > 0
            ? `${database}\u0000${rack}\u0000${JSON.stringify(queryObj)}\u0000${skip}|${limit ?? ''}|${sort ? sort.field + ':' + sort.order : ''}`
            : null;
        const hit = cacheKey !== null ? this.queryCache.get(cacheKey) : undefined;
        if (hit && hit.version === rackObj.version)
            return this.query(database, rack, queryObj, options);
        const matcher = (0, matcher_1.compileQuery)(queryObj); // reports query errors before any work
        const pool = this.queryPool();
        const version = rackObj.version;
        await this.disk.sync(); // workers read committed data: everything acknowledged so far
        const keep = limit != null && limit > 0 ? skip + limit : undefined;
        const table = rackObj.documents.table;
        const chunks = this.scanChunks(rackObj, pool.size * 4);
        let parts;
        try {
            parts = await pool.runAll(chunks.map((c) => ({
                kind: 'filter', table, lo: c.lo, hi: c.hi, query: queryObj,
                need: sort ? 'top' : 'ids', keep, sort,
            })));
        }
        catch (err) {
            this.workerFailed(err);
            return this.query(database, rack, queryObj, options);
        }
        this.stats.fullScans++;
        let total = 0;
        let ids;
        if (!sort) {
            ids = [];
            for (const p of parts) {
                total += p.count;
                for (const id of p.ids)
                    ids.push(id);
            }
            ids = ids.slice(skip, keep);
        }
        else {
            const dir = sort.order === 'desc' ? -1 : 1;
            const all = [];
            for (const p of parts) {
                total += p.count;
                for (const t of p.top)
                    all.push(t);
            }
            all.sort((a, b) => {
                const an = a[0] === undefined || a[0] === null, bn = b[0] === undefined || b[0] === null;
                const c = an || bn ? (an && bn ? 0 : an ? 1 : -1) : dir * (0, matcher_1.compareValues)(a[0], b[0]);
                return c !== 0 ? c : Number(a[1]) - Number(b[1]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
            });
            ids = all.slice(skip, keep).map((t) => t[1]);
        }
        if (cacheKey !== null && rackObj.version === version)
            this.storeCache(cacheKey, { version, ids, total });
        const db = this.databases.get(database);
        const populate = Boolean(options.populate);
        const results = [];
        const docs = rackObj.documents.getMany(ids);
        docs.forEach((doc) => {
            // Re-checked: a document may have changed while the workers were scanning.
            if (doc && matcher(doc.data ?? {}, doc.id))
                results.push(this.materialize(db, doc, populate));
        });
        return { results, total };
    }
    /**
     * GROUP BY over a large rack, computed in parallel: each worker builds
     * partial aggregates for its key range; they are merged here. Returns
     * null when not applicable (the caller then aggregates itself).
     * groups: field paths ("id" = numeric id); aggs: mergeable aggregates (field null = *).
     */
    async aggregateParallel(database, rack, query, groups, aggs, 
    /** SQL WHERE the workers evaluate exactly (when `query` is only a coarse pre-filter). */
    sqlWhere) {
        const rackObj = this.parallelRack(database, rack);
        if (!rackObj)
            return null;
        const queryObj = (0, security_middleware_1.sanitizeObject)(query ?? {});
        if (!(0, security_middleware_1.isPlainObject)(queryObj))
            return null;
        // An index can narrow the scan a lot: then a plain indexed query is cheaper.
        if (this.plan(rackObj, queryObj) !== null || this.exactPlan(rackObj, queryObj) !== null)
            return null;
        // COUNT(*) of the whole rack is known without scanning.
        if (!sqlWhere && Object.keys(queryObj).length === 0 && groups.length === 0 && aggs.every((a) => a.name === 'COUNT' && a.field === null))
            return null;
        (0, matcher_1.compileQuery)(queryObj);
        const pool = this.queryPool();
        await this.disk.sync();
        const table = rackObj.documents.table;
        const chunks = this.scanChunks(rackObj, pool.size * 4);
        let parts;
        try {
            parts = await pool.runAll(chunks.map((c) => ({ kind: 'agg', table, lo: c.lo, hi: c.hi, query: queryObj, groups, aggs, sqlWhere })));
        }
        catch (err) {
            this.workerFailed(err);
            return null;
        }
        this.stats.fullScans++;
        return (0, agg_state_1.finishPartials)((0, agg_state_1.mergePartials)(parts.flatMap((p) => p.groups)), groups, aggs);
    }
    /** A worker problem must never fail a query: stop using the pool and carry on single-threaded. */
    workerFailed(err) {
        console.warn(`⚠️  Parallel query workers failed (${err?.message ?? err}); continuing on the main thread`);
        const p = this.pool;
        this.pool = null;
        if (p)
            void p.close();
    }
    /** Parallel query workers (disk engine). */
    parallelInfo() {
        const p = this.pool;
        return { workers: p ? p.size : 0, enabled: Boolean(this.disk) && this.queryWorkers > 0, minDocs: this.parallelMinDocs, ...(p ? p.stats : { tasks: 0, parallelQueries: 0, failures: 0 }) };
    }
    /**
     * Aggregation pipeline. A leading $match runs through the query planner
     * (indexes, cache); $lookup fetches only the referenced documents of the
     * other rack via an $in query (index-backed when that field is indexed).
     */
    aggregate(database, rack, pipeline, source) {
        if (!Array.isArray(pipeline))
            throw new Error('pipeline must be an array of stages');
        if (this.getRackCount(database, rack) < 0)
            throw new Error(`Rack '${rack}' not found in database '${database}'`);
        const reader = source ?? this;
        const strip = (rows) => rows.map((r) => { delete r._metadata; return r; });
        let rest = pipeline;
        let initial = {};
        if (pipeline.length > 0 && (0, security_middleware_1.isPlainObject)(pipeline[0]) && (0, security_middleware_1.isPlainObject)(pipeline[0].$match) && Object.keys(pipeline[0]).length === 1) {
            initial = pipeline[0].$match;
            rest = pipeline.slice(1);
        }
        const input = strip(reader.query(database, rack, initial).results);
        return (0, aggregate_1.runPipeline)(input, rest, {
            lookup: (from, field, values) => {
                if (!(0, security_middleware_1.validateIdentifier)(from) || this.getRackCount(database, from) < 0)
                    throw new Error(`$lookup: rack '${from}' not found in '${database}'`);
                const q = field === 'id' ? { id: { $in: values.map(String) } } : { [field]: { $in: values.slice(0, 1000) } };
                if (values.length > 1000 && field !== 'id') {
                    // Large key sets: chunk the $in to keep each query bounded.
                    const out = [];
                    for (let i = 0; i < values.length; i += 1000)
                        out.push(...reader.query(database, from, { [field]: { $in: values.slice(i, i + 1000) } }).results);
                    return strip(out);
                }
                return strip(reader.query(database, from, q).results);
            },
        });
    }
    count(database, rack, query = {}) {
        return this.query(database, rack, query, { limit: 1 }).total;
    }
    /** Legacy string API -- each result is a JSON string. Prefer query(). */
    find(database, rack, query, options = {}) {
        return this.query(database, rack, query, options).results.map((r) => JSON.stringify(r));
    }
    fuzzySearch(database, rack, field, query, threshold) {
        const db = this.databases.get(database);
        const rackObj = db?.racks.get(rack);
        if (!db || !rackObj)
            return [];
        if (!(0, security_middleware_1.validateFieldName)(field))
            throw new Error('Invalid field name');
        if (typeof query !== 'string' || query.length > 1000)
            throw new Error('Query must be a string (max 1000 chars)');
        // Rust trigram index: sub-linear candidate narrowing + ranked,
        // typo-tolerant scoring instead of a full O(n) document scan.
        if (this.nativeSearch.available && rackObj.textIndexedFields.has(field)) {
            const nativeResults = this.nativeSearch.searchText(database, rack, field, query, 200);
            const out = [];
            for (const r of nativeResults) {
                if (r.score < threshold)
                    continue;
                const doc = rackObj.documents.get(r.id);
                if (doc)
                    out.push(JSON.stringify(this.materialize(db, doc, false, { score: r.score })));
            }
            return out;
        }
        // Fallback: brute-force scan, used when no text index has been
        // created on this field, or the native addon isn't available.
        const q = query.toLowerCase();
        const results = [];
        for (const doc of rackObj.documents.values()) {
            const fieldValue = (0, matcher_1.getPath)(doc.data, field);
            if (typeof fieldValue !== 'string')
                continue;
            const similarity = this.calculateSimilarity(q, fieldValue.toLowerCase());
            if (similarity >= threshold)
                results.push({ doc, score: similarity });
        }
        results.sort((a, b) => b.score - a.score);
        return results.map((r) => JSON.stringify(this.materialize(db, r.doc, false, { score: r.score })));
    }
    getDatabases() {
        return Array.from(this.databases.keys());
    }
    getStats() {
        let totalRacks = 0;
        let totalDocuments = 0;
        for (const [, db] of this.databases) {
            totalRacks += db.racks.size;
            for (const [, rack] of db.racks) {
                totalDocuments += rack.documents.size;
            }
        }
        return JSON.stringify({
            databases: this.databases.size,
            racks: totalRacks,
            documents: totalDocuments,
        });
    }
    /** Operational metrics for the admin panel. */
    getEngineStats() {
        let racks = 0, documents = 0, indexes = 0, dirtyRacks = 0, walEntries = 0;
        for (const db of this.databases.values()) {
            for (const rack of db.racks.values()) {
                racks++;
                documents += rack.documents.size;
                indexes += rack.indices.size + rack.textIndexedFields.size + rack.vectorIndexedFields.size;
                if (rack.dirty || rack.inFlight)
                    dirtyRacks++;
                walEntries += rack.walEntries;
            }
        }
        const lookups = this.stats.cacheHits + this.stats.cacheMisses;
        return {
            databases: this.databases.size,
            racks,
            documents,
            indexes,
            nativeSearch: this.nativeSearch.available,
            encryption: {
                enabled: this.cipher !== null,
                algorithm: this.cipher ? (this.disk ? 'AES-256-XTS' : 'AES-256-GCM') : null,
                keyFingerprint: this.cipher?.fingerprint ?? null,
            },
            transactions: this.stats.transactions,
            // Disk engine: every commit is fsynced when WAL_FSYNC is on.
            fsyncs: this.stats.fsyncs + (this.disk && this.walFsync ? this.disk.stats.commits : 0),
            queryCache: {
                capacity: this.queryCacheEntries,
                entries: this.queryCache.size,
                hits: this.stats.cacheHits,
                misses: this.stats.cacheMisses,
                hitRate: lookups ? this.stats.cacheHits / lookups : 0,
            },
            planner: {
                indexedQueries: this.stats.indexedQueries,
                fullScans: this.stats.fullScans,
            },
            storage: this.storageInfo(),
            parallel: this.parallelInfo(),
            persistence: {
                mode: this.disk ? 'disk-btree' : this.persistDebounceMs === 0 ? 'sync-snapshot' : 'wal',
                walFsync: this.walFsync,
                debounceMs: this.persistDebounceMs,
                dirtyRacks,
                pendingWalEntries: walEntries,
                walWrites: this.stats.walWrites,
                snapshots: this.stats.snapshots,
                snapshotFailures: this.stats.snapshotFailures,
                lastSnapshotAt: this.stats.lastSnapshotAt,
                lastSnapshotMs: this.stats.lastSnapshotMs,
                walRecordsReplayed: this.stats.walRecordsReplayed,
            },
            startedAt: this.stats.startedAt,
        };
    }
    /** Which storage engine is active and how much it holds on disk / in RAM. */
    storageInfo() {
        if (this.disk) {
            const d = this.disk;
            const lookups = d.stats.cacheHits + d.stats.cacheMisses;
            return {
                engine: 'disk',
                file: d.file,
                fileBytes: d.native.fileSize(),
                encryption: this.cipher ? 'AES-256-XTS' : null,
                cache: { ...d.cacheInfo(), hits: d.stats.cacheHits, misses: d.stats.cacheMisses, hitRate: lookups ? d.stats.cacheHits / lookups : 0 },
                commits: d.stats.commits,
                opsCommitted: d.stats.opsCommitted,
                commitFailures: d.stats.commitFailures,
                lastError: d.stats.lastError,
                pending: d.hasPending(),
            };
        }
        let fileBytes = 0;
        for (const db of this.databases.keys()) {
            try {
                const dir = this.getDatabasePath(db);
                for (const f of fs.readdirSync(dir)) {
                    if (f.endsWith('.odbs') || f.endsWith('.wal'))
                        fileBytes += fs.statSync(path.join(dir, f)).size;
                }
            }
            catch { /* ignore */ }
        }
        return { engine: 'memory', file: null, fileBytes, encryption: this.cipher ? 'AES-256-GCM' : null };
    }
    /**
     * Backup hook: every rack of a database as an .odbs snapshot (the
     * portable backup format, encrypted with the data key), one rack in
     * memory at a time.
     */
    exportDatabase(database) {
        const db = this.databases.get(database);
        if (!db)
            return [];
        this.flushAll();
        const out = [];
        for (const rack of db.racks.values()) {
            const data = this.serializeRack(rack, 0);
            out.push({
                fileName: `${rack.name}.odbs`,
                content: store.sealSnapshot(store.compressSync(store.encodeSnapshot(data).envelope), this.cipher),
            });
        }
        return out;
    }
    /** True when racks live in the disk store (restore goes through restoreDatabase, not files). */
    usesDiskStorage() {
        return this.disk !== null;
    }
    /**
     * Disk engine restore: replaces racks with the given .odbs snapshots.
     * `replace` also removes racks of the database that the backup lacks.
     */
    restoreDatabase(database, files, replace) {
        if (!this.disk)
            throw new Error('restoreDatabase is only used by the disk storage engine');
        if (!(0, security_middleware_1.validateIdentifier)(database))
            throw new Error(`Invalid database name '${database}'`);
        // Decode everything first: nothing changes unless every file is readable.
        const decoded = files.map((f) => {
            const rackName = path.basename(f.fileName, '.odbs');
            if (!(0, security_middleware_1.validateIdentifier)(rackName))
                throw new Error(`Invalid rack file '${f.fileName}'`);
            return { rackName, data: store.decodeSnapshot(store.openSnapshot(f.content, this.cipher).body) };
        });
        this.createDatabase(database);
        const db = this.databases.get(database);
        let removed = 0;
        if (replace) {
            const keep = new Set(decoded.map((d) => d.rackName));
            for (const name of Array.from(db.racks.keys())) {
                if (!keep.has(name)) {
                    this.deleteRack(database, name);
                    removed++;
                }
            }
        }
        for (const { rackName, data } of decoded) {
            const { rack, indexDefs } = this.rackFromSnapshot(database, rackName, data);
            this.importRack(db, rack, indexDefs);
        }
        this.queryCache.clear();
        return { count: decoded.length, removed };
    }
    getDatabaseRacks(database) {
        const db = this.databases.get(database);
        if (!db)
            return [];
        const racks = [];
        for (const [name, rack] of db.racks) {
            racks.push({
                name,
                type: rack.type,
                count: rack.documents.size,
                schema: rack.schema,
                createdAt: rack.createdAt.toISOString(),
            });
        }
        return racks;
    }
    getRackCount(database, rack) {
        return this.getRackObj(database, rack)?.documents.size ?? -1;
    }
    vectorSearch(database, rack, vectorField, queryVector, k = 10) {
        const db = this.databases.get(database);
        const rackObj = db?.racks.get(rack);
        if (!db || !rackObj)
            return [];
        if (!Array.isArray(queryVector) || queryVector.length === 0 || queryVector.length > 8192 ||
            !queryVector.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            throw new Error('queryVector must be a non-empty array of finite numbers (max 8192)');
        }
        if (!(0, security_middleware_1.validateFieldName)(vectorField))
            throw new Error('Invalid field name');
        // Rust HNSW index over scalar-quantized (int8) vectors: approximate
        // nearest-neighbor search instead of a full O(n) brute-force scan.
        if (this.nativeSearch.available && rackObj.vectorIndexedFields.has(vectorField)) {
            const nativeResults = this.nativeSearch.searchVector(database, rack, vectorField, queryVector, k);
            const out = [];
            for (const r of nativeResults) {
                const doc = rackObj.documents.get(r.id);
                if (doc)
                    out.push(JSON.stringify(this.materialize(db, doc, false, { score: r.score })));
            }
            return out;
        }
        // Fallback: brute-force cosine scan, used when no vector index has
        // been created on this field, or the native addon isn't available.
        const candidates = [];
        for (const doc of rackObj.documents.values()) {
            const docVector = (0, matcher_1.getPath)(doc.data, vectorField);
            if (Array.isArray(docVector) && docVector.length === queryVector.length) {
                candidates.push({ doc, similarity: this.calculateCosineSimilarity(queryVector, docVector) });
            }
        }
        candidates.sort((a, b) => b.similarity - a.similarity);
        return candidates
            .slice(0, k)
            .map((c) => JSON.stringify(this.materialize(db, c.doc, false, { score: c.similarity })));
    }
    calculateCosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            magnitudeA += vecA[i] * vecA[i];
            magnitudeB += vecB[i] * vecB[i];
        }
        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);
        if (magnitudeA === 0 || magnitudeB === 0)
            return 0;
        return dotProduct / (magnitudeA * magnitudeB);
    }
    calculateSimilarity(str1, str2) {
        if (str1 === str2)
            return 1;
        if (str1.length === 0 || str2.length === 0)
            return 0;
        // Exact substring match gets a high score
        if (str2.includes(str1) || str1.includes(str2))
            return 0.9;
        // Bound the O(m·n) DP so one huge field value can't stall the event loop.
        if (str1.length > 2000 || str2.length > 2000)
            return 0;
        // Levenshtein distance-based similarity
        const len1 = str1.length;
        const len2 = str2.length;
        // Use two rows to keep memory O(min(m,n))
        let prev = Array.from({ length: len2 + 1 }, (_, i) => i);
        let curr = new Array(len2 + 1).fill(0);
        for (let i = 1; i <= len1; i++) {
            curr[0] = i;
            for (let j = 1; j <= len2; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                curr[j] = Math.min(prev[j] + 1, // deletion
                curr[j - 1] + 1, // insertion
                prev[j - 1] + cost // substitution
                );
            }
            [prev, curr] = [curr, prev];
        }
        const distance = prev[len2];
        return 1 - distance / Math.max(len1, len2);
    }
    getDatabaseStats(database) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const racks = [];
        let totalDocuments = 0;
        for (const [rackName, rack] of db.racks) {
            const count = rack.documents.size;
            totalDocuments += count;
            racks.push({
                name: rackName,
                type: rack.type,
                count,
                indexCount: rack.indices.size,
            });
        }
        return { totalRacks: db.racks.size, totalDocuments, racks };
    }
}
exports.OpenDBSEngine = OpenDBSEngine;
//# sourceMappingURL=engine.js.map