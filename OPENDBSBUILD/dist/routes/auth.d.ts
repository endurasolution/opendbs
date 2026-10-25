import { FastifyPluginAsync } from 'fastify';
import { AuthService } from '../services/auth.service';
import { AuditService } from '../services/audit.service';
export declare function createAuthRoutes(authService: AuthService, audit?: AuditService): FastifyPluginAsync;
//# sourceMappingURL=auth.d.ts.map