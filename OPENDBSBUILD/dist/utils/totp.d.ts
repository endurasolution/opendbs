export declare function base32Encode(buf: Buffer): string;
export declare function base32Decode(s: string): Buffer;
export declare function generateTotpSecret(): string;
export declare function currentStep(now?: number): number;
export declare function totpAt(secret: string, step: number): string;
/**
 * Returns the matching time step (±1 step of clock drift), or null. Steps
 * at or before `lastUsedStep` are rejected so a code can't be replayed.
 */
export declare function verifyTotp(secret: string, code: string, lastUsedStep?: number, now?: number): number | null;
export declare function otpauthUrl(issuer: string, account: string, secret: string): string;
/** Human-friendly one-time recovery codes, e.g. "k3f9-2mxq". */
export declare function generateRecoveryCodes(n?: number): string[];
//# sourceMappingURL=totp.d.ts.map