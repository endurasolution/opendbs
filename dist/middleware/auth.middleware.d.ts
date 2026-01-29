import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService, User } from '../services/auth.service';
export interface AuthenticatedRequest extends FastifyRequest {
    user?: User;
}
/**
 * Middleware to authenticate requests with JWT or API key
 */
export declare function authMiddleware(authService: AuthService): (request: AuthenticatedRequest, reply: FastifyReply) => Promise<undefined>;
/**
 * Middleware to check if user is admin
 */
export declare function adminMiddleware(): (request: AuthenticatedRequest, reply: FastifyReply) => Promise<undefined>;
/**
 * Middleware to check database permission
 */
export declare function checkPermission(authService: AuthService, action: 'read' | 'write' | 'delete'): (request: AuthenticatedRequest, reply: FastifyReply) => Promise<undefined>;
//# sourceMappingURL=auth.middleware.d.ts.map