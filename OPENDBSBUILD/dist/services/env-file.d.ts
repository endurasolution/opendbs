/** Reading and safely rewriting the server's .env file (atomic, comments preserved). */
export declare function envPath(): string;
/** Parses KEY=VALUE lines, keeping '=' inside values. */
export declare function parseEnv(content: string): Record<string, string>;
export declare function readEnvFile(): Record<string, string>;
/**
 * Updates existing KEY= lines in place and appends new keys. Callers must
 * have validated keys and values (no newlines) already.
 */
export declare function writeEnvUpdates(updates: Record<string, string>): void;
export type SettingType = 'bool' | 'int' | 'string' | 'enum' | 'secret' | 'list';
export interface SettingDef {
    key: string;
    label: string;
    group: string;
    type: SettingType;
    help: string;
    default: string;
    options?: string[];
    min?: number;
    max?: number;
    minLength?: number;
}
/**
 * The settings the admin panel may change. Anything not listed here (in
 * particular ADMIN_PANEL_*, ADMIN_ALLOWED_IPS, ADMIN_REQUIRE_2FA,
 * SHOW_ENVONWEB, DB_PATH, BACKUP_PATH) can only be edited on the server.
 */
export declare const ADMIN_SETTINGS: SettingDef[];
export declare function readAdminSettings(): {
    value: string;
    isSet: boolean | undefined;
    key: string;
    label: string;
    group: string;
    type: SettingType;
    help: string;
    default: string;
    options?: string[];
    min?: number;
    max?: number;
    minLength?: number;
}[];
/** Validates updates against ADMIN_SETTINGS; returns normalized string values. */
export declare function validateAdminSettings(input: unknown): Record<string, string>;
//# sourceMappingURL=env-file.d.ts.map