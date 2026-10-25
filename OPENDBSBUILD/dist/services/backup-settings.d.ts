import { BackupConfig } from './backup.service';
import { SecretBox } from '../utils/secret-box';
/**
 * Backup settings edited from the admin panel. They are stored in
 * <DB_PATH>/.config/backup.json (credentials sealed with SecretBox) and
 * override the BACKUP_* values from .env. Changes apply immediately -- no
 * restart -- by reconfiguring the backup service and rescheduling the job.
 *
 * The backup *directory* is deliberately not editable from the browser: a
 * stolen admin session must not be able to point full-database dumps at a
 * publicly served folder.
 */
export declare class BackupSettingsStore {
    private box;
    private readonly file;
    constructor(dataPath: string, box: SecretBox);
    load(defaults: BackupConfig): BackupConfig;
    save(cfg: BackupConfig): void;
}
/** Config as shown to the browser: secrets replaced by "***" when set. */
export declare function maskBackupConfig(cfg: BackupConfig): {
    enabled: boolean;
    schedule: string;
    retentionDays: number;
    type: "local" | "s3" | "ftp" | "sftp";
    path: string;
    s3: {
        secretKey: string;
        bucket: string;
        region: string;
        accessKey: string;
        endpoint?: string;
        prefix?: string;
        forcePathStyle?: boolean;
    } | null;
    ftp: {
        password: string;
        host: string;
        port: number;
        user: string;
        secure?: boolean;
        dir?: string;
    } | null;
};
/**
 * Validates an update from the browser and merges it over `current`.
 * A secret sent back as "***" keeps the stored value.
 */
export declare function validateBackupInput(input: unknown, current: BackupConfig): BackupConfig;
//# sourceMappingURL=backup-settings.d.ts.map