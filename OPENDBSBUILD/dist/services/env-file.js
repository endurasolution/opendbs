"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADMIN_SETTINGS = void 0;
exports.envPath = envPath;
exports.parseEnv = parseEnv;
exports.readEnvFile = readEnvFile;
exports.writeEnvUpdates = writeEnvUpdates;
exports.readAdminSettings = readAdminSettings;
exports.validateAdminSettings = validateAdminSettings;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Reading and safely rewriting the server's .env file (atomic, comments preserved). */
function envPath() {
    return path_1.default.join(process.cwd(), '.env');
}
/** Parses KEY=VALUE lines, keeping '=' inside values. */
function parseEnv(content) {
    const env = {};
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return env;
}
function readEnvFile() {
    try {
        return parseEnv(fs_1.default.readFileSync(envPath(), 'utf-8'));
    }
    catch {
        return {};
    }
}
/**
 * Updates existing KEY= lines in place and appends new keys. Callers must
 * have validated keys and values (no newlines) already.
 */
function writeEnvUpdates(updates) {
    for (const [k, v] of Object.entries(updates)) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || /[\r\n\0]/.test(v))
            throw new Error(`Refusing to write invalid env entry '${k}'`);
    }
    const file = envPath();
    const content = fs_1.default.existsSync(file) ? fs_1.default.readFileSync(file, 'utf-8') : '';
    const seen = new Set();
    const lines = content.split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            return line;
        const eq = trimmed.indexOf('=');
        if (eq <= 0)
            return line;
        const key = trimmed.slice(0, eq).trim();
        seen.add(key);
        return Object.prototype.hasOwnProperty.call(updates, key) ? `${key}=${updates[key]}` : line;
    });
    for (const [key, val] of Object.entries(updates)) {
        if (!seen.has(key))
            lines.push(`${key}=${val}`);
    }
    const tmp = `${file}.tmp`;
    fs_1.default.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs_1.default.renameSync(tmp, file);
}
/**
 * The settings the admin panel may change. Anything not listed here (in
 * particular ADMIN_PANEL_*, ADMIN_ALLOWED_IPS, ADMIN_REQUIRE_2FA,
 * SHOW_ENVONWEB, DB_PATH, BACKUP_PATH) can only be edited on the server.
 */
