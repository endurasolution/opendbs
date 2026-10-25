/**
 * Query compiler. A query object is turned into a matcher closure once per
 * find() call -- regexes are compiled once, operator dispatch is resolved
 * once -- instead of re-interpreting the query object for every document.
 *
 * Semantics follow MongoDB where they differ from the old matcher:
 *  - top-level keys are implicitly AND-ed, including alongside $and/$or
 *    (previously a top-level $and/$or silently ignored sibling keys);
 *  - an array field matches equality / comparison / $in when ANY element
 *    matches (so {tags: "x"} finds documents whose tags array contains "x");
 *  - $ne / $nin also match documents where the field is missing;
 *  - comparisons only match values of the same type (no "10" > 5 coercion);
 *  - dotted paths ("address.city") reach into nested objects.
 */
export type Matcher = (data: any, docId: string) => boolean;
/** Resolves a (possibly dotted) path using own properties only. */
export declare function getPath(obj: any, path: string): any;
export declare function hasPath(obj: any, path: string): boolean;
export declare function compileQuery(query: any): Matcher;
/** Total order across mixed types; missing/null values sort last. */
export declare function compareValues(a: any, b: any): number;
//# sourceMappingURL=matcher.d.ts.map