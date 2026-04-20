"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSearchRoutes = createSearchRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
function createSearchRoutes(authService, engine) {
    return async (fastify) => {
        /**
         * POST /search/advanced - Advanced search with operators
         */
        fastify.post('/', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, rack } = request.params;
            const { query } = request.body;
            if (!query) {
                return reply.status(400).send({ error: 'Query object required' });
            }
            const results = engine.find(database, rack, JSON.stringify(query));
            return reply.send({
                results: results.map((r) => JSON.parse(r)),
                count: results.length,
            });
        });
        /**
         * POST /search/fuzzy - Fuzzy search
         */
        fastify.post('/fuzzy', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, query, threshold = 0.7 } = request.body;
            if (!field || !query) {
                return reply.status(400).send({ error: 'Field and query are required' });
            }
            const results = engine.fuzzySearch(database, rack, field, query, threshold);
            return reply.send({
                results: results.map((r) => JSON.parse(r)),
                count: results.length,
            });
        });
        /**
         * POST /search/range - Range search (convenience endpoint)
         */
        fastify.post('/range', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, min, max } = request.body;
            if (!field) {
                return reply.status(400).send({ error: 'Field is required' });
            }
            const query = {};
            query[field] = {};
            if (min !== undefined) {
                query[field].$gte = min;
            }
            if (max !== undefined) {
                query[field].$lte = max;
            }
            const results = engine.find(database, rack, JSON.stringify(query));
            return reply.send({
                results: results.map((r) => JSON.parse(r)),
                count: results.length,
            });
        });
        /**
         * POST /search/pattern - Pattern matching (regex)
         */
        fastify.post('/pattern', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, pattern, options } = request.body;
            if (!field || !pattern) {
                return reply.status(400).send({
                    error: 'Field and pattern are required',
                });
            }
            const query = {};
            query[field] = {
                $regex: pattern,
            };
            if (options) {
                query[field].$options = options;
            }
            const results = engine.find(database, rack, JSON.stringify(query));
            return reply.send({
                results: results.map((r) => JSON.parse(r)),
                count: results.length,
            });
        });
        /**
         * POST /search/vector - Vector search
         */
        fastify.post('/vector', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, vector, k = 10 } = request.body;
            if (!field || !vector || !Array.isArray(vector)) {
                return reply.status(400).send({
                    error: 'Field and vector (array of numbers) are required',
                });
            }
            const results = engine.vectorSearch(database, rack, field, vector, k);
            return reply.send({
                results: results.map((r) => JSON.parse(r)),
                count: results.length,
            });
        });
    };
}
//# sourceMappingURL=search.js.map