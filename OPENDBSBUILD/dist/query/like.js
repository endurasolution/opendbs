"use strict";
/**
 * SQL LIKE without regular expressions: % matches any run of characters,
 * _ exactly one, the escape character makes the next one literal.
 * Matching is case-insensitive (MySQL's default collation behaviour).
 *
 * A LIKE pattern turned into a regex (^a.*b.*c$) backtracks polynomially —
 * a pattern with many % on a long value can stall the server. This matcher
 * keeps one backtrack point, so it is O(value × pattern) in the worst case.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LIKE_PATTERN = void 0;
exports.compileLike = compileLike;
exports.MAX_LIKE_PATTERN = 1000;
function compileLike(pattern, escape = '\\') {
    if (typeof pattern !== 'string')
        throw new Error('LIKE pattern must be a string');
    if (pattern.length > exports.MAX_LIKE_PATTERN)
        throw new Error(`LIKE pattern too long (max ${exports.MAX_LIKE_PATTERN} characters)`);
    const toks = [];
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (escape && ch === escape && i + 1 < pattern.length)
            toks.push(pattern[++i].toLowerCase());
        else if (ch === '%') {
            if (toks[toks.length - 1] !== 0)
                toks.push(0);
        }
        else if (ch === '_')
            toks.push(1);
        else
            toks.push(ch.toLowerCase());
    }
    return (value) => {
        const s = value.toLowerCase();
        let si = 0, ti = 0, starTi = -1, starSi = 0;
        while (si < s.length) {
            const t = toks[ti];
            if (ti < toks.length && t !== 0 && (t === 1 || t === s[si])) {
                si++;
                ti++;
            }
            else if (ti < toks.length && t === 0) {
                starTi = ti++;
                starSi = si;
            }
            else if (starTi >= 0) {
                ti = starTi + 1;
                si = ++starSi;
            }
            else
                return false;
        }
        while (ti < toks.length && toks[ti] === 0)
            ti++;
        return ti === toks.length;
    };
}
//# sourceMappingURL=like.js.map