"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.adminMiddleware = adminMiddleware;
exports.checkPermission = checkPermission;
const security_middleware_1 = require("./security.middleware");
/**
 * Middleware to authenticate requests with JWT or API key
 */
function authMiddleware(authService) {
    return async (request, reply) => {
        // Check for API key in header (timing-safe comparison prevents oracle attacks)
        const apiKey = request.headers['x-api-key'];
        if (apiKey) {
            const allUsers = authService.getAllUsers();
            const matchedUser = allUsers.find((u) => u.apiKey && (0, security_middleware_1.timingSafeEqual)(u.apiKey, apiKey));
            if (matchedUser) {
                request.user = matchedUser;
                return;
            }
        }
        // Check for JWT token in Authorization header
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const user = authService.verifyToken(token);
            if (user) {
                request.user = user;
                return;
            }
        }
        return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid authentication required (JWT token or API key)',
        });
    };
}
/**
 * Middleware to check if user is admin
 */
function adminMiddleware() {
    return async (request, reply) => {
        if (!request.user || request.user.role !== 'admin') {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'Admin access required',
            });
        }
    };
}
/**
 * Middleware to check database permission
 */
function checkPermission(authService, action) {
    return async (request, reply) => {
        if (!request.user) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }
        const database = request.params.database;
        if (!database) {
            // If no database in params, allow (e.g., list all databases)
            return;
        }
        // Don't allow access to system database
        if (database === '_opendbs_system' && request.user.role !== 'admin') {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'Cannot access system database',
            });
        }
        if (!authService.hasPermission(request.user, database, action)) {
            return reply.status(403).send({
                error: 'Forbidden',
                message: `No ${action} permission for database '${database}'`,
            });
        }
    };
}
//# sourceMappingURL=auth.middleware.js.map