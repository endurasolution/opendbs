import { FastifyPluginAsync } from 'fastify';
import { AuthService } from '../services/auth.service';
import { AuditService } from '../services/audit.service';
import { BackupService } from '../services/backup.service';
import { OpenDBSEngine } from '../engine';
export declare function createBackupRoutes(authService: AuthService, backupService: BackupService, dataPath: string, engine: OpenDBSEngine, audit?: AuditService): FastifyPluginAsync;
//# sourceMappingURL=backup.d.ts.map