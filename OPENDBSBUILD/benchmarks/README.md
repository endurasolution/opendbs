# Benchmarks

Runs the same workloads against OpenDBS, PostgreSQL, MySQL, MongoDB and SQLite, so the numbers on
[opendbs.in/benchmarks](https://opendbs.in/benchmarks) can be reproduced and checked.

Needs Docker (with about 8 GB of memory for its VM) and bash.

```bash
cd benchmarks
bash run.sh 3            # 3 runs of every database (about 30 minutes)
node summarize.js        # medians per database → console table and results.ts
```

## What runs

Each database runs alone, in a fresh container and volume, limited to 4 CPUs and 4 GB of RAM, with a
1 GB cache (`shared_buffers`, `innodb_buffer_pool_size`, `wiredTigerCacheSizeGB`, `CACHE_SIZE_MB`).
The client is a Node.js 22 container on the same Docker network, also limited to 4 CPUs, using each
database's standard driver (`pg`, `mysql2`, `mongodb`, `better-sqlite3`, and the OpenDBS Node.js client).

Data: 100,000 rows of `name, email, city (50 values), age, score`. Workloads, in order:

| Workload | What is measured |
|---|---|
| Bulk load | 100,000 rows, 1,000 per request or statement → rows/s |
| Index build | an index on `(city, age)` → ms |
| Point reads | 20,000 reads by primary key, 16 concurrent clients → ops/s, p50, p99 |
| Indexed query | `city = ? AND age >= ? ORDER BY age LIMIT 50`, 5,000 queries, 16 concurrent → ops/s |
| Single inserts | 5,000 one-row inserts, each its own durable commit, 16 concurrent → ops/s |
| Updates | 5,000 updates of one field by primary key, 16 concurrent → ops/s |
| GROUP BY | `COUNT(*)` and `AVG(score)` per city over the whole table → median ms of 10 |

Every write is durable when acknowledged: PostgreSQL and MySQL use their defaults (fsync on commit),
MongoDB uses `writeConcern {w: 1, j: true}`, SQLite `journal_mode=WAL` with `synchronous=FULL`, and
OpenDBS acknowledges after fsync by default.

OpenDBS is used the way applications use it: through its HTTP/JSON API with the Node.js client and an
API key (the client adds an `Idempotency-Key` to every write). `RATE_LIMIT_MAX` is raised so the
per-IP rate limit doesn't throttle the benchmark client.

SQLite is a library inside the client process, not a server: it has no network round trip, and it runs
single-threaded (concurrency 1). Compare it with the servers only with that in mind.
