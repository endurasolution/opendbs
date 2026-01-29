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
exports.BackupScheduler = void 0;
const cron = __importStar(require("node-cron"));
class BackupScheduler {
    config;
    backupService;
    dataPath;
    task;
    constructor(config, backupService, dataPath) {
        this.config = config;
        this.backupService = backupService;
        this.dataPath = dataPath;
    }
    start() {
        if (!this.config.enabled) {
            console.log('📦 Scheduled backups: DISABLED');
            return;
        }
        // Validate cron expression
        if (!cron.validate(this.config.schedule)) {
            console.error(`❌ Invalid backup schedule: ${this.config.schedule}`);
            console.log('📦 Scheduled backups: DISABLED (invalid schedule)');
            return;
        }
        console.log(`📦 Scheduled backups: ENABLED`);
        console.log(`   Schedule: ${this.config.schedule}`);
        console.log(`   Type: ${this.config.type}`);
        console.log(`   Retention: ${this.config.retentionDays} days`);
        this.task = cron.schedule(this.config.schedule, async () => {
            try {
                console.log('🔄 Starting scheduled backup...');
                // Get all databases
                const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                const databases = [];
                if (fs.existsSync(this.dataPath)) {
                    const items = fs.readdirSync(this.dataPath);
                    databases.push(...items.filter(item => {
                        const itemPath = path.join(this.dataPath, item);
                        return fs.statSync(itemPath).isDirectory();
                    }));
                }
                if (databases.length === 0) {
                    console.log('⚠️  No databases to backup');
                    return;
                }
                const backupName = await this.backupService.createBackup(this.dataPath, databases);
                console.log(`✅ Scheduled backup completed: ${backupName}`);
            }
            catch (error) {
                console.error('❌ Scheduled backup failed:', error);
            }
        });
    }
    stop() {
        if (this.task) {
            this.task.stop();
            console.log('📦 Scheduled backups: STOPPED');
        }
    }
}
exports.BackupScheduler = BackupScheduler;
//# sourceMappingURL=backup-scheduler.js.map