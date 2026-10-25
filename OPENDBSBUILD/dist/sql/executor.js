"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truth = exports.sqlEquals = exports.compare = void 0;
exports.collectTables = collectTables;
exports.loadCatalog = loadCatalog;
exports.prepareQuery = prepareQuery;
exports.executeQuery = executeQuery;
exports.selectFrom = selectFrom;
exports.evaluateOnRows = evaluateOnRows;
exports.compileRowPredicate = compileRowPredicate;
exports.constantRow = constantRow;
const parser_1 = require("./parser");
const like_1 = require("../query/like");
const functions_1 = require("./functions");
Object.defineProperty(exports, "compare", { enumerable: true, get: function () { return functions_1.compare; } });
Object.defineProperty(exports, "sqlEquals", { enumerable: true, get: function () { return functions_1.sqlEquals; } });
Object.defineProperty(exports, "truth", { enumerable: true, get: function () { return functions_1.truth; } });
const security_middleware_1 = require("../middleware/security.middleware");
const agg_state_1 = require("./agg-state");
const MAX_JOIN_ROWS = 2_000_000;
const MAX_RECURSION = 1000;
const IN_PUSHDOWN_MAX = 5000;
const AGG = Symbol('agg');
const WIN = Symbol('win');
const SQ = Symbol('sq');
const OUT = Symbol('out');
class Scope {
    sources;
    parent;
    cat;
    depth;
    /** Smallest depth of an outer scope referenced from this scope (or below). */
    minOuter = Infinity;
    grouped = null;
    aggs = null;
    /** Where aggregate arguments are compiled (the pre-grouping scope). */
    pre = null;
    wins = null;
    namedWindows = {};
    subs = [];
    /** ORDER BY: output column name → index in the projection. */
    outputAliases = null;
    /** VALUES(col) inside ON DUPLICATE KEY UPDATE refers to this alias. */
    valuesAlias = null;
    constructor(sources, parent, cat) {
        this.sources = sources;
        this.parent = parent;
        this.cat = cat;
        this.depth = parent ? parent.depth + 1 : 0;
    }
    /** A sibling scope over the same sources (different stage settings). */
    derive() {
        const s = new Scope(this.sources, this.parent, this.cat);
        s.namedWindows = this.namedWindows;
        s.valuesAlias = this.valuesAlias;
        s.root = this.root ?? this;
        return s;
    }
    root = null;
    markOuter(depth) {
        const mark = (s) => {
            s.minOuter = Math.min(s.minOuter, depth);
            if (s.root)
                s.root.minOuter = Math.min(s.root.minOuter, depth);
        };
        mark(this);
        for (let s = this.parent; s && s.depth > depth; s = s.parent)
            mark(s);
    }
}
function resolveIn(s, parts) {
    if (parts.length >= 2) {
        const src = s.sources.find((x) => x.alias === parts[0]);
        if (src) {
            const col = parts[1];
            if (src.known && !src.columns.has(col))
                throw new Error(`Unknown column '${parts.join('.')}'`);
            return { alias: src.alias, col, path: parts.slice(2) };
        }
    }
    const head = parts[0];
    const owners = s.sources.filter((x) => !x.qualifiedOnly && x.columns.has(head));
    if (owners.length === 1)
        return { alias: owners[0].alias, col: head, path: parts.slice(1) };
    if (owners.length > 1) {
        throw new Error(`Column '${parts.join('.')}' is ambiguous — qualify it, e.g. ${owners[0].alias}.${parts.join('.')}`);
    }
    // NoSQL racks: a field missing from the column sample still belongs to the only table.
    if (s.sources.length === 1 && !s.sources[0].known)
        return { alias: s.sources[0].alias, col: head, path: parts.slice(1) };
    return null;
}
function resolveRef(scope, parts) {
    let lvl = 0;
    for (let s = scope; s; s = s.parent, lvl++) {
        const r = resolveIn(s, parts);
        if (r) {
            if (lvl > 0)
                scope.markOuter(s.depth);
            return { ...r, lvl };
        }
    }
    throw new Error(`Unknown column '${parts.join('.')}'`);
}
const hasOwn = Object.prototype.hasOwnProperty;
function readPath(o, col, path) {
    if (o === null || o === undefined || typeof o !== 'object')
        return null;
    let v = hasOwn.call(o, col) ? o[col] : undefined;
    for (const p of path) {
        if (v === null || v === undefined || typeof v !== 'object')
            return null;
        v = hasOwn.call(v, p) ? v[p] : undefined;
    }
    return v === undefined ? null : v;
}
/** Canonical text of an expression (refs resolved) — used to match GROUP BY expressions. */
function exprKey(e, scope) {
    return JSON.stringify(e, (_k, v) => {
        if (v && typeof v === 'object' && v.k === 'ref') {
            try {
                const r = resolveRef(scope, v.parts);
                return { R: `${r.lvl}:${r.alias}.${r.col}${r.path.length ? '.' + r.path.join('.') : ''}` };
            }
            catch {
                return { R: v.parts.join('.') };
            }
        }
        if (v && typeof v === 'object' && (v.k === 'subq' || v.k === 'exists' || v.k === 'quant'))
            return { S: Math.random() };
        if (v && typeof v === 'object' && v.k === 'fn')
            return { ...v, name: v.name.toUpperCase() };
        return v;
    });
}
/** Does the expression contain an aggregate call (outside subqueries; window calls count only via their arguments)? */
function containsAggregate(e) {
    if (!e || typeof e !== 'object')
        return false;
    if (Array.isArray(e))
        return e.some(containsAggregate);
    if (e.k === 'subq' || e.k === 'exists' || e.k === 'quant' || (e.k === 'in' && e.sub)) {
        return e.k === 'in' || e.k === 'quant' ? containsAggregate(e.e) : false;
    }
    if (e.k === 'fn') {
        if (!e.over && (0, parser_1.isAggregateName)(e.name))
            return true;
        return e.args.some(containsAggregate) || containsAggregate(e.filter);
    }
    for (const v of Object.values(e))
        if (v && typeof v === 'object' && containsAggregate(v))
            return true;
    return false;
}
function hasSubquery(e) {
    if (!e || typeof e !== 'object')
        return false;
    if (Array.isArray(e))
        return e.some(hasSubquery);
    if (e.k === 'subq' || e.k === 'exists' || e.k === 'quant' || (e.k === 'in' && e.sub))
        return true;
    for (const v of Object.values(e))
        if (v && typeof v === 'object' && hasSubquery(v))
            return true;
    return false;
}
function splitAnd(e) {
    if (!e)
        return [];
    if (e.k === 'bin' && e.op === 'AND')
        return [...splitAnd(e.l), ...splitAnd(e.r)];
    return [e];
}
/** Aliases (level 0) referenced by an expression, or null if it can't be determined. */
function aliasesOf(e, scope) {
    const out = new Set();
    let ok = true;
    const walk = (x) => {
        if (!ok || !x || typeof x !== 'object')
            return;
        if (Array.isArray(x)) {
            x.forEach(walk);
            return;
        }
        if (x.k === 'ref') {
            try {
                const r = resolveRef(scope, x.parts);
                if (r.lvl === 0)
                    out.add(r.alias);
            }
            catch {
                ok = false;
            }
            return;
        }
        if (x.k === 'subq' || x.k === 'exists' || x.k === 'quant' || (x.k === 'in' && x.sub)) {
            if (x.k === 'in' || x.k === 'quant')
                walk(x.e);
            ok = ok && true;
            return;
        }
        for (const v of Object.values(x))
            if (v && typeof v === 'object')
                walk(v);
    };
    walk(e);
    return ok ? out : null;
}
// ───────────────────────────── catalog ─────────────────────────────
class Catalog {
    tables;
    ctx;
    constructor(tables, ctx) {
        this.tables = tables;
        this.ctx = ctx;
    }
}
/** Every table name mentioned anywhere in the statement (CTE names included; they resolve to null). */
function collectTables(node, out = new Set()) {
    if (!node || typeof node !== 'object')
        return out;
    if (Array.isArray(node)) {
        for (const n of node)
            collectTables(n, out);
        return out;
    }
    if (node.k === 'table' && typeof node.name === 'string')
        out.add(node.name);
    for (const v of Object.values(node))
        if (v && typeof v === 'object')
            collectTables(v, out);
    return out;
}
async function loadCatalog(ctx, names) {
    const tables = new Map();
    for (const n of names)
        tables.set(n, await ctx.ds.describe(n));
    return new Catalog(tables, ctx);
}
function compileExpr(e, scope, cc) {
    // Inside a grouped stage, an expression equal to a GROUP BY key is read from the group's sample row.
    if (scope.grouped && scope.grouped.size && e.k !== 'lit' && e.k !== 'param' && scope.grouped.has(exprKey(e, scope))) {
        const plain = scope.pre ?? scope.derive();
        return compileExpr(e, plain, cc);
    }
    switch (e.k) {
        case 'lit': {
            const v = e.v;
            return () => v;
        }
        case 'param': {
            const i = e.i;
            if (i >= cc.cat.ctx.params.length)
                throw new Error(`Missing value for parameter ${i + 1} (got ${cc.cat.ctx.params.length})`);
            return (_r, env) => env.params[i] ?? null;
        }
        case 'star': throw new Error('* is only allowed in a SELECT list or COUNT(*)');
        case 'ref': return compileRef(e.parts, scope);
        case 'un': {
            const c = compileExpr(e.e, scope, cc);
            if (e.op === 'NOT')
                return (r, env) => { const t = (0, functions_1.truth)(c(r, env)); return t === null ? null : !t; };
            if (e.op === '-')
                return (r, env) => { const n = (0, functions_1.toNum)(c(r, env)); return n === null ? null : -n; };
            return (r, env) => (0, functions_1.toNum)(c(r, env));
        }
        case 'bin': return compileBinary(e, scope, cc);
        case 'like': {
            const v = compileExpr(e.e, scope, cc);
            const p = compileExpr(e.pat, scope, cc);
            const esc = e.esc ? compileExpr(e.esc, scope, cc) : null;
            const not = e.not;
            const cache = new Map();
            const re = (pat, escape) => {
                const key = `${pat}\u0000${escape}`;
                let r = cache.get(key);
                if (!r) {
                    if (e.regexp) {
                        (0, security_middleware_1.validateRegexPattern)(pat);
                        const rx = new RegExp(pat, 'i');
                        r = (s) => rx.test(s);
                    }
                    else {
                        r = (0, like_1.compileLike)(pat, escape);
                    }
                    if (cache.size < 1000)
                        cache.set(key, r);
                }
                return r;
            };
            return (r, env) => {
                const s = (0, functions_1.toStr)(v(r, env)), pat = (0, functions_1.toStr)(p(r, env));
                if (s === null || pat === null)
                    return null;
                const m = re(pat, esc ? (0, functions_1.toStr)(esc(r, env)) ?? '' : '\\')(s);
                return not ? !m : m;
            };
        }
        case 'between': {
            const v = compileExpr(e.e, scope, cc), lo = compileExpr(e.lo, scope, cc), hi = compileExpr(e.hi, scope, cc);
            const not = e.not;
            return (r, env) => {
                const x = v(r, env);
                const a = (0, functions_1.compare)(x, lo(r, env)), b = (0, functions_1.compare)(x, hi(r, env));
                const ge = a === null ? null : a >= 0, le = b === null ? null : b <= 0;
                const res = ge === false || le === false ? false : ge === null || le === null ? null : true;
                return res === null ? null : not ? !res : res;
            };
        }
        case 'in': {
            const v = compileExpr(e.e, scope, cc);
            const not = e.not;
            const finish = (x, found, sawNull) => {
                if ((0, functions_1.isNull)(x))
                    return null;
                const res = found ? true : sawNull ? null : false;
                return res === null ? null : not ? !res : res;
            };
            if (e.sub) {
                const sub = compileSub(e.sub, 'in', scope, cc);
                return (r, env) => {
                    const x = v(r, env);
                    const s = subValue(sub, r, env);
                    if ((0, functions_1.isNull)(x))
                        return finish(x, false, false);
                    const found = typeof x === 'boolean' ? s.values.some((y) => (0, functions_1.sqlEquals)(x, y) === true) : s.keys.has((0, functions_1.valueKey)(x));
                    return finish(x, found, s.hasNull);
                };
            }
            const items = e.list.map((x) => compileExpr(x, scope, cc));
            const literal = e.list.every((x) => x.k === 'lit' && typeof x.v !== 'boolean');
            if (literal) {
                const keys = new Set(e.list.filter((x) => x.k === 'lit' && !(0, functions_1.isNull)(x.v)).map((x) => (0, functions_1.valueKey)(x.v)));
                const sawNull = e.list.some((x) => x.k === 'lit' && (0, functions_1.isNull)(x.v));
                return (r, env) => {
                    const x = v(r, env);
                    if ((0, functions_1.isNull)(x))
                        return null;
                    const found = typeof x === 'boolean' ? e.list.some((y) => (0, functions_1.sqlEquals)(x, y.v) === true) : keys.has((0, functions_1.valueKey)(x));
                    return finish(x, found, sawNull);
                };
            }
            return (r, env) => {
                const x = v(r, env);
                let found = false, sawNull = false;
                for (const it of items) {
                    const eq = (0, functions_1.sqlEquals)(x, it(r, env));
                    if (eq === true) {
                        found = true;
                        break;
                    }
                    if (eq === null)
                        sawNull = true;
                }
                return finish(x, found, sawNull);
            };
        }
        case 'is': {
            const v = compileExpr(e.e, scope, cc);
            const { what, not } = e;
            return (r, env) => {
                const x = v(r, env);
                let res;
                if (what === 'null')
                    res = (0, functions_1.isNull)(x);
                else if (what === 'unknown')
                    res = (0, functions_1.truth)(x) === null;
                else
                    res = (0, functions_1.truth)(x) === (what === 'true');
                return not ? !res : res;
            };
        }
        case 'distinctfrom': {
            const l = compileExpr(e.l, scope, cc), rr = compileExpr(e.r, scope, cc);
            const not = e.not;
            return (r, env) => {
                const a = l(r, env), b = rr(r, env);
                const same = (0, functions_1.isNull)(a) && (0, functions_1.isNull)(b) ? true : (0, functions_1.isNull)(a) || (0, functions_1.isNull)(b) ? false : (0, functions_1.sqlEquals)(a, b) === true;
                return not ? same : !same;
            };
        }
        case 'exists': {
            const sub = compileSub(e.sub, 'exists', scope, cc);
            const not = e.not;
            return (r, env) => { const x = subValue(sub, r, env); return not ? !x : x; };
        }
        case 'subq': {
            const sub = compileSub(e.sub, 'scalar', scope, cc);
            return (r, env) => subValue(sub, r, env);
        }
        case 'quant': {
            const v = compileExpr(e.e, scope, cc);
            const sub = compileSub(e.sub, 'list', scope, cc);
            const test = comparator(e.op);
            const all = e.quant === 'all';
            return (r, env) => {
                const x = v(r, env);
                const list = subValue(sub, r, env);
                let sawNull = false;
                for (const y of list) {
                    const t = test(x, y);
                    if (t === null) {
                        sawNull = true;
                        continue;
                    }
                    if (all && !t)
                        return false;
                    if (!all && t)
                        return true;
                }
                return sawNull ? null : all;
            };
        }
        case 'case': {
            const base = e.base ? compileExpr(e.base, scope, cc) : null;
            const whens = e.whens.map(([w, t]) => [compileExpr(w, scope, cc), compileExpr(t, scope, cc)]);
            const els = e.else ? compileExpr(e.else, scope, cc) : null;
            return (r, env) => {
                const b = base ? base(r, env) : undefined;
                for (const [w, t] of whens) {
                    const hit = base ? (0, functions_1.sqlEquals)(b, w(r, env)) === true : (0, functions_1.truth)(w(r, env)) === true;
                    if (hit)
                        return t(r, env);
                }
                return els ? els(r, env) : null;
            };
        }
        case 'cast': {
            const v = compileExpr(e.e, scope, cc);
            const to = e.to;
            return (r, env) => (0, functions_1.castTo)(v(r, env), to);
        }
        case 'interval': {
            const v = compileExpr(e.v, scope, cc);
            const unit = e.unit;
            return (r, env) => (0, functions_1.makeInterval)(v(r, env), unit);
        }
        case 'fn': return compileCall(e, scope, cc);
    }
    throw new Error('Unsupported expression');
}
function compileRef(parts, scope) {
    if (scope.outputAliases && parts.length === 1 && scope.outputAliases.has(parts[0])) {
        const idx = scope.outputAliases.get(parts[0]);
        return (r) => r[OUT][idx];
    }
    const res = resolveRef(scope, parts);
    if (scope.grouped && res.lvl === 0) {
        throw new Error(`Column '${parts.join('.')}' must appear in GROUP BY or be used in an aggregate function`);
    }
    const { alias, col, path } = res;
    if (res.lvl === 0) {
        if (path.length === 0)
            return (r) => { const o = r[alias]; if (!o)
                return null; const v = o[col]; return v === undefined ? null : v; };
        return (r) => readPath(r[alias], col, path);
    }
    const k = res.lvl - 1;
    return (_r, env) => readPath(env.outer[k]?.[alias], col, path);
}
function comparator(op) {
    switch (op) {
        case '=': return (a, b) => { const c = (0, functions_1.compare)(a, b); return c === null ? null : c === 0; };
        case '!=': return (a, b) => { const c = (0, functions_1.compare)(a, b); return c === null ? null : c !== 0; };
        case '<': return (a, b) => { const c = (0, functions_1.compare)(a, b); return c === null ? null : c < 0; };
        case '<=': return (a, b) => { const c = (0, functions_1.compare)(a, b); return c === null ? null : c <= 0; };
        case '>': return (a, b) => { const c = (0, functions_1.compare)(a, b); return c === null ? null : c > 0; };
        case '>=': return (a, b) => { const c = (0, functions_1.compare)(a, b); return c === null ? null : c >= 0; };
        case '<=>': return (a, b) => ((0, functions_1.isNull)(a) && (0, functions_1.isNull)(b) ? true : (0, functions_1.isNull)(a) || (0, functions_1.isNull)(b) ? false : (0, functions_1.sqlEquals)(a, b) === true);
    }
    throw new Error(`Unknown operator ${op}`);
}
function compileBinary(e, scope, cc) {
    const l = compileExpr(e.l, scope, cc), r = compileExpr(e.r, scope, cc);
    switch (e.op) {
        case 'AND': return (row, env) => {
            const a = (0, functions_1.truth)(l(row, env));
            if (a === false)
                return false;
            const b = (0, functions_1.truth)(r(row, env));
            if (b === false)
                return false;
            return a === null || b === null ? null : true;
        };
        case 'OR': return (row, env) => {
            const a = (0, functions_1.truth)(l(row, env));
            if (a === true)
                return true;
            const b = (0, functions_1.truth)(r(row, env));
            if (b === true)
                return true;
            return a === null || b === null ? null : false;
        };
        case 'XOR': return (row, env) => {
            const a = (0, functions_1.truth)(l(row, env)), b = (0, functions_1.truth)(r(row, env));
            return a === null || b === null ? null : a !== b;
        };
        case '||': return (row, env) => {
            const a = l(row, env), b = r(row, env);
            return (0, functions_1.isNull)(a) || (0, functions_1.isNull)(b) ? null : `${(0, functions_1.toStr)(a)}${(0, functions_1.toStr)(b)}`;
        };
        case '+':
        case '-': return (row, env) => {
            const a = l(row, env), b = r(row, env);
            if ((0, functions_1.isNull)(a) || (0, functions_1.isNull)(b))
                return null;
            if ((0, functions_1.isInterval)(b))
                return (0, functions_1.addInterval)(a, b.n, b.unit, e.op === '-' ? -1 : 1);
            if ((0, functions_1.isInterval)(a) && e.op === '+')
                return (0, functions_1.addInterval)(b, a.n, a.unit);
            const x = (0, functions_1.toNum)(a), y = (0, functions_1.toNum)(b);
            if (x === null || y === null)
                return null;
            return e.op === '+' ? x + y : x - y;
        };
        case '*': return (row, env) => { const x = (0, functions_1.toNum)(l(row, env)), y = (0, functions_1.toNum)(r(row, env)); return x === null || y === null ? null : x * y; };
        case '/': return (row, env) => { const x = (0, functions_1.toNum)(l(row, env)), y = (0, functions_1.toNum)(r(row, env)); return x === null || y === null || y === 0 ? null : x / y; };
        case 'DIV': return (row, env) => { const x = (0, functions_1.toNum)(l(row, env)), y = (0, functions_1.toNum)(r(row, env)); return x === null || y === null || y === 0 ? null : Math.trunc(x / y); };
        case '%': return (row, env) => { const x = (0, functions_1.toNum)(l(row, env)), y = (0, functions_1.toNum)(r(row, env)); return x === null || y === null || y === 0 ? null : x % y; };
        default: {
            const test = comparator(e.op);
            return (row, env) => test(l(row, env), r(row, env));
        }
    }
}
function compileCall(e, scope, cc) {
    const name = e.name.toUpperCase();
    if (name === '__ROW__') {
        const alias = e.args[0].parts[0];
        return (r) => r[alias] ?? null;
    }
    if (name === 'VALUES' && scope.valuesAlias && e.args.length === 1 && e.args[0].k === 'ref') {
        const parts = e.args[0].parts;
        return compileRef([scope.valuesAlias, parts[parts.length - 1]], scope);
    }
    if (e.over) {
        if (!scope.wins)
            throw new Error(`Window function ${name} is only allowed in SELECT and ORDER BY`);
        if (!(0, parser_1.isAggregateName)(name) && !(0, parser_1.isWindowOnlyName)(name))
            throw new Error(`${name} is not a window function`);
        let spec = e.over;
        if (spec.ref) {
            const base = scope.namedWindows[spec.ref];
            if (!base)
                throw new Error(`Unknown window '${spec.ref}'`);
            spec = { partition: base.partition, order: spec.order.length ? spec.order : base.order, frame: spec.frame ?? base.frame };
        }
        const argScope = scope.derive();
        argScope.grouped = scope.grouped;
        argScope.aggs = scope.aggs;
        argScope.pre = scope.pre;
        argScope.wins = null;
        argScope.subs = scope.subs;
        const def = {
            name,
            args: e.args.map((a) => compileExpr(a, argScope, cc)),
            star: Boolean(e.star),
            distinct: Boolean(e.distinct),
            partition: spec.partition.map((p) => compileExpr(p, argScope, cc)),
            order: spec.order.map((o) => ({ c: compileExpr(o.e, argScope, cc), desc: o.desc, nulls: o.nulls })),
            frame: spec.frame,
        };
        if (def.distinct)
            throw new Error(`DISTINCT is not supported in window function ${name}`);
        const i = scope.wins.push(def) - 1;
        return (r) => r[WIN][i];
    }
    if ((0, parser_1.isWindowOnlyName)(name))
        throw new Error(`${name}() needs an OVER (…) clause`);
    if ((0, parser_1.isAggregateName)(name)) {
        if (!scope.aggs || !scope.pre)
            throw new Error(`Aggregate function ${name}() is not allowed here`);
        const pre = scope.pre;
        if (e.star && name !== 'COUNT')
            throw new Error(`${name}(*) is not valid; name a column`);
        const def = {
            name,
            args: e.args.map((a) => compileExpr(a, pre, cc)),
            star: Boolean(e.star),
            distinct: Boolean(e.distinct),
            filter: e.filter ? compileExpr(e.filter, pre, cc) : undefined,
            order: e.orderBy?.map((o) => ({ c: compileExpr(o.e, pre, cc), desc: o.desc, nulls: o.nulls })),
            sep: e.sep ? compileExpr(e.sep, pre, cc) : undefined,
            argExprs: e.args,
        };
        if (!def.star && def.args.length === 0)
            throw new Error(`${name}() needs an argument`);
        const i = scope.aggs.push(def) - 1;
        return (r) => r[AGG][i];
    }
    const f = functions_1.FUNCTIONS[name];
    if (!f)
        throw new Error(`Unknown function ${e.name}()`);
    if (e.star || e.distinct)
        throw new Error(`${name}() does not take ${e.star ? '*' : 'DISTINCT'}`);
    const args = e.args.map((a) => compileExpr(a, scope, cc));
    if (name === 'RAND' || name === 'RANDOM' || name === 'UUID' || name === 'GEN_RANDOM_UUID' || name === 'SYSDATE') {
        return (r, env) => f(args.map((a) => a(r, env)), env.fn);
    }
    if (args.length === 0)
        return (_r, env) => f([], env.fn);
    if (args.length === 1) {
        const a0 = args[0];
        return (r, env) => f([a0(r, env)], env.fn);
    }
    return (r, env) => f(args.map((a) => a(r, env)), env.fn);
}
function compileSub(q, kind, scope, cc) {
    const plan = compileQuery(q, scope, cc);
    if ((kind === 'scalar' || kind === 'in' || kind === 'list') && plan.columns.length !== 1) {
        throw new Error(`Subquery must return exactly one column (it returns ${plan.columns.length})`);
    }
    const def = { kind, plan, correlated: plan.correlated };
    scope.subs.push(def);
    return def;
}
function subValue(def, row, env) {
    const v = def.correlated ? row[SQ]?.get(def) : env.sqCache.get(def);
    if (v === undefined)
        throw new Error('Subquery result is not available here');
    return v;
}
async function runSub(def, env, row) {
    const subEnv = row ? { ...env, outer: [row, ...env.outer], sqCache: new Map() } : env;
    const rel = await def.plan.run(subEnv);
    switch (def.kind) {
        case 'exists': return rel.rows.length > 0;
        case 'scalar':
            if (rel.rows.length > 1)
                throw new Error('Subquery returned more than one row');
            return rel.rows.length ? rel.rows[0][0] ?? null : null;
        case 'list': return rel.rows.map((r) => r[0]);
        case 'in': {
            const keys = new Set();
            let hasNull = false;
            const values = [];
            for (const r of rel.rows) {
                if ((0, functions_1.isNull)(r[0])) {
                    hasNull = true;
                    continue;
                }
                keys.add((0, functions_1.valueKey)(r[0]));
                values.push(r[0]);
            }
            return { keys, values, hasNull };
        }
    }
}
/** Evaluates the subqueries a stage needs: uncorrelated ones once, correlated ones per row. */
async function prepareSubs(defs, rows, env) {
    for (const d of defs) {
        if (!d.correlated) {
            if (!env.sqCache.has(d))
                env.sqCache.set(d, await runSub(d, env, null));
            continue;
        }
        for (const r of rows) {
            let m = r[SQ];
            if (!m)
                r[SQ] = m = new Map();
            if (!m.has(d))
                m.set(d, await runSub(d, env, r));
        }
    }
}
// ───────────────────────────── pushdown ─────────────────────────────
const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'date']);
/**
 * Translates one WHERE conjunct on a single table into an engine query.
 * `exact`: the engine returns exactly the rows SQL would (so LIMIT/ORDER BY/COUNT can be pushed too).
 */
