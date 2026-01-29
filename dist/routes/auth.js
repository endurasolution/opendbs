"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRoutes = createAuthRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
function createAuthRoutes(authService) {
    return async (fastify) => {
        /**
         * POST /auth/register - Create new user (admin only)
         */
        fastify.post('/register', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()],
        }, async (request, reply) => {
            const { username, password, role, permissions } = request.body;
            if (!username || !password) {
                return reply.status(400).send({
                    error: 'Username and password are required',
                });
            }
            try {
                const { id, apiKey } = await authService.createUser(username, password, role || 'user', permissions);
                return reply.status(201).send({
                    message: 'User created successfully',
                    user: {
                        id,
                        username,
                        role: role || 'user',
                        apiKey,
                    },
                });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        });
        /**
         * POST /auth/login - Login with username and password
         */
        fastify.post('/login', async (request, reply) => {
            const { username, password } = request.body;
            if (!username || !password) {
                return reply.status(400).send({
                    error: 'Username and password are required',
                });
            }
            try {
                const { token, user } = await authService.authenticate(username, password);
                return reply.send({
                    message: 'Login successful',
                    token,
                    user,
                });
            }
            catch (error) {
                return reply.status(401).send({
                    error: 'Invalid credentials',
                });
            }
        });
        /**
         * GET /auth/me - Get current user info
         */
        fastify.get('/me', { preHandler: (0, auth_middleware_1.authMiddleware)(authService) }, async (request, reply) => {
            const user = request.user;
            return reply.send({
                id: user.id,
                username: user.username,
                role: user.role,
                permissions: user.permissions,
                createdAt: user.createdAt,
            });
        });
        /**
         * PUT /auth/me/password - Update own password
         */
        fastify.put('/me/password', { preHandler: (0, auth_middleware_1.authMiddleware)(authService) }, async (request, reply) => {
            const { password } = request.body;
            if (!password || password.length < 6) {
                return reply.status(400).send({ error: 'Password must be at least 6 characters' });
            }
            try {
                await authService.updatePassword(request.user.id, password);
                return reply.send({ message: 'Password updated successfully' });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        });
        /**
         * POST /auth/regenerate-api-key - Regenerate API key
         */
        fastify.post('/regenerate-api-key', { preHandler: (0, auth_middleware_1.authMiddleware)(authService) }, async (request, reply) => {
            try {
                const newApiKey = await authService.regenerateApiKey(request.user.id);
                return reply.send({
                    message: 'API key regenerated successfully',
                    apiKey: newApiKey,
                });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        });
        /**
         * GET /auth/users - List all users (admin only)
         */
        fastify.get('/users', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()],
        }, async (request, reply) => {
            const users = authService.getAllUsers();
            return reply.send({
                users: users.map((u) => ({
                    id: u.id,
                    username: u.username,
                    role: u.role,
                    permissions: u.permissions,
                    createdAt: u.createdAt,
                    updatedAt: u.updatedAt,
                })),
                count: users.length,
            });
        });
        /**
         * PUT /auth/users/:userId/permissions - Update user permissions (admin only)
         */
        fastify.put('/users/:userId/permissions', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()],
        }, async (request, reply) => {
            const { userId } = request.params;
            const { permissions } = request.body;
            const updated = authService.updatePermissions(userId, permissions);
            if (!updated) {
                return reply.status(404).send({ error: 'User not found' });
            }
            return reply.send({
                message: 'Permissions updated successfully',
            });
        });
        /**
         * PATCH /auth/users/:userId - Update user details (admin only)
         */
        fastify.patch('/users/:userId', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()],
        }, async (request, reply) => {
            const { userId } = request.params;
            const updates = request.body;
            // password length check
            if (updates.password && updates.password.length < 6) {
                return reply.status(400).send({ error: 'Password must be at least 6 characters' });
            }
            try {
                const updated = await authService.updateUser(userId, updates);
                if (!updated) {
                    return reply.status(404).send({ error: 'User not found' });
                }
                return reply.send({ message: 'User updated successfully' });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        });
        /**
         * DELETE /auth/users/:userId - Delete user (admin only)
         */
        fastify.delete('/users/:userId', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()],
        }, async (request, reply) => {
            const { userId } = request.params;
            // Prevent deleting yourself
            if (userId === request.user.id) {
                return reply.status(400).send({
                    error: 'Cannot delete your own account',
                });
            }
            const deleted = authService.deleteUser(userId);
            if (!deleted) {
                return reply.status(404).send({ error: 'User not found' });
            }
            return reply.send({
                message: 'User deleted successfully',
            });
        });
    };
}
//# sourceMappingURL=auth.js.map