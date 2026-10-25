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
exports.isInterval = exports.FUNCTIONS = exports.isoDateTime = exports.isoDate = exports.isNull = void 0;
exports.canonicalNumber = canonicalNumber;
exports.toNum = toNum;
exports.toStr = toStr;
exports.truth = truth;
exports.compare = compare;
exports.sqlEquals = sqlEquals;
exports.sortCompare = sortCompare;
exports.valueKey = valueKey;
exports.toDate = toDate;
exports.addInterval = addInterval;
exports.castTo = castTo;
exports.jsonPath = jsonPath;
exports.makeInterval = makeInterval;
const crypto = __importStar(require("crypto"));
const security_middleware_1 = require("../middleware/security.middleware");
/**
 * SQL value semantics and scalar functions.
 *
 * NULL is null/undefined. Predicates return true / false / null (unknown).
 * Comparisons: numbers with numbers, strings with strings (case-sensitive),
 * booleans compare as 0/1, and a string that is exactly a number's canonical
 * form ("42", not "042") compares as that number — so ids ("7") equal 7.
 * Other mixes (e.g. 'abc' vs 3) are unknown, i.e. never match.
 * Dates are ISO-8601 strings (UTC).
 */
const isNull = (v) => v === null || v === undefined;
exports.isNull = isNull;
/** "42" → 42 when the string is a number's canonical spelling; otherwise null. */
function canonicalNumber(s) {
    if (s === '' || s.length > 30)
        return null;
    const n = Number(s);
    return Number.isFinite(n) && String(n) === s ? n : null;
}
/** Number for arithmetic: numbers, booleans (1/0), numeric strings. null otherwise. */
function toNum(v) {
    if (typeof v === 'number')
        return Number.isNaN(v) ? null : v;
    if (typeof v === 'boolean')
        return v ? 1 : 0;
    if (typeof v === 'string') {
        const t = v.trim();
        if (t === '')
            return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
function toStr(v) {
    if ((0, exports.isNull)(v))
        return null;
    if (typeof v === 'string')
        return v;
    if (typeof v === 'object')
        return JSON.stringify(v);
    return String(v);
}
/** Truth value of a condition: true, false or null (unknown). */
function truth(v) {
    if ((0, exports.isNull)(v))
        return null;
    if (typeof v === 'boolean')
        return v;
    if (typeof v === 'number')
        return v !== 0;
    if (typeof v === 'string') {
        const n = toNum(v);
        return n === null ? false : n !== 0;
    }
    return true;
}
function deepEq(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
/** Three-way comparison, or null when the values are NULL or not comparable. */
function compare(a, b) {
    if ((0, exports.isNull)(a) || (0, exports.isNull)(b))
        return null;
    const ta = typeof a, tb = typeof b;
    if (ta === 'number' && tb === 'number')
        return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'string' && tb === 'string')
        return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'boolean' || tb === 'boolean') {
        const x = ta === 'boolean' ? (a ? 1 : 0) : ta === 'number' ? a : null;
        const y = tb === 'boolean' ? (b ? 1 : 0) : tb === 'number' ? b : null;
        if (x === null || y === null)
            return null;
        return x < y ? -1 : x > y ? 1 : 0;
    }
    if (ta === 'number' && tb === 'string') {
        const n = canonicalNumber(b);
        return n === null ? null : a < n ? -1 : a > n ? 1 : 0;
    }
    if (ta === 'string' && tb === 'number') {
        const n = canonicalNumber(a);
        return n === null ? null : n < b ? -1 : n > b ? 1 : 0;
    }
    if (ta === 'object' && tb === 'object')
        return deepEq(a, b) ? 0 : null;
    return null;
}
function sqlEquals(a, b) {
    const c = compare(a, b);
    return c === null ? null : c === 0;
}
/** Total order for ORDER BY / GROUP BY / DISTINCT: NULL, numbers, strings, booleans, objects. */
function sortCompare(a, b) {
    const an = (0, exports.isNull)(a), bn = (0, exports.isNull)(b);
    if (an || bn)
        return an && bn ? 0 : an ? -1 : 1;
    const c = compare(a, b);
    if (c !== null)
        return c;
    const rank = (v) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 3 : 4);
    const r = rank(a) - rank(b);
    if (r !== 0)
        return r;
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}
/** Key identifying a value for GROUP BY / DISTINCT / hash joins ("7" and 7 are the same key). */
function valueKey(v) {
    if ((0, exports.isNull)(v))
        return 'N';
    if (typeof v === 'number')
        return `n${v}`;
    if (typeof v === 'string') {
        const n = canonicalNumber(v);
        return n !== null ? `n${n}` : `s${v}`;
    }
    if (typeof v === 'boolean')
        return v ? 'b1' : 'b0';
    return `o${JSON.stringify(v)}`;
}
// ───────────────────────────── dates ─────────────────────────────
function toDate(v) {
    if ((0, exports.isNull)(v))
        return null;
    if (v instanceof Date)
        return Number.isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string') {
        let s = v.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s))
            s += 'T00:00:00Z';
        else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s))
            s = s.replace(' ', 'T') + 'Z';
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
exports.isoDate = isoDate;
const isoDateTime = (d) => d.toISOString();
exports.isoDateTime = isoDateTime;
const isDateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
const UNIT_MS = {
    microsecond: 0.001, millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000,
};
/** date ± n units (months/years are calendar-aware). Keeps a date-only input date-only for day-or-larger units. */
function addInterval(v, n, unit, sign = 1) {
    const d = toDate(v);
    if (!d || !Number.isFinite(n))
        return null;
    const u = unit.toLowerCase().replace(/s$/, '');
    const out = new Date(d.getTime());
    if (u === 'month' || u === 'quarter' || u === 'year') {
        const months = sign * n * (u === 'year' ? 12 : u === 'quarter' ? 3 : 1);
        const day = out.getUTCDate();
        out.setUTCDate(1);
        out.setUTCMonth(out.getUTCMonth() + months);
        const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
        out.setUTCDate(Math.min(day, last));
    }
    else if (UNIT_MS[u] !== undefined) {
        out.setTime(out.getTime() + sign * n * UNIT_MS[u]);
    }
    else {
        throw new Error(`Unknown interval unit '${unit}'`);
    }
    return isDateOnly(v) && !['hour', 'minute', 'second', 'millisecond', 'microsecond'].includes(u) ? (0, exports.isoDate)(out) : (0, exports.isoDateTime)(out);
}
function datePart(unit, d) {
    switch (unit.toLowerCase().replace(/s$/, '')) {
        case 'year': return d.getUTCFullYear();
        case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1;
        case 'month': return d.getUTCMonth() + 1;
        case 'week': return isoWeek(d);
        case 'day': return d.getUTCDate();
        case 'dow': return d.getUTCDay();
        case 'isodow': return d.getUTCDay() || 7;
        case 'doy': return dayOfYear(d);
        case 'hour': return d.getUTCHours();
        case 'minute': return d.getUTCMinutes();
        case 'second': return d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
        case 'millisecond': return d.getUTCMilliseconds();
        case 'epoch': return d.getTime() / 1000;
        default: throw new Error(`Unknown date part '${unit}'`);
    }
}
function dayOfYear(d) {
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}
function isoWeek(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** MySQL DATE_FORMAT specifiers. */
function dateFormat(d, fmt) {
    return fmt.replace(/%([a-zA-Z%])/g, (_m, c) => {
        switch (c) {
            case 'Y': return String(d.getUTCFullYear());
            case 'y': return pad(d.getUTCFullYear() % 100);
            case 'm': return pad(d.getUTCMonth() + 1);
            case 'c': return String(d.getUTCMonth() + 1);
            case 'M': return MONTHS[d.getUTCMonth()];
            case 'b': return MONTHS[d.getUTCMonth()].slice(0, 3);
            case 'd': return pad(d.getUTCDate());
            case 'e': return String(d.getUTCDate());
            case 'j': return pad(dayOfYear(d), 3);
            case 'W': return DAYS[d.getUTCDay()];
            case 'a': return DAYS[d.getUTCDay()].slice(0, 3);
            case 'w': return String(d.getUTCDay());
            case 'H': return pad(d.getUTCHours());
            case 'k': return String(d.getUTCHours());
            case 'h':
            case 'I': return pad(((d.getUTCHours() + 11) % 12) + 1);
            case 'l': return String(((d.getUTCHours() + 11) % 12) + 1);
            case 'i': return pad(d.getUTCMinutes());
            case 's':
            case 'S': return pad(d.getUTCSeconds());
            case 'f': return pad(d.getUTCMilliseconds() * 1000, 6);
            case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
            case 'T': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
            case 'u':
            case 'v': return pad(isoWeek(d));
            case '%': return '%';
            default: return c;
        }
    });
}
function dateTrunc(unit, d) {
    const u = unit.toLowerCase().replace(/s$/, '');
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    let t;
    switch (u) {
        case 'year':
            t = Date.UTC(y, 0, 1);
            break;
        case 'quarter':
            t = Date.UTC(y, m - (m % 3), 1);
            break;
        case 'month':
            t = Date.UTC(y, m, 1);
            break;
        case 'week': {
            const day = (d.getUTCDay() + 6) % 7;
            t = Date.UTC(y, m, d.getUTCDate() - day);
            break;
        }
        case 'day':
            t = Date.UTC(y, m, d.getUTCDate());
            break;
        case 'hour':
            t = Date.UTC(y, m, d.getUTCDate(), d.getUTCHours());
            break;
        case 'minute':
            t = Date.UTC(y, m, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
            break;
        case 'second':
            t = Date.UTC(y, m, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
            break;
        default: throw new Error(`Unknown DATE_TRUNC unit '${unit}'`);
    }
    return new Date(t).toISOString();
}
// ───────────────────────────── casts ─────────────────────────────
function castTo(v, to) {
    if ((0, exports.isNull)(v))
        return null;
    switch (to) {
        case 'integer': {
            const n = toNum(v);
            if (n === null)
                throw new Error(`Cannot cast ${JSON.stringify(v)} to integer`);
            return Math.sign(n) * Math.round(Math.abs(n));
        }
        case 'number': {
            const n = toNum(v);
            if (n === null)
                throw new Error(`Cannot cast ${JSON.stringify(v)} to number`);
            return n;
        }
        case 'string': return toStr(v);
        case 'boolean': {
            if (typeof v === 'boolean')
                return v;
            if (typeof v === 'number')
                return v !== 0;
            const s = String(v).trim().toLowerCase();
            if (['true', 't', 'yes', 'y', '1', 'on'].includes(s))
                return true;
            if (['false', 'f', 'no', 'n', '0', 'off'].includes(s))
                return false;
            throw new Error(`Cannot cast ${JSON.stringify(v)} to boolean`);
        }
        case 'date': {
            const d = toDate(v);
            if (!d)
                throw new Error(`Cannot cast ${JSON.stringify(v)} to date`);
            return (0, exports.isoDate)(d);
        }
        case 'datetime': {
            const d = toDate(v);
            if (!d)
                throw new Error(`Cannot cast ${JSON.stringify(v)} to timestamp`);
            return (0, exports.isoDateTime)(d);
        }
        case 'time': {
            const d = toDate(v);
            if (!d)
                throw new Error(`Cannot cast ${JSON.stringify(v)} to time`);
            return d.toISOString().slice(11, 19);
        }
        case 'json': {
            if (typeof v !== 'string')
                return v;
            try {
                return JSON.parse(v);
            }
            catch {
                throw new Error('Cannot cast text to JSON: invalid JSON');
            }
        }
    }
    throw new Error(`Unknown cast type '${to}'`);
}
// ───────────────────────────── JSON paths ─────────────────────────────
/** MySQL-style path: $.a.b[0] or $."key with spaces" */
function jsonPath(doc, path) {
    if (typeof doc === 'string') {
        try {
            doc = JSON.parse(doc);
        }
        catch {
            return null;
        }
    }
    if (typeof path !== 'string' || !path.startsWith('$'))
        throw new Error(`Invalid JSON path '${path}' (must start with $)`);
    const re = /\.("([^"]*)"|[A-Za-z0-9_$]+)|\[(\d+)\]/g;
    let cur = doc;
    let m;
    let consumed = 1;
    while ((m = re.exec(path)) !== null) {
        if (m.index !== consumed)
            throw new Error(`Invalid JSON path '${path}'`);
        consumed = re.lastIndex;
        if (cur === null || typeof cur !== 'object')
            return null;
        const key = m[3] !== undefined ? Number(m[3]) : (m[2] ?? m[1]);
        if (!Object.prototype.hasOwnProperty.call(cur, key))
            return null;
        cur = cur[key];
    }
    if (consumed !== path.length)
        throw new Error(`Invalid JSON path '${path}'`);
    return cur === undefined ? null : cur;
}
const nullIfAny = (f) => (args, ctx) => (args.some(exports.isNull) ? null : f(args, ctx));
const num = (f) => (args) => {
    const ns = args.map(toNum);
    if (ns.some((n) => n === null))
        return null;
    const r = f(...ns);
    return Number.isFinite(r) ? r : null;
};
const str = (f) => nullIfAny((args) => f(...args.map((a) => toStr(a))));
function roundTo(x, d) {
    const f = 10 ** d;
    return Math.sign(x) * Math.round(Math.abs(x) * f + Number.EPSILON) / f;
}
function substring(s, start, len) {
    const chars = Array.from(s);
    let i = start > 0 ? start - 1 : start < 0 ? chars.length + start : 0;
    if (start === 0)
        return len === undefined ? chars.join('') : chars.slice(0, Math.max(0, len - 1)).join('');
    if (i < 0)
        i = 0;
    return (len === undefined ? chars.slice(i) : chars.slice(i, i + Math.max(0, len))).join('');
}
function trimChars(s, mode, chars) {
    if (chars === undefined) {
        return mode === 'LEADING' ? s.replace(/^\s+/, '') : mode === 'TRAILING' ? s.replace(/\s+$/, '') : s.trim();
    }
    if (chars === '')
        return s;
    let a = 0, b = s.length;
    if (mode !== 'TRAILING')
        while (a < b && s.startsWith(chars, a))
            a += chars.length;
    if (mode !== 'LEADING')
        while (b - chars.length >= a && s.endsWith(chars, b) && b > a)
            b -= chars.length;
    return s.slice(a, b);
}
function safeRegex(pattern, flags) {
    (0, security_middleware_1.validateRegexPattern)(pattern);
    return new RegExp(pattern, flags);
}
/** Largest string a function may build (a huge REPEAT/LPAD could exhaust memory and stop the server). */
const MAX_STRING = 16 * 1024 * 1024;
function sized(n) {
    if (!(n <= MAX_STRING))
        throw new Error(`Result would exceed ${MAX_STRING.toLocaleString()} characters`);
    return n;
}
exports.FUNCTIONS = {
    // null handling / conditionals
    COALESCE: (a) => a.find((v) => !(0, exports.isNull)(v)) ?? null,
    IFNULL: (a) => ((0, exports.isNull)(a[0]) ? a[1] ?? null : a[0]),
    NVL: (a) => ((0, exports.isNull)(a[0]) ? a[1] ?? null : a[0]),
    NULLIF: (a) => (sqlEquals(a[0], a[1]) === true ? null : a[0] ?? null),
    IF: (a) => (truth(a[0]) === true ? a[1] ?? null : a[2] ?? null),
    IIF: (a) => (truth(a[0]) === true ? a[1] ?? null : a[2] ?? null),
    ISNULL: (a) => (0, exports.isNull)(a[0]),
    GREATEST: (a) => (a.some(exports.isNull) ? null : a.reduce((m, v) => (sortCompare(v, m) > 0 ? v : m))),
    LEAST: (a) => (a.some(exports.isNull) ? null : a.reduce((m, v) => (sortCompare(v, m) < 0 ? v : m))),
    // strings
    CONCAT: (a) => (a.some(exports.isNull) ? null : a.map((v) => toStr(v)).join('')),
    CONCAT_WS: (a) => ((0, exports.isNull)(a[0]) ? null : a.slice(1).filter((v) => !(0, exports.isNull)(v)).map((v) => toStr(v)).join(toStr(a[0]))),
    LENGTH: str((s) => Array.from(s).length),
    CHAR_LENGTH: str((s) => Array.from(s).length),
    CHARACTER_LENGTH: str((s) => Array.from(s).length),
    OCTET_LENGTH: str((s) => Buffer.byteLength(s)),
    UPPER: str((s) => s.toUpperCase()),
    UCASE: str((s) => s.toUpperCase()),
    LOWER: str((s) => s.toLowerCase()),
    LCASE: str((s) => s.toLowerCase()),
    INITCAP: str((s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase())),
    SUBSTRING: nullIfAny((a) => substring(toStr(a[0]), toNum(a[1]) ?? 1, a[2] === undefined ? undefined : toNum(a[2]) ?? 0)),
    SUBSTR: nullIfAny((a) => substring(toStr(a[0]), toNum(a[1]) ?? 1, a[2] === undefined ? undefined : toNum(a[2]) ?? 0)),
    MID: nullIfAny((a) => substring(toStr(a[0]), toNum(a[1]) ?? 1, a[2] === undefined ? undefined : toNum(a[2]) ?? 0)),
    LEFT: nullIfAny((a) => Array.from(toStr(a[0])).slice(0, Math.max(0, toNum(a[1]) ?? 0)).join('')),
    RIGHT: nullIfAny((a) => { const c = Array.from(toStr(a[0])); const n = Math.max(0, toNum(a[1]) ?? 0); return n === 0 ? '' : c.slice(-n).join(''); }),
    LPAD: nullIfAny((a) => { const s = toStr(a[0]), n = sized(Math.max(0, Math.floor(toNum(a[1]) ?? 0))), p = a[2] === undefined ? ' ' : toStr(a[2]); return s.length >= n ? s.slice(0, n) : p ? s.padStart(n, p) : s; }),
    RPAD: nullIfAny((a) => { const s = toStr(a[0]), n = sized(Math.max(0, Math.floor(toNum(a[1]) ?? 0))), p = a[2] === undefined ? ' ' : toStr(a[2]); return s.length >= n ? s.slice(0, n) : p ? s.padEnd(n, p) : s; }),
    TRIM: (a) => ((0, exports.isNull)(a[0]) ? null : trimChars(toStr(a[0]), String(a[1] ?? 'BOTH'), a[2] === undefined || (0, exports.isNull)(a[2]) ? undefined : toStr(a[2]))),
    LTRIM: str((s, c) => trimChars(s, 'LEADING', c)),
    RTRIM: str((s, c) => trimChars(s, 'TRAILING', c)),
    BTRIM: str((s, c) => trimChars(s, 'BOTH', c)),
    REPLACE: str((s, from, to) => { if (from === '')
        return s; const parts = s.split(from); sized(s.length + (parts.length - 1) * Math.max(0, to.length - from.length)); return parts.join(to); }),
    REVERSE: str((s) => Array.from(s).reverse().join('')),
    REPEAT: nullIfAny((a) => { const t = toStr(a[0]), n = Math.max(0, Math.floor(toNum(a[1]) ?? 0)); sized(t.length * n); return t.repeat(n); }),
    SPACE: nullIfAny((a) => ' '.repeat(sized(Math.max(0, Math.floor(toNum(a[0]) ?? 0))))),
    INSTR: str((s, sub) => s.indexOf(sub) + 1),
    STRPOS: str((s, sub) => s.indexOf(sub) + 1),
    POSITION: str((sub, s) => s.indexOf(sub) + 1),
    LOCATE: nullIfAny((a) => { const sub = toStr(a[0]), s = toStr(a[1]), from = a[2] === undefined ? 1 : toNum(a[2]) ?? 1; return s.indexOf(sub, Math.max(0, from - 1)) + 1; }),
    SPLIT_PART: nullIfAny((a) => { const parts = toStr(a[0]).split(toStr(a[1])); const n = toNum(a[2]) ?? 1; const p = n > 0 ? parts[n - 1] : parts[parts.length + n]; return p ?? ''; }),
    SUBSTRING_INDEX: nullIfAny((a) => { const s = toStr(a[0]), d = toStr(a[1]), n = toNum(a[2]) ?? 0; if (!d || n === 0)
        return ''; const parts = s.split(d); return n > 0 ? parts.slice(0, n).join(d) : parts.slice(n).join(d); }),
    ASCII: str((s) => (s.length ? s.charCodeAt(0) : 0)),
    CHR: nullIfAny((a) => String.fromCodePoint(Math.max(0, Math.min(0x10ffff, toNum(a[0]) ?? 0)))),
    STARTS_WITH: str((s, p) => s.startsWith(p)),
    ENDS_WITH: str((s, p) => s.endsWith(p)),
    REGEXP_LIKE: nullIfAny((a) => safeRegex(toStr(a[1]), String(a[2] ?? 'i').replace(/[^imsu]/g, '')).test(toStr(a[0]))),
    REGEXP_REPLACE: nullIfAny((a) => toStr(a[0]).replace(safeRegex(toStr(a[1]), 'g' + String(a[3] ?? '').replace(/[^imsu]/g, '')), toStr(a[2]))),
    REGEXP_SUBSTR: nullIfAny((a) => { const m = safeRegex(toStr(a[1]), '').exec(toStr(a[0])); return m ? m[0] : null; }),
    FORMAT: nullIfAny((a) => { const n = toNum(a[0]); const d = Math.max(0, Math.min(30, toNum(a[1]) ?? 0)); return n === null ? null : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }),
    MD5: str((s) => crypto.createHash('md5').update(s).digest('hex')),
    SHA1: str((s) => crypto.createHash('sha1').update(s).digest('hex')),
    SHA2: nullIfAny((a) => { const bits = toNum(a[1]) ?? 256; if (![224, 256, 384, 512].includes(bits))
        return null; return crypto.createHash(`sha${bits}`).update(toStr(a[0])).digest('hex'); }),
    SHA256: str((s) => crypto.createHash('sha256').update(s).digest('hex')),
    UUID: () => crypto.randomUUID(),
    GEN_RANDOM_UUID: () => crypto.randomUUID(),
    TO_BASE64: str((s) => Buffer.from(s).toString('base64')),
    FROM_BASE64: str((s) => Buffer.from(s, 'base64').toString('utf8')),
    HEX: (a) => ((0, exports.isNull)(a[0]) ? null : typeof a[0] === 'number' ? Math.trunc(a[0]).toString(16).toUpperCase() : Buffer.from(toStr(a[0])).toString('hex').toUpperCase()),
    // math
    ABS: num(Math.abs),
    CEIL: num(Math.ceil),
    CEILING: num(Math.ceil),
    FLOOR: num(Math.floor),
    ROUND: (a) => { const x = toNum(a[0]); if (x === null)
        return null; const d = a[1] === undefined ? 0 : toNum(a[1]); return d === null ? null : roundTo(x, d); },
    TRUNCATE: num((x, d) => Math.trunc(x * 10 ** d) / 10 ** d),
    TRUNC: (a) => { const x = toNum(a[0]); if (x === null)
        return null; const d = a[1] === undefined ? 0 : toNum(a[1]) ?? 0; return Math.trunc(x * 10 ** d) / 10 ** d; },
    MOD: num((x, y) => (y === 0 ? NaN : x % y)),
    POWER: num(Math.pow),
    POW: num(Math.pow),
    SQRT: num((x) => (x < 0 ? NaN : Math.sqrt(x))),
    EXP: num(Math.exp),
    LN: num((x) => (x <= 0 ? NaN : Math.log(x))),
    LOG: (a) => { if (a.length === 2) {
        const b = toNum(a[0]), x = toNum(a[1]);
        return b === null || x === null || b <= 0 || b === 1 || x <= 0 ? null : Math.log(x) / Math.log(b);
    } const x = toNum(a[0]); return x === null || x <= 0 ? null : Math.log(x); },
    LOG10: num((x) => (x <= 0 ? NaN : Math.log10(x))),
    LOG2: num((x) => (x <= 0 ? NaN : Math.log2(x))),
    SIGN: num(Math.sign),
    PI: () => Math.PI,
    SIN: num(Math.sin), COS: num(Math.cos), TAN: num(Math.tan),
    ASIN: num(Math.asin), ACOS: num(Math.acos), ATAN: num(Math.atan), ATAN2: num(Math.atan2),
    COT: num((x) => 1 / Math.tan(x)),
    DEGREES: num((x) => (x * 180) / Math.PI),
    RADIANS: num((x) => (x * Math.PI) / 180),
    RAND: () => Math.random(),
    RANDOM: () => Math.random(),
    // dates (UTC)
    NOW: (_a, c) => c.now.toISOString(),
    CURRENT_TIMESTAMP: (_a, c) => c.now.toISOString(),
    LOCALTIMESTAMP: (_a, c) => c.now.toISOString(),
    SYSDATE: () => new Date().toISOString(),
    CURRENT_DATE: (_a, c) => (0, exports.isoDate)(c.now),
    CURDATE: (_a, c) => (0, exports.isoDate)(c.now),
    CURRENT_TIME: (_a, c) => c.now.toISOString().slice(11, 19),
    CURTIME: (_a, c) => c.now.toISOString().slice(11, 19),
    LOCALTIME: (_a, c) => c.now.toISOString().slice(11, 19),
    UTC_TIMESTAMP: (_a, c) => c.now.toISOString(),
    DATE: (a) => { const d = toDate(a[0]); return d ? (0, exports.isoDate)(d) : null; },
    TIME: (a) => { const d = toDate(a[0]); return d ? d.toISOString().slice(11, 19) : null; },
    TIMESTAMP: (a) => { const d = toDate(a[0]); return d ? d.toISOString() : null; },
    YEAR: (a) => { const d = toDate(a[0]); return d ? d.getUTCFullYear() : null; },
    QUARTER: (a) => { const d = toDate(a[0]); return d ? Math.floor(d.getUTCMonth() / 3) + 1 : null; },
    MONTH: (a) => { const d = toDate(a[0]); return d ? d.getUTCMonth() + 1 : null; },
    MONTHNAME: (a) => { const d = toDate(a[0]); return d ? MONTHS[d.getUTCMonth()] : null; },
    DAY: (a) => { const d = toDate(a[0]); return d ? d.getUTCDate() : null; },
    DAYOFMONTH: (a) => { const d = toDate(a[0]); return d ? d.getUTCDate() : null; },
    DAYNAME: (a) => { const d = toDate(a[0]); return d ? DAYS[d.getUTCDay()] : null; },
    DAYOFWEEK: (a) => { const d = toDate(a[0]); return d ? d.getUTCDay() + 1 : null; },
    WEEKDAY: (a) => { const d = toDate(a[0]); return d ? (d.getUTCDay() + 6) % 7 : null; },
    DAYOFYEAR: (a) => { const d = toDate(a[0]); return d ? dayOfYear(d) : null; },
    WEEK: (a) => { const d = toDate(a[0]); return d ? isoWeek(d) : null; },
    WEEKOFYEAR: (a) => { const d = toDate(a[0]); return d ? isoWeek(d) : null; },
    HOUR: (a) => { const d = toDate(a[0]); return d ? d.getUTCHours() : null; },
    MINUTE: (a) => { const d = toDate(a[0]); return d ? d.getUTCMinutes() : null; },
    SECOND: (a) => { const d = toDate(a[0]); return d ? d.getUTCSeconds() : null; },
    EXTRACT: (a) => { const d = toDate(a[1]); return d ? datePart(String(a[0]), d) : null; },
    DATE_PART: (a) => { const d = toDate(a[1]); return d ? datePart(String(a[0]), d) : null; },
    DATE_TRUNC: (a) => { const d = toDate(a[1]); return d ? dateTrunc(String(a[0]), d) : null; },
    LAST_DAY: (a) => { const d = toDate(a[0]); return d ? (0, exports.isoDate)(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) : null; },
    DATEDIFF: (a) => { const x = toDate(a[0]), y = toDate(a[1]); if (!x || !y)
        return null; const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); return Math.round((day(x) - day(y)) / 86_400_000); },
    TIMESTAMPDIFF: (a) => {
        const u = String(a[0]).toLowerCase().replace(/s$/, '');
        const x = toDate(a[1]), y = toDate(a[2]);
        if (!x || !y)
            return null;
        if (u === 'month' || u === 'quarter' || u === 'year') {
            let months = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
            const rest = (d) => ((d.getUTCDate() * 24 + d.getUTCHours()) * 60 + d.getUTCMinutes()) * 60_000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
            if (months > 0 && rest(y) < rest(x))
                months--;
            if (months < 0 && rest(y) > rest(x))
                months++;
            return u === 'month' ? months : u === 'quarter' ? Math.trunc(months / 3) : Math.trunc(months / 12);
        }
        if (UNIT_MS[u] === undefined)
            throw new Error(`Unknown TIMESTAMPDIFF unit '${a[0]}'`);
        return Math.trunc((y.getTime() - x.getTime()) / UNIT_MS[u]);
    },
    DATE_FORMAT: (a) => { const d = toDate(a[0]); return d && !(0, exports.isNull)(a[1]) ? dateFormat(d, toStr(a[1])) : null; },
    UNIX_TIMESTAMP: (a, c) => { const d = a.length ? toDate(a[0]) : c.now; return d ? Math.floor(d.getTime() / 1000) : null; },
    FROM_UNIXTIME: (a) => { const n = toNum(a[0]); return n === null ? null : new Date(n * 1000).toISOString(); },
    TO_TIMESTAMP: (a) => { const n = toNum(a[0]); return n === null ? null : new Date(n * 1000).toISOString(); },
    MAKEDATE: (a) => { const y = toNum(a[0]), d = toNum(a[1]); return y === null || d === null || d < 1 ? null : (0, exports.isoDate)(new Date(Date.UTC(y, 0, d))); },
    MAKE_DATE: (a) => { const y = toNum(a[0]), m = toNum(a[1]), d = toNum(a[2]); return y === null || m === null || d === null ? null : (0, exports.isoDate)(new Date(Date.UTC(y, m - 1, d))); },
    AGE: (a, c) => { const x = toDate(a[0]); const y = a.length > 1 ? toDate(a[1]) : c.now; if (!x || !y)
        return null; return Math.round((y.getTime() - x.getTime()) / 86_400_000); },
    // JSON
    JSON_EXTRACT: (a) => ((0, exports.isNull)(a[0]) || (0, exports.isNull)(a[1]) ? null : jsonPath(a[0], toStr(a[1]))),
    JSON_VALUE: (a) => { if ((0, exports.isNull)(a[0]) || (0, exports.isNull)(a[1]))
        return null; const v = jsonPath(a[0], toStr(a[1])); return v !== null && typeof v === 'object' ? null : v; },
    JSON_UNQUOTE: (a) => ((0, exports.isNull)(a[0]) ? null : typeof a[0] === 'string' ? a[0] : toStr(a[0])),
    JSON_ARROW: (a) => {
        let d = a[0];
        if (typeof d === 'string') {
            try {
                d = JSON.parse(d);
            }
            catch {
                return null;
            }
        }
        if (d === null || typeof d !== 'object' || (0, exports.isNull)(a[1]))
            return null;
        if (typeof a[1] === 'string' && a[1].startsWith('$'))
            return jsonPath(d, a[1]);
        const v = d[a[1]];
        return v === undefined ? null : v;
    },
    JSON_ARROW_TEXT: (a) => { const v = exports.FUNCTIONS.JSON_ARROW(a, { now: new Date(), database: '' }); return (0, exports.isNull)(v) ? null : toStr(v); },
    JSON_OBJECT: (a) => { const o = {}; for (let i = 0; i + 1 < a.length; i += 2)
        o[toStr(a[i]) ?? 'null'] = a[i + 1] ?? null; return o; },
    JSON_BUILD_OBJECT: (a) => { const o = {}; for (let i = 0; i + 1 < a.length; i += 2)
        o[toStr(a[i]) ?? 'null'] = a[i + 1] ?? null; return o; },
    JSON_ARRAY: (a) => a.map((v) => v ?? null),
    JSON_BUILD_ARRAY: (a) => a.map((v) => v ?? null),
    JSON_LENGTH: (a) => { let v = (0, exports.isNull)(a[1]) || a.length < 2 ? a[0] : jsonPath(a[0], toStr(a[1])); if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        }
        catch {
            return 1;
        }
    } return (0, exports.isNull)(v) ? null : Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : 1; },
    JSON_KEYS: (a) => { let v = a[0]; if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        }
        catch {
            return null;
        }
    } return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null; },
    JSON_TYPE: (a) => { const v = a[0]; return (0, exports.isNull)(v) ? 'NULL' : Array.isArray(v) ? 'ARRAY' : typeof v === 'object' ? 'OBJECT' : typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'DOUBLE') : typeof v === 'boolean' ? 'BOOLEAN' : 'STRING'; },
    JSON_VALID: (a) => { if ((0, exports.isNull)(a[0]))
        return null; if (typeof a[0] !== 'string')
        return true; try {
        JSON.parse(a[0]);
        return true;
    }
    catch {
        return false;
    } },
    JSON_CONTAINS: (a) => {
        let t = a[0], c = a[1];
        if ((0, exports.isNull)(t) || (0, exports.isNull)(c))
            return null;
        if (typeof t === 'string') {
            try {
                t = JSON.parse(t);
            }
            catch {
                return null;
            }
        }
        if (typeof c === 'string') {
            try {
                c = JSON.parse(c);
            }
            catch { /* scalar string */ }
        }
        const contains = (x, y) => {
            if (Array.isArray(x))
                return Array.isArray(y) ? y.every((e) => x.some((xe) => contains(xe, e))) : x.some((xe) => contains(xe, y));
            if (x && typeof x === 'object')
                return !!y && typeof y === 'object' && !Array.isArray(y) && Object.keys(y).every((k) => k in x && contains(x[k], y[k]));
            return JSON.stringify(x) === JSON.stringify(y);
        };
        return contains(t, c);
    },
    TO_JSON: (a) => a[0] ?? null,
    ROW: (a) => a,
    // arrays (NoSQL fields)
    ARRAY_LENGTH: (a) => (Array.isArray(a[0]) ? a[0].length : null),
    CARDINALITY: (a) => (Array.isArray(a[0]) ? a[0].length : null),
    ARRAY_CONTAINS: (a) => (Array.isArray(a[0]) ? a[0].some((v) => sqlEquals(v, a[1]) === true) : null),
    ARRAY_POSITION: (a) => { if (!Array.isArray(a[0]))
        return null; const i = a[0].findIndex((v) => sqlEquals(v, a[1]) === true); return i < 0 ? null : i + 1; },
    ARRAY_TO_STRING: (a) => (Array.isArray(a[0]) ? a[0].filter((v) => !(0, exports.isNull)(v)).map((v) => toStr(v)).join(toStr(a[1]) ?? ',') : null),
    STRING_TO_ARRAY: str((s, d) => (d === '' ? Array.from(s) : s.split(d))),
    // info
    VERSION: () => 'OpenDBS',
    DATABASE: (_a, c) => c.database,
    SCHEMA: (_a, c) => c.database,
    CURRENT_DATABASE: (_a, c) => c.database,
    TYPEOF: (a) => ((0, exports.isNull)(a[0]) ? 'null' : Array.isArray(a[0]) ? 'array' : typeof a[0]),
};
exports.FUNCTIONS.CHAR = exports.FUNCTIONS.CHR;
exports.FUNCTIONS.DATE_ADD = (a) => ((0, exports.isNull)(a[0]) || !a[1] || typeof a[1] !== 'object' ? null : addInterval(a[0], a[1].n, a[1].unit));
exports.FUNCTIONS.ADDDATE = (a) => ((0, exports.isNull)(a[0]) ? null : a[1] && typeof a[1] === 'object' ? addInterval(a[0], a[1].n, a[1].unit) : addInterval(a[0], toNum(a[1]) ?? 0, 'day'));
exports.FUNCTIONS.DATE_SUB = (a) => ((0, exports.isNull)(a[0]) || !a[1] || typeof a[1] !== 'object' ? null : addInterval(a[0], a[1].n, a[1].unit, -1));
exports.FUNCTIONS.SUBDATE = (a) => ((0, exports.isNull)(a[0]) ? null : a[1] && typeof a[1] === 'object' ? addInterval(a[0], a[1].n, a[1].unit, -1) : addInterval(a[0], toNum(a[1]) ?? 0, 'day', -1));
function makeInterval(n, unit) {
    const v = toNum(n);
    return v === null ? null : { __interval: true, n: v, unit };
}
const isInterval = (v) => v !== null && typeof v === 'object' && v.__interval === true;
exports.isInterval = isInterval;
//# sourceMappingURL=functions.js.map