"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPath = getPath;
exports.hasPath = hasPath;
exports.compileQuery = compileQuery;
exports.compareValues = compareValues;
const security_middleware_1 = require("../middleware/security.middleware");
const like_1 = require("./like");
const hasOwn = Object.prototype.hasOwnProperty;
/** Resolves a (possibly dotted) path using own properties only. */
function getPath(obj, path) {
    if (obj === null || typeof obj !== 'object')
        return undefined;
    if (path.indexOf('.') === -1)
        return hasOwn.call(obj, path) ? obj[path] : undefined;
    let cur = obj;
    for (const seg of path.split('.')) {
        if (cur === null || typeof cur !== 'object' || !hasOwn.call(cur, seg))
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
function hasPath(obj, path) {
    if (obj === null || typeof obj !== 'object')
        return false;
    if (path.indexOf('.') === -1)
        return hasOwn.call(obj, path);
    let cur = obj;
    for (const seg of path.split('.')) {
        if (cur === null || typeof cur !== 'object' || !hasOwn.call(cur, seg))
            return false;
        cur = cur[seg];
    }
    return true;
}
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object')
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!deepEqual(a[i], b[i]))
                return false;
        return true;
    }
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length)
        return false;
    for (const k of ka)
        if (!hasOwn.call(b, k) || !deepEqual(a[k], b[k]))
            return false;
    return true;
}
/** Equality with array-contains semantics. */
function eqMatch(value, operand) {
    if (value === operand)
        return true;
    if (operand !== null && typeof operand === 'object') {
        if (deepEqual(value, operand))
            return true;
    }
    else if (operand === null && value === undefined) {
        return true; // {field: null} matches missing, like Mongo
    }
    if (Array.isArray(value)) {
        for (const v of value)
            if (v === operand || (typeof operand === 'object' && deepEqual(v, operand)))
                return true;
    }
    return false;
}
function sameTypeCmp(operand, test) {
    const t = typeof operand;
    if (t !== 'number' && t !== 'string') {
        throw new Error('Comparison operators require a number or string operand');
    }
    const one = (v) => typeof v === t && test(v);
    return (v) => (Array.isArray(v) ? v.some(one) : one(v));
}
const TYPE_NAMES = new Set(['string', 'number', 'boolean', 'array', 'object', 'null']);
function typeOf(v) {
    if (v === null)
        return 'null';
    if (Array.isArray(v))
        return 'array';
    return typeof v;
}
/** Compiles an operator object ({$gt: 1, $lt: 5}) against a value. */
function compileOperators(ops) {
    const tests = [];
    for (const op of Object.keys(ops)) {
        const operand = ops[op];
        switch (op) {
            case '$eq':
                tests.push((v) => eqMatch(v, operand));
                break;
            case '$ne':
                tests.push((v) => !eqMatch(v, operand));
                break;
            case '$gt': {
                const c = sameTypeCmp(operand, (v) => v > operand);
                tests.push((v) => c(v));
                break;
            }
            case '$gte': {
                const c = sameTypeCmp(operand, (v) => v >= operand);
                tests.push((v) => c(v));
                break;
            }
            case '$lt': {
                const c = sameTypeCmp(operand, (v) => v < operand);
                tests.push((v) => c(v));
                break;
            }
            case '$lte': {
                const c = sameTypeCmp(operand, (v) => v <= operand);
                tests.push((v) => c(v));
                break;
            }
            case '$in': {
                if (!Array.isArray(operand))
                    throw new Error('$in requires an array');
                const prim = new Set(operand.filter((x) => x === null || typeof x !== 'object'));
                const objs = operand.filter((x) => x !== null && typeof x === 'object');
                const one = (x) => prim.has(x) || objs.some((o) => deepEqual(x, o));
                tests.push((v, present) => {
                    if (!present)
                        return prim.has(null);
                    return one(v) || (Array.isArray(v) && v.some(one));
                });
                break;
            }
            case '$nin': {
                if (!Array.isArray(operand))
                    throw new Error('$nin requires an array');
                const prim = new Set(operand.filter((x) => x === null || typeof x !== 'object'));
                const objs = operand.filter((x) => x !== null && typeof x === 'object');
                const one = (x) => prim.has(x) || objs.some((o) => deepEqual(x, o));
                tests.push((v, present) => {
                    if (!present)
                        return !prim.has(null);
                    return !(one(v) || (Array.isArray(v) && v.some(one)));
                });
                break;
            }
            case '$exists': {
                const want = Boolean(operand);
                tests.push((_v, present) => present === want);
                break;
            }
            case '$regex': {
                (0, security_middleware_1.validateRegexPattern)(operand);
                const flags = (0, security_middleware_1.validateRegexOptions)(ops.$options);
                const re = new RegExp(operand, flags);
                const one = (x) => typeof x === 'string' && x.length <= 100_000 && re.test(x);
                tests.push((v) => one(v) || (Array.isArray(v) && v.some(one)));
                break;
            }
            case '$like': {
                // SQL LIKE (% and _, case-insensitive), matched without a regex.
                const like = (0, like_1.compileLike)(operand);
                const one = (x) => typeof x === 'string' && like(x);
                tests.push((v) => one(v) || (Array.isArray(v) && v.some(one)));
                break;
            }
            case '$options':
                if (!hasOwn.call(ops, '$regex'))
                    throw new Error('$options requires $regex');
                break;
            case '$size': {
                if (typeof operand !== 'number')
                    throw new Error('$size requires a number');
                tests.push((v) => Array.isArray(v) && v.length === operand);
                break;
            }
            case '$all': {
                if (!Array.isArray(operand))
                    throw new Error('$all requires an array');
                tests.push((v) => Array.isArray(v) && operand.every((o) => v.some((x) => eqMatch(x, o))));
                break;
            }
            case '$elemMatch': {
                if (!(0, security_middleware_1.isPlainObject)(operand))
                    throw new Error('$elemMatch requires an object');
                const isOps = Object.keys(operand).every((k) => k.startsWith('$'));
                const inner = isOps ? compileOperators(operand) : null;
                const sub = isOps ? null : compileQuery(operand);
                tests.push((v) => Array.isArray(v) && v.some((el) => inner ? inner(el, true) : sub(el, '')));
                break;
            }
            case '$type': {
                if (typeof operand !== 'string' || !TYPE_NAMES.has(operand)) {
                    throw new Error(`$type must be one of: ${Array.from(TYPE_NAMES).join(', ')}`);
                }
                tests.push((v, present) => present && typeOf(v) === operand);
                break;
            }
            case '$not': {
                if (!(0, security_middleware_1.isPlainObject)(operand))
                    throw new Error('$not requires an operator object');
                const inner = compileOperators(operand);
                tests.push((v, present) => !inner(v, present));
                break;
            }
            default:
                throw new Error(`Unsupported query operator: ${op}`);
        }
    }
    return (value, present) => {
        for (const t of tests)
            if (!t(value, present))
                return false;
        return true;
    };
}
function isOperatorObject(v) {
    if (!(0, security_middleware_1.isPlainObject)(v))
        return false;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}
