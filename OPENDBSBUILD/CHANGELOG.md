# Changelog

## 1.0.1 — first stable release (2026-10-25)

This release is the result of a security review and attack testing of the whole server. A test that attacks a live server (`tests/security-test.js`) now passes all 70 of its checks. The full regression suite also passes:

- end-to-end tests on both storage engines;
- SQL compared against SQLite;
- parallel queries;
- replication and failover;
- sharding, including a router that is itself a cluster;
- the admin panel.

### Security fixes

See [SECURITY.md](SECURITY.md#fixed-in-101) for details.

- **High: regular expressions could freeze the server.** `$regex`, SQL `REGEXP` and the `REGEXP_*` functions accepted patterns that backtrack catastrophically, such as `(a|a)*b` or `(.*a){20}`. One request blocked all others. Patterns are now analysed structurally and rejected if they repeat a group that itself repeats or alternates, use backreferences, or contain too many unbounded repetitions.
- **High: SQL `LIKE` could freeze the server.** LIKE was compiled into a backtracking regex, so a pattern with many `%` stalled on long values. LIKE now uses a linear-time matcher, which is also used when LIKE conditions are pushed down to the engine (`$like`).
- **High: string functions could exhaust memory and crash the server.** `LPAD`, `RPAD`, `REPEAT`, `SPACE` and `REPLACE` could build strings of hundreds of MB to GB. Their results are now capped at 16 million characters.
- **High: a client header could bypass the sharding router.** Any client could send `x-opendbs-shard-request` and write directly to the router's local copy of a sharded rack, breaking routing and id allocation. Only the router's own in-process calls skip routing now.
- **Medium: internal shard endpoints were open to users.** On the router, users with write permission could call `/api/shard/:db/:rack/put` and `/delete` against a sharded rack. These now accept only the router itself.
- **Medium: ids could be reused.** Documents stored with explicit ids (shard writes, rebalancing) did not advance the rack's id counter, so a later normal insert could overwrite them. Fixed.
- **Medium: idempotent-retry responses could leak.**
  - A recorded response was replayed before authentication, and to any caller who presented the same `Idempotency-Key`.
  - Recorded responses could contain secrets, such as a newly created API key, kept in the system database and in backups.

  Records are now tied to the verified caller. Admin, settings, backup and auth traffic and read-only requests are never recorded.
- **Low: the public cluster status said too much.** `/api/cluster/status` exposed internal member URLs, log positions and document counts. It now returns only `role`, `primary` and `leaderId`; the details remain on the admin-only `/api/admin/cluster`.
- **Low: cluster RPC was unthrottled.** The cluster RPC endpoint now limits its body to 4 MB and throttles senders whose messages fail authentication.
- **Low: the forwarded-IP header could be replayed.** The sealed header a replica uses to pass on a client's real IP is now bound to the request's method and URL, so a captured header can't lend that IP to another request.
- **Low: the 2FA session flag was shared between sessions.** It was stored on the user object that all concurrent sessions of an account share. Each request now gets its own copy.

### Reliability fixes

- **Replication: a first-start race could make a replica diverge.**
  - A fresh member that briefly won the very first election could later follow another primary without copying its data first.
  - The cause: data that existed before logging started was never sent to it.
  - Each dataset now carries a **lineage** id. It is created by the first primary and copied by every full sync, and a replica continues incrementally only from a primary of the same lineage.
  - **After upgrading a cluster, each replica makes one full copy.**
- **SQL:** a window function combined with `HAVING` failed (`Cannot read properties of undefined`). Fixed.
- **Older clients:** a request with `Content-Type: application/json` and an empty body was refused with "Body cannot be empty". The 1.0.0 npm client sends its delete, clear and drop calls that way. An empty JSON body is now treated as no body.

### Other changes

- Version 1.0.1 for the server and the Node.js, Python, PHP and Dart / Flutter drivers.
- **npm package `opendbs` 1.0.1** is the new Node.js client (no dependencies, cluster failover, safe retries, TypeScript types). Code written for the 1.0.0 client keeps working: its methods, such as `insert(db, rack, doc)` and `login(username, password)`, and its `baseURL` option are still supported. `ignoreSSL` is no longer supported; use `NODE_EXTRA_CA_CERTS`.
- **pub.dev package `opendbs` 1.0.1** is a new Dart / Flutter client with the same API as the other drivers (racks, SQL with parameters, transactions, cluster failover, safe retries). It also works on the web and in plain Dart. The 1.0.0 methods keep working, and its `fuzzySearch()` now calls the right endpoint.
- **Docker image `endurasolution/opendbs:1.0.1`**: builds the Linux engine, runs in production mode as an unprivileged user, and keeps data and keys in the `/data` volume.
- New documentation: [README](README.md), [Administrator Guide](docs/ADMIN_GUIDE.md) (including cluster and sharding), and [SECURITY.md](SECURITY.md).
- The admin panel's API docs now list the cluster and sharding endpoints.

---

## Road to 1.0 (pre-releases)

- **0.6.0: sharding.**
  - A rack can be spread over several servers with a router, 4096 hash buckets and a shard key.
  - Queries scatter to the shards and are merged; GROUP BY is computed on the shards; SQL works on sharded tables.
  - Rebalancing with reads online.
  - Admin "Sharding" page.
- **0.5.0: replication and automatic failover.**
  - Log shipping in the same commit as the data; Raft-style elections; `majority` write concern.
  - Writes forwarded from replicas; read-your-writes.
  - Idempotency keys; drivers with multi-URL failover.
  - Admin "Cluster" page.
- **0.4.x: multi-core queries and full SQL.**
  - Worker threads for large scans, top-K and GROUP BY.
  - A new SQL engine: joins, subqueries, CTEs, windows, upserts, RETURNING, parameters and EXPLAIN, verified against SQLite.
- **0.4.0: disk storage engine.** An encrypted (AES-256-XTS) B-tree in Rust, so data can be larger than RAM, with ACID group commit.
- **0.3.0: enterprise features.**
  - Encryption at rest; fsync'd write-ahead log with group commit.
  - Multi-rack transactions; aggregation pipeline; compound indexes.
  - Drivers for Node.js, Python and PHP.
- **0.2.0: core rebuild.**
  - Write-ahead logging; a query planner with indexes.
  - The admin panel; access keys with IP allow-lists; 2FA.
  - SQL tables with typed schemas.
