# Integration tests

Each script starts real OpenDBS server processes on random local ports with temporary data directories, runs its checks and stops the servers. They need a compiled server (`npm run build:ts`, or a production build) and Node.js 18+.

| Script | What it checks |
|---|---|
| `security-test.js` | Attacks a live server: authentication and JWT forgery, permissions (REST and SQL), injection, ReDoS and resource exhaustion, idempotency replay, sharding bypass, security headers, login rate limit (70 checks). `SKIP_DOS=1` skips the denial-of-service section |
| `shard-test.js` | A router plus 3 shard servers: queries, SQL, documents by id, DDL, rebalance under load, shard failure, router restart. Results are compared with an unsharded copy of the same data (67 checks) |
| `router-cluster-test.js` | The sharding router running as a 3-member cluster: forwarded admin changes, sharded reads on every member, router failover (14 checks) |

```bash
# from the project root, after building
node tests/security-test.js dist/index.js
node tests/shard-test.js dist/index.js
node tests/router-cluster-test.js dist/index.js
# against the production build
NODE_PATH=OPENDBSBUILD/node_modules node tests/security-test.js OPENDBSBUILD/dist/index.js
```

Each script exits with code 0 when every check passes, and prints where the server logs are kept.
