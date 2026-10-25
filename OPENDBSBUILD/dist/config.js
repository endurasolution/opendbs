"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const bool = (v, def) => v === undefined || v === '' ? def : v.toLowerCase() === 'true';
const int = (v, def) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) ? n : def;
};
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
exports.config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: int(process.env.PORT, 4402),
    host: process.env.HOST || '0.0.0.0',
    // Database
    dbPath: process.env.DB_PATH || './data',
    dbMode: process.env.DB_MODE || 'nosql',
    // Security
    // Empty string means "not configured" -- see resolveJwtSecret() in
    // auth.service.ts, which refuses to start in production without one and
    // generates + persists a random one in development.
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpirationDays: int(process.env.JWT_EXPIRATION_DAYS, 7),
    apiKeySalt: process.env.API_KEY_SALT || 'your-api-key-salt',
    bcryptRounds: Math.min(15, Math.max(10, int(process.env.BCRYPT_ROUNDS, 10))),
    adminPassword: process.env.ADMIN_PASSWORD || '',
    trustProxy: bool(process.env.TRUST_PROXY, false),
    corsOrigins: list(process.env.CORS_ORIGINS),
    rateLimitMax: int(process.env.RATE_LIMIT_MAX, 300),
    bodyLimitMB: int(process.env.BODY_LIMIT_MB, 50),
    maxQueryLimit: int(process.env.MAX_QUERY_LIMIT, 10000),
    // Show the OpenDBS version to unauthenticated callers (GET /api/version, /health).
    // Default: yes in development, no in production (it helps attackers pick exploits).
    exposeVersion: bool(process.env.EXPOSE_VERSION, (process.env.NODE_ENV || 'development') !== 'production'),
    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    // Performance
    maxConnections: int(process.env.MAX_CONNECTIONS, 1000),
    cacheSizeMB: int(process.env.CACHE_SIZE_MB, 512),
    enableCompression: process.env.ENABLE_COMPRESSION === 'true',
    // Write path: every write is appended to a per-rack write-ahead log
    // (cheap, crash-safe), and the full compressed snapshot is rewritten in
    // the background at most once per PERSIST_DEBOUNCE_MS.
    persistDebounceMs: Math.max(0, int(process.env.PERSIST_DEBOUNCE_MS, 1000)),
    // fsync before acknowledging writes (group commit). Default on: survives power loss.
    walFsync: bool(process.env.WAL_FSYNC, true),
    queryCacheEntries: Math.max(0, int(process.env.QUERY_CACHE_ENTRIES, 1000)),
    // 'disk': documents and indexes live in an encrypted on-disk B-tree with a
    // RAM cache of CACHE_SIZE_MB (data can be far larger than memory).
    // 'memory': everything in RAM, persisted as per-rack snapshots + WAL.
    storageEngine: (process.env.STORAGE_ENGINE || 'disk').toLowerCase() === 'memory' ? 'memory' : 'disk',
    // Replication / failover (disk engine). Every member lists the others in CLUSTER_PEERS.
    cluster: {
        enabled: bool(process.env.CLUSTER_ENABLED, false),
        nodeId: (process.env.CLUSTER_NODE_ID || '').trim(),
        /** How the other members reach this node, e.g. http://10.0.0.5:4402 */
        advertiseUrl: (process.env.CLUSTER_ADVERTISE_URL || '').trim().replace(/\/+$/, ''),
        peers: (process.env.CLUSTER_PEERS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
        /** Shared secret (32+ chars): authenticates and encrypts all cluster traffic. */
        secret: process.env.CLUSTER_SECRET || '',
        /** async: acknowledge after the primary's own commit. majority: also wait for a majority of members. */
        writeConcern: (process.env.REPLICATION_SYNC || 'async').toLowerCase() === 'majority' ? 'majority' : 'async',
        electionTimeoutMs: Math.max(1000, int(process.env.CLUSTER_ELECTION_TIMEOUT_MS, 5000)),
        writeTimeoutMs: Math.max(1000, int(process.env.CLUSTER_WRITE_TIMEOUT_MS, 10000)),
        /** Log entries kept beyond what every member has applied (lets lagging replicas catch up without a full copy). */
        logRetention: Math.max(1000, int(process.env.CLUSTER_LOG_RETENTION, 100000)),
        /** Higher = preferred primary in elections (ties broken by node id). 0 = never becomes primary. */
        priority: Math.max(0, int(process.env.CLUSTER_PRIORITY, 1)),
    },
    // Search
    enableFuzzySearch: process.env.ENABLE_FUZZY_SEARCH !== 'false',
    enableSemanticSearch: process.env.ENABLE_SEMANTIC_SEARCH === 'true',
    enableVectorSearch: process.env.ENABLE_VECTOR_SEARCH === 'true',
    // Backup
    backup: {
        enabled: process.env.BACKUP_ENABLED === 'true',
        path: process.env.BACKUP_PATH || './backups',
        schedule: process.env.BACKUP_SCHEDULE || '0 2 * * *', // Default: 2 AM daily
        retentionDays: int(process.env.BACKUP_RETENTION_DAYS, 7),
        type: (process.env.BACKUP_TYPE || 'local'),
        s3: process.env.BACKUP_S3_BUCKET ? {
            bucket: process.env.BACKUP_S3_BUCKET,
            region: process.env.BACKUP_S3_REGION || 'us-east-1',
            accessKey: process.env.BACKUP_S3_ACCESS_KEY,
            secretKey: process.env.BACKUP_S3_SECRET_KEY,
        } : undefined,
        ftp: process.env.BACKUP_FTP_HOST ? {
            host: process.env.BACKUP_FTP_HOST,
            port: int(process.env.BACKUP_FTP_PORT, 21),
            user: process.env.BACKUP_FTP_USER,
            password: process.env.BACKUP_FTP_PASSWORD,
        } : undefined,
    },
    // SQL Configuration
    sql: {
        enabled: process.env.SQL_ENABLED === 'true',
        port: int(process.env.SQL_PORT, 3306),
        apiPort: int(process.env.API_PORT, 4402),
        mysql: process.env.MYSQL_HOST ? {
            host: process.env.MYSQL_HOST,
            port: int(process.env.MYSQL_PORT, 3306),
            user: process.env.MYSQL_USER || 'root',
            password: process.env.MYSQL_PASSWORD || '',
            database: process.env.MYSQL_DATABASE || 'opendbs',
        } : undefined,
    },
    // Web Config
    webInterfaceEnabled: process.env.WEB_INTERFACE_ENABLED === 'true',
    showEnvOnWeb: process.env.SHOW_ENVONWEB === 'true',
    // Admin panel -- admin-role accounts only.
    admin: {
        enabled: process.env.ADMIN_PANEL_ENABLED === 'true',
        // Mount path, e.g. /admin, an unguessable /ops-7f3a, or /company/console (validated in index.ts)
        path: '/' + ((process.env.ADMIN_PANEL_PATH || 'admin').trim().replace(/^\/+|\/+$/g, '') || 'admin'),
        // Optional IP allow-list (exact IPs). Empty = any IP (still admin-login only).
        allowedIps: list(process.env.ADMIN_ALLOWED_IPS),
        // When true, admin accounts must use two-factor auth: an admin session
        // without a verified second factor can only reach /api/auth (to set it up).
        require2fa: bool(process.env.ADMIN_REQUIRE_2FA, false),
        // Admin panel signs out after this many minutes without activity.
        sessionTimeoutMinutes: Math.max(1, int(process.env.ADMIN_SESSION_TIMEOUT_MINUTES, 30)),
    },
};
//# sourceMappingURL=config.js.map