"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.base32Encode = base32Encode;
exports.base32Decode = base32Decode;
exports.generateTotpSecret = generateTotpSecret;
exports.currentStep = currentStep;
exports.totpAt = totpAt;
exports.verifyTotp = verifyTotp;
exports.otpauthUrl = otpauthUrl;
exports.generateRecoveryCodes = generateRecoveryCodes;
const crypto_1 = __importDefault(require("crypto"));
/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps) — the variant every
 * authenticator app supports. Secrets are stored encrypted via SecretBox.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += B32[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(s) {
    const clean = s.replace(/[\s=-]/g, '').toUpperCase();
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx === -1)
            throw new Error('Invalid base32 secret');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}
function generateTotpSecret() {
    return base32Encode(crypto_1.default.randomBytes(20)); // 160-bit, as RFC 4226 recommends
}
function currentStep(now = Date.now()) {
    return Math.floor(now / 1000 / STEP_SECONDS);
}
function totpAt(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = crypto_1.default.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return code.toString().padStart(6, '0');
}
/**
 * Returns the matching time step (±1 step of clock drift), or null. Steps
 * at or before `lastUsedStep` are rejected so a code can't be replayed.
 */
function verifyTotp(secret, code, lastUsedStep = -1, now = Date.now()) {
    const c = String(code).replace(/\s/g, '');
    if (!/^\d{6}$/.test(c))
        return null;
    const step = currentStep(now);
    for (const s of [step, step - 1, step + 1]) {
        if (s <= lastUsedStep)
            continue;
        const expected = totpAt(secret, s);
        if (crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(c)))
            return s;
    }
    return null;
}
function otpauthUrl(issuer, account, secret) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
/** Human-friendly one-time recovery codes, e.g. "k3f9-2mxq". */
function generateRecoveryCodes(n = 10) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const pick = () => Array.from({ length: 4 }, () => alphabet[crypto_1.default.randomInt(alphabet.length)]).join('');
    return Array.from({ length: n }, () => `${pick()}-${pick()}`);
}
//# sourceMappingURL=totp.js.map