/**
 * Storage back-ends for rack documents and field indexes.
 *
 * memory: plain Maps (the whole data set lives in RAM; persisted elsewhere
 *         as snapshots + WAL).
 * disk:   an encrypted redb B-tree file in the native addon. Only a
 *         byte-bounded cache of hot documents is kept in RAM, so a rack can
 *         be far larger than memory.
 *
 * Disk writes made during one event-loop tick are collected into a single
 * batch and committed atomically on the thread pool (group commit). Until a
 * batch is committed its writes stay visible through a small overlay, so
 * reads always see the latest state.
 */
export interface StoredDoc {
    id: string;
    data: any;
    createdAt: string;
    updatedAt: string;
}
export type IndexKey = string | number | boolean;
export interface RangeBound {
    v: number | string;
    incl: boolean;
}
/** What the engine needs from a rack's document collection (Map-compatible). */
export interface DocStore extends Iterable<[string, StoredDoc]> {
    readonly size: number;
    get(id: string): StoredDoc | undefined;
    has(id: string): boolean;
    set(id: string, doc: StoredDoc): unknown;
    /** Insert of an id known not to exist yet (skips the existence check). */
    add(id: string, doc: StoredDoc): void;
    delete(id: string): boolean;
    clear(): void;
    keys(): Iterable<string>;
    values(): Iterable<StoredDoc>;
    entries(): Iterable<[string, StoredDoc]>;
    getMany(ids: string[]): Array<StoredDoc | undefined>;
}
export interface IndexStore {
    /** Ids having exactly this key (exact, never a superset). */
    get(k: IndexKey): ReadonlySet<string>;
    add(k: IndexKey, id: string): void;
    remove(k: IndexKey, id: string): void;
    /** Ids with a key of `type` inside the bounds. May include a few extra ids; callers re-check. */
    range(type: 'number' | 'string', lo: RangeBound | null, hi: RangeBound | null): ReadonlySet<string>;
    /** distinctKeys (memory) and/or entries (disk: one per indexed value of a document). */
    info(): {
        distinctKeys?: number;
        entries?: number;
    };
    clear(): void;
    /** The index is being removed: release its storage. */
    drop(): void;
    beginBuild(): void;
    endBuild(): void;
    abortBuild(): void;
}
export declare class MemoryDocStore extends Map<string, StoredDoc> implements DocStore {
    add(id: string, doc: StoredDoc): void;
    getMany(ids: string[]): Array<StoredDoc | undefined>;
}
/**
 * Hash index (key → ids) with lazily built sorted key arrays that serve
 * range queries via binary search.
 */
export declare class MemoryIndexStore implements IndexStore {
    private map;
    private sortedNums;
    private sortedStrs;
    private invalidate;
    get(k: IndexKey): ReadonlySet<string>;
    add(k: IndexKey, id: string): void;
    remove(k: IndexKey, id: string): void;
    private sorted;
    range(type: 'number' | 'string', lo: RangeBound | null, hi: RangeBound | null): ReadonlySet<string>;
    info(): {
        distinctKeys: number;
    };
    clear(): void;
    drop(): void;
    beginBuild(): void;
    endBuild(): void;
    abortBuild(): void;
}
/** Document ids → B-tree keys. Engine ids are integers, stored big-endian so key order = numeric order. */
export declare function encodeId(id: string): Buffer;
export declare function decodeId(b: Buffer): string;
/**
 * Index keys → bytes whose byte order matches JavaScript's ordering of the
 * values, and which are prefix-free so a document id can follow:
 *   numbers: order-preserving IEEE-754 (9 bytes)
 *   strings: UTF-16 code units (the order of the `<` operator) in a compact
 *            variable-length form, 0x00 escaped as 00 FF, terminated by 00
 */
