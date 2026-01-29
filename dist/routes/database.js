"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseRoutes = void 0;
const engine_1 = require("../engine");
const config_1 = require("../config");
const databaseRoutes = async (fastify) => {
    const engine = new engine_1.OpenDBSEngine(config_1.config.dbPath);
    // Create database
    fastify.post('/', async (request, reply) => {
        const { name } = request.body;
        if (!name) {
            return reply.status(400).send({ error: 'Database name is required' });
        }
        const created = engine.createDatabase(name);
        if (created) {
            return reply.status(201).send({
                message: 'Database created successfully',
                database: name
            });
        }
        else {
            return reply.status(409).send({ error: 'Database already exists' });
        }
    });
    // List databases
    fastify.get('/', async (request, reply) => {
        const stats = JSON.parse(engine.getStats());
        return reply.send({
            databases: stats.databases,
            stats
        });
    });
    // Get database info
    fastify.get('/:name', async (request, reply) => {
        const { name } = request.params;
        const stats = JSON.parse(engine.getStats());
        return reply.send({
            database: name,
            stats
        });
    });
};
exports.databaseRoutes = databaseRoutes;
//# sourceMappingURL=database.js.map