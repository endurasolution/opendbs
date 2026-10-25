"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTERNAL_HEADER = exports.INTERNAL_TOKEN = void 0;
exports.isInternalRequest = isInternalRequest;
exports.authMiddleware = authMiddleware;
exports.adminMiddleware = adminMiddleware;
exports.checkPermission = checkPermission;
const crypto = __importStar(require("crypto"));
const config_1 = require("../config");
/**
 * In-process calls (the shard router talking to this server's own shard via
 * fastify.inject) carry this random per-process token. It never leaves the
 * process: injected requests don't touch the network.
 */
exports.INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
exports.INTERNAL_HEADER = 'x-opendbs-internal';
const INTERNAL_USER = {
    id: 'internal', username: 'internal:shard-router', passwordHash: '', role: 'admin', permissions: {},
    createdAt: 0, updatedAt: 0,
};
/** True for an in-process request of this server's shard router. */
function isInternalRequest(request) {
    const internal = request.headers[exports.INTERNAL_HEADER];
    return typeof internal === 'string' && internal.length === exports.INTERNAL_TOKEN.length
        && crypto.timingSafeEqual(Buffer.from(internal), Buffer.from(exports.INTERNAL_TOKEN));
}
/**
 * Middleware to authenticate requests with JWT or API key
 */
function authMiddleware(authService) {
    return async (request, reply) => {
        if (isInternalRequest(request)) {
            request.user = INTERNAL_USER;
            return;
        }
        // API key: O(1) lookup by sha256 of the key -- personal user keys and
        // admin-issued access keys (which also enforce an IP allow-list).
        const apiKey = request.headers['x-api-key'];
        if (typeof apiKey === 'string' && apiKey) {
            const result = authService.authenticateApiKeyRequest(apiKey, request.ip);
            if (result && 'user' in result) {
                request.user = result.user;
                return;
            }
            if (result && 'denied' in result) {
                return reply.status(403).send({ error: 'Forbidden', message: result.denied });
            }
        }
        // Check for JWT token in Authorization header
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const user = authService.verifyToken(token);
            if (user) {
                // ADMIN_REQUIRE_2FA: an admin session that hasn't passed a second
                // factor may only use the auth endpoints (to set 2FA up).
                if (config_1.config.admin.require2fa && user.role === 'admin' && !user.sessionMfa) {
                    const url = request.url.split('?')[0];
                    if (!url.startsWith('/api/auth/') && url !== '/api/admin/ui-config') {
                        return reply.status(403).send({
                            error: 'Two-factor authentication required',
                            code: 'MFA_REQUIRED',
                            message: 'Admins must sign in with two-factor authentication. Enable it in Settings, then sign in again.',
                        });
                    }
                }
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
        const database = request.params?.database;
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