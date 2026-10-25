import { VectorIndexStats } from './services/native-search.service';
import { Cipher } from './storage/encryption';
import { StoredDoc as Document, DiskStorage, LogEntry } from './storage/disk-store';
import { AggState } from './sql/agg-state';
import { RowPredicateSpec } from './sql/executor';
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'array' | 'object';
export type RackType = 'sql' | 'nosql';
export declare const FIELD_TYPES: readonly FieldType[];
export interface FieldSchema {
    type: FieldType;
    required?: boolean;
    defaultValue?: any;
    /** Enforced through an automatically-created unique index. */
    unique?: boolean;
}
export interface RackSchema {
    [fieldName: string]: FieldSchema;
}
export interface IndexInfo {
    field: string;
    type: 'hash' | 'unique' | 'text' | 'vector';
    /** Memory engine: number of distinct indexed values. */
    distinctKeys?: number;
    /** Disk engine: number of index entries (one per indexed value of each document). */
    entries?: number;
    /** Compound indexes: the indexed fields in order. */
    fields?: string[];
}
export interface FindOptions {
    skip?: number;
    limit?: number;
    populate?: boolean;
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
}
export interface QueryResult {
    results: any[];
    total: number;
}
export interface Transaction {
    get(db: string, rack: string, id: string): any | null;
    query(db: string, rack: string, query: string | object, options?: FindOptions): QueryResult;
    insert(db: string, rack: string, data: string | object): string;
    update(db: string, rack: string, id: string, data: string | object): boolean;
    patch(db: string, rack: string, id: string, data: string | object): boolean;
    delete(db: string, rack: string, id: string): boolean;
    commit(): {
        txId: string;
        changes: number;
    };
    rollback(): void;
}
export type StorageEngineKind = 'disk' | 'memory';
export declare class OpenDBSEngine {
    private databases;
    private dataPath;
    private nativeSearch;
    private versionCounter;
    private readonly persistDebounceMs;
    private readonly walFsync;
    private readonly queryCacheEntries;
    private queryCache;
    /** Encrypts snapshots and WAL records at rest (null = plaintext). */
    private readonly cipher;
    /** Disk storage engine; null = in-memory engine with snapshots + WAL. */
    private readonly disk;
    /** Racks whose metadata (count, nextId, schema, indexes) must be written with the next disk batch. */
    private metaDirty;
    private migratedRacks;
    /** Worker threads for parallel scans (disk engine); undefined until first needed. */
    private pool;
    private readonly queryWorkers;
    /** Racks smaller than this are scanned on the main thread (parallelism doesn't pay off). */
    private readonly parallelMinDocs;
    private dirtyWalFds;
    private syncingFds;
    private writeSeq;
    private syncedSeq;
    private syncInFlight;
    private stats;
    constructor(dbPath: string, options?: {
        persistDebounceMs?: number;
        walFsync?: boolean;
        queryCacheEntries?: number;
        quiet?: boolean;
        cipher?: Cipher | null;
        storage?: StorageEngineKind;
        cacheMB?: number;
        queryWorkers?: number;
        parallelMinDocs?: number;
    });
    private nativeFlushTimer;
    /** Persists the native search index to disk. Call on graceful shutdown. */
    flushNativeSearch(): void;
    private getDatabasePath;
    private getRackPath;
    private docTable;
    private indexTable;
    private indexTableSeq;
    /**
     * Every disk index build gets its own table (name recorded in the rack
     * metadata), so rebuilding an index never touches the one still in use
     * until the new one is complete.
     */
    private newIndexStore;
    private loadAll;
    /**
     * `fresh`: a new, empty rack (its disk table is ignored until the current
     * batch commits, in case a dropped rack of the same name is still being
     * removed). `inMemory` forces RAM storage (temporary racks during import).
     */
    private newRack;
    /** Builds an in-memory rack (documents + settings, no indexes) from decoded snapshot data. */
    private rackFromSnapshot;
    /** Racks (and databases) recorded in the disk store's metadata table. */
    private loadFromDiskStore;
    private ensureDatabaseLocal;
    private rackFromMeta;
    /** Copies stored rack settings (counters, schema, indexes) onto a rack object. */
    private applyRackMeta;
    /** The disk store (replication log access for the cluster layer), or null on the memory engine. */
    get replicationStore(): DiskStorage | null;
    /** True on a cluster replica: writes must go to the primary. */
    isReadOnly(): boolean;
    /** Documents in user databases (not the system database) — how much data a node holds. */
    userDocumentCount(): number;
    /**
     * Replica: applies log entries shipped from the primary, then brings the
     * in-memory view (racks, schemas, indexes, caches, search indexes) in line.
     */
    applyReplicated(entries: LogEntry[], durable: boolean): void;
    /** Re-reads one metadata key after replication. Returns the rack if it was (re)created. */
    private refreshFromMeta;
    /** Rebuilds the native text/vector indexes of a rack from its documents (replicas). */
    private backfillNative;
    /** Replica after a full resync: rebuilds the whole in-memory view from the store. */
    reloadFromStore(): void;
    private rackMeta;
    /** Disk engine: appends the metadata of every rack changed this tick to the batch being committed. */
    private writeDirtyMeta;
    /** Disk engine: writes documents straight to the store in chunks (import, restore, duplicate). */
    private bulkLoad;
    /**
     * Disk engine: replaces (or creates) a rack with the contents of an
     * in-memory rack -- used to import .odbs files and to restore backups.
     */
    private importRack;
    /**
     * Memory engine started on a data directory last used by the disk engine:
     * writes every rack back out as an .odbs snapshot, then retires the store file.
     */
    private exportDiskStoreIfPresent;
    private openDiskStorage;
    /**
     * Reads a rack's .odbs snapshot and replays its WAL into an in-memory
     * rack (not registered anywhere). Corrupt files are quarantined (null).
     */
    private readRackFiles;
    private loadRack;
    private serializeRack;
    private closeWal;
    /**
     * Group commit: resolves once every write made before the call is on
     * stable storage. A single fsync per dirty WAL covers all writes that
     * happened since the previous sync, so N concurrent requests cost one
     * fsync instead of N. No-op when WAL_FSYNC is off.
     */
    syncWal(): Promise<void>;
    hasUnsyncedWrites(): boolean;
    /** Rotates the WAL and packs the rack's current state (synchronously, so it is a consistent point-in-time view). */
    private captureSnapshot;
    private deleteWalsBelow;
    private snapshotSync;
    private snapshotAsync;
    private scheduleSnapshot;
    /**
     * Durably records a write *before* it is applied in memory, so a failed
     * disk write surfaces as a failed request instead of an acknowledged
     * write that is silently lost.
     */
    private logWrite;
    /** Call after an in-memory mutation has been applied. */
    private touched;
    /** Index/schema changes are rare and must not depend on WAL replay. */
    private metaChanged;
    private dropRackState;
    /** Synchronously snapshots every rack with pending writes. Safe to call any time (e.g. before a backup). */
    flushAll(): void;
    /** Flushes everything and releases file handles. Call on graceful shutdown. */
    close(): void;
    /**
     * Detaches all in-memory state from disk so external code (backup
     * restore) can replace files safely; follow with reloadFromDisk().
     */
    suspendForRestore(): void;
    /**
     * Throws unless `content` is a rack file this server can read (right
     * encryption key, intact). Used to vet backups before restoring them.
     */
    verifySnapshot(content: Buffer): void;
    reloadFromDisk(): void;
    private indexKeys;
    /**
     * Keys a document contributes to an index. Compound indexes use one key
     * per document: the JSON tuple of its field values (all must be scalars).
     */
    private keysFor;
    private addToIndexes;
    private removeFromIndexes;
    /**
     * Builds an index over the rack's current documents. On the disk engine
     * this replaces any stored index of the same name and is written in
     * chunks, so it works on racks far larger than RAM.
     */
    private buildIndex;
    /** Releases an index's storage after it has been removed from a rack. */
    private dropIndex;
    /**
     * Throws if `data` would violate a unique index. `batch` tracks keys
     * claimed earlier in the same insertMany so in-batch duplicates are
     * caught before anything is written.
     */
    private checkUnique;
    private requireRack;
    private getRackObj;
    createDatabase(name: string): boolean;
    createRack(database: string, rack: string, type?: RackType, schema?: RackSchema): boolean;
    /** Validates a schema definition and returns a copy with only known properties. */
    private normalizeSchema;
    private normalizeColumn;
    /** null when `value` matches `type`, otherwise a human-readable reason. */
    private static typeError;
    getRackSchema(database: string, rack: string): {
        type: RackType;
        schema: RackSchema | null;
    };
    /**
     * ALTER TABLE ADD COLUMN. Existing rows get the default value (if any);
     * a required column without a default can only be added to an empty rack.
     */
    addColumn(database: string, rack: string, column: string, def: any): boolean;
    /** Converts an existing value to a new column type, or throws if it can't be represented. */
    private static convertValue;
    /**
     * ALTER TABLE MODIFY / RENAME COLUMN. `changes.name` renames; type changes
     * convert existing values (the whole change is refused if any row can't
     * be converted); required/unique/defaultValue are validated against the
     * existing data before anything is written.
     */
    alterColumn(database: string, rack: string, column: string, changes: {
        name?: string;
        type?: FieldType;
        required?: boolean;
        unique?: boolean;
        defaultValue?: any;
    }): boolean;
    /** ALTER TABLE DROP COLUMN: removes the column, its data and any index on it. */
    dropColumn(database: string, rack: string, column: string): boolean;
    /** Applies `fn` to every document's data (null = unchanged) as one WAL batch. */
    private rewriteAll;
    getRackType(database: string, rack: string): RackType | null;
    /** Changes whenever the rack is written to; -1 if it doesn't exist. Lets callers cache derived views. */
    getRackVersion(database: string, rack: string): number;
    /**
     * Applies defaults and checks types. `strict` (SQL racks) additionally
     * rejects fields that aren't declared columns.
     */
    private validateSchema;
    duplicateRack(sourceDb: string, sourceRack: string, targetDb: string, targetRack: string): boolean;
    /**
     * `field` may be one field or several (compound index, e.g. ['city', 'age']).
     * A compound index answers queries with equality on all of its fields and
     * can enforce uniqueness of the combination.
     */
    createIndex(database: string, rack: string, field: string | string[], options?: {
        unique?: boolean;
    }): boolean;
    getIndexes(database: string, rack: string): string[];
    getIndexDetails(database: string, rack: string): IndexInfo[];
    deleteIndex(database: string, rack: string, field: string): boolean;
    /** Applies the current value of every text/vector-indexed field on a
     * document to the native search index (add/update), and removes the
     * field's entry when it's absent or the wrong type. Used uniformly by
     * insert/update/patch so the native index always reflects the
     * document's current data regardless of which write path touched it. */
    private syncNativeIndexes;
    private removeFromNativeIndexes;
    /** Marks a field as full-text/fuzzy indexed and backfills any existing
     * documents into the native trigram index. Mirrors createIndex()'s
     * opt-in-per-field pattern for exact-match indices. */
    createTextIndex(database: string, rack: string, field: string): boolean;
    getTextIndexes(database: string, rack: string): string[];
    deleteTextIndex(database: string, rack: string, field: string): boolean;
    /** Marks a field as vector-indexed and backfills any existing documents
     * (via the batched native insert path, since this can be a large
     * one-time operation on an already-populated rack). */
    createVectorIndex(database: string, rack: string, field: string): boolean;
    getVectorIndexes(database: string, rack: string): string[];
    deleteVectorIndex(database: string, rack: string, field: string): boolean;
    getVectorIndexStats(database: string, rack: string, field: string): VectorIndexStats | null;
    rebuildVectorIndex(database: string, rack: string, field: string): void;
    private parseDocumentInput;
    private assertValid;
    /**
     * `operationType` is accepted for API compatibility. SQL racks take writes
     * from any interface (REST, SQL, admin panel); what makes them SQL is that
     * every write is checked strictly against the declared columns.
     */
    insert(database: string, rack: string, data: string | object, operationType?: 'sql' | 'nosql'): string;
    insertMany(database: string, rack: string, dataItems: any[]): string[];
    /**
     * Sharding: stores documents under ids chosen by the shard router (which
     * keeps them unique across all shards). `replace` overwrites existing
     * documents (used when moving data between shards).
     */
    insertWithIds(database: string, rack: string, docs: Array<{
        id: string;
        data: any;
        createdAt?: string;
        updatedAt?: string;
    }>, replace?: boolean): string[];
    /** Deletes many documents by id; returns how many existed. */
    deleteMany(database: string, rack: string, ids: string[]): number;
    /**
     * Sharding (rebalance): documents whose numeric id falls in one of the
     * given buckets (id mod `buckets`), after `after`, at most `limit`.
     */
    documentsInBuckets(database: string, rack: string, bucketSet: Set<number>, bucketCount: number, after: string | null, limit: number): {
        docs: Document[];
        last: string | null;
        done: boolean;
    };
    /**
     * Partial (unfinished) GROUP BY states for a rack — the shard side of a
     * distributed aggregation; the router merges states from every shard.
     */
    aggregatePartial(database: string, rack: string, query: object, groups: string[], aggs: Array<{
        name: string;
        field: string | null;
    }>, sqlWhere?: RowPredicateSpec): Promise<Array<{
        key: any[];
        states: AggState[];
    }>>;
    clearRack(database: string, rack: string): boolean;
    deleteRack(database: string, rack: string): boolean;
    deleteDatabase(database: string): boolean;
    update(database: string, rack: string, id: string, data: string | object): boolean;
    patch(database: string, rack: string, id: string, partialData: string | object): boolean;
    private replaceDocument;
    delete(database: string, rack: string, id: string): boolean;
    private txSeq;
    private journalFd;
    private journalPath;
    private journalAppend;
    /**
     * Crash recovery for transactions: a transaction is journaled (and
     * fsynced) before it touches any rack, and marked done afterwards. Any
     * journaled transaction without a done marker is re-applied here.
     * Puts and deletes are idempotent, so re-applying is always safe.
     */
    private recoverTransactions;
    /**
     * Starts a multi-rack (and multi-database) transaction. Reads see the
     * transaction's own uncommitted changes; nothing is visible to anyone
     * else until commit(), which applies everything or nothing.
     *
     * Isolation: optimistic. If another write changed a rack this
     * transaction touched between its first read/write and commit(),
     * commit() fails with a conflict and the caller may retry.
     */
    beginTransaction(): Transaction;
    private materialize;
    /** O(1) primary-key lookup. */
    getDocument(database: string, rack: string, id: string, populate?: boolean): any | null;
    private static isPrimitiveKey;
    private static union;
    private static intersect;
    /** Candidate ids for one field condition using an index, or null if the index can't serve it. */
    private indexCandidates;
    /**
     * Query planner: returns a superset of matching ids drawn from indexes
     * (primary key, hash, range), or null when a full scan is required.
     * The compiled matcher still runs on every candidate, so the planner
     * only has to be conservative, never exact.
     */
    private plan;
    /**
     * The exact set of matching ids when every condition is an equality or
     * $in on primitives over a single-field index (or on id) -- the index
     * then has exactly the matcher's semantics (value equal, or array
     * containing it). null for anything else (ranges, compound indexes,
     * operators, unindexed fields).
     */
    private exactPlan;
    /** Natural order: numeric ids ascending (typed-array sort), then any others. */
    private static sortIds;
    private sortValue;
    /**
     * Documents to run the matcher over: index candidates in natural (id)
     * order, fetched in batches, or the whole rack in one sequential scan.
     */
    private scanSource;
    private execute;
    private storeCache;
    /**
     * Object-returning query API (preferred). Returns the requested page and
     * the total number of matches.
     */
    query(database: string, rack: string, query: string | object, options?: FindOptions): QueryResult;
    private queryPool;
    /** Key ranges covering a rack's documents (by id), one task each. */
    private scanChunks;
    private parallelRack;
    /**
     * Same as query(), but a full scan of a large rack is split across the
     * worker threads (all CPU cores). Index-served and small queries run
     * here directly. Results reflect all writes acknowledged before the call.
     */
    queryAsync(database: string, rack: string, query: string | object, options?: FindOptions): Promise<QueryResult>;
    /**
     * GROUP BY over a large rack, computed in parallel: each worker builds
     * partial aggregates for its key range; they are merged here. Returns
     * null when not applicable (the caller then aggregates itself).
     * groups: field paths ("id" = numeric id); aggs: mergeable aggregates (field null = *).
     */
    aggregateParallel(database: string, rack: string, query: object, groups: string[], aggs: Array<{
        name: string;
        field: string | null;
    }>, 
    /** SQL WHERE the workers evaluate exactly (when `query` is only a coarse pre-filter). */
    sqlWhere?: RowPredicateSpec): Promise<Array<{
        key: any[];
        values: any[];
    }> | null>;
    /** A worker problem must never fail a query: stop using the pool and carry on single-threaded. */
    private workerFailed;
    /** Parallel query workers (disk engine). */
    parallelInfo(): {
        tasks: number;
        parallelQueries: number;
        failures: number;
        workers: number;
        enabled: boolean;
        minDocs: number;
    };
    /**
     * Aggregation pipeline. A leading $match runs through the query planner
     * (indexes, cache); $lookup fetches only the referenced documents of the
     * other rack via an $in query (index-backed when that field is indexed).
     */
    aggregate(database: string, rack: string, pipeline: any[], source?: {
        query(db: string, rack: string, q: object): QueryResult;
    }): any[];
    count(database: string, rack: string, query?: string | object): number;
    /** Legacy string API -- each result is a JSON string. Prefer query(). */
    find(database: string, rack: string, query: string, options?: FindOptions): string[];
    fuzzySearch(database: string, rack: string, field: string, query: string, threshold: number): string[];
    getDatabases(): string[];
    getStats(): string;
    /** Operational metrics for the admin panel. */
    getEngineStats(): {
        databases: number;
        racks: number;
        documents: number;
        indexes: number;
        nativeSearch: boolean;
        encryption: {
            enabled: boolean;
            algorithm: string | null;
            keyFingerprint: string | null;
        };
        transactions: number;
        fsyncs: number;
        queryCache: {
            capacity: number;
            entries: number;
            hits: number;
            misses: number;
            hitRate: number;
        };
        planner: {
            indexedQueries: number;
            fullScans: number;
        };
        storage: {
            engine: StorageEngineKind;
            file: string;
            fileBytes: number;
            encryption: string | null;
            cache: {
                hits: number;
                misses: number;
                hitRate: number;
                entries: number;
                bytes: number;
                budgetBytes: number;
            };
            commits: number;
            opsCommitted: number;
            commitFailures: number;
            lastError: string | null;
            pending: boolean;
        } | {
            engine: StorageEngineKind;
            file: null;
            fileBytes: number;
            encryption: string | null;
            cache?: undefined;
            commits?: undefined;
            opsCommitted?: undefined;
            commitFailures?: undefined;
            lastError?: undefined;
            pending?: undefined;
        };
        parallel: {
            tasks: number;
            parallelQueries: number;
            failures: number;
            workers: number;
            enabled: boolean;
            minDocs: number;
        };
        persistence: {
            mode: string;
            walFsync: boolean;
            debounceMs: number;
            dirtyRacks: number;
            pendingWalEntries: number;
            walWrites: number;
            snapshots: number;
            snapshotFailures: number;
            lastSnapshotAt: string | null;
            lastSnapshotMs: number;
            walRecordsReplayed: number;
        };
        startedAt: string;
    };
    /** Which storage engine is active and how much it holds on disk / in RAM. */
    storageInfo(): {
        engine: StorageEngineKind;
        file: string;
        fileBytes: number;
        encryption: string | null;
        cache: {
            hits: number;
            misses: number;
            hitRate: number;
            entries: number;
            bytes: number;
            budgetBytes: number;
        };
        commits: number;
        opsCommitted: number;
        commitFailures: number;
        lastError: string | null;
        pending: boolean;
    } | {
        engine: StorageEngineKind;
        file: null;
        fileBytes: number;
        encryption: string | null;
        cache?: undefined;
        commits?: undefined;
        opsCommitted?: undefined;
        commitFailures?: undefined;
        lastError?: undefined;
        pending?: undefined;
    };
    /**
     * Backup hook: every rack of a database as an .odbs snapshot (the
     * portable backup format, encrypted with the data key), one rack in
     * memory at a time.
     */
    exportDatabase(database: string): Array<{
        fileName: string;
        content: Buffer;
    }>;
    /** True when racks live in the disk store (restore goes through restoreDatabase, not files). */
    usesDiskStorage(): boolean;
    /**
     * Disk engine restore: replaces racks with the given .odbs snapshots.
     * `replace` also removes racks of the database that the backup lacks.
     */
    restoreDatabase(database: string, files: Array<{
        fileName: string;
        content: Buffer;
    }>, replace: boolean): {
        count: number;
        removed: number;
    };
    getDatabaseRacks(database: string): {
        name: string;
        type: RackType;
        count: number;
        schema?: RackSchema;
        createdAt: string;
    }[];
    getRackCount(database: string, rack: string): number;
    vectorSearch(database: string, rack: string, vectorField: string, queryVector: number[], k?: number): string[];
    private calculateCosineSimilarity;
    private calculateSimilarity;
    getDatabaseStats(database: string): {
        totalRacks: number;
        totalDocuments: number;
        racks: Array<{
            name: string;
            type: string;
            count: number;
            indexCount: number;
        }>;
    };
}
//# sourceMappingURL=engine.d.ts.map