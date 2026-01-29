"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
async function errorHandler(error, request, reply) {
    request.log.error(error);
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';
    reply.status(statusCode).send({
        error: {
            message,
            statusCode,
            timestamp: new Date().toISOString(),
            path: request.url,
        },
    });
}
//# sourceMappingURL=errorHandler.js.map