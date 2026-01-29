import { FastifyPluginAsync } from 'fastify';
import { AuthService } from '../services/auth.service';
import { SQLBridgeService } from '../services/sql-bridge.service';
export declare function createSQLRoutes(authService: AuthService, sqlBridge: SQLBridgeService): FastifyPluginAsync;
//# sourceMappingURL=sql.d.ts.map