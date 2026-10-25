import { OpenDBSEngine } from '../engine';
import { SecretBox } from '../utils/secret-box';
export type Permission = 'read' | 'write' | 'delete';
export interface User {
    id: string;
    username: string;
    passwordHash: string;
    role: 'admin' | 'user';
    /** sha256 of the API key. The plaintext key is only ever shown once. */
    apiKeyHash?: string;
    /** Legacy plaintext key -- migrated to apiKeyHash on startup. */
    apiKey?: string;
    permissions?: {
        [database: string]: Permission[];
    };
    /** Bumped on password/role change; embedded in JWTs so old tokens stop working. */
    tokenVersion?: number;
    lastLoginAt?: number;
    /** Set when the request authenticated with an admin-issued access key (not a user account). */
    accessKeyId?: string;
    /** TOTP two-factor auth. The secret is AES-GCM encrypted; recovery codes are sha256 hashes. */
    twoFactor?: {
        enabled: boolean;
        secretEnc: string;
        recoveryHashes: string[];
        lastStep?: number;
        enabledAt?: number;
    };
    /** Secret awaiting confirmation during 2FA setup. */
    twoFactorPending?: {
        secretEnc: string;
        createdAt: number;
    };
    /** Per-request only (never stored): this session completed a second factor. */
    sessionMfa?: boolean;
    createdAt: number;
    updatedAt: number;
}
export type LoginResult = {
    token: string;
    user: PublicUser;
} | {
    twoFactorRequired: true;
    challenge: string;
};
/** Permission map key that grants access to every (non-system) database. */
export declare const ALL_DATABASES = "*";
/** Minimal view of AccessKeyService, to avoid a circular import. */
interface AccessKeyAuthenticator {
    authenticate(rawKey: string, ip: string): {
        ok: true;
        user: User;
    } | {
        ok: false;
        reason: 'disabled' | 'expired' | 'ip';
    } | null;
}
export type ApiKeyAuthResult = {
    user: User;
} | {
    denied: string;
} | null;
export type PublicUser = Omit<User, 'passwordHash' | 'apiKey' | 'apiKeyHash' | 'tokenVersion' | 'twoFactor' | 'twoFactorPending' | 'sessionMfa'> & {
    twoFactorEnabled: boolean;
};
export declare function validatePermissions(permissions: unknown): User['permissions'];
export declare class AuthService {
    private engine;
    private readonly USERS_DB;
    private readonly USERS_RACK;
    private jwtSecret;
    /** Encrypts secrets at rest (TOTP seeds, backup credentials). */
    readonly secretBox: SecretBox;
    /** Cluster: every node signs/verifies tokens with the same secret (the primary's). */
    get tokenSecret(): string;
    adoptTokenSecret(secret: string): void;
    private cacheVersion;
    private byId;
    private byUsername;
    private byApiKeyHash;
    private readonly dummyHash;
    constructor(engine: OpenDBSEngine);
    /**
     * Initialize the system database for users
     */
    private initializeSystem;
    /** Replaces plaintext API keys with their hash. Existing keys keep working. */
    private migrateLegacyApiKeys;
    private refreshCache;
    /** Copies so callers can't mutate cached users. */
    private clone;
    /** Persists a user, stripping envelope fields that don't belong in data. */
    private save;
    static toPublic(user: User): PublicUser;
    /**
     * Create a new user
     */
    createUser(username: string, password: string, role?: 'admin' | 'user', permissions?: User['permissions']): Promise<{
        id: string;
        apiKey: string;
    }>;
    /**
     * Authenticate user with username and password
     */
    authenticate(username: string, password: string): Promise<LoginResult>;
    /** Second login step: challenge from authenticate() + TOTP or recovery code. */
    completeTwoFactorLogin(challenge: string, code: string): {
        token: string;
        user: PublicUser;
        usedRecoveryCode: boolean;
    };
    /** Username behind a challenge (for rate limiting), or null. */
    challengeUsername(challenge: string): string | null;
    /**
     * Verifies a TOTP code (with replay protection) or consumes a recovery
     * code. Mutates `user` -- the caller saves it.
     */
    private checkSecondFactor;
    twoFactorStatus(userId: string): {
        enabled: boolean;
        recoveryCodesLeft: number;
        enabledAt?: number;
    };
    /** Starts setup: a fresh secret is stored as pending until confirmed with a code. */
    beginTwoFactorSetup(userId: string): {
        secret: string;
        otpauthUrl: string;
    };
    /** Confirms setup with a code from the app. Returns one-time recovery codes and a 2FA-verified token. */
    enableTwoFactor(userId: string, code: string): {
        recoveryCodes: string[];
        token: string;
    };
    /** Requires the password and a current code (or recovery code). */
    disableTwoFactor(userId: string, password: string, code: string): Promise<void>;
    regenerateRecoveryCodes(userId: string, code: string): string[];
    verifyPassword(userId: string, password: string): Promise<boolean>;
    /** Admin action for a user who lost their device. Signs them out everywhere. */
    resetTwoFactor(userId: string): boolean;
    /**
     * Authenticate with API key -- O(1) hash lookup. Comparing hashes of a
     * high-entropy secret via a map lookup leaks nothing useful by timing.
     */
    authenticateWithApiKey(apiKey: string): User | null;
    /**
     * Verify JWT token
     */
    verifyToken(token: string): User | null;
    /**
     * Find user by username
     */
    private findUserByUsername;
    /**
     * Find user by ID
     */
    findUserById(id: string): User | null;
    /**
     * Get all users (admin only)
     */
    getAllUsers(): User[];
    private adminCount;
    /**
     * Update user permissions
     */
    updatePermissions(userId: string, permissions: User['permissions']): boolean;
    /**
     * Check if user has permission
     */
    hasPermission(user: User, database: string, action: Permission): boolean;
    /** Databases (from `all`) the user can see at all. */
    accessibleDatabases(user: User, all: string[]): string[];
    private accessKeys?;
    setAccessKeyAuthenticator(svc: AccessKeyAuthenticator): void;
    /**
     * Resolves an X-Api-Key header: personal user keys first, then
     * admin-issued access keys (which also enforce their IP allow-list).
     */
    authenticateApiKeyRequest(apiKey: string, ip: string): ApiKeyAuthResult;
    /**
     * Generate JWT token
     */
    private generateJWT;
    /**
     * Generate API key
     */
    private generateApiKey;
    /**
     * Regenerate API key for user
     */
    regenerateApiKey(userId: string): Promise<string>;
    /**
     * Update user password (also revokes all of the user's existing tokens)
     */
    updatePassword(userId: string, newPassword: string): Promise<boolean>;
    /** Issues a fresh token, e.g. after the user changed their own password. */
    issueToken(userId: string, mfa?: boolean): string | null;
    /**
     * Update user (generic)
     */
    updateUser(userId: string, updates: {
        password?: string;
        role?: 'admin' | 'user';
        permissions?: User['permissions'];
    }): Promise<boolean>;
    /**
     * Delete user
     */
    deleteUser(userId: string): boolean;
    /**
     * Create default admin user if no users exist. Uses ADMIN_PASSWORD when
     * set, otherwise a random one-time password printed to the console --
     * never a fixed, publicly documented default.
     */
    ensureAdminExists(): Promise<void>;
    adminUsesDefaultPassword(): Promise<boolean>;
}
export {};
//# sourceMappingURL=auth.service.d.ts.map