"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminIpGuard = adminIpGuard;
exports.createAdminRoutes = createAdminRoutes;
const os_1 = __importDefault(require("os"));
const access_key_service_1 = require("../services/access-key.service");
const auth_middleware_1 = require("../middleware/auth.middleware");
const config_1 = require("../config");
const version_1 = require("../version");
const encryption_1 = require("../storage/encryption");
const encryptionStatus = (0, encryption_1.resolveEncryption)().status;
const backup_settings_1 = require("../services/backup-settings");
const env_file_1 = require("../services/env-file");
/** Enforces ADMIN_ALLOWED_IPS for both the admin API and the admin UI. */
function adminIpGuard() {
    const allowed = new Set(config_1.config.admin.allowedIps.map(access_key_service_1.normalizeIp));
    return async (request, reply) => {
        if (allowed.size === 0)
            return;
        if (!allowed.has((0, access_key_service_1.normalizeIp)(request.ip))) {
            return reply.status(403).send({ error: 'Forbidden' });
        }
    };
}
function createAdminRoutes(authService, engine, audit, accessKeys, deps) {
    const { backupService, backupScheduler, backupSettings, benchmark } = deps;
    const cluster = deps.cluster ?? null;
    return async (fastify) => {
        fastify.addHook('onRequest', adminIpGuard());
        fastify.addHook('preHandler', (0, auth_middleware_1.authMiddleware)(authService));
        fastify.addHook('preHandler', (0, auth_middleware_1.adminMiddleware)());
        fastify.addHook('onSend', async (_req, reply, payload) => {
            reply.header('Cache-Control', 'no-store');
            return payload;
        });
        // Read before 2FA setup is complete (see authMiddleware), so it must not expose anything sensitive.
        fastify.get('/ui-config', async (request) => ({
            version: version_1.VERSION.version,
            sessionTimeoutMinutes: config_1.config.admin.sessionTimeoutMinutes,
            require2fa: config_1.config.admin.require2fa,
            sessionMfa: Boolean(request.user.sessionMfa),
        }));
        // ── Backup settings (applied live) ───────────────────────────────
        fastify.get('/backup-config', async () => ({
            config: (0, backup_settings_1.maskBackupConfig)(backupService.getConfig()),
            status: backupScheduler.status(),
        }));
        fastify.put('/backup-config', async (request, reply) => {
            try {
                const next = (0, backup_settings_1.validateBackupInput)(request.body, backupService.getConfig());
                backupSettings.save(next);
                backupService.reconfigure(next);
                backupScheduler.reschedule();
                audit.record({ action: 'backup.settings', actor: request.user.username, ip: request.ip, ok: true, detail: `${next.enabled ? 'on' : 'off'} ${next.type} "${next.schedule}" keep ${next.retentionDays}d` });
                return { message: 'Backup settings saved and applied', config: (0, backup_settings_1.maskBackupConfig)(next), status: backupScheduler.status() };
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        fastify.post('/backup-config/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
            try {
                const candidate = (0, backup_settings_1.validateBackupInput)(request.body ?? {}, backupService.getConfig());
                const message = await backupService.testDestination(candidate);
                return { ok: true, message };
            }
            catch (e) {
                return reply.status(400).send({ ok: false, error: e?.message ?? String(e) });
            }
        });
        fastify.post('/backup/run', async (request, reply) => {
            try {
                const run = await backupScheduler.runNow('manual');
                audit.record({ action: 'backup.create', actor: request.user.username, ip: request.ip, target: run.backupName, ok: run.ok, detail: run.error });
                return run.ok ? run : reply.status(500).send({ error: run.error, run });
            }
            catch (e) {
                return reply.status(409).send({ error: e.message });
            }
        });
        // Backups stored at the S3/FTP destination, and copying one back to this server.
        fastify.get('/backup/remote', async (_request, reply) => {
            try {
                return { backups: await backupService.listRemoteBackups() };
            }
            catch (e) {
                return reply.status(400).send({ error: e?.message ?? String(e) });
            }
        });
        fastify.post('/backup/remote/fetch', async (request, reply) => {
            const { backupName } = (request.body ?? {});
            try {
                const name = await backupService.fetchRemoteBackup(String(backupName ?? ''));
                audit.record({ action: 'backup.fetch', actor: request.user.username, ip: request.ip, target: name, ok: true });
                return { message: 'Backup copied to this server', backupName: name };
            }
            catch (e) {
                return reply.status(400).send({ error: e?.message ?? String(e) });
            }
        });
        // ── Server settings (.env, curated) ──────────────────────────────
        fastify.get('/env-settings', async () => ({ settings: (0, env_file_1.readAdminSettings)() }));
        fastify.put('/env-settings', async (request, reply) => {
            try {
                const updates = (0, env_file_1.validateAdminSettings)(request.body);
                if (Object.keys(updates).length === 0)
                    return { message: 'Nothing to change', updated: [] };
                (0, env_file_1.writeEnvUpdates)(updates);
                audit.record({ action: 'settings.env.update', actor: request.user.username, ip: request.ip, ok: true, detail: Object.keys(updates).join(',') });
                return { message: 'Saved. Restart the server to apply.', updated: Object.keys(updates), restartRequired: true };
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        // ── Speed test ───────────────────────────────────────────────────
        fastify.post('/benchmark', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
            const { size } = (request.body ?? {});
            try {
                const result = await benchmark.run(Number(size) || 10_000);
                audit.record({ action: 'engine.benchmark', actor: request.user.username, ip: request.ip, ok: true, detail: `${result.size} docs, ${result.totalMs} ms` });
                return result;
            }
            catch (e) {
                return reply.status(409).send({ error: e.message });
            }
        });
        // bcrypt is deliberately slow; don't run it on every overview poll.
        let defaultPwCheck = { at: 0, value: false };
        const usesDefaultPassword = async () => {
            if (Date.now() - defaultPwCheck.at > 60_000) {
                defaultPwCheck = { at: Date.now(), value: await authService.adminUsesDefaultPassword() };
            }
            return defaultPwCheck.value;
        };
        fastify.get('/overview', async () => {
            const mem = process.memoryUsage();
            const users = authService.getAllUsers();
            const weakDefaultPw = await usesDefaultPassword();
            const checks = [
                { id: 'node_env', ok: config_1.config.nodeEnv === 'production', label: 'NODE_ENV is production', hint: 'Set NODE_ENV=production on live servers (hides internal error details).' },
                { id: 'jwt_secret', ok: config_1.config.jwtSecret.length >= 32 && !/change-in-production/.test(config_1.config.jwtSecret), label: 'Strong JWT_SECRET configured', hint: 'Set JWT_SECRET to 64+ random hex characters.' },
                { id: 'default_password', ok: !weakDefaultPw, label: 'Default admin password changed', hint: 'User "admin" still uses admin123 — change it now.' },
                { id: 'cors', ok: config_1.config.corsOrigins.length > 0 && !config_1.config.corsOrigins.includes('*'), label: 'CORS restricted to known origins', hint: 'Set CORS_ORIGINS to your front-end origin(s).' },
                { id: 'admin_ips', ok: config_1.config.admin.allowedIps.length > 0, label: 'Admin panel IP allow-list', hint: 'Set ADMIN_ALLOWED_IPS to restrict who can reach the admin panel.' },
                { id: 'admin_2fa', ok: users.filter((u) => u.role === 'admin').every((u) => u.twoFactor?.enabled), label: 'All admins use two-factor auth', hint: 'Enable 2FA under Settings for every admin, then set ADMIN_REQUIRE_2FA=true.' },
                { id: 'require_2fa', ok: config_1.config.admin.require2fa, label: '2FA required for admin access', hint: 'Set ADMIN_REQUIRE_2FA=true in .env on the server (after every admin has 2FA).' },
                { id: 'env_editor', ok: !config_1.config.showEnvOnWeb, label: 'Raw .env editor in /web disabled', hint: 'SHOW_ENVONWEB=true lets the /web UI edit every .env key. The admin panel’s Settings page is safer.' },
                { id: 'backups', ok: backupService.getConfig().enabled, label: 'Automatic backups enabled', hint: 'Turn on scheduled backups on the Backups page.' },
                { id: 'wal_fsync', ok: config_1.config.walFsync, label: 'Writes survive power loss (fsync)', hint: 'Set WAL_FSYNC=true. Writes are acknowledged only once on disk (group commit keeps it fast).' },
                { id: 'encryption', ok: encryptionStatus.enabled, label: `Data encrypted at rest (${engine.storageInfo().engine === 'disk' ? 'AES-256-XTS storage, AES-256-GCM backups' : 'AES-256-GCM'})`, hint: 'Remove ENCRYPTION_AT_REST=false so data files and backups are unreadable without the key.' },
                { id: 'storage_engine', ok: engine.storageInfo().engine === 'disk', label: 'Disk storage engine (data can exceed RAM)', hint: 'Set STORAGE_ENGINE=disk: documents and indexes then live in an encrypted on-disk B-tree with a RAM cache instead of entirely in memory.' },
                { id: 'encryption_key', ok: encryptionStatus.enabled && encryptionStatus.source === 'env', label: 'Encryption key kept off the data disk', hint: 'Set DB_ENCRYPTION_KEY (e.g. from a secrets manager) instead of keeping opendbs.key next to the data. Keep a safe copy — without it the data cannot be read.' },
            ];
            return {
                server: {
                    version: version_1.VERSION.version,
                    builtAt: version_1.VERSION.builtAt,
                    commit: version_1.VERSION.commit,
                    node: process.version,
                    platform: `${os_1.default.platform()} ${os_1.default.arch()}`,
                    pid: process.pid,
                    uptimeSec: Math.round(process.uptime()),
                    env: config_1.config.nodeEnv,
                    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
                    load: os_1.default.loadavg(),
                    cpus: os_1.default.cpus().length,
                },
                engine: engine.getEngineStats(),
                users: { total: users.length, admins: users.filter((u) => u.role === 'admin').length },
                security: { checks, score: checks.filter((c) => c.ok).length, of: checks.length },
            };
        });
        fastify.get('/audit', async (request) => {
            const { limit, filter } = request.query;
            return { events: audit.list(parseInt(limit || '200', 10) || 200, typeof filter === 'string' ? filter.slice(0, 100) : undefined) };
        });
        fastify.post('/flush', async (request) => {
            const started = Date.now();
            engine.flushAll();
            engine.flushNativeSearch();
            audit.record({ action: 'engine.flush', actor: request.user.username, ip: request.ip, ok: true });
            return { message: 'All pending writes flushed to snapshots', ms: Date.now() - started };
        });
        // ── API access keys ──────────────────────────────────────────────
        // The caller's IP as the server sees it (for "add my IP" in the UI).
        fastify.get('/my-ip', async (request) => ({ ip: (0, access_key_service_1.normalizeIp)(request.ip), trustProxy: config_1.config.trustProxy }));
        // ── Cluster (replication / failover) — about this node; never forwarded ──
        fastify.get('/cluster', async () => cluster ? cluster.info() : {
            enabled: false,
            storageEngine: engine.storageInfo().engine,
            hint: 'Set CLUSTER_ENABLED=true, CLUSTER_SECRET, CLUSTER_ADVERTISE_URL and CLUSTER_PEERS on every member (Settings → Cluster), then restart.',
        });
        const clusterAction = (name, fn) => fastify.post(`/cluster/${name}`, async (request, reply) => {
            if (!cluster)
                return reply.status(400).send({ error: 'Replication is not enabled on this server' });
            try {
                fn(cluster, request.body ?? {});
                audit.record({ action: `cluster.${name}`, actor: request.user.username, ip: request.ip, ok: true });
                return { ok: true, cluster: cluster.info() };
            }
            catch (e) {
                audit.record({ action: `cluster.${name}`, actor: request.user.username, ip: request.ip, ok: false, detail: e.message });
                return reply.status(400).send({ error: e.message });
            }
        });
        clusterAction('step-down', (c) => c.stepDown());
        clusterAction('elect', (c) => c.electNow());
        clusterAction('force-primary', (c, body) => {
            if (body.confirm !== 'FORCE')
                throw new Error('Send { "confirm": "FORCE" }: only do this when the other members are gone for good');
            c.forcePrimary();
        });
        // ── Sharding (configuration lives in system racks: replicated, and forwarded to the primary) ──
        const shards = deps.shardRouter ?? null;
        const shardCall = (action, fn) => async (request, reply) => {
            if (!shards)
                return reply.status(503).send({ error: 'Sharding is not available' });
            const target = JSON.stringify(request.params ?? {}).slice(0, 120);
            try {
                const result = await fn(shards, request);
                if (request.method !== 'GET')
                    audit.record({ action: `sharding.${action}`, actor: request.user.username, ip: request.ip, target, ok: true });
                return result ?? { ok: true };
            }
            catch (e) {
                if (request.method !== 'GET')
                    audit.record({ action: `sharding.${action}`, actor: request.user.username, ip: request.ip, target, ok: false, detail: e.message });
                return reply.status(e.status ?? 400).send({ error: e.message });
            }
        };
        fastify.get('/sharding', shardCall('info', (r) => r.info()));
        fastify.post('/sharding/shards', shardCall('shard.add', (r, req) => r.addShard((req.body ?? {}))));
        fastify.post('/sharding/shards/:name/test', shardCall('shard.test', (r, req) => r.testShard(req.params.name)));
        fastify.delete('/sharding/shards/:name', shardCall('shard.remove', (r, req) => r.removeShard(req.params.name)));
        fastify.post('/sharding/racks', shardCall('rack.create', (r, req) => r.createRack((req.body ?? {}))));
        const rackOf = (r, req) => {
            const { database, rack } = req.params;
            const def = r.rackDef(database, rack);
            if (!def)
                throw Object.assign(new Error(`${database}/${rack} is not sharded`), { status: 404 });
            return def;
        };
        fastify.get('/sharding/racks/:database/:rack', shardCall('rack.stats', (r, req) => r.rackStats(rackOf(r, req))));
        fastify.post('/sharding/racks/:database/:rack/rebalance', shardCall('rack.rebalance', (r, req) => r.rebalance(rackOf(r, req), (req.body ?? {}).shards)));
        fastify.get('/access-keys', async () => ({ keys: accessKeys.list() }));
        fastify.post('/access-keys', async (request, reply) => {
            try {
                const { key, record } = accessKeys.create((request.body ?? {}), request.user.username);
                audit.record({ action: 'apikey.create', actor: request.user.username, ip: request.ip, target: `${record.name} (#${record.id})`, ok: true, detail: `ips=${record.allowedIps.join(',')}` });
                return reply.status(201).send({ key, record });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        fastify.patch('/access-keys/:id', async (request, reply) => {
            const { id } = request.params;
            try {
                const record = accessKeys.update(id, (request.body ?? {}));
                audit.record({ action: 'apikey.update', actor: request.user.username, ip: request.ip, target: `${record.name} (#${id})`, ok: true, detail: Object.keys(request.body ?? {}).join(',') });
                return { record };
            }
            catch (e) {
                return reply.status(/not found/.test(e.message) ? 404 : 400).send({ error: e.message });
            }
        });
        fastify.post('/access-keys/:id/rotate', async (request, reply) => {
            const { id } = request.params;
            try {
                const { key, record } = accessKeys.rotate(id);
                audit.record({ action: 'apikey.rotate', actor: request.user.username, ip: request.ip, target: `${record.name} (#${id})`, ok: true });
                return { key, record };
            }
            catch (e) {
                return reply.status(404).send({ error: e.message });
            }
        });
        fastify.delete('/access-keys/:id', async (request, reply) => {
            const { id } = request.params;
            try {
                accessKeys.delete(id);
                audit.record({ action: 'apikey.delete', actor: request.user.username, ip: request.ip, target: `#${id}`, ok: true });
                return { message: 'API key deleted' };
            }
            catch (e) {
                return reply.status(404).send({ error: e.message });
            }
        });
        fastify.get('/databases/:database/racks/:rack/indexes', async (request, reply) => {
            const { database, rack } = request.params;
            try {
                return { indexes: engine.getIndexDetails(database, rack) };
            }
            catch (e) {
                return reply.status(404).send({ error: e.message });
            }
        });
    };
}
//# sourceMappingURL=admin.js.map