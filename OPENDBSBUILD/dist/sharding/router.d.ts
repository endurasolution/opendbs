import { FastifyInstance } from 'fastify';
import { OpenDBSEngine } from '../engine';
import { AuthService } from '../services/auth.service';
import { RowPredicateSpec } from '../sql/executor';
/**
 * Sharding: one rack spread over several OpenDBS servers.
 *
 * This server is the router. Other servers (each may itself be a replicated
 * cluster) are registered as shards; "local" is this server's own storage.
 * A sharded rack hashes its shard key into 4096 buckets; each bucket lives
 * on one shard. Document ids are seq × 4096 + bucket, so an id alone tells
 * which shard holds the document. Queries go to every shard (or only the
 * ones the shard key points at) and the results are merged in the same
 * order a single server would return; GROUP BY runs as partial aggregates
 * on every shard (each using all its cores) merged here.
 */
export declare const BUCKETS = 4096;
export declare const LOCAL = "local";
/** Marks router→shard traffic (exempts it from the rate limit when sent with a valid admin/access key). */
export declare const SHARD_HEADER = "x-opendbs-shard-request";
export declare function bucketOf(value: unknown): number;
export interface RackDef {
    id: string;
    database: string;
    rack: string;
    /** Field path, or "id" (documents spread evenly). */
    key: string;
    type: 'sql' | 'nosql';
    /** Shard names; buckets[b] is an index into this list. */
    shards: string[];
    buckets: number[];
    nextSeq: number;
    /**
     * rebalancing: buckets are being copied (writes paused); cleaning: some
     * shards may still hold copies of buckets they don't own (reads filter
     * by ownership until the cleanup finishes).
     */
    state: 'active' | 'rebalancing' | 'cleaning';
    createdAt: string;
}
interface ShardResponse {
    status: number;
    data: any;
}
export declare class ShardRouter {
    private engine;
    private auth;
    private shards;
    private shardDefs;
    private racks;
    private loadedVersion;
    private fastify;
    private idBlocks;
    /** Writes running per rack, and racks whose writes are paused (rebalance). */
    private inflight;
    private pausing;
    /** Racks this process is rebalancing or cleaning up. */
    private busy;
    readonly stats: {
        routed: number;
        scattered: number;
        rebalances: number;
    };
    constructor(engine: OpenDBSEngine, auth: AuthService);
    private refresh;
    rackDef(database: string, rack: string): RackDef | null;
    isSharded(database: string, rack: string): boolean;
    private shard;
    private shardOfBucket;
    private shardOfId;
    /** Shards that can hold matches for a query (all, unless the shard key or id narrows it). */
    private targets;
    /** Saves only the given fields (never a stale nextSeq). */
    private saveRack;
    /** Buckets a shard owns under the current map. */
    private ownedBy;
    /** Reserves sequence numbers for new ids (in blocks, persisted so a new primary never reuses them). */
    private allocSeq;
    /** Runs a write unless the rack is being rebalanced; a rebalance waits for running writes to finish. */
    private writing;
    insert(def: RackDef, docs: any[]): Promise<string[]>;
    private insertNow;
    get(def: RackDef, id: string, populate: boolean): Promise<ShardResponse>;
    private checkKeyUnchanged;
    /** PUT (replace) or PATCH (merge). PUT of a missing id inserts a new document unless `upsert` is false. */
    modify(def: RackDef, method: 'PUT' | 'PATCH', id: string, data: any, upsert?: boolean): Promise<ShardResponse>;
    private modifyNow;
    remove(def: RackDef, id: string): Promise<ShardResponse>;
    sqlGet(def: RackDef, id: string): Promise<any | null>;
    sqlInsert(def: RackDef, data: object): Promise<string>;
    sqlWrite(def: RackDef, method: 'PUT' | 'PATCH' | 'DELETE', id: string, data?: object): Promise<boolean>;
    /** Schema / index change applied on every shard of the rack (sub: path below the rack, e.g. "/indexes"). */
    ddl(def: RackDef, method: string, sub: string, body?: unknown): Promise<any>;
    /** Scatter-gather query, merged in single-server order (sort field, missing last, then id). */
    query(def: RackDef, query: any, opts?: {
        skip?: number;
        limit?: number;
        sort?: {
            field: string;
            order: 'asc' | 'desc';
        };
        populate?: boolean;
    }): Promise<{
        results: any[];
        total: number;
    }>;
    count(def: RackDef, query: any): Promise<number>;
    /** Distributed GROUP BY: partial states from every shard, merged and finished here. */
    aggregate(def: RackDef, query: object, groups: string[], aggs: Array<{
        name: string;
        field: string | null;
    }>, where?: RowPredicateSpec): Promise<Array<{
        key: any[];
        values: any[];
    }>>;
    /** Aggregation pipeline: a leading $match runs on the shards; the rest here. */
    pipeline(def: RackDef, pipeline: any[]): Promise<any[]>;
    /** Sends the same request to every shard of the rack (schema, index and clear operations). */
    broadcast(def: RackDef, method: string, path: string, body?: unknown): Promise<ShardResponse>;
    listShards(): ({
        name: string;
        urls: string[];
        local: boolean;
        addedAt: string;
    } | {
        name: string;
        urls: string[];
        local: boolean;
    })[];
    addShard(input: {
        name?: unknown;
        urls?: unknown;
        apiKey?: unknown;
    }): Promise<{
        name: string;
        urls: string[];
        version: string | null;
    }>;
    /** Checks that the shard answers and accepts the key (an authenticated request); returns its version. */
    private probe;
    testShard(name: string): Promise<{
        name: string;
        ok: boolean;
        version: string | null;
        ms: number;
    }>;
    removeShard(name: string): void;
    private ensureRackOn;
    /** Creates a new (empty) sharded rack on the given shards. */
    createRack(input: {
        database?: unknown;
        rack?: unknown;
        type?: unknown;
        schema?: unknown;
        key?: unknown;
        shards?: unknown;
    }): Promise<{
        warnings: string[];
        database: string;
        rack: string;
        key: string;
        type: string;
        shards: string[];
        buckets: number[];
        nextSeq: number;
        state: "active";
        createdAt: string;
    }>;
    /** Stops sharding a rack and deletes its data on every shard. */
    dropRack(def: RackDef): Promise<ShardResponse>;
    rackStats(def: RackDef): Promise<{
        database: string;
        rack: string;
        key: string;
        state: "active" | "rebalancing" | "cleaning";
        shards: ({
            shard: string;
            buckets: number;
            documents: any;
            error?: undefined;
        } | {
            shard: string;
            buckets: number;
            documents: null;
            error: any;
        })[];
        documents: number;
    }>;
    /**
     * Moves buckets so the rack is spread evenly over `shards` (add or remove
     * shards). Writes to the rack pause (503, retried by the drivers) while
     * documents are copied; reads keep working throughout.
     */
    rebalance(def: RackDef, shards: string[]): Promise<{
        moved: number;
        removedFromOldShards: number;
        buckets: {
            [k: string]: number;
        };
    }>;
    /**
     * Deletes, on each listed shard, the documents of buckets it doesn't own
     * under the current map; then the rack is active again.
     */
    private cleanup;
    /** Partial GROUP BY over the documents of the given buckets only (shard side, while buckets move). */
    private partialOwned;
    /** Finishes rebalances interrupted by a crash or failover (run on the primary). */
    private recover;
    /** Shard-side endpoints (every server) + routing of requests for sharded racks (router). */
    register(fastify: FastifyInstance): void;
    private dispatch;
    /** SQL data source support. */
    info(): {
        shards: ({
            name: string;
            urls: string[];
            local: boolean;
            addedAt: string;
        } | {
            name: string;
            urls: string[];
            local: boolean;
        })[];
        racks: {
            database: string;
            rack: string;
            key: string;
            type: "nosql" | "sql";
            state: "active" | "rebalancing" | "cleaning";
            shards: string[];
            buckets: {
                [k: string]: number;
            };
        }[];
        stats: {
            routed: number;
            scattered: number;
            rebalances: number;
        };
    };
}
/** Parses the GET …/documents query string (same rules as the unsharded route). */
export declare function parseListQuery(queryParams: Record<string, any>): {
    query: Record<string, any>;
    skip: number;
    limit?: number;
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
    populate: boolean;
    error?: string;
};
export {};
//# sourceMappingURL=router.d.ts.map