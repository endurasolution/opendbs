import { BackupService, BackupConfig } from '../services/backup.service';
export declare class BackupScheduler {
    private config;
    private backupService;
    private dataPath;
    private task?;
    constructor(config: BackupConfig, backupService: BackupService, dataPath: string);
    start(): void;
    stop(): void;
}
//# sourceMappingURL=backup-scheduler.d.ts.map