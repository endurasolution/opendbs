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
exports.createBackupRoutes = createBackupRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
const config_1 = require("../config");
function createBackupRoutes(authService, backupService, dataPath, engine // Should be OpenDBSEngine but avoiding circular import issues if any, or import it
) {
    return async (fastify) => {
        // ... (keep existing routes)
        /**
         * GET /api/backup/quick
         * Quick backup as JSON or Zip
         */
        fastify.get('/quick', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            const query = request.query;
            const { database, rack } = query;
            if (!database) {
                return reply.status(400).send({ error: 'Database name is required' });
            }
            // Check permissions
            if (user.role !== 'admin') {
                const userPermissions = user.permissions || {};
                if (!userPermissions[database] || !userPermissions[database].includes('read')) {
                    return reply.status(403).send({ error: 'Access denied' });
                }
            }
            if (rack) {
                // Backup specific rack as JSON
                try {
                    const results = engine.find(database, rack, '{}');
                    const documents = results.map((r) => JSON.parse(r));
                    const jsonContent = JSON.stringify(documents, null, 2);
                    reply.header('Content-Type', 'application/json');
                    reply.header('Content-Disposition', `attachment; filename="${database}_${rack}.json"`);
                    return reply.send(jsonContent);
                }
                catch (error) {
                    return reply.status(404).send({ error: error.message });
                }
            }
            else {
                // Backup entire database as Zip of JSONs
                const archiver = await Promise.resolve().then(() => __importStar(require('archiver')));
                const archive = archiver.default('zip', {
                    zlib: { level: 9 }
                });
                reply.header('Content-Type', 'application/zip');
                reply.header('Content-Disposition', `attachment; filename="${database}_quick_backup.zip"`);
                archive.pipe(reply.raw);
                try {
                    const racks = engine.getDatabaseRacks(database);
                    for (const rackInfo of racks) {
                        const rackName = rackInfo.name;
                        const results = engine.find(database, rackName, '{}');
                        const documents = results.map((r) => JSON.parse(r));
                        const jsonContent = JSON.stringify(documents, null, 2);
                        archive.append(jsonContent, { name: `${rackName}.json` });
                    }
                    await archive.finalize();
                }
                catch (error) {
                    // If headers are already sent, we can't change status
                    request.log.error(error);
                    archive.abort();
                }
            }
        });
        /**
         * POST /api/backup/create
         * Create a manual backup
         */
        fastify.post('/create', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            let databases = [];
            if (user.role === 'admin') {
                // Admin: backup all databases
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                if (fs.existsSync(dataPath)) {
                    const items = fs.readdirSync(dataPath);
                    databases = items.filter(item => {
                        const itemPath = path.join(dataPath, item);
                        return fs.statSync(itemPath).isDirectory();
                    });
                }
            }
            else {
                // Regular user: backup only their databases
                databases = Object.keys(user.permissions || {});
            }
            if (databases.length === 0) {
                return reply.status(400).send({ error: 'No databases to backup' });
            }
            try {
                const backupName = await backupService.createBackup(dataPath, databases, user.role === 'admin' ? undefined : user.id);
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
            const { backupName } = request.body;
            if (!backupName) {
                return reply.status(400).send({ error: 'backupName is required' });
            }
            try {
                const result = await backupService.restoreBackup(backupName, dataPath);
                return reply.send({
                    message: 'Backup restored successfully',
                    ...result,
                });
            }
            catch (error) {
                return reply.status(500).send({ error: error.message });
            }
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
                    : backups.filter(b => b.name.includes(`user_${user.id}`));
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
            if (backupName.includes('..') || backupName.includes('/') || !backupName.endsWith('.tar.gz')) {
                return reply.status(400).send({ error: 'Invalid backup name' });
            }
            if (user.role !== 'admin' && !backupName.includes(`user_${user.id}`)) {
                return reply.status(403).send({ error: 'Access denied' });
            }
            const fs = await Promise.resolve().then(() => __importStar(require('fs')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const filePath = path.join(config_1.config.backup.path, backupName);
            if (!fs.existsSync(filePath)) {
                return reply.status(404).send({ error: 'Backup not found' });
            }
            const stream = fs.createReadStream(filePath);
            reply.header('Content-Type', 'application/gzip');
            reply.header('Content-Disposition', `attachment; filename="${backupName}"`);
            return reply.send(stream);
        });
    };
}
//# sourceMappingURL=backup.js.map