export declare function encodeIndexKey(k: IndexKey): Buffer;
/** Collects ops into the packed format the native store commits: [u8 kind][u32 table][u32 klen][key][u32 vlen][value]. */
declare class OpWriter {
    readonly tables: string[];
    private tableIdx;
    private buf;
    private len;
    count: number;
    push(kind: number, table: string, key?: Buffer, value?: Buffer): void;
    get bytes(): Buffer;
}
/** Calls `fn` for every op in a packed op buffer. */
export declare function forEachOp(buf: Buffer, tables: string[], fn: (kind: number, table: string, key: Buffer, value: Buffer) => void): void;
interface NativeStore {
    /** Lets worker threads attach to this store (Store.attach(handle)). */
    readonly handle: number;
    commit(tables: string[], ops: Buffer, durable: boolean): Promise<void>;
    commitSync(tables: string[], ops: Buffer, durable: boolean): void;
    close(): void;
    get(table: string, key: Buffer): Buffer | null;
    getMany(table: string, keys: Buffer): Buffer;
    scan(table: string, after: Buffer | null, limit: number): Buffer;
    scanRange(table: string, lo: Buffer | null, loInclusive: boolean, hi: Buffer | null, limit: number): Buffer;
    edgeKey(table: string, last: boolean): Buffer | null;
    rangeValues(table: string, lo: Buffer | null, loInclusive: boolean, hi: Buffer | null, hiInclusive: boolean, limit: number): Buffer;
    rangeCount(table: string, lo: Buffer | null, loInclusive: boolean, hi: Buffer | null, hiInclusive: boolean, limit: number): number;
    count(table: string): number;
    listTables(): string[];
    fileSize(): number;
}
export declare function diskStorageAvailable(): boolean;
export declare const STORE_DIR = ".storage";
export declare const STORE_FILE = "opendbs.odb";
export declare function storeFilePath(dataPath: string): string;
/** Replication log table (lsn → batch) and node-local cluster state (never replicated). */
export declare const REPL_TABLE = "repl";
export declare const CLUSTER_TABLE = "cluster";
export interface LogEntry {
    lsn: number;
    term: number;
    tables: string[];
    ops: Buffer;
}
export declare function lsnKey(n: number): Buffer;
export declare const lsnOf: (key: Buffer) => number;
/**
 * Owns the store file and the write pipeline: batches every write of a tick
 * into one atomic commit, tracks which batch each overlay entry belongs to,
 * and keeps the shared byte-budgeted document cache.
 */
