"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MERGEABLE = void 0;
exports.compareKeys = compareKeys;
exports.newAggState = newAggState;
exports.addAgg = addAgg;
exports.mergeAggState = mergeAggState;
exports.finishAgg = finishAgg;
exports.serializeState = serializeState;
exports.fieldReader = fieldReader;
exports.mergePartials = mergePartials;
exports.finishPartials = finishPartials;
const functions_1 = require("./functions");
/** Aggregates whose partial states can be combined (computed in parallel). */
exports.MERGEABLE = new Set([
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ANY_VALUE', 'STDDEV', 'STD', 'STDDEV_POP', 'STDDEV_SAMP',
    'VARIANCE', 'VAR_SAMP', 'VAR_POP', 'BOOL_AND', 'EVERY', 'BOOL_OR', 'BIT_AND', 'BIT_OR',
]);
const LIST_AGGS = new Set(['GROUP_CONCAT', 'STRING_AGG', 'ARRAY_AGG', 'JSON_AGG', 'JSON_ARRAYAGG', 'MEDIAN']);
const NUMERIC_AGGS = (name) => name === 'SUM' || name === 'AVG' || name.startsWith('STD') || name.startsWith('VAR') || name === 'MEDIAN';
/** MySQL ordering: NULL sorts first ascending, last descending (unless NULLS FIRST/LAST says otherwise). */
function compareKeys(a, b, order) {
    for (let i = 0; i < order.length; i++) {
        const x = a[i], y = b[i];
        const xn = (0, functions_1.isNull)(x), yn = (0, functions_1.isNull)(y);
        if (xn || yn) {
            if (xn && yn)
                continue;
            const nullsFirst = order[i].nulls ? order[i].nulls === 'first' : !order[i].desc;
            return xn ? (nullsFirst ? -1 : 1) : (nullsFirst ? 1 : -1);
        }
        const c = (0, functions_1.sortCompare)(x, y);
        if (c !== 0)
            return order[i].desc ? -c : c;
    }
    return 0;
}
function newAggState(def) {
    return {
        n: 0, sum: 0, sumSq: 0, nums: 0, min: undefined, max: undefined, first: undefined,
        list: LIST_AGGS.has(def.name) ? [] : null,
        keys: def.order ? [] : null,
        seen: def.distinct ? new Set() : null,
        all: true, any: false, band: null, bor: null,
    };
}
function addAgg(st, def, row, env) {
    if (def.filter && (0, functions_1.truth)(def.filter(row, env)) !== true)
        return;
    if (def.star) {
        st.n++;
        return;
    }
    const v = def.args[0](row, env);
    const keepNull = def.name === 'ARRAY_AGG' || def.name === 'JSON_AGG' || def.name === 'JSON_ARRAYAGG';
    if ((0, functions_1.isNull)(v) && !keepNull)
        return;
    if (def.name === 'COUNT' && def.args.length > 1) {
        const vals = def.args.map((a) => a(row, env));
        if (vals.some(functions_1.isNull))
            return;
        if (st.seen) {
            const k = vals.map(functions_1.valueKey).join('\u0001');
            if (st.seen.has(k))
                return;
            st.seen.add(k);
        }
        st.n++;
        return;
    }
    if (st.seen) {
        const k = (0, functions_1.valueKey)(v);
        if (st.seen.has(k))
            return;
        st.seen.add(k);
    }
    st.n++;
    if (st.first === undefined)
        st.first = v;
    const x = (0, functions_1.toNum)(v);
    if (x !== null && (typeof v !== 'string' || NUMERIC_AGGS(def.name))) {
        st.sum += x;
        st.sumSq += x * x;
        st.nums++;
    }
    if (st.min === undefined || (0, functions_1.sortCompare)(v, st.min) < 0)
        st.min = v;
    if (st.max === undefined || (0, functions_1.sortCompare)(v, st.max) > 0)
        st.max = v;
    const t = (0, functions_1.truth)(v);
    if (t === false)
        st.all = false;
    if (t === true)
        st.any = true;
    if (x !== null && Number.isInteger(x)) {
        st.band = st.band === null ? x : st.band & x;
        st.bor = st.bor === null ? x : st.bor | x;
    }
    if (st.list) {
        st.list.push(def.name === 'MEDIAN' ? x : v);
        if (st.keys)
            st.keys.push(def.order.map((o) => o.c(row, env)));
    }
}
/** Combines a partial state into another (MERGEABLE aggregates only). */
function mergeAggState(into, from) {
    into.n += from.n;
    into.sum += from.sum;
    into.sumSq += from.sumSq;
    into.nums += from.nums;
    if (from.min !== undefined && (into.min === undefined || (0, functions_1.sortCompare)(from.min, into.min) < 0))
        into.min = from.min;
    if (from.max !== undefined && (into.max === undefined || (0, functions_1.sortCompare)(from.max, into.max) > 0))
        into.max = from.max;
    if (into.first === undefined)
        into.first = from.first;
    into.all = into.all && from.all;
    into.any = into.any || from.any;
    if (from.band !== null)
        into.band = into.band === null ? from.band : into.band & from.band;
    if (from.bor !== null)
        into.bor = into.bor === null ? from.bor : into.bor | from.bor;
}
function finishAgg(st, def, env, row) {
    const variance = (sample) => {
        if (st.nums === 0 || (sample && st.nums < 2))
            return null;
        const mean = st.sum / st.nums;
        const v = (st.sumSq - st.nums * mean * mean) / (sample ? st.nums - 1 : st.nums);
        return Math.max(0, v);
    };
    const ordered = () => {
        if (!st.list)
            return [];
        if (!st.keys)
            return st.list;
        const idx = st.list.map((_v, i) => i);
        idx.sort((a, b) => compareKeys(st.keys[a], st.keys[b], def.order));
        return idx.map((i) => st.list[i]);
    };
    switch (def.name) {
        case 'COUNT': return st.n;
        case 'SUM': return st.nums ? st.sum : null;
        case 'AVG': return st.nums ? st.sum / st.nums : null;
        case 'MIN': return st.min ?? null;
        case 'MAX': return st.max ?? null;
        case 'ANY_VALUE': return st.first ?? null;
        case 'GROUP_CONCAT': {
            if (!st.list.length)
                return null;
            const sep = def.sep ? (0, functions_1.toStr)(def.sep(row, env)) ?? ',' : ',';
            return ordered().map((v) => (0, functions_1.toStr)(v)).join(sep);
        }
        case 'STRING_AGG': {
            if (!st.list.length)
                return null;
            const sep = def.args[1] ? (0, functions_1.toStr)(def.args[1](row, env)) ?? '' : ',';
            return ordered().map((v) => (0, functions_1.toStr)(v)).join(sep);
        }
        case 'ARRAY_AGG':
        case 'JSON_AGG':
        case 'JSON_ARRAYAGG': return st.list.length ? ordered() : null;
        case 'MEDIAN': {
            const xs = st.list.filter((x) => x !== null).sort((a, b) => a - b);
            if (!xs.length)
                return null;
            const m = xs.length >> 1;
            return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
        }
        case 'STDDEV':
        case 'STD':
        case 'STDDEV_POP': {
            const v = variance(false);
            return v === null ? null : Math.sqrt(v);
        }
        case 'STDDEV_SAMP': {
            const v = variance(true);
            return v === null ? null : Math.sqrt(v);
        }
        case 'VARIANCE':
        case 'VAR_SAMP': return variance(true);
        case 'VAR_POP': return variance(false);
        case 'BOOL_AND':
        case 'EVERY': return st.n ? st.all : null;
        case 'BOOL_OR': return st.n ? st.any : null;
        case 'BIT_AND': return st.band;
        case 'BIT_OR': return st.bor;
    }
    throw new Error(`Unknown aggregate ${def.name}`);
}
/** Plain-object form of a state for sending between threads (structured clone drops nothing important). */
function serializeState(st) {
    return { ...st, list: null, keys: null, seen: null };
}
/** Reads a group/aggregate field of a stored document ({ id, data }): "id" is numeric, others are data paths. */
function fieldReader(field) {
    if (field === 'id')
        return (doc) => { const n = (0, functions_1.canonicalNumber)(doc.id); return n ?? doc.id; };
    const parts = field.split('.');
    return (doc) => {
        let v = doc.data;
        for (const p of parts) {
            if (v === null || v === undefined || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, p))
                return null;
            v = v[p];
        }
        return v === undefined ? null : v;
    };
}
/** Combines partial groups (from workers or shards) by group key. */
function mergePartials(parts) {
    const merged = new Map();
    for (const g of parts) {
        const k = g.key.map(functions_1.valueKey).join('\u0001');
        const m = merged.get(k);
        if (!m) {
            merged.set(k, { key: g.key, states: g.states });
            continue;
        }
        g.states.forEach((s, i) => mergeAggState(m.states[i], s));
    }
    return Array.from(merged.values());
}
/** Final values of merged groups (one row with empty states when nothing matched and there is no GROUP BY). */
function finishPartials(groups, groupFields, aggs) {
    const defs = aggs.map((a) => ({ name: a.name, star: a.field === null, distinct: false, args: [] }));
    const list = groups.length === 0 && groupFields.length === 0 ? [{ key: [], states: defs.map(newAggState) }] : groups;
    return list.map((g) => ({ key: g.key, values: g.states.map((s, i) => finishAgg(s, defs[i], null, null)) }));
}
//# sourceMappingURL=agg-state.js.map