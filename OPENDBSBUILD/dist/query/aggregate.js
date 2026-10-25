"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evalExpr = evalExpr;
exports.makeAccumulator = makeAccumulator;
exports.runPipeline = runPipeline;
const matcher_1 = require("./matcher");
const security_middleware_1 = require("../middleware/security.middleware");
const MAX_STAGES = 50;
const MAX_DOCS = 2_000_000;
function evalExpr(expr, doc) {
    if (typeof expr === 'string') {
        if (expr.startsWith('$') && !expr.startsWith('$$'))
            return (0, matcher_1.getPath)(doc, expr.slice(1));
        return expr;
    }
    if (Array.isArray(expr))
        return expr.map((e) => evalExpr(e, doc));
    if (!(0, security_middleware_1.isPlainObject)(expr))
        return expr;
    const keys = Object.keys(expr);
    if (keys.length === 1 && keys[0].startsWith('$'))
        return evalOperator(keys[0], expr[keys[0]], doc);
    const out = {};
    for (const k of keys)
        out[k] = evalExpr(expr[k], doc);
    return out;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toDate = (v) => {
    if (v === null || v === undefined)
        return null;
    const d = new Date(typeof v === 'number' ? v : String(v));
    return isNaN(d.getTime()) ? null : d;
};
function evalOperator(op, arg, doc) {
    const args = () => (Array.isArray(arg) ? arg : [arg]).map((a) => evalExpr(a, doc));
    switch (op) {
        case '$literal': return arg;
        case '$add': {
            const v = args();
            return v.every((x) => num(x) !== null) ? v.reduce((a, b) => a + b, 0) : null;
        }
        case '$multiply': {
            const v = args();
            return v.every((x) => num(x) !== null) ? v.reduce((a, b) => a * b, 1) : null;
        }
        case '$subtract': {
            const [a, b] = args();
            return num(a) !== null && num(b) !== null ? a - b : null;
        }
        case '$divide': {
            const [a, b] = args();
            return num(a) !== null && num(b) ? a / b : null;
        }
        case '$mod': {
            const [a, b] = args();
            return num(a) !== null && num(b) ? a % b : null;
        }
        case '$abs': {
            const [a] = args();
            return num(a) !== null ? Math.abs(a) : null;
        }
        case '$floor': {
            const [a] = args();
            return num(a) !== null ? Math.floor(a) : null;
        }
        case '$ceil': {
            const [a] = args();
            return num(a) !== null ? Math.ceil(a) : null;
        }
        case '$round': {
            const [a, places = 0] = args();
            if (num(a) === null)
                return null;
            const f = 10 ** (num(places) ?? 0);
            return Math.round(a * f) / f;
        }
        case '$concat': {
            const v = args();
            return v.some((x) => x === null || x === undefined) ? null : v.map(String).join('');
        }
        case '$toUpper': {
            const [a] = args();
            return a === null || a === undefined ? '' : String(a).toUpperCase();
        }
        case '$toLower': {
            const [a] = args();
            return a === null || a === undefined ? '' : String(a).toLowerCase();
        }
        case '$trim': {
            const [a] = args();
            return typeof a === 'string' ? a.trim() : a;
        }
        case '$strLen': {
            const [a] = args();
            return typeof a === 'string' ? a.length : null;
        }
        case '$substr': {
            const [s, start, len] = args();
            return typeof s === 'string' ? s.substr(num(start) ?? 0, num(len) ?? undefined) : null;
        }
        case '$split': {
            const [s, sep] = args();
            return typeof s === 'string' && typeof sep === 'string' ? s.split(sep) : null;
        }
        case '$eq': {
            const [a, b] = args();
            return (0, matcher_1.compareValues)(a, b) === 0 && (a === null) === (b === null);
        }
        case '$ne': {
            const [a, b] = args();
            return !((0, matcher_1.compareValues)(a, b) === 0 && (a === null) === (b === null));
        }
        case '$gt': {
            const [a, b] = args();
            return a !== null && a !== undefined && (0, matcher_1.compareValues)(a, b) > 0;
        }
        case '$gte': {
            const [a, b] = args();
            return a !== null && a !== undefined && (0, matcher_1.compareValues)(a, b) >= 0;
        }
        case '$lt': {
            const [a, b] = args();
            return b !== null && b !== undefined && (0, matcher_1.compareValues)(a, b) < 0;
        }
        case '$lte': {
            const [a, b] = args();
            return (0, matcher_1.compareValues)(a, b) <= 0;
        }
        case '$in': {
            const [a, arr] = args();
            return Array.isArray(arr) && arr.some((x) => (0, matcher_1.compareValues)(x, a) === 0);
        }
        case '$and': return args().every(Boolean);
        case '$or': return args().some(Boolean);
        case '$not': {
            const [a] = args();
            return !a;
        }
        case '$cond': {
            const [c, t, e] = Array.isArray(arg) ? arg : [arg.if, arg.then, arg.else];
            return evalExpr(c, doc) ? evalExpr(t, doc) : evalExpr(e, doc);
        }
        case '$ifNull': {
            const v = args();
            return v.find((x) => x !== null && x !== undefined) ?? null;
        }
        case '$size': {
            const [a] = args();
            return Array.isArray(a) ? a.length : null;
        }
        case '$arrayElemAt': {
            const [a, i] = args();
            if (!Array.isArray(a) || num(i) === null)
                return null;
            return a[i < 0 ? a.length + i : i] ?? null;
        }
        case '$year': {
            const d = toDate(args()[0]);
            return d ? d.getUTCFullYear() : null;
        }
        case '$month': {
            const d = toDate(args()[0]);
            return d ? d.getUTCMonth() + 1 : null;
        }
        case '$dayOfMonth': {
            const d = toDate(args()[0]);
            return d ? d.getUTCDate() : null;
        }
        case '$hour': {
            const d = toDate(args()[0]);
            return d ? d.getUTCHours() : null;
        }
        case '$dateToString': {
            const d = toDate(evalExpr(arg?.date, doc));
            if (!d)
                return null;
            const p = (n) => String(n).padStart(2, '0');
            return String(arg?.format ?? '%Y-%m-%d')
                .replace('%Y', String(d.getUTCFullYear())).replace('%m', p(d.getUTCMonth() + 1)).replace('%d', p(d.getUTCDate()))
                .replace('%H', p(d.getUTCHours())).replace('%M', p(d.getUTCMinutes())).replace('%S', p(d.getUTCSeconds()));
        }
        case '$toString': {
            const [a] = args();
            return a === null || a === undefined ? null : typeof a === 'object' ? JSON.stringify(a) : String(a);
        }
        case '$toInt': {
            const [a] = args();
            const n = parseInt(String(a), 10);
            return Number.isFinite(n) ? n : null;
        }
        case '$toDouble': {
            const [a] = args();
            const n = Number(a);
            return Number.isFinite(n) ? n : null;
        }
        default:
            throw new Error(`Unsupported expression operator ${op}`);
    }
}
const ACCS = new Set(['$sum', '$avg', '$min', '$max', '$count', '$push', '$addToSet', '$first', '$last']);
function makeAccumulator(name) {
    switch (name) {
        case '$sum': {
            let s = 0;
            return { add: (v) => { if (num(v) !== null)
                    s += v; }, result: () => s };
        }
        case '$count': {
            let n = 0;
            return { add: () => { n++; }, result: () => n };
        }
        case '$avg': {
            let s = 0, n = 0;
            return { add: (v) => { if (num(v) !== null) {
                    s += v;
                    n++;
                } }, result: () => (n ? s / n : null) };
        }
        case '$min': {
            let m = undefined;
            return { add: (v) => { if (v !== null && v !== undefined && (m === undefined || (0, matcher_1.compareValues)(v, m) < 0))
                    m = v; }, result: () => m ?? null };
        }
        case '$max': {
            let m = undefined;
            return { add: (v) => { if (v !== null && v !== undefined && (m === undefined || (0, matcher_1.compareValues)(v, m) > 0))
                    m = v; }, result: () => m ?? null };
        }
        case '$push': {
            const a = [];
            return { add: (v) => { if (a.length < 100_000)
                    a.push(v); }, result: () => a };
        }
        case '$addToSet': {
            const m = new Map();
            return { add: (v) => { m.set(JSON.stringify(v), v); }, result: () => Array.from(m.values()) };
        }
        case '$first': {
            let f, set = false;
            return { add: (v) => { if (!set) {
                    f = v;
                    set = true;
                } }, result: () => f ?? null };
        }
        case '$last': {
            let l = null;
            return { add: (v) => { l = v; }, result: () => l ?? null };
        }
    }
}
function setPath(obj, p, value) {
    const segs = p.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        if (!(0, security_middleware_1.isPlainObject)(cur[segs[i]]))
            cur[segs[i]] = {};
        cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
}
function unsetPath(obj, p) {
    const segs = p.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        if (!(0, security_middleware_1.isPlainObject)(cur?.[segs[i]]))
            return;
        cur = cur[segs[i]];
    }
    delete cur[segs[segs.length - 1]];
}
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
function checkFieldName(f) {
    if (typeof f !== 'string' || !f || f.length > 255 || f.split('.').some((s) => !s || FORBIDDEN.has(s))) {
        throw new Error(`Invalid field name '${f}'`);
    }
}
function sortDocs(docs, spec) {
    const keys = Object.entries(spec).map(([f, d]) => { checkFieldName(f); return [f, d === -1 || d === 'desc' ? -1 : 1]; });
    docs.sort((a, b) => {
        for (const [f, dir] of keys) {
            const c = (0, matcher_1.compareValues)((0, matcher_1.getPath)(a, f), (0, matcher_1.getPath)(b, f));
            if (c !== 0)
                return dir * c;
        }
        return 0;
    });
}
/** Runs `pipeline` over `input` (each doc includes `id`). */
function runPipeline(input, pipeline, ctx) {
    if (!Array.isArray(pipeline))
        throw new Error('pipeline must be an array of stages');
    if (pipeline.length > MAX_STAGES)
        throw new Error(`At most ${MAX_STAGES} stages`);
    let docs = input;
    for (const [i, rawStage] of pipeline.entries()) {
        if (!(0, security_middleware_1.isPlainObject)(rawStage) || Object.keys(rawStage).length !== 1)
            throw new Error(`Stage ${i + 1} must be an object with exactly one operator`);
        const [op] = Object.keys(rawStage);
        const spec = (0, security_middleware_1.sanitizeObject)(rawStage[op]);
        try {
            docs = runStage(op, spec, docs, ctx);
        }
        catch (e) {
            throw new Error(`Stage ${i + 1} (${op}): ${e.message}`);
        }
        if (docs.length > MAX_DOCS)
            throw new Error(`Pipeline produced more than ${MAX_DOCS.toLocaleString()} documents`);
    }
    return docs;
}
function runStage(op, spec, docs, ctx) {
    switch (op) {
        case '$match': {
            const m = (0, matcher_1.compileQuery)(spec);
            return docs.filter((d) => m(d, d.id !== undefined ? String(d.id) : ''));
        }
        case '$project': {
            if (!(0, security_middleware_1.isPlainObject)(spec))
                throw new Error('$project needs an object');
            const entries = Object.entries(spec);
            const inclusive = entries.some(([k, v]) => k !== 'id' && (v === 1 || v === true || typeof v === 'string' || (0, security_middleware_1.isPlainObject)(v)));
            return docs.map((d) => {
                if (inclusive) {
                    const out = {};
                    if (spec.id !== 0 && spec.id !== false && d.id !== undefined)
                        out.id = d.id;
                    if (spec._id !== 0 && spec._id !== false && d._id !== undefined)
                        out._id = d._id;
                    for (const [k, v] of entries) {
                        if (v === 0 || v === false)
                            continue;
                        checkFieldName(k);
                        const val = v === 1 || v === true ? (0, matcher_1.getPath)(d, k) : evalExpr(v, d);
                        if (val !== undefined)
                            setPath(out, k, val);
                    }
                    return out;
                }
                const out = structuredClone(d);
                for (const [k] of entries) {
                    checkFieldName(k);
                    unsetPath(out, k);
                }
                return out;
            });
        }
        case '$addFields':
        case '$set': {
            if (!(0, security_middleware_1.isPlainObject)(spec))
                throw new Error(`${op} needs an object`);
            return docs.map((d) => {
                const out = { ...d };
                for (const [k, v] of Object.entries(spec)) {
                    checkFieldName(k);
                    setPath(out, k, evalExpr(v, d));
                }
                return out;
            });
        }
        case '$unset': {
            const fields = Array.isArray(spec) ? spec : [spec];
            fields.forEach(checkFieldName);
            return docs.map((d) => { const out = structuredClone(d); for (const f of fields)
                unsetPath(out, f); return out; });
        }
        case '$replaceRoot': {
            const root = spec?.newRoot;
            return docs.map((d) => { const v = evalExpr(root, d); if (!(0, security_middleware_1.isPlainObject)(v))
                throw new Error('newRoot must evaluate to an object'); return v; });
        }
        case '$group': {
            if (!(0, security_middleware_1.isPlainObject)(spec) || !('_id' in spec))
                throw new Error('$group needs an _id expression (null for a single group)');
            const fields = Object.entries(spec).filter(([k]) => k !== '_id').map(([k, v]) => {
                checkFieldName(k);
                if (!(0, security_middleware_1.isPlainObject)(v) || Object.keys(v).length !== 1 || !ACCS.has(Object.keys(v)[0])) {
                    throw new Error(`'${k}' must use one accumulator: ${Array.from(ACCS).join(', ')}`);
                }
                const [acc] = Object.keys(v);
                return { name: k, acc: acc, expr: v[acc] };
            });
            const groups = new Map();
            for (const d of docs) {
                const id = evalExpr(spec._id, d);
                const key = JSON.stringify(id ?? null);
                let g = groups.get(key);
                if (!g) {
                    g = { id: id ?? null, accs: fields.map((f) => makeAccumulator(f.acc)) };
                    groups.set(key, g);
                }
                fields.forEach((f, i) => g.accs[i].add(f.acc === '$count' ? 1 : evalExpr(f.expr, d)));
            }
            return Array.from(groups.values()).map((g) => {
                const out = { _id: g.id };
                fields.forEach((f, i) => { out[f.name] = g.accs[i].result(); });
                return out;
            });
        }
        case '$sortByCount': {
            const counts = runStage('$group', { _id: spec, count: { $sum: 1 } }, docs, ctx);
            counts.sort((a, b) => b.count - a.count);
            return counts;
        }
        case '$sort': {
            if (!(0, security_middleware_1.isPlainObject)(spec) || Object.keys(spec).length === 0)
                throw new Error('$sort needs { field: 1 | -1 }');
            const out = docs.slice();
            sortDocs(out, spec);
            return out;
        }
        case '$skip': {
            if (!Number.isInteger(spec) || spec < 0)
                throw new Error('$skip needs a non-negative integer');
            return docs.slice(spec);
        }
        case '$limit': {
            if (!Number.isInteger(spec) || spec < 1)
                throw new Error('$limit needs a positive integer');
            return docs.slice(0, spec);
        }
        case '$count': {
            if (typeof spec !== 'string' || !spec)
                throw new Error('$count needs an output field name');
            checkFieldName(spec);
            return [{ [spec]: docs.length }];
        }
        case '$unwind': {
            const opt = typeof spec === 'string' ? { path: spec } : spec;
            if (!(0, security_middleware_1.isPlainObject)(opt) || typeof opt.path !== 'string' || !opt.path.startsWith('$'))
                throw new Error('$unwind needs a "$field" path');
            const p = opt.path.slice(1);
            checkFieldName(p);
            const out = [];
            for (const d of docs) {
                const v = (0, matcher_1.getPath)(d, p);
                if (Array.isArray(v) && v.length > 0) {
                    v.forEach((el, idx) => {
                        const copy = { ...d };
                        setPath(copy, p, el);
                        if (opt.includeArrayIndex)
                            setPath(copy, opt.includeArrayIndex, idx);
                        out.push(copy);
                    });
                }
                else if (opt.preserveNullAndEmptyArrays) {
                    out.push(d);
                }
            }
            return out;
        }
        case '$lookup': {
            const { from, localField, foreignField, as } = spec ?? {};
            for (const [k, v] of Object.entries({ from, localField, foreignField, as })) {
                if (typeof v !== 'string' || !v)
                    throw new Error(`$lookup needs "${k}"`);
            }
            [localField, foreignField, as].forEach(checkFieldName);
            const local = new Set();
            for (const d of docs) {
                const v = (0, matcher_1.getPath)(d, localField);
                for (const x of Array.isArray(v) ? v : [v])
                    if (x !== undefined && x !== null)
                        local.add(x);
            }
            const foreign = local.size ? ctx.lookup(from, foreignField, Array.from(local)) : [];
            const byKey = new Map();
            for (const f of foreign) {
                const v = (0, matcher_1.getPath)(f, foreignField);
                for (const x of Array.isArray(v) ? v : [v]) {
                    const k = JSON.stringify(foreignField === 'id' ? String(x) : x);
                    if (!byKey.has(k))
                        byKey.set(k, []);
                    byKey.get(k).push(f);
                }
            }
            return docs.map((d) => {
                const v = (0, matcher_1.getPath)(d, localField);
                const matches = [];
                for (const x of Array.isArray(v) ? v : [v]) {
                    const k = JSON.stringify(foreignField === 'id' ? String(x) : x);
                    for (const f of byKey.get(k) ?? [])
                        if (!matches.includes(f))
                            matches.push(f);
                }
                const out = { ...d };
                setPath(out, as, matches);
                return out;
            });
        }
        default:
            throw new Error(`Unsupported stage ${op}`);
    }
}
//# sourceMappingURL=aggregate.js.map