"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const MAX_MEMORY_EVENTS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Append-only audit trail of security-relevant actions (logins, user and
 * permission changes, destructive operations, restores, settings edits).
 * Kept in a ring buffer for the admin panel and appended as JSON lines to
 * <DB_PATH>/.audit/audit.log, rotated to audit.log.1 at 10 MB.
 */
class AuditService {
    events = [];
    file;
    constructor(dataPath) {
        const dir = path_1.default.join(dataPath, '.audit');
        fs_1.default.mkdirSync(dir, { recursive: true });
        this.file = path_1.default.join(dir, 'audit.log');
        this.loadTail();
    }
    loadTail() {
        try {
            const lines = fs_1.default.readFileSync(this.file, 'utf-8').split('\n').filter(Boolean);
            for (const line of lines.slice(-MAX_MEMORY_EVENTS)) {
                try {
                    this.events.push(JSON.parse(line));
                }
                catch { /* skip torn line */ }
            }
        }
        catch { /* no log yet */ }
    }
    record(event) {
        const full = { ts: new Date().toISOString(), ...event };
        // Bound attacker-controlled strings (e.g. attempted usernames).
        for (const k of ['actor', 'target', 'detail']) {
            if (typeof full[k] === 'string' && full[k].length > 300)
                full[k] = full[k].slice(0, 300) + '…';
        }
        this.events.push(full);
        if (this.events.length > MAX_MEMORY_EVENTS)
            this.events.splice(0, this.events.length - MAX_MEMORY_EVENTS);
        try {
            try {
                if (fs_1.default.statSync(this.file).size > MAX_FILE_BYTES)
                    fs_1.default.renameSync(this.file, `${this.file}.1`);
            }
            catch { /* file doesn't exist yet */ }
            fs_1.default.appendFileSync(this.file, JSON.stringify(full) + '\n');
        }
        catch (err) {
            console.error('Failed to write audit log:', err);
        }
    }
    list(limit = 200, filter) {
        let out = this.events;
        if (filter) {
            const f = filter.toLowerCase();
            out = out.filter((e) => e.action.toLowerCase().includes(f) ||
                (e.actor ?? '').toLowerCase().includes(f) ||
                (e.target ?? '').toLowerCase().includes(f));
        }
        return out.slice(-Math.min(Math.max(1, limit), MAX_MEMORY_EVENTS)).reverse();
    }
}
exports.AuditService = AuditService;
//# sourceMappingURL=audit.service.js.map