"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const path_1 = __importDefault(require("path"));
const static_1 = __importDefault(require("@fastify/static"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const config_1 = require("./config");
const engine_1 = require("./engine");
const auth_service_1 = require("./services/auth.service");
const auth_1 = require("./routes/auth");
const auth_middleware_1 = require("./middleware/auth.middleware");
const security_middleware_1 = require("./middleware/security.middleware");
const search_1 = require("./routes/search");
const ai_datasets_1 = require("./routes/ai-datasets");
const backup_1 = require("./routes/backup");
const backup_service_1 = require("./services/backup.service");
const backup_scheduler_1 = require("./services/backup-scheduler");
const sql_bridge_service_1 = require("./services/sql-bridge.service");
const sql_1 = require("./routes/sql");
const settings_1 = require("./routes/settings");
async function start() {
    const fastify = (0, fastify_1.default)({
        logger: config_1.config.nodeEnv !== 'test',
        bodyLimit: 1048576 * 50,
        // Mask internal error details from HTTP responses in production
        disableRequestLogging: config_1.config.nodeEnv === 'production',
    });
    // ── Security headers ──────────────────────────────────────────────────
    await fastify.register(helmet_1.default, {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"], // needed by web UI
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"],
            },
        },
        crossOriginEmbedderPolicy: false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });
    // ── CORS ──────────────────────────────────────────────────────────────
    const allowedOrigins = process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
        : (config_1.config.nodeEnv === 'production' ? [] : ['*']);
    await fastify.register(cors_1.default, {
        origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
        credentials: !allowedOrigins.includes('*'),
        maxAge: 86400, // preflight cache 24 h
    });
    // ── Global rate limiting ──────────────────────────────────────────────
    await fastify.register(rate_limit_1.default, {
        global: true,
        max: 300,
        timeWindow: '1 minute',
        errorResponseBuilder: (_req, context) => ({
            error: 'Too many requests',
            message: `Rate limit exceeded. Retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
            retryAfter: Math.ceil(context.ttl / 1000),
        }),
        skipOnError: false,
    });
    // ── Global identifier-parameter guard ─────────────────────────────────
    // Runs on every route that has :database or :rack params — prevents path
    // traversal and injection via URL parameters before any handler executes.
    fastify.addHook('preHandler', (0, security_middleware_1.identifierParamGuard)());
    // ── Global error handler — no stack traces in responses ───────────────
    fastify.setErrorHandler((error, _request, reply) => {
        const statusCode = error.statusCode ?? 500;
        const message = config_1.config.nodeEnv === 'production' && statusCode >= 500
            ? 'Internal server error'
            : error.message ?? 'Unknown error';
        reply.status(statusCode).send({ error: message });
    });
    // Initialize engine and auth service
    const engine = new engine_1.OpenDBSEngine(config_1.config.dbPath);
    const authService = new auth_service_1.AuthService(engine);
    // Initialize backup service
    const backupService = new backup_service_1.BackupService(config_1.config.backup);
    const backupScheduler = new backup_scheduler_1.BackupScheduler(config_1.config.backup, backupService, config_1.config.dbPath);
    // Initialize SQL bridge service
    const sqlBridge = new sql_bridge_service_1.SQLBridgeService(engine, config_1.config.sql.mysql);
    // Register Routes
    await fastify.register((0, ai_datasets_1.createAiDatasetRoutes)(authService, engine), { prefix: '/api/ai/datasets' });
    await fastify.register((0, search_1.createSearchRoutes)(authService, engine), { prefix: '/api/databases/:database/racks/:rack/search' });
    await fastify.register((0, backup_1.createBackupRoutes)(authService, backupService, config_1.config.dbPath, engine), { prefix: '/api/backup' });
    await fastify.register((0, sql_1.createSQLRoutes)(authService, sqlBridge), { prefix: '/api/sql' });
    await fastify.register((0, settings_1.createSettingsRoutes)(authService), { prefix: '/api/settings' });
    // Ensure default admin exists
    await authService.ensureAdminExists();
    // Start backup scheduler
    backupScheduler.start();
    // Web Interface
    if (config_1.config.webInterfaceEnabled) {
        await fastify.register(static_1.default, {
            root: path_1.default.join(__dirname, '../public'),
            prefix: '/web/',
            redirect: true,
        });
        console.log('🌐 Web Interface enabled at /web/');
    }
    // Public routes (no auth required)
    fastify.get('/health', async (_request, reply) => {
        // Do NOT expose version or internal info to unauthenticated callers in prod
        reply.header('Cache-Control', 'no-store');
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
        };
    });
    // Auth routes (tighter rate limit — login brute force protection at HTTP layer)
    await fastify.register((0, auth_1.createAuthRoutes)(authService), { prefix: '/api/auth' });
    // Stricter limit specifically for login (handled inside createAuthRoutes via config key)
    // Protected routes - Database operations
    fastify.post('/api/databases', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService)] }, async (request, reply) => {
        const { name } = request.body;
        if (!name) {
            return reply.status(400).send({ error: 'Database name is required' });
        }
        // Prevent creating system database
        if (name === '_opendbs_system') {
            return reply.status(403).send({ error: 'Cannot create system database' });
        }
        const created = engine.createDatabase(name);
        // Grant creator full permissions
        if (created && request.user.role !== 'admin') {
            const permissions = request.user.permissions || {};
            permissions[name] = ['read', 'write', 'delete'];
            authService.updatePermissions(request.user.id, permissions);
        }
        return created
            ? reply.status(201).send({ message: 'Database created', database: name })
            : reply.status(409).send({ error: 'Database already exists' });
    });
    fastify.get('/api/databases', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService)] }, async (request, reply) => {
        const query = request.query;
        const includeRacks = query.include_racks === 'true';
        let allowedDbs = [];
        if (request.user.role === 'admin') {
            allowedDbs = engine.getDatabases();
        }
        else {
            allowedDbs = Object.keys(request.user.permissions || {});
        }
        if (includeRacks) {
            const result = allowedDbs.map(dbName => {
                return {
                    name: dbName,
                    racks: engine.getDatabaseRacks(dbName)
                };
            });
            return reply.send({
                databases: result,
                count: result.length
            });
        }
        const response = {
            databases: allowedDbs,
            count: allowedDbs.length,
        };
        if (request.user.role === 'admin') {
            response.stats = JSON.parse(engine.getStats());
        }
        return reply.send(response);
    });
    fastify.delete('/api/databases/:database', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'delete'),
        ],
    }, async (request, reply) => {
        const { database } = request.params;
        // Prevent deleting system database
        if (database === '_opendbs_system') {
            return reply.status(403).send({ error: 'Cannot delete system database' });
        }
        const deleted = engine.deleteDatabase(database);
        return deleted
            ? reply.status(200).send({ message: 'Database deleted', database })
            : reply.status(404).send({ error: 'Database not found' });
    });
    // Rack routes
    fastify.post('/api/databases/:database/racks', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'write'),
        ],
    }, async (request, reply) => {
        const { database } = request.params;
        const { name, type, schema } = request.body;
        if (!name) {
            return reply.status(400).send({ error: 'Rack name is required' });
        }
        // Validate type
        const rackType = type || 'nosql';
        if (rackType !== 'sql' && rackType !== 'nosql') {
            return reply.status(400).send({ error: 'Type must be "sql" or "nosql"' });
        }
        try {
            const created = engine.createRack(database, name, rackType, schema);
            return created
                ? reply.status(201).send({
                    message: 'Rack created',
                    database,
                    rack: name,
                    type: rackType,
                    schema: schema || null
                })
                : reply.status(409).send({ error: 'Rack already exists' });
        }
        catch (error) {
            return reply.status(400).send({ error: error.message });
        }
    });
    fastify.post('/api/databases/:database/racks/:rack/indexes', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'write'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        const { field } = request.body;
        if (!field) {
            return reply.status(400).send({ error: 'Field name is required' });
        }
        try {
            const created = engine.createIndex(database, rack, field);
            return created
                ? reply.status(201).send({ message: 'Index created', database, rack, field })
                : reply.status(500).send({ error: 'Failed to create index' });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks/:rack/indexes', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'read'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        try {
            const indexes = engine.getIndexes(database, rack);
            return reply.send({ indexes, count: indexes.length });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'read'),
        ],
    }, async (request, reply) => {
        const { database } = request.params;
        const racks = engine.getDatabaseRacks(database);
        return reply.send({
            database,
            racks,
            count: racks.length
        });
    });
    fastify.get('/api/databases/:database/racks/:rack/count', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'read'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        const count = engine.getRackCount(database, rack);
        if (count === -1) {
            return reply.status(404).send({ error: 'Rack not found' });
        }
        return reply.send({
            database,
            rack,
            count
        });
    });
    // Get database statistics (rack count and document counts)
    fastify.get('/api/databases/:database/stats', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'read'),
        ],
    }, async (request, reply) => {
        const { database } = request.params;
        try {
            const stats = engine.getDatabaseStats(database);
            return reply.send({
                database,
                totalRacks: stats.totalRacks,
                totalDocuments: stats.totalDocuments,
                racks: stats.racks
            });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.delete('/api/databases/:database/racks/:rack', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'delete'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        const deleted = engine.deleteRack(database, rack);
        return deleted
            ? reply.status(200).send({ message: 'Rack deleted', database, rack })
            : reply.status(404).send({ error: 'Rack not found' });
    });
    // Document routes - INSERT
    fastify.post('/api/databases/:database/racks/:rack/documents', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'write'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        let data = request.body;
        // Handle case where body might be a string (e.g. if content-type parsing failed)
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            }
            catch (e) {
                return reply.status(400).send({ error: 'Invalid JSON body' });
            }
        }
        if (Array.isArray(data)) {
            // Batch insert
            const ids = engine.insertMany(database, rack, data);
            return reply.status(201).send({
                message: 'Documents inserted',
                ids,
                count: ids.length,
                database,
                rack,
            });
        }
        else {
            // Single insert
            try {
                const id = engine.insert(database, rack, JSON.stringify(data), 'nosql');
                return reply.status(201).send({
                    message: 'Document inserted',
                    id,
                    database,
                    rack,
                });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        }
    });
    // Document routes - QUERY
    fastify.get('/api/databases/:database/racks/:rack/documents', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'read'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        const queryParams = request.query;
        const query = {};
        let populate = false;
        let skip = 0;
        let limit;
        let sortField;
        let sortOrder = 'asc';
        for (const [key, value] of Object.entries(queryParams)) {
            if (key === 'populate') {
                populate = value === 'true';
                continue;
            }
            if (key === '_skip') {
                skip = Math.max(0, parseInt(value) || 0);
                continue;
            }
            if (key === '_limit') {
                limit = Math.max(1, parseInt(value) || 100);
                continue;
            }
            if (key === '_sort') {
                sortField = value;
                continue;
            }
            if (key === '_order') {
                sortOrder = value === 'desc' ? 'desc' : 'asc';
                continue;
            }
            if (!isNaN(Number(value)) && value !== '') {
                query[key] = Number(value);
            }
            else if (value === 'true' || value === 'false') {
                query[key] = value === 'true';
            }
            else {
                query[key] = value;
            }
        }
        const findOptions = {
            skip,
            limit,
            populate,
            sort: sortField ? { field: sortField, order: sortOrder } : undefined,
        };
        try {
            const results = engine.find(database, rack, JSON.stringify(query), findOptions);
            return reply.send({
                results: results.map((r) => JSON.parse(r)),
                count: results.length,
                skip,
                limit: limit ?? null,
            });
        }
        catch (error) {
            return reply.status(400).send({ error: error.message });
        }
    });
    // Document routes - UPDATE/UPSERT
    fastify.put('/api/databases/:database/racks/:rack/documents/:id', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'write'),
        ],
    }, async (request, reply) => {
        const { database, rack, id } = request.params;
        const data = request.body;
        // Try to update first
        const updated = engine.update(database, rack, id, JSON.stringify(data));
        if (!updated) {
            // Document doesn't exist — insert with engine-generated ID (requested ID not guaranteed)
            try {
                const dataObj = typeof data === 'object' && data !== null ? data : {};
                const insertedId = engine.insert(database, rack, JSON.stringify(dataObj), 'nosql');
                return reply.status(201).send({
                    message: 'Document created (upsert)',
                    id: insertedId,
                    requestedId: id,
                    upserted: true,
                });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        }
        return reply.send({ message: 'Document updated', id, upserted: false });
    });
    // Document routes - GET by ID
    fastify.get('/api/databases/:database/racks/:rack/documents/:id', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'read'),
        ],
    }, async (request, reply) => {
        const { database, rack, id } = request.params;
        try {
            const results = engine.find(database, rack, JSON.stringify({ id }));
            if (results.length === 0) {
                return reply.status(404).send({ error: 'Document not found' });
            }
            return reply.send(JSON.parse(results[0]));
        }
        catch (error) {
            return reply.status(400).send({ error: error.message });
        }
    });
    // Document routes - PATCH (partial update / merge)
    fastify.patch('/api/databases/:database/racks/:rack/documents/:id', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'write'),
        ],
    }, async (request, reply) => {
        const { database, rack, id } = request.params;
        const data = request.body;
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return reply.status(400).send({ error: 'Request body must be a JSON object' });
        }
        try {
            const patched = engine.patch(database, rack, id, JSON.stringify(data));
            if (!patched) {
                return reply.status(404).send({ error: 'Document not found' });
            }
            return reply.send({ message: 'Document patched', id });
        }
        catch (error) {
            return reply.status(400).send({ error: error.message });
        }
    });
    // Document routes - DELETE
    fastify.delete('/api/databases/:database/racks/:rack/documents/:id', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'delete'),
        ],
    }, async (request, reply) => {
        const { database, rack, id } = request.params;
        const deleted = engine.delete(database, rack, id);
        if (!deleted) {
            return reply.status(404).send({ error: 'Document not found' });
        }
        return reply.send({ message: 'Document deleted', id });
    });
    fastify.delete('/api/databases/:database/racks/:rack/clear', {
        preHandler: [
            (0, auth_middleware_1.authMiddleware)(authService),
            (0, auth_middleware_1.checkPermission)(authService, 'delete'),
        ],
    }, async (request, reply) => {
        const { database, rack } = request.params;
        const cleared = engine.clearRack(database, rack);
        return cleared
            ? reply.status(200).send({ message: 'Rack cleared', database, rack })
            : reply.status(404).send({ error: 'Rack not found' });
    });
    // Stats endpoint (admin only)
    fastify.get('/api/stats', async (request, reply) => {
        // Check for API key or token
        const apiKey = request.headers['x-api-key'];
        const authHeader = request.headers.authorization;
        let user = null;
        if (apiKey) {
            user = authService.authenticateWithApiKey(apiKey);
        }
        else if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            user = authService.verifyToken(token);
        }
        if (!user || user.role !== 'admin') {
            return reply.status(403).send({
                error: 'Admin access required',
            });
        }
        return JSON.parse(engine.getStats());
    });
    // Start server
    try {
        await fastify.listen({
            port: config_1.config.port,
            host: config_1.config.host,
        });
        const modeIndicator = '🔄 SQL + NoSQL';
        const portInfo = `${config_1.config.port}`;
        console.log(`
    ╔═══════════════════════════════════════╗
    ║                                       ║
    ║         OpenDBS Server Started        ║
    ║                                       ║
    ║  🚀 Server running on:                ║
    ║     http://${config_1.config.host}:${portInfo.padEnd(18)}║
    ║                                       ║
    ║  🔐 Authentication: ENABLED           ║
    ║  ⚡ Mode: ${modeIndicator.padEnd(24)}║
    ║  💾 Storage: ${config_1.config.dbPath.padEnd(23)}║
    ║                                       ║
    ║  📊 Endpoints:                        ║
    ║     GET  /health                      ║
    ║     POST /api/auth/login              ║
    ║     POST /api/databases               ║
    ║     GET  /api/databases/:db/stats     ║
    ║     GET  /api/databases/:db/racks/:r  ║
    ║          ack/count                    ║
    ║     POST /api/sql/credentials         ║
    ║     POST /api/sql/:db/execute         ║
    ║                                       ║
    ╚═══════════════════════════════════════╝
    `);
    }
    catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}
start();
//# sourceMappingURL=index.js.map