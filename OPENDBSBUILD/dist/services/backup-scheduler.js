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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Runs scheduled backups. Reads its settings from the BackupService, so a
 * change saved in the admin panel only needs reschedule() -- no restart.
 */
class BackupScheduler {
    backupService;
    dataPath;
    task;
    running = false;
    lastRun = null;
    // The first parameter is kept for call-site compatibility; settings come from the service.
    constructor(_config, backupService, dataPath) {
        this.backupService = backupService;
        this.dataPath = dataPath;
    }
    start(quiet = false) {
        const cfg = this.backupService.getConfig();
        if (!cfg.enabled) {
            if (!quiet)
                console.log('📦 Scheduled backups: DISABLED');
            return;
        }
        if (!cron.validate(cfg.schedule)) {
            console.error(`❌ Invalid backup schedule: ${cfg.schedule}`);
            return;
        }
        if (!quiet) {
            console.log(`📦 Scheduled backups: ENABLED`);
            console.log(`   Schedule: ${cfg.schedule}`);
            console.log(`   Type: ${cfg.type}`);
            console.log(`   Retention: ${cfg.retentionDays} days`);
        }
        this.task = cron.schedule(cfg.schedule, () => {
            this.runNow('schedule').catch(() => undefined);
        });
    }
    /** Applies the service's current settings (call after reconfigure). */
    reschedule() {
        this.stop(true);
        this.start(true);
    }
    async runNow(trigger = 'manual') {
        if (this.running)
            throw new Error('A backup is already running');
        this.running = true;
        try {
            const databases = fs.existsSync(this.dataPath)
                ? fs.readdirSync(this.dataPath).filter((item) => fs.statSync(path.join(this.dataPath, item)).isDirectory())
                : [];
            if (databases.length === 0)
                throw new Error('No databases to backup');
            const backupName = await this.backupService.createBackup(this.dataPath, databases);
            this.lastRun = { at: new Date().toISOString(), ok: true, backupName, trigger };
            console.log(`✅ ${trigger === 'schedule' ? 'Scheduled' : 'Manual'} backup completed: ${backupName}`);
        }
        catch (error) {
            this.lastRun = { at: new Date().toISOString(), ok: false, error: error?.message ?? String(error), trigger };
            console.error('❌ Backup failed:', error);
        }
        finally {
            this.running = false;
        }
        return this.lastRun;
    }
    status() {
        const cfg = this.backupService.getConfig();
        let nextRun = null;
        try {
            const d = this.task?.getNextRun();
            nextRun = d ? d.toISOString() : null;
        }
        catch { /* not scheduled */ }
        return { enabled: cfg.enabled, scheduled: Boolean(this.task), nextRun, lastRun: this.lastRun, running: this.running };
    }
    stop(quiet = false) {
        if (this.task) {
            this.task.stop();
            this.task.destroy?.();
            this.task = undefined;
            if (!quiet)
                console.log('📦 Scheduled backups: STOPPED');
        }
    }
}
exports.BackupScheduler = BackupScheduler;
//# sourceMappingURL=backup-scheduler.js.map