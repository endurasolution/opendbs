export interface OpenDBSOptions {
    /** One server, or several cluster members (array or comma-separated) to fail over between. */
    url?: string | string[];
    /** Same as `url` (the option name used by the 1.0.0 client). */
    baseURL?: string;
    apiKey?: string;
    /** An existing session token. */
    token?: string;
    username?: string;
    password?: string;
    /** 6-digit code when the account uses two-factor authentication. */
    totp?: string;
    timeoutMs?: number;
    /** How long to keep trying other members when one is down (default 20000 ms, covers an election). */
    failoverMs?: number;
}

export interface FindOptions {
    skip?: number;
    limit?: number;
    sort?: { field: string; order?: 'asc' | 'desc' };
    populate?: boolean;
}

export interface FindResult<T = Record<string, any>> {
    results: Array<T & { id: string }>;
    count: number;
    total: number;
}

export interface SqlResult {
    success: boolean;
    result: any;
    rowCount: number;
    total?: number;
    columns?: string[];
    results: Array<{ statement: string; result: any; rowCount: number; total?: number; columns?: string[]; ms: number }>;
}

export type ColumnType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'array' | 'object';
export interface ColumnDef { type: ColumnType; required?: boolean; unique?: boolean; defaultValue?: any }

export interface TxBuilder {
    /** Returns a reference ("$N.id") usable in later operations' data. */
    insert(database: string, rack: string, data: object): string;
    update(database: string, rack: string, id: string, data: object): string;
    patch(database: string, rack: string, id: string, data: object): string;
    delete(database: string, rack: string, id: string): string;
}

export type TxOperation =
    | { op: 'insert'; database: string; rack: string; data: object }
    | { op: 'update' | 'patch'; database: string; rack: string; id: string; data: object }
    | { op: 'delete'; database: string; rack: string; id: string };

export class OpenDBSError extends Error {
    status: number;
    body: any;
}

export class Rack<T = Record<string, any>> {
    readonly name: string;
    insert(doc: T): Promise<string>;
    insertMany(docs: T[]): Promise<string[]>;
    find(query?: object, options?: FindOptions): Promise<FindResult<T>>;
    findOne(query?: object): Promise<(T & { id: string }) | null>;
    count(query?: object): Promise<number>;
    get(id: string): Promise<(T & { id: string }) | null>;
    update(id: string, doc: T): Promise<any>;
    patch(id: string, fields: Partial<T>): Promise<any>;
    delete(id: string): Promise<any>;
    clear(): Promise<any>;
    aggregate(pipeline: object[]): Promise<any[]>;
    createIndex(fields: string | string[], options?: { unique?: boolean }): Promise<any>;
    dropIndex(name: string | string[]): Promise<any>;
    indexes(): Promise<Array<{ field: string; type: string; fields?: string[]; distinctKeys?: number }>>;
    fuzzySearch(field: string, query: string, threshold?: number): Promise<{ results: any[]; count: number }>;
    vectorSearch(field: string, vector: number[], k?: number): Promise<{ results: any[]; count: number }>;
}

export class Database {
    readonly name: string;
    listRacks(): Promise<Array<{ name: string; type: 'sql' | 'nosql'; count: number }>>;
    createRack(name: string): Promise<any>;
    createTable(name: string, schema: Record<string, ColumnDef>): Promise<any>;
    dropRack(name: string): Promise<any>;
    rack<T = Record<string, any>>(name: string): Rack<T>;
    table<T = Record<string, any>>(name: string): Rack<T>;
    /** `params` fill ? / $1 placeholders (safe for user input). */
    sql(query: string, params?: unknown[]): Promise<SqlResult>;
    stats(): Promise<any>;
}

export class OpenDBS {
    constructor(options: OpenDBSOptions);
    /** Signs in with the constructor's credentials, or with the ones given here (kept for automatic re-login). */
    login(username?: string, password?: string, totp?: string): Promise<{ token: string; user: any }>;
    setToken(token: string): void;
    request(method: string, path: string, body?: any): Promise<any>;
    version(): Promise<{ name: string; version: string; builtAt: string | null; commit: string | null }>;
    me(): Promise<any>;
    listDatabases(includeRacks?: boolean): Promise<any[]>;
    createDatabase(name: string): Promise<any>;
    dropDatabase(name: string): Promise<any>;
    database(name: string): Database;
    transaction(ops: TxOperation[] | ((tx: TxBuilder) => void | Promise<void>)): Promise<{ committed: true; txId: string; changes: number; results: Array<{ op: string; rack: string; id: string }> }>;

    // 1.0.0 API: database and rack passed as arguments
    register(userData: object): Promise<any>;
    regenerateApiKey(): Promise<{ apiKey: string }>;
    deleteDatabase(name: string): Promise<any>;
    listRacks(database: string): Promise<Array<{ name: string; type: 'sql' | 'nosql'; count: number }>>;
    createRack(database: string, config: { name: string; type?: 'sql' | 'nosql'; schema?: Record<string, ColumnDef> }): Promise<any>;
    deleteRack(database: string, rack: string): Promise<any>;
    clearRack(database: string, rack: string): Promise<any>;
    insert(database: string, rack: string, document: object | object[]): Promise<any>;
    find(database: string, rack: string, query?: Record<string, string | number | boolean>, options?: { populate?: boolean }): Promise<any[]>;
    findOne(database: string, rack: string, id: string, options?: { populate?: boolean }): Promise<any>;
    update(database: string, rack: string, id: string, updates: object): Promise<any>;
    delete(database: string, rack: string, id: string): Promise<any>;
    sql(database: string, query: string, params?: unknown[]): Promise<any>;
    getSqlCredentials(): Promise<any>;
    search(database: string, rack: string, queryBody: { query: object; limit?: number; skip?: number; sort?: FindOptions['sort'] }): Promise<any[]>;
    fuzzySearch(database: string, rack: string, field: string, query: string): Promise<any[]>;
    vectorSearch(database: string, rack: string, field: string, vector: number[], k?: number): Promise<any[]>;
    rangeSearch(database: string, rack: string, field: string, min: number, max: number): Promise<any[]>;
    patternSearch(database: string, rack: string, field: string, pattern: string): Promise<any[]>;
    createBackup(): Promise<any>;
    listBackups(): Promise<string[]>;
    restoreBackup(backupName: string): Promise<any>;
    quickBackupRack(database: string, rack: string): Promise<any>;
}

export default OpenDBS;
