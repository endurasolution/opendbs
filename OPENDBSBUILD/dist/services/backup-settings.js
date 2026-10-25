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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackupSettingsStore = void 0;
exports.maskBackupConfig = maskBackupConfig;
exports.validateBackupInput = validateBackupInput;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const cron = __importStar(require("node-cron"));
const security_middleware_1 = require("../middleware/security.middleware");
/**
 * Backup settings edited from the admin panel. They are stored in
 * <DB_PATH>/.config/backup.json (credentials sealed with SecretBox) and
 * override the BACKUP_* values from .env. Changes apply immediately -- no
 * restart -- by reconfiguring the backup service and rescheduling the job.
 *
 * The backup *directory* is deliberately not editable from the browser: a
 * stolen admin session must not be able to point full-database dumps at a
 * publicly served folder.
 */
class BackupSettingsStore {
    box;
    file;
    constructor(dataPath, box) {
        this.box = box;
        this.file = path_1.default.join(dataPath, '.config', 'backup.json');
    }
    load(defaults) {
        let stored;
        try {
            stored = JSON.parse(fs_1.default.readFileSync(this.file, 'utf-8'));
        }
        catch {
            return defaults;
        }
        const cfg = { ...defaults, ...pick(stored, ['enabled', 'schedule', 'retentionDays', 'type']) };
        if (stored.s3) {
            cfg.s3 = { ...stored.s3, secretKey: stored.s3.secretKeySealed ? this.box.open(stored.s3.secretKeySealed) : '' };
            delete cfg.s3.secretKeySealed;
        }
        if (stored.ftp) {
            cfg.ftp = { ...stored.ftp, password: stored.ftp.passwordSealed ? this.box.open(stored.ftp.passwordSealed) : '' };
            delete cfg.ftp.passwordSealed;
        }
        return cfg;
    }
    save(cfg) {
        const out = pick(cfg, ['enabled', 'schedule', 'retentionDays', 'type']);
        if (cfg.s3) {
            const { secretKey, ...rest } = cfg.s3;
            out.s3 = { ...rest, secretKeySealed: secretKey ? this.box.seal(secretKey) : '' };
        }
        if (cfg.ftp) {
            const { password, ...rest } = cfg.ftp;
            out.ftp = { ...rest, passwordSealed: password ? this.box.seal(password) : '' };
        }
        fs_1.default.mkdirSync(path_1.default.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs_1.default.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
        fs_1.default.renameSync(tmp, this.file);
    }
}
exports.BackupSettingsStore = BackupSettingsStore;
function pick(obj, keys) {
    const out = {};
    for (const k of keys)
        if (obj && obj[k] !== undefined)
            out[k] = obj[k];
    return out;
}
/** Config as shown to the browser: secrets replaced by "***" when set. */
function maskBackupConfig(cfg) {
    return {
        enabled: cfg.enabled,
        schedule: cfg.schedule,
        retentionDays: cfg.retentionDays,
        type: cfg.type,
        path: cfg.path,
        s3: cfg.s3 ? { ...cfg.s3, secretKey: cfg.s3.secretKey ? security_middleware_1.MASKED_VALUE : '' } : null,
        ftp: cfg.ftp ? { ...cfg.ftp, password: cfg.ftp.password ? security_middleware_1.MASKED_VALUE : '' } : null,
    };
}
const str = (v, field, { max = 512, required = false } = {}) => {
    if (v === undefined || v === null) {
        if (required)
            throw new Error(`${field} is required`);
        return '';
    }
    if (typeof v !== 'string' || v.length > max || /[\r\n\0]/.test(v))
        throw new Error(`${field} is invalid`);
    const s = v.trim();
    if (required && !s)
        throw new Error(`${field} is required`);
    return s;
};
/**
 * Validates an update from the browser and merges it over `current`.
 * A secret sent back as "***" keeps the stored value.
 */
function validateBackupInput(input, current) {
    if (!(0, security_middleware_1.isPlainObject)(input))
        throw new Error('Body must be an object');
    const next = { ...current };
    if (input.enabled !== undefined)
        next.enabled = Boolean(input.enabled);
    if (input.schedule !== undefined) {
        const s = str(input.schedule, 'schedule', { max: 100, required: true });
        if (!cron.validate(s))
            throw new Error(`"${s}" is not a valid cron expression (e.g. "0 2 * * *" = every day at 02:00)`);
        next.schedule = s;
    }
    if (input.retentionDays !== undefined) {
        const n = Number(input.retentionDays);
        if (!Number.isInteger(n) || n < 1 || n > 3650)
            throw new Error('retentionDays must be a whole number from 1 to 3650');
        next.retentionDays = n;
    }
    if (input.type !== undefined) {
        if (!['local', 's3', 'ftp'].includes(input.type))
            throw new Error('type must be local, s3 or ftp');
        next.type = input.type;
    }
    if (input.s3 !== undefined && input.s3 !== null) {
        if (!(0, security_middleware_1.isPlainObject)(input.s3))
            throw new Error('s3 must be an object');
        const s = input.s3;
        const prev = current.s3;
        const endpoint = str(s.endpoint, 's3.endpoint');
        if (endpoint && !/^https?:\/\/[^\s]+$/.test(endpoint))
            throw new Error('s3.endpoint must be an http(s) URL');
        next.s3 = {
            bucket: str(s.bucket, 's3.bucket', { max: 255 }),
            region: str(s.region, 's3.region', { max: 64 }) || 'us-east-1',
            accessKey: str(s.accessKey, 's3.accessKey', { max: 256 }),
            secretKey: s.secretKey === security_middleware_1.MASKED_VALUE ? prev?.secretKey ?? '' : str(s.secretKey, 's3.secretKey', { max: 512 }),
            endpoint: endpoint || undefined,
            prefix: str(s.prefix, 's3.prefix', { max: 200 }).replace(/^\/+|\/+$/g, '') || 'backups',
            forcePathStyle: Boolean(s.forcePathStyle),
        };
    }
    if (input.ftp !== undefined && input.ftp !== null) {
        if (!(0, security_middleware_1.isPlainObject)(input.ftp))
            throw new Error('ftp must be an object');
        const f = input.ftp;
        const prev = current.ftp;
        const port = f.port === undefined || f.port === '' ? 21 : Number(f.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error('ftp.port must be 1–65535');
        const dir = str(f.dir, 'ftp.dir', { max: 200 }) || '/backups';
        if (dir.includes('..'))
            throw new Error('ftp.dir must not contain ".."');
        next.ftp = {
            host: str(f.host, 'ftp.host', { max: 255 }),
            port,
            user: str(f.user, 'ftp.user', { max: 128 }),
            password: f.password === security_middleware_1.MASKED_VALUE ? prev?.password ?? '' : str(f.password, 'ftp.password', { max: 256 }),
            secure: Boolean(f.secure),
            dir: dir.startsWith('/') ? dir : `/${dir}`,
        };
    }
    if (next.type === 's3' && (!next.s3?.bucket || !next.s3.accessKey || !next.s3.secretKey)) {
        throw new Error('S3 needs a bucket, access key and secret key');
    }
    if (next.type === 'ftp' && (!next.ftp?.host || !next.ftp.user)) {
        throw new Error('FTP needs a host and user');
    }
    return next;
}
//# sourceMappingURL=backup-settings.js.map