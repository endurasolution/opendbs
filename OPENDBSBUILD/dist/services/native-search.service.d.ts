export interface ScoredResult {
    id: string;
    score: number;
}
interface VectorItem {
    docId: string;
    vector: number[];
}
export interface VectorIndexStats {
    logicalCount: number;
    physicalCount: number;
    needsRebuild: boolean;
}
/** The raw native addon (search + disk storage), or null if it isn't built for this platform. */
export declare function nativeAddon(): any | null;
/**
 * Thin wrapper around the Rust-accelerated full-text + vector search addon.
 * Every method is a no-op-safe best-effort call: if the native module isn't
 * available (unbuilt platform, missing file), `available` is false and
 * callers are expected to fall back to their existing pure-JS behavior
 * rather than this service throwing.
 */
export declare class NativeSearchService {
    private engine;
    readonly available: boolean;
    constructor(dataPath: string);
    indexText(database: string, rack: string, field: string, docId: string, text: string): void;
    removeText(database: string, rack: string, field: string, docId: string): void;
    searchText(database: string, rack: string, field: string, query: string, limit: number): ScoredResult[];
    addVector(database: string, rack: string, field: string, docId: string, vector: number[]): void;
    addVectorsBatch(database: string, rack: string, field: string, items: VectorItem[]): void;
    removeVector(database: string, rack: string, field: string, docId: string): void;
    searchVector(database: string, rack: string, field: string, query: number[], k: number): ScoredResult[];
    vectorStats(database: string, rack: string, field: string): VectorIndexStats | null;
    rebuildVectorIndex(database: string, rack: string, field: string): void;
    flush(): void;
}
export {};
//# sourceMappingURL=native-search.service.d.ts.map