exports.ADMIN_SETTINGS = [
    { key: 'NODE_ENV', label: 'Environment', group: 'Server', type: 'enum', options: ['development', 'production'], default: 'development', help: 'production hides internal error details and requires a strong JWT_SECRET.' },
    { key: 'PORT', label: 'Port', group: 'Server', type: 'int', min: 1, max: 65535, default: '4402', help: 'HTTP port the server listens on.' },
    { key: 'HOST', label: 'Bind address', group: 'Server', type: 'string', default: '0.0.0.0', help: '0.0.0.0 = all interfaces, 127.0.0.1 = this machine only.' },
    { key: 'LOG_LEVEL', label: 'Log level', group: 'Server', type: 'enum', options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], default: 'info', help: 'Verbosity of server logs.' },
    { key: 'TRUST_PROXY', label: 'Behind a reverse proxy', group: 'Server', type: 'bool', default: 'false', help: 'Trust X-Forwarded-For (nginx, Caddy, load balancer). Needed for correct client IPs in rate limits and API-key IP rules.' },
    { key: 'CORS_ORIGINS', label: 'Allowed browser origins', group: 'Server', type: 'list', default: '', help: 'Comma-separated, e.g. https://app.example.com. Empty = any origin in development, none in production.' },
    { key: 'WEB_INTERFACE_ENABLED', label: 'User web UI (/web)', group: 'Server', type: 'bool', default: 'true', help: 'Serve the user-facing web interface.' },
    { key: 'JWT_SECRET', label: 'JWT signing secret', group: 'Security', type: 'secret', minLength: 32, default: '', help: 'Signs login sessions. Changing it signs everyone out. 32+ random characters.' },
    { key: 'JWT_EXPIRATION_DAYS', label: 'Session lifetime (days)', group: 'Security', type: 'int', min: 1, max: 365, default: '7', help: 'How long a login token stays valid.' },
    { key: 'ADMIN_SESSION_TIMEOUT_MINUTES', label: 'Admin idle timeout (minutes)', group: 'Security', type: 'int', min: 1, max: 1440, default: '30', help: 'The admin panel signs out after this much inactivity.' },
    { key: 'BCRYPT_ROUNDS', label: 'Password hashing cost', group: 'Security', type: 'int', min: 10, max: 15, default: '10', help: 'bcrypt rounds. 12 is a good production value; each +1 doubles login time.' },
    { key: 'RATE_LIMIT_MAX', label: 'Requests per minute per IP', group: 'Security', type: 'int', min: 10, max: 1000000, default: '300', help: 'Global API rate limit (login has its own stricter limit).' },
    { key: 'BODY_LIMIT_MB', label: 'Max request size (MB)', group: 'Security', type: 'int', min: 1, max: 1024, default: '50', help: 'Largest accepted request body.' },
    { key: 'MAX_QUERY_LIMIT', label: 'Max rows per query', group: 'Security', type: 'int', min: 100, max: 1000000, default: '10000', help: 'Upper bound for page sizes and SQL SELECT results.' },
    { key: 'STORAGE_ENGINE', label: 'Storage engine', group: 'Performance', type: 'enum', options: ['disk', 'memory'], default: 'disk', help: 'disk: data lives in an encrypted on-disk B-tree with a RAM cache, so databases can be far larger than memory (recommended). memory: everything in RAM, saved as snapshots. Switching converts the data automatically on the next restart.' },
    { key: 'CACHE_SIZE_MB', label: 'RAM cache (MB)', group: 'Performance', type: 'int', min: 32, max: 1048576, default: '512', help: 'Disk engine: memory for hot documents and B-tree pages. More cache = fewer disk reads.' },
    { key: 'PERSIST_DEBOUNCE_MS', label: 'Snapshot delay (ms)', group: 'Performance', type: 'int', min: 0, max: 60000, default: '1000', help: 'Memory engine only: writes go to the WAL instantly; the compressed snapshot is rewritten after this idle time. 0 = snapshot on every write (slow).' },
    { key: 'WAL_FSYNC', label: 'Power-loss safe writes (fsync)', group: 'Performance', type: 'bool', default: 'true', help: 'A write is acknowledged only once it is on disk. Group commit shares one fsync between concurrent writes. Turning it off is faster but can lose the last moments of writes on power loss.' },
    { key: 'QUERY_CACHE_ENTRIES', label: 'Query cache size', group: 'Performance', type: 'int', min: 0, max: 100000, default: '1000', help: 'Cached query results (invalidated on writes). 0 disables.' },
    { key: 'QUERY_WORKERS', label: 'Parallel query workers', group: 'Performance', type: 'string', default: '', help: 'Threads that scan large racks in parallel (disk engine). Empty = automatic (half the CPUs, up to 8); 0 = off.' },
    { key: 'CLUSTER_ENABLED', label: 'Replication / failover', group: 'Cluster', type: 'bool', default: 'false', help: 'Run this server as a member of a replicated cluster (disk engine). Every member needs the same CLUSTER_SECRET and lists the others in CLUSTER_PEERS. Restart to apply.' },
    { key: 'CLUSTER_NODE_ID', label: 'Node name', group: 'Cluster', type: 'string', default: '', help: 'Unique name of this member (default: its advertised address).' },
    { key: 'CLUSTER_ADVERTISE_URL', label: 'This node’s address', group: 'Cluster', type: 'string', default: '', help: 'How the other members reach this server, e.g. http://10.0.0.5:4402. Must match how the others list it in CLUSTER_PEERS.' },
    { key: 'CLUSTER_PEERS', label: 'Other members', group: 'Cluster', type: 'list', default: '', help: 'Comma-separated addresses of the other members, e.g. http://10.0.0.6:4402,http://10.0.0.7:4402. Use 3+ members in total for automatic failover.' },
    { key: 'CLUSTER_SECRET', label: 'Cluster secret', group: 'Cluster', type: 'secret', minLength: 32, default: '', help: 'Shared by all members (32+ random characters). Authenticates and encrypts replication traffic.' },
    { key: 'REPLICATION_SYNC', label: 'Write concern', group: 'Cluster', type: 'enum', options: ['async', 'majority'], default: 'async', help: 'majority: a write is acknowledged only once most members have it, so no acknowledged write is lost on failover (slower). async: acknowledged after the primary’s own commit.' },
    { key: 'CLUSTER_ELECTION_TIMEOUT_MS', label: 'Failover timeout (ms)', group: 'Cluster', type: 'int', min: 1000, max: 120000, default: '5000', help: 'How long the primary may be unreachable before the others elect a new one.' },
    { key: 'CLUSTER_PRIORITY', label: 'Election priority', group: 'Cluster', type: 'int', min: 0, max: 100, default: '1', help: 'Higher = preferred primary. 0 = never becomes primary (e.g. a backup-only replica).' },
];
const DEF_BY_KEY = new Map(exports.ADMIN_SETTINGS.map((d) => [d.key, d]));
function readAdminSettings() {
    const file = readEnvFile();
    return exports.ADMIN_SETTINGS.map((d) => {
        const raw = file[d.key] ?? process.env[d.key] ?? '';
        return {
            ...d,
            value: d.type === 'secret' ? '' : (raw || d.default),
            isSet: d.type === 'secret' ? raw.length > 0 : undefined,
        };
    });
}
/** Validates updates against ADMIN_SETTINGS; returns normalized string values. */
function validateAdminSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Body must be an object of KEY: value');
    const out = {};
    for (const [key, rawVal] of Object.entries(input)) {
        const def = DEF_BY_KEY.get(key);
        if (!def)
            throw new Error(`'${key}' can't be changed from the admin panel`);
        const val = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();
        if (/[\r\n\0]/.test(val) || val.length > 2048)
            throw new Error(`${def.label}: invalid value`);
        switch (def.type) {
            case 'bool':
                if (!['true', 'false'].includes(val))
                    throw new Error(`${def.label}: must be true or false`);
                break;
            case 'int': {
                const n = Number(val);
                if (!Number.isInteger(n) || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
                    throw new Error(`${def.label}: must be a whole number from ${def.min} to ${def.max}`);
                }
                break;
            }
            case 'enum':
                if (!def.options.includes(val))
                    throw new Error(`${def.label}: must be one of ${def.options.join(', ')}`);
                break;
            case 'secret':
                if (val === '')
                    continue; // empty = keep current
                if (val.length < (def.minLength ?? 1))
                    throw new Error(`${def.label}: must be at least ${def.minLength} characters`);
                break;
            case 'list':
                if (val && !val.split(',').every((s) => s.trim().length > 0))
                    throw new Error(`${def.label}: comma-separated values`);
                break;
            default:
                if (key === 'HOST' && !/^[a-zA-Z0-9.:-]{1,255}$/.test(val))
                    throw new Error(`${def.label}: invalid host`);
        }
        out[key] = val;
    }
    return out;
}
//# sourceMappingURL=env-file.js.map