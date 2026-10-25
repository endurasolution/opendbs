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
exports.MASKED_VALUE = exports.SENSITIVE_ENV_KEYS = void 0;
exports.validateIdentifier = validateIdentifier;
exports.validateFieldName = validateFieldName;
exports.sanitizeObject = sanitizeObject;
exports.sanitizeDocument = sanitizeDocument;
exports.isPlainObject = isPlainObject;
exports.regexRisk = regexRisk;
exports.validateRegexPattern = validateRegexPattern;
exports.validateRegexOptions = validateRegexOptions;
exports.timingSafeEqual = timingSafeEqual;
exports.sha256Hex = sha256Hex;
exports.checkLoginRateLimit = checkLoginRateLimit;
exports.recordLoginFailure = recordLoginFailure;
exports.recordLoginSuccess = recordLoginSuccess;
exports.validatePasswordStrength = validatePasswordStrength;
exports.identifierParamGuard = identifierParamGuard;
exports.isSensitiveEnvKey = isSensitiveEnvKey;
exports.maskSensitiveEnv = maskSensitiveEnv;
const crypto = __importStar(require("crypto"));
// ---------------------------------------------------------------------------
// Identifier validation — database / rack names
// ---------------------------------------------------------------------------
const IDENTIFIER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;
const MAX_IDENTIFIER_LEN = 64;
function validateIdentifier(name) {
    if (!name || typeof name !== 'string')
        return false;
    if (name.length > MAX_IDENTIFIER_LEN)
        return false;
    if (!IDENTIFIER_RE.test(name))
        return false;
    // Reject path traversal attempts regardless of regex
    if (name.includes('..') || name.includes('/') || name.includes('\\'))
        return false;
    return true;
}
// ---------------------------------------------------------------------------
// Field-name validation — index fields, sort fields, query keys
// ---------------------------------------------------------------------------
// Dotted paths ("address.city") are allowed; each segment must be a plain
// key that can't reach the prototype chain and can't be mistaken for a
// query operator ($-prefixed).
const FIELD_SEGMENT_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;
function validateFieldName(name) {
    if (!name || typeof name !== 'string' || name.length > 255)
        return false;
    const segments = name.split('.');
    if (segments.length > 8)
        return false;
    return segments.every((s) => FIELD_SEGMENT_RE.test(s) && !DANGEROUS_KEYS.has(s));
}
// ---------------------------------------------------------------------------
// Prototype-pollution sanitization
// ---------------------------------------------------------------------------
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_QUERY_DEPTH = 6;
const MAX_QUERY_KEYS = 50;
function sanitizeObject(obj, depth = 0) {
    if (depth > MAX_QUERY_DEPTH) {
        throw new Error('Query object too deeply nested (max depth 6)');
    }
    if (obj === null || typeof obj !== 'object')
        return obj;
    if (Array.isArray(obj)) {
        if (obj.length > 1000)
            throw new Error('Array in query exceeds max length (1000)');
        return obj.map((item) => sanitizeObject(item, depth + 1));
    }
    const keys = Object.keys(obj);
    if (keys.length > MAX_QUERY_KEYS) {
        throw new Error(`Query object has too many keys (max ${MAX_QUERY_KEYS})`);
    }
    const clean = {};
    for (const key of keys) {
        if (DANGEROUS_KEYS.has(key))
            continue; // drop silently
        clean[key] = sanitizeObject(obj[key], depth + 1);
    }
    return clean;
}
const MAX_DOCUMENT_DEPTH = 32;
/**
 * Strips prototype-pollution keys from a document body at any depth and
 * bounds nesting so a hostile payload can't blow the stack in later
 * recursive code (hashing, cloning, matching). Mutates nothing -- returns
 * a clean copy only when something had to be removed.
 */
function sanitizeDocument(obj, depth = 0) {
    if (obj === null || typeof obj !== 'object')
        return obj;
    if (depth > MAX_DOCUMENT_DEPTH) {
        throw new Error(`Document too deeply nested (max depth ${MAX_DOCUMENT_DEPTH})`);
    }
    if (Array.isArray(obj)) {
        let changed = false;
        const out = obj.map((item) => {
            const c = sanitizeDocument(item, depth + 1);
            if (c !== item)
                changed = true;
            return c;
        });
        return changed ? out : obj;
    }
    let changed = false;
    const out = {};
    for (const key of Object.keys(obj)) {
        if (DANGEROUS_KEYS.has(key)) {
            changed = true;
            continue;
        }
        const v = obj[key];
        const c = sanitizeDocument(v, depth + 1);
        if (c !== v)
            changed = true;
        out[key] = c;
    }
    return changed ? out : obj;
}
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
// ---------------------------------------------------------------------------
// ReDoS guard — reject regex patterns that can cause catastrophic backtracking
// ---------------------------------------------------------------------------
const MAX_REGEX_LEN = 500;
const MAX_UNBOUNDED_QUANTIFIERS = 6;
/**
 * Structural ReDoS check (JavaScript regexes have no time limit, and one
 * runaway match blocks the whole server). Rejects:
 *  - a repeated group that itself contains a repetition or an alternation:
 *    (a+)+  (a*)*  (.*a){20}  (a|aa)+  (\w+\s?)*
 *  - backreferences (\1, \k<name>)
 *  - more than MAX_UNBOUNDED_QUANTIFIERS unbounded quantifiers (.*a.*b.*c… is polynomial)
 * Returns the reason, or null when the pattern is acceptable.
 */
