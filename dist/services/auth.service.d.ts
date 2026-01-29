import { OpenDBSEngine } from '../engine';
export interface User {
    id: string;
    username: string;
    passwordHash: string;
    role: 'admin' | 'user';
    apiKey?: string;
    permissions?: {
        [database: string]: ('read' | 'write' | 'delete')[];
    };
    createdAt: number;
    updatedAt: number;
}
export declare class AuthService {
    private engine;
    private readonly SALT_ROUNDS;
    private readonly USERS_DB;
    private readonly USERS_RACK;
    constructor(engine: OpenDBSEngine);
    /**
     * Initialize the system database for users
     */
    private initializeSystem;
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
    authenticate(username: string, password: string): Promise<{
        token: string;
        user: Omit<User, 'passwordHash' | 'apiKey'>;
    }>;
    /**
     * Authenticate with API key
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
    /**
     * Update user permissions
     */
    updatePermissions(userId: string, permissions: User['permissions']): boolean;
    /**
     * Check if user has permission
     */
    hasPermission(user: User, database: string, action: 'read' | 'write' | 'delete'): boolean;
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
     * Update user password
     */
    updatePassword(userId: string, newPassword: string): Promise<boolean>;
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
     * Create default admin user if no users exist
     */
    ensureAdminExists(): Promise<void>;
}
//# sourceMappingURL=auth.service.d.ts.map