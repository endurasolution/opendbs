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
exports.OpenDBSEngine = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const msgpackr_1 = require("msgpackr");
const zlib = __importStar(require("zlib"));
class OpenDBSEngine {
    databases;
    dataPath;
    packer;
    constructor(dbPath) {
        this.dataPath = dbPath;
        this.databases = new Map();
        this.packer = new msgpackr_1.Packr();
        // Ensure data root exists
        if (!fs.existsSync(this.dataPath)) {
            fs.mkdirSync(this.dataPath, { recursive: true });
        }
        this.loadAll();
        console.log(`📦 Mock Engine: Persistence enabled at ${this.dataPath} (.odbs)`);
        console.log(`⚡ Optimization: MsgPack Encoding + Brotli Compression Enabled`);
    }
    getDatabasePath(dbName) {
        return path.join(this.dataPath, dbName);
    }
    getRackPath(dbName, rackName) {
        return path.join(this.getDatabasePath(dbName), `${rackName}.odbs`);
    }
    loadAll() {
        try {
            const items = fs.readdirSync(this.dataPath);
            for (const item of items) {
                const dbPath = path.join(this.dataPath, item);
                if (fs.statSync(dbPath).isDirectory()) {
                    const dbName = item;
                    this.databases.set(dbName, { name: dbName, racks: new Map() });
                    const rackFiles = fs.readdirSync(dbPath);
                    for (const file of rackFiles) {
                        if (file.endsWith('.odbs')) {
                            const rackName = path.basename(file, '.odbs');
                            this.loadRack(dbName, rackName);
                        }
                    }
                }
            }
        }
        catch (error) {
            console.error('Failed to load data:', error);
        }
    }
    loadRack(dbName, rackName) {
        try {
            const filePath = this.getRackPath(dbName, rackName);
            if (!fs.existsSync(filePath))
                return;
            const content = fs.readFileSync(filePath);
            let fileData;
            // Try to load as Binary (Brotli + MsgPack)
            try {
                const decompressed = zlib.brotliDecompressSync(content);
                fileData = this.packer.unpack(decompressed);
            }
            catch (binaryError) {
                // Fallback to JSON (Legacy)
                try {
                    fileData = JSON.parse(content.toString('utf-8'));
                }
                catch (jsonError) {
                    console.error(`❌ Failed to load ${rackName}.odbs: Unknown format`);
                    return;
                }
            }
            // Verify Hash for Integrity
            if (fileData.hash) {
                const calculatedHash = this.calculateHash(fileData.data);
                if (calculatedHash !== fileData.hash) {
                    console.error(`❌ Integrity Check Failed for ${dbName}/${rackName}.odbs! Data corruption detected.`);
                    return;
                }
            }
            const db = this.databases.get(dbName);
            if (db) {
                const documents = new Map();
                if (fileData.data && fileData.data.documents) {
                    for (const [id, doc] of Object.entries(fileData.data.documents)) {
                        documents.set(id, doc);
                    }
                }
                const indices = new Map();
                // Rebuild indices if persisted metadata exists
                const indexedFields = fileData.data.indexedFields || [];
                if (Array.isArray(indexedFields)) {
                    for (const field of indexedFields) {
                        const index = new Map();
                        // Populate index from documents
                        for (const [id, doc] of documents) {
                            const data = typeof doc.data === 'object' ? doc.data : doc;
                            if (data && field in data) {
                                const val = data[field];
                                if (['string', 'number', 'boolean'].includes(typeof val)) {
                                    if (!index.has(val)) {
                                        index.set(val, new Set());
                                    }
                                    index.get(val).add(id);
                                }
                            }
                        }
                        indices.set(field, index);
                    }
                }
                db.racks.set(rackName, {
                    name: rackName,
                    documents,
                    nextId: fileData.data.nextId || 1,
                    indices,
                    type: fileData.data.type || 'nosql',
                    schema: fileData.data.schema,
                    createdAt: fileData.data.createdAt ? new Date(fileData.data.createdAt) : new Date()
                });
            }
        }
        catch (error) {
            console.error(`Error loading rack ${rackName}:`, error);
        }
    }
    saveRack(dbName, rackName) {
        try {
            const db = this.databases.get(dbName);
            if (!db)
                return;
            const rack = db.racks.get(rackName);
            if (!rack)
                return;
            // Convert Map to Object for JSON serialization
            const documentsObj = {};
            for (const [id, doc] of rack.documents) {
                documentsObj[id] = doc;
            }
            const dataToSave = {
                documents: documentsObj,
                nextId: rack.nextId,
                indexedFields: Array.from(rack.indices.keys()),
                type: rack.type,
                schema: rack.schema,
                createdAt: rack.createdAt
            };
            const fileContent = {
                signature: 'OPENDBS_V1',
                timestamp: Date.now(),
                encoding: 'msgpack+brotli',
                hash: this.calculateHash(dataToSave),
                data: dataToSave
            };
            const dbPath = this.getDatabasePath(dbName);
            if (!fs.existsSync(dbPath)) {
                fs.mkdirSync(dbPath, { recursive: true });
            }
            // Optimize: Pack (Binary) -> Compress (Brotli) -> Save
            const binaryData = this.packer.pack(fileContent);
            const compressed = zlib.brotliCompressSync(binaryData, {
                params: {
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
                    [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // Balance speed/size (1-11)
                }
            });
            fs.writeFileSync(this.getRackPath(dbName, rackName), compressed);
        }
        catch (error) {
            console.error(`Failed to save rack ${rackName}:`, error);
        }
    }
    calculateHash(data) {
        // Hash the serialized object for consistency
        return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    }
    createDatabase(name) {
        if (this.databases.has(name)) {
            return false;
        }
        this.databases.set(name, {
            name,
            racks: new Map(),
        });
        // Create directory
        const dbPath = this.getDatabasePath(name);
        if (!fs.existsSync(dbPath)) {
            fs.mkdirSync(dbPath, { recursive: true });
        }
        return true;
    }
    createRack(database, rack, type = 'nosql', schema) {
        const db = this.databases.get(database);
        if (!db) {
            throw new Error(`Database '${database}' not found`);
        }
        if (db.racks.has(rack)) {
            return false;
        }
        db.racks.set(rack, {
            name: rack,
            documents: new Map(),
            nextId: 1,
            indices: new Map(),
            type,
            schema,
            createdAt: new Date()
        });
        // Save initial state
        this.saveRack(database, rack);
        return true;
    }
    // Get rack type
    getRackType(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            return null;
        const rackObj = db.racks.get(rack);
        return rackObj ? rackObj.type : null;
    }
    // Validate data against schema
    validateSchema(data, schema) {
        if (!schema)
            return { valid: true, errors: [] };
        const errors = [];
        for (const [field, fieldSchema] of Object.entries(schema)) {
            const value = data[field];
            // Check required fields
            if (fieldSchema.required && (value === undefined || value === null)) {
                errors.push(`Field '${field}' is required`);
                continue;
            }
            // Check type if value exists
            if (value !== undefined && value !== null) {
                const actualType = Array.isArray(value) ? 'array' : typeof value;
                if (actualType !== fieldSchema.type && fieldSchema.type !== 'object') {
                    errors.push(`Field '${field}' must be of type ${fieldSchema.type}, got ${actualType}`);
                }
            }
        }
        return { valid: errors.length === 0, errors };
    }
    duplicateRack(sourceDb, sourceRack, targetDb, targetRack) {
        const sDb = this.databases.get(sourceDb);
        if (!sDb)
            throw new Error(`Source Database '${sourceDb}' not found`);
        const sRack = sDb.racks.get(sourceRack);
        if (!sRack)
            throw new Error(`Source Rack '${sourceRack}' not found`);
        const tDb = this.databases.get(targetDb);
        if (!tDb)
            throw new Error(`Target Database '${targetDb}' not found`);
        if (tDb.racks.has(targetRack))
            return false; // Target already exists
        // Deep copy documents
        const newDocs = new Map();
        for (const [id, doc] of sRack.documents) {
            // Deep clone document
            const docClone = JSON.parse(JSON.stringify(doc));
            newDocs.set(id, docClone);
        }
        // Rebuild indices for the new rack
        const newIndices = new Map();
        for (const [field, index] of sRack.indices) {
            const newIndex = new Map(index); // Shallow copy of outer map is fine as we need new Set for values
            // Actually, the values are Sets, so we need to clone those too
            for (const [k, v] of index) {
                newIndex.set(k, new Set(v));
            }
            newIndices.set(field, newIndex);
        }
        tDb.racks.set(targetRack, {
            name: targetRack,
            documents: newDocs,
            nextId: sRack.nextId,
            indices: newIndices,
            type: sRack.type,
            schema: sRack.schema ? { ...sRack.schema } : undefined,
            createdAt: new Date()
        });
        this.saveRack(targetDb, targetRack);
        return true;
    }
    createIndex(database, rack, field) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            throw new Error(`Rack '${rack}' not found`);
        if (rackObj.indices.has(field))
            return true; // Already exists
        const index = new Map();
        // Build index from existing documents
        for (const [id, doc] of rackObj.documents) {
            const data = typeof doc.data === 'object' ? doc.data : doc;
            if (data && field in data) {
                const val = data[field];
                if (['string', 'number', 'boolean'].includes(typeof val)) {
                    if (!index.has(val)) {
                        index.set(val, new Set());
                    }
                    index.get(val).add(id);
                }
            }
        }
        rackObj.indices.set(field, index);
        this.saveRack(database, rack);
        return true;
    }
    insert(database, rack, data, operationType) {
        const db = this.databases.get(database);
        if (!db) {
            throw new Error(`Database '${database}' not found`);
        }
        const rackObj = db.racks.get(rack);
        if (!rackObj) {
            throw new Error(`Rack '${rack}' not found in database '${database}'`);
        }
        // Type enforcement: SQL racks can only accept SQL operations
        if (rackObj.type === 'sql' && operationType === 'nosql') {
            throw new Error(`Rack '${rack}' is of type SQL and cannot accept NoSQL operations`);
        }
        const id = String(rackObj.nextId++);
        const parsedData = JSON.parse(data);
        // Validate schema if defined
        if (rackObj.schema) {
            const validation = this.validateSchema(parsedData, rackObj.schema);
            if (!validation.valid) {
                throw new Error(`Schema validation failed: ${validation.errors.join(', ')}`);
            }
        }
        const document = {
            id,
            data: parsedData,
            ...parsedData,
        };
        rackObj.documents.set(id, document);
        // Update indices
        for (const [field, index] of rackObj.indices) {
            if (field in parsedData) {
                const val = parsedData[field];
                if (['string', 'number', 'boolean'].includes(typeof val)) {
                    if (!index.has(val)) {
                        index.set(val, new Set());
                    }
                    index.get(val).add(id);
                }
            }
        }
        // Save state
        this.saveRack(database, rack);
        return id;
    }
    insertMany(database, rack, dataItems) {
        const db = this.databases.get(database);
        if (!db) {
            throw new Error(`Database '${database}' not found`);
        }
        const rackObj = db.racks.get(rack);
        if (!rackObj) {
            throw new Error(`Rack '${rack}' not found in database '${database}'`);
        }
        const ids = [];
        for (const item of dataItems) {
            const id = String(rackObj.nextId++);
            const document = {
                id,
                data: item,
                ...item,
            };
            rackObj.documents.set(id, document);
            ids.push(id);
            // Update indices
            for (const [field, index] of rackObj.indices) {
                if (field in item) {
                    const val = item[field];
                    if (['string', 'number', 'boolean'].includes(typeof val)) {
                        if (!index.has(val)) {
                            index.set(val, new Set());
                        }
                        index.get(val).add(id);
                    }
                }
            }
        }
        // Save state
        this.saveRack(database, rack);
        return ids;
    }
    clearRack(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return false;
        rackObj.documents.clear();
        // Clear all indices
        for (const index of rackObj.indices.values()) {
            index.clear();
        }
        this.saveRack(database, rack);
        return true;
    }
    deleteRack(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        if (db.racks.delete(rack)) {
            // Delete file
            const filePath = this.getRackPath(database, rack);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return true;
        }
        return false;
    }
    deleteDatabase(database) {
        if (this.databases.delete(database)) {
            const dbPath = this.getDatabasePath(database);
            if (fs.existsSync(dbPath)) {
                fs.rmdirSync(dbPath, { recursive: true });
            }
            return true;
        }
        return false;
    }
    find(database, rack, query, populate = false) {
        const db = this.databases.get(database);
        if (!db) {
            return [];
        }
        const rackObj = db.racks.get(rack);
        if (!rackObj) {
            return [];
        }
        const queryObj = JSON.parse(query);
        const results = [];
        let candidateIds = null;
        // Check for indexed fields in query (exact match only for now)
        for (const key in queryObj) {
            if (rackObj.indices.has(key)) {
                const val = queryObj[key];
                // Skip if operator query
                if (typeof val === 'object')
                    continue;
                const index = rackObj.indices.get(key);
                if (index.has(val)) {
                    const ids = index.get(val);
                    if (candidateIds === null) {
                        candidateIds = new Set(ids);
                    }
                    else {
                        const currentIds = Array.from(candidateIds);
                        candidateIds = new Set(currentIds.filter((x) => ids.has(x)));
                    }
                }
                else {
                    // Indexed field queried but value not found -> 0 results
                    return [];
                }
            }
        }
        const iterator = candidateIds
            ? Array.from(candidateIds).map(id => rackObj.documents.get(id)).filter(doc => doc !== undefined)
            : rackObj.documents.values();
        for (const doc of iterator) {
            if (!doc)
                continue; // Should not happen with filter above, but for safety
            // Special handling for id field - check both doc.id and data
            let matches = true;
            for (const key in queryObj) {
                if (key === 'id') {
                    // Match against document ID
                    if (doc.id !== queryObj[key]) {
                        matches = false;
                        break;
                    }
                }
                else {
                    // Match against data fields
                    const data = typeof doc.data === 'object' ? doc.data : doc;
                    if (!this.matchesQuery(data, { [key]: queryObj[key] })) {
                        matches = false;
                        break;
                    }
                }
            }
            // For empty query, match all
            if (Object.keys(queryObj).length === 0) {
                matches = true;
            }
            if (matches) {
                // Return document with clean structure
                const docData = typeof doc.data === 'object' && doc.data !== null ? doc.data : {};
                const result = {
                    id: doc.id,
                    ...docData, // Spread data at top level
                    _metadata: {
                        createdAt: doc.createdAt,
                        updatedAt: doc.updatedAt,
                    },
                };
                // Handle population of foreign keys
                if (populate) {
                    for (const key in result) {
                        // Check for foreign key pattern or explicit configuration
                        // Value matches format "rack:id" (e.g., "dob:25")
                        const value = result[key];
                        if (typeof value === 'string' && value.includes(':') && !value.includes('http')) {
                            const [refRack, refId] = value.split(':');
                            if (refRack && refId && db.racks.has(refRack)) {
                                const refRackObj = db.racks.get(refRack);
                                if (refRackObj && refRackObj.documents.has(refId)) {
                                    const refDoc = refRackObj.documents.get(refId);
                                    if (refDoc) {
                                        const refData = typeof refDoc.data === 'object' ? refDoc.data : refDoc;
                                        // Replace the foreign key string with the actual object
                                        const { id, ...rest } = refData;
                                        result[key] = {
                                            id: refDoc.id,
                                            ...rest,
                                        };
                                    }
                                }
                            }
                        }
                    }
                }
                results.push(JSON.stringify(result));
            }
        }
        return results;
    }
    update(database, rack, id, data) {
        const db = this.databases.get(database);
        if (!db) {
            return false;
        }
        const rackObj = db.racks.get(rack);
        if (!rackObj) {
            return false;
        }
        const doc = rackObj.documents.get(id);
        if (!doc) {
            return false;
        }
        const parsedData = JSON.parse(data);
        const oldData = typeof doc.data === 'object' ? Object.assign({}, doc.data) : doc.data;
        doc.data = parsedData;
        Object.assign(doc, parsedData);
        // Update indices
        for (const [field, index] of rackObj.indices) {
            // Remove old value
            if (oldData && typeof oldData === 'object' && field in oldData) {
                const oldVal = oldData[field];
                if (index.has(oldVal)) {
                    index.get(oldVal).delete(id);
                    if (index.get(oldVal).size === 0) {
                        index.delete(oldVal);
                    }
                }
            }
            // Add new value
            if (field in parsedData) {
                const newVal = parsedData[field];
                if (['string', 'number', 'boolean'].includes(typeof newVal)) {
                    if (!index.has(newVal)) {
                        index.set(newVal, new Set());
                    }
                    index.get(newVal).add(id);
                }
            }
        }
        // Save state
        this.saveRack(database, rack);
        return true;
    }
    delete(database, rack, id) {
        const db = this.databases.get(database);
        if (!db) {
            return false;
        }
        const rackObj = db.racks.get(rack);
        if (!rackObj) {
            return false;
        }
        // Remove from indices
        const doc = rackObj.documents.get(id);
        if (doc) {
            const data = typeof doc.data === 'object' ? doc.data : doc;
            for (const [field, index] of rackObj.indices) {
                if (data && field in data) {
                    const val = data[field];
                    if (index.has(val)) {
                        index.get(val).delete(id);
                        if (index.get(val).size === 0) {
                            index.delete(val);
                        }
                    }
                }
            }
        }
        const deleted = rackObj.documents.delete(id);
        if (deleted) {
            this.saveRack(database, rack);
        }
        return deleted;
    }
    fuzzySearch(database, rack, field, query, threshold) {
        // Simple fuzzy search implementation
        const db = this.databases.get(database);
        if (!db) {
            return [];
        }
        const rackObj = db.racks.get(rack);
        if (!rackObj) {
            return [];
        }
        const results = [];
        for (const [_, doc] of rackObj.documents) {
            const data = typeof doc.data === 'object' && doc.data !== null ? doc.data : doc;
            if (typeof data === 'object' && data !== null && field in data) {
                const fieldValue = data[field];
                if (typeof fieldValue === 'string') {
                    const similarity = this.calculateSimilarity(query.toLowerCase(), fieldValue.toLowerCase());
                    if (similarity >= threshold) {
                        const docData = typeof doc.data === 'object' && doc.data !== null ? doc.data : {};
                        const result = {
                            id: doc.id,
                            ...docData, // Spread data at top level
                            _metadata: {
                                createdAt: doc.createdAt,
                                updatedAt: doc.updatedAt,
                            },
                        };
                        results.push(JSON.stringify(result));
                    }
                }
            }
        }
        return results;
    }
    getDatabases() {
        return Array.from(this.databases.keys());
    }
    getStats() {
        let totalRacks = 0;
        let totalDocuments = 0;
        for (const [_, db] of this.databases) {
            totalRacks += db.racks.size;
            for (const [_, rack] of db.racks) {
                totalDocuments += rack.documents.size;
            }
        }
        return JSON.stringify({
            databases: this.databases.size,
            racks: totalRacks,
            documents: totalDocuments,
        });
    }
    getDatabaseRacks(database) {
        const db = this.databases.get(database);
        if (!db) {
            return [];
        }
        const racks = [];
        for (const [name, rack] of db.racks) {
            racks.push({
                name,
                count: rack.documents.size,
            });
        }
        return racks;
    }
    getRackCount(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            return -1;
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return -1;
        return rackObj.documents.size;
    }
    matchesQuery(data, query) {
        if (Object.keys(query).length === 0) {
            return true; // Empty query matches all
        }
        for (const key in query) {
            if (!(key in data)) {
                return false;
            }
            const queryValue = query[key];
            const dataValue = data[key];
            // Handle MongoDB-style operators
            if (typeof queryValue === 'object' && queryValue !== null && !Array.isArray(queryValue)) {
                // Check for operators
                for (const operator in queryValue) {
                    switch (operator) {
                        case '$gte': // Greater than or equal
                            if (!(dataValue >= queryValue[operator]))
                                return false;
                            break;
                        case '$gt': // Greater than
                            if (!(dataValue > queryValue[operator]))
                                return false;
                            break;
                        case '$lte': // Less than or equal
                            if (!(dataValue <= queryValue[operator]))
                                return false;
                            break;
                        case '$lt': // Less than
                            if (!(dataValue < queryValue[operator]))
                                return false;
                            break;
                        case '$ne': // Not equal
                            if (dataValue === queryValue[operator])
                                return false;
                            break;
                        case '$in': // In array
                            if (!Array.isArray(queryValue[operator]))
                                return false;
                            if (!queryValue[operator].includes(dataValue))
                                return false;
                            break;
                        case '$nin': // Not in array
                            if (!Array.isArray(queryValue[operator]))
                                return false;
                            if (queryValue[operator].includes(dataValue))
                                return false;
                            break;
                        case '$regex': // Regular expression match
                            if (typeof dataValue !== 'string')
                                return false;
                            const regex = new RegExp(queryValue[operator], queryValue.$options || '');
                            if (!regex.test(dataValue))
                                return false;
                            break;
                        case '$exists': // Field exists
                            const exists = key in data;
                            if (exists !== queryValue[operator])
                                return false;
                            break;
                        default:
                            // Unknown operator, do equality check
                            if (dataValue !== queryValue)
                                return false;
                    }
                }
            }
            else {
                // Simple equality check
                if (dataValue !== queryValue) {
                    return false;
                }
            }
        }
        return true;
    }
    vectorSearch(database, rack, vectorField, queryVector, k = 10) {
        const db = this.databases.get(database);
        if (!db)
            return [];
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return [];
        const candidates = [];
        for (const [id, doc] of rackObj.documents) {
            const data = typeof doc.data === 'object' && doc.data !== null ? doc.data : doc;
            // Check if document has the vector field and it is an array
            if (data && vectorField in data) {
                const docVector = data[vectorField];
                if (Array.isArray(docVector) && docVector.length === queryVector.length) {
                    const similarity = this.calculateCosineSimilarity(queryVector, docVector);
                    candidates.push({ id, doc, similarity });
                }
            }
        }
        // Sort by similarity (descending) and take top k
        candidates.sort((a, b) => b.similarity - a.similarity);
        return candidates.slice(0, k).map(c => {
            // Include similarity score in metadata or as a field? 
            // Let's add it to _metadata
            const docData = typeof c.doc.data === 'object' && c.doc.data !== null ? c.doc.data : {};
            return JSON.stringify({
                id: c.id,
                ...docData,
                _metadata: {
                    createdAt: c.doc.createdAt,
                    updatedAt: c.doc.updatedAt,
                    score: c.similarity
                }
            });
        });
    }
    calculateCosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            magnitudeA += vecA[i] * vecA[i];
            magnitudeB += vecB[i] * vecB[i];
        }
        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);
        if (magnitudeA === 0 || magnitudeB === 0)
            return 0;
        return dotProduct / (magnitudeA * magnitudeB);
    }
    calculateSimilarity(str1, str2) {
        // Simple Jaro-Winkler-like similarity
        if (str1 === str2)
            return 1;
        if (str1.length === 0 || str2.length === 0)
            return 0;
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        if (longer.includes(shorter)) {
            return 0.8; // High similarity if one contains the other
        }
        // Simple character overlap
        const set1 = new Set(str1.split(''));
        const set2 = new Set(str2.split(''));
        const intersection = new Set([...set1].filter((x) => set2.has(x)));
        return intersection.size / Math.max(set1.size, set2.size);
    }
    getDatabaseStats(database) {
        const db = this.databases.get(database);
        if (!db) {
            throw new Error(`Database '${database}' not found`);
        }
        const racks = [];
        let totalDocuments = 0;
        for (const [rackName, rack] of db.racks) {
            const count = rack.documents.size;
            totalDocuments += count;
            racks.push({
                name: rackName,
                type: rack.type,
                count
            });
        }
        return {
            totalRacks: db.racks.size,
            totalDocuments,
            racks
        };
    }
}
exports.OpenDBSEngine = OpenDBSEngine;
//# sourceMappingURL=engine.js.map