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
const security_middleware_1 = require("./middleware/security.middleware");
class OpenDBSEngine {
    databases;
    dataPath;
    packer;
    constructor(dbPath) {
        this.dataPath = dbPath;
        this.databases = new Map();
        this.packer = new msgpackr_1.Packr();
        if (!fs.existsSync(this.dataPath)) {
            fs.mkdirSync(this.dataPath, { recursive: true });
        }
        this.loadAll();
        console.log(`📦 OpenDBS Engine: Persistence enabled at ${this.dataPath} (.odbs)`);
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
            try {
                const decompressed = zlib.brotliDecompressSync(content);
                fileData = this.packer.unpack(decompressed);
            }
            catch {
                try {
                    fileData = JSON.parse(content.toString('utf-8'));
                }
                catch {
                    console.error(`❌ Failed to load ${rackName}.odbs: Unknown format`);
                    return;
                }
            }
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
                const indexedFields = fileData.data.indexedFields || [];
                if (Array.isArray(indexedFields)) {
                    for (const field of indexedFields) {
                        const index = new Map();
                        for (const [id, doc] of documents) {
                            const data = typeof doc.data === 'object' ? doc.data : doc;
                            if (data && field in data) {
                                const val = data[field];
                                if (['string', 'number', 'boolean'].includes(typeof val)) {
                                    if (!index.has(val))
                                        index.set(val, new Set());
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
                    createdAt: fileData.data.createdAt ? new Date(fileData.data.createdAt) : new Date(),
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
                createdAt: rack.createdAt,
            };
            const fileContent = {
                signature: 'OPENDBS_V1',
                timestamp: Date.now(),
                encoding: 'msgpack+brotli',
                hash: this.calculateHash(dataToSave),
                data: dataToSave,
            };
            const dbPath = this.getDatabasePath(dbName);
            if (!fs.existsSync(dbPath)) {
                fs.mkdirSync(dbPath, { recursive: true });
            }
            const binaryData = this.packer.pack(fileContent);
            const compressed = zlib.brotliCompressSync(binaryData, {
                params: {
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
                    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
                },
            });
            fs.writeFileSync(this.getRackPath(dbName, rackName), compressed);
        }
        catch (error) {
            console.error(`Failed to save rack ${rackName}:`, error);
        }
    }
    calculateHash(data) {
        return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    }
    createDatabase(name) {
        if (this.databases.has(name))
            return false;
        this.databases.set(name, { name, racks: new Map() });
        const dbPath = this.getDatabasePath(name);
        if (!fs.existsSync(dbPath)) {
            fs.mkdirSync(dbPath, { recursive: true });
        }
        return true;
    }
    createRack(database, rack, type = 'nosql', schema) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        if (db.racks.has(rack))
            return false;
        db.racks.set(rack, {
            name: rack,
            documents: new Map(),
            nextId: 1,
            indices: new Map(),
            type,
            schema,
            createdAt: new Date(),
        });
        this.saveRack(database, rack);
        return true;
    }
    getRackType(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            return null;
        const rackObj = db.racks.get(rack);
        return rackObj ? rackObj.type : null;
    }
    validateSchema(data, schema) {
        if (!schema)
            return { valid: true, errors: [] };
        const errors = [];
        for (const [field, fieldSchema] of Object.entries(schema)) {
            const value = data[field];
            if (fieldSchema.required && (value === undefined || value === null)) {
                if (fieldSchema.defaultValue !== undefined) {
                    data[field] = fieldSchema.defaultValue;
                }
                else {
                    errors.push(`Field '${field}' is required`);
                    continue;
                }
            }
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
            return false;
        const newDocs = new Map();
        for (const [id, doc] of sRack.documents) {
            newDocs.set(id, JSON.parse(JSON.stringify(doc)));
        }
        const newIndices = new Map();
        for (const [field, index] of sRack.indices) {
            const newIndex = new Map();
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
            createdAt: new Date(),
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
            return true;
        const index = new Map();
        for (const [id, doc] of rackObj.documents) {
            const data = typeof doc.data === 'object' ? doc.data : doc;
            if (data && field in data) {
                const val = data[field];
                if (['string', 'number', 'boolean'].includes(typeof val)) {
                    if (!index.has(val))
                        index.set(val, new Set());
                    index.get(val).add(id);
                }
            }
        }
        rackObj.indices.set(field, index);
        this.saveRack(database, rack);
        return true;
    }
    getIndexes(database, rack) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            throw new Error(`Rack '${rack}' not found`);
        return Array.from(rackObj.indices.keys());
    }
    deleteIndex(database, rack, field) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            throw new Error(`Rack '${rack}' not found`);
        if (!rackObj.indices.has(field))
            return false;
        rackObj.indices.delete(field);
        this.saveRack(database, rack);
        return true;
    }
    insert(database, rack, data, operationType) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            throw new Error(`Rack '${rack}' not found in database '${database}'`);
        if (rackObj.type === 'sql' && operationType === 'nosql') {
            throw new Error(`Rack '${rack}' is of type SQL and cannot accept NoSQL operations`);
        }
        const parsedData = JSON.parse(data);
        if (rackObj.schema) {
            const validation = this.validateSchema(parsedData, rackObj.schema);
            if (!validation.valid) {
                throw new Error(`Schema validation failed: ${validation.errors.join(', ')}`);
            }
        }
        const id = String(rackObj.nextId++);
        const now = new Date().toISOString();
        const document = {
            id,
            data: parsedData,
            createdAt: now,
            updatedAt: now,
        };
        rackObj.documents.set(id, document);
        for (const [field, index] of rackObj.indices) {
            if (field in parsedData) {
                const val = parsedData[field];
                if (['string', 'number', 'boolean'].includes(typeof val)) {
                    if (!index.has(val))
                        index.set(val, new Set());
                    index.get(val).add(id);
                }
            }
        }
        this.saveRack(database, rack);
        return id;
    }
    insertMany(database, rack, dataItems) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            throw new Error(`Rack '${rack}' not found in database '${database}'`);
        if (rackObj.type === 'sql') {
            throw new Error(`Rack '${rack}' is of type SQL and cannot accept NoSQL bulk inserts`);
        }
        const ids = [];
        const now = new Date().toISOString();
        for (const item of dataItems) {
            if (rackObj.schema) {
                const validation = this.validateSchema(item, rackObj.schema);
                if (!validation.valid) {
                    throw new Error(`Schema validation failed on item: ${validation.errors.join(', ')}`);
                }
            }
            const id = String(rackObj.nextId++);
            const document = {
                id,
                data: item,
                createdAt: now,
                updatedAt: now,
            };
            rackObj.documents.set(id, document);
            ids.push(id);
            for (const [field, index] of rackObj.indices) {
                if (field in item) {
                    const val = item[field];
                    if (['string', 'number', 'boolean'].includes(typeof val)) {
                        if (!index.has(val))
                            index.set(val, new Set());
                        index.get(val).add(id);
                    }
                }
            }
        }
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
            const filePath = this.getRackPath(database, rack);
            if (fs.existsSync(filePath))
                fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }
    deleteDatabase(database) {
        if (this.databases.delete(database)) {
            const dbPath = this.getDatabasePath(database);
            if (fs.existsSync(dbPath)) {
                // fs.rmSync supports recursive deletion in Node 14.14+
                fs.rmSync(dbPath, { recursive: true, force: true });
            }
            return true;
        }
        return false;
    }
    find(database, rack, query, options = {}) {
        const db = this.databases.get(database);
        if (!db)
            return [];
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return [];
        const rawQuery = JSON.parse(query);
        const queryObj = (0, security_middleware_1.sanitizeObject)(rawQuery); // strip __proto__ / constructor pollution
        const { skip = 0, limit, populate = false, sort } = options;
        let candidateIds = null;
        // Use indices for exact-match fields
        for (const key in queryObj) {
            if (key === '$and' || key === '$or' || key === '$not')
                continue;
            if (rackObj.indices.has(key)) {
                const val = queryObj[key];
                if (typeof val === 'object')
                    continue;
                const index = rackObj.indices.get(key);
                if (index.has(val)) {
                    const ids = index.get(val);
                    if (candidateIds === null) {
                        candidateIds = new Set(ids);
                    }
                    else {
                        const current = Array.from(candidateIds);
                        candidateIds = new Set(current.filter((x) => ids.has(x)));
                    }
                }
                else {
                    return [];
                }
            }
        }
        const allDocs = candidateIds
            ? Array.from(candidateIds)
                .map((id) => rackObj.documents.get(id))
                .filter((doc) => doc !== undefined)
            : Array.from(rackObj.documents.values());
        let results = [];
        for (const doc of allDocs) {
            if (!doc)
                continue;
            const docData = typeof doc.data === 'object' && doc.data !== null ? doc.data : {};
            let matches = true;
            if (Object.keys(queryObj).length > 0) {
                if (queryObj.$and) {
                    matches = Array.isArray(queryObj.$and) &&
                        queryObj.$and.every((subQuery) => this.matchesQuery(docData, subQuery, doc.id));
                }
                else if (queryObj.$or) {
                    matches = Array.isArray(queryObj.$or) &&
                        queryObj.$or.some((subQuery) => this.matchesQuery(docData, subQuery, doc.id));
                }
                else {
                    matches = this.matchesQuery(docData, queryObj, doc.id);
                }
            }
            if (!matches)
                continue;
            const result = {
                id: doc.id,
                ...docData,
                _metadata: {
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt,
                },
            };
            if (populate) {
                for (const key in result) {
                    const value = result[key];
                    if (typeof value === 'string' &&
                        /^[a-zA-Z0-9_]+:[0-9]+$/.test(value)) {
                        const [refRack, refId] = value.split(':');
                        if (refRack && refId && db.racks.has(refRack)) {
                            const refRackObj = db.racks.get(refRack);
                            if (refRackObj && refRackObj.documents.has(refId)) {
                                const refDoc = refRackObj.documents.get(refId);
                                const refData = typeof refDoc.data === 'object' ? refDoc.data : {};
                                result[key] = { id: refDoc.id, ...refData };
                            }
                        }
                    }
                }
            }
            results.push(JSON.stringify(result));
        }
        // Sort results if requested
        if (sort) {
            results = results.sort((a, b) => {
                const docA = JSON.parse(a);
                const docB = JSON.parse(b);
                const valA = docA[sort.field];
                const valB = docB[sort.field];
                if (valA == null && valB == null)
                    return 0;
                if (valA == null)
                    return 1;
                if (valB == null)
                    return -1;
                const cmp = valA < valB ? -1 : valA > valB ? 1 : 0;
                return sort.order === 'desc' ? -cmp : cmp;
            });
        }
        // Apply skip and limit
        const skipped = skip > 0 ? results.slice(skip) : results;
        return limit != null && limit > 0 ? skipped.slice(0, limit) : skipped;
    }
    update(database, rack, id, data) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return false;
        const doc = rackObj.documents.get(id);
        if (!doc)
            return false;
        const parsedData = JSON.parse(data);
        const oldData = typeof doc.data === 'object' ? { ...doc.data } : doc.data;
        doc.data = parsedData;
        doc.updatedAt = new Date().toISOString();
        // Update indices
        for (const [field, index] of rackObj.indices) {
            if (oldData && typeof oldData === 'object' && field in oldData) {
                const oldVal = oldData[field];
                if (index.has(oldVal)) {
                    index.get(oldVal).delete(id);
                    if (index.get(oldVal).size === 0)
                        index.delete(oldVal);
                }
            }
            if (field in parsedData) {
                const newVal = parsedData[field];
                if (['string', 'number', 'boolean'].includes(typeof newVal)) {
                    if (!index.has(newVal))
                        index.set(newVal, new Set());
                    index.get(newVal).add(id);
                }
            }
        }
        this.saveRack(database, rack);
        return true;
    }
    patch(database, rack, id, partialData) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return false;
        const doc = rackObj.documents.get(id);
        if (!doc)
            return false;
        const updates = JSON.parse(partialData);
        const oldData = typeof doc.data === 'object' ? { ...doc.data } : {};
        const mergedData = { ...oldData, ...updates };
        doc.data = mergedData;
        doc.updatedAt = new Date().toISOString();
        // Update indices for changed fields
        for (const [field, index] of rackObj.indices) {
            if (field in updates) {
                if (oldData && field in oldData) {
                    const oldVal = oldData[field];
                    if (index.has(oldVal)) {
                        index.get(oldVal).delete(id);
                        if (index.get(oldVal).size === 0)
                            index.delete(oldVal);
                    }
                }
                const newVal = updates[field];
                if (['string', 'number', 'boolean'].includes(typeof newVal)) {
                    if (!index.has(newVal))
                        index.set(newVal, new Set());
                    index.get(newVal).add(id);
                }
            }
        }
        this.saveRack(database, rack);
        return true;
    }
    delete(database, rack, id) {
        const db = this.databases.get(database);
        if (!db)
            return false;
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return false;
        const doc = rackObj.documents.get(id);
        if (doc) {
            const data = typeof doc.data === 'object' ? doc.data : doc;
            for (const [field, index] of rackObj.indices) {
                if (data && field in data) {
                    const val = data[field];
                    if (index.has(val)) {
                        index.get(val).delete(id);
                        if (index.get(val).size === 0)
                            index.delete(val);
                    }
                }
            }
        }
        const deleted = rackObj.documents.delete(id);
        if (deleted)
            this.saveRack(database, rack);
        return deleted;
    }
    fuzzySearch(database, rack, field, query, threshold) {
        const db = this.databases.get(database);
        if (!db)
            return [];
        const rackObj = db.racks.get(rack);
        if (!rackObj)
            return [];
        const results = [];
        for (const [, doc] of rackObj.documents) {
            const data = typeof doc.data === 'object' && doc.data !== null ? doc.data : doc;
            if (typeof data === 'object' && data !== null && field in data) {
                const fieldValue = data[field];
                if (typeof fieldValue === 'string') {
                    const similarity = this.calculateSimilarity(query.toLowerCase(), fieldValue.toLowerCase());
                    if (similarity >= threshold) {
                        const docData = typeof doc.data === 'object' && doc.data !== null ? doc.data : {};
                        results.push({
                            json: JSON.stringify({
                                id: doc.id,
                                ...docData,
                                _metadata: {
                                    createdAt: doc.createdAt,
                                    updatedAt: doc.updatedAt,
                                    score: similarity,
                                },
                            }),
                            score: similarity,
                        });
                    }
                }
            }
        }
        // Return sorted by score descending
        results.sort((a, b) => b.score - a.score);
        return results.map((r) => r.json);
    }
    getDatabases() {
        return Array.from(this.databases.keys());
    }
    getStats() {
        let totalRacks = 0;
        let totalDocuments = 0;
        for (const [, db] of this.databases) {
            totalRacks += db.racks.size;
            for (const [, rack] of db.racks) {
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
        if (!db)
            return [];
        const racks = [];
        for (const [name, rack] of db.racks) {
            racks.push({
                name,
                type: rack.type,
                count: rack.documents.size,
                schema: rack.schema,
                createdAt: rack.createdAt.toISOString(),
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
    matchesQuery(data, query, docId) {
        if (!query || Object.keys(query).length === 0)
            return true;
        for (const key in query) {
            const queryValue = query[key];
            // Handle document ID matching
            if (key === 'id') {
                if (docId !== String(queryValue))
                    return false;
                continue;
            }
            // Check if query has operator objects
            if (typeof queryValue === 'object' && queryValue !== null && !Array.isArray(queryValue)) {
                for (const operator of Object.keys(queryValue)) {
                    const operand = queryValue[operator];
                    switch (operator) {
                        case '$exists':
                            if ((key in data) !== Boolean(operand))
                                return false;
                            break;
                        case '$gte':
                            if (!(key in data) || !(data[key] >= operand))
                                return false;
                            break;
                        case '$gt':
                            if (!(key in data) || !(data[key] > operand))
                                return false;
                            break;
                        case '$lte':
                            if (!(key in data) || !(data[key] <= operand))
                                return false;
                            break;
                        case '$lt':
                            if (!(key in data) || !(data[key] < operand))
                                return false;
                            break;
                        case '$ne':
                            if (!(key in data))
                                return false;
                            if (data[key] === operand)
                                return false;
                            break;
                        case '$in':
                            if (!Array.isArray(operand))
                                return false;
                            if (!(key in data) || !operand.includes(data[key]))
                                return false;
                            break;
                        case '$nin':
                            if (!Array.isArray(operand))
                                return false;
                            if (key in data && operand.includes(data[key]))
                                return false;
                            break;
                        case '$regex': {
                            if (!(key in data) || typeof data[key] !== 'string')
                                return false;
                            (0, security_middleware_1.validateRegexPattern)(operand); // throws on ReDoS-prone patterns
                            const flags = queryValue.$options || '';
                            const regex = new RegExp(operand, flags);
                            if (!regex.test(data[key]))
                                return false;
                            break;
                        }
                        case '$options':
                            // handled inside $regex case
                            break;
                        default:
                            if (!(key in data) || data[key] !== queryValue)
                                return false;
                    }
                }
            }
            else {
                // Simple equality
                if (!(key in data) || data[key] !== queryValue)
                    return false;
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
        if (!Array.isArray(queryVector) || queryVector.length === 0) {
            throw new Error('queryVector must be a non-empty array of numbers');
        }
        const candidates = [];
        for (const [id, doc] of rackObj.documents) {
            const data = typeof doc.data === 'object' && doc.data !== null ? doc.data : doc;
            if (data && vectorField in data) {
                const docVector = data[vectorField];
                if (Array.isArray(docVector) && docVector.length === queryVector.length) {
                    const similarity = this.calculateCosineSimilarity(queryVector, docVector);
                    candidates.push({ id, doc, similarity });
                }
            }
        }
        candidates.sort((a, b) => b.similarity - a.similarity);
        return candidates.slice(0, k).map((c) => {
            const docData = typeof c.doc.data === 'object' && c.doc.data !== null ? c.doc.data : {};
            return JSON.stringify({
                id: c.id,
                ...docData,
                _metadata: {
                    createdAt: c.doc.createdAt,
                    updatedAt: c.doc.updatedAt,
                    score: c.similarity,
                },
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
        if (str1 === str2)
            return 1;
        if (str1.length === 0 || str2.length === 0)
            return 0;
        // Exact substring match gets a high score
        if (str2.includes(str1) || str1.includes(str2))
            return 0.9;
        // Levenshtein distance-based similarity
        const len1 = str1.length;
        const len2 = str2.length;
        // Use two rows to keep memory O(min(m,n))
        let prev = Array.from({ length: len2 + 1 }, (_, i) => i);
        let curr = new Array(len2 + 1).fill(0);
        for (let i = 1; i <= len1; i++) {
            curr[0] = i;
            for (let j = 1; j <= len2; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                curr[j] = Math.min(prev[j] + 1, // deletion
                curr[j - 1] + 1, // insertion
                prev[j - 1] + cost // substitution
                );
            }
            [prev, curr] = [curr, prev];
        }
        const distance = prev[len2];
        return 1 - distance / Math.max(len1, len2);
    }
    getDatabaseStats(database) {
        const db = this.databases.get(database);
        if (!db)
            throw new Error(`Database '${database}' not found`);
        const racks = [];
        let totalDocuments = 0;
        for (const [rackName, rack] of db.racks) {
            const count = rack.documents.size;
            totalDocuments += count;
            racks.push({
                name: rackName,
                type: rack.type,
                count,
                indexCount: rack.indices.size,
            });
        }
        return { totalRacks: db.racks.size, totalDocuments, racks };
    }
}
exports.OpenDBSEngine = OpenDBSEngine;
//# sourceMappingURL=engine.js.map