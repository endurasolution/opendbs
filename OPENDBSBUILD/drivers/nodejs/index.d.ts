export interface OpenDBSOptions {
    /** One server, or several cluster members (array or comma-separated) to fail over between. */
    url: string | string[];
    apiKey?: string;
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
    login(): Promise<any>;
    request(method: string, path: string, body?: any): Promise<any>;
    version(): Promise<{ name: string; version: string; builtAt: string | null; commit: string | null }>;
    me(): Promise<any>;
    listDatabases(): Promise<string[]>;
    createDatabase(name: string): Promise<any>;
    dropDatabase(name: string): Promise<any>;
    database(name: string): Database;
    transaction(ops: TxOperation[] | ((tx: TxBuilder) => void | Promise<void>)): Promise<{ committed: true; txId: string; changes: number; results: Array<{ op: string; rack: string; id: string }> }>;
}

export default OpenDBS;
