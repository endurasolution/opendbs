"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSearchRoutes = createSearchRoutes;
const config_1 = require("../config");
const auth_middleware_1 = require("../middleware/auth.middleware");
const security_middleware_1 = require("../middleware/security.middleware");
const clampInt = (v, min, max, def) => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};
function createSearchRoutes(authService, engine) {
    return async (fastify) => {
        const guards = { preHandler: [(0, auth_middleware_1.authMiddleware)(authService), (0, auth_middleware_1.checkPermission)(authService, 'read')] };
        /**
         * POST /search - Advanced search with operators.
         * Body: { query, skip?, limit?, sort?: { field, order }, populate? }
         */
        fastify.post('/', guards, async (request, reply) => {
            const { database, rack } = request.params;
            const body = (request.body ?? {});
            if (!body.query || typeof body.query !== 'object') {
                return reply.status(400).send({ error: 'Query object required' });
            }
            try {
                const { results, total } = await engine.queryAsync(database, rack, body.query, {
                    skip: clampInt(body.skip, 0, Number.MAX_SAFE_INTEGER, 0),
                    limit: body.limit !== undefined ? clampInt(body.limit, 1, config_1.config.maxQueryLimit, 100) : undefined,
                    sort: body.sort?.field ? { field: body.sort.field, order: body.sort.order === 'desc' ? 'desc' : 'asc' } : undefined,
                    populate: body.populate === true,
                });
                return reply.send({ results, count: results.length, total });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        /**
         * POST /search/fuzzy - Fuzzy search
         */
        fastify.post('/fuzzy', guards, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, query, threshold = 0.7 } = (request.body ?? {});
            if (!field || !query) {
                return reply.status(400).send({ error: 'Field and query are required' });
            }
            if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
                return reply.status(400).send({ error: 'threshold must be a number between 0 and 1' });
            }
            try {
                const results = engine.fuzzySearch(database, rack, field, query, threshold);
                return reply.send({ results: results.map((r) => JSON.parse(r)), count: results.length });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        /**
         * POST /search/range - Range search (convenience endpoint)
         */
        fastify.post('/range', guards, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, min, max } = (request.body ?? {});
            if (!field || !(0, security_middleware_1.validateFieldName)(field)) {
                return reply.status(400).send({ error: 'A valid field is required' });
            }
            const cond = {};
            if (min !== undefined)
                cond.$gte = min;
            if (max !== undefined)
                cond.$lte = max;
            try {
                const { results } = engine.query(database, rack, Object.keys(cond).length ? { [field]: cond } : {});
                return reply.send({ results, count: results.length });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        /**
         * POST /search/pattern - Pattern matching (regex)
         */
        fastify.post('/pattern', guards, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, pattern, options } = (request.body ?? {});
            if (!field || !pattern || !(0, security_middleware_1.validateFieldName)(field)) {
                return reply.status(400).send({ error: 'A valid field and pattern are required' });
            }
            const cond = { $regex: pattern };
            if (options)
                cond.$options = options;
            try {
                const { results } = engine.query(database, rack, { [field]: cond });
                return reply.send({ results, count: results.length });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
        /**
         * POST /search/vector - Vector search
         */
        fastify.post('/vector', guards, async (request, reply) => {
            const { database, rack } = request.params;
            const { field, vector, k = 10 } = (request.body ?? {});
            if (!field || !vector || !Array.isArray(vector)) {
                return reply.status(400).send({
                    error: 'Field and vector (array of numbers) are required',
                });
            }
            try {
                const results = engine.vectorSearch(database, rack, field, vector, clampInt(k, 1, 1000, 10));
                return reply.send({ results: results.map((r) => JSON.parse(r)), count: results.length });
            }
            catch (e) {
                return reply.status(400).send({ error: e.message });
            }
        });
    };
}
//# sourceMappingURL=search.js.map