import { FastifyPluginAsync } from 'fastify';
import { AuthService } from '../services/auth.service';
import { BackupService } from '../services/backup.service';
export declare function createBackupRoutes(authService: AuthService, backupService: BackupService, dataPath: string, engine: any): FastifyPluginAsync;
//# sourceMappingURL=backup.d.ts.map