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
exports.NativeSearchService = void 0;
exports.nativeAddon = nativeAddon;
const path = __importStar(require("path"));
const logger_1 = require("../utils/logger");
// Matches napi-rs's platform-triple naming convention. We only build one
// target locally today, but trying the full list costs nothing and means
// this keeps working if the project later cross-builds for Linux prod.
const CANDIDATE_SUFFIXES = [
    'win32-x64-msvc',
    'win32-x64-gnu',
    'linux-x64-gnu',
    'linux-x64-musl',
    'linux-arm64-gnu',
    'darwin-x64',
    'darwin-arm64',
];
let cachedModule;
function loadNativeModule() {
    if (cachedModule !== undefined)
        return cachedModule;
    cachedModule = null;
    for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = path.join(__dirname, '..', '..', `opendbs-engine.${suffix}.node`);
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require(candidate);
            if (mod && mod.SearchEngine) {
                cachedModule = mod;
                break;
            }
        }
        catch {
            // Not present for this platform/build -- try the next candidate.
        }
    }
    return cachedModule;
}
/** The raw native addon (search + disk storage), or null if it isn't built for this platform. */
function nativeAddon() {
    return loadNativeModule();
}
/**
 * Thin wrapper around the Rust-accelerated full-text + vector search addon.
 * Every method is a no-op-safe best-effort call: if the native module isn't
 * available (unbuilt platform, missing file), `available` is false and
 * callers are expected to fall back to their existing pure-JS behavior
 * rather than this service throwing.
 */
class NativeSearchService {
    engine = null;
    available;
    constructor(dataPath) {
        const nativeModule = loadNativeModule();
        if (!nativeModule) {
            logger_1.logger.warn('[native-search] no native search addon found for this platform; falling back to pure-JS fuzzy/vector search.');
            this.available = false;
            return;
        }
        try {
            this.engine = new nativeModule.SearchEngine(path.join(dataPath, '.search-index'));
            this.available = true;
        }
        catch (err) {
            logger_1.logger.warn({ err }, '[native-search] failed to initialize native search engine; falling back to pure-JS.');
            this.available = false;
        }
    }
    indexText(database, rack, field, docId, text) {
        try {
            this.engine?.indexText(database, rack, field, docId, text);
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] indexText failed');
        }
    }
    removeText(database, rack, field, docId) {
        try {
            this.engine?.removeText(database, rack, field, docId);
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] removeText failed');
        }
    }
    searchText(database, rack, field, query, limit) {
        try {
            return this.engine?.searchText(database, rack, field, query, limit) ?? [];
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] searchText failed');
            return [];
        }
    }
    addVector(database, rack, field, docId, vector) {
        try {
            this.engine?.addVector(database, rack, field, docId, vector);
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] addVector failed');
        }
    }
    addVectorsBatch(database, rack, field, items) {
        if (items.length === 0)
            return;
        try {
            this.engine?.addVectorsBatch(database, rack, field, items);
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] addVectorsBatch failed');
        }
    }
    removeVector(database, rack, field, docId) {
        try {
            this.engine?.removeVector(database, rack, field, docId);
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] removeVector failed');
        }
    }
    searchVector(database, rack, field, query, k) {
        try {
            return this.engine?.searchVector(database, rack, field, query, k) ?? [];
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] searchVector failed');
            return [];
        }
    }
    vectorStats(database, rack, field) {
        try {
            return this.engine?.vectorStats(database, rack, field) ?? null;
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] vectorStats failed');
            return null;
        }
    }
    rebuildVectorIndex(database, rack, field) {
        try {
            this.engine?.rebuildVectorIndex(database, rack, field);
        }
        catch (err) {
            logger_1.logger.warn({ err, database, rack, field }, '[native-search] rebuildVectorIndex failed');
        }
    }
    flush() {
        try {
            this.engine?.flush();
        }
        catch (err) {
            logger_1.logger.warn({ err }, '[native-search] flush failed');
        }
    }
}
exports.NativeSearchService = NativeSearchService;
//# sourceMappingURL=native-search.service.js.map