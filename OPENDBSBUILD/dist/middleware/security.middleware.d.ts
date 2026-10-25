import { FastifyRequest, FastifyReply } from 'fastify';
export declare function validateIdentifier(name: string): boolean;
export declare function validateFieldName(name: string): boolean;
export declare function sanitizeObject(obj: any, depth?: number): any;
/**
 * Strips prototype-pollution keys from a document body at any depth and
 * bounds nesting so a hostile payload can't blow the stack in later
 * recursive code (hashing, cloning, matching). Mutates nothing -- returns
 * a clean copy only when something had to be removed.
 */
export declare function sanitizeDocument(obj: any, depth?: number): any;
export declare function isPlainObject(v: unknown): v is Record<string, any>;
/**
 * Structural ReDoS check (JavaScript regexes have no time limit, and one
 * runaway match blocks the whole server). Rejects:
 *  - a repeated group that itself contains a repetition or an alternation:
 *    (a+)+  (a*)*  (.*a){20}  (a|aa)+  (\w+\s?)*
 *  - backreferences (\1, \k<name>)
 *  - more than MAX_UNBOUNDED_QUANTIFIERS unbounded quantifiers (.*a.*b.*c… is polynomial)
 * Returns the reason, or null when the pattern is acceptable.
 */
export declare function regexRisk(p: string): string | null;
export declare function validateRegexPattern(pattern: string): void;
export declare function validateRegexOptions(options: unknown): string;
export declare function timingSafeEqual(a: string, b: string): boolean;
export declare function sha256Hex(value: string): string;
export declare function checkLoginRateLimit(ip: string, username?: string): void;
export declare function recordLoginFailure(ip: string, username?: string): void;
export declare function recordLoginSuccess(ip: string, username?: string): void;
export declare function validatePasswordStrength(password: unknown): string | null;
export declare function identifierParamGuard(): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export declare const SENSITIVE_ENV_KEYS: Set<string>;
export declare const MASKED_VALUE = "***";
export declare function isSensitiveEnvKey(key: string): boolean;
export declare function maskSensitiveEnv(env: Record<string, string>): Record<string, string>;
//# sourceMappingURL=security.middleware.d.ts.map