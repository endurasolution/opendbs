"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const msgpackr_1 = require("msgpackr");
const native_search_service_1 = require("../services/native-search.service");
const matcher_1 = require("../query/matcher");
const disk_store_1 = require("../storage/disk-store");
const functions_1 = require("../sql/functions");
const agg_state_1 = require("../sql/agg-state");
const executor_1 = require("../sql/executor");
const SCAN_PAGE = 2000;
const packr = new msgpackr_1.Packr({ useRecords: false });
const addon = (0, native_search_service_1.nativeAddon)();
const store = addon.Store.attach(worker_threads_1.workerData.handle);
const matchers = new Map();
function matcherFor(q) {
    const k = JSON.stringify(q);
    let m = matchers.get(k);
    if (!m) {
        m = (0, matcher_1.compileQuery)(q);
        if (matchers.size > 100)
            matchers.clear();
        matchers.set(k, m);
    }
    return m;
}
function* scan(task) {
    let lo = task.lo ? Buffer.from(task.lo) : null;
    let incl = true;
    const hi = task.hi ? Buffer.from(task.hi) : null;
    for (;;) {
        const page = store.scanRange(task.table, lo, incl, hi, SCAN_PAGE);
        if (page.length === 0)
            return;
        let p = 0, n = 0;
        let last = null;
        while (p < page.length) {
            const kl = page.readUInt32LE(p);
            const key = page.subarray(p + 4, p + 4 + kl);
            p += 4 + kl;
            const vl = page.readUInt32LE(p);
            const value = page.subarray(p + 4, p + 4 + vl);
            p += 4 + vl;
            last = key;
            n++;
            yield [(0, disk_store_1.decodeId)(key), packr.unpack(value)];
        }
        if (n < SCAN_PAGE || !last)
            return;
        lo = Buffer.from(last);
        incl = false;
    }
}
/** Same ordering as the engine's sorted queries: missing values last, then by id. */
function sortValue(doc, field) {
    if (field === 'id') {
        const n = Number(doc.id);
        return Number.isFinite(n) ? n : doc.id;
    }
    const v = (0, matcher_1.getPath)(doc.data, field);
    if (v === undefined && (field === 'createdAt' || field === 'updatedAt'))
        return doc[field];
    return v;
}
function runFilter(task) {
    const match = matcherFor(task.query);
    let count = 0;
    const ids = [];
    const keep = task.keep ?? Infinity;
    const top = [];
    const dir = task.sort?.order === 'desc' ? -1 : 1;
    const cmp = (a, b) => {
        const an = a[0] === undefined || a[0] === null, bn = b[0] === undefined || b[0] === null;
        const c = an || bn ? (an && bn ? 0 : an ? 1 : -1) : dir * (0, matcher_1.compareValues)(a[0], b[0]);
        return c !== 0 ? c : Number(a[1]) - Number(b[1]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    };
    for (const [id, doc] of scan(task)) {
        if (!match(doc.data ?? {}, id))
            continue;
        count++;
        if (task.need === 'ids') {
            if (ids.length < keep)
                ids.push(id);
        }
        else if (task.need === 'top') {
            const item = [sortValue(doc, task.sort.field), id];
            if (top.length < keep) {
                top.push(item);
                if (top.length === keep)
                    top.sort(cmp);
            }
            else if (cmp(item, top[top.length - 1]) < 0) {
                // Binary insertion into the sorted top-K.
                let lo = 0, hi = top.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cmp(top[mid], item) <= 0)
                        lo = mid + 1;
                    else
                        hi = mid;
                }
                top.splice(lo, 0, item);
                top.pop();
            }
        }
    }
    if (task.need === 'top')
        top.sort(cmp);
    return { count, ids, top };
}
const predicates = new Map();
function sqlPredicate(spec) {
    const k = JSON.stringify(spec);
    let p = predicates.get(k);
    if (!p) {
        p = (0, executor_1.compileRowPredicate)(spec);
        if (predicates.size > 100)
            predicates.clear();
        predicates.set(k, p);
    }
    return p;
}
function runAgg(task) {
    const coarse = matcherFor(task.query);
    const pred = task.sqlWhere ? sqlPredicate(task.sqlWhere) : null;
    // SQL rows: the document's fields plus a numeric id.
    const match = pred
        ? (data, id) => coarse(data, id) && pred({ ...data, id: (0, functions_1.canonicalNumber)(id) ?? id })
        : coarse;
    const keyFns = task.groups.map(agg_state_1.fieldReader);
    const defs = task.aggs.map((a) => {
        const read = a.field === null ? null : (0, agg_state_1.fieldReader)(a.field);
        return { name: a.name, star: a.field === null, distinct: false, args: read ? [(doc) => read(doc)] : [] };
    });
    const groups = new Map();
    for (const [id, doc] of scan(task)) {
        if (!match(doc.data ?? {}, id))
            continue;
        const key = keyFns.map((f) => f(doc));
        const k = key.map(functions_1.valueKey).join('\u0001');
        let g = groups.get(k);
        if (!g)
            groups.set(k, (g = { key, states: defs.map(agg_state_1.newAggState) }));
        for (let i = 0; i < defs.length; i++)
            (0, agg_state_1.addAgg)(g.states[i], defs[i], doc, null);
    }
    return { groups: Array.from(groups.values()).map((g) => ({ key: g.key, states: g.states.map(agg_state_1.serializeState) })) };
}
worker_threads_1.parentPort.on('message', (task) => {
    try {
        const result = task.kind === 'agg' ? runAgg(task) : runFilter(task);
        worker_threads_1.parentPort.postMessage({ id: task.id, ok: true, result });
    }
    catch (e) {
        worker_threads_1.parentPort.postMessage({ id: task.id, ok: false, error: e?.message ?? String(e) });
    }
});
//# sourceMappingURL=query-worker.js.map