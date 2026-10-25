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
const version_1 = require("./version");
const engine_1 = require("./engine");
const auth_service_1 = require("./services/auth.service");
const audit_service_1 = require("./services/audit.service");
const access_key_service_1 = require("./services/access-key.service");
const backup_settings_1 = require("./services/backup-settings");
const benchmark_service_1 = require("./services/benchmark.service");
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
const admin_1 = require("./routes/admin");
const cluster_1 = require("./cluster/cluster");
const idempotency_1 = require("./services/idempotency");
const router_1 = require("./sharding/router");
const SYSTEM_DB = '_opendbs_system';
const RESERVED_ADMIN_SEGMENTS = new Set(['api', 'web', 'health']);
/**
 * ADMIN_PANEL_PATH rules: 1–4 segments of letters, numbers, "-" or "_"
 * (each up to 64 chars), not starting with a path the server already uses.
 * Returns an error message, or null when the path is usable.
 */
function checkAdminPath(p) {
    const segments = p.split('/').slice(1);
    if (segments.length === 0 || segments.length > 4 || segments.some((s) => !/^[a-zA-Z0-9_-]{1,64}$/.test(s))) {
        return `ADMIN_PANEL_PATH "${p}" is invalid. Use letters, numbers, "-" or "_", e.g. /admin, /ops-7f3a or /company/console`;
    }
    if (RESERVED_ADMIN_SEGMENTS.has(segments[0].toLowerCase())) {
        return `ADMIN_PANEL_PATH "${p}" conflicts with /${segments[0]}, which the server already uses. Pick another path.`;
    }
    return null;
}
async function start() {
    const fastify = (0, fastify_1.default)({
        // Per-request logs are emitted at info level; in production default to
        // warn so they're off unless LOG_LEVEL asks for more than info.
        logger: config_1.config.nodeEnv === 'test'
            ? false
            : { level: config_1.config.nodeEnv === 'production' && config_1.config.logLevel === 'info' ? 'warn' : config_1.config.logLevel },
        bodyLimit: 1048576 * Math.max(1, config_1.config.bodyLimitMB),
        // Only trust X-Forwarded-* when actually behind a reverse proxy;
        // otherwise clients could spoof their IP past rate limits.
        trustProxy: config_1.config.trustProxy,
        requestTimeout: 120_000,
        connectionTimeout: 0,
        keepAliveTimeout: 72_000,
        routerOptions: { maxParamLength: 200 },
        return503OnClosing: true,
    });
    // ── Security headers ──────────────────────────────────────────────────
    await fastify.register(helmet_1.default, {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The /web UI loads Bootstrap, SweetAlert2 and CodeMirror from these CDNs.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
            },
        },
        crossOriginEmbedderPolicy: false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });
    // ── CORS ──────────────────────────────────────────────────────────────
    const allowedOrigins = config_1.config.corsOrigins.length > 0
        ? config_1.config.corsOrigins
        : (config_1.config.nodeEnv === 'production' ? [] : ['*']);
    await fastify.register(cors_1.default, {
        origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'Idempotency-Key'],
        credentials: !allowedOrigins.includes('*'),
        maxAge: 86400, // preflight cache 24 h
    });
    // ── Cluster: requests a replica forwarded keep the real client IP (rate limits, IP allow-lists, audit) ──
    let cluster = null;
    fastify.addHook('onRequest', async (request) => { cluster?.adoptForwardedIp(request); });
    // ── Global rate limiting ──────────────────────────────────────────────
    // Not for shard-router traffic: in-process calls, and a router's calls made with an admin or access key.
    let isShardRouterCall = () => false;
    await fastify.register(rate_limit_1.default, {
        global: true,
        allowList: (req) => (0, auth_middleware_1.isInternalRequest)(req) || (Boolean(req.headers[router_1.SHARD_HEADER]) && isShardRouterCall(req)),
        max: config_1.config.rateLimitMax,
        timeWindow: '1 minute',
        errorResponseBuilder: (_req, context) => ({
            statusCode: 429,
            error: 'Too many requests',
            message: `Rate limit exceeded. Retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
            retryAfter: Math.ceil(context.ttl / 1000),
        }),
        skipOnError: false,
    });
    // ── Global identifier-parameter guard ─────────────────────────────────
    // Runs on every route that has :database / :rack / :name / :field params —
    // prevents path traversal and injection via URL parameters before any
    // handler executes.
    fastify.addHook('preHandler', (0, security_middleware_1.identifierParamGuard)());
    // ── Global error handler — no stack traces in responses ───────────────
    fastify.setErrorHandler((error, request, reply) => {
        const statusCode = error.statusCode ?? 500;
        if (statusCode >= 500)
            request.log.error(error);
        const message = config_1.config.nodeEnv === 'production' && statusCode >= 500
            ? 'Internal server error'
            : error.message ?? 'Unknown error';
        reply.status(statusCode).send({ error: message });
    });
    // Initialize engine and auth service
    const engine = new engine_1.OpenDBSEngine(config_1.config.dbPath);
    // Safe write retries (Idempotency-Key): the recorded response joins the write's own commit,
    // so this hook must run before the durability hook below.
    // Idempotency records belong to the verified caller (resolved once authService exists).
    let identifyCaller = () => null;
    const idempotency = new idempotency_1.IdempotencyService(engine, (req) => identifyCaller(req));
    fastify.addHook('onSend', async (request, reply, payload) => {
        await idempotency.record(request, reply, payload);
        return payload;
    });
    // Durability (group commit): a request that changed data is answered only
    // after its WAL records are fsynced. Concurrent requests share one fsync.
    fastify.addHook('onSend', async (request, reply, payload) => {
        if (request.method === 'GET' || request.method === 'HEAD' || !engine.hasUnsyncedWrites())
            return payload;
        try {
            await engine.syncWal();
            return payload;
        }
        catch (err) {
            request.log.error({ err }, 'WAL fsync failed');
            reply.code(500);
            reply.header('content-type', 'application/json; charset=utf-8');
            return JSON.stringify({ error: 'The change could not be made durable (disk error). It may not survive a crash.' });
        }
    });
    const authService = new auth_service_1.AuthService(engine);
    const accessKeys = new access_key_service_1.AccessKeyService(engine);
    authService.setAccessKeyAuthenticator(accessKeys);
    identifyCaller = (req) => {
        const key = req.headers['x-api-key'];
        if (typeof key === 'string' && key) {
            const r = authService.authenticateApiKeyRequest(key, req.ip);
            if (r && 'user' in r)
                return r.user.accessKeyId ? `key:${r.user.accessKeyId}` : `user:${r.user.id}`;
            return null;
        }
        const h = req.headers.authorization;
        if (typeof h === 'string' && h.startsWith('Bearer ')) {
            const u = authService.verifyToken(h.substring(7));
            return u ? `user:${u.id}` : null;
        }
        return null;
    };
    isShardRouterCall = (req) => {
        const key = req.headers['x-api-key'];
        if (typeof key !== 'string' || !key)
            return false;
        const r = authService.authenticateApiKeyRequest(key, req.ip);
        // An admin's key, or an access key (issued by an admin for exactly this kind of use).
        return Boolean(r && 'user' in r && (r.user.role === 'admin' || r.user.accessKeyId));
    };
    const audit = new audit_service_1.AuditService(config_1.config.dbPath);
    // Initialize backup service (coordinates with the engine for consistent snapshots / safe restores).
    // Settings saved from the admin panel override the BACKUP_* values in .env.
    const backupSettings = new backup_settings_1.BackupSettingsStore(config_1.config.dbPath, authService.secretBox);
    const backupService = new backup_service_1.BackupService(backupSettings.load(config_1.config.backup), engine);
    // ── Replication / failover ──
    // Registered before the API routes: replicas forward writes to the primary.
    if (config_1.config.cluster.enabled) {
        cluster = new cluster_1.ClusterManager(engine, {
            secrets: {
                get: () => ({ jwt: authService.tokenSecret, master: authService.secretBox.keyHex() }),
                adopt: (s) => { authService.adoptTokenSecret(s.jwt); authService.secretBox.setKeyHex(s.master); },
            },
            // A full resync replaces this node's data: keep a copy first if it has any.
            beforeWipe: async () => {
                if (engine.userDocumentCount() === 0)
                    return;
                const name = await backupService.createBackup(config_1.config.dbPath, engine.getDatabases(), undefined, 'prerestore');
                console.log(`💾 Saved this node's data to ${name} before replacing it with the primary's`);
            },
        });
        cluster.register(fastify);
    }
    // After the forwarding hook: on replicas the primary handles repeats.
    idempotency.register(fastify);
    // ── Sharding: shard endpoints, and routing of sharded racks to their shards ──
    const shardRouter = new router_1.ShardRouter(engine, authService);
    shardRouter.register(fastify);
    const backupScheduler = new backup_scheduler_1.BackupScheduler(config_1.config.backup, backupService, config_1.config.dbPath);
    const benchmark = new benchmark_service_1.BenchmarkService(config_1.config.dbPath);
    // Initialize SQL bridge service
    const sqlBridge = new sql_bridge_service_1.SQLBridgeService(engine, config_1.config.sql.mysql);
    sqlBridge.setShardRouter(shardRouter);
    // Register Routes
    await fastify.register((0, ai_datasets_1.createAiDatasetRoutes)(authService, engine), { prefix: '/api/ai/datasets' });
    await fastify.register((0, search_1.createSearchRoutes)(authService, engine), { prefix: '/api/databases/:database/racks/:rack/search' });
    await fastify.register((0, backup_1.createBackupRoutes)(authService, backupService, config_1.config.dbPath, engine, audit), { prefix: '/api/backup' });
    await fastify.register((0, sql_1.createSQLRoutes)(authService, sqlBridge), { prefix: '/api/sql' });
    await fastify.register((0, settings_1.createSettingsRoutes)(authService, audit), { prefix: '/api/settings' });
    // Ensure default admin exists
    await authService.ensureAdminExists();
    cluster?.start();
    // Start backup scheduler
    backupScheduler.start();
    // Web Interface
    if (config_1.config.webInterfaceEnabled) {
        await fastify.register(static_1.default, {
            root: path_1.default.join(__dirname, '../public'),
            prefix: '/web/',
            redirect: true,
            index: ['index.html'],
            // public/admin is served separately (and only when enabled)
            allowedPath: (pathName) => !pathName.startsWith('/admin'),
        });
        fastify.get('/', async (_req, reply) => reply.redirect('/web/'));
        // The static plugin only serves "/web/…"; make the bare prefix work too.
        fastify.get('/web', async (_req, reply) => reply.redirect('/web/'));
        console.log('🌐 Web Interface enabled at /web/');
    }
    // Admin panel -- served at ADMIN_PANEL_PATH (e.g. /admin, /ops-7f3a or /company/console).
    const adminPath = config_1.config.admin.path;
    const adminPathError = config_1.config.admin.enabled ? checkAdminPath(adminPath) : null;
    if (adminPathError) {
        // Fail closed for the panel only: the database API keeps running.
        console.error(`❌ Admin panel NOT started: ${adminPathError}`);
    }
    if (config_1.config.admin.enabled && !adminPathError) {
        await fastify.register((0, admin_1.createAdminRoutes)(authService, engine, audit, accessKeys, { backupService, backupScheduler, backupSettings, benchmark, cluster, shardRouter }), { prefix: '/api/admin' });
        await fastify.register(async (scope) => {
            scope.addHook('onRequest', (0, admin_1.adminIpGuard)());
            // "/admin" → "/admin/" (the static plugin only matches the trailing-slash prefix).
            scope.get(adminPath, async (_req, reply) => reply.redirect(`${adminPath}/`));
            // Stricter CSP than /web: the admin UI has no inline script and no third-party code.
            scope.addHook('onSend', async (_req, reply, payload) => {
                reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
                    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
                reply.header('Cache-Control', 'no-store');
                reply.header('X-Robots-Tag', 'noindex, nofollow');
                reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
                reply.header('Cross-Origin-Opener-Policy', 'same-origin');
                reply.header('Cross-Origin-Resource-Policy', 'same-origin');
                return payload;
            });
            await scope.register(static_1.default, {
                root: path_1.default.join(__dirname, '../public/admin'),
                prefix: `${adminPath}/`,
                redirect: true,
                decorateReply: false,
                index: ['index.html'],
            });
        });
        console.log(`🛡️  Admin panel enabled at ${adminPath}/${config_1.config.admin.allowedIps.length ? ` (IP allow-list: ${config_1.config.admin.allowedIps.join(', ')})` : ''}`);
    }
    // Public routes (no auth required)
    fastify.get('/health', async (_request, reply) => {
        // Version only when EXPOSE_VERSION allows it (off by default in production).
        reply.header('Cache-Control', 'no-store');
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            ...(config_1.config.exposeVersion ? { version: version_1.VERSION.version } : {}),
        };
    });
    // GET /api/version — public when EXPOSE_VERSION is on, otherwise login (JWT or API key) required.
    fastify.get('/api/version', config_1.config.exposeVersion ? {} : { preHandler: [(0, auth_middleware_1.authMiddleware)(authService)] }, async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return version_1.VERSION;
    });
    // Auth routes (tighter rate limit — login brute force protection at HTTP layer)
    await fastify.register((0, auth_1.createAuthRoutes)(authService, audit), { prefix: '/api/auth' });
    const auth = (0, auth_middleware_1.authMiddleware)(authService);
    const can = (action) => ({ preHandler: [auth, (0, auth_middleware_1.checkPermission)(authService, action)] });
    // Protected routes - Database operations
    fastify.post('/api/databases', { preHandler: [auth] }, async (request, reply) => {
        const { name } = (request.body ?? {});
        if (!name) {
            return reply.status(400).send({ error: 'Database name is required' });
        }
        if (!(0, security_middleware_1.validateIdentifier)(name)) {
            return reply.status(400).send({ error: 'Invalid database name. Use letters, numbers, underscore or hyphen (max 64 chars).' });
        }
        // Prevent creating system database
        if (name === SYSTEM_DB) {
            return reply.status(403).send({ error: 'Cannot create system database' });
        }
        // Access keys have a fixed scope: only "all databases" keys with write may create one.
        const viaKey = Boolean(request.user.accessKeyId);
        if (viaKey && !request.user.permissions?.[auth_service_1.ALL_DATABASES]?.includes('write')) {
            return reply.status(403).send({ error: 'This API key cannot create databases (needs write on "*")' });
        }
        const created = engine.createDatabase(name);
        // Grant creator full permissions
        if (created && request.user.role !== 'admin' && !viaKey) {
            const permissions = request.user.permissions || {};
            permissions[name] = ['read', 'write', 'delete'];
            authService.updatePermissions(request.user.id, permissions);
        }
        return created
            ? reply.status(201).send({ message: 'Database created', database: name })
            : reply.status(409).send({ error: 'Database already exists' });
    });
    fastify.get('/api/databases', { preHandler: [auth] }, async (request, reply) => {
        const query = request.query;
        const includeRacks = query.include_racks === 'true';
        const allowedDbs = authService.accessibleDatabases(request.user, engine.getDatabases());
        if (includeRacks) {
            const result = allowedDbs.map(dbName => ({
                name: dbName,
                racks: engine.getDatabaseRacks(dbName),
            }));
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
    fastify.delete('/api/databases/:database', can('delete'), async (request, reply) => {
        const { database } = request.params;
        // Prevent deleting system database
        if (database === SYSTEM_DB) {
            return reply.status(403).send({ error: 'Cannot delete system database' });
        }
        const deleted = engine.deleteDatabase(database);
        if (deleted)
            audit.record({ action: 'database.delete', actor: request.user.username, ip: request.ip, target: database, ok: true });
        return deleted
            ? reply.status(200).send({ message: 'Database deleted', database })
            : reply.status(404).send({ error: 'Database not found' });
    });
    // Rack routes
    fastify.post('/api/databases/:database/racks', can('write'), async (request, reply) => {
        const { database } = request.params;
        const { name, type, schema } = (request.body ?? {});
        if (!name) {
            return reply.status(400).send({ error: 'Rack name is required' });
        }
        if (!(0, security_middleware_1.validateIdentifier)(name)) {
            return reply.status(400).send({ error: 'Invalid rack name. Use letters, numbers, underscore or hyphen (max 64 chars).' });
        }
        // Validate type
        const rackType = type || 'nosql';
        if (rackType !== 'sql' && rackType !== 'nosql') {
            return reply.status(400).send({ error: 'Type must be "sql" or "nosql"' });
        }
        try {
            const created = engine.createRack(database, name, rackType, schema || undefined);
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
    // ── Rack schema (SQL racks: typed columns) ────────────────────────────
    fastify.get('/api/databases/:database/racks/:rack/schema', can('read'), async (request, reply) => {
        const { database, rack } = request.params;
        try {
            return reply.send({ database, rack, ...engine.getRackSchema(database, rack) });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    // ALTER TABLE ADD COLUMN — body: { name, type, required?, unique?, defaultValue? }
    fastify.post('/api/databases/:database/racks/:rack/columns', can('write'), async (request, reply) => {
        const { database, rack } = request.params;
        const { name, ...def } = (request.body ?? {});
        if (typeof name !== 'string')
            return reply.status(400).send({ error: 'Column name is required' });
        try {
            engine.addColumn(database, rack, name, def);
            audit.record({ action: 'rack.column.add', actor: request.user.username, ip: request.ip, target: `${database}/${rack}.${name}`, ok: true, detail: def.type });
            return reply.status(201).send({ message: 'Column added', ...engine.getRackSchema(database, rack) });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    // ALTER TABLE MODIFY / RENAME COLUMN — body: any of { name, type, required, unique, defaultValue }
    fastify.patch('/api/databases/:database/racks/:rack/columns/:field', can('write'), async (request, reply) => {
        const { database, rack, field } = request.params;
        const changes = (request.body ?? {});
        try {
            engine.alterColumn(database, rack, field, changes);
            audit.record({ action: 'rack.column.alter', actor: request.user.username, ip: request.ip, target: `${database}/${rack}.${field}`, ok: true, detail: JSON.stringify(changes).slice(0, 200) });
            return reply.send({ message: 'Column updated', ...engine.getRackSchema(database, rack) });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    // ALTER TABLE DROP COLUMN (removes the column's data from every row)
    fastify.delete('/api/databases/:database/racks/:rack/columns/:field', can('delete'), async (request, reply) => {
        const { database, rack, field } = request.params;
        try {
            const dropped = engine.dropColumn(database, rack, field);
            if (!dropped)
                return reply.status(404).send({ error: 'Column not found' });
            audit.record({ action: 'rack.column.drop', actor: request.user.username, ip: request.ip, target: `${database}/${rack}.${field}`, ok: true });
            return reply.send({ message: 'Column dropped', ...engine.getRackSchema(database, rack) });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    // Exact-match / range index (hash + sorted keys). Pass { unique: true } to enforce uniqueness.
    fastify.post('/api/databases/:database/racks/:rack/indexes', can('write'), async (request, reply) => {
        const { database, rack } = request.params;
        // { field: "email" } or a compound index { fields: ["city", "age"] }
        const { field, fields, unique } = (request.body ?? {});
        const list = Array.isArray(fields) ? fields : field ? [field] : [];
        if (list.length === 0) {
            return reply.status(400).send({ error: 'field (or fields for a compound index) is required' });
        }
        if (!list.every((f) => typeof f === 'string' && (0, security_middleware_1.validateFieldName)(f))) {
            return reply.status(400).send({ error: 'Invalid field name (letters, numbers, _ or -, dot-separated for nested fields)' });
        }
        try {
            engine.createIndex(database, rack, list, { unique: unique === true });
            return reply.status(201).send({ message: 'Index created', database, rack, field: list.join('+'), fields: list, unique: unique === true });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks/:rack/indexes', can('read'), async (request, reply) => {
        const { database, rack } = request.params;
        try {
            const indexes = engine.getIndexes(database, rack);
            return reply.send({ indexes, count: indexes.length, details: engine.getIndexDetails(database, rack) });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.delete('/api/databases/:database/racks/:rack/indexes/:field', can('delete'), async (request, reply) => {
        const { database, rack, field } = request.params;
        try {
            const deleted = engine.deleteIndex(database, rack, field);
            return deleted
                ? reply.send({ message: 'Index deleted', database, rack, field })
                : reply.status(404).send({ error: 'Index not found' });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    // Full-text / fuzzy ("Google-like") search index -- trigram-indexed and
    // ranked via the native Rust accelerator when available, falling back
    // to the existing brute-force scan otherwise.
    fastify.post('/api/databases/:database/racks/:rack/text-indexes', can('write'), async (request, reply) => {
        const { database, rack } = request.params;
        const { field } = (request.body ?? {});
        if (!field || !(0, security_middleware_1.validateFieldName)(field)) {
            return reply.status(400).send({ error: 'A valid field name is required' });
        }
        try {
            engine.createTextIndex(database, rack, field);
            return reply.status(201).send({ message: 'Text index created', database, rack, field });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks/:rack/text-indexes', can('read'), async (request, reply) => {
        const { database, rack } = request.params;
        try {
            const indexes = engine.getTextIndexes(database, rack);
            return reply.send({ indexes, count: indexes.length });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.delete('/api/databases/:database/racks/:rack/text-indexes/:field', can('delete'), async (request, reply) => {
        const { database, rack, field } = request.params;
        try {
            const deleted = engine.deleteTextIndex(database, rack, field);
            return deleted
                ? reply.send({ message: 'Text index deleted', database, rack, field })
                : reply.status(404).send({ error: 'Text index not found' });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    // Vector (ANN) search index -- scalar-quantized, HNSW-backed via the
    // native Rust accelerator when available, falling back to a brute-force
    // cosine scan otherwise.
    fastify.post('/api/databases/:database/racks/:rack/vector-indexes', can('write'), async (request, reply) => {
        const { database, rack } = request.params;
        const { field } = (request.body ?? {});
        if (!field || !(0, security_middleware_1.validateFieldName)(field)) {
            return reply.status(400).send({ error: 'A valid field name is required' });
        }
        try {
            engine.createVectorIndex(database, rack, field);
            return reply.status(201).send({ message: 'Vector index created', database, rack, field });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks/:rack/vector-indexes', can('read'), async (request, reply) => {
        const { database, rack } = request.params;
        try {
            const indexes = engine.getVectorIndexes(database, rack);
            return reply.send({ indexes, count: indexes.length });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks/:rack/vector-indexes/:field/stats', can('read'), async (request, reply) => {
        const { database, rack, field } = request.params;
        const stats = engine.getVectorIndexStats(database, rack, field);
        return reply.send({ database, rack, field, stats });
    });
    fastify.post('/api/databases/:database/racks/:rack/vector-indexes/:field/rebuild', can('write'), async (request, reply) => {
        const { database, rack, field } = request.params;
        engine.rebuildVectorIndex(database, rack, field);
        return reply.send({ message: 'Vector index rebuild triggered', database, rack, field });
    });
    fastify.delete('/api/databases/:database/racks/:rack/vector-indexes/:field', can('delete'), async (request, reply) => {
        const { database, rack, field } = request.params;
        try {
            const deleted = engine.deleteVectorIndex(database, rack, field);
            return deleted
                ? reply.send({ message: 'Vector index deleted', database, rack, field })
                : reply.status(404).send({ error: 'Vector index not found' });
        }
        catch (error) {
            return reply.status(404).send({ error: error.message });
        }
    });
    fastify.get('/api/databases/:database/racks', can('read'), async (request, reply) => {
        const { database } = request.params;
        const racks = engine.getDatabaseRacks(database);
        return reply.send({
            database,
            racks,
            count: racks.length
        });
    });
    fastify.get('/api/databases/:database/racks/:rack/count', can('read'), async (request, reply) => {
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
    fastify.get('/api/databases/:database/stats', can('read'), async (request, reply) => {
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
    fastify.delete('/api/databases/:database/racks/:rack', can('delete'), async (request, reply) => {
        const { database, rack } = request.params;
        if (database === SYSTEM_DB) {
            return reply.status(403).send({ error: 'Cannot delete system racks' });
        }
        const deleted = engine.deleteRack(database, rack);
        if (deleted)
            audit.record({ action: 'rack.delete', actor: request.user.username, ip: request.ip, target: `${database}/${rack}`, ok: true });
        return deleted
            ? reply.status(200).send({ message: 'Rack deleted', database, rack })
            : reply.status(404).send({ error: 'Rack not found' });
    });
    // ── Aggregation pipeline ($match $group $lookup $unwind $project $sort …) ──
    fastify.post('/api/databases/:database/racks/:rack/aggregate', can('read'), async (request, reply) => {
        const { database, rack } = request.params;
        const { pipeline } = (request.body ?? {});
        if (!Array.isArray(pipeline))
            return reply.status(400).send({ error: 'Body must be { "pipeline": [ …stages ] }' });
        try {
            const started = Date.now();
            const results = engine.aggregate(database, rack, pipeline);
            const capped = results.length > config_1.config.maxQueryLimit;
            return reply.send({
                results: capped ? results.slice(0, config_1.config.maxQueryLimit) : results,
                count: Math.min(results.length, config_1.config.maxQueryLimit),
                total: results.length,
                truncated: capped,
                ms: Date.now() - started,
            });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    // ── Multi-rack transactions ──────────────────────────────────────────
    // Body: { database?, operations: [{ op: insert|update|patch|delete, database?, rack, id?, data? }] }
    // All operations commit together or none do. A string "$N.id" anywhere in
    // `data` (or as `id`) is replaced by the id produced by operation N (0-based),
    // e.g. insert an order, then its items with { "order_id": "$0.id" }.
    fastify.post('/api/transactions', { preHandler: [auth], config: { rateLimit: { max: Math.max(60, config_1.config.rateLimitMax), timeWindow: '1 minute' } } }, async (request, reply) => {
        const user = request.user;
        const body = (request.body ?? {});
        const ops = body.operations;
        if (!Array.isArray(ops) || ops.length === 0)
            return reply.status(400).send({ error: 'operations must be a non-empty array' });
        if (ops.length > 10_000)
            return reply.status(400).send({ error: 'At most 10,000 operations per transaction' });
        const permFor = { insert: 'write', update: 'write', patch: 'write', delete: 'delete' };
        for (const [i, op] of ops.entries()) {
            const db = op?.database ?? body.database;
            if (!op || typeof op !== 'object' || !permFor[op.op])
                return reply.status(400).send({ error: `Operation ${i}: op must be insert, update, patch or delete` });
            if (typeof db !== 'string' || !(0, security_middleware_1.validateIdentifier)(db))
                return reply.status(400).send({ error: `Operation ${i}: a valid database is required` });
            if (typeof op.rack !== 'string' || !(0, security_middleware_1.validateIdentifier)(op.rack))
                return reply.status(400).send({ error: `Operation ${i}: a valid rack is required` });
            if (db === SYSTEM_DB && user.role !== 'admin')
                return reply.status(403).send({ error: 'Cannot access system database' });
            if (shardRouter.isSharded(db, op.rack))
                return reply.status(400).send({ error: `Operation ${i}: ${db}/${op.rack} is sharded; transactions cover unsharded racks only` });
            if (!authService.hasPermission(user, db, permFor[op.op])) {
                return reply.status(403).send({ error: `Operation ${i}: no ${permFor[op.op]} permission for database '${db}'` });
            }
        }
        const produced = [];
        const substitute = (v) => {
            if (typeof v === 'string') {
                const m = /^\$(\d+)\.id$/.exec(v);
                if (!m)
                    return v;
                const n = Number(m[1]);
                if (produced[n] === undefined)
                    throw new Error(`"${v}" refers to an operation that has not produced an id`);
                return produced[n];
            }
            if (Array.isArray(v))
                return v.map(substitute);
            if (v && typeof v === 'object')
                return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)]));
            return v;
        };
        const tx = engine.beginTransaction();
        const results = [];
        try {
            for (const [i, op] of ops.entries()) {
                const db = op.database ?? body.database;
                try {
                    if (op.op === 'insert') {
                        const id = tx.insert(db, op.rack, substitute(op.data ?? {}));
                        produced[i] = id;
                        results.push({ op: 'insert', rack: op.rack, id });
                    }
                    else {
                        const id = String(substitute(op.id ?? ''));
                        if (!id)
                            throw new Error('id is required');
                        const ok = op.op === 'delete' ? tx.delete(db, op.rack, id)
                            : op.op === 'update' ? tx.update(db, op.rack, id, substitute(op.data ?? {}))
                                : tx.patch(db, op.rack, id, substitute(op.data ?? {}));
                        if (!ok)
                            throw new Error(`document ${id} not found in ${op.rack}`);
                        produced[i] = id;
                        results.push({ op: op.op, rack: op.rack, id });
                    }
                }
                catch (e) {
                    throw new Error(`Operation ${i} (${op.op} ${op.rack}): ${e.message}`);
                }
            }
            const { txId, changes } = tx.commit();
            return reply.send({ committed: true, txId, changes, results });
        }
        catch (e) {
            tx.rollback();
            return reply.status(/conflict/i.test(e.message) ? 409 : 400).send({ committed: false, error: `${e.message} — nothing was changed` });
        }
    });
    // Document routes - INSERT
    fastify.post('/api/databases/:database/racks/:rack/documents', can('write'), async (request, reply) => {
        const { database, rack } = request.params;
        let data = request.body;
        // Handle case where body might be a string (e.g. if content-type parsing failed)
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            }
            catch {
                return reply.status(400).send({ error: 'Invalid JSON body' });
            }
        }
        try {
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
            // Single insert
            const id = engine.insert(database, rack, data, 'nosql');
            return reply.status(201).send({
                message: 'Document inserted',
                id,
                database,
                rack,
            });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    // Document routes - QUERY
    //   ?field=value            exact match (numbers/booleans auto-typed)
    //   ?_q={"age":{"$gt":30}}  full JSON query with operators
    //   ?_skip=&_limit=&_sort=&_order=asc|desc&populate=true
    fastify.get('/api/databases/:database/racks/:rack/documents', can('read'), async (request, reply) => {
        const { database, rack } = request.params;
        const queryParams = request.query;
        let query = {};
        let populate = false;
        let skip = 0;
        let limit;
        let sortField;
        let sortOrder = 'asc';
        for (const [key, value] of Object.entries(queryParams)) {
            if (typeof value !== 'string')
                continue; // repeated params arrive as arrays
            if (key === 'populate') {
                populate = value === 'true';
                continue;
            }
            if (key === '_skip') {
                skip = Math.max(0, parseInt(value) || 0);
                continue;
            }
            if (key === '_limit') {
                limit = Math.min(config_1.config.maxQueryLimit, Math.max(1, parseInt(value) || 100));
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
            if (key === '_q') {
                try {
                    query = { ...query, ...JSON.parse(value) };
                }
                catch {
                    return reply.status(400).send({ error: '_q must be valid JSON' });
                }
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
            const { results, total } = await engine.queryAsync(database, rack, query, findOptions);
            return reply.send({
                results,
                count: results.length,
                total,
                skip,
                limit: limit ?? null,
            });
        }
        catch (error) {
            return reply.status(400).send({ error: error.message });
        }
    });
    // Document routes - UPDATE/UPSERT
    fastify.put('/api/databases/:database/racks/:rack/documents/:id', can('write'), async (request, reply) => {
        const { database, rack, id } = request.params;
        const data = request.body;
        try {
            // Try to update first
            if (engine.update(database, rack, id, data)) {
                return reply.send({ message: 'Document updated', id, upserted: false });
            }
            // Document doesn't exist — insert with engine-generated ID (requested ID not guaranteed)
            const insertedId = engine.insert(database, rack, (data ?? {}), 'nosql');
            return reply.status(201).send({
                message: 'Document created (upsert)',
                id: insertedId,
                requestedId: id,
                upserted: true,
            });
        }
        catch (error) {
            return reply.status(/not found/.test(error.message) ? 404 : 400).send({ error: error.message });
        }
    });
    // Document routes - GET by ID (O(1) primary-key lookup)
    fastify.get('/api/databases/:database/racks/:rack/documents/:id', can('read'), async (request, reply) => {
        const { database, rack, id } = request.params;
        const { populate } = request.query;
        const doc = engine.getDocument(database, rack, id, populate === 'true');
        if (!doc) {
            return reply.status(404).send({ error: 'Document not found' });
        }
        return reply.send(doc);
    });
    // Document routes - PATCH (partial update / merge)
    fastify.patch('/api/databases/:database/racks/:rack/documents/:id', can('write'), async (request, reply) => {
        const { database, rack, id } = request.params;
        const data = request.body;
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return reply.status(400).send({ error: 'Request body must be a JSON object' });
        }
        try {
            const patched = engine.patch(database, rack, id, data);
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
    fastify.delete('/api/databases/:database/racks/:rack/documents/:id', can('delete'), async (request, reply) => {
        const { database, rack, id } = request.params;
        const deleted = engine.delete(database, rack, id);
        if (!deleted) {
            return reply.status(404).send({ error: 'Document not found' });
        }
        return reply.send({ message: 'Document deleted', id });
    });
    fastify.delete('/api/databases/:database/racks/:rack/clear', can('delete'), async (request, reply) => {
        const { database, rack } = request.params;
        if (database === SYSTEM_DB) {
            return reply.status(403).send({ error: 'Cannot clear system racks' });
        }
        const cleared = engine.clearRack(database, rack);
        if (cleared)
            audit.record({ action: 'rack.clear', actor: request.user.username, ip: request.ip, target: `${database}/${rack}`, ok: true });
        return cleared
            ? reply.status(200).send({ message: 'Rack cleared', database, rack })
            : reply.status(404).send({ error: 'Rack not found' });
    });
    // Stats endpoint (admin only)
    fastify.get('/api/stats', { preHandler: [auth] }, async (request, reply) => {
        if (request.user.role !== 'admin') {
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
        const portInfo = `${config_1.config.port}`;
        console.log(`
    ╔═══════════════════════════════════════╗
    ║                                       ║
    ║         OpenDBS Server Started        ║
    ║  ${`version ${version_1.VERSION.version}`.padStart(22).padEnd(37)}║
    ║                                       ║
    ║  🚀 Server running on:                ║
    ║     http://${config_1.config.host}:${portInfo.padEnd(18)}║
    ║                                       ║
    ║  🔐 Authentication: ENABLED           ║
    ║  ⚡ Mode: ${'🔄 SQL + NoSQL'.padEnd(24)}║
    ║  💾 Storage: ${config_1.config.dbPath.padEnd(23)}║
    ║                                       ║
    ║  🌐 Web UI:   ${(config_1.config.webInterfaceEnabled ? '/web/' : 'disabled').padEnd(24)}║
    ║  🛡️  Admin:    ${(!config_1.config.admin.enabled ? 'disabled' : adminPathError ? 'NOT started (bad path)' : adminPath + '/').padEnd(23)}║
    ║                                       ║
    ╚═══════════════════════════════════════╝
    `);
    }
    catch (err) {
        console.error('Failed to start server:', err);
        engine.close();
        process.exit(1);
    }
    // Writes are durable in the WAL immediately; on shutdown fold them into
    // snapshots and persist the native search index so restart is instant.
    let shuttingDown = false;
    const gracefulShutdown = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log(`\n${signal} received, flushing data and shutting down...`);
        backupScheduler.stop();
        cluster?.stop();
        try {
            await fastify.close();
        }
        finally {
            engine.close();
            await sqlBridge.close().catch(() => undefined);
            process.exit(0);
        }
    };
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        fastify.log.error({ reason }, 'Unhandled promise rejection');
    });
}
start().catch((err) => {
    console.error('❌ Failed to start OpenDBS:', err?.message ?? err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map