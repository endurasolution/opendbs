"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsRoutes = createSettingsRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
function createSettingsRoutes(authService) {
    return async (fastify) => {
        // GET /api/settings/env
        fastify.get('/env', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()] }, async (req, reply) => {
            if (!config_1.config.webInterfaceEnabled || !config_1.config.showEnvOnWeb) {
                return reply.status(403).send({ error: 'Settings access disabled via config' });
            }
            try {
                const envPath = path_1.default.join(process.cwd(), '.env');
                if (!fs_1.default.existsSync(envPath))
                    return { env: {} };
                const content = fs_1.default.readFileSync(envPath, 'utf-8');
                const envVars = {};
                content.split('\n').forEach(line => {
                    line = line.trim();
                    if (!line || line.startsWith('#'))
                        return;
                    const parts = line.split('=');
                    if (parts.length < 2)
                        return;
                    const key = parts[0].trim();
                    // Hide specific keys as requested
                    if (key === 'WEB_INTERFACE_ENABLED' || key === 'SHOW_ENVONWEB')
                        return;
                    // Simple value extraction (might fail for complex values with =, typically env files are simple)
                    // Better approach: join slice(1) to handle value containing '='
                    const val = parts.slice(1).join('=').trim();
                    envVars[key] = val;
                });
                return reply.send({ env: envVars });
            }
            catch (e) {
                return reply.status(500).send({ error: e.message });
            }
        });
        // POST /api/settings/env
        fastify.post('/env', { preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.adminMiddleware)()] }, async (req, reply) => {
            if (!config_1.config.webInterfaceEnabled || !config_1.config.showEnvOnWeb) {
                return reply.status(403).send({ error: 'Settings access disabled via config' });
            }
            const updates = req.body;
            const envPath = path_1.default.join(process.cwd(), '.env');
            try {
                let content = '';
                if (fs_1.default.existsSync(envPath)) {
                    content = fs_1.default.readFileSync(envPath, 'utf-8');
                }
                let lines = content.split('\n');
                const newLines = [];
                const updatedKeys = new Set();
                lines.forEach(line => {
                    const trimmed = line.trim();
                    // Keep comments and empty lines
                    if (!trimmed || trimmed.startsWith('#')) {
                        newLines.push(line);
                        return;
                    }
                    const parts = trimmed.split('=');
                    const key = parts[0].trim();
                    // Prevent editing restricted keys
                    if (key === 'WEB_INTERFACE_ENABLED' || key === 'SHOW_ENVONWEB') {
                        newLines.push(line);
                        updatedKeys.add(key);
                        return;
                    }
                    if (updates[key] !== undefined) {
                        newLines.push(`${key}=${updates[key]}`);
                        updatedKeys.add(key);
                    }
                    else {
                        newLines.push(line);
                        updatedKeys.add(key);
                    }
                });
                // Add new keys that were not present
                for (const [key, val] of Object.entries(updates)) {
                    // Safety check
                    if (key === 'WEB_INTERFACE_ENABLED' || key === 'SHOW_ENVONWEB')
                        continue;
                    if (!updatedKeys.has(key)) {
                        newLines.push(`${key}=${val}`);
                    }
                }
                fs_1.default.writeFileSync(envPath, newLines.join('\n'));
                // Note: We cannot easily restart the server from here, but changes take effect on restart.
                // Or if we use dotenv.parse/re-read, but config.ts loads once.
                return reply.send({ message: 'Settings updated successfully. You may need to restart the server for changes to take effect.' });
            }
            catch (e) {
                return reply.status(500).send({ error: e.message });
            }
        });
    };
}
//# sourceMappingURL=settings.js.map