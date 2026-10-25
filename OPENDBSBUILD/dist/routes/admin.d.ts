import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { OpenDBSEngine } from '../engine';
import { AuthService } from '../services/auth.service';
import { AuditService } from '../services/audit.service';
import { AccessKeyService } from '../services/access-key.service';
import { BackupService } from '../services/backup.service';
import { BackupScheduler } from '../services/backup-scheduler';
import { BackupSettingsStore } from '../services/backup-settings';
import { BenchmarkService } from '../services/benchmark.service';
import type { ClusterManager } from '../cluster/cluster';
import type { ShardRouter } from '../sharding/router';
/** Enforces ADMIN_ALLOWED_IPS for both the admin API and the admin UI. */
export declare function adminIpGuard(): (request: FastifyRequest, reply: FastifyReply) => Promise<undefined>;
export interface AdminDeps {
    backupService: BackupService;
    backupScheduler: BackupScheduler;
    backupSettings: BackupSettingsStore;
    benchmark: BenchmarkService;
    cluster?: ClusterManager | null;
    shardRouter?: ShardRouter | null;
}
export declare function createAdminRoutes(authService: AuthService, engine: OpenDBSEngine, audit: AuditService, accessKeys: AccessKeyService, deps: AdminDeps): FastifyPluginAsync;
//# sourceMappingURL=admin.d.ts.map