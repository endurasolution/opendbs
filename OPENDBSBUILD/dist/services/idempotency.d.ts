import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OpenDBSEngine } from '../engine';
/** The verified caller of a request ("user:<id>" / "key:<id>"), or null when it has no valid credentials. */
export type Identify = (request: FastifyRequest) => string | null;
export declare class IdempotencyService {
    private engine;
    private identify;
    private inProgress;
    private releases;
    constructor(engine: OpenDBSEngine, identify: Identify);
    private keyOf;
    /** Record id: the client's key scoped to the verified caller. */
    private ridOf;
    private find;
    private expire;
    register(fastify: FastifyInstance): void;
    /**
     * onSend: records the response. Registered before the durability hook, so
     * the record joins the write's own commit batch.
     */
    record(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<void>;
}
//# sourceMappingURL=idempotency.d.ts.map