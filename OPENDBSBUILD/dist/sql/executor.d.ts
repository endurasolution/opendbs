import { Expr, Query, Select, SelectItem } from './ast';
import { FnContext, compare, sqlEquals, truth } from './functions';
/**
 * SQL query executor.
 *
 * A query is compiled once into a tree of async plans; expressions become
 * plain closures. Rows inside a SELECT are objects keyed by table alias
 * ({ c: customerDoc, o: orderDoc }). WHERE conditions on a single table are
 * translated into the engine's query language and pushed into that table's
 * scan (so indexes are used); the translation is always a superset of the
 * SQL result and every row is re-checked, except where it is exact — then
 * ORDER BY / LIMIT / COUNT(*) are pushed down too.
 */
export interface TableInfo {
    name: string;
    type: 'sql' | 'nosql';
    /** Known columns (SQL schema) or columns seen in a sample (NoSQL). Always includes id. */
    columns: string[];
    /** True when columns is the complete, enforced schema. */
    known: boolean;
    /** Declared column types (SQL racks). */
    types: Record<string, string>;
    /** Declared NOT NULL columns. */
    required: Set<string>;
}
export interface ScanOptions {
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
    skip?: number;
    limit?: number;
    /** Only the number of matches is needed. */
    countOnly?: boolean;
}
export interface DataSource {
    describe(table: string): Promise<TableInfo | null>;
    scan(table: string, query: object, options?: ScanOptions): Promise<{
        docs: any[];
        total: number;
    }>;
    /**
     * Optional: GROUP BY with mergeable aggregates computed by the storage
     * layer (in parallel). groups/fields are field paths; null = not done here.
     */
    aggregate?(table: string, query: object, groups: string[], aggs: Array<{
        name: string;
        field: string | null;
    }>, where?: RowPredicateSpec): Promise<Array<{
        key: any[];
        values: any[];
    }> | null>;
}
export interface Relation {
    columns: string[];
    rows: any[][];
    /** Rows before LIMIT/OFFSET (top-level SELECT). */
    total?: number;
    /** Columns holding document ids (numbers inside SQL, returned as the API's string ids). */
    idColumns?: number[];
}
export interface ExecContext {
    ds: DataSource;
    db: string;
    params: any[];
    maxRows: number;
}
type Row = Record<string | symbol, any>;
interface Env {
    ctx: ExecContext;
    params: any[];
    outer: Row[];
    now: Date;
    fn: FnContext;
    /** Uncorrelated subquery results (per execution of the enclosing query). */
    sqCache: Map<SubDef, any>;
    /** Materialized CTEs. */
    ctes: Map<CteDef, Promise<Relation>>;
    /** Recursive CTE working tables. */
    working: Map<CteDef, Relation>;
}
interface SubDef {
    kind: 'scalar' | 'in' | 'exists' | 'list';
    plan: QueryPlan;
    correlated: boolean;
}
interface CteDef {
    name: string;
    cols?: string[];
    plan?: QueryPlan;
    recursive?: {
        anchor: QueryPlan;
        step: QueryPlan;
        all: boolean;
    };
    columns: string[];
}
declare class Catalog {
    readonly tables: Map<string, TableInfo | null>;
    readonly ctx: ExecContext;
    constructor(tables: Map<string, TableInfo | null>, ctx: ExecContext);
}
/** Every table name mentioned anywhere in the statement (CTE names included; they resolve to null). */
export declare function collectTables(node: any, out?: Set<string>): Set<string>;
export declare function loadCatalog(ctx: ExecContext, names: Iterable<string>): Promise<Catalog>;
export interface QueryPlan {
    columns: string[];
    correlated: boolean;
    run(env: Env): Promise<Relation>;
    explain(): any[];
}
export interface CompiledQuery {
    plan: QueryPlan;
    run(): Promise<Relation>;
}
export declare function prepareQuery(q: Query, ctx: ExecContext): Promise<CompiledQuery>;
export declare function executeQuery(q: Query, ctx: ExecContext): Promise<Relation>;
/** Builds `SELECT <items> FROM table AS alias WHERE where` (used by UPDATE / DELETE / RETURNING). */
export declare function selectFrom(table: string, alias: string, items: SelectItem[], where?: Expr): Select;
/**
 * Evaluates expressions against given rows (no table access except
 * subqueries). `sources`: alias → table info, `rows`: alias → document.
 */
export declare function evaluateOnRows(exprs: Expr[], sources: Array<{
    alias: string;
    info: TableInfo | null;
    columns?: string[];
    qualifiedOnly?: boolean;
}>, rows: Array<Record<string, any>>, ctx: ExecContext, opts?: {
    valuesAlias?: string;
}): Promise<any[][]>;
/** Serializable description of a single-table SQL WHERE, evaluated by query workers. */
export interface RowPredicateSpec {
    expr: Expr;
    alias: string;
    columns: string[];
    known: boolean;
    types: Record<string, string>;
    required: string[];
    params: any[];
}
/**
 * Compiles a single-table WHERE (no subqueries) into a predicate over SQL
 * rows ({ id, ...fields }). Used by worker threads, which have no catalog.
 */
export declare function compileRowPredicate(spec: RowPredicateSpec): (row: Record<string, any>) => boolean;
/** True when every expression is a literal or parameter (no evaluation needed). */
export declare function constantRow(exprs: Expr[], params: any[]): any[] | null;
export { compare, sqlEquals, truth };
//# sourceMappingURL=executor.d.ts.map