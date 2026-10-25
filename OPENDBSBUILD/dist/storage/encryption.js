"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionKeyError = exports.Cipher = void 0;
exports.isSealed = isSealed;
exports.resolveEncryption = resolveEncryption;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Encryption at rest for data files (.odbs snapshots and .wal logs).
 *
 * AES-256-GCM: confidentiality + tamper detection. Each sealed blob is
 *   MAGIC(8) | IV(12) | TAG(16) | CIPHERTEXT
 * so encrypted and legacy plaintext files can be told apart and old data is
 * migrated transparently on first start.
 *
 * Key resolution (first match wins):
 *   1. DB_ENCRYPTION_KEY       64 hex chars or base64 of 32 bytes
 *   2. DB_ENCRYPTION_KEY_FILE  path to a file containing such a key
 *   3. ./opendbs.key           generated on first start (outside DB_PATH, so
 *                              copying the data folder or a backup does not
 *                              copy the key). Move it to a secrets manager.
 * ENCRYPTION_AT_REST=false disables encryption (files are then plaintext).
 */
const MAGIC = Buffer.from('ODBSENC1');
const IV_LEN = 12;
const TAG_LEN = 16;
class Cipher {
    fingerprint;
    // A KeyObject avoids re-importing the raw key on every message (~25 µs → ~2 µs per write).
    key;
    // Random IVs, generated in bulk: every message still gets a fresh random 96-bit IV.
    ivPool = Buffer.alloc(0);
    ivPos = 0;
    constructor(rawKey) {
        if (rawKey.length !== 32)
            throw new Error('Encryption key must be 32 bytes');
        this.key = crypto_1.default.createSecretKey(rawKey);
        // Identifies the key in logs/backups without revealing it.
        this.fingerprint = crypto_1.default.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
    }
    /** A separate 32-byte key for another purpose (e.g. the disk store), derived with HKDF. */
    subkeyHex(purpose) {
        return Buffer.from(crypto_1.default.hkdfSync('sha256', this.key.export(), Buffer.alloc(0), `opendbs:${purpose}`, 32)).toString('hex');
    }
    nextIv() {
        if (this.ivPos + IV_LEN > this.ivPool.length) {
            this.ivPool = crypto_1.default.randomBytes(IV_LEN * 4096);
            this.ivPos = 0;
        }
        const iv = this.ivPool.subarray(this.ivPos, this.ivPos + IV_LEN);
        this.ivPos += IV_LEN;
        return iv;
    }
    seal(plain) {
        const iv = this.nextIv();
        const c = crypto_1.default.createCipheriv('aes-256-gcm', this.key, iv);
        const ct = Buffer.concat([c.update(plain), c.final()]);
        return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
    }
    open(sealed) {
        if (!isSealed(sealed))
            throw new Error('Not an encrypted OpenDBS blob');
        const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_LEN);
        const tag = sealed.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
        const ct = sealed.subarray(MAGIC.length + IV_LEN + TAG_LEN);
        const d = crypto_1.default.createDecipheriv('aes-256-gcm', this.key, iv);
        d.setAuthTag(tag);
        try {
            return Buffer.concat([d.update(ct), d.final()]);
        }
        catch {
            throw new EncryptionKeyError('Data could not be decrypted: wrong encryption key or the file was tampered with');
        }
    }
}
exports.Cipher = Cipher;
class EncryptionKeyError extends Error {
}
exports.EncryptionKeyError = EncryptionKeyError;
function isSealed(buf) {
    return buf.length >= MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}
function parseKey(raw, source) {
    const s = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(s))
        return Buffer.from(s, 'hex');
    const b = Buffer.from(s, 'base64');
    if (b.length === 32)
        return b;
    throw new Error(`${source} must be 64 hex characters (or base64 of 32 bytes). Generate one with:\n  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
}
let resolved = null;
function resolveEncryption() {
    if (resolved)
        return resolved;
    if ((process.env.ENCRYPTION_AT_REST ?? 'true').toLowerCase() === 'false') {
        resolved = { cipher: null, status: { enabled: false, source: 'disabled', keyFile: null, fingerprint: null } };
        return resolved;
    }
    if (process.env.DB_ENCRYPTION_KEY) {
        const cipher = new Cipher(parseKey(process.env.DB_ENCRYPTION_KEY, 'DB_ENCRYPTION_KEY'));
        resolved = { cipher, status: { enabled: true, source: 'env', keyFile: null, fingerprint: cipher.fingerprint } };
        return resolved;
    }
    const explicitFile = process.env.DB_ENCRYPTION_KEY_FILE;
    const file = path_1.default.resolve(explicitFile || 'opendbs.key');
    if (fs_1.default.existsSync(file)) {
        const cipher = new Cipher(parseKey(fs_1.default.readFileSync(file, 'utf-8'), file));
        resolved = { cipher, status: { enabled: true, source: explicitFile ? 'file' : 'generated-file', keyFile: file, fingerprint: cipher.fingerprint } };
        return resolved;
    }
    if (explicitFile)
        throw new Error(`DB_ENCRYPTION_KEY_FILE ${file} does not exist`);
    const key = crypto_1.default.randomBytes(32);
    fs_1.default.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    const cipher = new Cipher(key);
    console.warn('\n🔐 Encryption at rest is ON. A new data key was generated: ' + file + '\n' +
        '   ⚠️  Without this key your data and backups CANNOT be read. Back it up somewhere safe\n' +
        '   (password manager / secrets vault) and ideally set DB_ENCRYPTION_KEY instead of keeping\n' +
        '   the file on the same disk as the data.\n');
    resolved = { cipher, status: { enabled: true, source: 'generated-file', keyFile: file, fingerprint: cipher.fingerprint } };
    return resolved;
}
//# sourceMappingURL=encryption.js.map