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
exports.IntegrityError = void 0;
exports.encodeSnapshot = encodeSnapshot;
exports.compressSync = compressSync;
exports.compressAsync = compressAsync;
exports.decodeSnapshot = decodeSnapshot;
exports.writeFileAtomicSync = writeFileAtomicSync;
exports.writeTempFile = writeTempFile;
exports.walFileName = walFileName;
exports.listWalFiles = listWalFiles;
exports.readWal = readWal;
exports.encodeWal = encodeWal;
exports.sealSnapshot = sealSnapshot;
exports.openSnapshot = openSnapshot;
exports.cleanupTempFiles = cleanupTempFiles;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const zlib = __importStar(require("zlib"));
const msgpackr_1 = require("msgpackr");
const encryption_1 = require("./encryption");
/**
 * On-disk format helpers for rack snapshots (.odbs) and write-ahead logs
 * (.wal). The engine owns *when* things are written; this module owns
 * *how*, so the format details live in one place.
 *
 * Snapshot V2 layout (brotli-compressed msgpack):
 *   { signature: 'OPENDBS_V2', timestamp, encoding, hashAlgo: 'sha256',
 *     hash: sha256(payload), payload: <msgpack bytes of the rack data> }
 *
 * Hashing the packed payload bytes (instead of JSON.stringify of the whole
 * rack, as V1 did) makes integrity checking roughly an order of magnitude
 * cheaper and removes the JSON round-trip from the write path entirely.
 *
 * V1 files ({ signature: 'OPENDBS_V1', hash: sha256(JSON(data)), data }) and
 * plain-JSON files are still read transparently and upgraded on next write.
 */
const packer = new msgpackr_1.Packr();
const BROTLI_OPTS = {
    params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    },
};
function encodeSnapshot(data) {
    const payload = packer.pack(data);
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const envelope = packer.pack({
        signature: 'OPENDBS_V2',
        timestamp: Date.now(),
        encoding: 'msgpack+brotli',
        hashAlgo: 'sha256',
        hash,
        payload,
    });
    return { envelope };
}
function compressSync(buf) {
    return zlib.brotliCompressSync(buf, BROTLI_OPTS);
}
function compressAsync(buf) {
    return new Promise((resolve, reject) => zlib.brotliCompress(buf, BROTLI_OPTS, (err, out) => (err ? reject(err) : resolve(out))));
}
class IntegrityError extends Error {
}
exports.IntegrityError = IntegrityError;
/** Decodes any supported snapshot format back into the rack data object. */
function decodeSnapshot(content) {
    let outer;
    try {
        outer = packer.unpack(zlib.brotliDecompressSync(content));
    }
    catch {
        try {
            outer = JSON.parse(content.toString('utf-8'));
        }
        catch {
            throw new Error('Unknown snapshot format');
        }
    }
    if (outer && outer.signature === 'OPENDBS_V2') {
        const payload = Buffer.isBuffer(outer.payload) ? outer.payload : Buffer.from(outer.payload);
        const hash = crypto.createHash('sha256').update(payload).digest('hex');
        if (hash !== outer.hash)
            throw new IntegrityError('Snapshot hash mismatch');
        return packer.unpack(payload);
    }
    // V1 / legacy
    if (outer && outer.hash) {
        const calculated = crypto.createHash('sha256').update(JSON.stringify(outer.data)).digest('hex');
        if (calculated !== outer.hash)
            throw new IntegrityError('Snapshot hash mismatch');
    }
    return outer?.data ?? {};
}
/** Write-then-rename so a crash mid-write never leaves a torn snapshot. */
function writeFileAtomicSync(filePath, data) {
    const tmp = `${filePath}.tmp-sync`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
}
async function writeTempFile(filePath, data, tag) {
    const tmp = `${filePath}.tmp-${tag}`;
    const fh = await fs.promises.open(tmp, 'w');
    try {
        await fh.writeFile(data);
        await fh.sync();
    }
    finally {
        await fh.close();
    }
    return tmp;
}
const WAL_RE = /^([a-zA-Z0-9_][a-zA-Z0-9_-]*)\.(\d+)\.wal$/;
function walFileName(rack, gen) {
    return `${rack}.${gen}.wal`;
}
/** Lists a rack's WAL files in a database directory as [gen, fullPath], ascending. */
function listWalFiles(dbDir, rack) {
    let entries;
    try {
        entries = fs.readdirSync(dbDir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const f of entries) {
        const m = WAL_RE.exec(f);
        if (m && m[1] === rack)
            out.push([parseInt(m[2], 10), path.join(dbDir, f)]);
    }
    return out.sort((a, b) => a[0] - b[0]);
}
/**
 * Reads WAL records. A torn final line (crash mid-append) is expected and
 * skipped; any other malformed line is skipped with a warning count so one
 * bad record can't make the whole rack unloadable.
 */
function readWal(filePath, cipher) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const records = [];
    let skipped = 0;
    let plaintext = false;
    let start = 0;
    const parseLines = (chunk) => {
        for (const l of chunk.split('\n')) {
            if (!l)
                continue;
            try {
                records.push(JSON.parse(l));
            }
            catch {
                skipped++;
            }
        }
    };
    while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1)
            end = text.length;
        const line = text.slice(start, end);
        start = end + 1;
        if (!line)
            continue;
        if (line.startsWith('E:')) {
            // One encrypted line = one write batch (all-or-nothing, tamper-evident).
            if (!cipher)
                throw new encryption_1.EncryptionKeyError(`${path.basename(filePath)} is encrypted but no encryption key is configured`);
            try {
                parseLines(cipher.open(Buffer.from(line.slice(2), 'base64')).toString('utf-8'));
            }
            catch (e) {
                if (e instanceof encryption_1.EncryptionKeyError && start < text.length)
                    throw e; // wrong key (not just a torn tail)
                skipped++;
            }
            continue;
        }
        plaintext = true;
        try {
            records.push(JSON.parse(line));
        }
        catch {
            skipped++;
        }
    }
    return { records, skipped, plaintext };
}
function encodeWal(records, cipher) {
    let out = '';
    for (const r of records)
        out += JSON.stringify(r) + '\n';
    if (!cipher)
        return out;
    return 'E:' + cipher.seal(Buffer.from(out, 'utf-8')).toString('base64') + '\n';
}
/** Encrypts a snapshot file body (after compression) when a cipher is configured. */
function sealSnapshot(compressed, cipher) {
    return cipher ? cipher.seal(compressed) : compressed;
}
/** Reverses sealSnapshot; tells the caller whether the file was encrypted. */
function openSnapshot(content, cipher) {
    if ((0, encryption_1.isSealed)(content)) {
        if (!cipher)
            throw new encryption_1.EncryptionKeyError('Snapshot is encrypted but no encryption key is configured');
        return { body: cipher.open(content), encrypted: true };
    }
    return { body: content, encrypted: false };
}
/** Removes leftover temp files from interrupted snapshot writes. */
function cleanupTempFiles(dbDir) {
    try {
        for (const f of fs.readdirSync(dbDir)) {
            if (/\.odbs\.tmp-/.test(f)) {
                try {
                    fs.unlinkSync(path.join(dbDir, f));
                }
                catch { /* ignore */ }
            }
        }
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=persistence.js.map