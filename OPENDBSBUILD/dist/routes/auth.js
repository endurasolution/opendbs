"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRoutes = createAuthRoutes;
const qrcode_1 = __importDefault(require("qrcode"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const security_middleware_1 = require("../middleware/security.middleware");
function createAuthRoutes(authService, audit) {
    return async (fastify) => {
        /**
         * POST /auth/register - Create new user (admin only)
         */
        fastify.post('/register', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()],
        }, async (request, reply) => {
            const { username, password, role, permissions } = (request.body ?? {});
            if (!username || !password) {
                return reply.status(400).send({
                    error: 'Username and password are required',
                });
            }
            const pwError = (0, security_middleware_1.validatePasswordStrength)(password);
            if (pwError)
                return reply.status(400).send({ error: pwError });
            try {
                const { id, apiKey } = await authService.createUser(username, password, role || 'user', permissions);
                audit?.record({ action: 'user.create', actor: request.user.username, ip: request.ip, target: username, ok: true, detail: `role=${role || 'user'}` });
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
         * Tighter HTTP-level rate limit: 10 attempts per 5 minutes per IP.
         */
        fastify.post('/login', {
            config: {
                rateLimit: { max: 10, timeWindow: '5 minutes' },
            },
        }, async (request, reply) => {
            const ip = request.ip ?? 'unknown';
            const { username, password } = (request.body ?? {});
            if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
                return reply.status(400).send({
                    error: 'Username and password are required',
                });
            }
            if (username.length > 64 || password.length > 256) {
                return reply.status(401).send({ error: 'Invalid credentials' });
            }
            // In-process lockout check, per IP and per username
            try {
                (0, security_middleware_1.checkLoginRateLimit)(ip, username);
            }
            catch (err) {
                audit?.record({ action: 'auth.login.locked', actor: username, ip, ok: false });
                return reply.status(429).send({ error: err.message });
            }
            try {
                const result = await authService.authenticate(username, password);
                if ('twoFactorRequired' in result) {
                    // Counters are only reset once the second factor also succeeds.
                    audit?.record({ action: 'auth.login.password', actor: username, ip, ok: true, detail: '2FA pending' });
                    return reply.send({ message: 'Enter your authentication code', twoFactorRequired: true, challenge: result.challenge });
                }
                (0, security_middleware_1.recordLoginSuccess)(ip, username);
                audit?.record({ action: 'auth.login', actor: username, ip, ok: true });
                return reply.send({ message: 'Login successful', token: result.token, user: result.user });
            }
            catch {
                (0, security_middleware_1.recordLoginFailure)(ip, username);
                audit?.record({ action: 'auth.login', actor: username, ip, ok: false });
                // Always return the same message — don't leak "user not found" vs "bad password"
                return reply.status(401).send({ error: 'Invalid credentials' });
            }
        });
        /**
         * POST /auth/login/2fa - Second step: { challenge, code } → session token.
         * `code` is a 6-digit TOTP code or a one-time recovery code.
         */
        fastify.post('/login/2fa', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
            const ip = request.ip ?? 'unknown';
            const { challenge, code } = (request.body ?? {});
            if (typeof challenge !== 'string' || typeof code !== 'string' || challenge.length > 2000 || code.length > 20) {
                return reply.status(400).send({ error: 'challenge and code are required' });
            }
            const username = authService.challengeUsername(challenge) ?? undefined;
            try {
                (0, security_middleware_1.checkLoginRateLimit)(ip, username);
            }
            catch (err) {
                return reply.status(429).send({ error: err.message });
            }
            try {
                const { token, user, usedRecoveryCode } = authService.completeTwoFactorLogin(challenge, code);
                (0, security_middleware_1.recordLoginSuccess)(ip, username);
                audit?.record({ action: 'auth.login', actor: user.username, ip, ok: true, detail: usedRecoveryCode ? '2FA (recovery code)' : '2FA' });
                return reply.send({ message: 'Login successful', token, user, usedRecoveryCode });
            }
            catch (e) {
                (0, security_middleware_1.recordLoginFailure)(ip, username);
                audit?.record({ action: 'auth.login.2fa', actor: username, ip, ok: false });
                return reply.status(401).send({ error: e.message });
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
                lastLoginAt: user.lastLoginAt,
                twoFactorEnabled: Boolean(user.twoFactor?.enabled),
                // whether *this* session passed a second factor
                mfa: Boolean(user.sessionMfa),
            });
        });
        // ── Two-factor authentication (TOTP) ──────────────────────────────
        const twoFactorGuard = { preHandler: (0, auth_middleware_1.authMiddleware)(authService), config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } };
        fastify.get('/2fa', { preHandler: (0, auth_middleware_1.authMiddleware)(authService) }, async (request, reply) => {
            try {
                return reply.send(authService.twoFactorStatus(request.user.id));
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        fastify.post('/2fa/setup', twoFactorGuard, async (request, reply) => {
            try {
                const { secret, otpauthUrl } = authService.beginTwoFactorSetup(request.user.id);
                const qrSvg = await qrcode_1.default.toString(otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
                return reply.send({
                    secret,
                    otpauthUrl,
                    // data: URL so it renders as an <img> under the admin panel's strict CSP
                    qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}`,
                });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        fastify.post('/2fa/enable', twoFactorGuard, async (request, reply) => {
            const { code } = (request.body ?? {});
            try {
                const { recoveryCodes, token } = authService.enableTwoFactor(request.user.id, String(code ?? ''));
                audit?.record({ action: 'user.2fa.enable', actor: request.user.username, ip: request.ip, ok: true });
                return reply.send({ message: 'Two-factor authentication enabled', recoveryCodes, token });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        fastify.post('/2fa/disable', twoFactorGuard, async (request, reply) => {
            const { password, code } = (request.body ?? {});
            try {
                await authService.disableTwoFactor(request.user.id, String(password ?? ''), String(code ?? ''));
                audit?.record({ action: 'user.2fa.disable', actor: request.user.username, ip: request.ip, ok: true });
                return reply.send({ message: 'Two-factor authentication disabled. Sign in again.' });
            }
            catch (e) {
                audit?.record({ action: 'user.2fa.disable', actor: request.user.username, ip: request.ip, ok: false, detail: e.message });
                return reply.status(400).send({ error: e.message });
            }
        });
        fastify.post('/2fa/recovery-codes', twoFactorGuard, async (request, reply) => {
            const { code } = (request.body ?? {});
            try {
                const recoveryCodes = authService.regenerateRecoveryCodes(request.user.id, String(code ?? ''));
                audit?.record({ action: 'user.2fa.recovery-codes', actor: request.user.username, ip: request.ip, ok: true });
                return reply.send({ recoveryCodes });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        /**
         * PUT /auth/me/password - Update own password. Revokes every existing
         * token for the account and returns a fresh one for this session.
         */
        fastify.put('/me/password', {
            preHandler: (0, auth_middleware_1.authMiddleware)(authService),
            config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
        }, async (request, reply) => {
            const { password, currentPassword } = (request.body ?? {});
            // Re-authentication: a stolen session token alone can't take over the account.
            if (!(await authService.verifyPassword(request.user.id, String(currentPassword ?? '')))) {
                audit?.record({ action: 'user.password.self', actor: request.user.username, ip: request.ip, ok: false, detail: 'wrong current password' });
                return reply.status(400).send({ error: 'Current password is incorrect' });
            }
            const pwError = (0, security_middleware_1.validatePasswordStrength)(password);
            if (pwError)
                return reply.status(400).send({ error: pwError });
            try {
                await authService.updatePassword(request.user.id, password);
                audit?.record({ action: 'user.password.self', actor: request.user.username, ip: request.ip, ok: true });
                return reply.send({
                    message: 'Password updated successfully. Other sessions have been signed out.',
                    token: authService.issueToken(request.user.id, Boolean(request.user.sessionMfa)),
                });
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
                audit?.record({ action: 'user.apikey.regenerate', actor: request.user.username, ip: request.ip, ok: true });
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
        }, async (_request, reply) => {
            const users = authService.getAllUsers();
            return reply.send({
                users: users.map((u) => ({
                    id: u.id,
                    username: u.username,
                    role: u.role,
                    permissions: u.permissions,
                    createdAt: u.createdAt,
                    updatedAt: u.updatedAt,
                    lastLoginAt: u.lastLoginAt,
                    twoFactorEnabled: Boolean(u.twoFactor?.enabled),
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
            const { permissions } = (request.body ?? {});
            try {
                const updated = authService.updatePermissions(userId, permissions);
                if (!updated) {
                    return reply.status(404).send({ error: 'User not found' });
                }
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
            audit?.record({ action: 'user.permissions', actor: request.user.username, ip: request.ip, target: `user#${userId}`, ok: true, detail: JSON.stringify(permissions) });
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
            const updates = (request.body ?? {});
            // Lost authenticator: an admin can switch 2FA off for the user.
            if (updates.resetTwoFactor === true) {
                if (!authService.resetTwoFactor(userId))
                    return reply.status(404).send({ error: 'User not found' });
                audit?.record({ action: 'user.2fa.reset', actor: request.user.username, ip: request.ip, target: `user#${userId}`, ok: true });
                if (Object.keys(updates).length === 1)
                    return reply.send({ message: 'Two-factor authentication reset' });
            }
            if (updates.password !== undefined) {
                const pwError = (0, security_middleware_1.validatePasswordStrength)(updates.password);
                if (pwError)
                    return reply.status(400).send({ error: pwError });
            }
            try {
                const updated = await authService.updateUser(userId, updates);
                if (!updated) {
                    return reply.status(404).send({ error: 'User not found' });
                }
                const changed = Object.keys(updates).filter((k) => ['password', 'role', 'permissions'].includes(k)).join(',');
                audit?.record({ action: 'user.update', actor: request.user.username, ip: request.ip, target: `user#${userId}`, ok: true, detail: changed });
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
            try {
                const deleted = authService.deleteUser(userId);
                if (!deleted) {
                    return reply.status(404).send({ error: 'User not found' });
                }
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
            audit?.record({ action: 'user.delete', actor: request.user.username, ip: request.ip, target: `user#${userId}`, ok: true });
            return reply.send({
                message: 'User deleted successfully',
            });
        });
    };
}
//# sourceMappingURL=auth.js.map