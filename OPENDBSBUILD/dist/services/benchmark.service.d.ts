export interface BenchmarkResult {
    name: string;
    detail: string;
    ops: number;
    ms: number;
    opsPerSec: number;
    avgMs: number;
    /** MB/s for throughput tests. */
    mbPerSec?: number;
}
/**
 * Write/read speed test. Runs against a throwaway engine in
 * <DB_PATH>/.bench-* -- the same disk as the real data, so the numbers are
 * representative -- using the server's current persistence settings.
 * Nothing touches real databases; the temp directory is deleted afterwards.
 */
export declare class BenchmarkService {
    private dataPath;
    private running;
    constructor(dataPath: string);
    run(requestedSize: number): Promise<{
        size: number;
        settings: any;
        results: BenchmarkResult[];
        totalMs: number;
    }>;
}
//# sourceMappingURL=benchmark.service.d.ts.map