"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretBox = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Encrypts small secrets at rest (TOTP seeds, backup-destination
 * credentials) with AES-256-GCM under a random master key kept in
 * <DB_PATH>/.master.key. The key is deliberately separate from JWT_SECRET
 * (rotating that must not lock anyone out of 2FA) and is never included in
 * backups, so a leaked backup file doesn't leak these secrets.
 */
class SecretBox {
    key;
    file;
    constructor(dataPath) {
        const file = path_1.default.join(dataPath, '.master.key');
        this.file = file;
        let key = null;
        try {
            const raw = fs_1.default.readFileSync(file, 'utf-8').trim();
            if (/^[0-9a-f]{64}$/.test(raw))
                key = Buffer.from(raw, 'hex');
        }
        catch { /* first run */ }
        if (!key) {
            key = crypto_1.default.randomBytes(32);
            fs_1.default.mkdirSync(dataPath, { recursive: true });
            fs_1.default.writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
        }
        this.key = key;
    }
    /** Hex master key (cluster members share it so replicated 2FA secrets open everywhere). */
    keyHex() {
        return this.key.toString('hex');
    }
    /** Adopts another node's master key (cluster join) and stores it. */
    setKeyHex(hex) {
        if (!/^[0-9a-f]{64}$/.test(hex) || hex === this.keyHex())
            return;
        this.key = Buffer.from(hex, 'hex');
        fs_1.default.writeFileSync(this.file, hex, { mode: 0o600 });
    }
    seal(plain) {
        const iv = crypto_1.default.randomBytes(12);
        const cipher = crypto_1.default.createCipheriv('aes-256-gcm', this.key, iv);
        const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return ['sb1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
    }
    open(blob) {
        const [v, iv, tag, data] = String(blob).split('.');
        if (v !== 'sb1')
            throw new Error('Unknown sealed-secret format');
        const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        try {
            return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
        }
        catch {
            throw new Error('Stored secret could not be decrypted (was data/.master.key replaced?)');
        }
    }
}
exports.SecretBox = SecretBox;
//# sourceMappingURL=secret-box.js.map