"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = exports.ALL_DATABASES = void 0;
exports.validatePermissions = validatePermissions;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const security_middleware_1 = require("../middleware/security.middleware");
const totp_1 = require("../utils/totp");
const secret_box_1 = require("../utils/secret-box");
/** Permission map key that grants access to every (non-system) database. */
exports.ALL_DATABASES = '*';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const VALID_PERMS = new Set(['read', 'write', 'delete']);
const JWT_ISSUER = 'opendbs';
// Secrets that shipped in sample configs -- never acceptable.
const KNOWN_WEAK_SECRETS = new Set([
    'your-super-secret-jwt-key-change-in-production',
    'your-super-secret-jwt-key-change-in-production-use-random-64-chars',
    'secret',
    'changeme',
]);
/**
 * Production refuses to start with a missing/weak JWT secret. Development
 * generates a random one and persists it under the data directory so
 * tokens survive restarts.
 */
function resolveJwtSecret() {
    const configured = config_1.config.jwtSecret;
    const weak = !configured || configured.length < 32 || KNOWN_WEAK_SECRETS.has(configured);
    if (!weak)
        return configured;
    if (config_1.config.nodeEnv === 'production') {
        throw new Error('JWT_SECRET is missing or weak. Set a random value of at least 32 characters, e.g.\n' +
            "  node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"");
    }
    const secretFile = path_1.default.join(config_1.config.dbPath, '.jwt_secret');
    try {
        const existing = fs_1.default.readFileSync(secretFile, 'utf-8').trim();
        if (existing.length >= 32)
            return existing;
    }
    catch { /* not created yet */ }
    const generated = crypto_1.default.randomBytes(48).toString('hex');
    fs_1.default.mkdirSync(config_1.config.dbPath, { recursive: true });
    fs_1.default.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn('⚠️  JWT_SECRET is not set (or weak) -- using a generated secret stored in data/.jwt_secret.');
    console.warn('   Set JWT_SECRET in .env before going to production.');
    return generated;
}
function validatePermissions(permissions) {
    if (permissions === undefined || permissions === null)
        return {};
    if (!(0, security_middleware_1.isPlainObject)(permissions))
        throw new Error('permissions must be an object of { database: ["read","write","delete"] }');
    const out = {};
    for (const [db, perms] of Object.entries(permissions)) {
        if (db !== exports.ALL_DATABASES && (!(0, security_middleware_1.validateIdentifier)(db) || db === '_opendbs_system')) {
            throw new Error(`Invalid database in permissions: '${db}'`);
        }
        if (!Array.isArray(perms) || !perms.every((p) => VALID_PERMS.has(p))) {
            throw new Error(`Permissions for '${db}' must be an array of read/write/delete`);
        }
        out[db] = Array.from(new Set(perms));
    }
    return out;
}
class AuthService {
    engine;
    USERS_DB = '_opendbs_system';
    USERS_RACK = 'users';
    jwtSecret;
    /** Encrypts secrets at rest (TOTP seeds, backup credentials). */
    secretBox;
    /** Cluster: every node signs/verifies tokens with the same secret (the primary's). */
    get tokenSecret() {
        return this.jwtSecret;
    }
    adoptTokenSecret(secret) {
        if (typeof secret !== 'string' || secret.length < 32 || secret === this.jwtSecret)
            return;
        this.jwtSecret = secret;
        if (!config_1.config.jwtSecret) {
            try {
                fs_1.default.writeFileSync(path_1.default.join(config_1.config.dbPath, '.jwt_secret'), secret, { mode: 0o600 });
            }
            catch { /* keep in memory */ }
        }
    }
    // In-memory view of the users rack, rebuilt only when the rack changes.
    cacheVersion = -1;
    byId = new Map();
    byUsername = new Map();
    byApiKeyHash = new Map();
    // A real bcrypt hash to compare against when the username doesn't exist,
    // so response time doesn't reveal which usernames are valid.
    dummyHash;
    constructor(engine) {
        this.engine = engine;
        this.jwtSecret = resolveJwtSecret();
        this.secretBox = new secret_box_1.SecretBox(config_1.config.dbPath);
        this.dummyHash = bcrypt_1.default.hashSync(crypto_1.default.randomBytes(16).toString('hex'), config_1.config.bcryptRounds);
        this.initializeSystem();
    }
    /**
     * Initialize the system database for users
     */
    initializeSystem() {
        this.engine.createDatabase(this.USERS_DB);
        this.engine.createRack(this.USERS_DB, this.USERS_RACK);
        try {
            this.engine.createIndex(this.USERS_DB, this.USERS_RACK, 'username', { unique: true });
        }
        catch (err) {
            console.warn(`⚠️  Could not create unique username index (${err.message}); using non-unique index.`);
            this.engine.createIndex(this.USERS_DB, this.USERS_RACK, 'username');
        }
        this.migrateLegacyApiKeys();
    }
    /** Replaces plaintext API keys with their hash. Existing keys keep working. */
    migrateLegacyApiKeys() {
        let migrated = 0;
        for (const user of this.getAllUsers()) {
            if (user.apiKey) {
                const { apiKey, ...rest } = user;
                this.save({ ...rest, apiKeyHash: (0, security_middleware_1.sha256Hex)(apiKey) });
                migrated++;
            }
        }
        if (migrated > 0)
            console.log(`🔐 Migrated ${migrated} plaintext API key(s) to hashed storage`);
    }
    refreshCache() {
        const version = this.engine.getRackVersion(this.USERS_DB, this.USERS_RACK);
        if (version === this.cacheVersion)
            return;
        this.byId.clear();
        this.byUsername.clear();
        this.byApiKeyHash.clear();
        const { results } = this.engine.query(this.USERS_DB, this.USERS_RACK, {});
        for (const raw of results) {
            const u = { ...raw };
            delete u._metadata;
            this.byId.set(u.id, u);
            this.byUsername.set(u.username, u);
            const hash = u.apiKeyHash ?? (u.apiKey ? (0, security_middleware_1.sha256Hex)(u.apiKey) : undefined);
            if (hash)
                this.byApiKeyHash.set(hash, u);
        }
        this.cacheVersion = version;
    }
    /** Copies so callers can't mutate cached users. */
    clone(u) {
        return u ? structuredClone(u) : null;
    }
    /** Persists a user, stripping envelope fields that don't belong in data. */
    save(user) {
        const { id, ...data } = user;
        delete data._metadata;
        delete data.sessionMfa;
        return this.engine.update(this.USERS_DB, this.USERS_RACK, id, data);
    }
    static toPublic(user) {
        return {
            id: user.id,
            username: user.username,
            role: user.role,
            permissions: user.permissions,
            lastLoginAt: user.lastLoginAt,
            twoFactorEnabled: Boolean(user.twoFactor?.enabled),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };
    }
    /**
     * Create a new user
     */
    async createUser(username, password, role = 'user', permissions) {
        if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
            throw new Error('Username must be 3–32 characters: letters, numbers, underscore only');
        }
        if (role !== 'admin' && role !== 'user')
            throw new Error('Role must be "admin" or "user"');
        const perms = validatePermissions(permissions);
        if (this.findUserByUsername(username)) {
            throw new Error('User already exists');
        }
        const now = Date.now();
        const passwordHash = await bcrypt_1.default.hash(password, config_1.config.bcryptRounds);
        const apiKey = this.generateApiKey();
        const user = {
            username,
            passwordHash,
            role,
            apiKeyHash: (0, security_middleware_1.sha256Hex)(apiKey),
            permissions: perms,
            tokenVersion: 0,
            createdAt: now,
            updatedAt: now,
        };
        const id = this.engine.insert(this.USERS_DB, this.USERS_RACK, user);
        return { id, apiKey };
    }
    /**
     * Authenticate user with username and password
     */
    async authenticate(username, password) {
        const user = typeof username === 'string' ? this.findUserByUsername(username) : null;
        // Always run exactly one bcrypt compare, whether or not the user exists.
        const isValid = await bcrypt_1.default.compare(String(password), user ? user.passwordHash : this.dummyHash);
        if (!user || !isValid) {
            throw new Error('Invalid credentials');
        }
        // Password is right; with 2FA on, hand back a short-lived challenge
        // instead of a session -- it's only useful together with a valid code.
        if (user.twoFactor?.enabled) {
            const challenge = jsonwebtoken_1.default.sign({ uid: user.id, tv: user.tokenVersion ?? 0, purpose: '2fa' }, this.jwtSecret, { algorithm: 'HS256', issuer: JWT_ISSUER, audience: '2fa-challenge', expiresIn: '5m' });
            return { twoFactorRequired: true, challenge };
        }
        user.lastLoginAt = Date.now();
        this.save(user);
        return { token: this.generateJWT(user, false), user: AuthService.toPublic(user) };
    }
    /** Second login step: challenge from authenticate() + TOTP or recovery code. */
    completeTwoFactorLogin(challenge, code) {
        let payload;
        try {
            payload = jsonwebtoken_1.default.verify(challenge, this.jwtSecret, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: '2fa-challenge' });
        }
        catch {
            throw new Error('Login challenge expired. Sign in again.');
        }
        const user = this.findUserById(payload.uid);
        if (!user || payload.purpose !== '2fa' || (user.tokenVersion ?? 0) !== payload.tv || !user.twoFactor?.enabled) {
            throw new Error('Login challenge expired. Sign in again.');
        }
        const result = this.checkSecondFactor(user, code);
        if (!result)
            throw new Error('Invalid authentication code');
        user.lastLoginAt = Date.now();
        this.save(user);
        return { token: this.generateJWT(user, true), user: AuthService.toPublic(user), usedRecoveryCode: result === 'recovery' };
    }
    /** Username behind a challenge (for rate limiting), or null. */
    challengeUsername(challenge) {
        const decoded = jsonwebtoken_1.default.decode(challenge);
        return decoded?.uid ? this.findUserById(decoded.uid)?.username ?? null : null;
    }
    /**
     * Verifies a TOTP code (with replay protection) or consumes a recovery
     * code. Mutates `user` -- the caller saves it.
     */
    checkSecondFactor(user, code) {
        const tf = user.twoFactor;
        if (!tf?.enabled || typeof code !== 'string')
            return null;
        const trimmed = code.trim();
        if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
            const step = (0, totp_1.verifyTotp)(this.secretBox.open(tf.secretEnc), trimmed, tf.lastStep ?? -1);
            if (step === null)
                return null;
            tf.lastStep = step;
            return 'totp';
        }
        const hash = (0, security_middleware_1.sha256Hex)(trimmed.toLowerCase());
        const idx = tf.recoveryHashes.findIndex((h) => (0, security_middleware_1.timingSafeEqual)(h, hash));
        if (idx === -1)
            return null;
        tf.recoveryHashes.splice(idx, 1);
        return 'recovery';
    }
    twoFactorStatus(userId) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        return {
            enabled: Boolean(user.twoFactor?.enabled),
            recoveryCodesLeft: user.twoFactor?.recoveryHashes.length ?? 0,
            enabledAt: user.twoFactor?.enabledAt,
        };
    }
    /** Starts setup: a fresh secret is stored as pending until confirmed with a code. */
    beginTwoFactorSetup(userId) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        if (user.twoFactor?.enabled)
            throw new Error('Two-factor authentication is already enabled');
        const secret = (0, totp_1.generateTotpSecret)();
        user.twoFactorPending = { secretEnc: this.secretBox.seal(secret), createdAt: Date.now() };
        this.save(user);
        return { secret, otpauthUrl: (0, totp_1.otpauthUrl)('OpenDBS', user.username, secret) };
    }
    /** Confirms setup with a code from the app. Returns one-time recovery codes and a 2FA-verified token. */
    enableTwoFactor(userId, code) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        const pending = user.twoFactorPending;
        if (!pending || Date.now() - pending.createdAt > 15 * 60_000)
            throw new Error('Setup expired. Start again.');
        const secret = this.secretBox.open(pending.secretEnc);
        const step = (0, totp_1.verifyTotp)(secret, String(code ?? ''));
        if (step === null)
            throw new Error('That code is not valid. Check the time on your phone and try again.');
        const codes = (0, totp_1.generateRecoveryCodes)();
        user.twoFactor = {
            enabled: true,
            secretEnc: pending.secretEnc,
            recoveryHashes: codes.map((c) => (0, security_middleware_1.sha256Hex)(c)),
            lastStep: step,
            enabledAt: Date.now(),
        };
        delete user.twoFactorPending;
        user.updatedAt = Date.now();
        this.save(user);
        return { recoveryCodes: codes, token: this.generateJWT(user, true) };
    }
    /** Requires the password and a current code (or recovery code). */
    async disableTwoFactor(userId, password, code) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        if (!user.twoFactor?.enabled)
            throw new Error('Two-factor authentication is not enabled');
        if (!(await bcrypt_1.default.compare(String(password ?? ''), user.passwordHash)))
            throw new Error('Password is incorrect');
        if (!this.checkSecondFactor(user, String(code ?? '')))
            throw new Error('Invalid authentication code');
        delete user.twoFactor;
        delete user.twoFactorPending;
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        user.updatedAt = Date.now();
        this.save(user);
    }
    regenerateRecoveryCodes(userId, code) {
        const user = this.findUserById(userId);
        if (!user?.twoFactor?.enabled)
            throw new Error('Two-factor authentication is not enabled');
        if (this.checkSecondFactor(user, String(code ?? '')) !== 'totp')
            throw new Error('Enter a current code from your authenticator app');
        const codes = (0, totp_1.generateRecoveryCodes)();
        user.twoFactor.recoveryHashes = codes.map((c) => (0, security_middleware_1.sha256Hex)(c));
        this.save(user);
        return codes;
    }
    async verifyPassword(userId, password) {
        const user = this.findUserById(userId);
        return Boolean(user && password && await bcrypt_1.default.compare(password, user.passwordHash));
    }
    /** Admin action for a user who lost their device. Signs them out everywhere. */
    resetTwoFactor(userId) {
        const user = this.findUserById(userId);
        if (!user)
            return false;
        delete user.twoFactor;
        delete user.twoFactorPending;
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        user.updatedAt = Date.now();
        return this.save(user);
    }
    /**
     * Authenticate with API key -- O(1) hash lookup. Comparing hashes of a
     * high-entropy secret via a map lookup leaks nothing useful by timing.
     */
    authenticateWithApiKey(apiKey) {
        if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 256)
            return null;
        this.refreshCache();
        return this.clone(this.byApiKeyHash.get((0, security_middleware_1.sha256Hex)(apiKey)));
    }
    /**
     * Verify JWT token
     */
    verifyToken(token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, this.jwtSecret, {
                algorithms: ['HS256'],
                issuer: JWT_ISSUER,
            });
            if (decoded.purpose)
                return null; // 2FA challenges are not sessions
            const user = this.findUserById(decoded.userId);
            if (!user)
                return null;
            if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0))
                return null; // revoked
            // A per-request copy: sessionMfa belongs to this token, and the stored user
            // object is shared by every concurrent session of the same account.
            return { ...user, sessionMfa: decoded.mfa === true };
        }
        catch {
            return null;
        }
    }
    /**
     * Find user by username
     */
    findUserByUsername(username) {
        this.refreshCache();
        return this.clone(this.byUsername.get(username));
    }
    /**
     * Find user by ID
     */
    findUserById(id) {
        this.refreshCache();
        return this.clone(this.byId.get(String(id)));
    }
    /**
     * Get all users (admin only)
     */
    getAllUsers() {
        this.refreshCache();
        return Array.from(this.byId.values()).map((u) => structuredClone(u));
    }
    adminCount() {
        this.refreshCache();
        let n = 0;
        for (const u of this.byId.values())
            if (u.role === 'admin')
                n++;
        return n;
    }
    /**
     * Update user permissions
     */
    updatePermissions(userId, permissions) {
        const user = this.findUserById(userId);
        if (!user)
            return false;
        user.permissions = validatePermissions(permissions);
        user.updatedAt = Date.now();
        return this.save(user);
    }
    /**
     * Check if user has permission
     */
    hasPermission(user, database, action) {
        // Admin has all permissions
        if (user.role === 'admin')
            return true;
        const perms = user.permissions;
        if (!perms)
            return false;
        const has = (key) => Object.prototype.hasOwnProperty.call(perms, key) && Array.isArray(perms[key]) && perms[key].includes(action);
        // "*" covers every database except the system one.
        if (database !== '_opendbs_system' && database !== exports.ALL_DATABASES && has(exports.ALL_DATABASES))
            return true;
        return has(database);
    }
    /** Databases (from `all`) the user can see at all. */
    accessibleDatabases(user, all) {
        if (user.role === 'admin')
            return all;
        const perms = user.permissions || {};
        if (Object.prototype.hasOwnProperty.call(perms, exports.ALL_DATABASES) && perms[exports.ALL_DATABASES].length > 0) {
            return all.filter((db) => db !== '_opendbs_system');
        }
        return all.filter((db) => db !== '_opendbs_system' && Object.prototype.hasOwnProperty.call(perms, db) && perms[db].length > 0);
    }
    accessKeys;
    setAccessKeyAuthenticator(svc) {
        this.accessKeys = svc;
    }
    /**
     * Resolves an X-Api-Key header: personal user keys first, then
     * admin-issued access keys (which also enforce their IP allow-list).
     */
    authenticateApiKeyRequest(apiKey, ip) {
        const user = this.authenticateWithApiKey(apiKey);
        if (user)
            return { user };
        const res = this.accessKeys?.authenticate(apiKey, ip) ?? null;
        if (!res)
            return null;
        if (res.ok)
            return { user: res.user };
        return {
            denied: res.reason === 'ip'
                ? 'This API key is not allowed from your IP address'
                : res.reason === 'expired' ? 'This API key has expired' : 'This API key is disabled',
        };
    }
    /**
     * Generate JWT token
     */
    generateJWT(user, mfa) {
        return jsonwebtoken_1.default.sign({
            userId: user.id,
            username: user.username,
            role: user.role,
            tv: user.tokenVersion ?? 0,
            // true only when this session passed a second factor
            mfa,
        }, this.jwtSecret, {
            algorithm: 'HS256',
            issuer: JWT_ISSUER,
            expiresIn: `${Math.max(1, config_1.config.jwtExpirationDays)}d`,
        });
    }
    /**
     * Generate API key
     */
    generateApiKey() {
        return `opendbs_${crypto_1.default.randomBytes(32).toString('hex')}`;
    }
    /**
     * Regenerate API key for user
     */
    async regenerateApiKey(userId) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        const newApiKey = this.generateApiKey();
        delete user.apiKey;
        user.apiKeyHash = (0, security_middleware_1.sha256Hex)(newApiKey);
        user.updatedAt = Date.now();
        this.save(user);
        return newApiKey;
    }
    /**
     * Update user password (also revokes all of the user's existing tokens)
     */
    async updatePassword(userId, newPassword) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        user.passwordHash = await bcrypt_1.default.hash(newPassword, config_1.config.bcryptRounds);
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        user.updatedAt = Date.now();
        return this.save(user);
    }
    /** Issues a fresh token, e.g. after the user changed their own password. */
    issueToken(userId, mfa = false) {
        const user = this.findUserById(userId);
        return user ? this.generateJWT(user, mfa) : null;
    }
    /**
     * Update user (generic)
     */
    async updateUser(userId, updates) {
        const user = this.findUserById(userId);
        if (!user)
            return false;
        if (updates.password) {
            user.passwordHash = await bcrypt_1.default.hash(updates.password, config_1.config.bcryptRounds);
            user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        }
        if (updates.role !== undefined) {
            if (updates.role !== 'admin' && updates.role !== 'user')
                throw new Error('Role must be "admin" or "user"');
            if (user.role === 'admin' && updates.role === 'user' && this.adminCount() <= 1) {
                throw new Error('Cannot demote the last admin');
            }
            if (updates.role !== user.role)
                user.tokenVersion = (user.tokenVersion ?? 0) + 1;
            user.role = updates.role;
        }
        if (updates.permissions !== undefined) {
            user.permissions = validatePermissions(updates.permissions);
        }
        user.updatedAt = Date.now();
        return this.save(user);
    }
    /**
     * Delete user
     */
    deleteUser(userId) {
        const user = this.findUserById(userId);
        if (!user)
            return false;
        if (user.role === 'admin' && this.adminCount() <= 1) {
            throw new Error('Cannot delete the last admin');
        }
        return this.engine.delete(this.USERS_DB, this.USERS_RACK, userId);
    }
    /**
     * Create default admin user if no users exist. Uses ADMIN_PASSWORD when
     * set, otherwise a random one-time password printed to the console --
     * never a fixed, publicly documented default.
     */
    async ensureAdminExists() {
        const users = this.getAllUsers();
        if (users.length === 0) {
            const password = config_1.config.adminPassword || crypto_1.default.randomBytes(12).toString('base64url') + '1a';
            const { apiKey } = await this.createUser('admin', password, 'admin');
            console.log('\n⚠️  DEFAULT ADMIN CREATED');
            console.log('Username: admin');
            console.log(config_1.config.adminPassword ? 'Password: (from ADMIN_PASSWORD)' : `Password: ${password}`);
            console.log(`API Key:  ${apiKey}`);
            console.log('⚠️  Store these now -- they are not shown again.\n');
            return;
        }
        // Warn loudly if the old publicly-known default is still in use.
        if (await this.adminUsesDefaultPassword()) {
            console.warn('\n🚨 SECURITY: user "admin" still has the default password "admin123". Change it now.\n');
        }
    }
    async adminUsesDefaultPassword() {
        const admin = this.findUserByUsername('admin');
        return Boolean(admin && await bcrypt_1.default.compare('admin123', admin.passwordHash));
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=auth.service.js.map