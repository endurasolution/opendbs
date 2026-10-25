import { OpenDBSEngine, QueryResult, FindOptions } from '../engine';
import { Statement, SQLPermission } from '../sql/parser';
import { DataSource } from '../sql/executor';
import type { ShardRouter } from '../sharding/router';
type MaybeAsync<T> = T | Promise<T>;
/** What statements read and write through: the engine directly, an open transaction, or the shard router. */
export interface DataApi {
    query(db: string, rack: string, q: object, options?: FindOptions): MaybeAsync<QueryResult>;
    get(db: string, rack: string, id: string): MaybeAsync<any | null>;
    insert(db: string, rack: string, data: object): MaybeAsync<string>;
    update(db: string, rack: string, id: string, data: object): MaybeAsync<boolean>;
    patch(db: string, rack: string, id: string, data: object): MaybeAsync<boolean>;
    delete(db: string, rack: string, id: string): MaybeAsync<boolean>;
    /** Optional bulk insert (sharded tables: one request per shard instead of one per row); null = not available. */
    insertMany?(db: string, rack: string, docs: object[]): Promise<string[]> | null;
}
export type { SQLPermission } from '../sql/parser';
/** Highest permission needed by any statement in `query` (throws on syntax errors). */
export declare function requiredSQLPermission(query: string): SQLPermission;
export interface StatementResult {
    statement: Statement['type'];
    /** Rows for SELECT/SHOW/DESCRIBE/RETURNING, a status object otherwise. */
    result: any;
    rowCount: number;
    /** SELECT: matches before LIMIT/OFFSET. */
    total?: number;
    columns?: string[];
    truncated?: boolean;
    ms: number;
}
export interface SQLCredentials {
    userId: string;
    username: string;
    password: string;
    host: string;
    port: number;
    createdAt: Date;
}
/**
 * Engine-backed data source for the SQL executor (reads go through `api`, so
 * transactions see their own writes). Outside transactions, large full scans
 * and GROUP BYs run on the parallel query workers.
 */
export declare function engineDataSource(engine: OpenDBSEngine, db: string, api: DataApi, parallel?: boolean, router?: ShardRouter | null): DataSource;
export declare class SQLBridgeService {
    private engine;
    private pool?;
    private sqlCredentials;
    private router;
    constructor(engine: OpenDBSEngine, mysqlConfig?: {
        host: string;
        port: number;
        user: string;
        password: string;
        database?: string;
    });
    generateSQLCredentials(userId: string, username: string): SQLCredentials;
    getSQLCredentials(userId: string): SQLCredentials | undefined;
    /** Backwards-compatible: runs every statement and returns the last statement's result. */
    executeSQL(query: string, database: string, params?: any[]): Promise<any>;
    /**
     * Runs `;`-separated statements in order; stops at the first error.
     * `params` fill ? / $1 placeholders (values are never parsed as SQL).
     *
     * Transactions: BEGIN … COMMIT makes every statement in between
     * all-or-nothing (ROLLBACK or any error discards them). Outside an
     * explicit transaction each INSERT/UPDATE/DELETE is still atomic on its
     * own — a multi-row UPDATE never stops halfway.
     */
    executeScript(query: string, database: string, params?: any[]): Promise<StatementResult[]>;
    private requireTable;
    private ctx;
    /** Sharding: lets SQL read and write sharded tables (set once at startup). */
    setShardRouter(router: ShardRouter): void;
    private sharded;
    private static toObjects;
    private execute;
    private insert;
    private returning;
    private createAs;
    /** Maps SQL values onto declared column types (1/0 → boolean, '42' → 42, JSON text → object). */
    private coerceRow;
    private generateSecurePassword;
    close(): Promise<void>;
}
//# sourceMappingURL=sql-bridge.service.d.ts.map