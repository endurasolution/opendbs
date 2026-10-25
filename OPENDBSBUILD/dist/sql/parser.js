"use strict";
/**
 * SQL parser for OpenDBS (MySQL / PostgreSQL flavoured).
 *
 * Queries:  [WITH [RECURSIVE] cte AS (…), …]
 *           SELECT [DISTINCT] expr [AS a], t.*, * FROM t [AS a]
 *             [[INNER|LEFT|RIGHT|FULL [OUTER]|CROSS] JOIN … ON expr | USING (c, …)] , t2 …
 *             [WHERE expr] [GROUP BY expr, …] [HAVING expr] [WINDOW w AS (…)]
 *           [UNION [ALL] | INTERSECT [ALL] | EXCEPT [ALL] SELECT …]
 *           [ORDER BY expr [ASC|DESC] [NULLS FIRST|LAST], …]
 *           [LIMIT n [OFFSET m] | LIMIT m, n | OFFSET m ROWS FETCH FIRST n ROWS ONLY]
 * Expressions: arithmetic + - * / % DIV MOD, || (concat), comparisons incl. <=> and
 *           IS [NOT] DISTINCT FROM, AND / OR / NOT, [NOT] IN (list | subquery),
 *           [NOT] BETWEEN, [NOT] LIKE / ILIKE [ESCAPE], REGEXP / RLIKE, IS [NOT] NULL/TRUE/FALSE,
 *           EXISTS (subquery), scalar subqueries, = ANY / ALL (subquery), CASE, CAST(x AS t), x::t,
 *           INTERVAL n unit, functions (see functions.ts), aggregates with DISTINCT / FILTER,
 *           window functions with OVER (PARTITION BY … ORDER BY … ROWS|RANGE …), ? / $1 parameters.
 * Writes:   INSERT [IGNORE] INTO t [(cols)] VALUES (…), … | SELECT …
 *             [ON DUPLICATE KEY UPDATE c = expr, …] [ON CONFLICT [(c)] DO NOTHING | DO UPDATE SET …]
 *             [RETURNING …]
 *           UPDATE t [AS a] SET c = expr, … WHERE expr [RETURNING …]   (WHERE is mandatory)
 *           DELETE FROM t [AS a] WHERE expr [RETURNING …]               (WHERE is mandatory)
 * Schema:   CREATE TABLE [IF NOT EXISTS] t (col TYPE [NOT NULL] [UNIQUE] [DEFAULT v], …) | AS SELECT …
 *           DROP TABLE, TRUNCATE TABLE, ALTER TABLE ADD/DROP/MODIFY/RENAME COLUMN, ADD [UNIQUE] INDEX (…), DROP INDEX
 *           CREATE [UNIQUE] INDEX [name] ON t (c, …) · DROP INDEX name ON t
 * Other:    SHOW TABLES · SHOW INDEXES FROM t · DESCRIBE t · EXPLAIN SELECT … · BEGIN / COMMIT / ROLLBACK
 */
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQLSyntaxError = void 0;
exports.isAggregateName = isAggregateName;
exports.isWindowOnlyName = isWindowOnlyName;
exports.likeToRegex = likeToRegex;
exports.parseSQL = parseSQL;
exports.permissionFor = permissionFor;
exports.parseExpression = parseExpression;
__exportStar(require("./ast"), exports);
class SQLSyntaxError extends Error {
}
exports.SQLSyntaxError = SQLSyntaxError;
const MAX_STATEMENTS = 50;
const MAX_DEPTH = 200;
// ─────────────────────────── tokenizer ───────────────────────────
const OPS = ['<=>', '->>', '<=', '>=', '<>', '!=', '||', '::', '->', '&&', '=', '<', '>', '(', ')', ',', '*', ';', '-', '+', '.', '/', '%'];
function tokenize(sql) {
    const out = [];
    let i = 0;
    let paramSeq = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
            i++;
            continue;
        }
        if (c === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n')
                i++;
            continue;
        }
        if (c === '#') {
            while (i < sql.length && sql[i] !== '\n')
                i++;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
            continue;
        }
        const start = i;
        if (c === "'") {
            let s = '';
            i++;
            for (;;) {
                if (i >= sql.length)
                    throw new SQLSyntaxError(`Unterminated string starting at position ${start + 1}`);
                const ch = sql[i];
                if (ch === '\\' && i + 1 < sql.length) {
                    const n = sql[i + 1];
                    s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n;
                    i += 2;
                    continue;
                }
                if (ch === "'") {
                    if (sql[i + 1] === "'") {
                        s += "'";
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                s += ch;
                i++;
            }
            out.push({ t: 'str', v: s, pos: start, end: i });
            continue;
        }
        if (c === '`' || c === '"') {
            const end = sql.indexOf(c, i + 1);
            if (end === -1)
                throw new SQLSyntaxError(`Unterminated quoted identifier at position ${start + 1}`);
            out.push({ t: 'ident', v: sql.slice(i + 1, end), pos: start, end: end + 1 });
            i = end + 1;
            continue;
        }
        if (c === '?') {
            out.push({ t: 'param', v: String(paramSeq++), pos: start, end: i + 1 });
            i++;
            continue;
        }
        if (c === '$' && /\d/.test(sql[i + 1] ?? '')) {
            const m = /^\$(\d+)/.exec(sql.slice(i));
            const n = Number(m[1]);
            if (n < 1)
                throw new SQLSyntaxError(`Parameters are numbered from $1 (position ${start + 1})`);
            out.push({ t: 'param', v: String(n - 1), pos: start, end: i + m[0].length });
            i += m[0].length;
            continue;
        }
        const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i, i + 64));
        if (num && !(c === '.' && out.length && (out[out.length - 1].t === 'word' || out[out.length - 1].t === 'ident'))) {
            out.push({ t: 'num', v: num[0], pos: start, end: i + num[0].length });
            i += num[0].length;
            continue;
        }
        const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 256));
        if (word) {
            out.push({ t: 'word', v: word[0], pos: start, end: i + word[0].length });
            i += word[0].length;
            continue;
        }
        const op = OPS.find((o) => sql.startsWith(o, i));
        if (op) {
            out.push({ t: 'op', v: op, pos: start, end: i + op.length });
            i += op.length;
            continue;
        }
        throw new SQLSyntaxError(`Unexpected character '${c}' at position ${i + 1}`);
    }
    out.push({ t: 'eof', v: '', pos: sql.length, end: sql.length });
    return out;
}
// Words that can't be bare identifiers or aliases (quote them with `backticks`).
const RESERVED = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'REGEXP', 'RLIKE', 'IS', 'NULL', 'BETWEEN',
    'ORDER', 'BY', 'LIMIT', 'OFFSET', 'FETCH', 'VALUES', 'SET', 'INSERT', 'UPDATE', 'DELETE', 'INTO', 'TRUE', 'FALSE',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING', 'GROUP', 'HAVING', 'AS',
    'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'WITH',
    'WINDOW', 'OVER', 'PARTITION', 'RETURNING', 'ASC', 'DESC', 'DIV', 'MOD', 'ESCAPE', 'ANY', 'SOME',
]);
const AGGREGATES = new Set([
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'ARRAY_AGG', 'JSON_AGG', 'JSON_ARRAYAGG',
    'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'STD', 'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'BOOL_AND', 'BOOL_OR', 'EVERY',
    'BIT_AND', 'BIT_OR', 'ANY_VALUE', 'MEDIAN',
]);
const WINDOW_ONLY = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE']);
function isAggregateName(name) {
    return AGGREGATES.has(name.toUpperCase());
}
function isWindowOnlyName(name) {
    return WINDOW_ONLY.has(name.toUpperCase());
}
/** CAST target → normalized type. */
function normalizeType(word, next) {
    const t = word.toUpperCase();
    if (t === 'SIGNED' || t === 'UNSIGNED') {
        next();
        return 'integer';
    }
    if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8)$/.test(t))
        return 'integer';
    if (/^(DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|FLOAT4|FLOAT8|NUMBER)$/.test(t))
        return 'number';
    if (/^(CHAR|VARCHAR|TEXT|STRING|NCHAR|NVARCHAR)$/.test(t))
        return 'string';
    if (/^(BOOL|BOOLEAN)$/.test(t))
        return 'boolean';
    if (t === 'DATE')
        return 'date';
    if (/^(DATETIME|TIMESTAMP|TIMESTAMPTZ)$/.test(t))
        return 'datetime';
    if (t === 'TIME')
        return 'time';
    if (/^(JSON|JSONB)$/.test(t))
        return 'json';
    throw new SQLSyntaxError(`Unknown type '${word}' in CAST`);
}
// ─────────────────────────── parser ───────────────────────────
class Parser {
    toks;
    src;
    i = 0;
    depth = 0;
    constructor(toks, src) {
        this.toks = toks;
        this.src = src;
    }
    peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
    next() { return this.toks[Math.min(this.i++, this.toks.length - 1)]; }
    atEnd() { return this.peek().t === 'eof' || (this.peek().t === 'op' && this.peek().v === ';'); }
    isWord(w, o = 0) {
        const t = this.peek(o);
        return t.t === 'word' && t.v.toUpperCase() === w;
    }
    isOp(op, o = 0) {
        const t = this.peek(o);
        return t.t === 'op' && t.v === op;
    }
    acceptWord(w) { if (this.isWord(w)) {
        this.i++;
        return true;
    } return false; }
    acceptOp(op) { if (this.isOp(op)) {
        this.i++;
        return true;
    } return false; }
    fail(msg) {
        const t = this.peek();
        throw new SQLSyntaxError(`${msg} near ${t.t === 'eof' ? 'end of statement' : `'${t.v}'`} (position ${t.pos + 1})`);
    }
    expectWord(w) { if (!this.acceptWord(w))
        this.fail(`Expected ${w}`); }
    expectOp(op) { if (!this.acceptOp(op))
        this.fail(`Expected '${op}'`); }
    isIdentTok(t) {
        return t.t === 'ident' || (t.t === 'word' && !RESERVED.has(t.v.toUpperCase()));
    }
    ident(what = 'identifier') {
        const t = this.peek();
        if (this.isIdentTok(t)) {
            this.i++;
            return t.v;
        }
        return this.fail(`Expected ${what}`);
    }
    /** Optional alias: [AS] name. */
    alias() {
        if (this.acceptWord('AS')) {
            const t = this.peek();
            if (t.t === 'ident' || t.t === 'word' || t.t === 'str') {
                this.i++;
                return t.v;
            }
            this.fail('Expected an alias');
        }
        if (this.isIdentTok(this.peek()))
            return this.next().v;
        return undefined;
    }
    enter() {
        if (++this.depth > MAX_DEPTH)
            this.fail('Query is nested too deeply');
    }
    leave() { this.depth--; }
    // ── expressions (Pratt) ──
    expr(minBp = 0) {
        this.enter();
        try {
            let left = this.prefix();
            for (;;) {
                const t = this.peek();
                const u = t.t === 'word' ? t.v.toUpperCase() : '';
                let bp = 0;
                if (u === 'OR')
                    bp = 1;
                else if (u === 'XOR')
                    bp = 1;
                else if (u === 'AND' || (t.t === 'op' && t.v === '&&'))
                    bp = 2;
                else if (t.t === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(t.v))
                    bp = 4;
                else if (['IS', 'LIKE', 'ILIKE', 'REGEXP', 'RLIKE', 'BETWEEN', 'IN'].includes(u))
                    bp = 4;
                else if (u === 'NOT' && ['LIKE', 'ILIKE', 'REGEXP', 'RLIKE', 'BETWEEN', 'IN'].includes(this.peek(1).t === 'word' ? this.peek(1).v.toUpperCase() : ''))
                    bp = 4;
                else if (t.t === 'op' && (t.v === '+' || t.v === '-' || t.v === '||'))
                    bp = 5;
                else if ((t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) || u === 'DIV' || u === 'MOD')
                    bp = 6;
                else if (t.t === 'op' && (t.v === '::' || t.v === '->' || t.v === '->>'))
                    bp = 8;
                if (bp === 0 || bp <= minBp)
                    break;
                left = this.infix(left, bp);
            }
            return left;
        }
        finally {
            this.leave();
        }
    }
    infix(left, bp) {
        const t = this.next();
        const u = t.t === 'word' ? t.v.toUpperCase() : '';
        if (u === 'OR' || u === 'XOR')
            return { k: 'bin', op: u, l: left, r: this.expr(bp) };
        if (u === 'AND' || t.v === '&&')
            return { k: 'bin', op: 'AND', l: left, r: this.expr(bp) };
        if (t.t === 'op' && bp === 4) {
            const op = t.v === '<>' ? '!=' : t.v;
            if ((this.isWord('ANY') || this.isWord('SOME') || this.isWord('ALL')) && this.isOp('(', 1)) {
                const quant = this.next().v.toUpperCase() === 'ALL' ? 'all' : 'any';
                this.expectOp('(');
                const sub = this.query();
                this.expectOp(')');
                return { k: 'quant', op, quant, e: left, sub };
            }
            return { k: 'bin', op, l: left, r: this.expr(bp) };
        }
        if (u === 'IS') {
            const not = this.acceptWord('NOT');
            if (this.acceptWord('NULL'))
                return { k: 'is', e: left, what: 'null', not };
            if (this.acceptWord('TRUE'))
                return { k: 'is', e: left, what: 'true', not };
            if (this.acceptWord('FALSE'))
                return { k: 'is', e: left, what: 'false', not };
            if (this.acceptWord('UNKNOWN'))
                return { k: 'is', e: left, what: 'unknown', not };
            if (this.acceptWord('DISTINCT')) {
                this.expectWord('FROM');
                return { k: 'distinctfrom', l: left, r: this.expr(4), not };
            }
            return this.fail('Expected NULL, TRUE, FALSE or DISTINCT FROM after IS');
        }
        let not = false;
        let w = u;
        if (u === 'NOT') {
            not = true;
            w = this.next().v.toUpperCase();
        }
        if (w === 'LIKE' || w === 'ILIKE' || w === 'REGEXP' || w === 'RLIKE') {
            const pat = this.expr(4);
            let esc;
            if (this.acceptWord('ESCAPE'))
                esc = this.expr(4);
            return { k: 'like', e: left, pat, esc, not, regexp: w === 'REGEXP' || w === 'RLIKE' };
        }
        if (w === 'BETWEEN') {
            this.acceptWord('SYMMETRIC');
            const lo = this.expr(4);
            this.expectWord('AND');
            const hi = this.expr(4);
            return { k: 'between', e: left, lo, hi, not };
        }
        if (w === 'IN') {
            this.expectOp('(');
            if (this.isWord('SELECT') || this.isWord('WITH')) {
                const sub = this.query();
                this.expectOp(')');
                return { k: 'in', e: left, sub, not };
            }
            const list = [];
            if (!this.isOp(')'))
                do {
                    list.push(this.expr());
                } while (this.acceptOp(','));
            this.expectOp(')');
            return { k: 'in', e: left, list, not };
        }
        if (t.v === '+' || t.v === '-' || t.v === '||' || t.v === '*' || t.v === '/' || t.v === '%') {
            return { k: 'bin', op: t.v, l: left, r: this.expr(bp) };
        }
        if (u === 'DIV')
            return { k: 'bin', op: 'DIV', l: left, r: this.expr(bp) };
        if (u === 'MOD')
            return { k: 'bin', op: '%', l: left, r: this.expr(bp) };
        if (t.v === '::')
            return { k: 'cast', e: left, to: this.typeName() };
        if (t.v === '->' || t.v === '->>') {
            const key = this.prefix();
            return { k: 'fn', name: t.v === '->' ? 'JSON_ARROW' : 'JSON_ARROW_TEXT', args: [left, key] };
        }
        return this.fail('Unexpected operator');
    }
    typeName() {
        const w = this.next();
        if (w.t !== 'word') {
            this.i--;
            this.fail('Expected a type name');
        }
        const t = normalizeType(w.v, () => (this.isWord('INTEGER') || this.isWord('INT') ? this.next().v : null));
        if (this.acceptOp('(')) {
            while (!this.isOp(')') && !this.atEnd())
                this.next();
            this.expectOp(')');
        }
        if (w.v.toUpperCase() === 'DOUBLE')
            this.acceptWord('PRECISION');
        return t;
    }
    prefix() {
        const t = this.peek();
        if (t.t === 'num') {
            this.i++;
            return { k: 'lit', v: Number(t.v) };
        }
        if (t.t === 'str') {
            this.i++;
            return { k: 'lit', v: t.v };
        }
        if (t.t === 'param') {
            this.i++;
            return { k: 'param', i: Number(t.v) };
        }
        if (t.t === 'op') {
            if (t.v === '-' || t.v === '+') {
                this.i++;
                const e = this.expr(7);
                if (e.k === 'lit' && typeof e.v === 'number')
                    return { k: 'lit', v: t.v === '-' ? -e.v : e.v };
                return { k: 'un', op: t.v, e };
            }
            if (t.v === '(') {
                this.i++;
                if (this.isWord('SELECT') || this.isWord('WITH')) {
                    const sub = this.query();
                    this.expectOp(')');
                    return { k: 'subq', sub };
                }
                const e = this.expr();
                if (this.isOp(',')) {
                    // Row value (a, b) — only meaningful in IN lists; evaluate as an array.
                    const items = [e];
                    while (this.acceptOp(','))
                        items.push(this.expr());
                    this.expectOp(')');
                    return { k: 'fn', name: 'ROW', args: items };
                }
                this.expectOp(')');
                return e;
            }
            if (t.v === '*') {
                this.i++;
                return { k: 'star' };
            }
            return this.fail('Expected an expression');
        }
        if (t.t === 'ident')
            return this.refOrCall();
        const u = t.v.toUpperCase();
        switch (u) {
            case 'NULL':
                this.i++;
                return { k: 'lit', v: null };
            case 'TRUE':
                this.i++;
                return { k: 'lit', v: true };
            case 'FALSE':
                this.i++;
                return { k: 'lit', v: false };
            case 'NOT':
                this.i++;
                return { k: 'un', op: 'NOT', e: this.expr(3) };
            case 'EXISTS': {
                this.i++;
                this.expectOp('(');
                const sub = this.query();
                this.expectOp(')');
                return { k: 'exists', sub, not: false };
            }
            case 'CASE': return this.caseExpr();
            case 'CAST':
            case 'CONVERT': {
                if (!this.isOp('(', 1))
                    break;
                this.i += 2;
                const e = this.expr();
                if (u === 'CONVERT' && this.acceptOp(',')) {
                    const to = this.typeName();
                    this.expectOp(')');
                    return { k: 'cast', e, to };
                }
                this.expectWord('AS');
                const to = this.typeName();
                this.expectOp(')');
                return { k: 'cast', e, to };
            }
            case 'INTERVAL': {
                this.i++;
                const v = this.expr(6);
                const unit = this.next();
                if (unit.t !== 'word') {
                    this.i--;
                    this.fail('Expected an interval unit (DAY, HOUR, …)');
                }
                return { k: 'interval', v, unit: unit.v.toLowerCase().replace(/s$/, '') };
            }
            case 'DATE':
            case 'TIMESTAMP':
            case 'TIME':
                if (this.peek(1).t === 'str') {
                    this.i++;
                    return { k: 'lit', v: this.next().v };
                }
                break;
            case 'CURRENT_DATE':
            case 'CURRENT_TIMESTAMP':
            case 'CURRENT_TIME':
            case 'LOCALTIMESTAMP':
            case 'LOCALTIME':
                if (!this.isOp('(', 1)) {
                    this.i++;
                    return { k: 'fn', name: u, args: [] };
                }
                break;
        }
        if (RESERVED.has(u) && !this.isOp('(', 1))
            return this.fail('Expected an expression');
        return this.refOrCall();
    }
    caseExpr() {
        this.expectWord('CASE');
        let base;
        if (!this.isWord('WHEN'))
            base = this.expr();
        const whens = [];
        while (this.acceptWord('WHEN')) {
            const w = this.expr();
            this.expectWord('THEN');
            whens.push([w, this.expr()]);
        }
        if (whens.length === 0)
            this.fail('CASE needs at least one WHEN');
        let els;
        if (this.acceptWord('ELSE'))
            els = this.expr();
        this.expectWord('END');
        return { k: 'case', base, whens, else: els };
    }
    refOrCall() {
        const first = this.next();
        if (this.isOp('('))
            return this.call(first.v);
        const parts = [first.v];
        while (this.isOp('.') && (this.peek(1).t === 'word' || this.peek(1).t === 'ident')) {
            this.next();
            parts.push(this.next().v);
        }
        return { k: 'ref', parts };
    }
    call(rawName) {
        const name = rawName.toUpperCase();
        this.expectOp('(');
        const fn = { k: 'fn', name, args: [] };
        // Special argument syntaxes.
        if (name === 'EXTRACT') {
            const unit = this.next().v.toLowerCase();
            this.expectWord('FROM');
            fn.args = [{ k: 'lit', v: unit }, this.expr()];
            this.expectOp(')');
            return this.afterCall(fn);
        }
        if (name === 'POSITION' && !this.isOp(')')) {
            const needle = this.expr(4);
            if (this.acceptWord('IN')) {
                fn.args = [needle, this.expr()];
                this.expectOp(')');
                return this.afterCall(fn);
            }
            fn.args = [needle];
            while (this.acceptOp(','))
                fn.args.push(this.expr());
            this.expectOp(')');
            return this.afterCall(fn);
        }
        if ((name === 'SUBSTRING' || name === 'SUBSTR') && !this.isOp(')')) {
            const s = this.expr();
            if (this.acceptWord('FROM')) {
                fn.args = [s, this.expr()];
                if (this.acceptWord('FOR'))
                    fn.args.push(this.expr());
                this.expectOp(')');
                return this.afterCall(fn);
            }
            fn.args = [s];
            while (this.acceptOp(','))
                fn.args.push(this.expr());
            this.expectOp(')');
            return this.afterCall(fn);
        }
        if (name === 'TRIM') {
            let mode = 'BOTH';
            if (this.isWord('LEADING') || this.isWord('TRAILING') || this.isWord('BOTH'))
                mode = this.next().v.toUpperCase();
            let chars;
            let s;
            if (this.acceptWord('FROM')) {
                s = this.expr();
            }
            else {
                const a = this.expr();
                if (this.acceptWord('FROM')) {
                    chars = a;
                    s = this.expr();
                }
                else
                    s = a;
            }
            this.expectOp(')');
            fn.args = [s, { k: 'lit', v: mode }, ...(chars ? [chars] : [])];
            return this.afterCall(fn);
        }
        if (this.acceptOp(')'))
            return this.afterCall(fn);
        if (this.acceptWord('DISTINCT'))
            fn.distinct = true;
        else
            this.acceptWord('ALL');
        if (this.isOp('*') && (this.isOp(')', 1))) {
            this.next();
            fn.star = true;
        }
        else {
            do {
                fn.args.push(this.expr());
            } while (this.acceptOp(','));
        }
        // Ordered-set / string aggregation extras.
        if (this.acceptWord('ORDER')) {
            this.expectWord('BY');
            fn.orderBy = this.orderList();
        }
        if (this.acceptWord('SEPARATOR'))
            fn.sep = this.expr();
        this.expectOp(')');
        return this.afterCall(fn);
    }
    afterCall(fn) {
        if (this.isWord('FILTER') && this.isOp('(', 1)) {
            this.next();
            this.next();
            this.expectWord('WHERE');
            fn.filter = this.expr();
            this.expectOp(')');
        }
        if (this.isWord('WITHIN') && this.isWord('GROUP', 1)) {
            this.next();
            this.next();
            this.expectOp('(');
            this.expectWord('ORDER');
            this.expectWord('BY');
            fn.orderBy = this.orderList();
            this.expectOp(')');
        }
        if (this.acceptWord('OVER')) {
            if (this.isOp('(')) {
                this.next();
                fn.over = this.windowSpec();
                this.expectOp(')');
            }
            else {
                fn.over = { partition: [], order: [], ref: this.ident('window name') };
            }
        }
        return fn;
    }
    windowSpec() {
        const spec = { partition: [], order: [] };
        if (this.isIdentTok(this.peek()) && !this.isWord('PARTITION') && !this.isWord('ORDER') && !this.isWord('ROWS') && !this.isWord('RANGE')) {
            spec.ref = this.ident();
        }
        if (this.acceptWord('PARTITION')) {
            this.expectWord('BY');
            do {
                spec.partition.push(this.expr());
            } while (this.acceptOp(','));
        }
        if (this.acceptWord('ORDER')) {
            this.expectWord('BY');
            spec.order = this.orderList();
        }
        if (this.isWord('ROWS') || this.isWord('RANGE')) {
            const unit = this.next().v.toLowerCase();
            let start, end;
            if (this.acceptWord('BETWEEN')) {
                start = this.frameBound();
                this.expectWord('AND');
                end = this.frameBound();
            }
            else {
                start = this.frameBound();
                end = { kind: 'current' };
            }
            spec.frame = { unit, start, end };
        }
        return spec;
    }
    frameBound() {
        if (this.acceptWord('UNBOUNDED')) {
            if (this.acceptWord('PRECEDING'))
                return { kind: 'unbounded_preceding' };
            this.expectWord('FOLLOWING');
            return { kind: 'unbounded_following' };
        }
        if (this.acceptWord('CURRENT')) {
            this.expectWord('ROW');
            return { kind: 'current' };
        }
        const n = this.next();
        if (n.t !== 'num' || !/^\d+$/.test(n.v)) {
            this.i--;
            this.fail('Expected a frame bound');
        }
        if (this.acceptWord('PRECEDING'))
            return { kind: 'preceding', n: Number(n.v) };
        this.expectWord('FOLLOWING');
        return { kind: 'following', n: Number(n.v) };
    }
    orderList() {
        const out = [];
        do {
            const e = this.expr();
            const desc = this.acceptWord('DESC') ? true : (this.acceptWord('ASC'), false);
            let nulls;
            if (this.acceptWord('NULLS')) {
                if (this.acceptWord('FIRST'))
                    nulls = 'first';
                else {
                    this.expectWord('LAST');
                    nulls = 'last';
                }
            }
            out.push({ e, desc, nulls });
        } while (this.acceptOp(','));
        return out;
    }
    // ── queries ──
    query() {
        this.enter();
        try {
            if (this.acceptWord('WITH')) {
                const recursive = this.acceptWord('RECURSIVE');
                const ctes = [];
                do {
                    const name = this.ident('CTE name');
                    let cols;
                    if (this.acceptOp('(')) {
                        cols = [];
                        do {
                            cols.push(this.ident('column name'));
                        } while (this.acceptOp(','));
                        this.expectOp(')');
                    }
                    this.expectWord('AS');
                    this.expectOp('(');
                    const q = this.query();
                    this.expectOp(')');
                    ctes.push({ name, cols, q });
                } while (this.acceptOp(','));
                return { k: 'with', recursive, ctes, body: this.query() };
            }
            let q = this.setExpr();
            const orderBy = this.acceptWord('ORDER') ? (this.expectWord('BY'), this.orderList()) : [];
            const { limit, offset } = this.limitClause();
            if (orderBy.length || limit || offset) {
                if (q.k === 'select' && q.orderBy.length === 0 && !q.limit && !q.offset) {
                    q = { ...q, orderBy, limit, offset };
                }
                else if (q.k === 'setop' && q.orderBy.length === 0 && !q.limit && !q.offset) {
                    q = { ...q, orderBy, limit, offset };
                }
                else {
                    // (SELECT … LIMIT 5) ORDER BY … → wrap.
                    q = {
                        k: 'select', distinct: false, items: [{ star: true }], from: { k: 'sub', q, alias: '__q' },
                        groupBy: [], windows: {}, orderBy, limit, offset,
                    };
                }
            }
            return q;
        }
        finally {
            this.leave();
        }
    }
    limitClause() {
        let limit, offset;
        if (this.acceptWord('LIMIT')) {
            if (this.acceptWord('ALL'))
                limit = undefined;
            else {
                const a = this.expr();
                if (this.acceptOp(',')) {
                    offset = a;
                    limit = this.expr();
                }
                else
                    limit = a;
            }
        }
        if (this.acceptWord('OFFSET')) {
            offset = this.expr();
            if (!this.acceptWord('ROWS'))
                this.acceptWord('ROW');
        }
        if (this.acceptWord('FETCH')) {
            if (!this.acceptWord('FIRST'))
                this.expectWord('NEXT');
            limit = this.isWord('ROW') || this.isWord('ROWS') ? { k: 'lit', v: 1 } : this.expr();
            if (!this.acceptWord('ROWS'))
                this.expectWord('ROW');
            this.expectWord('ONLY');
        }
        return { limit, offset };
    }
    setExpr() {
        let left = this.setTerm();
        while (this.isWord('UNION') || this.isWord('EXCEPT') || this.isWord('MINUS')) {
            const w = this.next().v.toUpperCase();
            const all = this.acceptWord('ALL') ? true : (this.acceptWord('DISTINCT'), false);
            const right = this.setTerm();
            left = { k: 'setop', op: w === 'UNION' ? 'union' : 'except', all, l: left, r: right, orderBy: [] };
        }
        return left;
    }
    setTerm() {
        let left = this.setPrimary();
        while (this.isWord('INTERSECT')) {
            this.next();
            const all = this.acceptWord('ALL') ? true : (this.acceptWord('DISTINCT'), false);
            left = { k: 'setop', op: 'intersect', all, l: left, r: this.setPrimary(), orderBy: [] };
        }
        return left;
    }
    setPrimary() {
        if (this.isOp('(') && (this.isWord('SELECT', 1) || this.isWord('WITH', 1) || this.isOp('(', 1))) {
            this.next();
            const q = this.query();
            this.expectOp(')');
            return q;
        }
        if (this.isWord('VALUES'))
            return this.valuesQuery();
        return this.selectCore();
    }
    /** VALUES (…), (…) as a query (columns column1, column2, …). */
    valuesQuery() {
        this.expectWord('VALUES');
        const rows = [];
        do {
            this.expectOp('(');
            const r = [];
            do {
                r.push(this.expr());
            } while (this.acceptOp(','));
            this.expectOp(')');
            rows.push(r);
        } while (this.acceptOp(','));
        const n = rows[0].length;
        if (rows.some((r) => r.length !== n))
            this.fail('Every VALUES row needs the same number of values');
        let q = null;
        for (const r of rows) {
            const sel = {
                k: 'select', distinct: false, from: null, groupBy: [], windows: {}, orderBy: [],
                items: r.map((e, i) => ({ e, alias: `column${i + 1}`, text: `column${i + 1}` })),
            };
            q = q ? { k: 'setop', op: 'union', all: true, l: q, r: sel, orderBy: [] } : sel;
        }
        return q;
    }
    selectCore() {
        this.expectWord('SELECT');
        const distinct = this.acceptWord('DISTINCT') ? true : (this.acceptWord('ALL'), false);
        const items = [];
        do {
            if (this.acceptOp('*')) {
                items.push({ star: true });
                continue;
            }
            if (this.isIdentTok(this.peek()) && this.isOp('.', 1) && this.isOp('*', 2)) {
                const table = this.next().v;
                this.next();
                this.next();
                items.push({ star: true, table });
                continue;
            }
            const start = this.peek().pos;
            const e = this.expr();
            const end = this.toks[this.i - 1].end;
            const text = this.src.slice(start, end).trim();
            items.push({ e, alias: this.alias(), text });
        } while (this.acceptOp(','));
        let from = null;
        if (this.acceptWord('FROM'))
            from = this.fromList();
        let where;
        if (this.acceptWord('WHERE'))
            where = this.expr();
        const groupBy = [];
        if (this.acceptWord('GROUP')) {
            this.expectWord('BY');
            do {
                groupBy.push(this.expr());
            } while (this.acceptOp(','));
            if (this.isWord('WITH') && this.isWord('ROLLUP', 1))
                this.fail('WITH ROLLUP is not supported');
        }
        let having;
        if (this.acceptWord('HAVING'))
            having = this.expr();
        const windows = {};
        if (this.acceptWord('WINDOW')) {
            do {
                const name = this.ident('window name');
                this.expectWord('AS');
                this.expectOp('(');
                windows[name] = this.windowSpec();
                this.expectOp(')');
            } while (this.acceptOp(','));
        }
        return { k: 'select', distinct, items, from, where, groupBy, having, windows, orderBy: [] };
    }
    fromList() {
        let left = this.fromItem();
        while (this.acceptOp(','))
            left = { k: 'join', type: 'cross', l: left, r: this.fromItem() };
        return left;
    }
    fromItem() {
        let left = this.tablePrimary();
        for (;;) {
            let type = null;
            if (this.acceptWord('NATURAL'))
                this.fail('NATURAL JOIN is not supported; use JOIN … USING (…)');
            if (this.acceptWord('JOIN'))
                type = 'inner';
            else if (this.isWord('INNER')) {
                this.next();
                this.expectWord('JOIN');
                type = 'inner';
            }
            else if (this.isWord('LEFT') && !this.isOp('(', 1)) {
                this.next();
                this.acceptWord('OUTER');
                this.expectWord('JOIN');
                type = 'left';
            }
            else if (this.isWord('RIGHT') && !this.isOp('(', 1)) {
                this.next();
                this.acceptWord('OUTER');
                this.expectWord('JOIN');
                type = 'right';
            }
            else if (this.isWord('FULL')) {
                this.next();
                this.acceptWord('OUTER');
                this.expectWord('JOIN');
                type = 'full';
            }
            else if (this.isWord('CROSS')) {
                this.next();
                this.expectWord('JOIN');
                type = 'cross';
            }
            if (!type)
                break;
            const right = this.tablePrimary();
            if (type === 'cross') {
                left = { k: 'join', type, l: left, r: right };
                continue;
            }
            if (this.acceptWord('USING')) {
                this.expectOp('(');
                const using = [];
                do {
                    using.push(this.ident('column name'));
                } while (this.acceptOp(','));
                this.expectOp(')');
                left = { k: 'join', type, l: left, r: right, using };
                continue;
            }
            this.expectWord('ON');
            left = { k: 'join', type, l: left, r: right, on: this.expr() };
        }
        return left;
    }
    tablePrimary() {
        if (this.acceptOp('(')) {
            if (this.isWord('SELECT') || this.isWord('WITH') || this.isWord('VALUES')) {
                const q = this.query();
                this.expectOp(')');
                const alias = this.alias();
                if (!alias)
                    this.fail('A subquery in FROM needs an alias');
                let cols;
                if (this.acceptOp('(')) {
                    cols = [];
                    do {
                        cols.push(this.ident('column name'));
                    } while (this.acceptOp(','));
                    this.expectOp(')');
                }
                return { k: 'sub', q, alias: alias, cols };
            }
            const inner = this.fromItem();
            this.expectOp(')');
            return inner;
        }
        const name = this.ident('table name');
        if (this.isOp('.') && this.isIdentTok(this.peek(1))) {
            // db.table: only the current database is addressable.
            this.next();
            return this.tableAlias(this.ident('table name'));
        }
        return this.tableAlias(name);
    }
    tableAlias(name) {
        return { k: 'table', name, alias: this.alias() ?? name };
    }
    // ── column definitions ──
    columnDef() {
        const name = this.ident('column name');
        const typeWord = this.next();
        if (typeWord.t !== 'word') {
            this.i--;
            this.fail('Expected a column type');
        }
        let args = [];
        if (this.acceptOp('(')) {
            while (!this.isOp(')') && !this.atEnd())
                args.push(this.next().v);
            this.expectOp(')');
            args = args.filter((a) => a !== ',');
        }
        if (typeWord.v.toUpperCase() === 'DOUBLE')
            this.acceptWord('PRECISION');
        this.acceptWord('UNSIGNED');
        const def = { type: mapType(typeWord.v, args) };
        for (;;) {
            if (this.acceptWord('NOT')) {
                this.expectWord('NULL');
                def.required = true;
                continue;
            }
            if (this.acceptWord('NULL'))
                continue;
            if (this.acceptWord('UNIQUE')) {
                this.acceptWord('KEY');
                def.unique = true;
                continue;
            }
            if (this.acceptWord('PRIMARY')) {
                this.expectWord('KEY');
                def.unique = true;
                def.required = true;
                continue;
            }
            if (this.acceptWord('AUTO_INCREMENT') || this.acceptWord('AUTOINCREMENT'))
                continue;
            if (this.acceptWord('COMMENT')) {
                this.next();
                continue;
            }
            if (this.acceptWord('DEFAULT')) {
                const e = this.expr(4);
                let v = e.k === 'lit' ? e.v : null;
                if (e.k === 'fn' && /^(CURRENT_TIMESTAMP|NOW|CURRENT_DATE)$/.test(e.name))
                    v = null; // evaluated per row is not supported: ignore
                if ((def.type === 'integer' || def.type === 'number') && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))
                    v = Number(v);
                if (def.type === 'boolean' && typeof v === 'number')
                    v = v !== 0;
                if (v !== null)
                    def.defaultValue = v;
                continue;
            }
            if (this.acceptWord('CHECK') || this.acceptWord('REFERENCES')) {
                // Accepted and ignored.
                let depth = 0;
                while (!this.atEnd() && !(depth === 0 && (this.isOp(',') || this.isOp(')')))) {
                    if (this.isOp('('))
                        depth++;
                    if (this.isOp(')'))
                        depth--;
                    this.next();
                }
                continue;
            }
            break;
        }
        return { name, def };
    }
    // ── statements ──
    statement() {
        const t = this.peek();
        if (t.t === 'op' && t.v === '(')
            return { type: 'select', q: this.query() };
        if (t.t !== 'word')
            this.fail('Expected a statement');
        switch (t.v.toUpperCase()) {
            case 'SELECT':
            case 'WITH':
            case 'VALUES': return { type: 'select', q: this.query() };
            case 'EXPLAIN':
                this.next();
                this.acceptWord('ANALYZE');
                return { type: 'explain', q: this.query() };
            case 'INSERT':
            case 'REPLACE': return this.insert();
            case 'UPDATE': return this.update();
            case 'DELETE': return this.del();
            case 'CREATE': return this.create();
            case 'DROP': return this.drop();
            case 'TRUNCATE': {
                this.next();
                this.acceptWord('TABLE');
                return { type: 'truncate', table: this.ident('table name') };
            }
            case 'ALTER': return this.alter();
            case 'SHOW': {
                this.next();
                if (this.acceptWord('TABLES'))
                    return { type: 'show_tables' };
                if (this.acceptWord('INDEXES') || this.acceptWord('INDEX') || this.acceptWord('KEYS')) {
                    if (!this.acceptWord('FROM'))
                        this.expectWord('IN');
                    return { type: 'show_indexes', table: this.ident('table name') };
                }
                if (this.acceptWord('COLUMNS') || this.acceptWord('FIELDS')) {
                    if (!this.acceptWord('FROM'))
                        this.expectWord('IN');
                    return { type: 'describe', table: this.ident('table name') };
                }
                return this.fail('Expected TABLES, INDEXES FROM t or COLUMNS FROM t');
            }
            case 'DESCRIBE':
            case 'DESC': {
                this.next();
                return { type: 'describe', table: this.ident('table name') };
            }
            case 'BEGIN':
            case 'START': {
                this.next();
                if (t.v.toUpperCase() === 'START')
                    this.expectWord('TRANSACTION');
                else if (!this.acceptWord('TRANSACTION'))
                    this.acceptWord('WORK');
                return { type: 'begin' };
            }
            case 'COMMIT':
            case 'END':
                this.next();
                if (!this.acceptWord('WORK'))
                    this.acceptWord('TRANSACTION');
                return { type: 'commit' };
            case 'ROLLBACK':
                this.next();
                if (!this.acceptWord('WORK'))
                    this.acceptWord('TRANSACTION');
                return { type: 'rollback' };
            default:
                return this.fail('Unsupported statement');
        }
    }
    returning() {
        if (!this.acceptWord('RETURNING'))
            return undefined;
        const items = [];
        do {
            if (this.acceptOp('*')) {
                items.push({ star: true });
                continue;
            }
            const start = this.peek().pos;
            const e = this.expr();
            items.push({ e, alias: this.alias(), text: this.src.slice(start, this.toks[this.i - 1].end).trim() });
        } while (this.acceptOp(','));
        return items;
    }
    setList() {
        const set = [];
        do {
            let col = this.ident('column name');
            if (this.acceptOp('.'))
                col = this.ident('column name'); // alias.col
            this.expectOp('=');
            set.push([col, this.expr()]);
        } while (this.acceptOp(','));
        return set;
    }
    insert() {
        const replace = this.next().v.toUpperCase() === 'REPLACE';
        const ignore = this.acceptWord('IGNORE');
        this.acceptWord('INTO');
        const table = this.ident('table name');
        let columns;
        if (this.isOp('(') && !(this.isWord('SELECT', 1) || this.isWord('WITH', 1))) {
            this.next();
            columns = [];
            do {
                columns.push(this.ident('column name'));
            } while (this.acceptOp(','));
            this.expectOp(')');
        }
        let rows;
        let query;
        if (this.acceptWord('VALUES') || this.acceptWord('VALUE')) {
            rows = [];
            do {
                this.expectOp('(');
                const r = [];
                if (!this.isOp(')'))
                    do {
                        r.push(this.expr());
                    } while (this.acceptOp(','));
                this.expectOp(')');
                rows.push(r);
            } while (this.acceptOp(','));
            if (columns)
                for (const r of rows)
                    if (r.length !== columns.length)
                        this.fail(`Expected ${columns.length} values per row, got ${r.length}`);
        }
        else if (this.acceptWord('SET')) {
            // MySQL INSERT … SET a = 1, b = 2
            const set = this.setList();
            columns = set.map(([c]) => c);
            rows = [set.map(([, e]) => e)];
        }
        else if (this.isWord('SELECT') || this.isWord('WITH') || this.isOp('(')) {
            query = this.query();
        }
        else {
            this.fail('Expected VALUES, SET or SELECT');
        }
        let conflict;
        if (replace)
            conflict = { action: 'update', set: [] };
        if (this.isWord('ON') && this.isWord('DUPLICATE', 1)) {
            this.next();
            this.next();
            this.expectWord('KEY');
            this.expectWord('UPDATE');
            conflict = { action: 'update', set: this.setList() };
        }
        else if (this.isWord('ON') && this.isWord('CONFLICT', 1)) {
            this.next();
            this.next();
            let target;
            if (this.acceptOp('(')) {
                target = [];
                do {
                    target.push(this.ident('column name'));
                } while (this.acceptOp(','));
                this.expectOp(')');
            }
            this.expectWord('DO');
            if (this.acceptWord('NOTHING'))
                conflict = { target, action: 'nothing', set: [] };
            else {
                this.expectWord('UPDATE');
                this.expectWord('SET');
                const set = this.setList();
                let where;
                if (this.acceptWord('WHERE'))
                    where = this.expr();
                conflict = { target, action: 'update', set, where };
            }
        }
        return { type: 'insert', table, columns, rows, query, conflict, ignore, returning: this.returning() };
    }
    update() {
        this.expectWord('UPDATE');
        const table = this.ident('table name');
        const alias = this.alias() ?? table;
        this.expectWord('SET');
        const set = this.setList();
        if (!this.acceptWord('WHERE'))
            this.fail('UPDATE requires a WHERE clause (use WHERE 1 = 1 to update every row)');
        const where = this.expr();
        return { type: 'update', table, alias, set, where, returning: this.returning() };
    }
    del() {
        this.expectWord('DELETE');
        this.expectWord('FROM');
        const table = this.ident('table name');
        const alias = this.alias() ?? table;
        if (!this.acceptWord('WHERE'))
            this.fail('DELETE requires a WHERE clause (use TRUNCATE TABLE to empty a table)');
        const where = this.expr();
        return { type: 'delete', table, alias, where, returning: this.returning() };
    }
    indexColumns() {
        this.expectOp('(');
        const fields = [];
        do {
            let f = this.ident('column name');
            while (this.acceptOp('.'))
                f += `.${this.ident('field name')}`;
            if (!this.acceptWord('ASC'))
                this.acceptWord('DESC');
            fields.push(f);
        } while (this.acceptOp(','));
        this.expectOp(')');
        return fields;
    }
    create() {
        this.expectWord('CREATE');
        const unique = this.acceptWord('UNIQUE');
        if (this.acceptWord('INDEX')) {
            let ifNotExists = false;
            if (this.acceptWord('IF')) {
                this.expectWord('NOT');
                this.expectWord('EXISTS');
                ifNotExists = true;
            }
            if (!this.isWord('ON'))
                this.ident('index name');
            this.expectWord('ON');
            const table = this.ident('table name');
            if (this.acceptWord('USING'))
                this.next();
            return { type: 'create_index', table, fields: this.indexColumns(), unique, ifNotExists };
        }
        if (unique)
            this.fail('Expected INDEX after CREATE UNIQUE');
        this.acceptWord('TEMPORARY');
        this.expectWord('TABLE');
        let ifNotExists = false;
        if (this.acceptWord('IF')) {
            this.expectWord('NOT');
            this.expectWord('EXISTS');
            ifNotExists = true;
        }
        const table = this.ident('table name');
        if (this.acceptWord('AS') || this.isWord('SELECT')) {
            return { type: 'create', table, ifNotExists, columns: {}, asQuery: this.query() };
        }
        this.expectOp('(');
        const columns = {};
        do {
            // Table-level constraints: UNIQUE/PRIMARY KEY lists mark columns unique; the rest is ignored.
            if (this.isWord('PRIMARY') || this.isWord('UNIQUE') || this.isWord('KEY') || this.isWord('INDEX') || this.isWord('CONSTRAINT') || this.isWord('FOREIGN') || this.isWord('CHECK')) {
                const isUnique = this.isWord('UNIQUE') || this.isWord('PRIMARY');
                let depth = 0;
                const names = [];
                while (!this.atEnd()) {
                    if (this.isOp('('))
                        depth++;
                    else if (this.isOp(')')) {
                        if (depth === 0)
                            break;
                        depth--;
                    }
                    else if (this.isOp(',') && depth === 0)
                        break;
                    const tk = this.next();
                    if (depth === 1 && (tk.t === 'word' || tk.t === 'ident'))
                        names.push(tk.v);
                }
                if (isUnique && names.length === 1 && columns[names[0]])
                    columns[names[0]].unique = true;
                continue;
            }
            const { name, def } = this.columnDef();
            if (name.toLowerCase() === 'id')
                continue; // the engine assigns ids
            if (columns[name])
                this.fail(`Duplicate column '${name}'`);
            columns[name] = def;
        } while (this.acceptOp(','));
        this.expectOp(')');
        while (!this.atEnd())
            this.next(); // ENGINE=…, CHARSET=… etc.
        return { type: 'create', table, ifNotExists, columns };
    }
    drop() {
        this.expectWord('DROP');
        if (this.acceptWord('INDEX')) {
            let ifExists = false;
            if (this.acceptWord('IF')) {
                this.expectWord('EXISTS');
                ifExists = true;
            }
            // Index names are the indexed column(s): city, or city+age for a compound index.
            let name = this.ident('index name');
            while (this.acceptOp('+'))
                name += `+${this.ident('index name')}`;
            this.expectWord('ON');
            return { type: 'drop_index', table: this.ident('table name'), name, ifExists };
        }
        this.expectWord('TABLE');
        let ifExists = false;
        if (this.acceptWord('IF')) {
            this.expectWord('EXISTS');
            ifExists = true;
        }
        return { type: 'drop', table: this.ident('table name'), ifExists };
    }
    alter() {
        this.expectWord('ALTER');
        this.expectWord('TABLE');
        const table = this.ident('table name');
        if (this.acceptWord('ADD')) {
            const unique = this.acceptWord('UNIQUE');
            if (this.acceptWord('INDEX') || this.acceptWord('KEY') || unique) {
                if (!this.isOp('('))
                    this.ident('index name');
                return { type: 'alter', table, action: { kind: 'add_index', fields: this.indexColumns(), unique } };
            }
            this.acceptWord('COLUMN');
            const { name, def } = this.columnDef();
            return { type: 'alter', table, action: { kind: 'add', name, def } };
        }
        if (this.acceptWord('DROP')) {
            if (this.acceptWord('INDEX') || this.acceptWord('KEY')) {
                return { type: 'alter', table, action: { kind: 'drop_index', name: this.ident('index name') } };
            }
            this.acceptWord('COLUMN');
            return { type: 'alter', table, action: { kind: 'drop', name: this.ident('column name') } };
        }
        if (this.acceptWord('MODIFY') || (this.isWord('ALTER') && (this.next(), true))) {
            this.acceptWord('COLUMN');
            const { name, def } = this.columnDef();
            return { type: 'alter', table, action: { kind: 'modify', name, def } };
        }
        if (this.acceptWord('RENAME')) {
            this.acceptWord('COLUMN');
            const from = this.ident('column name');
            this.expectWord('TO');
            return { type: 'alter', table, action: { kind: 'rename', from, to: this.ident('column name') } };
        }
        return this.fail('Expected ADD, DROP, MODIFY or RENAME COLUMN');
    }
}
function mapType(word, args) {
    const t = word.toLowerCase();
    if (t === 'tinyint' && args[0] === '1')
        return 'boolean';
    if (/^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|int2|int4|int8)$/.test(t))
        return 'integer';
    if (/^(decimal|numeric|float|double|real|float4|float8|money)$/.test(t))
        return 'number';
    if (/^(bool|boolean|bit)$/.test(t))
        return 'boolean';
    if (/^(date|datetime|timestamp|timestamptz|time|year)$/.test(t))
        return 'date';
    if (/^(json|jsonb)$/.test(t))
        return 'object';
    if (/^(array)$/.test(t))
        return 'array';
    if (/^(char|varchar|nchar|nvarchar|text|tinytext|mediumtext|longtext|string|enum|uuid|blob|citext)$/.test(t))
        return 'string';
    throw new SQLSyntaxError(`Unknown column type '${word}'`);
}
/**
 * SQL LIKE → anchored regex source (use with flags 's' and usually 'i').
 * % = any run, _ = one char, `esc` escapes the next char.
 */
