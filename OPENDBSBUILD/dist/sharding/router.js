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
exports.ShardRouter = exports.SHARD_HEADER = exports.LOCAL = exports.BUCKETS = void 0;
exports.bucketOf = bucketOf;
exports.parseListQuery = parseListQuery;
const crypto = __importStar(require("crypto"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const security_middleware_1 = require("../middleware/security.middleware");
const functions_1 = require("../sql/functions");
const matcher_1 = require("../query/matcher");
const aggregate_1 = require("../query/aggregate");
const agg_state_1 = require("../sql/agg-state");
const executor_1 = require("../sql/executor");
const config_1 = require("../config");
/**
 * Sharding: one rack spread over several OpenDBS servers.
 *
 * This server is the router. Other servers (each may itself be a replicated
 * cluster) are registered as shards; "local" is this server's own storage.
 * A sharded rack hashes its shard key into 4096 buckets; each bucket lives
 * on one shard. Document ids are seq × 4096 + bucket, so an id alone tells
 * which shard holds the document. Queries go to every shard (or only the
 * ones the shard key points at) and the results are merged in the same
 * order a single server would return; GROUP BY runs as partial aggregates
 * on every shard (each using all its cores) merged here.
 */
exports.BUCKETS = 4096;
const SYSTEM_DB = '_opendbs_system';
const SHARDS_RACK = 'shards';
const RACKS_RACK = 'sharded_racks';
exports.LOCAL = 'local';
const ID_BLOCK = 1024;
/** Marks router→shard traffic (exempts it from the rate limit when sent with a valid admin/access key). */
exports.SHARD_HEADER = 'x-opendbs-shard-request';
function bucketOf(value) {
    const s = (0, functions_1.valueKey)(value);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % exports.BUCKETS;
}
class ShardError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
/** A shard: remote server(s) with failover, or this server itself (in-process). */
class Shard {
    name;
    urls;
    apiKey;
    inject;
    constructor(name, urls, apiKey, inject) {
        this.name = name;
        this.urls = urls;
        this.apiKey = apiKey;
        this.inject = inject;
    }
    async request(method, path, body) {
        const headers = { [exports.SHARD_HEADER]: '1' };
        if (body !== undefined)
            headers['content-type'] = 'application/json';
        if (this.inject) {
            headers[auth_middleware_1.INTERNAL_HEADER] = auth_middleware_1.INTERNAL_TOKEN;
            const res = await this.inject.inject({ method: method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
            let data = null;
            try {
                data = res.body ? JSON.parse(res.body) : null;
            }
            catch {
                data = res.body;
            }
            return { status: res.statusCode, data };
        }
        if (this.apiKey)
            headers['x-api-key'] = this.apiKey;
        // Retried writes (another URL of a replicated shard) must not apply twice.
        if (method !== 'GET' && !/\/(search(\/[^/]*)?|partial|bucket-scan|aggregate)$/.test(path))
            headers['idempotency-key'] = crypto.randomUUID();
        let last = null;
        for (let round = 0; round < 2; round++) {
            for (const url of this.urls) {
                try {
                    const res = await fetch(url + path, {
                        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
                    });
                    const text = await res.text();
                    let data = null;
                    try {
                        data = text ? JSON.parse(text) : null;
                    }
                    catch {
                        data = text;
                    }
                    if (res.status === 503) {
                        last = new ShardError(data?.error || 'unavailable', 503);
                        continue;
                    }
                    return { status: res.status, data };
                }
                catch (e) {
                    last = e;
                }
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        throw new ShardError(`Shard '${this.name}' is unreachable: ${last?.message ?? 'no address'}`, 503);
    }
    /** Request that must succeed. */
    async ok(method, path, body) {
        const r = await this.request(method, path, body);
        if (r.status >= 400)
            throw new ShardError(`Shard '${this.name}': ${r.data?.error || r.data?.message || `HTTP ${r.status}`}`, r.status);
        return r.data;
    }
}
const enc = encodeURIComponent;
class ShardRouter {
    engine;
    auth;
    shards = new Map();
    shardDefs = new Map();
    racks = new Map();
    loadedVersion = '';
    fastify = null;
    idBlocks = new Map();
    /** Writes running per rack, and racks whose writes are paused (rebalance). */
    inflight = new Map();
    pausing = new Set();
    /** Racks this process is rebalancing or cleaning up. */
    busy = new Set();
    stats = { routed: 0, scattered: 0, rebalances: 0 };
    constructor(engine, auth) {
        this.engine = engine;
        this.auth = auth;
        try {
            engine.createDatabase(SYSTEM_DB);
            if (engine.getRackCount(SYSTEM_DB, SHARDS_RACK) < 0)
                engine.createRack(SYSTEM_DB, SHARDS_RACK);
            if (engine.getRackCount(SYSTEM_DB, RACKS_RACK) < 0)
                engine.createRack(SYSTEM_DB, RACKS_RACK);
        }
        catch { /* read-only replica: the primary creates them */ }
    }
    // ───────────────────────────── config ─────────────────────────────
    refresh() {
        const v = `${this.engine.getRackVersion(SYSTEM_DB, SHARDS_RACK)}:${this.engine.getRackVersion(SYSTEM_DB, RACKS_RACK)}`;
        if (v === this.loadedVersion)
            return;
        this.loadedVersion = v;
        this.shardDefs.clear();
        this.shards.clear();
        if (this.fastify)
            this.shards.set(exports.LOCAL, new Shard(exports.LOCAL, [], null, this.fastify));
        if (this.engine.getRackCount(SYSTEM_DB, SHARDS_RACK) >= 0) {
            for (const d of this.engine.query(SYSTEM_DB, SHARDS_RACK, {}).results) {
                this.shardDefs.set(d.name, d);
                let key = null;
                try {
                    key = d.keySealed ? this.auth.secretBox.open(d.keySealed) : null;
                }
                catch {
                    key = null;
                }
                this.shards.set(d.name, new Shard(d.name, d.urls, key, null));
            }
        }
        this.racks.clear();
        if (this.engine.getRackCount(SYSTEM_DB, RACKS_RACK) >= 0) {
            for (const r of this.engine.query(SYSTEM_DB, RACKS_RACK, {}).results) {
                this.racks.set(`${r.database}\u0000${r.rack}`, { ...r, id: String(r.id) });
            }
        }
    }
    rackDef(database, rack) {
        this.refresh();
        return this.racks.get(`${database}\u0000${rack}`) ?? null;
    }
    isSharded(database, rack) {
        return this.rackDef(database, rack) !== null;
    }
    shard(name) {
        this.refresh();
        const s = this.shards.get(name);
        if (!s)
            throw new ShardError(`Unknown shard '${name}'`, 400);
        return s;
    }
    shardOfBucket(def, b) {
        return this.shard(def.shards[def.buckets[b]]);
    }
    shardOfId(def, id) {
        const n = (0, functions_1.canonicalNumber)(String(id));
        if (n === null || !Number.isSafeInteger(n) || n < 0)
            return null;
        return this.shardOfBucket(def, n % exports.BUCKETS);
    }
    /** Shards that can hold matches for a query (all, unless the shard key or id narrows it). */
    targets(def, query) {
        const owners = (buckets) => Array.from(new Set(buckets.map((b) => def.shards[def.buckets[b]]))).map((n) => this.shard(n));
        const all = () => Array.from(new Set(def.buckets)).map((i) => this.shard(def.shards[i]));
        if (!(0, security_middleware_1.isPlainObject)(query))
            return all();
        const valuesOf = (cond) => {
            const prim = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
            if (prim(cond))
                return [cond];
            if ((0, security_middleware_1.isPlainObject)(cond) && Object.keys(cond).length === 1) {
                if (prim(cond.$eq))
                    return [cond.$eq];
                if (Array.isArray(cond.$in) && cond.$in.length <= 1000 && cond.$in.every(prim))
                    return cond.$in;
            }
            return null;
        };
        const ids = query.id !== undefined ? valuesOf(query.id) : null;
        if (ids) {
            const buckets = ids.map((v) => (0, functions_1.canonicalNumber)(String(v))).filter((n) => n !== null && Number.isSafeInteger(n) && n >= 0).map((n) => n % exports.BUCKETS);
            return owners(buckets);
        }
        if (def.key !== 'id' && query[def.key] !== undefined) {
            const vals = valuesOf(query[def.key]);
            // Documents without a shard key are spread by id, so NULL can be anywhere.
            if (vals && !vals.includes(null))
                return owners(vals.map(bucketOf));
        }
        return all();
    }
    /** Saves only the given fields (never a stale nextSeq). */
    saveRack(def, changes) {
        Object.assign(def, changes);
        this.engine.patch(SYSTEM_DB, RACKS_RACK, def.id, changes);
        this.loadedVersion = '';
    }
    /** Buckets a shard owns under the current map. */
    ownedBy(def, shard) {
        const i = def.shards.indexOf(shard);
        const out = [];
        for (let b = 0; b < exports.BUCKETS; b++)
            if (def.buckets[b] === i)
                out.push(b);
        return out;
    }
    /** Reserves sequence numbers for new ids (in blocks, persisted so a new primary never reuses them). */
    allocSeq(def, n) {
        const k = `${def.database}\u0000${def.rack}`;
        let block = this.idBlocks.get(k);
        if (!block || block.next + n > block.end) {
            const size = Math.max(ID_BLOCK, n);
            const start = Math.max(def.nextSeq, block?.end ?? 0);
            def.nextSeq = start + size;
            this.engine.patch(SYSTEM_DB, RACKS_RACK, def.id, { nextSeq: def.nextSeq });
            block = { next: start, end: start + size };
            this.idBlocks.set(k, block);
        }
        const first = block.next;
        block.next += n;
        return first;
    }
    /** Runs a write unless the rack is being rebalanced; a rebalance waits for running writes to finish. */
    async writing(def, fn) {
        const k = `${def.database}\u0000${def.rack}`;
        if ((this.rackDef(def.database, def.rack) ?? def).state === 'rebalancing' || this.pausing.has(k)) {
            throw new ShardError(`${def.database}/${def.rack} is being rebalanced; retry in a moment`, 503);
        }
        this.inflight.set(k, (this.inflight.get(k) ?? 0) + 1);
        try {
            return await fn();
        }
        finally {
            this.inflight.set(k, this.inflight.get(k) - 1);
        }
    }
    // ───────────────────────────── data operations ─────────────────────────────
    insert(def, docs) {
        return this.writing(def, () => this.insertNow(def, docs));
    }
    async insertNow(def, docs) {
        for (const [i, d] of docs.entries())
            if (!(0, security_middleware_1.isPlainObject)(d))
                throw new ShardError(`Item ${i}: document must be a JSON object`, 400);
        const seq0 = this.allocSeq(def, docs.length);
        const ids = [];
        const perShard = new Map();
        docs.forEach((d, i) => {
            const seq = seq0 + i;
            const kv = def.key === 'id' ? undefined : (0, matcher_1.getPath)(d, def.key);
            const b = kv === undefined || kv === null ? seq % exports.BUCKETS : bucketOf(kv);
            const id = String(seq * exports.BUCKETS + b);
            ids.push(id);
            const s = this.shardOfBucket(def, b);
            if (!perShard.has(s))
                perShard.set(s, []);
            const data = { ...d };
            delete data.id;
            perShard.get(s).push({ id, data });
        });
        const done = [];
        try {
            await Promise.all(Array.from(perShard, async ([s, batch]) => {
                await s.ok('POST', `/api/shard/${enc(def.database)}/${enc(def.rack)}/put`, { docs: batch });
                done.push([s, batch.map((b) => b.id)]);
            }));
        }
        catch (e) {
            // Keep the batch all-or-nothing: undo what other shards already stored.
            await Promise.all(done.map(([s, list]) => s.request('POST', `/api/shard/${enc(def.database)}/${enc(def.rack)}/delete`, { ids: list }).catch(() => undefined)));
            throw e;
        }
        this.stats.routed++;
        return ids;
    }
    async get(def, id, populate) {
        const s = this.shardOfId(def, id);
        if (!s)
            return { status: 404, data: { error: 'Document not found' } };
        return s.request('GET', `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}/documents/${enc(id)}${populate ? '?populate=true' : ''}`);
    }
    checkKeyUnchanged(def, id, data) {
        if (def.key === 'id' || !(0, security_middleware_1.isPlainObject)(data))
            return;
        const v = (0, matcher_1.getPath)(data, def.key);
        if (v === undefined)
            return;
        const n = Number(id);
        if (bucketOf(v) !== n % exports.BUCKETS)
            throw new ShardError(`The shard key '${def.key}' of an existing document can't change (delete and re-insert it instead)`, 400);
    }
    /** PUT (replace) or PATCH (merge). PUT of a missing id inserts a new document unless `upsert` is false. */
    modify(def, method, id, data, upsert = true) {
        return this.writing(def, () => this.modifyNow(def, method, id, data, upsert));
    }
    async modifyNow(def, method, id, data, upsert) {
        const s = this.shardOfId(def, id);
        if (method === 'PUT') {
            if (!(0, security_middleware_1.isPlainObject)(data))
                return { status: 400, data: { error: 'Request body must be a JSON object' } };
            const exists = s ? (await this.get(def, id, false)).status === 200 : false;
            if (!exists) {
                if (!upsert)
                    return { status: 404, data: { error: 'Document not found' } };
                // Same as an unsharded rack: an upsert of a missing id inserts a new document (new id).
                const [newId] = await this.insertNow(def, [data]);
                return { status: 201, data: { message: 'Document created (upsert)', id: newId, requestedId: id, upserted: true } };
            }
            this.checkKeyUnchanged(def, id, data);
            const clean = { ...data };
            delete clean.id;
            delete clean._metadata;
            // Replace with exactly this id (the shard's own PUT would upsert under a new local id).
            await s.ok('POST', `/api/shard/${enc(def.database)}/${enc(def.rack)}/put`, { docs: [{ id, data: clean }], replace: true });
            return { status: 200, data: { message: 'Document updated', id, upserted: false } };
        }
        if (!s)
            return { status: 404, data: { error: 'Document not found' } };
        this.checkKeyUnchanged(def, id, data);
        return s.request(method, `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}/documents/${enc(id)}`, data);
    }
    remove(def, id) {
        return this.writing(def, async () => {
            const s = this.shardOfId(def, id);
            if (!s)
                return { status: 404, data: { error: 'Document not found' } };
            return s.request('DELETE', `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}/documents/${enc(id)}`);
        });
    }
    // SQL over sharded tables (engine-style results: null / false when missing, errors thrown).
    async sqlGet(def, id) {
        const r = await this.get(def, id, false);
        if (r.status === 404)
            return null;
        if (r.status >= 400)
            throw new ShardError(r.data?.error ?? `HTTP ${r.status}`, r.status);
        return r.data;
    }
    async sqlInsert(def, data) {
        return (await this.insert(def, [data]))[0];
    }
    async sqlWrite(def, method, id, data) {
        const r = method === 'DELETE' ? await this.remove(def, id) : await this.modify(def, method, id, data, false);
        if (r.status === 404)
            return false;
        if (r.status >= 400)
            throw new ShardError(r.data?.error ?? `HTTP ${r.status}`, r.status);
        return true;
    }
    /** Schema / index change applied on every shard of the rack (sub: path below the rack, e.g. "/indexes"). */
    async ddl(def, method, sub, body) {
        const r = await this.broadcast(def, method, `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}${sub}`, body);
        if (r.status >= 400)
            throw new ShardError(r.data?.error ?? `HTTP ${r.status}`, r.status);
        return r.data;
    }
    /** Scatter-gather query, merged in single-server order (sort field, missing last, then id). */
    async query(def, query, opts = {}) {
        const skip = opts.skip ?? 0;
        const need = opts.limit ? skip + opts.limit : undefined;
        if (need !== undefined && need > config_1.config.maxQueryLimit) {
            throw new ShardError(`On a sharded rack, skip + limit can be at most ${config_1.config.maxQueryLimit} (narrow the query or sort and filter instead of paging deeply)`, 400);
        }
        const targets = this.targets(def, query);
        this.stats.scattered++;
        // While buckets move, a shard may also hold copies it doesn't own: it filters them out itself.
        const moving = def.state !== 'active';
        const parts = await Promise.all(targets.map((s) => s.ok('POST', moving
            ? `/api/shard/${enc(def.database)}/${enc(def.rack)}/search`
            : `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}/search`, {
            query: query ?? {}, skip: 0, ...(need !== undefined ? { limit: need } : {}), ...(opts.sort ? { sort: opts.sort } : {}), populate: Boolean(opts.populate),
            ...(moving ? { owned: this.ownedBy(def, s.name) } : {}),
        })));
        let total = 0;
        const all = [];
        for (const p of parts) {
            total += p.total;
            for (const r of p.results)
                all.push(r);
        }
        const sortVal = (d) => {
            if (!opts.sort)
                return undefined;
            const f = opts.sort.field;
            if (f === 'id') {
                const n = Number(d.id);
                return Number.isFinite(n) ? n : d.id;
            }
            const v = (0, matcher_1.getPath)(d, f);
            return v === undefined && (f === 'createdAt' || f === 'updatedAt') ? d._metadata?.[f] : v;
        };
        const dir = opts.sort?.order === 'desc' ? -1 : 1;
        const keyed = all.map((d) => ({ d, v: sortVal(d), n: Number(d.id) }));
        keyed.sort((a, b) => {
            if (opts.sort) {
                const an = a.v === undefined || a.v === null, bn = b.v === undefined || b.v === null;
                const c = an || bn ? (an && bn ? 0 : an ? 1 : -1) : dir * (0, matcher_1.compareValues)(a.v, b.v);
                if (c !== 0)
                    return c;
            }
            return a.n - b.n;
        });
        return { results: keyed.slice(skip, need).map((k) => k.d), total };
    }
    async count(def, query) {
        const targets = this.targets(def, query);
        if ((!query || Object.keys(query).length === 0) && def.state === 'active') {
            const counts = await Promise.all(targets.map((s) => s.ok('GET', `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}/count`)));
            return counts.reduce((n, c) => n + c.count, 0);
        }
        return (await this.query(def, query, { limit: 1 })).total;
    }
    /** Distributed GROUP BY: partial states from every shard, merged and finished here. */
    async aggregate(def, query, groups, aggs, where) {
        const targets = this.targets(def, query);
        this.stats.scattered++;
        const moving = def.state !== 'active';
        const parts = await Promise.all(targets.map((s) => s.ok('POST', `/api/shard/${enc(def.database)}/${enc(def.rack)}/partial`, {
            query, groups, aggs, where, ...(moving ? { owned: this.ownedBy(def, s.name) } : {}),
        })));
        return (0, agg_state_1.finishPartials)((0, agg_state_1.mergePartials)(parts.flatMap((p) => p.groups)), groups, aggs);
    }
    /** Aggregation pipeline: a leading $match runs on the shards; the rest here. */
    async pipeline(def, pipeline) {
        let rest = pipeline;
        let initial = {};
        if (pipeline.length > 0 && (0, security_middleware_1.isPlainObject)(pipeline[0]) && (0, security_middleware_1.isPlainObject)(pipeline[0].$match) && Object.keys(pipeline[0]).length === 1) {
            initial = pipeline[0].$match;
            rest = pipeline.slice(1);
        }
        const input = (await this.query(def, initial)).results.map((r) => { delete r._metadata; return r; });
        const lookups = new Map();
        for (const st of rest) {
            if ((0, security_middleware_1.isPlainObject)(st) && (0, security_middleware_1.isPlainObject)(st.$lookup)) {
                const from = st.$lookup.from;
                if (typeof from !== 'string' || !(0, security_middleware_1.validateIdentifier)(from))
                    continue;
                const other = this.rackDef(def.database, from);
                lookups.set(from, other ? (await this.query(other, {})).results : this.engine.query(def.database, from, {}).results);
            }
        }
        return (0, aggregate_1.runPipeline)(input, rest, {
            lookup: (from, field, values) => {
                const rows = lookups.get(from) ?? [];
                const want = new Set(values.map((v) => (0, functions_1.valueKey)(v)));
                return rows.filter((r) => want.has((0, functions_1.valueKey)(field === 'id' ? r.id : (0, matcher_1.getPath)(r, field)))).map((r) => { const c = { ...r }; delete c._metadata; return c; });
            },
        });
    }
    /** Sends the same request to every shard of the rack (schema, index and clear operations). */
    async broadcast(def, method, path, body) {
        const names = Array.from(new Set([exports.LOCAL, ...def.shards]));
        const results = await Promise.all(names.map((n) => this.shard(n).request(method, path, body).then((r) => ({ n, r }))));
        const bad = results.find(({ r }) => r.status >= 400);
        if (bad)
            return { status: bad.r.status, data: { error: `Shard '${bad.n}': ${bad.r.data?.error || bad.r.data?.message || `HTTP ${bad.r.status}`}` } };
        return results.find(({ n }) => n === exports.LOCAL)?.r ?? results[0].r;
    }
    // ───────────────────────────── administration ─────────────────────────────
    listShards() {
        this.refresh();
        return [{ name: exports.LOCAL, urls: ['(this server)'], local: true }, ...Array.from(this.shardDefs.values()).map((d) => ({ name: d.name, urls: d.urls, local: false, addedAt: d.addedAt }))];
    }
    async addShard(input) {
        const name = String(input.name ?? '');
        if (!(0, security_middleware_1.validateIdentifier)(name) || name === exports.LOCAL)
            throw new ShardError('Shard name: letters, numbers, - and _ (not "local")', 400);
        const urls = (Array.isArray(input.urls) ? input.urls : String(input.urls ?? '').split(','))
            .map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
        if (urls.length === 0 || !urls.every((u) => /^https?:\/\/[^\s/]+(:\d+)?$/.test(u)))
            throw new ShardError('urls: http(s)://host:port, comma-separated for a replicated shard', 400);
        if (typeof input.apiKey !== 'string' || input.apiKey.length < 16)
            throw new ShardError('apiKey: an admin-issued API key of the shard server with read/write/delete on the sharded databases', 400);
        this.refresh();
        if (this.shardDefs.has(name))
            throw new ShardError(`Shard '${name}' already exists`, 409);
        const v = await this.probe(new Shard(name, urls, input.apiKey, null));
        this.engine.insert(SYSTEM_DB, SHARDS_RACK, { name, urls, keySealed: this.auth.secretBox.seal(input.apiKey), addedAt: new Date().toISOString() });
        return { name, urls, version: v };
    }
    /** Checks that the shard answers and accepts the key (an authenticated request); returns its version. */
    async probe(s) {
        await s.ok('GET', '/api/databases');
        const v = await s.request('GET', '/api/version');
        return v.status === 200 ? v.data?.version ?? null : null;
    }
    async testShard(name) {
        const t = Date.now();
        const version = await this.probe(this.shard(name));
        return { name, ok: true, version, ms: Date.now() - t };
    }
    removeShard(name) {
        this.refresh();
        const d = this.shardDefs.get(name);
        if (!d)
            throw new ShardError(`Unknown shard '${name}'`, 404);
        const users = Array.from(this.racks.values()).filter((r) => r.shards.includes(name));
        if (users.length)
            throw new ShardError(`Shard '${name}' still holds ${users.map((r) => `${r.database}/${r.rack}`).join(', ')} — rebalance them off it first`, 409);
        this.engine.delete(SYSTEM_DB, SHARDS_RACK, String(d.id));
    }
    async ensureRackOn(s, database, rack, type, schema) {
        const db = await s.request('POST', '/api/databases', { name: database });
        if (db.status >= 400 && db.status !== 409 && !/exist/i.test(db.data?.error ?? ''))
            throw new ShardError(`Shard '${s.name}': ${db.data?.error}`, db.status);
        const r = await s.request('POST', `/api/databases/${enc(database)}/racks`, { name: rack, type, ...(schema ? { schema } : {}) });
        if (r.status >= 400) {
            if (r.status !== 409 && !/exist/i.test(r.data?.error ?? ''))
                throw new ShardError(`Shard '${s.name}': ${r.data?.error}`, r.status);
            const c = await s.ok('GET', `/api/databases/${enc(database)}/racks/${enc(rack)}/count`);
            if (c.count > 0 && s.name !== exports.LOCAL)
                throw new ShardError(`Shard '${s.name}' already has a non-empty ${database}/${rack}`, 409);
        }
        // Same indexes as the router's copy.
        if (s.name !== exports.LOCAL && this.engine.getRackCount(database, rack) >= 0) {
            const base = `/api/databases/${enc(database)}/racks/${enc(rack)}`;
            for (const ix of this.engine.getIndexDetails(database, rack)) {
                if (ix.type === 'text')
                    await s.request('POST', `${base}/text-indexes`, { field: ix.field });
                else if (ix.type === 'vector')
                    await s.request('POST', `${base}/vector-indexes`, { field: ix.field });
                else
                    await s.request('POST', `${base}/indexes`, { fields: ix.fields ?? [ix.field], unique: ix.type === 'unique' });
            }
        }
    }
    /** Creates a new (empty) sharded rack on the given shards. */
    async createRack(input) {
        const database = String(input.database ?? ''), rack = String(input.rack ?? '');
        if (!(0, security_middleware_1.validateIdentifier)(database) || !(0, security_middleware_1.validateIdentifier)(rack) || database === SYSTEM_DB)
            throw new ShardError('Valid database and rack names are required', 400);
        const type = input.type === 'sql' ? 'sql' : 'nosql';
        const key = String(input.key ?? 'id');
        if (key !== 'id' && !(0, security_middleware_1.validateFieldName)(key))
            throw new ShardError('Invalid shard key field', 400);
        const shards = Array.isArray(input.shards) && input.shards.length ? input.shards.map(String) : [exports.LOCAL];
        this.refresh();
        for (const n of shards)
            if (!this.shards.has(n))
                throw new ShardError(`Unknown shard '${n}'`, 400);
        if (new Set(shards).size !== shards.length)
            throw new ShardError('A shard is listed twice', 400);
        if (this.isSharded(database, rack))
            throw new ShardError(`${database}/${rack} is already sharded`, 409);
        const existing = this.engine.getRackCount(database, rack);
        if (existing > 0)
            throw new ShardError(`${database}/${rack} already has data here; shard a new rack and copy into it (INSERT INTO new SELECT * FROM old)`, 409);
        // Remote shards first: if one refuses (key, permissions, schema), nothing changes here.
        const schema = existing === 0 ? this.engine.getRackSchema(database, rack).schema : (input.schema ?? null);
        for (const n of shards)
            if (n !== exports.LOCAL)
                await this.ensureRackOn(this.shard(n), database, rack, type, schema);
        // The router's own copy holds the schema and index definitions (and the data of the "local" shard).
        this.engine.createDatabase(database);
        if (existing < 0)
            this.engine.createRack(database, rack, type, (schema ?? undefined));
        const buckets = Array.from({ length: exports.BUCKETS }, (_, b) => b % shards.length);
        const def = { database, rack, key, type, shards, buckets, nextSeq: 1, state: 'active', createdAt: new Date().toISOString() };
        this.engine.insert(SYSTEM_DB, RACKS_RACK, def);
        this.loadedVersion = '';
        const warnings = [];
        for (const [col, d] of Object.entries(schema ?? {})) {
            if (d.unique && col !== key)
                warnings.push(`Column '${col}' is unique per shard only (it isn't the shard key)`);
        }
        return { ...def, warnings };
    }
    /** Stops sharding a rack and deletes its data on every shard. */
    async dropRack(def) {
        for (const n of def.shards) {
            if (n === exports.LOCAL)
                continue;
            const r = await this.shard(n).request('DELETE', `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}`);
            if (r.status >= 400 && r.status !== 404)
                throw new ShardError(`Shard '${n}': ${r.data?.error}`, r.status);
        }
        this.engine.delete(SYSTEM_DB, RACKS_RACK, def.id);
        this.loadedVersion = '';
        this.engine.deleteRack(def.database, def.rack);
        return { status: 200, data: { message: 'Rack deleted', database: def.database, rack: def.rack } };
    }
    async rackStats(def) {
        const per = await Promise.all(Array.from(new Set(def.shards)).map(async (n) => {
            const buckets = def.buckets.filter((i) => def.shards[i] === n).length;
            try {
                const c = await this.shard(n).ok('GET', `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}/count`);
                return { shard: n, buckets, documents: c.count };
            }
            catch (e) {
                return { shard: n, buckets, documents: null, error: e.message };
            }
        }));
        return { database: def.database, rack: def.rack, key: def.key, state: def.state, shards: per, documents: per.reduce((n, p) => n + (p.documents ?? 0), 0) };
    }
    /**
     * Moves buckets so the rack is spread evenly over `shards` (add or remove
     * shards). Writes to the rack pause (503, retried by the drivers) while
     * documents are copied; reads keep working throughout.
     */
    async rebalance(def, shards) {
        if (def.state !== 'active' || this.busy.has(`${def.database}\u0000${def.rack}`))
            throw new ShardError('A rebalance is already running', 409);
        if (!Array.isArray(shards) || shards.length === 0)
            throw new ShardError('shards: the complete list of shards the rack should use', 400);
        this.refresh();
        for (const n of shards)
            if (!this.shards.has(n))
                throw new ShardError(`Unknown shard '${n}'`, 400);
        const schema = this.engine.getRackSchema(def.database, def.rack).schema;
        for (const n of shards)
            if (n !== exports.LOCAL && !def.shards.includes(n))
                await this.ensureRackOn(this.shard(n), def.database, def.rack, def.type, schema);
        // New owner of every bucket: keep where possible, fill each shard up to its even share.
        const owner = def.buckets.map((i) => def.shards[i]);
        const share = new Map(shards.map((n, i) => [n, Math.floor(exports.BUCKETS / shards.length) + (i < exports.BUCKETS % shards.length ? 1 : 0)]));
        const next = owner.map(() => null);
        const held = new Map(shards.map((n) => [n, 0]));
        owner.forEach((o, b) => {
            if (share.has(o) && held.get(o) < share.get(o)) {
                next[b] = o;
                held.set(o, held.get(o) + 1);
            }
        });
        for (let b = 0; b < exports.BUCKETS; b++) {
            if (next[b])
                continue;
            const target = shards.find((n) => held.get(n) < share.get(n));
            next[b] = target;
            held.set(target, held.get(target) + 1);
        }
        const moves = new Map();
        for (let b = 0; b < exports.BUCKETS; b++) {
            if (next[b] === owner[b])
                continue;
            if (!moves.has(owner[b]))
                moves.set(owner[b], new Map());
            const m = moves.get(owner[b]);
            if (!m.has(next[b]))
                m.set(next[b], []);
            m.get(next[b]).push(b);
        }
        const k = `${def.database}\u0000${def.rack}`;
        const before = [...def.shards];
        this.busy.add(k);
        this.pausing.add(k);
        let copied = 0;
        try {
            this.saveRack(def, { state: 'rebalancing' });
            // Writes that started before the pause finish first (they may go to a bucket being copied).
            const t0 = Date.now();
            while ((this.inflight.get(k) ?? 0) > 0) {
                if (Date.now() - t0 > 30_000)
                    throw new ShardError('Writes did not finish within 30 s; rebalance cancelled', 503);
                await new Promise((r) => setTimeout(r, 20));
            }
            for (const [from, targets] of moves) {
                for (const [to, buckets] of targets) {
                    let after = null;
                    for (;;) {
                        const page = await this.shard(from).ok('POST', `/api/shard/${enc(def.database)}/${enc(def.rack)}/bucket-scan`, { buckets, after, limit: 2000 });
                        if (page.docs.length) {
                            await this.shard(to).ok('POST', `/api/shard/${enc(def.database)}/${enc(def.rack)}/put`, {
                                docs: page.docs.map((d) => ({ id: d.id, data: d.data, createdAt: d.createdAt, updatedAt: d.updatedAt })), replace: true,
                            });
                            copied += page.docs.length;
                        }
                        if (page.done)
                            break;
                        after = page.last;
                    }
                }
            }
        }
        catch (e) {
            // Old map stays; drop the partial copies on the new shards.
            this.saveRack(def, { state: 'cleaning' });
            this.pausing.delete(k);
            try {
                await this.cleanup(def, [...before, ...shards]);
            }
            catch { /* retried by recover() */ }
            this.busy.delete(k);
            throw e;
        }
        // Switch routing (writes resume), then remove the moved copies from their old shards.
        const list = Array.from(new Set(shards));
        this.saveRack(def, { shards: list, buckets: next.map((n) => list.indexOf(n)), state: 'cleaning' });
        this.pausing.delete(k);
        try {
            const removed = await this.cleanup(def, [...before, ...list]);
            this.stats.rebalances++;
            return { moved: copied, removedFromOldShards: removed, buckets: Object.fromEntries(list.map((n) => [n, held.get(n) ?? 0])) };
        }
        finally {
            this.busy.delete(k);
        }
    }
    /**
     * Deletes, on each listed shard, the documents of buckets it doesn't own
     * under the current map; then the rack is active again.
     */
    async cleanup(def, shardNames) {
        let removed = 0;
        for (const n of new Set(shardNames)) {
            const owned = new Set(this.ownedBy(def, n));
            const foreign = [];
            for (let b = 0; b < exports.BUCKETS; b++)
                if (!owned.has(b))
                    foreign.push(b);
            const s = this.shard(n);
            const path = `/api/shard/${enc(def.database)}/${enc(def.rack)}`;
            let after = null;
            for (;;) {
                const r = await s.request('POST', `${path}/bucket-scan`, { buckets: foreign, after, limit: 2000 });
                if (r.status === 404)
                    break; // this shard never had the rack
                if (r.status >= 400)
                    throw new ShardError(`Shard '${n}': ${r.data?.error ?? `HTTP ${r.status}`}`, r.status);
                const page = r.data;
                if (page.docs.length)
                    removed += (await s.ok('POST', `${path}/delete`, { ids: page.docs.map((d) => d.id) })).deleted;
                if (page.done)
                    break;
                after = page.last;
            }
        }
        this.saveRack(def, { state: 'active' });
        return removed;
    }
    /** Partial GROUP BY over the documents of the given buckets only (shard side, while buckets move). */
    partialOwned(database, rack, query, groups, aggs, where, owned) {
        const pred = where ? (0, executor_1.compileRowPredicate)(where) : null;
        const keyFns = groups.map(agg_state_1.fieldReader);
        const defs = aggs.map((a) => {
            const read = a.field === null ? null : (0, agg_state_1.fieldReader)(a.field);
            return { name: a.name, star: a.field === null, distinct: false, args: read ? [(doc) => read(doc)] : [] };
        });
        const out = new Map();
        for (const r of this.engine.query(database, rack, query).results) {
            const n = Number(r.id);
            if (!owned.has(n % exports.BUCKETS))
                continue;
            const data = { ...r };
            delete data.id;
            delete data._metadata;
            if (pred && !pred({ ...data, id: n }))
                continue;
            const doc = { id: String(r.id), data };
            const key = keyFns.map((f) => f(doc));
            const k = key.map(functions_1.valueKey).join('\u0001');
            let g = out.get(k);
            if (!g)
                out.set(k, (g = { key, states: defs.map(agg_state_1.newAggState) }));
            for (let i = 0; i < defs.length; i++)
                (0, agg_state_1.addAgg)(g.states[i], defs[i], doc, null);
        }
        return Array.from(out.values()).map((g) => ({ key: g.key, states: g.states.map(agg_state_1.serializeState) }));
    }
    /** Finishes rebalances interrupted by a crash or failover (run on the primary). */
    async recover() {
        if (this.engine.isReadOnly())
            return;
        this.refresh();
        for (const def of Array.from(this.racks.values())) {
            const k = `${def.database}\u0000${def.rack}`;
            if (def.state === 'active' || this.busy.has(k))
                continue;
            this.busy.add(k);
            try {
                // Interrupted while copying: the old map is still in force, so the copies get removed.
                if (def.state === 'rebalancing')
                    this.saveRack(def, { state: 'cleaning' });
                const removed = await this.cleanup(def, [exports.LOCAL, ...this.shardDefs.keys()]);
                console.log(`🧩 Sharding: finished an interrupted rebalance of ${def.database}/${def.rack} (${removed} stray copies removed)`);
            }
            catch (e) {
                console.warn(`⚠️  Sharding: cleanup of ${def.database}/${def.rack} failed (will retry): ${e.message}`);
            }
            finally {
                this.busy.delete(k);
            }
        }
    }
    // ───────────────────────────── HTTP ─────────────────────────────
    /** Shard-side endpoints (every server) + routing of requests for sharded racks (router). */
    register(fastify) {
        this.fastify = fastify;
        this.loadedVersion = '';
        const authn = (0, auth_middleware_1.authMiddleware)(this.auth);
        const guard = (perm) => ({ preHandler: [authn, (0, auth_middleware_1.checkPermission)(this.auth, perm)] });
        const p = (r) => r.params;
        const fail = (reply, e) => reply.status(e.status ?? (/not found/i.test(e.message) ? 404 : 400)).send({ error: e.message });
        // On the router, a sharded rack's local copy is written only by the router itself
        // (an id placed in a bucket this server doesn't own would break routing).
        const ownWrite = (request, reply) => {
            if (this.isSharded(p(request).database, p(request).rack) && !(0, auth_middleware_1.isInternalRequest)(request)) {
                reply.status(403).send({ error: 'This rack is sharded from this server: write through its normal API' });
                return false;
            }
            return true;
        };
        fastify.post('/api/shard/:database/:rack/put', guard('write'), async (request, reply) => {
            if (!ownWrite(request, reply))
                return reply;
            const { docs, replace } = (request.body ?? {});
            try {
                return { ids: this.engine.insertWithIds(p(request).database, p(request).rack, docs ?? [], Boolean(replace)) };
            }
            catch (e) {
                return fail(reply, e);
            }
        });
        fastify.post('/api/shard/:database/:rack/delete', guard('delete'), async (request, reply) => {
            if (!ownWrite(request, reply))
                return reply;
            const { ids } = (request.body ?? {});
            if (!Array.isArray(ids))
                return reply.status(400).send({ error: 'ids must be an array' });
            try {
                return { deleted: this.engine.deleteMany(p(request).database, p(request).rack, ids) };
            }
            catch (e) {
                return fail(reply, e);
            }
        });
        fastify.post('/api/shard/:database/:rack/bucket-scan', guard('read'), async (request, reply) => {
            const { buckets, after, limit } = (request.body ?? {});
            if (!Array.isArray(buckets))
                return reply.status(400).send({ error: 'buckets must be an array' });
            try {
                return this.engine.documentsInBuckets(p(request).database, p(request).rack, new Set(buckets.map(Number)), exports.BUCKETS, after ?? null, Math.min(5000, Number(limit) || 2000));
            }
            catch (e) {
                return fail(reply, e);
            }
        });
        fastify.post('/api/shard/:database/:rack/partial', guard('read'), async (request, reply) => {
            const { query, groups, aggs, where } = (request.body ?? {});
            if (!Array.isArray(groups) || !Array.isArray(aggs))
                return reply.status(400).send({ error: 'groups and aggs must be arrays' });
            try {
                if (Array.isArray(request.body.owned)) {
                    return { groups: this.partialOwned(p(request).database, p(request).rack, query ?? {}, groups, aggs, where, new Set(request.body.owned.map(Number))) };
                }
                return { groups: await this.engine.aggregatePartial(p(request).database, p(request).rack, query ?? {}, groups, aggs, where ?? undefined) };
            }
            catch (e) {
                return fail(reply, e);
            }
        });
        // Search limited to the buckets this shard owns (used while buckets move between shards).
        fastify.post('/api/shard/:database/:rack/search', guard('read'), async (request, reply) => {
            const { query, skip, limit, sort, populate, owned } = (request.body ?? {});
            if (!Array.isArray(owned))
                return reply.status(400).send({ error: 'owned must be an array' });
            try {
                const set = new Set(owned.map(Number));
                const r = await this.engine.queryAsync(p(request).database, p(request).rack, query ?? {}, {
                    sort: sort?.field ? { field: String(sort.field), order: sort.order === 'desc' ? 'desc' : 'asc' } : undefined, populate: populate === true,
                });
                const kept = r.results.filter((d) => set.has(Number(d.id) % exports.BUCKETS));
                const from = Math.max(0, Number(skip) || 0);
                return { results: kept.slice(from, limit ? from + Number(limit) : undefined), total: kept.length };
            }
            catch (e) {
                return fail(reply, e);
            }
        });
        const recover = () => { this.recover().catch(() => undefined); };
        setTimeout(recover, 3000).unref();
        setInterval(recover, 60_000).unref();
        // Router: requests for sharded racks are answered here instead of by the local handlers.
        fastify.addHook('preHandler', async (request, reply) => {
            // Only the router's own in-process calls skip routing; a client-supplied header never does.
            if ((0, auth_middleware_1.isInternalRequest)(request))
                return;
            const params = request.params;
            const route = request.routeOptions?.url ?? '';
            if (request.method === 'DELETE' && route === '/api/databases/:database' && params?.database) {
                this.refresh();
                const held = Array.from(this.racks.values()).filter((r) => r.database === params.database).map((r) => r.rack);
                if (held.length)
                    return reply.status(409).send({ error: `Database '${params.database}' has sharded racks (${held.join(', ')}); delete them first` });
                return;
            }
            if (!params?.database || !params?.rack)
                return;
            if (!route.startsWith('/api/databases/:database/racks/:rack'))
                return;
            const def = this.rackDef(params.database, params.rack);
            if (!def)
                return;
            const perm = request.method === 'GET' || route.endsWith('/search') || route.includes('/search/') || route.endsWith('/aggregate')
                ? 'read' : request.method === 'DELETE' ? 'delete' : 'write';
            await authn(request, reply);
            if (reply.sent)
                return reply;
            await (0, auth_middleware_1.checkPermission)(this.auth, perm)(request, reply);
            if (reply.sent)
                return reply;
            try {
                const r = await this.dispatch(def, route, request);
                return reply.status(r.status).send(r.data);
            }
            catch (e) {
                return fail(reply, e);
            }
        });
    }
    async dispatch(def, route, request) {
        const sub = route.slice('/api/databases/:database/racks/:rack'.length);
        const m = request.method;
        const body = request.body;
        const params = request.params;
        const qs = request.query;
        const base = `/api/databases/${enc(def.database)}/racks/${enc(def.rack)}`;
        const okJson = (data, status = 200) => ({ status, data });
        if (sub === '/documents' && m === 'POST') {
            let data = body;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                }
                catch {
                    return okJson({ error: 'Invalid JSON body' }, 400);
                }
            }
            if (Array.isArray(data)) {
                const ids = await this.insert(def, data);
                return okJson({ message: 'Documents inserted', ids, count: ids.length, database: def.database, rack: def.rack }, 201);
            }
            const [id] = await this.insert(def, [data ?? {}]);
            return okJson({ message: 'Document inserted', id, database: def.database, rack: def.rack }, 201);
        }
        if (sub === '/documents' && m === 'GET') {
            const { query, skip, limit, sort, populate, error } = parseListQuery(qs);
            if (error)
                return okJson({ error }, 400);
            const { results, total } = await this.query(def, query, { skip, limit, sort, populate });
            return okJson({ results, count: results.length, total, skip, limit: limit ?? null });
        }
        if (sub === '/documents/:id') {
            if (m === 'GET')
                return this.get(def, params.id, qs?.populate === 'true');
            if (m === 'PUT' || m === 'PATCH') {
                if (m === 'PATCH' && (!body || typeof body !== 'object' || Array.isArray(body)))
                    return okJson({ error: 'Request body must be a JSON object' }, 400);
                return this.modify(def, m, params.id, body);
            }
            if (m === 'DELETE')
                return this.remove(def, params.id);
        }
        if ((sub === '/search' || sub === '/search/') && m === 'POST') {
            if (!body?.query || typeof body.query !== 'object')
                return okJson({ error: 'Query object required' }, 400);
            const limit = body.limit !== undefined ? Math.max(1, Math.min(config_1.config.maxQueryLimit, Number(body.limit) || 100)) : undefined;
            const { results, total } = await this.query(def, body.query, {
                skip: Math.max(0, Number(body.skip) || 0), limit,
                sort: body.sort?.field ? { field: String(body.sort.field), order: body.sort.order === 'desc' ? 'desc' : 'asc' } : undefined,
                populate: body.populate === true,
            });
            return okJson({ results, count: results.length, total });
        }
        if ((sub === '/search/vector' || sub === '/search/fuzzy') && m === 'POST') {
            // Best matches from every shard, merged by score.
            const targets = this.targets(def, {});
            const parts = await Promise.all(targets.map((s) => s.ok('POST', base + sub, body)));
            // While buckets move, keep each document only from the shard that owns it.
            const owns = (shard, d) => def.state === 'active' || def.shards[def.buckets[Number(d.id) % exports.BUCKETS]] === shard;
            let results = parts.flatMap((x, i) => (x.results ?? []).filter((d) => owns(targets[i].name, d))).sort((a, b) => (b._metadata?.score ?? b.score ?? 0) - (a._metadata?.score ?? a.score ?? 0));
            if (sub === '/search/vector') {
                const k = Math.min(1000, Math.max(1, Math.floor(Number(body?.k ?? 10)) || 10));
                results = results.slice(0, k);
            }
            return okJson({ results, count: results.length });
        }
        if ((sub === '/search/range' || sub === '/search/pattern') && m === 'POST') {
            const field = body?.field;
            if (typeof field !== 'string' || !(0, security_middleware_1.validateFieldName)(field))
                return okJson({ error: 'A valid field is required' }, 400);
            const cond = {};
            if (sub === '/search/range') {
                if (body.min !== undefined)
                    cond.$gte = body.min;
                if (body.max !== undefined)
                    cond.$lte = body.max;
            }
            else {
                if (!body.pattern)
                    return okJson({ error: 'A valid field and pattern are required' }, 400);
                cond.$regex = body.pattern;
                if (body.options)
                    cond.$options = body.options;
            }
            const { results } = await this.query(def, Object.keys(cond).length ? { [field]: cond } : {});
            return okJson({ results, count: results.length });
        }
        if (sub === '/count' && m === 'GET')
            return okJson({ database: def.database, rack: def.rack, count: await this.count(def, {}) });
        if (sub === '/aggregate' && m === 'POST') {
            if (!Array.isArray(body?.pipeline))
                return okJson({ error: 'Body must be { "pipeline": [ …stages ] }' }, 400);
            const started = Date.now();
            const results = await this.pipeline(def, body.pipeline);
            const capped = results.length > config_1.config.maxQueryLimit;
            return okJson({ results: capped ? results.slice(0, config_1.config.maxQueryLimit) : results, count: Math.min(results.length, config_1.config.maxQueryLimit), total: results.length, truncated: capped, ms: Date.now() - started });
        }
        if (sub === '' && m === 'DELETE')
            return this.dropRack(def);
        if (sub === '/clear' && m === 'DELETE')
            return this.broadcast(def, 'DELETE', base + '/clear');
        // Schema, columns and indexes: the same on every shard.
        if (m === 'GET')
            return this.shard(exports.LOCAL).request('GET', request.url);
        return this.broadcast(def, m, request.url.split('?')[0], body);
    }
    /** SQL data source support. */
    info() {
        this.refresh();
        return {
            shards: this.listShards(),
            racks: Array.from(this.racks.values()).map((r) => ({
                database: r.database, rack: r.rack, key: r.key, type: r.type, state: r.state, shards: r.shards,
                buckets: Object.fromEntries(r.shards.map((n, i) => [n, r.buckets.filter((x) => x === i).length])),
            })),
            stats: this.stats,
        };
    }
}
exports.ShardRouter = ShardRouter;
/** Parses the GET …/documents query string (same rules as the unsharded route). */
function parseListQuery(queryParams) {
    let query = {};
    let populate = false, skip = 0;
    let limit;
    let sortField;
    let sortOrder = 'asc';
    for (const [key, value] of Object.entries(queryParams ?? {})) {
        if (typeof value !== 'string')
            continue;
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
                return { query, skip, populate, error: '_q must be valid JSON' };
            }
            continue;
        }
        if (!isNaN(Number(value)) && value !== '')
            query[key] = Number(value);
        else if (value === 'true' || value === 'false')
            query[key] = value === 'true';
        else
            query[key] = value;
    }
    return { query, skip, limit, populate, sort: sortField ? { field: sortField, order: sortOrder } : undefined };
}
//# sourceMappingURL=router.js.map