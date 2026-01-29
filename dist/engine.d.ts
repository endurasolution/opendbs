export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
export type RackType = 'sql' | 'nosql';
export interface FieldSchema {
    type: FieldType;
    required?: boolean;
    defaultValue?: any;
}
export interface RackSchema {
    [fieldName: string]: FieldSchema;
}
export declare class OpenDBSEngine {
    private databases;
    private dataPath;
    private packer;
    constructor(dbPath: string);
    private getDatabasePath;
    private getRackPath;
    private loadAll;
    private loadRack;
    private saveRack;
    private calculateHash;
    createDatabase(name: string): boolean;
    createRack(database: string, rack: string, type?: RackType, schema?: RackSchema): boolean;
    getRackType(database: string, rack: string): RackType | null;
    private validateSchema;
    duplicateRack(sourceDb: string, sourceRack: string, targetDb: string, targetRack: string): boolean;
    createIndex(database: string, rack: string, field: string): boolean;
    insert(database: string, rack: string, data: string, operationType?: 'sql' | 'nosql'): string;
    insertMany(database: string, rack: string, dataItems: any[]): string[];
    clearRack(database: string, rack: string): boolean;
    deleteRack(database: string, rack: string): boolean;
    deleteDatabase(database: string): boolean;
    find(database: string, rack: string, query: string, populate?: boolean): string[];
    update(database: string, rack: string, id: string, data: string): boolean;
    delete(database: string, rack: string, id: string): boolean;
    fuzzySearch(database: string, rack: string, field: string, query: string, threshold: number): string[];
    getDatabases(): string[];
    getStats(): string;
    getDatabaseRacks(database: string): {
        name: string;
        count: number;
    }[];
    getRackCount(database: string, rack: string): number;
    private matchesQuery;
    vectorSearch(database: string, rack: string, vectorField: string, queryVector: number[], k?: number): string[];
    private calculateCosineSimilarity;
    private calculateSimilarity;
    getDatabaseStats(database: string): {
        totalRacks: number;
        totalDocuments: number;
        racks: Array<{
            name: string;
            type: string;
            count: number;
        }>;
    };
}
//# sourceMappingURL=engine.d.ts.map