import { BackupService, BackupConfig } from '../services/backup.service';
export interface BackupRunInfo {
    at: string;
    ok: boolean;
    backupName?: string;
    error?: string;
    trigger: 'schedule' | 'manual';
}
/**
 * Runs scheduled backups. Reads its settings from the BackupService, so a
 * change saved in the admin panel only needs reschedule() -- no restart.
 */
export declare class BackupScheduler {
    private backupService;
    private dataPath;
    private task?;
    private running;
    lastRun: BackupRunInfo | null;
    constructor(_config: BackupConfig, backupService: BackupService, dataPath: string);
    start(quiet?: boolean): void;
    /** Applies the service's current settings (call after reconfigure). */
    reschedule(): void;
    runNow(trigger?: 'schedule' | 'manual'): Promise<BackupRunInfo>;
    status(): {
        enabled: boolean;
        scheduled: boolean;
        nextRun: string | null;
        lastRun: BackupRunInfo | null;
        running: boolean;
    };
    stop(quiet?: boolean): void;
}
//# sourceMappingURL=backup-scheduler.d.ts.map