function compileQuery(query) {
    if (!(0, security_middleware_1.isPlainObject)(query))
        throw new Error('Query must be an object');
    const parts = [];
    for (const key of Object.keys(query)) {
        const qv = query[key];
        switch (key) {
            case '$and': {
                if (!Array.isArray(qv))
                    throw new Error('$and requires an array');
                const subs = qv.map(compileQuery);
                parts.push((d, id) => subs.every((m) => m(d, id)));
                continue;
            }
            case '$or': {
                if (!Array.isArray(qv))
                    throw new Error('$or requires an array');
                const subs = qv.map(compileQuery);
                parts.push((d, id) => subs.some((m) => m(d, id)));
                continue;
            }
            case '$nor': {
                if (!Array.isArray(qv))
                    throw new Error('$nor requires an array');
                const subs = qv.map(compileQuery);
                parts.push((d, id) => !subs.some((m) => m(d, id)));
                continue;
            }
            case '$not': {
                const sub = compileQuery(qv);
                parts.push((d, id) => !sub(d, id));
                continue;
            }
        }
        if (key.startsWith('$'))
            throw new Error(`Unsupported top-level operator: ${key}`);
        if (key === 'id') {
            // The document id lives on the envelope, not in data.
            if (isOperatorObject(qv)) {
                const ops = compileOperators(normalizeIdOperand(qv));
                // Ids are numeric strings: compare numerically for range operators.
                const numeric = ['$gt', '$gte', '$lt', '$lte'].some((k) => typeof qv[k] === 'number');
                parts.push((_d, id) => ops(numeric ? Number(id) : id, true));
            }
            else {
                const want = String(qv);
                parts.push((_d, id) => id === want);
            }
            continue;
        }
        if (isOperatorObject(qv)) {
            const ops = compileOperators(qv);
            // Only fall back to the hasPath walk for the rare explicit-undefined case.
            parts.push((d) => {
                const v = getPath(d, key);
                return ops(v, v !== undefined || hasPath(d, key));
            });
        }
        else {
            parts.push((d) => eqMatch(getPath(d, key), qv));
        }
    }
    if (parts.length === 0)
        return () => true;
    if (parts.length === 1)
        return parts[0];
    return (d, id) => {
        for (const p of parts)
            if (!p(d, id))
                return false;
        return true;
    };
}
/** Ids are strings internally; let callers pass numbers in id operators. */
function normalizeIdOperand(ops) {
    const out = {};
    for (const [k, v] of Object.entries(ops)) {
        if ((k === '$in' || k === '$nin') && Array.isArray(v))
            out[k] = v.map(String);
        else if (k === '$eq' || k === '$ne')
            out[k] = String(v);
        else
            out[k] = v;
    }
    return out;
}
// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
const TYPE_RANK = { number: 1, string: 2, boolean: 3, object: 4 };
/** Total order across mixed types; missing/null values sort last. */
function compareValues(a, b) {
    const an = a === undefined || a === null;
    const bn = b === undefined || b === null;
    if (an || bn)
        return an && bn ? 0 : an ? 1 : -1;
    const ta = typeof a, tb = typeof b;
    if (ta !== tb)
        return (TYPE_RANK[ta] ?? 9) - (TYPE_RANK[tb] ?? 9);
    if (ta === 'object') {
        const sa = JSON.stringify(a), sb = JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}
//# sourceMappingURL=matcher.js.map