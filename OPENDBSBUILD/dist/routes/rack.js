"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rackRoutes = void 0;
const engine_1 = require("../engine");
const config_1 = require("../config");
const rackRoutes = async (fastify) => {
    const engine = new engine_1.OpenDBSEngine(config_1.config.dbPath);
    // Create rack
    fastify.post('/', async (request, reply) => {
        const { database } = request.params;
        const { name } = request.body;
        if (!name) {
            return reply.status(400).send({ error: 'Rack name is required' });
        }
        const created = engine.createRack(database, name);
        if (created) {
            return reply.status(201).send({
                message: 'Rack created successfully',
                database,
                rack: name
            });
        }
        else {
            return reply.status(409).send({ error: 'Rack already exists' });
        }
    });
    // List racks
    fastify.get('/', async (request, reply) => {
        const { database } = request.params;
        const stats = JSON.parse(engine.getStats());
        return reply.send({
            database,
            racks: stats.racks
        });
    });
};
exports.rackRoutes = rackRoutes;
//# sourceMappingURL=rack.js.map