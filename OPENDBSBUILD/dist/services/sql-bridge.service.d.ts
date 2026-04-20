import { OpenDBSEngine } from '../engine';
export interface SQLCredentials {
    userId: string;
    username: string;
    password: string;
    host: string;
    port: number;
    createdAt: Date;
}
export declare class SQLBridgeService {
    private engine;
    private pool?;
    private sqlCredentials;
    constructor(engine: OpenDBSEngine, mysqlConfig?: {
        host: string;
        port: number;
        user: string;
        password: string;
        database?: string;
    });
    generateSQLCredentials(userId: string, username: string): SQLCredentials;
    getSQLCredentials(userId: string): SQLCredentials | undefined;
    executeSQL(query: string, database: string): Promise<any>;
    private handleSelect;
    private handleInsert;
    private handleUpdate;
    private handleDelete;
    private handleCreateTable;
    private handleDropTable;
    private generateSecurePassword;
    close(): Promise<void>;
}
//# sourceMappingURL=sql-bridge.service.d.ts.map