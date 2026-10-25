import { RowPredicateSpec } from '../sql/executor';
/**
 * Parallel scan worker. Attaches (read-only) to the disk store opened by the
 * main thread and processes one key range of a rack per task: filtering
 * with the engine's own matcher, counting, picking the top-K for a sort, or
 * computing partial aggregates that the main thread merges.
 */
export interface ScanTask {
    id: number;
    kind: 'filter' | 'agg';
    table: string;
    lo: Uint8Array | null;
    hi: Uint8Array | null;
    query: any;
    /** filter: what to return. */
    need?: 'count' | 'ids' | 'top';
    /** ids: keep at most this many (first in key order); top: K. */
    keep?: number;
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
    /** agg: group-by fields and aggregates (field null = *). */
    groups?: string[];
    aggs?: Array<{
        name: string;
        field: string | null;
    }>;
    /** agg: exact SQL WHERE (when `query` is only a coarse pre-filter). */
    sqlWhere?: RowPredicateSpec;
}
//# sourceMappingURL=query-worker.d.ts.map