"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
class AuthService {
    engine;
    SALT_ROUNDS = 10; // bcrypt salt rounds (optimal for low-memory)
    USERS_DB = '_opendbs_system';
    USERS_RACK = 'users';
    constructor(engine) {
        this.engine = engine;
        this.initializeSystem();
    }
    /**
     * Initialize the system database for users
     */
    initializeSystem() {
        try {
            // Create system database if not exists
            this.engine.createDatabase(this.USERS_DB);
            // Create users rack
            this.engine.createRack(this.USERS_DB, this.USERS_RACK);
        }
        catch (error) {
            // Database might already exist, that's okay
        }
    }
    /**
     * Create a new user
     */
    async createUser(username, password, role = 'user', permissions) {
        // Check if user already exists
        const existing = this.findUserByUsername(username);
        if (existing) {
            throw new Error('User already exists');
        }
        const now = Date.now();
        const passwordHash = await bcrypt_1.default.hash(password, this.SALT_ROUNDS);
        const apiKey = this.generateApiKey();
        const user = {
            username,
            passwordHash,
            role,
            apiKey,
            permissions: permissions || {},
            createdAt: now,
            updatedAt: now,
        };
        const id = this.engine.insert(this.USERS_DB, this.USERS_RACK, JSON.stringify(user));
        return { id, apiKey };
    }
    /**
     * Authenticate user with username and password
     */
    async authenticate(username, password) {
        const user = this.findUserByUsername(username);
        if (!user) {
            throw new Error('Invalid credentials');
        }
        const isValid = await bcrypt_1.default.compare(password, user.passwordHash);
        if (!isValid) {
            throw new Error('Invalid credentials');
        }
        const token = this.generateJWT(user);
        return {
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                permissions: user.permissions,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
            },
        };
    }
    /**
     * Authenticate with API key
     */
    authenticateWithApiKey(apiKey) {
        const users = this.getAllUsers();
        const user = users.find((u) => u.apiKey === apiKey);
        return user || null;
    }
    /**
     * Verify JWT token
     */
    verifyToken(token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwtSecret);
            return this.findUserById(decoded.userId);
        }
        catch (error) {
            return null;
        }
    }
    /**
     * Find user by username
     */
    findUserByUsername(username) {
        try {
            const results = this.engine.find(this.USERS_DB, this.USERS_RACK, JSON.stringify({ username }));
            if (results.length === 0)
                return null;
            return JSON.parse(results[0]);
        }
        catch (error) {
            return null;
        }
    }
    /**
     * Find user by ID
     */
    findUserById(id) {
        try {
            const results = this.engine.find(this.USERS_DB, this.USERS_RACK, JSON.stringify({ id }));
            if (results.length === 0)
                return null;
            return JSON.parse(results[0]);
        }
        catch (error) {
            return null;
        }
    }
    /**
     * Get all users (admin only)
     */
    getAllUsers() {
        try {
            const results = this.engine.find(this.USERS_DB, this.USERS_RACK, '{}');
            return results.map((r) => JSON.parse(r));
        }
        catch (error) {
            return [];
        }
    }
    /**
     * Update user permissions
     */
    updatePermissions(userId, permissions) {
        const user = this.findUserById(userId);
        if (!user)
            return false;
        user.permissions = permissions;
        user.updatedAt = Date.now();
        return this.engine.update(this.USERS_DB, this.USERS_RACK, userId, JSON.stringify(user));
    }
    /**
     * Check if user has permission
     */
    hasPermission(user, database, action) {
        // Admin has all permissions
        if (user.role === 'admin')
            return true;
        // Check specific permissions
        if (!user.permissions || !user.permissions[database])
            return false;
        return user.permissions[database].includes(action);
    }
    /**
     * Generate JWT token
     */
    generateJWT(user) {
        return jsonwebtoken_1.default.sign({
            userId: user.id,
            username: user.username,
            role: user.role,
        }, config_1.config.jwtSecret, { expiresIn: '7d' } // Token expires in 7 days
        );
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
        user.apiKey = newApiKey;
        user.updatedAt = Date.now();
        this.engine.update(this.USERS_DB, this.USERS_RACK, userId, JSON.stringify(user));
        return newApiKey;
    }
    /**
     * Update user password
     */
    async updatePassword(userId, newPassword) {
        const user = this.findUserById(userId);
        if (!user)
            throw new Error('User not found');
        const passwordHash = await bcrypt_1.default.hash(newPassword, this.SALT_ROUNDS);
        user.passwordHash = passwordHash;
        user.updatedAt = Date.now();
        return this.engine.update(this.USERS_DB, this.USERS_RACK, userId, JSON.stringify(user));
    }
    /**
     * Update user (generic)
     */
    async updateUser(userId, updates) {
        const user = this.findUserById(userId);
        if (!user)
            return false;
        if (updates.password) {
            user.passwordHash = await bcrypt_1.default.hash(updates.password, this.SALT_ROUNDS);
        }
        if (updates.role) {
            user.role = updates.role;
            // If promoting to admin, maybe clear permissions? Or keep them as inactive?
            // Existing logic relies on role check first, so it's fine.
        }
        if (updates.permissions) {
            user.permissions = updates.permissions;
        }
        user.updatedAt = Date.now();
        return this.engine.update(this.USERS_DB, this.USERS_RACK, userId, JSON.stringify(user));
    }
    /**
     * Delete user
     */
    deleteUser(userId) {
        return this.engine.delete(this.USERS_DB, this.USERS_RACK, userId);
    }
    /**
     * Create default admin user if no users exist
     */
    async ensureAdminExists() {
        const users = this.getAllUsers();
        if (users.length === 0) {
            const { id, apiKey } = await this.createUser('admin', 'admin123', // Default password - CHANGE THIS!
            'admin');
            console.log('\n⚠️  DEFAULT ADMIN CREATED');
            console.log('Username: admin');
            console.log('Password: admin123');
            console.log(`API Key: ${apiKey}`);
            console.log('⚠️  PLEASE CHANGE THE PASSWORD IMMEDIATELY!\n');
        }
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=auth.service.js.map