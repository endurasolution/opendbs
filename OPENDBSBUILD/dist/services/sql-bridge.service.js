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
exports.SQLBridgeService = void 0;
const mysql = __importStar(require("mysql2/promise"));
class SQLBridgeService {
    engine;
    pool;
    sqlCredentials;
    constructor(engine, mysqlConfig) {
        this.engine = engine;
        this.sqlCredentials = new Map();
        // Initialize MySQL connection pool if config provided
        if (mysqlConfig) {
            this.pool = mysql.createPool({
                host: mysqlConfig.host,
                port: mysqlConfig.port,
                user: mysqlConfig.user,
                password: mysqlConfig.password,
                database: mysqlConfig.database || 'opendbs',
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
            });
        }
    }
    // Generate SQL credentials for a user
    generateSQLCredentials(userId, username) {
        const sqlUsername = `opendbs_${username}`;
        const sqlPassword = this.generateSecurePassword();
        const credentials = {
            userId,
            username: sqlUsername,
            password: sqlPassword,
            host: 'localhost',
            port: 3306,
            createdAt: new Date(),
        };
        this.sqlCredentials.set(userId, credentials);
        return credentials;
    }
    getSQLCredentials(userId) {
        return this.sqlCredentials.get(userId);
    }
    // Execute SQL query and bridge to NoSQL operations
    async executeSQL(query, database) {
        const normalizedQuery = query.trim().toLowerCase();
        // Parse query type
        if (normalizedQuery.startsWith('select')) {
            return this.handleSelect(query, database);
        }
        else if (normalizedQuery.startsWith('insert')) {
            return this.handleInsert(query, database);
        }
        else if (normalizedQuery.startsWith('update')) {
            return this.handleUpdate(query, database);
        }
        else if (normalizedQuery.startsWith('delete')) {
            return this.handleDelete(query, database);
        }
        else if (normalizedQuery.startsWith('create table')) {
            return this.handleCreateTable(query, database);
        }
        else if (normalizedQuery.startsWith('drop table')) {
            return this.handleDropTable(query, database);
        }
        else {
            throw new Error('Unsupported SQL operation');
        }
    }
    async handleSelect(query, database) {
        // Parse: SELECT * FROM table_name WHERE condition
        const tableMatch = query.match(/from\s+([a-z0-9_]+)/i);
        if (!tableMatch)
            throw new Error('Invalid SELECT query');
        const tableName = tableMatch[1];
        // Simple WHERE parsing (basic implementation)
        const whereMatch = query.match(/where\s+(.+?)(?:limit|order|$)/i);
        let filter = {};
        if (whereMatch) {
            const whereClause = whereMatch[1].trim();
            // Parse simple conditions: column = 'value'
            const conditionMatch = whereClause.match(/([a-z0-9_]+)\s*=\s*'([^']+)'/i);
            if (conditionMatch) {
                filter = { [conditionMatch[1]]: conditionMatch[2] };
            }
        }
        const results = this.engine.find(database, tableName, JSON.stringify(filter));
        return results.map(r => JSON.parse(r));
    }
    async handleInsert(query, database) {
        // Parse: INSERT INTO table_name (col1, col2) VALUES (val1, val2)
        const tableMatch = query.match(/into\s+([a-z0-9_]+)/i);
        const valuesMatch = query.match(/values\s*\((.+?)\)/i);
        if (!tableMatch || !valuesMatch)
            throw new Error('Invalid INSERT query');
        const tableName = tableMatch[1];
        const values = valuesMatch[1].split(',').map(v => {
            const val = v.trim();
            if (val.startsWith("'") && val.endsWith("'")) {
                return val.slice(1, -1);
            }
            if (!isNaN(Number(val)))
                return Number(val);
            if (val.toLowerCase() === 'true')
                return true;
            if (val.toLowerCase() === 'false')
                return false;
            return val;
        });
        // Extract column names if specified
        const columnsMatch = query.match(/\(([^)]+)\)\s*values/i);
        let data = {};
        if (columnsMatch) {
            const columns = columnsMatch[1].split(',').map(c => c.trim());
            columns.forEach((col, idx) => {
                data[col] = values[idx];
            });
        }
        else {
            // If no columns specified, use generic field names
            values.forEach((val, idx) => {
                data[`field${idx + 1}`] = val;
            });
        }
        const id = this.engine.insert(database, tableName, JSON.stringify(data), 'sql');
        return { insertId: id, affectedRows: 1 };
    }
    async handleUpdate(query, database) {
        // Parse: UPDATE table_name SET col1='val1' WHERE id='123'
        const tableMatch = query.match(/update\s+([a-z0-9_]+)/i);
        const setMatch = query.match(/set\s+(.+?)\s+where/i);
        const whereMatch = query.match(/where\s+(.+?)$/i);
        if (!tableMatch || !setMatch || !whereMatch)
            throw new Error('Invalid UPDATE query');
        const tableName = tableMatch[1];
        // Parse SET clause
        const updates = {};
        const setPairs = setMatch[1].split(',');
        setPairs.forEach(pair => {
            const [key, rawVal] = pair.split('=').map(s => s.trim());
            let val = rawVal;
            if (rawVal.startsWith("'") && rawVal.endsWith("'")) {
                val = rawVal.slice(1, -1);
            }
            else if (!isNaN(Number(rawVal))) {
                val = Number(rawVal);
            }
            else if (rawVal.toLowerCase() === 'true') {
                val = true;
            }
            else if (rawVal.toLowerCase() === 'false') {
                val = false;
            }
            updates[key] = val;
        });
        // Parse WHERE for ID
        const idMatch = whereMatch[1].match(/id\s*=\s*'?([^'\s]+)'?/i);
        if (!idMatch)
            throw new Error('UPDATE requires WHERE id=...');
        const id = idMatch[1];
        const success = this.engine.update(database, tableName, id, JSON.stringify(updates));
        return { affectedRows: success ? 1 : 0 };
    }
    async handleDelete(query, database) {
        // Parse: DELETE FROM table_name WHERE id='123'
        const tableMatch = query.match(/from\s+([a-z0-9_]+)/i);
        const whereMatch = query.match(/where\s+(.+?)$/i);
        if (!tableMatch || !whereMatch)
            throw new Error('Invalid DELETE query');
        const tableName = tableMatch[1];
        // Parse WHERE for ID
        const idMatch = whereMatch[1].match(/id\s*=\s*'?([^'\s]+)'?/i);
        if (!idMatch)
            throw new Error('DELETE requires WHERE id=...');
        const id = idMatch[1];
        const success = this.engine.delete(database, tableName, id);
        return { affectedRows: success ? 1 : 0 };
    }
    async handleCreateTable(query, database) {
        // Parse: CREATE TABLE table_name (col1 TYPE1, col2 TYPE2, ...)
        const tableMatch = query.match(/create\s+table\s+([a-z0-9_]+)/i);
        if (!tableMatch)
            throw new Error('Invalid CREATE TABLE query');
        const tableName = tableMatch[1];
        // Parse column definitions
        const columnsMatch = query.match(/\(([^)]+)\)/i);
        let schema = undefined;
        if (columnsMatch) {
            schema = {};
            const columnDefs = columnsMatch[1].split(',').map(c => c.trim());
            for (const colDef of columnDefs) {
                const parts = colDef.split(/\s+/);
                const colName = parts[0];
                const colType = parts[1]?.toLowerCase() || 'string';
                // Map SQL types to our types
                let fieldType = 'string';
                if (colType.includes('int') || colType.includes('decimal') || colType.includes('float') || colType.includes('double')) {
                    fieldType = 'number';
                }
                else if (colType.includes('bool')) {
                    fieldType = 'boolean';
                }
                else if (colType.includes('date') || colType.includes('time')) {
                    fieldType = 'date';
                }
                schema[colName] = {
                    type: fieldType,
                    required: colDef.toLowerCase().includes('not null')
                };
            }
        }
        const created = this.engine.createRack(database, tableName, 'sql', schema);
        return {
            message: created ? 'Table created' : 'Table already exists',
            affectedRows: created ? 1 : 0
        };
    }
    async handleDropTable(query, database) {
        // Parse: DROP TABLE table_name
        const tableMatch = query.match(/drop\s+table\s+([a-z0-9_]+)/i);
        if (!tableMatch)
            throw new Error('Invalid DROP TABLE query');
        const tableName = tableMatch[1];
        const deleted = this.engine.deleteRack(database, tableName);
        return {
            message: deleted ? 'Table dropped' : 'Table not found',
            affectedRows: deleted ? 1 : 0
        };
    }
    generateSecurePassword(length = 16) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
        let password = '';
        for (let i = 0; i < length; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return password;
    }
    async close() {
        if (this.pool) {
            await this.pool.end();
        }
    }
}
exports.SQLBridgeService = SQLBridgeService;
//# sourceMappingURL=sql-bridge.service.js.map