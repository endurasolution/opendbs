"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.documentRoutes = void 0;
const engine_1 = require("../engine");
const config_1 = require("../config");
const documentRoutes = async (fastify) => {
    const engine = new engine_1.OpenDBSEngine(config_1.config.dbPath);
    // Insert document
    fastify.post('/', async (request, reply) => {
        const { database, rack } = request.params;
        const data = request.body;
        const id = engine.insert(database, rack, JSON.stringify(data));
        return reply.status(201).send({
            message: 'Document inserted successfully',
            id,
            database,
            rack
        });
    });
    // Find documents
    fastify.get('/', async (request, reply) => {
        const { database, rack } = request.params;
        const query = request.query;
        const results = engine.find(database, rack, JSON.stringify(query || {}));
        return reply.send({
            results: results.map(r => JSON.parse(r)),
            count: results.length
        });
    });
    // Get document by ID
    fastify.get('/:id', async (request, reply) => {
        const { database, rack, id } = request.params;
        const results = engine.find(database, rack, JSON.stringify({ id }));
        if (results.length === 0) {
            return reply.status(404).send({ error: 'Document not found' });
        }
        return reply.send(JSON.parse(results[0]));
    });
    // Update document
    fastify.put('/:id', async (request, reply) => {
        const { database, rack, id } = request.params;
        const data = request.body;
        const updated = engine.update(database, rack, id, JSON.stringify(data));
        if (updated) {
            return reply.send({
                message: 'Document updated successfully',
                id
            });
        }
        else {
            return reply.status(404).send({ error: 'Document not found' });
        }
    });
    // Delete document
    fastify.delete('/:id', async (request, reply) => {
        const { database, rack, id } = request.params;
        const deleted = engine.delete(database, rack, id);
        if (deleted) {
            return reply.send({
                message: 'Document deleted successfully',
                id
            });
        }
        else {
            return reply.status(404).send({ error: 'Document not found' });
        }
    });
};
exports.documentRoutes = documentRoutes;
//# sourceMappingURL=document.js.map