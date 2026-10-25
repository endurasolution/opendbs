'use strict';

/**
 * OpenDBS client for Node.js (18+). Zero dependencies.
 *
 *   const { OpenDBS } = require('opendbs-client');
 *   const client = new OpenDBS({ url: 'http://localhost:4402', apiKey: process.env.OPENDBS_KEY });
 *   const users = client.database('shop').rack('users');
 *   const id = await users.insert({ name: 'Asha', age: 31 });
 *   const { results } = await users.find({ age: { $gte: 18 } }, { limit: 20, sort: { field: 'age', order: 'desc' } });
 *
 * Connections are kept alive and reused (Node's built-in fetch pools them).
 */

class OpenDBSError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'OpenDBSError';
        this.status = status;
        this.body = body;
    }
}

const crypto = require('crypto');

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Connection errors where the request certainly never reached a server (safe to retry, even writes). */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

class OpenDBS {
    /**
     * @param {object} opts
     * @param {string|string[]} opts.url     e.g. http://localhost:4402 — or several cluster members
     *                                       (array or comma-separated): the client fails over between them
     * @param {string} [opts.apiKey]         API key (X-Api-Key) — preferred for apps
     * @param {string} [opts.username]       or a user login…
     * @param {string} [opts.password]
     * @param {string} [opts.totp]           …with a 2FA code if the account uses 2FA
     * @param {number} [opts.timeoutMs=30000]
     * @param {number} [opts.failoverMs=20000]  how long to keep trying other members (covers an election)
     */
    constructor(opts = {}) {
        const list = Array.isArray(opts.url) ? opts.url : String(opts.url || opts.urls || '').split(',');
        this.urls = list.map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
        if (this.urls.length === 0) throw new Error('OpenDBS: url is required');
        this.current = 0;
        this.failoverMs = opts.failoverMs ?? 20_000;
        this.apiKey = opts.apiKey || null;
        this.username = opts.username || null;
        this.password = opts.password || null;
        this.totp = opts.totp || null;
        this.timeoutMs = opts.timeoutMs || 30_000;
        this.token = null;
        if (!this.apiKey && !(this.username && this.password)) throw new Error('OpenDBS: give apiKey, or username and password');
    }

    async login() {
        let data = await this._raw('POST', '/api/auth/login', { username: this.username, password: this.password }, false);
        if (data.twoFactorRequired) {
            if (!this.totp) throw new OpenDBSError('This account uses two-factor authentication: pass totp', 401, data);
            data = await this._raw('POST', '/api/auth/login/2fa', { challenge: data.challenge, code: String(this.totp) }, false);
        }
        this.token = data.token;
        return data.user;
    }

    /** The member requests currently go to. */
    get url() { return this.urls[this.current]; }

