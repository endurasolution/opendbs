"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsRoutes = createSettingsRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
const security_middleware_1 = require("../middleware/security.middleware");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
// Keys that gate access to the settings/admin surfaces themselves. They can
// only be changed by editing .env on the server, so a stolen admin token
// can't widen its own access (e.g. open the admin panel to every IP).
const PROTECTED_KEYS = new Set([
    'WEB_INTERFACE_ENABLED',
    'SHOW_ENVONWEB',
    'ADMIN_PANEL_ENABLED',
    'ADMIN_PANEL_PATH',
    'ADMIN_ALLOWED_IPS',
    'ADMIN_REQUIRE_2FA',
]);
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LEN = 4096;
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
function createSettingsRoutes(authService, audit) {
    return async (fastify) => {
        // GET /api/settings/env
        fastify.get('/env', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()] }, async (_req, reply) => {
            if (!config_1.config.showEnvOnWeb || (!config_1.config.webInterfaceEnabled && !config_1.config.admin.enabled)) {
                return reply.status(403).send({ error: 'Settings access disabled via config' });
            }
            try {
                if (!fs_1.default.existsSync(envPath()))
                    return { env: {} };
                const envVars = parseEnv(fs_1.default.readFileSync(envPath(), 'utf-8'));
                for (const key of PROTECTED_KEYS)
                    delete envVars[key];
                return reply.send({ env: (0, security_middleware_1.maskSensitiveEnv)(envVars), protectedKeys: Array.from(PROTECTED_KEYS) });
            }
            catch (e) {
                return reply.status(500).send({ error: e.message });
            }
        });
        // POST /api/settings/env
        fastify.post('/env', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()] }, async (req, reply) => {
            if (!config_1.config.showEnvOnWeb || (!config_1.config.webInterfaceEnabled && !config_1.config.admin.enabled)) {
                return reply.status(403).send({ error: 'Settings access disabled via config' });
            }
            const updates = req.body;
            if (!(0, security_middleware_1.isPlainObject)(updates)) {
                return reply.status(400).send({ error: 'Body must be an object of KEY: value pairs' });
            }
            // Validate everything first. A newline in a value would otherwise
            // inject arbitrary extra keys into .env.
            const accepted = {};
            for (const [key, rawVal] of Object.entries(updates)) {
                if (!ENV_KEY_RE.test(key))
                    return reply.status(400).send({ error: `Invalid key '${key}'` });
                if (PROTECTED_KEYS.has(key))
                    return reply.status(403).send({ error: `'${key}' can only be changed on the server` });
                if (rawVal === null || !['string', 'number', 'boolean'].includes(typeof rawVal)) {
                    return reply.status(400).send({ error: `Value for '${key}' must be a string, number or boolean` });
                }
                const val = String(rawVal);
                if (/[\r\n\0]/.test(val) || val.length > MAX_VALUE_LEN) {
                    return reply.status(400).send({ error: `Value for '${key}' contains forbidden characters or is too long` });
                }
                // The UI round-trips masked secrets as "***" -- keep the real value.
                if (val === security_middleware_1.MASKED_VALUE)
                    continue;
                accepted[key] = val;
            }
            try {
                const content = fs_1.default.existsSync(envPath()) ? fs_1.default.readFileSync(envPath(), 'utf-8') : '';
                const seen = new Set();
                const newLines = content.split(/\r?\n/).map((line) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#'))
                        return line;
                    const eq = trimmed.indexOf('=');
                    if (eq <= 0)
                        return line;
                    const key = trimmed.slice(0, eq).trim();
                    seen.add(key);
                    return Object.prototype.hasOwnProperty.call(accepted, key) ? `${key}=${accepted[key]}` : line;
                });
                for (const [key, val] of Object.entries(accepted)) {
                    if (!seen.has(key))
                        newLines.push(`${key}=${val}`);
                }
                const tmp = `${envPath()}.tmp`;
                fs_1.default.writeFileSync(tmp, newLines.join('\n'), { mode: 0o600 });
                fs_1.default.renameSync(tmp, envPath());
                audit?.record({ action: 'settings.env.update', actor: req.user.username, ip: req.ip, ok: true, detail: Object.keys(accepted).join(',') });
                return reply.send({
                    message: 'Settings updated successfully. Restart the server for changes to take effect.',
                    updated: Object.keys(accepted),
                });
            }
            catch (e) {
                return reply.status(500).send({ error: e.message });
            }
        });
    };
}
//# sourceMappingURL=settings.js.map