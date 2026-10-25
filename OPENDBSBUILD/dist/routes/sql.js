"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSQLRoutes = createSQLRoutes;
const sql_bridge_service_1 = require("../services/sql-bridge.service");
const auth_middleware_1 = require("../middleware/auth.middleware");
const security_middleware_1 = require("../middleware/security.middleware");
function createSQLRoutes(authService, sqlBridge) {
    /**
     * Checks the permission the *statement* needs (SELECT → read,
     * INSERT/UPDATE/CREATE → write, DELETE/DROP → delete), not just read.
     */
    /** Bind parameters for ? / $1 placeholders: an array of JSON values (at most 10,000). */
    const paramsOf = (body) => {
        const p = body?.params;
        if (p === undefined || p === null)
            return [];
        if (!Array.isArray(p))
            return 'params must be an array';
        if (p.length > 10_000)
            return 'At most 10,000 params';
        return p;
    };
    const authorize = (request, reply, database, query) => {
        if (typeof database !== 'string' || !(0, security_middleware_1.validateIdentifier)(database)) {
            reply.status(400).send({ error: 'A valid database name is required' });
            return false;
        }
        if (typeof query !== 'string' || !query.trim()) {
            reply.status(400).send({ error: 'SQL query is required' });
            return false;
        }
        const user = request.user;
        if (database === '_opendbs_system' && user.role !== 'admin') {
            reply.status(403).send({ error: 'Cannot access system database' });
            return false;
        }
        let needed;
        try {
            needed = (0, sql_bridge_service_1.requiredSQLPermission)(query);
        }
        catch (e) {
            reply.status(400).send({ error: e.message });
            return false;
        }
        if (!authService.hasPermission(user, database, needed)) {
            reply.status(403).send({ error: `No ${needed} permission for database '${database}'` });
            return false;
        }
        return true;
    };
    return async (fastify) => {
        /**
         * POST /api/sql/credentials
         * Generate SQL credentials for the authenticated user
         */
        fastify.post('/credentials', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            // Check if user already has SQL credentials
            let credentials = sqlBridge.getSQLCredentials(user.id);
            if (!credentials) {
                credentials = sqlBridge.generateSQLCredentials(user.id, user.username);
            }
            return reply.send({
                message: 'SQL credentials generated',
                credentials: {
                    username: credentials.username,
                    password: credentials.password,
                    host: credentials.host,
                    port: credentials.port,
                    connectionString: `mysql://${credentials.username}:${credentials.password}@${credentials.host}:${credentials.port}/`,
                },
            });
        });
        /**
         * GET /api/sql/credentials
         * Get existing SQL credentials
         */
        fastify.get('/credentials', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const user = request.user;
            const credentials = sqlBridge.getSQLCredentials(user.id);
            if (!credentials) {
                return reply.status(404).send({
                    error: 'SQL credentials not generated. Use POST /api/sql/credentials to create them.'
                });
            }
            return reply.send({
                credentials: {
                    username: credentials.username,
                    host: credentials.host,
                    port: credentials.port,
                    createdAt: credentials.createdAt,
                    connectionString: `mysql://${credentials.username}:****@${credentials.host}:${credentials.port}/`,
                },
            });
        });
        /**
         * POST /api/sql/query
         * Execute SQL query (bridges to NoSQL). Body: { database, query }
         */
        fastify.post('/query', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const { query, database } = (request.body ?? {});
            if (!authorize(request, reply, database, query))
                return reply;
            const params = paramsOf(request.body);
            if (typeof params === 'string')
                return reply.status(400).send({ error: params });
            try {
                const result = await sqlBridge.executeSQL(query, database, params);
                return reply.send({ success: true, result });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        });
        /**
         * POST /api/sql/:database/execute
         * Execute SQL query on specific database
         */
        fastify.post('/:database/execute', {
            preHandler: [(0, auth_middleware_1.authMiddleware)(authService)],
        }, async (request, reply) => {
            const { database } = request.params;
            const { query } = (request.body ?? {});
            if (!authorize(request, reply, database, query))
                return reply;
            const params = paramsOf(request.body);
            if (typeof params === 'string')
                return reply.status(400).send({ error: params });
            try {
                const results = await sqlBridge.executeScript(query, database, params);
                const last = results[results.length - 1];
                return reply.send({
                    success: true,
                    // Last statement's output (backwards compatible shape)…
                    result: last.result,
                    rowCount: last.rowCount,
                    total: last.total,
                    columns: last.columns,
                    truncated: last.truncated,
                    // …and every statement's, for multi-statement scripts.
                    results,
                });
            }
            catch (error) {
                return reply.status(400).send({ error: error.message });
            }
        });
    };
}
//# sourceMappingURL=sql.js.map