function regexRisk(p) {
    const stack = [];
    let unbounded = 0;
    let last = null;
    let i = 0;
    while (i < p.length) {
        const c = p[i];
        if (c === '\\') {
            const n = p[i + 1];
            if ((n >= '1' && n <= '9') || n === 'k')
                return 'backreferences are not allowed';
            i += 2;
            last = 'atom';
            continue;
        }
        if (c === '[') {
            i++;
            if (p[i] === '^')
                i++;
            if (p[i] === ']')
                i++;
            while (i < p.length && p[i] !== ']')
                i += p[i] === '\\' ? 2 : 1;
            i++;
            last = 'atom';
            continue;
        }
        if (c === '(') {
            stack.push({ quant: false, alt: false });
            i++;
            if (p[i] === '?') {
                i++;
                if (p[i] === '<' && p[i + 1] !== '=' && p[i + 1] !== '!') {
                    while (i < p.length && p[i] !== '>')
                        i++;
                }
                i++;
            }
            last = null;
            continue;
        }
        if (c === ')') {
            const g = stack.pop() ?? { quant: false, alt: false };
            if (stack.length && g.alt)
                stack[stack.length - 1].alt = true;
            i++;
            last = g;
            continue;
        }
        if (c === '|') {
            if (stack.length)
                stack[stack.length - 1].alt = true;
            i++;
            last = null;
            continue;
        }
        if (c === '*' || c === '+' || c === '?' || c === '{') {
            let many = c !== '?', unb = c === '*' || c === '+';
            if (c === '{') {
                const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i, i + 24));
                if (!m) {
                    i++;
                    last = 'atom';
                    continue;
                } // a literal "{"
                many = m[2] !== undefined ? (m[3] === '' || Number(m[3]) > 1) : Number(m[1]) > 1;
                unb = m[2] !== undefined && m[3] === '';
                i += m[0].length;
            }
            else {
                i++;
            }
            if (p[i] === '?' || p[i] === '+')
                i++; // lazy / possessive suffix
            if (unb)
                unbounded++;
            if (many && last && last !== 'atom' && (last.quant || last.alt)) {
                return 'a repeated group contains a repetition or alternation (e.g. (a+)+ or (a|b)*); use a character class such as [ab]+ instead';
            }
            if (many)
                for (const g of stack)
                    g.quant = true;
            last = null;
            continue;
        }
        i++;
        last = 'atom';
    }
    if (unbounded > MAX_UNBOUNDED_QUANTIFIERS)
        return `more than ${MAX_UNBOUNDED_QUANTIFIERS} unbounded repetitions (* or +)`;
    return null;
}
function validateRegexPattern(pattern) {
    if (typeof pattern !== 'string')
        throw new Error('Regex pattern must be a string');
    if (pattern.length > MAX_REGEX_LEN) {
        throw new Error(`Regex pattern too long (max ${MAX_REGEX_LEN} characters)`);
    }
    const risk = regexRisk(pattern);
    if (risk)
        throw new Error(`Regex pattern is potentially unsafe (ReDoS risk): ${risk}`);
    try {
        new RegExp(pattern);
    }
    catch {
        throw new Error('Invalid regex pattern');
    }
}
function validateRegexOptions(options) {
    if (options === undefined || options === null || options === '')
        return '';
    if (typeof options !== 'string' || !/^[imsu]{0,4}$/.test(options) || new Set(options).size !== options.length) {
        throw new Error('Invalid regex options (allowed: i, m, s, u)');
    }
    return options;
}
// ---------------------------------------------------------------------------
// Timing-safe string comparison — prevents timing attacks on secrets
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;
    // Hash both sides so inputs of any length compare in constant time
    // without truncation or length leakage.
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}
function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_USERNAME_ATTEMPTS = 10; // across all IPs -- slows distributed guessing
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const LOCKOUT_MS = 15 * 60 * 1000; // 15-minute lockout
const MAX_TRACKED_KEYS = 100_000;
// Periodically clean up old entries to prevent memory growth
setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of loginAttempts) {
        const expired = rec.lockedUntil
            ? now > rec.lockedUntil
            : now - rec.firstAttemptAt > LOGIN_WINDOW_MS;
        if (expired)
            loginAttempts.delete(key);
    }
}, 60 * 1000).unref();
function checkKey(key) {
    const now = Date.now();
    const rec = loginAttempts.get(key);
    if (!rec)
        return;
    if (rec.lockedUntil && now < rec.lockedUntil) {
        const remaining = Math.ceil((rec.lockedUntil - now) / 1000 / 60);
        throw new Error(`Too many failed login attempts. Try again in ${remaining} minute(s).`);
    }
    if (now - rec.firstAttemptAt > LOGIN_WINDOW_MS || (rec.lockedUntil && now >= rec.lockedUntil)) {
        loginAttempts.delete(key);
    }
}
function failKey(key, max) {
    const now = Date.now();
    if (!loginAttempts.has(key) && loginAttempts.size >= MAX_TRACKED_KEYS)
        return;
    const rec = loginAttempts.get(key) ?? { count: 0, firstAttemptAt: now };
    if (now - rec.firstAttemptAt > LOGIN_WINDOW_MS) {
        rec.count = 0;
        rec.firstAttemptAt = now;
        rec.lockedUntil = undefined;
    }
    rec.count++;
    if (rec.count >= max) {
        rec.lockedUntil = now + LOCKOUT_MS;
    }
    loginAttempts.set(key, rec);
}
const userKey = (username) => `u:${String(username ?? '').toLowerCase().slice(0, 64)}`;
function checkLoginRateLimit(ip, username) {
    checkKey(`ip:${ip}`);
    if (username)
        checkKey(userKey(username));
}
function recordLoginFailure(ip, username) {
    failKey(`ip:${ip}`, MAX_LOGIN_ATTEMPTS);
    if (username)
        failKey(userKey(username), MAX_USERNAME_ATTEMPTS);
}
function recordLoginSuccess(ip, username) {
    loginAttempts.delete(`ip:${ip}`);
    if (username)
        loginAttempts.delete(userKey(username));
}
// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------
function validatePasswordStrength(password) {
    if (typeof password !== 'string')
        return 'Password is required';
    if (password.length < 8)
        return 'Password must be at least 8 characters';
    // bcrypt only uses the first 72 bytes; reject longer ones instead of
    // silently ignoring the tail.
    if (Buffer.byteLength(password, 'utf8') > 72)
        return 'Password must be at most 72 bytes';
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        return 'Password must contain at least one letter and one digit';
    }
    return null;
}
// ---------------------------------------------------------------------------
// Global identifier-param validation hook factory
// ---------------------------------------------------------------------------
function identifierParamGuard() {
    return async (request, reply) => {
        const params = (request.params || {});
        if (params.database !== undefined && !validateIdentifier(params.database)) {
            return reply
                .status(400)
                .send({ error: 'Invalid database name. Use letters, numbers, underscore or hyphen (max 64 chars).' });
        }
        // `name` is the rack param on the AI-dataset routes.
        for (const key of ['rack', 'name']) {
            if (params[key] !== undefined && !validateIdentifier(params[key])) {
                return reply
                    .status(400)
                    .send({ error: 'Invalid rack name. Use letters, numbers, underscore or hyphen (max 64 chars).' });
            }
        }
        // Compound index names are "a+b"; each part must be a valid field.
        if (params.field !== undefined && !params.field.split('+').every(validateFieldName)) {
            return reply.status(400).send({ error: 'Invalid field name' });
        }
    };
}
// ---------------------------------------------------------------------------
// Sensitive keys to mask in env/settings responses
// ---------------------------------------------------------------------------
exports.SENSITIVE_ENV_KEYS = new Set([
    'JWT_SECRET',
    'API_KEY_SALT',
    'BACKUP_S3_ACCESS_KEY',
    'BACKUP_S3_SECRET_KEY',
    'BACKUP_FTP_PASSWORD',
    'MYSQL_PASSWORD',
    'DB_PASSWORD',
    'SECRET',
    'PASSWORD',
    'API_KEY',
    'ACCESS_KEY',
    'TOKEN',
    'PRIVATE',
]);
exports.MASKED_VALUE = '***';
function isSensitiveEnvKey(key) {
    const upper = key.toUpperCase();
    for (const s of exports.SENSITIVE_ENV_KEYS)
        if (upper.includes(s))
            return true;
    return false;
}
function maskSensitiveEnv(env) {
    const masked = {};
    for (const [key, value] of Object.entries(env)) {
        masked[key] = isSensitiveEnvKey(key) ? exports.MASKED_VALUE : value;
    }
    return masked;
}
//# sourceMappingURL=security.middleware.js.map