export declare class DiskStorage {
    readonly file: string;
    readonly native: NativeStore;
    private readonly durable;
    private pending;
    private pendingCleanups;
    /** Sequence number of the batch currently being collected. */
    private batchSeq;
    /** Every batch ≤ this is committed (and fsynced in durable mode). */
    committedSeq: number;
    private inFlight;
    private inFlightCleanups;
    /** A batch whose commit failed; it is retried before anything newer. */
    private retry;
    private scheduled;
    private cutting;
    private waiters;
    private lazyTimer;
    private needsDurable;
    private closed;
    /** Called right before a batch is cut, so the engine can append rack metadata. */
    beforeFlush: (() => void) | null;
    /** Leader: every commit is also appended to the replication log (same atomic batch). */
    private logging;
    /** Term stamped on new log entries. */
    term: number;
    /** Highest LSN written to this node's log (or covered by a full sync). */
    lastLsn: number;
    lastTerm: number;
    /** Highest LSN known committed (durable when WAL_FSYNC). */
    committedLsn: number;
    /** Set on replicas: local writes are refused with this message. */
    readOnly: string | null;
    private applying;
    /** Called after a logged batch commits (wakes replication long-polls). */
    onLogCommitted: ((lsn: number) => void) | null;
    private young;
    private old;
    private youngBytes;
    private oldBytes;
    private readonly cacheBudget;
    readonly stats: {
        commits: number;
        opsCommitted: number;
        commitFailures: number;
        cacheHits: number;
        cacheMisses: number;
        lastError: string | null;
    };
    constructor(dataPath: string, options: {
        keyHex: string | null;
        cacheMB: number;
        durable: boolean;
    });
    get currentSeq(): number;
    put(table: string, key: Buffer, value: Buffer, cleanup?: () => void): void;
    del(table: string, key: Buffer, cleanup?: () => void): void;
    dropTable(table: string): void;
    private enqueue;
    /** Ensures a flush runs this tick even if only metadata changed. */
    schedule(): void;
    hasPending(): boolean;
    private cut;
    /** Leader: appends the batch itself to the replication log (inside the same commit). Returns its LSN or 0. */
    private logBatch;
    private logCommitted;
    /** Starts (leader) or stops (replica) writing the replication log. */
    setLogging(on: boolean, term: number): void;
    get isLogging(): boolean;
    /** Reads the log state from disk (after open or a full sync). */
    loadLogState(base: {
        lsn: number;
        term: number;
    }): void;
    /** Oldest LSN still in the log (0 = empty). */
    firstLsn(): number;
    /** Log entries with LSN > after, up to maxEntries / ~maxBytes. */
    readLog(after: number, maxEntries: number, maxBytes?: number): LogEntry[];
    /** Replica: applies shipped log entries in one atomic commit (and keeps them in its own log). */
    applyEntries(entries: LogEntry[], durable: boolean): void;
    /** Deletes log entries below `lsn` (retention). */
    trimLog(lsn: number): void;
    /** Replica full resync: removes every table (data, indexes, metadata, log). */
    wipe(): void;
    /** Raw table copy for full resync (key/value pairs straight into the store). */
    writeRaw(table: string, entries: Array<[Buffer, Buffer]>): void;
    /** Node-local key/value state (cluster term, vote) — not replicated, not logged. */
    getLocal(key: string): any;
    setLocal(key: string, value: any): void;
    /** Runs `fn` with the replica write guard lifted (applying replicated state). */
    asApplier<T>(fn: () => T): T;
    private flush;
    private commitFailed;
    private markCommitted;
    private lazyDurable;
    /** Resolves once every write made before the call is committed. */
    sync(): Promise<void>;
    /** Commits everything pending now, durably, blocking until done. */
    flushSync(): void;
    close(): void;
    private rotate;
    cacheGet(key: string): StoredDoc | undefined;
    cacheSet(key: string, doc: StoredDoc, packedBytes: number): void;
    cacheDelete(key: string): void;
    cacheInfo(): {
        entries: number;
        bytes: number;
        budgetBytes: number;
    };
    putMeta(key: string, value: any): void;
    deleteMeta(key: string): void;
    unpackValue(buf: Buffer): any;
    readAllMeta(): Array<[string, any]>;
    /** Every entry of a table in key order, one page per native call. */
    scanAll(table: string): IterableIterator<[Buffer, Buffer]>;
    newChunk(): OpWriter;
    writeChunk(ops: OpWriter, durable?: boolean): void;
}
export declare const BULK_OP_PUT = 0;
export declare const BULK_OP_DROP = 2;
export declare function packDoc(doc: StoredDoc): Buffer;
/** A rack's documents on disk, with a Map-like API. */
export declare class DiskDocMap implements DocStore {
    private storage;
    readonly table: string;
    private overlay;
    /** The on-disk table is ignored until this batch commits (right after a clear/drop). */
    private hiddenUntil;
    /**
     * Cache namespace, unique per map instance and renewed on clear(), so a
     * re-created or restored rack never sees cached documents of an old one.
     */
    private uid;
    private count;
    constructor(storage: DiskStorage, table: string, count: number, fresh: boolean);
    private hidden;
    private ck;
    get size(): number;
    /** For bulk loads that wrote documents with writeChunk(). */
    setCount(n: number): void;
    /** Replica: a document changed on disk underneath us — forget any cached copy. */
    invalidate(id: string): void;
    /** Replica: the table was dropped/replaced on disk — forget everything cached. */
    resetLocal(count: number): void;
    get(id: string): StoredDoc | undefined;
    getMany(ids: string[]): Array<StoredDoc | undefined>;
    has(id: string): boolean;
    private write;
    set(id: string, doc: StoredDoc): this;
    add(id: string, doc: StoredDoc): void;
    delete(id: string): boolean;
    clear(): void;
    /**
     * Key-ordered iteration: disk pages merged with uncommitted writes.
     * The overlay is snapshotted at the start, so writes made by the loop
     * body itself are not visited (same as building a list first).
     */
    entries(): IterableIterator<[string, StoredDoc]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<StoredDoc>;
    /** Committed documents with id > `after`, in key order (pagination for bulk exports; ignores the overlay). */
    committedAfter(after: string | null): IterableIterator<[string, StoredDoc]>;
    [Symbol.iterator](): IterableIterator<[string, StoredDoc]>;
}
/**
 * A field index as an ordinary B-tree table whose keys are
 * encodeIndexKey(value) + encodeId(docId) (value: the doc id). Inserts are
 * O(log n) no matter how many documents share a value; equality is a prefix
 * scan and ranges are key ranges.
 */
export declare class DiskIndexStore implements IndexStore {
    private storage;
    readonly table: string;
    /** Uncommitted changes, by encoded index key. */
    private overlay;
    private hiddenUntil;
    private building;
    private chunk;
    private chunkKeys;
    constructor(storage: DiskStorage, table: string, fresh: boolean);
    private hidden;
    private diskIds;
    get(k: IndexKey): ReadonlySet<string>;
    private write;
    add(k: IndexKey, id: string): void;
    remove(k: IndexKey, id: string): void;
    range(type: 'number' | 'string', lo: RangeBound | null, hi: RangeBound | null): ReadonlySet<string>;
    info(): {
        entries: number;
    };
    clear(): void;
    drop(): void;
    /** Bulk (re)build: writes straight to disk in chunks instead of through the overlay. */
    beginBuild(): void;
    private flushChunk;
    endBuild(): void;
    abortBuild(): void;
}
export {};
//# sourceMappingURL=disk-store.d.ts.map