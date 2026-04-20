export interface BackupConfig {
    enabled: boolean;
    path: string;
    schedule: string;
    retentionDays: number;
    type: 'local' | 's3' | 'ftp' | 'sftp';
    s3?: {
        bucket: string;
        region: string;
        accessKey: string;
        secretKey: string;
    };
    ftp?: {
        host: string;
        port: number;
        user: string;
        password: string;
    };
}
export declare class BackupService {
    private config;
    private s3Client?;
    constructor(config: BackupConfig);
    createBackup(dataPath: string, databases: string[], userId?: string): Promise<string>;
    restoreBackup(backupName: string, dataPath: string): Promise<{
        databases: string[];
        count: number;
    }>;
    listBackups(): Promise<Array<{
        name: string;
        size: number;
        created: Date;
    }>>;
    private uploadBackup;
    private downloadBackup;
    private cleanupOldBackups;
}
//# sourceMappingURL=backup.service.d.ts.map