"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyService = void 0;
const sql_bridge_service_1 = require("./sql-bridge.service");
/**
 * Safe retries of writes (Idempotency-Key header).
 *
 * A client that loses its connection mid-write can't know whether the write
 * happened. The OpenDBS drivers send every write with an Idempotency-Key and
 * re-send it with the same key (possibly to another cluster member after a
 * failover). The first time, the response is recorded in a system rack — in
 * the same atomic batch as the write itself, and replicated like any data —
 * so a repeat returns the recorded response instead of writing twice.
 *
 * A record belongs to the caller that made it (user / access key, verified
 * here — this hook runs before route authentication): another caller using
 * the same key never sees it. Only writes are recorded, never admin,
 * settings, backup or auth traffic (those responses can contain secrets).
 */
const DB = '_opendbs_system';
const RACK = 'request_log';
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TTL_MS = 15 * 60_000;
const MAX_BODY = 256 * 1024;
/** Never recorded: responses may hold secrets (new API keys, 2FA setup, backup settings). */
const SKIP = /^\/api\/(auth|cluster|admin|settings|backup)\//;
/** POSTs that only read. */
const READ_POST = /\/(search(\/[^/]*)?|aggregate|partial|bucket-scan)$/;
class IdempotencyService {
    engine;
    identify;
    inProgress = new Map();
    releases = new WeakMap();
    constructor(engine, identify) {
        this.engine = engine;
        this.identify = identify;
        try {
            engine.createDatabase(DB);
            if (engine.getRackCount(DB, RACK) < 0) {
                engine.createRack(DB, RACK);
                engine.createIndex(DB, RACK, 'rid', { unique: true });
                engine.createIndex(DB, RACK, 'at');
            }
        }
        catch { /* read-only replica: the primary creates it */ }
        const t = setInterval(() => this.expire(), 60_000);
        t.unref();
    }
    keyOf(request) {
        if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
            return null;
        const k = request.headers['idempotency-key'];
        if (typeof k !== 'string' || !KEY_RE.test(k))
            return null;
        const url = request.url.split('?')[0];
        if (SKIP.test(url))
            return null;
        if (request.method === 'POST' && READ_POST.test(url))
            return null;
        if (url.startsWith('/api/sql/')) {
            // Reads are safe to repeat; only statements that change data are recorded.
            const q = request.body?.query;
            try {
                if (typeof q !== 'string' || (0, sql_bridge_service_1.requiredSQLPermission)(q) === 'read')
                    return null;
            }
            catch {
                return null;
            }
        }
        return k;
    }
    /** Record id: the client's key scoped to the verified caller. */
    ridOf(request) {
        const k = this.keyOf(request);
        if (!k)
            return null;
        const who = this.identify(request);
        return who ? `${who}|${k}` : null;
    }
    find(rid) {
        if (this.engine.getRackCount(DB, RACK) < 0)
            return null;
        return this.engine.query(DB, RACK, { rid }, { limit: 1 }).results[0] ?? null;
    }
    expire() {
        if (this.engine.isReadOnly() || this.engine.getRackCount(DB, RACK) < 0)
            return;
        const old = this.engine.query(DB, RACK, { at: { $lt: Date.now() - TTL_MS } }, { limit: 5000 }).results;
        for (const r of old)
            this.engine.delete(DB, RACK, String(r.id));
    }
    register(fastify) {
        // Before the handler: a repeated key gets the recorded response.
        fastify.addHook('preHandler', async (request, reply) => {
            const rid = this.ridOf(request);
            if (!rid || this.engine.isReadOnly() || reply.sent)
                return;
            // The same key arriving twice at once: wait for the first to finish.
            const running = this.inProgress.get(rid);
            if (running)
                await running;
            const hit = this.find(rid);
            if (hit) {
                if (hit.method !== request.method || hit.url !== request.url) {
                    return reply.status(422).send({ error: 'Idempotency-Key was already used for a different request' });
                }
                reply.header('idempotent-replay', 'true');
                if (hit.contentType)
                    reply.header('content-type', hit.contentType);
                return reply.status(hit.status).send(hit.body);
            }
            let release;
            this.inProgress.set(rid, new Promise((r) => { release = r; }));
            this.releases.set(request, () => { this.inProgress.delete(rid); release(); });
        });
    }
    /**
     * onSend: records the response. Registered before the durability hook, so
     * the record joins the write's own commit batch.
     */
    async record(request, reply, payload) {
        const release = this.releases.get(request);
        if (!release)
            return;
        try {
            const rid = this.ridOf(request);
            if (!rid || reply.statusCode >= 500 || reply.getHeader('idempotent-replay'))
                return;
            if (typeof payload !== 'string' && !Buffer.isBuffer(payload))
                return;
            const body = payload.toString();
            if (body.length > MAX_BODY)
                return;
            const ct = reply.getHeader('content-type');
            this.engine.insert(DB, RACK, {
                rid, method: request.method, url: request.url, status: reply.statusCode, body, at: Date.now(),
                ...(typeof ct === 'string' ? { contentType: ct } : {}),
            });
        }
        catch { /* duplicate key from a concurrent request, or read-only */ }
        finally {
            release();
        }
    }
}
exports.IdempotencyService = IdempotencyService;
//# sourceMappingURL=idempotency.js.map