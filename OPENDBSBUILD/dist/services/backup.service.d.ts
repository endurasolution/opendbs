export declare function isValidBackupName(name: unknown): name is string;
/** full | user | upload | prerestore — derived from the file name. */
export declare function backupKind(name: string): string;
/** Exact-prefix ownership check (the old substring check let user 1 read user 12's backups). */
export declare function isBackupOwnedBy(name: string, userId: string): boolean;
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
        /** S3-compatible services (MinIO, Cloudflare R2, Backblaze B2, DigitalOcean Spaces…). */
        endpoint?: string;
        /** Key prefix ("folder") inside the bucket. */
        prefix?: string;
        forcePathStyle?: boolean;
    };
    ftp?: {
        host: string;
        port: number;
        user: string;
        password: string;
        /** Explicit FTPS (TLS). */
        secure?: boolean;
        /** Remote directory. */
        dir?: string;
    };
}
/** The slice of the engine the backup service needs to coordinate with. */
export interface BackupEngineHooks {
    flushAll(): void;
    suspendForRestore(): void;
    reloadFromDisk(): void;
    /** Throws if a rack file can't be read by this server (e.g. different encryption key). */
    verifySnapshot?(content: Buffer): void;
    /** Disk storage engine: racks are not files, so backups export and restore through the engine. */
    usesDiskStorage?(): boolean;
    exportDatabase?(database: string): Array<{
        fileName: string;
        content: Buffer;
    }>;
    restoreDatabase?(database: string, files: Array<{
        fileName: string;
        content: Buffer;
    }>, replace: boolean): {
        count: number;
        removed: number;
    };
}
export declare class BackupService {
    private config;
    private s3Client?;
    private engine?;
    private busy;
    constructor(config: BackupConfig, engine?: BackupEngineHooks);
    getConfig(): BackupConfig;
    /** Applies new settings immediately (used by the admin panel). The backup path never changes at runtime. */
    reconfigure(config: BackupConfig): void;
    private static makeS3;
    private static s3Key;
    private static ftpConnect;
    /**
     * Checks that a destination is reachable and writable by uploading and
     * deleting a tiny marker file. Used by the admin panel's "Test" button.
     */
    testDestination(cfg: BackupConfig): Promise<string>;
    /**
     * kind: 'full' (scheduled/manual) or 'prerestore' (automatic safety copy
     * taken right before a restore). Per-user backups are named by user id.
     */
    createBackup(dataPath: string, databases: string[], userId?: string, kind?: 'full' | 'prerestore'): Promise<string>;
    /**
     * Decompresses and validates a backup without touching the data
     * directory. Every database / file name is checked (path-traversal guard).
     */
    private parseBackup;
    private loadBackup;
    /** What's inside a backup: manifest plus databases → racks with sizes. */
    getBackupContents(backupName: string): Promise<{
        name: string;
        size: number;
        created: Date;
        manifest: {
            timestamp: string | null;
            formatVersion: string;
            appVersion: string | null;
            kind: string | null;
            createdBy: string | null;
        };
        databases: {
            name: string;
            racks: {
                name: string;
                bytes: number;
            }[];
        }[];
    }>;
    /**
     * Restores a backup.
     *  - databases: only restore these (default: everything in the backup)
     *  - replace (default true): racks that exist now but not in the backup
     *    are removed from the restored databases, so each database matches
     *    the backup exactly. false = merge (keep racks created later).
     *  - safetyBackup (default true): first take a 'prerestore' backup of the
     *    current data so the restore itself can be undone.
     */
    restoreBackup(backupName: string, dataPath: string, options?: {
        databases?: string[];
        replace?: boolean;
        safetyBackup?: boolean;
    }): Promise<{
        databases: string[];
        count: number;
        removedRacks: number;
        safetyBackup: string | null;
    }>;
    /** Stores an uploaded backup file after validating it fully. Returns its new name. */
    importBackup(buf: Buffer): Promise<string>;
    deleteBackup(backupName: string): boolean;
    listBackups(): Promise<Array<{
        name: string;
        size: number;
        created: Date;
        kind: string;
    }>>;
    /** Backups stored at the configured S3/FTP destination. */
    listRemoteBackups(): Promise<Array<{
        name: string;
        size: number;
        created: Date | null;
        local: boolean;
    }>>;
    /** Copies a remote backup to the local backup folder so it can be inspected and restored. */
    fetchRemoteBackup(backupName: string): Promise<string>;
    getBackupPath(backupName: string): string | null;
    private uploadBackup;
    private downloadBackup;
    private cleanupOldBackups;
}
//# sourceMappingURL=backup.service.d.ts.map