function likeToRegex(pattern, esc = '\\') {
    if (pattern.length > 1000)
        throw new SQLSyntaxError('LIKE pattern too long (max 1000 characters)');
    let re = '^';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (esc && ch === esc && i + 1 < pattern.length) {
            re += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        }
        else if (ch === '%') {
            if (!re.endsWith('.*'))
                re += '.*';
        }
        else if (ch === '_') {
            re += '.';
        }
        else {
            re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        }
    }
    return re + '$';
}
/** Parses one or more `;`-separated statements. */
function parseSQL(sql) {
    if (typeof sql !== 'string' || !sql.trim())
        throw new SQLSyntaxError('Empty query');
    if (sql.length > 200_000)
        throw new SQLSyntaxError('Query too long (max 200k characters)');
    const p = new Parser(tokenize(sql), sql);
    const out = [];
    while (p.peek().t !== 'eof') {
        if (p.acceptOp(';'))
            continue;
        out.push(p.statement());
        if (!p.atEnd())
            p.fail('Unexpected input');
        if (out.length > MAX_STATEMENTS)
            throw new SQLSyntaxError(`At most ${MAX_STATEMENTS} statements per request`);
    }
    if (out.length === 0)
        throw new SQLSyntaxError('Empty query');
    return out;
}
function permissionFor(s) {
    switch (s.type) {
        case 'select':
        case 'explain':
        case 'show_tables':
        case 'show_indexes':
        case 'describe':
        case 'begin':
        case 'commit':
        case 'rollback':
            return 'read';
        case 'delete':
        case 'drop':
        case 'truncate':
        case 'drop_index': return 'delete';
        case 'alter': return s.action.kind === 'drop' || s.action.kind === 'drop_index' ? 'delete' : 'write';
        default: return 'write';
    }
}
/** Parses a bare expression (e.g. a WHERE clause typed into a filter box). */
function parseExpression(clause) {
    const p = new Parser(tokenize(clause), clause);
    const e = p.expr();
    if (!p.atEnd())
        p.fail('Unexpected input');
    return e;
}
//# sourceMappingURL=parser.js.map