export declare class Cipher {
    readonly fingerprint: string;
    private readonly key;
    private ivPool;
    private ivPos;
    constructor(rawKey: Buffer);
    /** A separate 32-byte key for another purpose (e.g. the disk store), derived with HKDF. */
    subkeyHex(purpose: string): string;
    private nextIv;
    seal(plain: Buffer): Buffer;
    open(sealed: Buffer): Buffer;
}
export declare class EncryptionKeyError extends Error {
}
export declare function isSealed(buf: Buffer): boolean;
export interface EncryptionStatus {
    enabled: boolean;
    source: 'env' | 'file' | 'generated-file' | 'disabled';
    keyFile: string | null;
    fingerprint: string | null;
}
export declare function resolveEncryption(): {
    cipher: Cipher | null;
    status: EncryptionStatus;
};
//# sourceMappingURL=encryption.d.ts.map