function toEngineQuery(e, alias, src, scope, constOf) {
    const field = (x) => {
        if (x.k !== 'ref')
            return null;
        let r;
        try {
            r = resolveRef(scope, x.parts);
        }
        catch {
            return null;
        }
        if (r.lvl !== 0 || r.alias !== alias)
            return null;
        const key = [r.col, ...r.path].join('.');
        if (key.startsWith('$') || key === '_metadata' || key.split('.').some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype'))
            return null;
        const declared = r.path.length === 0 ? (r.col === 'id' ? 'id' : src.types[r.col]) : undefined;
        return { key, col: r.col, declared };
    };
    // Engine values that cover every SQL-equal value (numbers ↔ canonical numeric strings, booleans ↔ 0/1).
    const variants = (v) => {
        const out = [v];
        if (typeof v === 'number') {
            out.push(String(v));
            if (v === 0 || v === 1)
                out.push(v === 1);
        }
        else if (typeof v === 'string') {
            const n = (0, functions_1.canonicalNumber)(v);
            if (n !== null) {
                out.push(n);
                if (n === 0 || n === 1)
                    out.push(n === 1);
            }
        }
        else if (typeof v === 'boolean')
            out.push(v ? 1 : 0);
        return out;
    };
    const naturalFor = (declared, v) => {
        if (!declared || !SCALAR_TYPES.has(declared) && declared !== 'id')
            return false;
        if (declared === 'id')
            return typeof v === 'string' || typeof v === 'number';
        if (declared === 'integer' || declared === 'number')
            return typeof v === 'number';
        if (declared === 'boolean')
            return typeof v === 'boolean';
        return typeof v === 'string';
    };
    const typedValue = (declared, v) => {
        if ((declared === 'integer' || declared === 'number') && typeof v === 'string') {
            const n = (0, functions_1.canonicalNumber)(v);
            return n ?? v;
        }
        if (declared === 'boolean' && (v === 0 || v === 1))
            return v === 1;
        return v;
    };
    switch (e.k) {
        case 'lit': {
            const t = (0, functions_1.truth)(e.v);
            return { q: t === true ? {} : { $nor: [{}] }, exact: true };
        }
        case 'bin': {
            if (e.op === 'AND' || e.op === 'OR') {
                const a = toEngineQuery(e.l, alias, src, scope, constOf), b = toEngineQuery(e.r, alias, src, scope, constOf);
                if (e.op === 'AND') {
                    if (!a && !b)
                        return null;
                    if (!a || !b)
                        return { q: (a ?? b).q, exact: false };
                    return { q: { $and: [a.q, b.q] }, exact: a.exact && b.exact };
                }
                if (!a || !b)
                    return null;
                return { q: { $or: [a.q, b.q] }, exact: a.exact && b.exact };
            }
            if (!['=', '!=', '<', '<=', '>', '>='].includes(e.op))
                return null;
            let f = field(e.l), c = constOf(e.r), op = e.op;
            if (!f) {
                f = field(e.r);
                c = constOf(e.l);
                op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op] ?? op;
            }
            if (!f || !c.ok || (0, functions_1.isNull)(c.v) || typeof c.v === 'object')
                return null;
            const v = typedValue(f.declared, c.v);
            const exact = naturalFor(f.declared, v);
            if (f.declared === 'id') {
                if (op === '=')
                    return { q: { id: v }, exact: true };
                if (op === '!=')
                    return { q: { id: { $ne: String(v) } }, exact: true };
                return typeof v === 'number' ? { q: { id: { [mongoOp(op)]: v } }, exact: true } : null;
            }
            if (op === '=') {
                const vs = exact ? [v] : variants(v);
                return { q: vs.length === 1 ? { [f.key]: vs[0] } : { [f.key]: { $in: vs } }, exact };
            }
            if (op === '!=')
                return { q: { [f.key]: { $nin: [...(exact ? [v] : variants(v)), null] } }, exact };
            if (typeof v === 'boolean')
                return null;
            const base = { [f.key]: { [mongoOp(op)]: v } };
            if (exact)
                return { q: base, exact: true };
            if (f.declared && SCALAR_TYPES.has(f.declared))
                return null; // e.g. string column vs number: not translatable
            // Unknown type (NoSQL): SQL also compares numeric strings / booleans numerically → keep those candidates.
            if (typeof v === 'number')
                return { q: { $or: [base, { [f.key]: { $type: 'string' } }, { [f.key]: { $type: 'boolean' } }] }, exact: false };
            if ((0, functions_1.canonicalNumber)(v) !== null)
                return { q: { $or: [base, { [f.key]: { $type: 'number' } }] }, exact: false };
            return { q: base, exact: false };
        }
        case 'between': {
            if (e.not)
                return null;
            const lo = toEngineQuery({ k: 'bin', op: '>=', l: e.e, r: e.lo }, alias, src, scope, constOf);
            const hi = toEngineQuery({ k: 'bin', op: '<=', l: e.e, r: e.hi }, alias, src, scope, constOf);
            if (!lo || !hi)
                return lo || hi ? { q: (lo ?? hi).q, exact: false } : null;
            return { q: { $and: [lo.q, hi.q] }, exact: lo.exact && hi.exact };
        }
        case 'in': {
            const f = field(e.e);
            if (!f)
                return null;
            let values;
            if (e.sub) {
                const c = constOf(e);
                if (!c.ok)
                    return null;
                values = c.v;
            }
            else {
                const cs = e.list.map(constOf);
                if (cs.some((c) => !c.ok))
                    return null;
                values = cs.map((c) => c.v);
            }
            if (values.length > 10_000)
                return null;
            const nonNull = values.filter((v) => !(0, functions_1.isNull)(v) && typeof v !== 'object').map((v) => typedValue(f.declared, v));
            if (f.declared === 'id') {
                const ids = nonNull.map(String);
                return e.not ? { q: { id: { $nin: ids } }, exact: !values.some(functions_1.isNull) } : { q: { id: { $in: ids } }, exact: true };
            }
            const exact = nonNull.every((v) => naturalFor(f.declared, v)) && nonNull.length === values.length;
            const vs = exact ? nonNull : nonNull.flatMap(variants);
            if (e.not)
                return { q: { [f.key]: { $nin: [...vs, null] } }, exact: exact && !values.some(functions_1.isNull) };
            return { q: { [f.key]: { $in: vs } }, exact };
        }
        case 'is': {
            const f = field(e.e);
            if (!f || e.what !== 'null')
                return null;
            return { q: e.not ? { [f.key]: { $ne: null } } : { [f.key]: null }, exact: f.declared !== undefined };
        }
        case 'like': {
            const f = field(e.e);
            const c = constOf(e.pat);
            if (!f || !c.ok || typeof c.v !== 'string' || e.esc)
                return null;
            const stringCol = f.declared === 'string' || f.declared === 'date';
            if (!stringCol && f.declared)
                return null;
            if (e.regexp) {
                try {
                    (0, security_middleware_1.validateRegexPattern)(c.v);
                }
                catch {
                    return null;
                }
            }
            const cond = e.regexp ? { $regex: c.v, $options: 'i' } : { $like: c.v };
            if (e.not)
                return { q: { [f.key]: { $not: cond } }, exact: false };
            return { q: { [f.key]: cond }, exact: stringCol };
        }
        case 'un': {
            if (e.op !== 'NOT')
                return null;
            const inner = toEngineQuery(e.e, alias, src, scope, constOf);
            if (!inner || !inner.exact)
                return null;
            return { q: { $nor: [inner.q] }, exact: false };
        }
    }
    return null;
}
function mongoOp(op) {
    return op === '<' ? '$lt' : op === '<=' ? '$lte' : op === '>' ? '$gt' : '$gte';
}
function constValue(e, cc) {
    if (!e)
        return undefined;
    const scope = new Scope([], null, cc.cat);
    const c = compileExpr(e, scope, cc);
    const env = rootEnv(cc.cat.ctx);
    const v = (0, functions_1.toNum)(c({}, env));
    if (v === null || v < 0 || !Number.isInteger(v))
        throw new Error('LIMIT/OFFSET must be a non-negative whole number');
    return v;
}
function rootEnv(ctx) {
    const now = new Date();
    return {
        ctx, params: ctx.params, outer: [], now, fn: { now, database: ctx.db },
        sqCache: new Map(), ctes: new Map(), working: new Map(),
    };
}
function compileQuery(q, parent, cc) {
    switch (q.k) {
        case 'with': return compileWith(q, parent, cc);
        case 'setop': return compileSetOp(q, parent, { ...cc, top: false });
        case 'select': return compileSelect(q, parent, cc);
    }
}
function compileWith(q, parent, cc) {
    const ctes = new Map(cc.ctes);
    const inner = { cat: cc.cat, ctes, top: false };
    for (const c of q.ctes) {
        const def = { name: c.name, cols: c.cols, columns: [] };
        const selfRef = collectTables(c.q).has(c.name);
        if (q.recursive && selfRef) {
            if (c.q.k !== 'setop' || c.q.op !== 'union')
                throw new Error(`Recursive CTE '${c.name}' must be: anchor UNION [ALL] recursive part`);
            const anchor = compileQuery(c.q.l, null, inner);
            def.columns = c.cols ?? anchor.columns;
            if (def.columns.length !== anchor.columns.length)
                throw new Error(`CTE '${c.name}' lists ${def.columns.length} columns but its query returns ${anchor.columns.length}`);
            ctes.set(c.name, def);
            const step = compileQuery(c.q.r, null, inner);
            if (step.columns.length !== def.columns.length)
                throw new Error(`The recursive part of '${c.name}' must return ${def.columns.length} columns`);
            def.recursive = { anchor, step, all: c.q.all };
        }
        else {
            // Not recursive: a reference to its own name means a real table of that name.
            def.plan = compileQuery(c.q, null, inner);
            def.columns = c.cols ?? def.plan.columns;
            if (def.columns.length !== def.plan.columns.length)
                throw new Error(`CTE '${c.name}' lists ${def.columns.length} columns but its query returns ${def.plan.columns.length}`);
            ctes.set(c.name, def);
        }
    }
    const body = compileQuery(q.body, parent, { ...inner, top: cc.top });
    return {
        columns: body.columns,
        correlated: body.correlated,
        run: (env) => body.run(env),
        explain: () => [
            ...q.ctes.map((c) => ({ step: 'cte', detail: `${c.name}${q.recursive && collectTables(c.q).has(c.name) ? ' (recursive)' : ''}` })),
            ...body.explain(),
        ],
    };
}
async function materializeCte(def, env) {
    const working = env.working.get(def);
    if (working)
        return working;
    let p = env.ctes.get(def);
    if (!p) {
        p = (async () => {
            if (def.plan) {
                const rel = await def.plan.run({ ...env, outer: [], sqCache: new Map() });
                return { columns: def.columns, rows: rel.rows };
            }
            const { anchor, step, all } = def.recursive;
            const base = await anchor.run({ ...env, outer: [], sqCache: new Map() });
            const out = [];
            const seen = new Set();
            const add = (rows) => {
                const fresh = [];
                for (const r of rows) {
                    if (!all) {
                        const k = r.map(functions_1.valueKey).join('\u0001');
                        if (seen.has(k))
                            continue;
                        seen.add(k);
                    }
                    fresh.push(r);
                    out.push(r);
                }
                if (out.length > env.ctx.maxRows)
                    throw new Error(`Recursive CTE '${def.name}' produced more than ${env.ctx.maxRows} rows`);
                return fresh;
            };
            let frontier = add(base.rows);
            for (let i = 0; frontier.length > 0; i++) {
                if (i >= MAX_RECURSION)
                    throw new Error(`Recursive CTE '${def.name}' did not finish after ${MAX_RECURSION} iterations`);
                const stepEnv = { ...env, outer: [], sqCache: new Map(), working: new Map(env.working) };
                stepEnv.working.set(def, { columns: def.columns, rows: frontier });
                const next = await step.run(stepEnv);
                frontier = add(next.rows);
            }
            return { columns: def.columns, rows: out };
        })();
        env.ctes.set(def, p);
    }
    return p;
}
function compileSetOp(q, parent, cc) {
    const l = compileQuery(q.l, parent, cc), r = compileQuery(q.r, parent, cc);
    if (l.columns.length !== r.columns.length) {
        throw new Error(`${q.op.toUpperCase()}: both sides must return the same number of columns (${l.columns.length} vs ${r.columns.length})`);
    }
    const columns = l.columns;
    // ORDER BY over the combined result: output names, positions or expressions on them.
    const src = { alias: '__set', columns: new Set(columns), known: true, types: {}, required: new Set() };
    const scope = new Scope([src], parent, cc.cat);
    const order = q.orderBy.map((o) => orderKey(o, columns, (e) => compileExpr(e, scope, cc)));
    const limit = constValue(q.limit, cc), offset = constValue(q.offset, cc) ?? 0;
    return {
        columns,
        correlated: l.correlated || r.correlated,
        explain: () => [...l.explain(), { step: q.op + (q.all ? ' all' : ''), detail: '' }, ...r.explain()],
        async run(env) {
            const [a, b] = [await l.run(env), await r.run(env)];
            const key = (row) => row.map(functions_1.valueKey).join('\u0001');
            let rows;
            if (q.op === 'union') {
                if (q.all)
                    rows = [...a.rows, ...b.rows];
                else {
                    const seen = new Set();
                    rows = [];
                    for (const row of [...a.rows, ...b.rows]) {
                        const k = key(row);
                        if (!seen.has(k)) {
                            seen.add(k);
                            rows.push(row);
                        }
                    }
                }
            }
            else {
                const counts = new Map();
                for (const row of b.rows)
                    counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
                const seen = new Set();
                rows = [];
                for (const row of a.rows) {
                    const k = key(row);
                    const n = counts.get(k) ?? 0;
                    const inRight = n > 0;
                    if (q.op === 'intersect' ? !inRight : inRight) {
                        if (q.op === 'except' && q.all)
                            counts.set(k, n - 1);
                        continue;
                    }
                    if (q.op === 'intersect' && q.all)
                        counts.set(k, n - 1);
                    if (!q.all) {
                        if (seen.has(k))
                            continue;
                        seen.add(k);
                    }
                    rows.push(row);
                }
            }
            if (order.length) {
                const keyed = rows.map((row) => {
                    const obj = { __set: Object.fromEntries(columns.map((c, i) => [c, row[i]])) };
                    obj[OUT] = row;
                    return { row, keys: order.map((o) => o.get(obj, env)) };
                });
                keyed.sort((x, y) => (0, agg_state_1.compareKeys)(x.keys, y.keys, order));
                rows = keyed.map((k) => k.row);
            }
            const total = rows.length;
            rows = rows.slice(offset, limit === undefined ? undefined : offset + limit);
            const idColumns = (a.idColumns ?? []).filter((i) => (b.idColumns ?? []).includes(i));
            return { columns, rows, total, idColumns };
        },
    };
}
/** ORDER BY item → key getter (position, output name, or expression). */
function orderKey(o, outCols, compile, outputFirst = true) {
    if (o.e.k === 'lit' && typeof o.e.v === 'number') {
        const i = o.e.v - 1;
        if (!Number.isInteger(o.e.v) || i < 0 || i >= outCols.length)
            throw new Error(`ORDER BY position ${o.e.v} is out of range`);
        return { get: (r) => r[OUT][i], desc: o.desc, nulls: o.nulls };
    }
    if (outputFirst && o.e.k === 'ref' && o.e.parts.length === 1) {
        const i = outCols.indexOf(o.e.parts[0]);
        if (i >= 0)
            return { get: (r) => r[OUT][i], desc: o.desc, nulls: o.nulls };
    }
    return { get: compile(o.e), desc: o.desc, nulls: o.nulls };
}
function buildFrom(item, parent, cc, sources, nullable, joinsOut) {
    if (item.k === 'table') {
        const cte = cc.ctes.get(item.name);
        if (cte) {
            const src = { alias: item.alias, columns: new Set(cte.columns), known: true, types: {}, required: new Set() };
            sources.push(src);
            return {
                aliases: [item.alias],
                explain: () => [{ step: 'scan', detail: `CTE ${item.name}${item.alias !== item.name ? ` AS ${item.alias}` : ''}` }],
                async run(env) {
                    const rel = await materializeCte(cte, env);
                    return rel.rows.map((r) => ({ [item.alias]: Object.fromEntries(cte.columns.map((c, i) => [c, r[i]])) }));
                },
            };
        }
        const info = cc.cat.tables.get(item.name);
        if (!info)
            throw new Error(`Table '${item.name}' doesn't exist in '${cc.cat.ctx.db}'`);
        const src = {
            alias: item.alias, columns: new Set(info.columns), known: info.known, types: info.types, required: info.required, table: item.name,
        };
        sources.push(src);
        const describe = (p) => {
            const q = p ? buildQuery(p, item.alias, src) : { q: {}, exact: true };
            return { q: q.q, exact: q.exact };
        };
        return {
            aliases: [item.alias],
            explain: (push) => {
                const p = push.get(item.alias);
                const d = describe(p);
                return [{
                        step: 'scan',
                        detail: `${item.name}${item.alias !== item.name ? ` AS ${item.alias}` : ''}`,
                        filter: Object.keys(d.q).length ? d.q : null,
                        exact: d.exact,
                        ...(p?.sort ? { sort: p.sort } : {}),
                        ...(p?.limit !== undefined ? { limit: p.limit, skip: p.skip ?? 0 } : {}),
                        ...(p?.countOnly ? { countOnly: true } : {}),
                    }];
            },
            async run(env, push) {
                const p = push.get(item.alias);
                const { q } = describe(p);
                const query = p?.joinIn ? (Object.keys(q).length ? { $and: [q, { [p.joinIn.key]: { $in: p.joinIn.values } }] } : { [p.joinIn.key]: { $in: p.joinIn.values } }) : q;
                const { docs, total } = await env.ctx.ds.scan(item.name, query, { sort: p?.sort, skip: p?.skip, limit: p?.limit, countOnly: p?.countOnly });
                if (p?.countOnly) {
                    const out = [];
                    out.total = total;
                    return out;
                }
                const rows = docs.map((d) => { delete d._metadata; return { [item.alias]: d }; });
                rows.total = total;
                return rows;
            },
        };
    }
    if (item.k === 'sub') {
        const plan = compileQuery(item.q, null, cc);
        const cols = item.cols ?? plan.columns;
        if (cols.length !== plan.columns.length)
            throw new Error(`Derived table '${item.alias}' lists ${cols.length} columns but returns ${plan.columns.length}`);
        sources.push({ alias: item.alias, columns: new Set(cols), known: true, types: {}, required: new Set() });
        return {
            aliases: [item.alias],
            explain: () => [{ step: 'subquery', detail: `AS ${item.alias}` }, ...plan.explain()],
            async run(env) {
                const rel = await plan.run({ ...env, outer: [], sqCache: new Map() });
                return rel.rows.map((r) => ({ [item.alias]: Object.fromEntries(cols.map((c, i) => [c, r[i]])) }));
            },
        };
    }
    // join
    const l = buildFrom(item.l, parent, cc, sources, nullable, joinsOut);
    const r = buildFrom(item.r, parent, cc, sources, nullable, joinsOut);
    if (item.type === 'left' || item.type === 'full')
        r.aliases.forEach((a) => nullable.add(a));
    if (item.type === 'right' || item.type === 'full')
        l.aliases.forEach((a) => nullable.add(a));
    const info = { item, l, r, on: item.on };
    if (item.using) {
        // USING (c): left.c = right.c for each column; the left side owns the name.
        const scopeAll = new Scope(sources, parent, cc.cat);
        const leftScope = new Scope(sources.filter((s) => l.aliases.includes(s.alias)), null, cc.cat);
        const conds = item.using.map((c) => {
            const lr = resolveIn(leftScope, [c]);
            if (!lr)
                throw new Error(`USING column '${c}' is not in the left side of the join`);
            const rightAlias = r.aliases.find((a) => sources.find((s) => s.alias === a)?.columns.has(c)) ?? (r.aliases.length === 1 ? r.aliases[0] : null);
            if (!rightAlias)
                throw new Error(`USING column '${c}' is not in the right side of the join`);
            return { k: 'bin', op: '=', l: { k: 'ref', parts: [lr.alias, c] }, r: { k: 'ref', parts: [rightAlias, c] } };
        });
        void scopeAll;
        info.on = conds.reduce((acc, c) => (acc ? { k: 'bin', op: 'AND', l: acc, r: c } : c), undefined);
    }
    joinsOut.push(info);
    return {
        aliases: [...l.aliases, ...r.aliases],
        explain: (push) => [...l.explain(push), ...r.explain(push), { step: 'join', detail: `${item.type.toUpperCase()}${info.equi?.length ? ` hash join on ${info.equi.length} key(s)` : ' nested loop'}` }],
        run: (env, push) => runJoin(info, env, push),
    };
}
function buildQuery(p, alias, src) {
    const parts = [];
    let exact = true;
    for (const c of p.conjuncts) {
        const t = toEngineQuery(c, alias, src, p.scope, p.constOf);
        if (!t) {
            exact = false;
            continue;
        }
        if (!t.exact)
            exact = false;
        if (Object.keys(t.q).length)
            parts.push(t.q);
    }
    return { q: parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts }, exact };
}
async function runJoin(j, env, push) {
    if (j.onSubs?.length)
        await prepareSubs(j.onSubs.filter((s) => !s.correlated), [], env);
    const left = await j.l.run(env, push);
    // Selective joins: fetch only the right rows whose key appears on the left (index-assisted).
    let rightPush = push;
    const type = j.item.type;
    if (j.equi?.length === 1 && j.equi[0].rightField && (type === 'inner' || type === 'left')) {
        const keys = new Map();
        for (const row of left) {
            const v = j.equi[0].left(row, env);
            if (!(0, functions_1.isNull)(v) && typeof v !== 'object')
                keys.set((0, functions_1.valueKey)(v), v);
            if (keys.size > IN_PUSHDOWN_MAX)
                break;
        }
        if (keys.size <= IN_PUSHDOWN_MAX) {
            const values = [];
            for (const v of keys.values()) {
                values.push(v);
                if (typeof v === 'number')
                    values.push(String(v));
                else if (typeof v === 'string') {
                    const n = (0, functions_1.canonicalNumber)(v);
                    if (n !== null)
                        values.push(n);
                }
            }
            const alias = j.equi[0].rightAlias;
            const base = push.get(alias);
            rightPush = new Map(push);
            rightPush.set(alias, { ...(base ?? { conjuncts: [], scope: null, constOf: () => ({ ok: false }) }), joinIn: { key: j.equi[0].rightField, values }, limit: undefined, skip: undefined, sort: undefined });
            if (values.length === 0 && type === 'inner')
                return [];
        }
    }
    const right = await j.r.run(env, rightPush);
    const out = [];
    const nullRow = (aliases) => Object.fromEntries(aliases.map((a) => [a, null]));
    const check = (row) => {
        if (!j.residual)
            return true;
        return (0, functions_1.truth)(j.residual(row, env)) === true;
    };
    const guard = () => {
        if (out.length > MAX_JOIN_ROWS)
            throw new Error(`JOIN produced more than ${MAX_JOIN_ROWS.toLocaleString()} rows — add a WHERE or ON condition`);
    };
    const rightMatched = type === 'right' || type === 'full' ? new Uint8Array(right.length) : null;
    if (j.equi?.length) {
        const index = new Map();
        right.forEach((row, i) => {
            const ks = j.equi.map((k) => k.right(row, env));
            if (ks.some((k) => (0, functions_1.isNull)(k)))
                return;
            const key = ks.map(functions_1.valueKey).join('\u0001');
            let list = index.get(key);
            if (!list)
                index.set(key, (list = []));
            list.push(i);
        });
        for (const lrow of left) {
            const ks = j.equi.map((k) => k.left(lrow, env));
            const matches = ks.some((k) => (0, functions_1.isNull)(k)) ? undefined : index.get(ks.map(functions_1.valueKey).join('\u0001'));
            let any = false;
            if (matches) {
                for (const i of matches) {
                    const combined = { ...lrow, ...right[i] };
                    if (!check(combined))
                        continue;
                    any = true;
                    if (rightMatched)
                        rightMatched[i] = 1;
                    out.push(combined);
                }
            }
            if (!any && (type === 'left' || type === 'full'))
                out.push({ ...lrow, ...nullRow(j.r.aliases) });
            guard();
        }
    }
    else {
        for (const lrow of left) {
            let any = false;
            for (let i = 0; i < right.length; i++) {
                const combined = { ...lrow, ...right[i] };
                if (type !== 'cross' && !check(combined))
                    continue;
                any = true;
                if (rightMatched)
                    rightMatched[i] = 1;
                out.push(combined);
                if ((out.length & 0xfff) === 0)
                    guard();
            }
            if (!any && (type === 'left' || type === 'full'))
                out.push({ ...lrow, ...nullRow(j.r.aliases) });
            guard();
        }
    }
    if (rightMatched) {
        right.forEach((row, i) => { if (!rightMatched[i])
            out.push({ ...nullRow(j.l.aliases), ...row }); });
    }
    return out;
}
function compileSelect(sel, parent, outerCc) {
    const top = Boolean(outerCc.top);
    const cc = { ...outerCc, top: false };
    const sources = [];
    const nullable = new Set();
    const joins = [];
    const from = sel.from ? buildFrom(sel.from, parent, cc, sources, nullable, joins) : null;
    const seenAlias = new Set();
    for (const s of sources) {
        if (seenAlias.has(s.alias))
            throw new Error(`Table alias '${s.alias}' is used twice`);
        seenAlias.add(s.alias);
    }
    const scope = new Scope(sources, parent, cc.cat);
    scope.namedWindows = sel.windows;
    // JOIN conditions: equi-keys for hash joins + residual.
    for (const j of joins) {
        if (!j.on)
            continue;
        const onScope = scope.derive();
        onScope.subs = [];
        const leftSet = new Set(j.l.aliases), rightSet = new Set(j.r.aliases);
        const equi = [];
        const rest = [];
        for (const c of splitAnd(j.on)) {
            if (c.k === 'bin' && c.op === '=' && !hasSubquery(c)) {
                const la = aliasesOf(c.l, onScope), ra = aliasesOf(c.r, onScope);
                const sub = (a, set) => a !== null && a.size > 0 && Array.from(a).every((x) => set.has(x));
                let lhs = null, rhs = null;
                if (sub(la, leftSet) && sub(ra, rightSet)) {
                    lhs = c.l;
                    rhs = c.r;
                }
                else if (sub(la, rightSet) && sub(ra, leftSet)) {
                    lhs = c.r;
                    rhs = c.l;
                }
                if (lhs && rhs) {
                    let rightField, rightAlias;
                    if (rhs.k === 'ref') {
                        const res = resolveRef(onScope, rhs.parts);
                        const srcInfo = sources.find((s) => s.alias === res.alias);
                        if (res.lvl === 0 && srcInfo?.table) {
                            rightField = [res.col, ...res.path].join('.');
                            rightAlias = res.alias;
                        }
                    }
                    equi.push({ left: compileExpr(lhs, onScope, cc), right: compileExpr(rhs, onScope, cc), rightField, rightAlias });
                    continue;
                }
            }
            rest.push(c);
        }
        j.equi = equi;
        j.residual = rest.length ? compileExpr(rest.reduce((a, b) => ({ k: 'bin', op: 'AND', l: a, r: b })), onScope, cc) : null;
        if (onScope.subs.some((s) => s.correlated))
            throw new Error('Correlated subqueries are not supported in JOIN … ON');
        j.onSubs = onScope.subs;
    }
    // WHERE
    const whereScope = scope.derive();
    whereScope.subs = [];
    if (sel.where && containsAggregate(sel.where))
        throw new Error('Aggregate functions are not allowed in WHERE (use HAVING)');
    const whereFn = sel.where ? compileExpr(sel.where, whereScope, cc) : null;
    const whereSubs = whereScope.subs;
    // Pushdown candidates per table alias (WHERE conjuncts + single-table ON conjuncts of inner/left joins).
    const pushConj = new Map();
    const addPush = (alias, c) => {
        if (!pushConj.has(alias))
            pushConj.set(alias, []);
        pushConj.get(alias).push(c);
    };
    const allWhere = splitAnd(sel.where);
    let residualFree = true;
    for (const c of allWhere) {
        const al = hasCorrelatedOrNonInSub(c) ? null : aliasesOf(c, whereScope);
        if (al && al.size === 1) {
            const [a] = Array.from(al);
            const src = sources.find((s) => s.alias === a);
            if (src?.table && !nullable.has(a)) {
                addPush(a, c);
                continue;
            }
        }
        if (al && al.size === 0 && !hasSubquery(c)) {
            // Constant condition: push to every table (it filters all or nothing).
            for (const s of sources)
                if (s.table && !nullable.has(s.alias))
                    addPush(s.alias, c);
            if (sources.length)
                continue;
        }
        residualFree = false;
    }
    for (const j of joins) {
        if (!j.on || (j.item.type !== 'inner' && j.item.type !== 'left'))
            continue;
        for (const c of splitAnd(j.on)) {
            if (hasSubquery(c))
                continue;
            const al = aliasesOf(c, scope);
            if (!al || al.size !== 1)
                continue;
            const [a] = Array.from(al);
            const src = sources.find((s) => s.alias === a);
            const onRightSide = j.r.aliases.includes(a);
            if (src?.table && (j.item.type === 'inner' ? !nullable.has(a) : onRightSide && j.r.aliases.length === 1))
                addPush(a, c);
        }
    }
    // Grouping.
    const itemsHaveAgg = sel.items.some((it) => !it.star && containsAggregate(it.e));
    const grouped = sel.groupBy.length > 0 || itemsHaveAgg || Boolean(sel.having) || sel.orderBy.some((o) => containsAggregate(o.e));
    const preScope = scope.derive();
    preScope.subs = [];
    // GROUP BY may name a select alias or a position.
    const groupExprs = sel.groupBy.map((g) => {
        if (g.k === 'lit' && typeof g.v === 'number') {
            const it = sel.items[g.v - 1];
            if (!it || it.star)
                throw new Error(`GROUP BY position ${g.v} is out of range`);
            return it.e;
        }
        if (g.k === 'ref' && g.parts.length === 1) {
            let isColumn = true;
            try {
                resolveRef(scope, g.parts);
            }
            catch {
                isColumn = false;
            }
            if (!isColumn) {
                const it = sel.items.find((i) => !i.star && i.alias === g.parts[0]);
                if (it && !it.star)
                    return it.e;
            }
        }
        return g;
    });
    for (const g of groupExprs)
        if (containsAggregate(g))
            throw new Error('Aggregate functions are not allowed in GROUP BY');
    const groupFns = groupExprs.map((g) => compileExpr(g, preScope, cc));
    const post = scope.derive();
    post.subs = [];
    post.wins = [];
    if (grouped) {
        post.grouped = new Set(groupExprs.map((g) => exprKey(g, scope)));
        post.aggs = [];
        post.pre = preScope;
    }
    // Select list.
    const outs = [];
    const multi = sources.length > 1;
    for (const it of sel.items) {
        if (it.star) {
            if (grouped)
                throw new Error('SELECT * cannot be combined with GROUP BY or aggregates');
            const srcs = it.table ? sources.filter((s) => s.alias === it.table) : sources;
            if (it.table && srcs.length === 0)
                throw new Error(`Unknown table '${it.table}'`);
            if (!sel.from)
                throw new Error('SELECT * needs a FROM clause');
            for (const s of srcs) {
                const alias = s.alias;
                if (top && !s.known) {
                    outs.push({ name: `${alias}.*`, get: (r) => r[alias] ?? null, isRef: false, expand: { prefix: multi ? `${alias}.` : '', base: Array.from(s.columns) } });
                    continue;
                }
                for (const c of s.columns) {
                    outs.push({ name: multi ? `${alias}.${c}` : c, get: (r) => { const o = r[alias]; if (!o)
                            return null; const v = o[c]; return v === undefined ? null : v; }, isRef: false, isId: c === 'id' && Boolean(s.table) });
                }
            }
            continue;
        }
        const get = compileExpr(it.e, post, cc);
        let name = it.alias;
        let qualified;
        let isId = false;
        const isRef = it.e.k === 'ref';
        if (it.e.k === 'ref') {
            try {
                const r = resolveRef(scope, it.e.parts);
                qualified = [r.alias, r.col, ...r.path].join('.');
                isId = r.lvl === 0 && r.col === 'id' && r.path.length === 0 && Boolean(sources.find((s) => s.alias === r.alias)?.table);
            }
            catch { /* outer reference */ }
            if (!name)
                name = it.e.parts[it.e.parts.length - 1];
        }
        if (!name && it.e.k === 'fn' && it.e.name === 'COUNT' && it.e.star && sel.items.length === 1 && !it.e.filter)
            name = 'count';
        outs.push({ name: name ?? it.text, get, isRef: isRef && !it.alias, qualified, isId });
    }
    // Duplicate plain column names (c.name, p.name) → qualified; then numeric suffixes.
    const counts = new Map();
    for (const o of outs)
        counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
    for (const o of outs)
        if (o.isRef && o.qualified && (counts.get(o.name) ?? 0) > 1)
            o.name = o.qualified;
    const used = new Map();
    for (const o of outs) {
        const n = used.get(o.name) ?? 0;
        used.set(o.name, n + 1);
        if (n > 0)
            o.name = `${o.name}_${n + 1}`;
    }
    const columns = outs.map((o) => o.name);
    // HAVING
    const havingScope = post.derive();
    havingScope.grouped = post.grouped;
    havingScope.aggs = post.aggs;
    havingScope.pre = post.pre;
    havingScope.subs = [];
    // HAVING may use select aliases (MySQL).
    havingScope.outputAliases = new Map(columns.map((c, i) => [c, i]));
    const havingFn = sel.having ? compileExpr(sel.having, havingScope, cc) : null;
    if (sel.having && !grouped)
        throw new Error('HAVING needs GROUP BY or an aggregate');
    // ORDER BY
    const orderScope = post.derive();
    orderScope.grouped = post.grouped;
    orderScope.aggs = post.aggs;
    orderScope.pre = post.pre;
    orderScope.wins = post.wins;
    orderScope.subs = [];
    orderScope.outputAliases = new Map(columns.map((c, i) => [c, i]));
    const order = sel.orderBy.map((o) => orderKey(o, columns, (e) => compileExpr(e, orderScope, cc)));
    const limit = constValue(sel.limit, cc);
    const offset = constValue(sel.offset, cc) ?? 0;
    const hasWindows = post.wins.length > 0;
    const aggs = post.aggs ?? [];
    // Correlated: something in this query (or below) reads a column of an enclosing query.
    const isCorrelated = parent !== null && scope.minOuter <= parent.depth;
    // Single-table fast paths (pushed sort / limit / count).
    const single = sources.length === 1 && sources[0].table && joins.length === 0 ? sources[0] : null;
    const simple = single && !grouped && !sel.distinct && !hasWindows && residualFree && whereSubs.every((s) => !s.correlated);
    const onlyItem = sel.items.length === 1 && !sel.items[0].star ? sel.items[0].e : null;
    const countStarOnly = single && grouped && sel.groupBy.length === 0 && !sel.having && !sel.distinct && !hasWindows && residualFree
        && aggs.length === 1 && aggs[0].star && !aggs[0].filter && sel.orderBy.length === 0
        && onlyItem?.k === 'fn' && onlyItem.name === 'COUNT' && Boolean(onlyItem.star) && !onlyItem.over;
    const constOf = (env) => (e) => {
        if (e.k === 'lit')
            return { ok: true, v: e.v };
        if (e.k === 'param')
            return env || cc.cat.ctx.params.length > e.i ? { ok: true, v: (env?.params ?? cc.cat.ctx.params)[e.i] ?? null } : { ok: false };
        if (e.k === 'un' && e.op === '-' && e.e.k === 'lit' && typeof e.e.v === 'number')
            return { ok: true, v: -e.e.v };
        if (e.k === 'in' && e.sub && env) {
            const def = whereSubs.find((s) => s.plan === e.__plan);
            const v = def && env.sqCache.get(def);
            return v ? { ok: true, v: v.values.concat(v.hasNull ? [null] : []) } : { ok: false };
        }
        return { ok: false };
    };
    // Remember which compiled subquery belongs to which IN node (for pushing IN (SELECT …) as $in).
    attachInPlans(sel.where, whereSubs);
    // GROUP BY on one table with plain columns and mergeable aggregates: can run in the storage layer (parallel).
    const parGroup = (() => {
        if (!single || !grouped || !residualFree || whereSubs.length || preScope.subs.length)
            return null;
        const fieldOf = (e) => {
            if (e.k !== 'ref')
                return null;
            try {
                const r = resolveRef(scope, e.parts);
                return r.lvl === 0 && r.alias === single.alias ? [r.col, ...r.path].join('.') : null;
            }
            catch {
                return null;
            }
        };
        const groups = groupExprs.map(fieldOf);
        if (groups.some((g) => g === null))
            return null;
        const specs = [];
        for (const a of aggs) {
            if (!agg_state_1.MERGEABLE.has(a.name) || a.distinct || a.filter || a.order || a.sep)
                return null;
            if (a.star) {
                specs.push({ name: a.name, field: null });
                continue;
            }
            if (!a.argExprs || a.argExprs.length !== 1)
                return null;
            const f = fieldOf(a.argExprs[0]);
            if (!f)
                return null;
            specs.push({ name: a.name, field: f });
        }
        return { groups: groups, specs };
    })();
    const parallelGroups = async (env, push) => {
        if (!parGroup || !env.ctx.ds.aggregate)
            return null;
        const p = push.get(single.alias) ?? { conjuncts: [], scope: whereScope, constOf: constOf(env) };
        const { q, exact } = buildQuery(p, single.alias, single);
        // Not exactly translatable: the workers evaluate the SQL WHERE themselves.
        const where = exact || !sel.where ? undefined : {
            expr: sel.where, alias: single.alias, columns: Array.from(single.columns), known: single.known,
            types: single.types, required: Array.from(single.required), params: env.params,
        };
        const res = await env.ctx.ds.aggregate(single.table, q, parGroup.groups, parGroup.specs, where);
        if (!res)
            return null;
        return res.map((g) => {
            const doc = {};
            parGroup.groups.forEach((f, i) => setPath(doc, f, g.key[i]));
            const row = { [single.alias]: doc };
            row[AGG] = g.values;
            return row;
        });
    };
    const pushFor = (env) => {
        const m = new Map();
        for (const [alias, conj] of pushConj)
            m.set(alias, { conjuncts: conj, scope: whereScope, constOf: constOf(env) });
        if (single) {
            const p = m.get(single.alias) ?? { conjuncts: [], scope: whereScope, constOf: constOf(env) };
            const exact = buildQuery(p, single.alias, single).exact;
            if (exact && countStarOnly)
                p.countOnly = true;
            if (exact && simple) {
                const sortable = order.length === 0 || (order.length === 1 && sel.orderBy[0].e.k === 'ref' && pushableSort(sel.orderBy[0], single, scope));
                if (sortable) {
                    if (order.length === 1) {
                        const ref = sel.orderBy[0].e;
                        const r = resolveRef(scope, ref.parts);
                        p.sort = { field: [r.col, ...r.path].join('.'), order: sel.orderBy[0].desc ? 'desc' : 'asc' };
                    }
                    if (limit !== undefined || offset) {
                        p.skip = offset;
                        p.limit = limit ?? env?.ctx.maxRows ?? cc.cat.ctx.maxRows;
                    }
                }
            }
            m.set(single.alias, p);
        }
        return m;
    };
    const plan = {
        columns,
        correlated: isCorrelated,
        explain() {
            const push = pushFor(null);
            const steps = from ? from.explain(push) : [{ step: 'values', detail: 'no FROM' }];
            if (sel.where && !residualFree)
                steps.push({ step: 'filter', detail: 'WHERE (evaluated per row)' });
            if (grouped)
                steps.push({ step: 'group', detail: sel.groupBy.length ? `${sel.groupBy.length} key(s), ${aggs.length} aggregate(s)` : `${aggs.length} aggregate(s)` });
            if (havingFn)
                steps.push({ step: 'filter', detail: 'HAVING' });
            if (hasWindows)
                steps.push({ step: 'window', detail: `${post.wins.length} window function(s)` });
            if (sel.distinct)
                steps.push({ step: 'distinct', detail: '' });
            const pushedSort = single && push.get(single.alias)?.sort;
            if (order.length && !pushedSort)
                steps.push({ step: 'sort', detail: `${order.length} key(s)` });
            if ((limit !== undefined || offset) && !(single && push.get(single.alias)?.limit !== undefined))
                steps.push({ step: 'limit', detail: `${limit ?? 'all'} offset ${offset}` });
            return steps;
        },
        async run(env) {
            // 1. Uncorrelated WHERE subqueries first (IN (SELECT …) becomes an index lookup).
            await prepareSubs(whereSubs.filter((s) => !s.correlated), [], env);
            const push = pushFor(env);
            const sp = single ? push.get(single.alias) : undefined;
            let pushedTotal;
            // 2–3. Scan + WHERE + GROUP BY — or all three at once in the storage layer.
            let rows = await parallelGroups(env, push);
            if (!rows) {
                rows = from ? await from.run(env, push) : [{}];
                pushedTotal = rows.total;
                if (sp?.countOnly)
                    return { columns, rows: [[pushedTotal ?? 0]], total: 1 };
                // WHERE is re-checked: the pushed filter is a superset.
                if (whereFn) {
                    await prepareSubs(whereSubs.filter((s) => s.correlated), rows, env);
                    rows = rows.filter((r) => (0, functions_1.truth)(whereFn(r, env)) === true);
                }
                if (grouped) {
                    await prepareSubs(preScope.subs, rows, env);
                    rows = groupRows(rows, groupFns, aggs, env, sel.groupBy.length === 0);
                }
            }
            if (grouped) {
                if (havingFn) {
                    // HAVING can use output aliases: compute the projection first. Window
                    // functions run after HAVING, so their columns are still empty here.
                    await prepareSubs(post.subs, rows, env);
                    for (const r of rows) {
                        if (hasWindows)
                            r[WIN] = [];
                        r[OUT] = outs.map((o) => o.get(r, env));
                    }
                    await prepareSubs(havingScope.subs, rows, env);
                    rows = rows.filter((r) => (0, functions_1.truth)(havingFn(r, env)) === true);
                    if (hasWindows)
                        for (const r of rows)
                            r[OUT] = undefined; // recomputed with the window values
                }
            }
            // 4. Window functions.
            if (hasWindows)
                computeWindows(rows, post.wins, env);
            // 5. Projection + ORDER BY + DISTINCT + LIMIT.
            await prepareSubs(post.subs, rows, env);
            for (const r of rows)
                if (!r[OUT])
                    r[OUT] = outs.map((o) => o.get(r, env));
            if (order.length && !sp?.sort) {
                await prepareSubs(orderScope.subs, rows, env);
                const keyed = rows.map((r) => ({ r, k: order.map((o) => o.get(r, env)) }));
                keyed.sort((a, b) => (0, agg_state_1.compareKeys)(a.k, b.k, order));
                rows = keyed.map((x) => x.r);
            }
            let out = rows.map((r) => r[OUT]);
            if (sel.distinct) {
                const seen = new Set();
                out = out.filter((row) => { const k = row.map(functions_1.valueKey).join('\u0001'); if (seen.has(k))
                    return false; seen.add(k); return true; });
            }
            let total = out.length;
            if (sp?.limit !== undefined)
                total = pushedTotal ?? out.length;
            else if (limit !== undefined || offset)
                out = out.slice(offset, limit === undefined ? undefined : offset + limit);
            return expandDynamic(outs, columns, out, total);
        },
    };
    return plan;
}
/** Expands NoSQL `*` columns into every field present in the returned documents. */
function expandDynamic(outs, columns, rows, total) {
    if (!outs.some((o) => o.expand)) {
        return { columns, rows, total, idColumns: outs.flatMap((o, i) => (o.isId ? [i] : [])) };
    }
    const layout = [];
    const finalCols = [];
    const idColumns = [];
    outs.forEach((o, idx) => {
        if (!o.expand) {
            if (o.isId)
                idColumns.push(finalCols.length);
            layout.push({ idx });
            finalCols.push(o.name);
            return;
        }
        const keys = new Set(o.expand.base);
        for (const r of rows) {
            const d = r[idx];
            if (d && typeof d === 'object')
                for (const k of Object.keys(d))
                    if (k !== '_metadata')
                        keys.add(k);
        }
        const list = Array.from(keys);
        layout.push({ idx, keys: list });
        for (const k of list) {
            if (k === 'id')
                idColumns.push(finalCols.length);
            finalCols.push(o.expand.prefix + k);
        }
    });
    const out = rows.map((r) => {
        const row = [];
        for (const l of layout) {
            if (!l.keys) {
                row.push(r[l.idx]);
                continue;
            }
            const d = r[l.idx];
            for (const k of l.keys) {
                const v = d && typeof d === 'object' ? d[k] : null;
                row.push(v === undefined ? null : v);
            }
        }
        return row;
    });
    return { columns: finalCols, rows: out, total, idColumns };
}
function setPath(obj, field, value) {
    const parts = field.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object')
            cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}
