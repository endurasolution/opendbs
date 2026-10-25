/**
 * Encrypts small secrets at rest (TOTP seeds, backup-destination
 * credentials) with AES-256-GCM under a random master key kept in
 * <DB_PATH>/.master.key. The key is deliberately separate from JWT_SECRET
 * (rotating that must not lock anyone out of 2FA) and is never included in
 * backups, so a leaked backup file doesn't leak these secrets.
 */
export declare class SecretBox {
    private key;
    private readonly file;
    constructor(dataPath: string);
    /** Hex master key (cluster members share it so replicated 2FA secrets open everywhere). */
    keyHex(): string;
    /** Adopts another node's master key (cluster join) and stores it. */
    setKeyHex(hex: string): void;
    seal(plain: string): string;
    open(blob: string): string;
}
//# sourceMappingURL=secret-box.d.ts.map