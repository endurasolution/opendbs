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
exports.SQLBridgeService = void 0;
exports.requiredSQLPermission = requiredSQLPermission;
exports.engineDataSource = engineDataSource;
const mysql = __importStar(require("mysql2/promise"));
const crypto = __importStar(require("crypto"));
const config_1 = require("../config");
const parser_1 = require("../sql/parser");
const executor_1 = require("../sql/executor");
const directApi = (e) => ({
    query: (db, r, q, o) => e.query(db, r, q, o),
    get: (db, r, id) => e.getDocument(db, r, id),
    insert: (db, r, d) => e.insert(db, r, d),
    update: (db, r, id, d) => e.update(db, r, id, d),
    patch: (db, r, id, d) => e.patch(db, r, id, d),
    delete: (db, r, id) => e.delete(db, r, id),
});
const txApi = (tx) => ({
    query: (db, r, q, o) => tx.query(db, r, q, o),
    get: (db, r, id) => tx.get(db, r, id),
    insert: (db, r, d) => tx.insert(db, r, d),
    update: (db, r, id, d) => tx.update(db, r, id, d),
    patch: (db, r, id, d) => tx.patch(db, r, id, d),
    delete: (db, r, id) => tx.delete(db, r, id),
});
/**
 * Sharded tables go through the router. Inside BEGIN … COMMIT they can be
 * read (not transactionally) but not written: a transaction is local to
 * one server.
 */
const shardedApi = (base, router, inTransaction) => {
    if (!router)
        return base;
    const sharded = (db, r) => {
        const def = router.rackDef(db, r);
        if (def && inTransaction)
            throw new Error(`Table '${r}' is sharded; BEGIN … COMMIT can only change unsharded tables`);
        return def;
    };
    return {
        query: (db, r, q, o) => {
            const def = router.rackDef(db, r);
            return def ? router.query(def, q, o ?? {}) : base.query(db, r, q, o);
        },
        get: (db, r, id) => { const def = router.rackDef(db, r); return def ? router.sqlGet(def, id) : base.get(db, r, id); },
        insert: (db, r, d) => { const def = sharded(db, r); return def ? router.sqlInsert(def, d) : base.insert(db, r, d); },
        update: (db, r, id, d) => { const def = sharded(db, r); return def ? router.sqlWrite(def, 'PUT', id, d) : base.update(db, r, id, d); },
        patch: (db, r, id, d) => { const def = sharded(db, r); return def ? router.sqlWrite(def, 'PATCH', id, d) : base.patch(db, r, id, d); },
        delete: (db, r, id) => { const def = sharded(db, r); return def ? router.sqlWrite(def, 'DELETE', id) : base.delete(db, r, id); },
        insertMany: (db, r, docs) => { const def = sharded(db, r); return def ? router.insert(def, docs) : null; },
    };
};
/** Highest permission needed by any statement in `query` (throws on syntax errors). */
function requiredSQLPermission(query) {
    const rank = { read: 0, write: 1, delete: 2 };
    let needed = 'read';
    for (const s of (0, parser_1.parseSQL)(query)) {
        const p = (0, parser_1.permissionFor)(s);
        if (rank[p] > rank[needed])
            needed = p;
    }
    return needed;
}
/**
 * Engine-backed data source for the SQL executor (reads go through `api`, so
 * transactions see their own writes). Outside transactions, large full scans
 * and GROUP BYs run on the parallel query workers.
 */