function pushableSort(o, src, scope) {
    if (o.e.k !== 'ref')
        return false;
    let r;
    try {
        r = resolveRef(scope, o.e.parts);
    }
    catch {
        return false;
    }
    if (r.lvl !== 0 || r.path.length)
        return false;
    const t = r.col === 'id' ? 'id' : src.types[r.col];
    if (!t || !(SCALAR_TYPES.has(t) || t === 'id'))
        return false;
    // The engine puts missing values last in both directions; SQL (MySQL) puts NULL first when ascending.
    const nullsLast = o.nulls ? o.nulls === 'last' : o.desc;
    if (o.nulls === 'first')
        return false;
    return nullsLast || r.col === 'id' || src.required.has(r.col);
}
function hasCorrelatedOrNonInSub(e) {
    // Only `x IN (SELECT …)` (uncorrelated, checked at run time) may be pushed; other subqueries stay residual.
    let bad = false;
    const walk = (x, top) => {
        if (bad || !x || typeof x !== 'object')
            return;
        if (Array.isArray(x)) {
            x.forEach((y) => walk(y, false));
            return;
        }
        if (x.k === 'subq' || x.k === 'exists' || x.k === 'quant') {
            bad = true;
            return;
        }
        if (x.k === 'in' && x.sub) {
            if (!top)
                bad = true;
            walk(x.e, false);
            return;
        }
        for (const v of Object.values(x))
            if (v && typeof v === 'object')
                walk(v, false);
    };
    walk(e, true);
    return bad;
}
/** Links each `IN (subquery)` node to its compiled SubDef so its prepared values can be pushed down. */
function attachInPlans(where, subs) {
    if (!where)
        return;
    let i = 0;
    const ordered = subs;
    const walk = (x) => {
        if (!x || typeof x !== 'object')
            return;
        if (Array.isArray(x)) {
            x.forEach(walk);
            return;
        }
        if (x.k === 'subq' || x.k === 'exists' || x.k === 'quant') {
            i++;
            return;
        }
        if (x.k === 'in' && x.sub) {
            walk(x.e);
            const def = ordered[i++];
            if (def)
                Object.defineProperty(x, '__plan', { value: def.plan, enumerable: false, configurable: true });
            return;
        }
        for (const v of Object.values(x))
            if (v && typeof v === 'object')
                walk(v);
    };
    walk(where);
}
// ── aggregates (accumulators live in agg-state.ts) ──
function groupRows(rows, keys, aggs, env, singleGroup) {
    const groups = new Map();
    for (const r of rows) {
        const k = keys.length ? keys.map((f) => (0, functions_1.valueKey)(f(r, env))).join('\u0001') : '';
        let g = groups.get(k);
        if (!g)
            groups.set(k, (g = { sample: r, states: aggs.map(agg_state_1.newAggState) }));
        for (let i = 0; i < aggs.length; i++)
            (0, agg_state_1.addAgg)(g.states[i], aggs[i], r, env);
    }
    if (groups.size === 0 && singleGroup)
        groups.set('', { sample: {}, states: aggs.map(agg_state_1.newAggState) });
    const out = [];
    for (const g of groups.values()) {
        const row = { ...g.sample };
        if (g.sample[SQ])
            row[SQ] = g.sample[SQ];
        row[AGG] = aggs.map((a, i) => (0, agg_state_1.finishAgg)(g.states[i], a, env, g.sample));
        out.push(row);
    }
    return out;
}
// ── window functions ──
function computeWindows(rows, wins, env) {
    for (const r of rows)
        r[WIN] = new Array(wins.length);
    wins.forEach((w, wi) => {
        const parts = new Map();
        for (const r of rows) {
            const k = w.partition.map((p) => (0, functions_1.valueKey)(p(r, env))).join('\u0001');
            let list = parts.get(k);
            if (!list)
                parts.set(k, (list = []));
            list.push(r);
        }
        for (const part of parts.values()) {
            const keys = new Map();
            for (const r of part)
                keys.set(r, w.order.map((o) => o.c(r, env)));
            if (w.order.length)
                part.sort((a, b) => (0, agg_state_1.compareKeys)(keys.get(a), keys.get(b), w.order));
            windowPartition(part, keys, w, wi, env);
        }
    });
}
function windowPartition(part, keys, w, wi, env) {
    const n = part.length;
    const peer = (a, b) => (0, agg_state_1.compareKeys)(keys.get(part[a]), keys.get(part[b]), w.order) === 0;
    // Peer groups (rows with equal ORDER BY keys).
    const peerEnd = new Int32Array(n), peerStart = new Int32Array(n);
    for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && w.order.length && peer(i, j + 1))
            j++;
        if (!w.order.length)
            j = n - 1;
        for (let k = i; k <= j; k++) {
            peerStart[k] = i;
            peerEnd[k] = j;
        }
        i = j + 1;
    }
    const set = (i, v) => { part[i][WIN][wi] = v; };
    const arg = (i, a = 0) => (w.args[a] ? w.args[a](part[i], env) : null);
    switch (w.name) {
        case 'ROW_NUMBER':
            for (let i = 0; i < n; i++)
                set(i, i + 1);
            return;
        case 'RANK':
            for (let i = 0; i < n; i++)
                set(i, peerStart[i] + 1);
            return;
        case 'DENSE_RANK': {
            let rank = 0;
            for (let i = 0; i < n; i++) {
                if (i === 0 || peerStart[i] === i)
                    rank++;
                set(i, rank);
            }
            return;
        }
        case 'PERCENT_RANK':
            for (let i = 0; i < n; i++)
                set(i, n > 1 ? peerStart[i] / (n - 1) : 0);
            return;
        case 'CUME_DIST':
            for (let i = 0; i < n; i++)
                set(i, (peerEnd[i] + 1) / n);
            return;
        case 'NTILE': {
            for (let i = 0; i < n; i++) {
                const buckets = Math.max(1, Math.trunc((0, functions_1.toNum)(arg(i)) ?? 1));
                const size = Math.floor(n / buckets), extra = n % buckets;
                let b = 0, start = 0;
                while (b < buckets) {
                    const len = size + (b < extra ? 1 : 0);
                    if (i < start + len)
                        break;
                    start += len;
                    b++;
                }
                set(i, b + 1);
            }
            return;
        }
        case 'LAG':
        case 'LEAD': {
            for (let i = 0; i < n; i++) {
                const off = w.args[1] ? Math.trunc((0, functions_1.toNum)(arg(i, 1)) ?? 1) : 1;
                const j = w.name === 'LAG' ? i - off : i + off;
                set(i, j >= 0 && j < n ? arg(j) : w.args[2] ? arg(i, 2) : null);
            }
            return;
        }
    }
    // Frame-based functions.
    const frame = w.frame ?? (w.order.length
        ? { unit: 'range', start: { kind: 'unbounded_preceding' }, end: { kind: 'current' } }
        : { unit: 'rows', start: { kind: 'unbounded_preceding' }, end: { kind: 'unbounded_following' } });
    if (frame.unit === 'range' && (frame.start.kind === 'preceding' || frame.start.kind === 'following' || frame.end.kind === 'preceding' || frame.end.kind === 'following')) {
        throw new Error('RANGE frames with offsets are not supported; use ROWS BETWEEN …');
    }
    const bound = (i, b, isStart) => {
        switch (b.kind) {
            case 'unbounded_preceding': return 0;
            case 'unbounded_following': return n - 1;
            case 'current': return frame.unit === 'range' ? (isStart ? peerStart[i] : peerEnd[i]) : i;
            case 'preceding': return i - b.n;
            case 'following': return i + b.n;
        }
    };
    if (w.name === 'FIRST_VALUE' || w.name === 'LAST_VALUE' || w.name === 'NTH_VALUE') {
        for (let i = 0; i < n; i++) {
            const s = Math.max(0, bound(i, frame.start, true)), e = Math.min(n - 1, bound(i, frame.end, false));
            if (s > e) {
                set(i, null);
                continue;
            }
            if (w.name === 'FIRST_VALUE')
                set(i, arg(s));
            else if (w.name === 'LAST_VALUE')
                set(i, arg(e));
            else {
                const k = Math.trunc((0, functions_1.toNum)(arg(i, 1)) ?? 1);
                set(i, k >= 1 && s + k - 1 <= e ? arg(s + k - 1) : null);
            }
        }
        return;
    }
    if (!(0, parser_1.isAggregateName)(w.name))
        throw new Error(`${w.name} is not a window function`);
    const def = { name: w.name, args: w.args, star: w.star, distinct: false };
    if (frame.start.kind === 'unbounded_preceding') {
        // Running accumulation: the frame end only moves forward.
        const st = (0, agg_state_1.newAggState)(def);
        let added = -1;
        for (let i = 0; i < n; i++) {
            const e = Math.min(n - 1, bound(i, frame.end, false));
            while (added < e) {
                added++;
                (0, agg_state_1.addAgg)(st, def, part[added], env);
            }
            set(i, (0, agg_state_1.finishAgg)(st, def, env, part[i]));
        }
        return;
    }
    if (n > 20_000)
        throw new Error('Sliding window frames are limited to 20,000 rows per partition');
    for (let i = 0; i < n; i++) {
        const s = Math.max(0, bound(i, frame.start, true)), e = Math.min(n - 1, bound(i, frame.end, false));
        const st = (0, agg_state_1.newAggState)(def);
        for (let k = s; k <= e; k++)
            (0, agg_state_1.addAgg)(st, def, part[k], env);
        set(i, (0, agg_state_1.finishAgg)(st, def, env, part[i]));
    }
}
async function prepareQuery(q, ctx) {
    const cat = await loadCatalog(ctx, collectTables(q));
    const plan = compileQuery(q, null, { cat, ctes: new Map(), top: true });
    return { plan, run: () => plan.run(rootEnv(ctx)) };
}
async function executeQuery(q, ctx) {
    return (await prepareQuery(q, ctx)).run();
}
/** Builds `SELECT <items> FROM table AS alias WHERE where` (used by UPDATE / DELETE / RETURNING). */
function selectFrom(table, alias, items, where) {
    return { k: 'select', distinct: false, items, from: { k: 'table', name: table, alias }, where, groupBy: [], windows: {}, orderBy: [] };
}
/**
 * Evaluates expressions against given rows (no table access except
 * subqueries). `sources`: alias → table info, `rows`: alias → document.
 */