    async _raw(method, path, body, auth = true) {
        const headers = { Accept: 'application/json' };
        if (auth) {
            if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
            else if (this.token) headers.Authorization = `Bearer ${this.token}`;
        }
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const read = method === 'GET' || method === 'HEAD';
        // Writes carry an idempotency key: a retry after a lost connection is answered with the
        // first attempt's result instead of being applied twice (server ≥ 0.5).
        const keyed = !read && !path.startsWith('/api/auth/');
        if (keyed) headers['Idempotency-Key'] = crypto.randomUUID();
        const deadline = Date.now() + this.failoverMs;
        let lastErr;
        for (let attempt = 1; ; attempt++) {
            let res;
            try {
                res = await fetch(this.url + path, {
                    method,
                    headers,
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (e) {
                // Another member can take the request if this one is down. Un-keyed writes only when surely not sent.
                if (!read && !keyed && !NOT_SENT.has(e?.cause?.code)) throw e;
                lastErr = e;
            }
            if (res) {
                const text = await res.text();
                let data = null;
                try { data = text ? JSON.parse(text) : null; } catch { data = text; }
                if (res.ok) return data;
                const msg = (data && (data.message && data.error === 'Forbidden' ? data.message : data.error || data.message)) || `HTTP ${res.status}`;
                const err = new OpenDBSError(msg, res.status, data);
                // 503 = no primary right now (election) / member unavailable: nothing was written, try again.
                if (res.status !== 503 || data?.savedOnPrimary) throw err;
                lastErr = err;
            }
            this.current = (this.current + 1) % this.urls.length;
            if (Date.now() >= deadline) throw lastErr;
            if (attempt % this.urls.length === 0) await sleep(400);
        }
    }

    /** Authenticated request; logs in (again) automatically when using username/password. */
    async request(method, path, body) {
        if (!this.apiKey && !this.token) await this.login();
        try {
            return await this._raw(method, path, body);
        } catch (e) {
            if (e.status === 401 && !this.apiKey) {
                await this.login();
                return this._raw(method, path, body);
            }
            throw e;
        }
    }

    version() { return this.request('GET', '/api/version'); }
    me() { return this.request('GET', '/api/auth/me'); }
    async listDatabases() { return (await this.request('GET', '/api/databases')).databases; }
    createDatabase(name) { return this.request('POST', '/api/databases', { name }); }
    dropDatabase(name) { return this.request('DELETE', `/api/databases/${enc(name)}`); }
    database(name) { return new Database(this, name); }

    /**
     * Atomic multi-rack transaction. Either pass operations, or a function
     * that records them on a builder. Values returned by tx.insert() are
     * references ("$N.id") that resolve to the new id inside the transaction:
     *
     *   await client.transaction((tx) => {
     *     const order = tx.insert('shop', 'orders', { total: 40 });
     *     tx.insert('shop', 'order_items', { order_id: order, sku: 'A1' });
     *     tx.patch('shop', 'stock', '7', { qty: 3 });
     *   });
     */
    async transaction(opsOrFn) {
        let ops = opsOrFn;
        if (typeof opsOrFn === 'function') {
            ops = [];
            const ref = () => `$${ops.length - 1}.id`;
            const tx = {
                insert: (database, rack, data) => { ops.push({ op: 'insert', database, rack, data }); return ref(); },
                update: (database, rack, id, data) => { ops.push({ op: 'update', database, rack, id, data }); return ref(); },
                patch: (database, rack, id, data) => { ops.push({ op: 'patch', database, rack, id, data }); return ref(); },
                delete: (database, rack, id) => { ops.push({ op: 'delete', database, rack, id }); return ref(); },
            };
            await opsOrFn(tx);
        }
        return this.request('POST', '/api/transactions', { operations: ops });
    }
}

class Database {
    constructor(client, name) { this.client = client; this.name = name; }
    _p(rest = '') { return `/api/databases/${enc(this.name)}${rest}`; }

    async listRacks() { return (await this.client.request('GET', this._p('/racks'))).racks; }
    /** NoSQL rack (free-form JSON documents). */
    createRack(name) { return this.client.request('POST', this._p('/racks'), { name, type: 'nosql' }); }
    /** SQL rack (table): schema = { column: { type, required?, unique?, defaultValue? } }. */
    createTable(name, schema) { return this.client.request('POST', this._p('/racks'), { name, type: 'sql', schema }); }
    dropRack(name) { return this.client.request('DELETE', this._p(`/racks/${enc(name)}`)); }
    rack(name) { return new Rack(this, name); }
    table(name) { return new Rack(this, name); }

    /**
     * Run SQL (one or more statements; BEGIN … COMMIT supported). `params` fill ? / $1 placeholders
     * (never parsed as SQL — use them for any user input). Returns the last statement's rows/result plus all results.
     */
    sql(query, params) { return this.client.request('POST', `/api/sql/${enc(this.name)}/execute`, params ? { query, params } : { query }); }
    stats() { return this.client.request('GET', this._p('/stats')); }
}

class Rack {
    constructor(db, name) { this.db = db; this.client = db.client; this.name = name; }
    _p(rest = '') { return `/api/databases/${enc(this.db.name)}/racks/${enc(this.name)}${rest}`; }

    async insert(doc) { return (await this.client.request('POST', this._p('/documents'), doc)).id; }
    /** All-or-nothing bulk insert. */
    async insertMany(docs) { return (await this.client.request('POST', this._p('/documents'), docs)).ids; }
    /**
     * @param {object} [query]   MongoDB-style: { age: { $gte: 18 }, $or: [...] }
     * @param {object} [options] { skip, limit, sort: { field, order: 'asc'|'desc' }, populate }
     * @returns {Promise<{results: object[], total: number, count: number}>}
     */
    find(query = {}, options = {}) { return this.client.request('POST', this._p('/search'), { query, ...options }); }
    async findOne(query = {}) { return (await this.find(query, { limit: 1 })).results[0] ?? null; }
    async count(query = {}) { return (await this.find(query, { limit: 1 })).total; }
    async get(id) {
        try { return await this.client.request('GET', this._p(`/documents/${enc(id)}`)); } catch (e) { if (e.status === 404) return null; throw e; }
    }
    /** Replace a document. */
    update(id, doc) { return this.client.request('PUT', this._p(`/documents/${enc(id)}`), doc); }
    /** Merge fields into a document. */
    patch(id, fields) { return this.client.request('PATCH', this._p(`/documents/${enc(id)}`), fields); }
    delete(id) { return this.client.request('DELETE', this._p(`/documents/${enc(id)}`)); }
    clear() { return this.client.request('DELETE', this._p('/clear')); }
    /** Aggregation pipeline: [{ $match }, { $group }, { $lookup }, { $sort }, …] */
    async aggregate(pipeline) { return (await this.client.request('POST', this._p('/aggregate'), { pipeline })).results; }
    /** Index one field, or several (compound): createIndex(['city', 'age'], { unique: true }). */
    createIndex(fields, { unique = false } = {}) {
        return this.client.request('POST', this._p('/indexes'), Array.isArray(fields) ? { fields, unique } : { field: fields, unique });
    }
    dropIndex(name) { return this.client.request('DELETE', this._p(`/indexes/${enc(Array.isArray(name) ? name.join('+') : name)}`)); }
    async indexes() { return (await this.client.request('GET', this._p('/indexes'))).details; }
    fuzzySearch(field, query, threshold = 0.6) { return this.client.request('POST', this._p('/search/fuzzy'), { field, query, threshold }); }
    vectorSearch(field, vector, k = 10) { return this.client.request('POST', this._p('/search/vector'), { field, vector, k }); }
}

module.exports = { OpenDBS, OpenDBSError, Database, Rack };
module.exports.default = OpenDBS;
