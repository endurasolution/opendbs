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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBackupRoutes = createBackupRoutes;
const fs_1 = __importDefault(require("fs"));
const backup_service_1 = require("../services/backup.service");
const auth_middleware_1 = require("../middleware/auth.middleware");
const security_middleware_1 = require("../middleware/security.middleware");
function createBackupRoutes(authService, backupService, dataPath, engine, audit) {
    return async (fastify) => {
        /**
         * GET /api/backup/quick
         * Quick backup as JSON or Zip
         */
        fastify.get('/quick', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            const { database, rack } = request.query;
            // Both values end up in a file path lookup and a Content-Disposition header.
            if (!database || !(0, security_middleware_1.validateIdentifier)(database)) {
                return reply.status(400).send({ error: 'A valid database name is required' });
            }
            if (rack !== undefined && !(0, security_middleware_1.validateIdentifier)(rack)) {
                return reply.status(400).send({ error: 'Invalid rack name' });
            }
            if (database === '_opendbs_system' && user.role !== 'admin') {
                return reply.status(403).send({ error: 'Access denied' });
            }
            if (!authService.hasPermission(user, database, 'read')) {
                return reply.status(403).send({ error: 'Access denied' });
            }
            if (!engine.getDatabases().includes(database)) {
                return reply.status(404).send({ error: 'Database not found' });
            }
            if (rack) {
                if (engine.getRackCount(database, rack) < 0) {
                    return reply.status(404).send({ error: 'Rack not found' });
                }
                const { results } = engine.query(database, rack, {});
                reply.header('Content-Type', 'application/json');
                reply.header('Content-Disposition', `attachment; filename="${database}_${rack}.json"`);
                return reply.send(JSON.stringify(results, null, 2));
            }
            // Backup entire database as Zip of JSONs
            const archiver = await Promise.resolve().then(() => __importStar(require('archiver')));
            const archive = archiver.default('zip', {
                zlib: { level: 9 }
            });
            reply.header('Content-Type', 'application/zip');
            reply.header('Content-Disposition', `attachment; filename="${database}_quick_backup.zip"`);
            try {
                for (const rackInfo of engine.getDatabaseRacks(database)) {
                    const { results } = engine.query(database, rackInfo.name, {});
                    archive.append(JSON.stringify(results, null, 2), { name: `${rackInfo.name}.json` });
                }
                archive.finalize();
            }
            catch (error) {
                request.log.error(error);
                archive.abort();
            }
            return reply.send(archive);
        });
        /**
         * POST /api/backup/create
         * Create a manual backup
         */
        fastify.post('/create', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
            config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        }, async (request, reply) => {
            const user = request.user;
            let databases;
            if (user.role === 'admin') {
                // Admin: backup all databases
                databases = engine.getDatabases();
            }
            else {
                // Regular user / access key: backup only databases they can read
                databases = authService.accessibleDatabases(user, engine.getDatabases()).filter((db) => authService.hasPermission(user, db, 'read'));
            }
            if (databases.length === 0) {
                return reply.status(400).send({ error: 'No databases to backup' });
            }
            try {
                const backupName = await backupService.createBackup(dataPath, databases, user.role === 'admin' ? undefined : user.id);
                audit?.record({ action: 'backup.create', actor: user.username, ip: request.ip, target: backupName, ok: true });
                return reply.send({
                    message: 'Backup created successfully',
                    backupName,
                    databases,
                    count: databases.length,
                });
            }
            catch (error) {
                return reply.status(500).send({ error: error.message });
            }
        });
        /**
         * POST /api/backup/restore
         * Restore from a backup
         */
        fastify.post('/restore', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            // Only admin can restore
            if (user.role !== 'admin') {
                return reply.status(403).send({ error: 'Admin access required' });
            }
            // Body: { backupName, databases?: string[], replace?: boolean, safetyBackup?: boolean }
            const { backupName, databases, replace, safetyBackup } = (request.body ?? {});
            if (!(0, backup_service_1.isValidBackupName)(backupName)) {
                return reply.status(400).send({ error: 'A valid backupName is required' });
            }
            if (databases !== undefined && (!Array.isArray(databases) || !databases.every((d) => typeof d === 'string' && (0, security_middleware_1.validateIdentifier)(d)))) {
                return reply.status(400).send({ error: 'databases must be an array of database names' });
            }
            try {
                const result = await backupService.restoreBackup(backupName, dataPath, {
                    databases,
                    replace: replace !== false,
                    safetyBackup: safetyBackup !== false,
                });
                audit?.record({
                    action: 'backup.restore', actor: user.username, ip: request.ip, target: backupName, ok: true,
                    detail: `${result.databases.join(',')}${replace === false ? ' (merge)' : ''}${result.safetyBackup ? ` · safety: ${result.safetyBackup}` : ''}`,
                });
                return reply.send({
                    message: 'Backup restored successfully',
                    ...result,
                });
            }
            catch (error) {
                audit?.record({ action: 'backup.restore', actor: user.username, ip: request.ip, target: backupName, ok: false, detail: error.message });
                return reply.status(/not found|Not in this backup|Choose|Invalid|malformed|Not an OpenDBS/.test(error.message) ? 400 : 500).send({ error: error.message });
            }
        });
        /**
         * GET /api/backup/:backupName/contents
         * Manifest (date, OpenDBS version, kind) and databases → racks with sizes.
         */
        fastify.get('/:backupName/contents', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService)] }, async (request, reply) => {
            const user = request.user;
            const { backupName } = request.params;
            if (!(0, backup_service_1.isValidBackupName)(backupName))
                return reply.status(400).send({ error: 'Invalid backup name' });
            if (user.role !== 'admin' && !(0, backup_service_1.isBackupOwnedBy)(backupName, user.id))
                return reply.status(403).send({ error: 'Access denied' });
            try {
                return reply.send(await backupService.getBackupContents(backupName));
            }
            catch (error) {
                return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
            }
        });
        /**
         * POST /api/backup/upload
         * Upload a backup file (raw body, Content-Type: application/gzip). Admin only.
         * The file is fully validated before it is stored; restore it afterwards.
         */
        fastify.register(async (scope) => {
            scope.addContentTypeParser(['application/gzip', 'application/x-gzip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 1024 }, (_req, body, done) => done(null, body));
            scope.post('/upload', {
                preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
                bodyLimit: 1024 * 1024 * 1024,
                config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
            }, async (request, reply) => {
                const user = request.user;
                if (user.role !== 'admin')
                    return reply.status(403).send({ error: 'Admin access required' });
                if (!Buffer.isBuffer(request.body)) {
                    return reply.status(415).send({ error: 'Send the backup file as the raw body with Content-Type: application/gzip' });
                }
                try {
                    const name = await backupService.importBackup(request.body);
                    audit?.record({ action: 'backup.upload', actor: user.username, ip: request.ip, target: name, ok: true, detail: `${request.body.length} bytes` });
                    return reply.status(201).send({ message: 'Backup uploaded', backupName: name, contents: await backupService.getBackupContents(name) });
                }
                catch (error) {
                    audit?.record({ action: 'backup.upload', actor: user.username, ip: request.ip, ok: false, detail: error.message });
                    return reply.status(400).send({ error: error.message });
                }
            });
        });
        /**
         * DELETE /api/backup/:backupName
         * Delete a local backup file. Admin only.
         */
        fastify.delete('/:backupName', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService)] }, async (request, reply) => {
            const user = request.user;
            if (user.role !== 'admin')
                return reply.status(403).send({ error: 'Admin access required' });
            const { backupName } = request.params;
            if (!(0, backup_service_1.isValidBackupName)(backupName))
                return reply.status(400).send({ error: 'Invalid backup name' });
            if (!backupService.deleteBackup(backupName))
                return reply.status(404).send({ error: 'Backup not found' });
            audit?.record({ action: 'backup.delete', actor: user.username, ip: request.ip, target: backupName, ok: true });
            return reply.send({ message: 'Backup deleted', backupName });
        });
        /**
         * GET /api/backup/list
         * List available backups
         */
        fastify.get('/list', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            try {
                const backups = await backupService.listBackups();
                // Filter backups for non-admin users
                const filtered = user.role === 'admin'
                    ? backups
                    : backups.filter(b => (0, backup_service_1.isBackupOwnedBy)(b.name, user.id));
                return reply.send({
                    backups: filtered,
                    count: filtered.length,
                });
            }
            catch (error) {
                return reply.status(500).send({ error: error.message });
            }
        });
        /**
         * GET /api/backup/:backupName/download
         * Download a backup file
         */
        fastify.get('/:backupName/download', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            const { backupName } = request.params;
            if (!(0, backup_service_1.isValidBackupName)(backupName)) {
                return reply.status(400).send({ error: 'Invalid backup name' });
            }
            if (user.role !== 'admin' && !(0, backup_service_1.isBackupOwnedBy)(backupName, user.id)) {
                return reply.status(403).send({ error: 'Access denied' });
            }
            const filePath = backupService.getBackupPath(backupName);
            if (!filePath) {
                return reply.status(404).send({ error: 'Backup not found' });
            }
            reply.header('Content-Type', 'application/gzip');
            reply.header('Content-Disposition', `attachment; filename="${backupName}"`);
            return reply.send(fs_1.default.createReadStream(filePath));
        });
    };
}
//# sourceMappingURL=backup.js.map