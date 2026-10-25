export interface AuditEvent {
    ts: string;
    action: string;
    actor?: string;
    ip?: string;
    target?: string;
    ok: boolean;
    detail?: string;
}
/**
 * Append-only audit trail of security-relevant actions (logins, user and
 * permission changes, destructive operations, restores, settings edits).
 * Kept in a ring buffer for the admin panel and appended as JSON lines to
 * <DB_PATH>/.audit/audit.log, rotated to audit.log.1 at 10 MB.
 */
export declare class AuditService {
    private events;
    private readonly file;
    constructor(dataPath: string);
    private loadTail;
    record(event: Omit<AuditEvent, 'ts'>): void;
    list(limit?: number, filter?: string): AuditEvent[];
}
//# sourceMappingURL=audit.service.d.ts.map