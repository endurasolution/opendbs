/**
 * SQL parser for OpenDBS (MySQL / PostgreSQL flavoured).
 *
 * Queries:  [WITH [RECURSIVE] cte AS (…), …]
 *           SELECT [DISTINCT] expr [AS a], t.*, * FROM t [AS a]
 *             [[INNER|LEFT|RIGHT|FULL [OUTER]|CROSS] JOIN … ON expr | USING (c, …)] , t2 …
 *             [WHERE expr] [GROUP BY expr, …] [HAVING expr] [WINDOW w AS (…)]
 *           [UNION [ALL] | INTERSECT [ALL] | EXCEPT [ALL] SELECT …]
 *           [ORDER BY expr [ASC|DESC] [NULLS FIRST|LAST], …]
 *           [LIMIT n [OFFSET m] | LIMIT m, n | OFFSET m ROWS FETCH FIRST n ROWS ONLY]
 * Expressions: arithmetic + - * / % DIV MOD, || (concat), comparisons incl. <=> and
 *           IS [NOT] DISTINCT FROM, AND / OR / NOT, [NOT] IN (list | subquery),
 *           [NOT] BETWEEN, [NOT] LIKE / ILIKE [ESCAPE], REGEXP / RLIKE, IS [NOT] NULL/TRUE/FALSE,
 *           EXISTS (subquery), scalar subqueries, = ANY / ALL (subquery), CASE, CAST(x AS t), x::t,
 *           INTERVAL n unit, functions (see functions.ts), aggregates with DISTINCT / FILTER,
 *           window functions with OVER (PARTITION BY … ORDER BY … ROWS|RANGE …), ? / $1 parameters.
 * Writes:   INSERT [IGNORE] INTO t [(cols)] VALUES (…), … | SELECT …
 *             [ON DUPLICATE KEY UPDATE c = expr, …] [ON CONFLICT [(c)] DO NOTHING | DO UPDATE SET …]
 *             [RETURNING …]
 *           UPDATE t [AS a] SET c = expr, … WHERE expr [RETURNING …]   (WHERE is mandatory)
 *           DELETE FROM t [AS a] WHERE expr [RETURNING …]               (WHERE is mandatory)
 * Schema:   CREATE TABLE [IF NOT EXISTS] t (col TYPE [NOT NULL] [UNIQUE] [DEFAULT v], …) | AS SELECT …
 *           DROP TABLE, TRUNCATE TABLE, ALTER TABLE ADD/DROP/MODIFY/RENAME COLUMN, ADD [UNIQUE] INDEX (…), DROP INDEX
 *           CREATE [UNIQUE] INDEX [name] ON t (c, …) · DROP INDEX name ON t
 * Other:    SHOW TABLES · SHOW INDEXES FROM t · DESCRIBE t · EXPLAIN SELECT … · BEGIN / COMMIT / ROLLBACK
 */
import { Expr, Statement } from './ast';
export * from './ast';
export declare class SQLSyntaxError extends Error {
}
export declare function isAggregateName(name: string): boolean;
export declare function isWindowOnlyName(name: string): boolean;
/**
 * SQL LIKE → anchored regex source (use with flags 's' and usually 'i').
 * % = any run, _ = one char, `esc` escapes the next char.
 */
export declare function likeToRegex(pattern: string, esc?: string): string;
/** Parses one or more `;`-separated statements. */
export declare function parseSQL(sql: string): Statement[];
export type SQLPermission = 'read' | 'write' | 'delete';
export declare function permissionFor(s: Statement): SQLPermission;
/** Parses a bare expression (e.g. a WHERE clause typed into a filter box). */
export declare function parseExpression(clause: string): Expr;
//# sourceMappingURL=parser.d.ts.map