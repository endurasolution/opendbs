/**
 * SQL LIKE without regular expressions: % matches any run of characters,
 * _ exactly one, the escape character makes the next one literal.
 * Matching is case-insensitive (MySQL's default collation behaviour).
 *
 * A LIKE pattern turned into a regex (^a.*b.*c$) backtracks polynomially —
 * a pattern with many % on a long value can stall the server. This matcher
 * keeps one backtrack point, so it is O(value × pattern) in the worst case.
 */
export declare const MAX_LIKE_PATTERN = 1000;
export declare function compileLike(pattern: string, escape?: string): (value: string) => boolean;
//# sourceMappingURL=like.d.ts.map