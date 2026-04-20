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
exports.SENSITIVE_ENV_KEYS = void 0;
exports.validateIdentifier = validateIdentifier;
exports.sanitizeObject = sanitizeObject;
exports.validateRegexPattern = validateRegexPattern;
exports.timingSafeEqual = timingSafeEqual;
exports.checkLoginRateLimit = checkLoginRateLimit;
exports.recordLoginFailure = recordLoginFailure;
exports.recordLoginSuccess = recordLoginSuccess;
exports.identifierParamGuard = identifierParamGuard;
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
// ---------------------------------------------------------------------------
// ReDoS guard — reject regex patterns that can cause catastrophic backtracking
// ---------------------------------------------------------------------------
const MAX_REGEX_LEN = 200;
// Patterns that strongly suggest exponential backtracking
const REDOS_PATTERNS = [
    /(\.\*|\.\+){2,}/, // .*.* or .+.+ chains
    /(\w\+|\w\*){2,}/, // \w+\w+ chains
    /\([^)]+\+\)[+*{]/, // (x+)+ or (x+)*
    /\([^)]+\*\)[+*{]/, // (x*)+ etc.
    /(\(\?:[^)]+\))[+*{][+*{]/, // (?:x)+* nested quantifiers
];
function validateRegexPattern(pattern) {
    if (typeof pattern !== 'string')
        throw new Error('Regex pattern must be a string');
    if (pattern.length > MAX_REGEX_LEN) {
        throw new Error(`Regex pattern too long (max ${MAX_REGEX_LEN} characters)`);
    }
    for (const dangerous of REDOS_PATTERNS) {
        if (dangerous.test(pattern)) {
            throw new Error('Regex pattern is potentially unsafe (ReDoS risk)');
        }
    }
    try {
        new RegExp(pattern);
    }
    catch {
        throw new Error('Invalid regex pattern');
    }
}
// ---------------------------------------------------------------------------
// Timing-safe string comparison — prevents timing attacks on API keys
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;
    // Always compare same-length buffers to avoid length leakage
    const bufA = Buffer.alloc(256);
    const bufB = Buffer.alloc(256);
    bufA.write(a.substring(0, 256));
    bufB.write(b.substring(0, 256));
    return crypto.timingSafeEqual(bufA, bufB) && a.length === b.length;
}
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const LOCKOUT_MS = 15 * 60 * 1000; // 15-minute lockout
// Periodically clean up old entries to prevent memory growth
setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of loginAttempts) {
        const expired = rec.lockedUntil
            ? now > rec.lockedUntil + LOCKOUT_MS
            : now - rec.firstAttemptAt > LOGIN_WINDOW_MS;
        if (expired)
            loginAttempts.delete(ip);
    }
}, 10 * 60 * 1000).unref();
function checkLoginRateLimit(ip) {
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec)
        return;
    if (rec.lockedUntil && now < rec.lockedUntil) {
        const remaining = Math.ceil((rec.lockedUntil - now) / 1000 / 60);
        throw new Error(`Account locked due to too many failed attempts. Try again in ${remaining} minute(s).`);
    }
    // Expire the window
    if (now - rec.firstAttemptAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
    }
}
function recordLoginFailure(ip) {
    const now = Date.now();
    const rec = loginAttempts.get(ip) ?? { count: 0, firstAttemptAt: now };
    // Reset window if it has expired
    if (now - rec.firstAttemptAt > LOGIN_WINDOW_MS) {
        rec.count = 0;
        rec.firstAttemptAt = now;
        rec.lockedUntil = undefined;
    }
    rec.count++;
    if (rec.count >= MAX_LOGIN_ATTEMPTS) {
        rec.lockedUntil = now + LOCKOUT_MS;
    }
    loginAttempts.set(ip, rec);
}
function recordLoginSuccess(ip) {
    loginAttempts.delete(ip);
}
// ---------------------------------------------------------------------------
// Global identifier-param validation hook factory
// ---------------------------------------------------------------------------
function identifierParamGuard() {
    return async (request, reply) => {
        const params = request.params;
        if (params.database !== undefined && !validateIdentifier(params.database)) {
            return reply
                .status(400)
                .send({ error: 'Invalid database name. Use letters, numbers, underscore or hyphen (max 64 chars).' });
        }
        if (params.rack !== undefined && !validateIdentifier(params.rack)) {
            return reply
                .status(400)
                .send({ error: 'Invalid rack name. Use letters, numbers, underscore or hyphen (max 64 chars).' });
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
]);
function maskSensitiveEnv(env) {
    const masked = {};
    for (const [key, value] of Object.entries(env)) {
        const upper = key.toUpperCase();
        const isSensitive = Array.from(exports.SENSITIVE_ENV_KEYS).some((s) => upper.includes(s));
        masked[key] = isSensitive ? '***' : value;
    }
    return masked;
}
//# sourceMappingURL=security.middleware.js.map