"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '4402', 10),
    host: process.env.HOST || '0.0.0.0',
    // Database
    dbPath: process.env.DB_PATH || './data',
    dbMode: process.env.DB_MODE || 'nosql',
    // Security
    jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    apiKeySalt: process.env.API_KEY_SALT || 'your-api-key-salt',
    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    // Performance
    maxConnections: parseInt(process.env.MAX_CONNECTIONS || '1000', 10),
    cacheSizeMB: parseInt(process.env.CACHE_SIZE_MB || '512', 10),
    enableCompression: process.env.ENABLE_COMPRESSION === 'true',
    // Search
    enableFuzzySearch: process.env.ENABLE_FUZZY_SEARCH !== 'false',
    enableSemanticSearch: process.env.ENABLE_SEMANTIC_SEARCH === 'true',
    enableVectorSearch: process.env.ENABLE_VECTOR_SEARCH === 'true',
    // Backup
    backup: {
        enabled: process.env.BACKUP_ENABLED === 'true',
        path: process.env.BACKUP_PATH || './backups',
        schedule: process.env.BACKUP_SCHEDULE || '0 2 * * *', // Default: 2 AM daily
        retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10),
        type: (process.env.BACKUP_TYPE || 'local'),
        s3: process.env.BACKUP_S3_BUCKET ? {
            bucket: process.env.BACKUP_S3_BUCKET,
            region: process.env.BACKUP_S3_REGION || 'us-east-1',
            accessKey: process.env.BACKUP_S3_ACCESS_KEY,
            secretKey: process.env.BACKUP_S3_SECRET_KEY,
        } : undefined,
        ftp: process.env.BACKUP_FTP_HOST ? {
            host: process.env.BACKUP_FTP_HOST,
            port: parseInt(process.env.BACKUP_FTP_PORT || '21', 10),
            user: process.env.BACKUP_FTP_USER,
            password: process.env.BACKUP_FTP_PASSWORD,
        } : undefined,
    },
    // SQL Configuration
    sql: {
        enabled: process.env.SQL_ENABLED === 'true',
        port: parseInt(process.env.SQL_PORT || '3306', 10),
        apiPort: parseInt(process.env.API_PORT || '4402', 10),
        mysql: process.env.MYSQL_HOST ? {
            host: process.env.MYSQL_HOST,
            port: parseInt(process.env.MYSQL_PORT || '3306', 10),
            user: process.env.MYSQL_USER || 'root',
            password: process.env.MYSQL_PASSWORD || '',
            database: process.env.MYSQL_DATABASE || 'opendbs',
        } : undefined,
    },
    // Web Config
    webInterfaceEnabled: process.env.WEB_INTERFACE_ENABLED === 'true',
    showEnvOnWeb: process.env.SHOW_ENVONWEB === 'true',
};
//# sourceMappingURL=config.js.map