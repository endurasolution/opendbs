"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAiDatasetRoutes = createAiDatasetRoutes;
const auth_middleware_1 = require("../middleware/auth.middleware");
function createAiDatasetRoutes(authService, engine) {
    return async (fastify) => {
        /**
         * POST /api/ai/datasets/:database/:name
         * Create a new Dataset (Rack)
         */
        fastify.post('/:database/:name', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'write'), // Creating a dataset needs write permission on DB
            ],
        }, async (request, reply) => {
            const { database, name } = request.params;
            try {
                const created = engine.createRack(database, name);
                if (!created) {
                    return reply.status(409).send({ error: 'Dataset (Rack) already exists' });
                }
                // Could add initial metadata here if we had detailed rack metadata
                return reply.status(201).send({
                    message: 'Dataset created successfully',
                    dataset: name,
                    database
                });
            }
            catch (e) {
                return reply.status(404).send({ error: e.message });
            }
        });
        /**
         * POST /api/ai/datasets/:database/:name/snapshot
         * Create a snapshot (version) of a dataset
         */
        fastify.post('/:database/:name/snapshot', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'write'), // Cloning needs read/write
            ],
        }, async (request, reply) => {
            const { database, name } = request.params;
            const { versionTag } = request.body;
            if (!versionTag) {
                return reply.status(400).send({ error: 'versionTag is required (e.g., v1)' });
            }
            const targetName = `${name}_${versionTag}`;
            try {
                const success = engine.duplicateRack(database, name, database, targetName);
                if (!success) {
                    return reply.status(409).send({ error: `Snapshot '${targetName}' already exists` });
                }
                return reply.status(201).send({
                    message: 'Snapshot created',
                    original: name,
                    snapshot: targetName
                });
            }
            catch (e) {
                return reply.status(404).send({ error: e.message });
            }
        });
        /**
         * POST /api/ai/datasets/:database/:name/ingest
         * Bulk Ingest Data
         */
        fastify.post('/:database/:name/ingest', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'write'),
            ],
        }, async (request, reply) => {
            const { database, name } = request.params;
            const data = request.body;
            if (!Array.isArray(data)) {
                return reply.status(400).send({ error: 'Request body must be a JSON array' });
            }
            try {
                const ids = engine.insertMany(database, name, data);
                return reply.send({
                    message: 'Ingestion complete',
                    count: ids.length,
                    ids
                });
            }
            catch (e) {
                return reply.status(404).send({ error: e.message });
            }
        });
        /**
         * GET /api/ai/datasets/:database/:name/export
         * Export Dataset as JSON
         */
        fastify.get('/:database/:name/export', {
            preHandler: [
                (0, auth_middleware_1.authMiddleware)(authService),
                (0, auth_middleware_1.checkPermission)(authService, 'read'),
            ],
        }, async (request, reply) => {
            const { database, name } = request.params;
            // Get all documents (empty query match all)
            const results = engine.find(database, name, '{}');
            const parsedResults = results.map(r => JSON.parse(r));
            return reply.send(parsedResults);
        });
    };
}
//# sourceMappingURL=ai-datasets.js.map