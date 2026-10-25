import { OpenDBSEngine } from '../engine';
import { Permission, User } from './auth.service';
/**
 * Admin-managed API access keys ("service keys"), independent of user
 * accounts. Each key carries:
 *  - per-database permissions (read / write / delete), "*" = every database
 *  - an IP allow-list of addresses or CIDR ranges, "*" = any IP (public)
 *  - optional expiry and an enabled flag
 * Keys are stored as sha256 hashes; the plaintext is shown once on create/rotate.
 */
export interface AccessKey {
    id: string;
    name: string;
    description?: string;
    keyHash: string;
    /** First characters of the key, for recognising it in the UI. */
    prefix: string;
    permissions: Record<string, Permission[]>;
    allowedIps: string[];
    enabled: boolean;
    expiresAt: number | null;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt?: number;
    lastUsedIp?: string;
    useCount?: number;
}
export type PublicAccessKey = Omit<AccessKey, 'keyHash'>;
export interface AccessKeyInput {
    name?: unknown;
    description?: unknown;
    permissions?: unknown;
    allowedIps?: unknown;
    enabled?: unknown;
    expiresAt?: unknown;
}
export type AccessKeyAuthResult = {
    ok: true;
    user: User;
    key: AccessKey;
} | {
    ok: false;
    reason: 'disabled' | 'expired' | 'ip';
    key: AccessKey;
};
export declare const normalizeIp: (ip: string) => string;
/** Validates an allow-list. Accepts "*", single IPs and CIDR ranges (v4 and v6). */
export declare function validateIpList(value: unknown): string[];
export declare class AccessKeyService {
    private engine;
    private readonly DB;
    private readonly RACK;
    private cacheVersion;
    private byHash;
    private matchers;
    private usage;
    constructor(engine: OpenDBSEngine);
    private refresh;
    private static toPublic;
    private static newSecret;
    private save;
    private require;
    list(): PublicAccessKey[];
    create(input: AccessKeyInput, createdBy: string): {
        key: string;
        record: PublicAccessKey;
    };
    update(id: string, input: AccessKeyInput): PublicAccessKey;
    rotate(id: string): {
        key: string;
        record: PublicAccessKey;
    };
    delete(id: string): boolean;
    /** Returns null when the key isn't an access key at all. */
    authenticate(rawKey: string, ip: string): AccessKeyAuthResult | null;
    flushUsage(): void;
}
//# sourceMappingURL=access-key.service.d.ts.map