async function evaluateOnRows(exprs, sources, rows, ctx, opts = {}) {
    const cat = await loadCatalog(ctx, collectTables(exprs));
    const cc = { cat, ctes: new Map() };
    const srcs = sources.map((s) => ({
        alias: s.alias,
        columns: new Set(s.columns ?? s.info?.columns ?? []),
        known: Boolean(s.info?.known) || Boolean(s.columns),
        types: s.info?.types ?? {},
        required: s.info?.required ?? new Set(),
        qualifiedOnly: s.qualifiedOnly,
    }));
    const scope = new Scope(srcs, null, cat);
    scope.subs = [];
    scope.valuesAlias = opts.valuesAlias ?? null;
    const fns = exprs.map((e) => compileExpr(e, scope, cc));
    const env = rootEnv(ctx);
    const rs = rows.map((r) => ({ ...r }));
    await prepareSubs(scope.subs, rs, env);
    return rs.map((r) => fns.map((f) => f(r, env)));
}
/**
 * Compiles a single-table WHERE (no subqueries) into a predicate over SQL
 * rows ({ id, ...fields }). Used by worker threads, which have no catalog.
 */
function compileRowPredicate(spec) {
    const ctx = { ds: null, db: '', params: spec.params, maxRows: 0 };
    const cat = new Catalog(new Map(), ctx);
    const src = { alias: spec.alias, columns: new Set(spec.columns), known: spec.known, types: spec.types, required: new Set(spec.required) };
    const scope = new Scope([src], null, cat);
    scope.subs = [];
    const fn = compileExpr(spec.expr, scope, { cat, ctes: new Map() });
    if (scope.subs.length)
        throw new Error('Subqueries cannot be evaluated by query workers');
    const env = rootEnv(ctx);
    const alias = spec.alias;
    return (row) => (0, functions_1.truth)(fn({ [alias]: row }, env)) === true;
}
/** True when every expression is a literal or parameter (no evaluation needed). */
function constantRow(exprs, params) {
    const out = [];
    for (const e of exprs) {
        if (e.k === 'lit')
            out.push(e.v);
        else if (e.k === 'param') {
            if (e.i >= params.length)
                throw new Error(`Missing value for parameter ${e.i + 1} (got ${params.length})`);
            out.push(params[e.i] ?? null);
        }
        else if (e.k === 'un' && e.op === '-' && e.e.k === 'lit' && typeof e.e.v === 'number')
            out.push(-e.e.v);
        else
            return null;
    }
    return out;
}
//# sourceMappingURL=executor.js.map