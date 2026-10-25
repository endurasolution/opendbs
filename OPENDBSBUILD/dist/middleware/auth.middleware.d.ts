import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService, User } from '../services/auth.service';
export interface AuthenticatedRequest extends FastifyRequest {
    user?: User;
}
/**
 * In-process calls (the shard router talking to this server's own shard via
 * fastify.inject) carry this random per-process token. It never leaves the
 * process: injected requests don't touch the network.
 */
export declare const INTERNAL_TOKEN: string;
export declare const INTERNAL_HEADER = "x-opendbs-internal";
/** True for an in-process request of this server's shard router. */
export declare function isInternalRequest(request: FastifyRequest): boolean;
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