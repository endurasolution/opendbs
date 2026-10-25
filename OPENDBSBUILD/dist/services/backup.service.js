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
exports.BackupService = void 0;
exports.isValidBackupName = isValidBackupName;
exports.backupKind = backupKind;
exports.isBackupOwnedBy = isBackupOwnedBy;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
const client_s3_1 = require("@aws-sdk/client-s3");
const basic_ftp_1 = require("basic-ftp");
const security_middleware_1 = require("../middleware/security.middleware");
const version_1 = require("../version");
const gzipAsync = (buf) => new Promise((resolve, reject) => zlib.gzip(buf, (e, out) => (e ? reject(e) : resolve(out))));
// Decompression-bomb guard for restores.
const MAX_RESTORE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const gunzipAsync = (buf) => new Promise((resolve, reject) => zlib.gunzip(buf, { maxOutputLength: MAX_RESTORE_BYTES }, (e, out) => (e ? reject(e) : resolve(out))));
const BACKUP_NAME_RE = /^backup_[a-zA-Z0-9_-]+\.tar\.gz$/;
function isValidBackupName(name) {
    return typeof name === 'string' && name.length <= 200 && BACKUP_NAME_RE.test(name);
}
/** full | user | upload | prerestore — derived from the file name. */
function backupKind(name) {
    const m = /^backup_(full|user|upload|prerestore)_/.exec(name);
    return m ? m[1] : 'other';
}
/** Exact-prefix ownership check (the old substring check let user 1 read user 12's backups). */
function isBackupOwnedBy(name, userId) {
    return name.startsWith(`backup_user_${userId}_`);
}
class BackupService {
    config;
    s3Client;
    engine;
    busy = false;
    constructor(config, engine) {
        this.config = config;
        this.engine = engine;
        this.reconfigure(config);
    }
    getConfig() {
        return this.config;
    }
    /** Applies new settings immediately (used by the admin panel). The backup path never changes at runtime. */
    reconfigure(config) {
        this.config = { ...config, path: this.config.path ?? config.path };
        this.s3Client = this.config.type === 's3' && this.config.s3 ? BackupService.makeS3(this.config.s3) : undefined;
        if (!fs.existsSync(this.config.path)) {
            fs.mkdirSync(this.config.path, { recursive: true });
        }
    }
    static makeS3(s3) {
        return new client_s3_1.S3Client({
            region: s3.region || 'us-east-1',
            endpoint: s3.endpoint || undefined,
            forcePathStyle: Boolean(s3.forcePathStyle),
            credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
        });
    }
    static s3Key(s3, fileName) {
        const prefix = (s3.prefix || 'backups').replace(/^\/+|\/+$/g, '');
        return prefix ? `${prefix}/${fileName}` : fileName;
    }
    static async ftpConnect(ftp) {
        const client = new basic_ftp_1.Client(30_000);
        await client.access({ host: ftp.host, port: ftp.port, user: ftp.user, password: ftp.password, secure: Boolean(ftp.secure) });
        return client;
    }
    /**
     * Checks that a destination is reachable and writable by uploading and
     * deleting a tiny marker file. Used by the admin panel's "Test" button.
     */
    async testDestination(cfg) {
        const marker = `.opendbs-test-${Date.now()}.txt`;
        const body = Buffer.from(`OpenDBS backup destination test ${new Date().toISOString()}\n`);
        if (cfg.type === 'local') {
            const p = path.join(this.config.path, marker);
            fs.writeFileSync(p, body);
            fs.unlinkSync(p);
            return `Local folder ${path.resolve(this.config.path)} is writable`;
        }
        if (cfg.type === 's3') {
            if (!cfg.s3)
                throw new Error('S3 is not configured');
            const client = BackupService.makeS3(cfg.s3);
            const Key = BackupService.s3Key(cfg.s3, marker);
            await client.send(new client_s3_1.PutObjectCommand({ Bucket: cfg.s3.bucket, Key, Body: body }));
            await client.send(new client_s3_1.DeleteObjectCommand({ Bucket: cfg.s3.bucket, Key }));
            return `Uploaded and removed a test file in s3://${cfg.s3.bucket}/${Key}`;
        }
        if (cfg.type === 'ftp') {
            if (!cfg.ftp)
                throw new Error('FTP is not configured');
            const client = await BackupService.ftpConnect(cfg.ftp);
            try {
                const dir = cfg.ftp.dir || '/backups';
                await client.ensureDir(dir);
                const tmp = path.join(this.config.path, marker);
                fs.writeFileSync(tmp, body);
                try {
                    await client.uploadFrom(tmp, marker);
                    await client.remove(marker);
                }
                finally {
                    fs.rmSync(tmp, { force: true });
                }
                return `Connected to ${cfg.ftp.host} and wrote to ${dir}`;
            }
            finally {
                client.close();
            }
        }
        throw new Error(`Unsupported destination '${cfg.type}'`);
    }
    /**
     * kind: 'full' (scheduled/manual) or 'prerestore' (automatic safety copy
     * taken right before a restore). Per-user backups are named by user id.
     */
    async createBackup(dataPath, databases, userId, kind = 'full') {
        if (userId !== undefined && !/^[0-9a-zA-Z_-]{1,64}$/.test(userId))
            throw new Error('Invalid user id');
        // Fold pending WAL writes into snapshots so the .odbs files are current.
        this.engine?.flushAll();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = userId
            ? `backup_user_${userId}_${timestamp}.tar.gz`
            : `backup_${kind}_${timestamp}.tar.gz`;
        const backupPath = path.join(this.config.path, backupName);
        const dbs = databases.filter(security_middleware_1.validateIdentifier);
        // Create backup manifest
        const manifest = {
            timestamp: new Date().toISOString(),
            databases: dbs,
            userId: userId || 'admin',
            version: '2.0', // backup file format
            appVersion: version_1.VERSION.version, // OpenDBS version that wrote it
            kind: userId ? 'user' : kind,
        };
        // Collect all data
        const backupData = {
            manifest,
            data: {},
        };
        const viaEngine = Boolean(this.engine?.usesDiskStorage?.() && this.engine.exportDatabase);
        for (const dbName of dbs) {
            if (viaEngine) {
                backupData.data[dbName] = {};
                for (const f of this.engine.exportDatabase(dbName))
                    backupData.data[dbName][f.fileName] = f.content.toString('base64');
                continue;
            }
            const dbPath = path.join(dataPath, dbName);
            if (!fs.existsSync(dbPath))
                continue;
            backupData.data[dbName] = {};
            for (const file of fs.readdirSync(dbPath)) {
                if (file.endsWith('.odbs') && (0, security_middleware_1.validateIdentifier)(path.basename(file, '.odbs'))) {
                    const content = fs.readFileSync(path.join(dbPath, file));
                    backupData.data[dbName][file] = content.toString('base64');
                }
            }
        }
        // Compress and save
        const compressed = await gzipAsync(Buffer.from(JSON.stringify(backupData)));
        fs.writeFileSync(backupPath, compressed, { mode: 0o600 });
        // Upload to remote if configured
        if (this.config.type !== 'local') {
            await this.uploadBackup(backupPath, backupName);
        }
        // Cleanup old backups
        await this.cleanupOldBackups();
        return backupName;
    }
    /**
     * Decompresses and validates a backup without touching the data
     * directory. Every database / file name is checked (path-traversal guard).
     */
    async parseBackup(buf, verify = true) {
        let backupData;
        try {
            backupData = JSON.parse((await gunzipAsync(buf)).toString());
        }
        catch {
            throw new Error('Not an OpenDBS backup file (expected gzip-compressed JSON)');
        }
        if (!backupData || typeof backupData.data !== 'object' || backupData.data === null || Array.isArray(backupData.data)) {
            throw new Error('Backup file is malformed');
        }
        const databases = {};
        for (const dbName of Object.keys(backupData.data)) {
            if (!(0, security_middleware_1.validateIdentifier)(dbName))
                throw new Error(`Backup contains invalid database name '${dbName}'`);
            const files = backupData.data[dbName];
            if (!files || typeof files !== 'object')
                continue;
            databases[dbName] = [];
            for (const fileName of Object.keys(files)) {
                if (!fileName.endsWith('.odbs') || !(0, security_middleware_1.validateIdentifier)(path.basename(fileName, '.odbs'))) {
                    throw new Error(`Backup contains invalid file name '${fileName}'`);
                }
                if (typeof files[fileName] !== 'string')
                    throw new Error(`Backup entry '${fileName}' is malformed`);
                databases[dbName].push({ fileName, content: Buffer.from(files[fileName], 'base64') });
            }
        }
        // Every rack file must be readable here (right encryption key, not corrupted)
        // before a restore is allowed to replace anything.
        if (verify && this.engine?.verifySnapshot) {
            for (const [db, files] of Object.entries(databases)) {
                for (const f of files) {
                    try {
                        this.engine.verifySnapshot(f.content);
                    }
                    catch (e) {
                        throw new Error(`${db}/${f.fileName} can't be read on this server: ${e.message}. ` +
                            'Backups of encrypted data need the same encryption key (DB_ENCRYPTION_KEY / opendbs.key) as the server that made them.');
                    }
                }
            }
        }
        const m = backupData.manifest && typeof backupData.manifest === 'object' ? backupData.manifest : {};
        return {
            manifest: {
                timestamp: typeof m.timestamp === 'string' ? m.timestamp : null,
                formatVersion: typeof m.version === 'string' ? m.version : '1.0',
                appVersion: typeof m.appVersion === 'string' ? m.appVersion : null,
                kind: typeof m.kind === 'string' ? m.kind : null,
                createdBy: typeof m.userId === 'string' ? m.userId : null,
            },
            databases,
        };
    }
    async loadBackup(backupName) {
        if (!isValidBackupName(backupName))
            throw new Error('Invalid backup name');
        const backupPath = path.join(this.config.path, backupName);
        if (!fs.existsSync(backupPath))
            throw new Error('Backup file not found');
        return this.parseBackup(fs.readFileSync(backupPath), false);
    }
    /** What's inside a backup: manifest plus databases → racks with sizes. */
    async getBackupContents(backupName) {
        const parsed = await this.loadBackup(backupName);
        const stats = fs.statSync(path.join(this.config.path, backupName));
        return {
            name: backupName,
            size: stats.size,
            created: stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime,
            manifest: parsed.manifest,
            databases: Object.entries(parsed.databases).map(([name, files]) => ({
                name,
                racks: files.map((f) => ({ name: path.basename(f.fileName, '.odbs'), bytes: f.content.length })),
            })),
        };
    }
    /**
     * Restores a backup.
     *  - databases: only restore these (default: everything in the backup)
     *  - replace (default true): racks that exist now but not in the backup
     *    are removed from the restored databases, so each database matches
     *    the backup exactly. false = merge (keep racks created later).
     *  - safetyBackup (default true): first take a 'prerestore' backup of the
     *    current data so the restore itself can be undone.
     */
    async restoreBackup(backupName, dataPath, options = {}) {
        if (!isValidBackupName(backupName))
            throw new Error('Invalid backup name');
        if (this.busy)
            throw new Error('Another restore is already in progress');
        this.busy = true;
        try {
            const backupPath = path.join(this.config.path, backupName);
            // Download from remote if needed
            if (this.config.type !== 'local' && !fs.existsSync(backupPath)) {
                await this.downloadBackup(backupName, backupPath);
            }
            if (!fs.existsSync(backupPath)) {
                throw new Error('Backup file not found');
            }
            // Decompress, parse and validate everything *before* touching the data directory.
            const parsed = await this.parseBackup(fs.readFileSync(backupPath));
            const available = Object.keys(parsed.databases);
            let selected = available;
            if (options.databases !== undefined) {
                if (!Array.isArray(options.databases) || options.databases.length === 0)
                    throw new Error('Choose at least one database to restore');
                const missing = options.databases.filter((d) => !available.includes(d));
                if (missing.length)
                    throw new Error(`Not in this backup: ${missing.join(', ')}`);
                selected = options.databases;
            }
            const replace = options.replace !== false;
            // Safety net: snapshot the current state of everything first.
            let safetyBackup = null;
            if (options.safetyBackup !== false) {
                const current = fs.readdirSync(dataPath).filter((d) => (0, security_middleware_1.validateIdentifier)(d) && fs.statSync(path.join(dataPath, d)).isDirectory());
                if (current.length > 0)
                    safetyBackup = await this.createBackup(dataPath, current, undefined, 'prerestore');
            }
            let count = 0;
            let removedRacks = 0;
            // Disk storage engine: the engine imports the snapshots into its store itself.
            if (this.engine?.usesDiskStorage?.() && this.engine.restoreDatabase) {
                for (const dbName of selected) {
                    const r = this.engine.restoreDatabase(dbName, parsed.databases[dbName], replace);
                    count += r.count;
                    removedRacks += r.removed;
                }
                return { databases: selected, count, removedRacks, safetyBackup };
            }
            // Detach the live engine so in-flight snapshots can't overwrite restored files.
            this.engine?.suspendForRestore();
            try {
                const root = path.resolve(dataPath);
                for (const dbName of selected) {
                    const dbPath = path.join(root, dbName);
                    if (path.dirname(dbPath) !== root)
                        throw new Error('Refusing to write outside the data directory');
                    fs.mkdirSync(dbPath, { recursive: true });
                    const keep = new Set(parsed.databases[dbName].map((f) => path.basename(f.fileName, '.odbs')));
                    for (const f of fs.readdirSync(dbPath)) {
                        const rack = f.split('.')[0];
                        // Drop WALs of restored racks (post-backup writes must not be replayed onto
                        // the restored snapshot) and, in replace mode, racks the backup doesn't have.
                        if (f.endsWith('.wal') && (keep.has(rack) || replace))
                            fs.unlinkSync(path.join(dbPath, f));
                        else if (replace && f.endsWith('.odbs') && !keep.has(rack)) {
                            fs.unlinkSync(path.join(dbPath, f));
                            removedRacks++;
                        }
                    }
                    for (const { fileName, content } of parsed.databases[dbName]) {
                        const filePath = path.join(dbPath, fileName);
                        if (path.dirname(path.resolve(filePath)) !== path.resolve(dbPath)) {
                            throw new Error('Refusing to write outside the data directory');
                        }
                        const tmp = `${filePath}.tmp-restore`;
                        fs.writeFileSync(tmp, content);
                        fs.renameSync(tmp, filePath);
                        count++;
                    }
                }
            }
            finally {
                this.engine?.reloadFromDisk();
            }
            return { databases: selected, count, removedRacks, safetyBackup };
        }
        finally {
            this.busy = false;
        }
    }
    /** Stores an uploaded backup file after validating it fully. Returns its new name. */
    async importBackup(buf) {
        if (!Buffer.isBuffer(buf) || buf.length === 0)
            throw new Error('Empty upload');
        await this.parseBackup(buf); // throws on anything that isn't a valid backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = `backup_upload_${timestamp}.tar.gz`;
        fs.writeFileSync(path.join(this.config.path, name), buf, { mode: 0o600 });
        return name;
    }
    deleteBackup(backupName) {
        if (!isValidBackupName(backupName))
            throw new Error('Invalid backup name');
        const p = path.join(this.config.path, backupName);
        if (!fs.existsSync(p))
            return false;
        fs.unlinkSync(p);
        return true;
    }
    async listBackups() {
        const files = fs.readdirSync(this.config.path);
        const backups = files
            .filter((f) => isValidBackupName(f))
            .map(f => {
            const stats = fs.statSync(path.join(this.config.path, f));
            return {
                name: f,
                size: stats.size,
                // birthtime is 0 on some Linux filesystems
                created: stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime,
                kind: backupKind(f),
            };
        })
            .sort((a, b) => b.created.getTime() - a.created.getTime());
        return backups;
    }
    /** Backups stored at the configured S3/FTP destination. */
    async listRemoteBackups() {
        const local = new Set(fs.readdirSync(this.config.path));
        if (this.config.type === 's3' && this.s3Client && this.config.s3) {
            const prefix = BackupService.s3Key(this.config.s3, '');
            const out = [];
            let token;
            do {
                const res = await this.s3Client.send(new client_s3_1.ListObjectsV2Command({ Bucket: this.config.s3.bucket, Prefix: prefix, ContinuationToken: token }));
                for (const o of res.Contents ?? []) {
                    const name = (o.Key ?? '').slice(prefix.length);
                    if (isValidBackupName(name))
                        out.push({ name, size: o.Size ?? 0, created: o.LastModified ?? null, local: local.has(name) });
                }
                token = res.IsTruncated ? res.NextContinuationToken : undefined;
            } while (token && out.length < 5000);
            return out.sort((a, b) => (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0));
        }
        if (this.config.type === 'ftp' && this.config.ftp) {
            const client = await BackupService.ftpConnect(this.config.ftp);
            try {
                const list = await client.list(this.config.ftp.dir || '/backups');
                return list
                    .filter((f) => f.isFile && isValidBackupName(f.name))
                    .map((f) => ({ name: f.name, size: f.size, created: f.modifiedAt ?? null, local: local.has(f.name) }))
                    .sort((a, b) => (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0));
            }
            finally {
                client.close();
            }
        }
        throw new Error('No remote destination configured (backups are stored locally only)');
    }
    /** Copies a remote backup to the local backup folder so it can be inspected and restored. */
    async fetchRemoteBackup(backupName) {
        if (!isValidBackupName(backupName))
            throw new Error('Invalid backup name');
        if (this.config.type === 'local')
            throw new Error('No remote destination configured');
        const dest = path.join(this.config.path, backupName);
        if (fs.existsSync(dest))
            return backupName;
        const tmp = `${dest}.download`;
        try {
            await this.downloadBackup(backupName, tmp);
            await this.parseBackup(fs.readFileSync(tmp)); // never keep an invalid file
            fs.renameSync(tmp, dest);
        }
        finally {
            fs.rmSync(tmp, { force: true });
        }
        return backupName;
    }
    getBackupPath(backupName) {
        if (!isValidBackupName(backupName))
            return null;
        const p = path.join(this.config.path, backupName);
        return fs.existsSync(p) ? p : null;
    }
    async uploadBackup(localPath, fileName) {
        if (this.config.type === 's3' && this.s3Client && this.config.s3) {
            await this.s3Client.send(new client_s3_1.PutObjectCommand({
                Bucket: this.config.s3.bucket,
                Key: BackupService.s3Key(this.config.s3, fileName),
                Body: fs.readFileSync(localPath),
            }));
        }
        else if (this.config.type === 'ftp' && this.config.ftp) {
            const client = await BackupService.ftpConnect(this.config.ftp);
            try {
                await client.ensureDir(this.config.ftp.dir || '/backups');
                await client.uploadFrom(localPath, fileName);
            }
            finally {
                client.close();
            }
        }
    }
    async downloadBackup(fileName, localPath) {
        if (this.config.type === 'ftp' && this.config.ftp) {
            const client = await BackupService.ftpConnect(this.config.ftp);
            try {
                await client.cd(this.config.ftp.dir || '/backups');
                await client.downloadTo(localPath, fileName);
            }
            finally {
                client.close();
            }
        }
        else if (this.config.type === 's3' && this.s3Client && this.config.s3) {
            const res = await this.s3Client.send(new client_s3_1.GetObjectCommand({
                Bucket: this.config.s3.bucket,
                Key: BackupService.s3Key(this.config.s3, fileName),
            }));
            const bytes = await res.Body?.transformToByteArray();
            if (!bytes)
                throw new Error('Backup not found in S3');
            if (bytes.length > MAX_RESTORE_BYTES)
                throw new Error('Backup too large');
            fs.writeFileSync(localPath, Buffer.from(bytes), { mode: 0o600 });
        }
    }
    async cleanupOldBackups() {
        const backups = await this.listBackups();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
        for (const backup of backups) {
            if (backup.created < cutoffDate) {
                try {
                    fs.unlinkSync(path.join(this.config.path, backup.name));
                }
                catch { /* ignore */ }
            }
        }
    }
}
exports.BackupService = BackupService;
//# sourceMappingURL=backup.service.js.map