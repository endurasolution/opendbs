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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
const util_1 = require("util");
const client_s3_1 = require("@aws-sdk/client-s3");
const basic_ftp_1 = require("basic-ftp");
const gzip = (0, util_1.promisify)(zlib.gzip);
const gunzip = (0, util_1.promisify)(zlib.gunzip);
class BackupService {
    config;
    s3Client;
    constructor(config) {
        this.config = config;
        if (config.type === 's3' && config.s3) {
            this.s3Client = new client_s3_1.S3Client({
                region: config.s3.region,
                credentials: {
                    accessKeyId: config.s3.accessKey,
                    secretAccessKey: config.s3.secretKey,
                },
            });
        }
        // Ensure backup directory exists
        if (!fs.existsSync(config.path)) {
            fs.mkdirSync(config.path, { recursive: true });
        }
    }
    async createBackup(dataPath, databases, userId) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = userId
            ? `backup_user_${userId}_${timestamp}.tar.gz`
            : `backup_full_${timestamp}.tar.gz`;
        const backupPath = path.join(this.config.path, backupName);
        // Create backup manifest
        const manifest = {
            timestamp: new Date().toISOString(),
            databases,
            userId: userId || 'admin',
            version: '1.0',
        };
        // Collect all data
        const backupData = {
            manifest,
            data: {},
        };
        for (const dbName of databases) {
            const dbPath = path.join(dataPath, dbName);
            if (!fs.existsSync(dbPath))
                continue;
            backupData.data[dbName] = {};
            const files = fs.readdirSync(dbPath);
            for (const file of files) {
                if (file.endsWith('.odbs')) {
                    const filePath = path.join(dbPath, file);
                    const content = fs.readFileSync(filePath);
                    backupData.data[dbName][file] = content.toString('base64');
                }
            }
        }
        // Compress and save
        const jsonData = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonData));
        fs.writeFileSync(backupPath, compressed);
        // Upload to remote if configured
        if (this.config.type !== 'local') {
            await this.uploadBackup(backupPath, backupName);
        }
        // Cleanup old backups
        await this.cleanupOldBackups();
        return backupName;
    }
    async restoreBackup(backupName, dataPath) {
        let backupPath = path.join(this.config.path, backupName);
        // Download from remote if needed
        if (this.config.type !== 'local' && !fs.existsSync(backupPath)) {
            await this.downloadBackup(backupName, backupPath);
        }
        if (!fs.existsSync(backupPath)) {
            throw new Error('Backup file not found');
        }
        // Decompress and parse
        const compressed = fs.readFileSync(backupPath);
        const decompressed = await gunzip(compressed);
        const backupData = JSON.parse(decompressed.toString());
        const restoredDbs = [];
        let fileCount = 0;
        // Restore data
        for (const dbName in backupData.data) {
            const dbPath = path.join(dataPath, dbName);
            if (!fs.existsSync(dbPath)) {
                fs.mkdirSync(dbPath, { recursive: true });
            }
            for (const fileName in backupData.data[dbName]) {
                const filePath = path.join(dbPath, fileName);
                const content = Buffer.from(backupData.data[dbName][fileName], 'base64');
                fs.writeFileSync(filePath, content);
                fileCount++;
            }
            restoredDbs.push(dbName);
        }
        return { databases: restoredDbs, count: fileCount };
    }
    async listBackups() {
        const files = fs.readdirSync(this.config.path);
        const backups = files
            .filter(f => f.startsWith('backup_') && f.endsWith('.tar.gz'))
            .map(f => {
            const stats = fs.statSync(path.join(this.config.path, f));
            return {
                name: f,
                size: stats.size,
                created: stats.birthtime,
            };
        })
            .sort((a, b) => b.created.getTime() - a.created.getTime());
        return backups;
    }
    async uploadBackup(localPath, fileName) {
        if (this.config.type === 's3' && this.s3Client && this.config.s3) {
            const fileContent = fs.readFileSync(localPath);
            const command = new client_s3_1.PutObjectCommand({
                Bucket: this.config.s3.bucket,
                Key: `backups/${fileName}`,
                Body: fileContent,
            });
            await this.s3Client.send(command);
        }
        else if (this.config.type === 'ftp' && this.config.ftp) {
            const client = new basic_ftp_1.Client();
            try {
                await client.access({
                    host: this.config.ftp.host,
                    port: this.config.ftp.port,
                    user: this.config.ftp.user,
                    password: this.config.ftp.password,
                });
                await client.uploadFrom(localPath, `/backups/${fileName}`);
            }
            finally {
                client.close();
            }
        }
    }
    async downloadBackup(fileName, localPath) {
        if (this.config.type === 'ftp' && this.config.ftp) {
            const client = new basic_ftp_1.Client();
            try {
                await client.access({
                    host: this.config.ftp.host,
                    port: this.config.ftp.port,
                    user: this.config.ftp.user,
                    password: this.config.ftp.password,
                });
                await client.downloadTo(localPath, `/backups/${fileName}`);
            }
            finally {
                client.close();
            }
        }
        // S3 download would go here
    }
    async cleanupOldBackups() {
        const backups = await this.listBackups();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
        for (const backup of backups) {
            if (backup.created < cutoffDate) {
                const filePath = path.join(this.config.path, backup.name);
                fs.unlinkSync(filePath);
            }
        }
    }
}
exports.BackupService = BackupService;
//# sourceMappingURL=backup.service.js.map