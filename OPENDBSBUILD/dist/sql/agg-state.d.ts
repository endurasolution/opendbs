/**
 * Aggregate accumulators, shared by the SQL executor and the parallel
 * query workers (which compute partial states that are merged).
 */
type Fn = (row: any, env: any) => any;
export interface AggDef {
    name: string;
    args: Fn[];
    star: boolean;
    distinct: boolean;
    filter?: Fn;
    order?: Array<{
        c: Fn;
        desc: boolean;
        nulls?: 'first' | 'last';
    }>;
    sep?: Fn;
    /** Source argument expressions (lets the planner push simple aggregates to workers). */
    argExprs?: any[];
}
export interface AggState {
    n: number;
    sum: number;
    sumSq: number;
    nums: number;
    min: any;
    max: any;
    first: any;
    list: any[] | null;
    keys: any[][] | null;
    seen: Set<string> | null;
    all: boolean;
    any: boolean;
    band: number | null;
    bor: number | null;
}
/** Aggregates whose partial states can be combined (computed in parallel). */
export declare const MERGEABLE: Set<string>;
/** MySQL ordering: NULL sorts first ascending, last descending (unless NULLS FIRST/LAST says otherwise). */
export declare function compareKeys(a: any[], b: any[], order: Array<{
    desc: boolean;
    nulls?: 'first' | 'last';
}>): number;
export declare function newAggState(def: AggDef): AggState;
export declare function addAgg(st: AggState, def: AggDef, row: any, env: any): void;
/** Combines a partial state into another (MERGEABLE aggregates only). */
export declare function mergeAggState(into: AggState, from: AggState): void;
export declare function finishAgg(st: AggState, def: AggDef, env: any, row: any): any;
/** Plain-object form of a state for sending between threads (structured clone drops nothing important). */
export declare function serializeState(st: AggState): any;
/** Reads a group/aggregate field of a stored document ({ id, data }): "id" is numeric, others are data paths. */
export declare function fieldReader(field: string): (doc: any) => any;
export interface PartialGroup {
    key: any[];
    states: AggState[];
}
/** Combines partial groups (from workers or shards) by group key. */
export declare function mergePartials(parts: PartialGroup[]): PartialGroup[];
/** Final values of merged groups (one row with empty states when nothing matched and there is no GROUP BY). */
export declare function finishPartials(groups: PartialGroup[], groupFields: string[], aggs: Array<{
    name: string;
    field: string | null;
}>): Array<{
    key: any[];
    values: any[];
}>;
export {};
//# sourceMappingURL=agg-state.d.ts.map