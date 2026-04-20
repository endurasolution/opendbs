import { FastifyRequest, FastifyReply } from 'fastify';
export declare function validateIdentifier(name: string): boolean;
export declare function sanitizeObject(obj: any, depth?: number): any;
export declare function validateRegexPattern(pattern: string): void;
export declare function timingSafeEqual(a: string, b: string): boolean;
export declare function checkLoginRateLimit(ip: string): void;
export declare function recordLoginFailure(ip: string): void;
export declare function recordLoginSuccess(ip: string): void;
export declare function identifierParamGuard(): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export declare const SENSITIVE_ENV_KEYS: Set<string>;
export declare function maskSensitiveEnv(env: Record<string, string>): Record<string, string>;
//# sourceMappingURL=security.middleware.d.ts.map