function engineDataSource(engine, db, api, parallel = false, router = null) {
    const fixIds = (docs) => {
        // In SQL, ids are integers (so they sort and compare as numbers).
        for (const d of docs)
            if (typeof d.id === 'string' && /^(0|[1-9]\d{0,14})$/.test(d.id))
                d.id = Number(d.id);
        return docs;
    };
    return {
        // GROUP BY in the storage layer: on every shard (sharded tables) or on the query workers.
        ...(parallel || router ? {
            aggregate: async (table, q, groups, aggs, where) => {
                const def = router?.rackDef(db, table);
                if (def)
                    return router.aggregate(def, q, groups, aggs, where);
                return parallel ? engine.aggregateParallel(db, table, q, groups, aggs, where) : null;
            },
        } : {}),
        async describe(table) {
            let info;
            try {
                info = engine.getRackSchema(db, table);
            }
            catch {
                return null;
            }
            if (info.schema) {
                const types = {};
                const required = new Set();
                for (const [c, def] of Object.entries(info.schema)) {
                    types[c] = def.type;
                    if (def.required)
                        required.add(c);
                }
                return { name: table, type: info.type, columns: ['id', ...Object.keys(info.schema)], known: info.type === 'sql', types, required };
            }
            // NoSQL: learn column names from a sample.
            const cols = new Set(['id']);
            for (const r of (await api.query(db, table, {}, { limit: 500 })).results)
                for (const k of Object.keys(r))
                    if (k !== '_metadata')
                        cols.add(k);
            return { name: table, type: info.type, columns: Array.from(cols), known: false, types: {}, required: new Set() };
        },
        async scan(table, q, options = {}) {
            const opts = options.countOnly ? { limit: 1 } : { sort: options.sort, skip: options.skip, limit: options.limit };
            const def = router?.rackDef(db, table);
            const r = def ? await router.query(def, q, opts)
                : parallel ? await engine.queryAsync(db, table, q, opts) : await api.query(db, table, q, opts);
            return { docs: options.countOnly ? [] : fixIds(r.results), total: r.total };
        },
    };
}
const isConflict = (e) => /Transaction conflict/.test(String(e?.message));
class SQLBridgeService {
    engine;
    pool;
    sqlCredentials;
    router = null;
    constructor(engine, mysqlConfig) {
        this.engine = engine;
        this.sqlCredentials = new Map();
        // Initialize MySQL connection pool if config provided
        if (mysqlConfig) {
            this.pool = mysql.createPool({
                host: mysqlConfig.host,
                port: mysqlConfig.port,
                user: mysqlConfig.user,
                password: mysqlConfig.password,
                database: mysqlConfig.database || 'opendbs',
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
            });
        }
    }
    // Generate SQL credentials for a user
    generateSQLCredentials(userId, username) {
        const sqlUsername = `opendbs_${username}`;
        const sqlPassword = this.generateSecurePassword();
        const credentials = {
            userId,
            username: sqlUsername,
            password: sqlPassword,
            host: 'localhost',
            port: 3306,
            createdAt: new Date(),
        };
        this.sqlCredentials.set(userId, credentials);
        return credentials;
    }
    getSQLCredentials(userId) {
        return this.sqlCredentials.get(userId);
    }
    /** Backwards-compatible: runs every statement and returns the last statement's result. */
    async executeSQL(query, database, params = []) {
        const results = await this.executeScript(query, database, params);
        return results[results.length - 1].result;
    }
    /**
     * Runs `;`-separated statements in order; stops at the first error.
     * `params` fill ? / $1 placeholders (values are never parsed as SQL).
     *
     * Transactions: BEGIN … COMMIT makes every statement in between
     * all-or-nothing (ROLLBACK or any error discards them). Outside an
     * explicit transaction each INSERT/UPDATE/DELETE is still atomic on its
     * own — a multi-row UPDATE never stops halfway.
     */
    async executeScript(query, database, params = []) {
        if (!database)
            throw new Error('database is required');
        if (!Array.isArray(params))
            throw new Error('params must be an array');
        const statements = (0, parser_1.parseSQL)(query);
        const out = [];
        let tx = null;
        for (const [i, s] of statements.entries()) {
            const started = Date.now();
            try {
                if (s.type === 'begin') {
                    if (tx)
                        throw new Error('A transaction is already open');
                    tx = this.engine.beginTransaction();
                    out.push({ statement: 'begin', result: { message: 'Transaction started' }, rowCount: 0, ms: 0 });
                    continue;
                }
                if (s.type === 'commit' || s.type === 'rollback') {
                    if (!tx)
                        throw new Error(`${s.type.toUpperCase()} without BEGIN`);
                    let msg;
                    if (s.type === 'commit') {
                        const r = tx.commit();
                        msg = `Committed ${r.changes} change(s)`;
                    }
                    else {
                        tx.rollback();
                        msg = 'Rolled back';
                    }
                    tx = null;
                    out.push({ statement: s.type, result: { message: msg }, rowCount: 0, ms: Date.now() - started });
                    continue;
                }
                const dml = s.type === 'insert' || s.type === 'update' || s.type === 'delete';
                if (tx && !dml && !['select', 'explain', 'show_tables', 'show_indexes', 'describe'].includes(s.type)) {
                    throw new Error(`${s.type.toUpperCase()} is not allowed inside a transaction`);
                }
                if (tx) {
                    out.push({ ...(await this.execute(s, database, shardedApi(txApi(tx), this.router, true), params)), ms: Date.now() - started });
                }
                else if (dml && this.router?.isSharded(database, s.table)) {
                    // A sharded target: each row is written on its own shard (no cross-shard transaction).
                    out.push({ ...(await this.execute(s, database, shardedApi(directApi(this.engine), this.router, false), params)), ms: Date.now() - started });
                }
                else if (dml) {
                    // Implicit single-statement transaction (retried if a concurrent write conflicts).
                    for (let attempt = 0;; attempt++) {
                        const auto = this.engine.beginTransaction();
                        try {
                            const r = await this.execute(s, database, shardedApi(txApi(auto), this.router, false), params);
                            auto.commit();
                            out.push({ ...r, ms: Date.now() - started });
                            break;
                        }
                        catch (e) {
                            auto.rollback();
                            if (isConflict(e) && attempt < 4)
                                continue;
                            throw e;
                        }
                    }
                }
                else {
                    // Read-only statements outside a transaction may use the parallel workers.
                    out.push({ ...(await this.execute(s, database, shardedApi(directApi(this.engine), this.router, false), params, true)), ms: Date.now() - started });
                }
            }
            catch (e) {
                if (tx)
                    tx.rollback();
                const prefix = statements.length > 1 ? `Statement ${i + 1} (${s.type.toUpperCase()}): ` : '';
                throw new Error(`${prefix}${e.message}${tx ? ' — transaction rolled back' : ''}`);
            }
        }
        if (tx) {
            tx.rollback();
            throw new Error('Transaction was not committed (missing COMMIT) — all its changes were rolled back');
        }
        return out;
    }
    requireTable(database, table) {
        if (this.engine.getRackCount(database, table) < 0)
            throw new Error(`Table '${table}' doesn't exist in '${database}'`);
    }
    ctx(db, api, params, parallel = false) {
        return { ds: engineDataSource(this.engine, db, api, parallel, this.router), db, params, maxRows: config_1.config.maxQueryLimit };
    }
    /** Sharding: lets SQL read and write sharded tables (set once at startup). */
    setShardRouter(router) {
        this.router = router;
    }
    sharded(db, table) {
        return this.router?.rackDef(db, table) ?? null;
    }
    static toObjects(rel) {
        const ids = new Set(rel.idColumns ?? []);
        return rel.rows.map((r) => {
            const o = {};
            rel.columns.forEach((c, i) => {
                const v = r[i] === undefined ? null : r[i];
                // Document ids are numbers inside SQL but strings everywhere else in OpenDBS.
                o[c] = ids.has(i) && typeof v === 'number' ? String(v) : v;
            });
            return o;
        });
    }
    async execute(s, db, api, params, parallel = false) {
        const ctx = this.ctx(db, api, params, parallel);
        switch (s.type) {
            case 'select': {
                const rel = await (0, executor_1.executeQuery)(s.q, ctx);
                const cap = config_1.config.maxQueryLimit;
                const truncated = rel.rows.length > cap;
                const rows = SQLBridgeService.toObjects(truncated ? { ...rel, rows: rel.rows.slice(0, cap) } : rel);
                return { statement: 'select', result: rows, rowCount: rows.length, total: rel.total ?? rel.rows.length, columns: rel.columns, truncated };
            }
            case 'explain': {
                const prepared = await (0, executor_1.prepareQuery)(s.q, ctx);
                const rows = prepared.plan.explain().map((st, i) => ({ step: i + 1, operation: st.step, detail: st.detail ?? '', ...(st.filter !== undefined ? { filter: st.filter === null ? null : JSON.stringify(st.filter) } : {}), ...(st.exact !== undefined ? { exact: st.exact } : {}), ...(st.sort ? { sort: `${st.sort.field} ${st.sort.order}` } : {}), ...(st.limit !== undefined ? { limit: st.limit } : {}) }));
                const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
                return { statement: 'explain', result: rows, rowCount: rows.length, columns };
            }
            case 'insert': return this.insert(s, db, api, ctx);
            case 'update': {
                this.requireTable(db, s.table);
                const info = (await ctx.ds.describe(s.table));
                const items = [
                    { e: { k: 'fn', name: '__ROW__', args: [{ k: 'ref', parts: [s.alias] }] }, alias: '__row', text: '__row' },
                    ...s.set.map(([c, e], i) => ({ e, alias: `__set${i}`, text: c })),
                ];
                const rel = await (0, executor_1.executeQuery)((0, executor_1.selectFrom)(s.table, s.alias, items, s.where), ctx);
                let affected = 0;
                const changedIds = [];
                for (const row of rel.rows) {
                    const doc = row[0];
                    const id = String(doc.id);
                    const raw = {};
                    s.set.forEach(([c], i) => {
                        if (c === 'id')
                            throw new Error('The id column cannot be updated');
                        raw[c] = row[i + 1];
                    });
                    const changes = this.coerceRow(info, raw);
                    try {
                        const unset = Object.keys(changes).filter((k) => changes[k] === null || changes[k] === undefined);
                        if (unset.length === 0) {
                            await api.patch(db, s.table, id, changes);
                        }
                        else {
                            const current = await api.get(db, s.table, id);
                            if (!current)
                                continue;
                            delete current._metadata;
                            delete current.id;
                            const next = { ...current, ...changes };
                            for (const k of unset)
                                delete next[k];
                            await api.update(db, s.table, id, next);
                        }
                        affected++;
                        changedIds.push(id);
                    }
                    catch (e) {
                        throw new Error(`${e.message} (row ${id}; no rows were changed)`);
                    }
                }
                if (s.returning)
                    return this.returning(s.returning, s.table, s.alias, (await Promise.all(changedIds.map((id) => api.get(db, s.table, id)))).filter(Boolean), info, ctx, 'update');
                return { statement: 'update', result: { affectedRows: affected, matchedRows: rel.rows.length }, rowCount: affected };
            }
            case 'delete': {
                this.requireTable(db, s.table);
                const info = (await ctx.ds.describe(s.table));
                const items = [{ e: { k: 'fn', name: '__ROW__', args: [{ k: 'ref', parts: [s.alias] }] }, alias: '__row', text: '__row' }];
                const rel = await (0, executor_1.executeQuery)((0, executor_1.selectFrom)(s.table, s.alias, items, s.where), ctx);
                const deleted = [];
                for (const [doc] of rel.rows)
                    if (await api.delete(db, s.table, String(doc.id)))
                        deleted.push(doc);
                if (s.returning)
                    return this.returning(s.returning, s.table, s.alias, deleted, info, ctx, 'delete');
                return { statement: 'delete', result: { affectedRows: deleted.length }, rowCount: deleted.length };
            }
            case 'truncate': {
                this.requireTable(db, s.table);
                const shardedDef = this.sharded(db, s.table);
                if (shardedDef) {
                    const n = await this.router.count(shardedDef, {});
                    await this.router.ddl(shardedDef, 'DELETE', '/clear');
                    return { statement: 'truncate', result: { message: `Table '${s.table}' emptied on every shard`, affectedRows: n }, rowCount: n };
                }
                const n = this.engine.getRackCount(db, s.table);
                this.engine.clearRack(db, s.table);
                return { statement: 'truncate', result: { message: `Table '${s.table}' emptied`, affectedRows: n }, rowCount: n };
            }
            case 'create': {
                if (s.asQuery)
                    return this.createAs(s.table, s.ifNotExists, s.asQuery, db, ctx);
                if (Object.keys(s.columns).length === 0)
                    throw new Error('CREATE TABLE needs at least one column besides id');
                const created = this.engine.createRack(db, s.table, 'sql', s.columns);
                if (!created && !s.ifNotExists)
                    throw new Error(`Table '${s.table}' already exists`);
                return { statement: 'create', result: { message: created ? 'Table created' : 'Table already exists', affectedRows: created ? 1 : 0 }, rowCount: created ? 1 : 0 };
            }
            case 'drop': {
                const shardedDef = this.sharded(db, s.table);
                if (shardedDef) {
                    await this.router.dropRack(shardedDef);
                    return { statement: 'drop', result: { message: 'Table dropped on every shard', affectedRows: 1 }, rowCount: 1 };
                }
                const deleted = this.engine.deleteRack(db, s.table);
                if (!deleted && !s.ifExists)
                    throw new Error(`Table '${s.table}' doesn't exist`);
                return { statement: 'drop', result: { message: deleted ? 'Table dropped' : 'Table did not exist', affectedRows: deleted ? 1 : 0 }, rowCount: deleted ? 1 : 0 };
            }
            case 'create_index': {
                this.requireTable(db, s.table);
                const name = s.fields.join('+');
                const existed = this.engine.getIndexes(db, s.table).includes(name);
                if (existed && !s.ifNotExists && this.engine.getIndexDetails(db, s.table).some((i) => i.field === name && (i.type === 'unique') === s.unique)) {
                    throw new Error(`Index '${name}' already exists on '${s.table}'`);
                }
                const shardedDef = this.sharded(db, s.table);
                if (shardedDef)
                    await this.router.ddl(shardedDef, 'POST', '/indexes', { fields: s.fields, unique: s.unique });
                else
                    this.engine.createIndex(db, s.table, s.fields.length === 1 ? s.fields[0] : s.fields, { unique: s.unique });
                return { statement: 'create_index', result: { message: `Index '${name}' ${existed ? 'updated' : 'created'}`, index: name, affectedRows: 0 }, rowCount: 0 };
            }
            case 'drop_index': {
                this.requireTable(db, s.table);
                const shardedDef = this.sharded(db, s.table);
                const dropped = shardedDef
                    ? this.engine.getIndexes(db, s.table).includes(s.name) && Boolean(await this.router.ddl(shardedDef, 'DELETE', `/indexes/${encodeURIComponent(s.name)}`))
                    : this.engine.deleteIndex(db, s.table, s.name);
                if (!dropped && !s.ifExists) {
                    throw new Error(`No index '${s.name}' on '${s.table}' (index names are the indexed column(s): ${this.engine.getIndexes(db, s.table).join(', ') || 'none'})`);
                }
                return { statement: 'drop_index', result: { message: dropped ? `Index '${s.name}' dropped` : 'Index did not exist', affectedRows: 0 }, rowCount: 0 };
            }
            case 'alter': {
                this.requireTable(db, s.table);
                const a = s.action;
                const shardedDef = this.sharded(db, s.table);
                if (shardedDef) {
                    // The same change on every shard (through each shard's REST API).
                    const col = (n) => `/columns/${encodeURIComponent(n)}`;
                    const ddl = (method, sub, body) => this.router.ddl(shardedDef, method, sub, body);
                    switch (a.kind) {
                        case 'add':
                            await ddl('POST', '/columns', { name: a.name, ...a.def });
                            break;
                        case 'drop':
                            await ddl('DELETE', col(a.name));
                            break;
                        case 'modify':
                            await ddl('PATCH', col(a.name), { type: a.def.type, required: Boolean(a.def.required), unique: Boolean(a.def.unique), defaultValue: a.def.defaultValue ?? null });
                            break;
                        case 'rename':
                            await ddl('PATCH', col(a.from), { name: a.to });
                            break;
                        case 'add_index':
                            await ddl('POST', '/indexes', { fields: a.fields, unique: a.unique });
                            break;
                        case 'drop_index':
                            await ddl('DELETE', `/indexes/${encodeURIComponent(a.name)}`);
                            break;
                    }
                    return { statement: 'alter', result: { message: `Table '${s.table}' altered on every shard`, affectedRows: 0 }, rowCount: 0 };
                }
                switch (a.kind) {
                    case 'add':
                        this.engine.addColumn(db, s.table, a.name, a.def);
                        break;
                    case 'drop':
                        if (!this.engine.dropColumn(db, s.table, a.name))
                            throw new Error(`Column '${a.name}' doesn't exist`);
                        break;
                    case 'modify':
                        // MODIFY restates the full definition, so absent constraints are cleared.
                        this.engine.alterColumn(db, s.table, a.name, {
                            type: a.def.type, required: Boolean(a.def.required), unique: Boolean(a.def.unique),
                            defaultValue: a.def.defaultValue ?? null,
                        });
                        break;
                    case 'rename':
                        this.engine.alterColumn(db, s.table, a.from, { name: a.to });
                        break;
                    case 'add_index':
                        this.engine.createIndex(db, s.table, a.fields.length === 1 ? a.fields[0] : a.fields, { unique: a.unique });
                        break;
                    case 'drop_index':
                        if (!this.engine.deleteIndex(db, s.table, a.name))
                            throw new Error(`No index '${a.name}' on '${s.table}'`);
                        break;
                }
                return { statement: 'alter', result: { message: `Table '${s.table}' altered`, affectedRows: 0 }, rowCount: 0 };
            }
            case 'show_tables': {
                const rows = this.engine.getDatabaseRacks(db).map((r) => ({
                    table: r.name, type: r.type, rows: r.count, columns: r.schema ? Object.keys(r.schema).length : null,
                }));
                return { statement: 'show_tables', result: rows, rowCount: rows.length, columns: ['table', 'type', 'rows', 'columns'] };
            }
            case 'show_indexes': {
                this.requireTable(db, s.table);
                const rows = this.engine.getIndexDetails(db, s.table).map((i) => ({
                    index: i.field, type: i.type, columns: (i.fields ?? [i.field]).join(', '), entries: i.entries ?? i.distinctKeys ?? null,
                }));
                return { statement: 'show_indexes', result: rows, rowCount: rows.length, columns: ['index', 'type', 'columns', 'entries'] };
            }
            case 'describe': {
                const { type, schema } = this.engine.getRackSchema(db, s.table);
                const rows = [{ column: 'id', type: 'auto', required: true, unique: true, default: null }];
                for (const [name, def] of Object.entries(schema ?? {})) {
                    rows.push({ column: name, type: def.type, required: Boolean(def.required), unique: Boolean(def.unique), default: def.defaultValue ?? null });
                }
                if (type === 'nosql' && !schema)
                    rows.push({ column: '(schemaless JSON)', type: 'nosql', required: false, unique: false, default: null });
                return { statement: 'describe', result: rows, rowCount: rows.length, columns: ['column', 'type', 'required', 'unique', 'default'] };
            }
            default:
                // BEGIN / COMMIT / ROLLBACK are handled by executeScript.
                throw new Error(`Unexpected ${s.type.toUpperCase()}`);
        }
    }
    async insert(s, db, api, ctx) {
        this.requireTable(db, s.table);
        const info = (await ctx.ds.describe(s.table));
        const schemaCols = info.known ? info.columns.filter((c) => c !== 'id') : null;
        // Source rows as value arrays + their column names.
        let valueRows;
        let cols = s.columns;
        if (s.rows) {
            valueRows = [];
            for (const exprs of s.rows) {
                valueRows.push((0, executor_1.constantRow)(exprs, ctx.params) ?? (await (0, executor_1.evaluateOnRows)(exprs, [], [{}], ctx))[0]);
            }
        }
        else {
            const rel = await (0, executor_1.executeQuery)(s.query, ctx);
            valueRows = rel.rows;
            if (!cols && !schemaCols)
                cols = rel.columns;
        }
        const docs = valueRows.map((vals) => {
            const row = {};
            if (cols) {
                if (vals.length !== cols.length)
                    throw new Error(`Expected ${cols.length} values per row, got ${vals.length}`);
                cols.forEach((c, i) => { row[c] = vals[i]; });
            }
            else if (schemaCols) {
                // Positional values follow the declared column order.
                if (vals.length !== schemaCols.length)
                    throw new Error(`Table '${s.table}' has ${schemaCols.length} columns; got ${vals.length} values`);
                schemaCols.forEach((c, i) => { row[c] = vals[i]; });
            }
            else {
                vals.forEach((v, i) => { row[`field${i + 1}`] = v; });
            }
            delete row.id;
            for (const k of Object.keys(row))
                if (row[k] === null || row[k] === undefined)
                    delete row[k];
            return this.coerceRow(info, row);
        });
        // Unique keys used to detect conflicts (ON CONFLICT target, else every unique index).
        const conflict = s.conflict;
        const uniqueKeys = conflict?.target
            ? [conflict.target]
            : this.engine.getIndexDetails(db, s.table).filter((i) => i.type === 'unique').map((i) => i.fields ?? [i.field]);
        const findExisting = async (doc) => {
            for (const key of uniqueKeys) {
                if (!key.every((k) => doc[k] !== undefined && doc[k] !== null))
                    continue;
                const q = {};
                for (const k of key)
                    q[k] = doc[k];
                const hit = (await api.query(db, s.table, q, { limit: 1 })).results[0];
                if (hit)
                    return hit;
            }
            return null;
        };
        const ids = [];
        let inserted = 0, updated = 0, skipped = 0;
        const bulk = !conflict && !s.ignore && docs.length > 1 ? api.insertMany?.(db, s.table, docs) : null;
        if (bulk) {
            ids.push(...(await bulk));
            inserted = ids.length;
        }
        for (const doc of bulk ? [] : docs) {
            const existing = conflict || s.ignore ? await findExisting(doc) : null;
            if (existing) {
                if (!conflict || conflict.action === 'nothing') {
                    skipped++;
                    continue;
                }
                const id = String(existing.id);
                delete existing._metadata;
                if (conflict.set.length === 0) {
                    // REPLACE INTO: the new row replaces the old one (same id).
                    await api.update(db, s.table, id, doc);
                }
                else {
                    // Bare column names mean the existing row; the proposed row is excluded.col / VALUES(col).
                    const sources = [
                        { alias: s.table, info },
                        { alias: 'excluded', info: null, columns: Array.from(new Set([...info.columns, ...Object.keys(doc)])), qualifiedOnly: true },
                    ];
                    const exprs = conflict.set.map(([, e]) => e);
                    if (conflict.where)
                        exprs.push(conflict.where);
                    const [vals] = await (0, executor_1.evaluateOnRows)(exprs, sources, [{ [s.table]: existing, excluded: { ...doc } }], ctx, { valuesAlias: 'excluded' });
                    if (conflict.where && (0, executor_1.truth)(vals[vals.length - 1]) !== true) {
                        skipped++;
                        continue;
                    }
                    const changes = {};
                    conflict.set.forEach(([c], i) => { changes[c] = vals[i]; });
                    const coerced = this.coerceRow(info, changes);
                    const unset = Object.keys(coerced).filter((k) => coerced[k] === null || coerced[k] === undefined);
                    if (unset.length === 0)
                        await api.patch(db, s.table, id, coerced);
                    else {
                        const cur = { ...existing, ...coerced };
                        delete cur.id;
                        for (const k of unset)
                            delete cur[k];
                        await api.update(db, s.table, id, cur);
                    }
                }
                ids.push(id);
                updated++;
                continue;
            }
            try {
                ids.push(await api.insert(db, s.table, doc));
                inserted++;
            }
            catch (e) {
                if (s.ignore && /Duplicate value/.test(e.message)) {
                    skipped++;
                    continue;
                }
                throw e;
            }
        }
        if (s.returning)
            return this.returning(s.returning, s.table, s.table, (await Promise.all(ids.map((id) => api.get(db, s.table, id)))).filter(Boolean), info, ctx, 'insert');
        return {
            statement: 'insert',
            result: { insertId: ids[0] ?? null, insertIds: ids, affectedRows: inserted + updated, ...(conflict || s.ignore ? { inserted, updated, skipped } : {}) },
            rowCount: inserted + updated,
        };
    }
    async returning(items, table, alias, docs, info, ctx, kind) {
        const cols = [];
        const exprs = [];
        for (const it of items) {
            if (it.star) {
                for (const c of info.known ? info.columns : Array.from(new Set(docs.flatMap((d) => Object.keys(d).filter((k) => k !== '_metadata'))))) {
                    cols.push(c);
                    exprs.push({ k: 'ref', parts: [alias, c] });
                }
            }
            else {
                cols.push(it.alias ?? (it.e.k === 'ref' ? it.e.parts[it.e.parts.length - 1] : it.text));
                exprs.push(it.e);
            }
        }
        const clean = docs.map((d) => { const c = { ...d }; delete c._metadata; return { [alias]: c }; });
        const vals = await (0, executor_1.evaluateOnRows)(exprs, [{ alias, info }], clean, ctx);
        const rows = SQLBridgeService.toObjects({ columns: cols, rows: vals });
        return { statement: kind, result: rows, rowCount: rows.length, columns: cols };
    }
    async createAs(table, ifNotExists, q, db, ctx) {
        if (this.engine.getRackCount(db, table) >= 0) {
            if (ifNotExists)
                return { statement: 'create', result: { message: 'Table already exists', affectedRows: 0 }, rowCount: 0 };
            throw new Error(`Table '${table}' already exists`);
        }
        const rel = await (0, executor_1.executeQuery)(q, ctx);
        const cols = rel.columns.filter((c) => c !== 'id');
        if (cols.length === 0)
            throw new Error('CREATE TABLE … AS SELECT needs at least one column besides id');
        const schema = {};
        for (const c of cols) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(c))
                throw new Error(`Column name '${c}' is not valid — give it an alias (… AS name)`);
            const i = rel.columns.indexOf(c);
            const sample = rel.rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined);
            let type = 'string';
            if (sample.length && sample.every((v) => typeof v === 'number'))
                type = sample.every(Number.isInteger) ? 'integer' : 'number';
            else if (sample.length && sample.every((v) => typeof v === 'boolean'))
                type = 'boolean';
            else if (sample.length && sample.every((v) => Array.isArray(v)))
                type = 'array';
            else if (sample.length && sample.every((v) => typeof v === 'object'))
                type = 'object';
            schema[c] = { type };
        }
        this.engine.createRack(db, table, 'sql', schema);
        const docs = rel.rows.map((r) => {
            const d = {};
            cols.forEach((c) => { const v = r[rel.columns.indexOf(c)]; if (v !== null && v !== undefined)
                d[c] = v; });
            return d;
        });
        if (docs.length)
            this.engine.insertMany(db, table, docs);
        return { statement: 'create', result: { message: `Table created with ${docs.length} row(s)`, affectedRows: docs.length }, rowCount: docs.length };
    }
    /** Maps SQL values onto declared column types (1/0 → boolean, '42' → 42, JSON text → object). */
    coerceRow(info, row) {
        if (!info.known)
            return row;
        const out = { ...row };
        for (const [col, v] of Object.entries(row)) {
            const type = info.types[col];
            if (!type || v === null || v === undefined)
                continue;
            if (type === 'boolean' && (v === 0 || v === 1))
                out[col] = v === 1;
            else if ((type === 'integer' || type === 'number') && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))
                out[col] = Number(v);
            else if (type === 'string' && (typeof v === 'number' || typeof v === 'boolean'))
                out[col] = String(v);
            else if ((type === 'object' || type === 'array') && typeof v === 'string') {
                try {
                    out[col] = JSON.parse(v);
                }
                catch { /* leave as-is; validation reports it */ }
            }
        }
        return out;
    }
    generateSecurePassword(length = 24) {
        // CSPRNG (was Math.random) and URL-safe, since it's embedded in a connection string.
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let password = '';
        for (let i = 0; i < length; i++) {
            password += chars.charAt(crypto.randomInt(chars.length));
        }
        return password;
    }
    async close() {
        if (this.pool) {
            await this.pool.end();
        }
    }
}
exports.SQLBridgeService = SQLBridgeService;
//# sourceMappingURL=sql-bridge.service.js.map