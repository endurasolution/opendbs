import { Cipher } from './encryption';
export interface EncodedSnapshot {
    /** Uncompressed outer envelope; compress with compressSync/compressAsync. */
    envelope: Buffer;
}
export declare function encodeSnapshot(data: any): EncodedSnapshot;
export declare function compressSync(buf: Buffer): Buffer;
export declare function compressAsync(buf: Buffer): Promise<Buffer>;
export declare class IntegrityError extends Error {
}
/** Decodes any supported snapshot format back into the rack data object. */
export declare function decodeSnapshot(content: Buffer): any;
/** Write-then-rename so a crash mid-write never leaves a torn snapshot. */
export declare function writeFileAtomicSync(filePath: string, data: Buffer): void;
export declare function writeTempFile(filePath: string, data: Buffer, tag: string): Promise<string>;
export type WalRecord = {
    o: 'p';
    d: any;
} | {
    o: 'd';
    i: string;
} | {
    o: 'c';
};
export declare function walFileName(rack: string, gen: number): string;
/** Lists a rack's WAL files in a database directory as [gen, fullPath], ascending. */
export declare function listWalFiles(dbDir: string, rack: string): Array<[number, string]>;
/**
 * Reads WAL records. A torn final line (crash mid-append) is expected and
 * skipped; any other malformed line is skipped with a warning count so one
 * bad record can't make the whole rack unloadable.
 */
export declare function readWal(filePath: string, cipher?: Cipher | null): {
    records: WalRecord[];
    skipped: number;
    plaintext: boolean;
};
export declare function encodeWal(records: WalRecord[], cipher?: Cipher | null): string;
/** Encrypts a snapshot file body (after compression) when a cipher is configured. */
export declare function sealSnapshot(compressed: Buffer, cipher?: Cipher | null): Buffer;
/** Reverses sealSnapshot; tells the caller whether the file was encrypted. */
export declare function openSnapshot(content: Buffer, cipher?: Cipher | null): {
    body: Buffer;
    encrypted: boolean;
};
/** Removes leftover temp files from interrupted snapshot writes. */
export declare function cleanupTempFiles(dbDir: string): void;
//# sourceMappingURL=persistence.d.ts.map