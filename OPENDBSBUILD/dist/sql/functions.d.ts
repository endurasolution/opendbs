/**
 * SQL value semantics and scalar functions.
 *
 * NULL is null/undefined. Predicates return true / false / null (unknown).
 * Comparisons: numbers with numbers, strings with strings (case-sensitive),
 * booleans compare as 0/1, and a string that is exactly a number's canonical
 * form ("42", not "042") compares as that number — so ids ("7") equal 7.
 * Other mixes (e.g. 'abc' vs 3) are unknown, i.e. never match.
 * Dates are ISO-8601 strings (UTC).
 */
export declare const isNull: (v: any) => boolean;
/** "42" → 42 when the string is a number's canonical spelling; otherwise null. */
export declare function canonicalNumber(s: string): number | null;
/** Number for arithmetic: numbers, booleans (1/0), numeric strings. null otherwise. */
export declare function toNum(v: any): number | null;
export declare function toStr(v: any): string | null;
/** Truth value of a condition: true, false or null (unknown). */
export declare function truth(v: any): boolean | null;
/** Three-way comparison, or null when the values are NULL or not comparable. */
export declare function compare(a: any, b: any): number | null;
export declare function sqlEquals(a: any, b: any): boolean | null;
/** Total order for ORDER BY / GROUP BY / DISTINCT: NULL, numbers, strings, booleans, objects. */
export declare function sortCompare(a: any, b: any): number;
/** Key identifying a value for GROUP BY / DISTINCT / hash joins ("7" and 7 are the same key). */
export declare function valueKey(v: any): string;
export declare function toDate(v: any): Date | null;
export declare const isoDate: (d: Date) => string;
export declare const isoDateTime: (d: Date) => string;
/** date ± n units (months/years are calendar-aware). Keeps a date-only input date-only for day-or-larger units. */
export declare function addInterval(v: any, n: number, unit: string, sign?: number): string | null;
export declare function castTo(v: any, to: string): any;
/** MySQL-style path: $.a.b[0] or $."key with spaces" */
export declare function jsonPath(doc: any, path: string): any;
export interface FnContext {
    now: Date;
    database: string;
}
type Fn = (args: any[], ctx: FnContext) => any;
export declare const FUNCTIONS: Record<string, Fn>;
/** Value of INTERVAL n unit (only meaningful in date arithmetic). */
export interface IntervalValue {
    __interval: true;
    n: number;
    unit: string;
}
export declare function makeInterval(n: any, unit: string): IntervalValue | null;
export declare const isInterval: (v: any) => v is IntervalValue;
export {};
//# sourceMappingURL=functions.d.ts.map