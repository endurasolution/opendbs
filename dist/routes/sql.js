"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSQLRoutes = createSQLRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
function createSQLRoutes(authService, sqlBridge) {
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
         * Execute SQL query (bridges to NoSQL)
         */
        fastify.post('/query', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, rack } = request.params;
            const { query } = request.body;
            if (!query) {
                return reply.status(400).send({ error: 'SQL query is required' });
            }
            try {
                const result = await sqlBridge.executeSQL(query, database);
                return reply.send({
                    success: true,
                    result,
                    query,
                });
            }
            catch (error) {
                return reply.status(400).send({
                    error: error.message,
                    query
                });
            }
        });
        /**
         * POST /api/sql/:database/execute
         * Execute SQL query on specific database
         */
        fastify.post('/:database/execute', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database } = request.params;
            const { query, params } = request.body;
            if (!query) {
                return reply.status(400).send({ error: 'SQL query is required' });
            }
            try {
                const result = await sqlBridge.executeSQL(query, database);
                return reply.send({
                    success: true,
                    result,
                    rowCount: Array.isArray(result) ? result.length : result.affectedRows || 0,
                });
            }
            catch (error) {
                return reply.status(400).send({
                    error: error.message,
                    query
                });
            }
        });
    };
}
//# sourceMappingURL=sql.js.map