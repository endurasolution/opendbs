import type { ScanTask } from '../workers/query-worker';
/**
 * Worker threads for parallel scans and aggregations over the disk store.
 * Each worker attaches read-only to the main thread's store; tasks are key
 * ranges of one rack, so N cores scan N ranges at once.
 */
export declare class QueryPool {
    private workers;
    private idle;
    private queue;
    private pending;
    private seq;
    private closed;
    readonly size: number;
    readonly stats: {
        tasks: number;
        parallelQueries: number;
        failures: number;
    };
    constructor(storeHandle: number, size: number);
    /**
     * Default worker count: QUERY_WORKERS, else half the logical CPUs (scans
     * stop scaling past the physical/performance cores), 1–8; 0 disables.
     */
    static defaultSize(): number;
    get alive(): boolean;
    private release;
    private dispatch;
    run(task: Omit<ScanTask, 'id'>): Promise<any>;
    runAll(tasks: Array<Omit<ScanTask, 'id'>>): Promise<any[]>;
    close(): Promise<void>;
}
//# sourceMappingURL=query-pool.d.ts.map