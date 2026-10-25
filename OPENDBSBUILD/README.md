# OpenDBS

![version](https://img.shields.io/badge/version-1.0.1-blue) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![license](https://img.shields.io/badge/license-CC%20BY--NC%204.0-lightgrey)

OpenDBS is a document **and** SQL database server written in TypeScript (Node.js) with a Rust storage engine. One server gives you:

- **Schemaless JSON racks** (like MongoDB collections) and **typed SQL tables** in the same database
- **SQL**: joins, subqueries, CTEs, window functions, upserts, transactions, over both kinds of rack
- **Encrypted, crash-safe storage**: an on-disk B-tree (AES-256-XTS), so data can be far larger than RAM
- **Multi-core queries**: large scans, sorts and GROUP BYs run on worker threads
- **Replication with automatic failover** and **sharding** across several servers, built in
- **Search**: indexes, full-text / fuzzy search, vector (nearest-neighbour) search, aggregation pipelines
- **An admin panel** for databases, users, API keys, backups, cluster and shards
- **Client libraries** for Node.js, Python, PHP and Dart / Flutter (with cluster failover and safe retries)

> Version **1.0.1** is the first stable release. See [CHANGELOG.md](CHANGELOG.md) and [SECURITY.md](SECURITY.md).

---

## Contents

- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Using the API](#using-the-api)
- [SQL](#sql)
- [Client libraries](#client-libraries)
- [Scaling: workers, replication, sharding](#scaling-workers-replication-sharding)
- [Security](#security)
- [Configuration](#configuration)
- [Performance](#performance)
- [Documentation](#documentation)
- [Other platforms (building the engine)](#other-platforms-building-the-engine)
- [License](#license)

---

## Quick start

Requirements: **Node.js 18+** (20 or newer recommended). The release build includes the prebuilt Rust engine for Windows x64; on other platforms build it from source (see [Other platforms](#other-platforms-building-the-engine)) or use [Docker](#with-docker).

```bash
git clone https://github.com/endurasolution/opendbs.git
cd opendbs/OPENDBSBUILD
npm install --omit=dev
cp .env.example .env          # then edit .env (see below)
npm start
```

On the first start OpenDBS:

1. creates the user **`admin`** with the password from `ADMIN_PASSWORD` (or prints a random one **once** to the console);
2. creates the data-encryption key `./opendbs.key`. **Back this file up.** Without it, the data and the backups can't be read.

Then open:

| URL | What |
|---|---|
| `http://localhost:4402/admin/` | Admin panel (`ADMIN_PANEL_ENABLED=true`, path set by `ADMIN_PANEL_PATH`) |
| `http://localhost:4402/web/` | User web interface (`WEB_INTERFACE_ENABLED=true`) |
| `http://localhost:4402/health` | Health check |

### With Docker

The image includes the Linux engine and runs in production mode. Data, keys and backups are kept in the `/data` volume:

```bash
docker run -d --name opendbs -p 4402:4402 -v opendbs-data:/data \
  -e ADMIN_PASSWORD='choose-a-strong-password' \
  endurasolution/opendbs:1.0.1
```

`docker logs opendbs` shows the first-start output. Back up `/data/opendbs.key`, or pass your own key with `-e DB_ENCRYPTION_KEY=…`. A compose file is in [docker/docker-compose.yml](docker/docker-compose.yml), and the [Admin Guide](docs/ADMIN_GUIDE.md#2-installation-and-first-start) covers the details.

### Production

For a server reachable from a network, follow the production checklist in the [Admin Guide](docs/ADMIN_GUIDE.md#production-checklist). At minimum set `NODE_ENV=production`, a strong `JWT_SECRET` and `ADMIN_PASSWORD`, and put HTTPS in front.

---

## Concepts

| OpenDBS | Relational | MongoDB |
|---|---|---|
| database | database / schema | database |
| **rack** (`nosql`) | — | collection |
| **rack** (`sql`) = table | table (typed columns) | collection with a validator |
| document / row | row | document |
| `id` | primary key | `_id` |

- **NoSQL racks** store any JSON object. **SQL racks** have declared columns (`string`, `integer`, `number`, `boolean`, `date`, `array`, `object`, with `required`, `unique` and `defaultValue`), and rows are validated strictly.
- Every document has a numeric `id` assigned by the server (returned as a string in JSON).
- SQL works on both kinds of rack: on a NoSQL rack the columns are the document's fields.

---

## Using the API

Authenticate with a **JWT** (`POST /api/auth/login`) or an **API key** (`X-Api-Key` header). API keys are created in the admin panel (**API keys**). They can be limited to certain databases and permissions (read / write / delete), to IP ranges, and given an expiry date.

```bash
# log in
TOKEN=$(curl -s localhost:4402/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"…"}' | jq -r .token)
H="authorization: Bearer $TOKEN"

curl -X POST localhost:4402/api/databases -H "$H" -H 'content-type: application/json' -d '{"name":"shop"}'
curl -X POST localhost:4402/api/databases/shop/racks -H "$H" -H 'content-type: application/json' -d '{"name":"orders"}'

# insert (send an array to bulk insert, all-or-nothing)
curl -X POST localhost:4402/api/databases/shop/racks/orders/documents -H "$H" -H 'content-type: application/json' \
  -d '{"customer":"c-17","total":49.9,"status":"paid","items":[{"sku":"A1","qty":2}]}'

# query (MongoDB-style operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or $not $elemMatch $all $size …)
curl -X POST localhost:4402/api/databases/shop/racks/orders/search -H "$H" -H 'content-type: application/json' \
  -d '{"query":{"status":"paid","total":{"$gte":20}},"sort":{"field":"total","order":"desc"},"limit":10}'

# index a field
curl -X POST localhost:4402/api/databases/shop/racks/orders/indexes -H "$H" -H 'content-type: application/json' -d '{"field":"status"}'
```

Other endpoints:

- **Documents:** `GET/PUT/PATCH/DELETE …/documents/:id`, plus `GET …/documents?status=paid&_sort=total&_order=desc&_limit=10`.
- **Aggregation:** `POST …/aggregate`, with stages `$match`, `$group`, `$sort`, `$project`, `$unwind`, `$lookup`, `$limit`, `$skip` and `$count`.
- **Transactions:** `POST /api/transactions` runs several operations across racks; they all commit or none do.
- **Search:** `POST …/search/fuzzy` and `POST …/search/vector` (with text and vector indexes).
- **Backups:** `/api/backup/*`.

The admin panel's **API docs** page lists every endpoint, and its **Playground** page sends requests from the browser.

---

## SQL

`POST /api/sql/query` takes `{ "database": "shop", "query": "…", "params": [ … ] }`; `POST /api/sql/:database/execute` takes `{ "query", "params" }`.

```sql
CREATE TABLE customers (id_ext VARCHAR(20) UNIQUE, name VARCHAR(80) NOT NULL, tier VARCHAR(10) DEFAULT 'std');

INSERT INTO customers (id_ext, name) VALUES (?, ?) ON CONFLICT (id_ext) DO UPDATE SET name = excluded.name;

SELECT c.tier, COUNT(*) AS orders, ROUND(SUM(o.total), 2) AS revenue,
       RANK() OVER (ORDER BY SUM(o.total) DESC) AS rnk
FROM orders o JOIN customers c ON c.id_ext = o.customer
WHERE o.status = 'paid' AND o.created >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
GROUP BY c.tier HAVING COUNT(*) > 10
ORDER BY revenue DESC;

BEGIN;
UPDATE stock SET qty = qty - 2 WHERE sku = 'A1' AND qty >= 2;
INSERT INTO orders (customer, total, status) VALUES ('c-17', 49.9, 'paid') RETURNING id;
COMMIT;
```

Supported:

- **Queries:** SELECT with every join type (`INNER`, `LEFT`, `RIGHT`, `FULL`, `CROSS`, `USING`), subqueries (scalar, `IN`, `EXISTS`, `ANY`/`ALL`), `WITH` and `WITH RECURSIVE`, `UNION` / `INTERSECT` / `EXCEPT`, window functions, `CASE`, `CAST` / `::`, and about 150 functions (string, math, date, JSON).
- **Changes:** INSERT (also `… SELECT`, `ON CONFLICT`, `ON DUPLICATE KEY UPDATE`, `IGNORE`, `REPLACE`), UPDATE and DELETE, all with `RETURNING`.
- **Schema:** `CREATE TABLE` (also `… AS SELECT`), `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, `CREATE INDEX` / `DROP INDEX`.
- **Inspection:** `SHOW TABLES`, `SHOW INDEXES`, `DESCRIBE`, `EXPLAIN`.
- **Transactions:** `BEGIN` / `COMMIT` / `ROLLBACK`.

Each statement is checked against your permissions: SELECT needs read, INSERT / UPDATE / CREATE need write, DELETE / DROP need delete. A single INSERT, UPDATE or DELETE is atomic on its own. **Always pass user input as `?` / `$1` parameters**, never by building the SQL string.

---

## Client libraries

The drivers live in `drivers/` (no third-party dependencies). They are also published as packages: npm `opendbs`, PyPI `opendbs`, Packagist `opendbs/client` and pub.dev `opendbs` (Dart / Flutter). Each one:

- accepts **several server URLs** and moves to another member when one fails (cluster failover);
- sends an **`Idempotency-Key`** with every write, so a retry after a network error never applies the write twice.

```js
// Node.js — npm install opendbs (or drivers/nodejs)
const { OpenDBS } = require('opendbs');
const db = new OpenDBS({ url: 'http://10.0.0.5:4402,http://10.0.0.6:4402,http://10.0.0.7:4402', apiKey: process.env.OPENDBS_KEY });
const orders = db.database('shop').rack('orders');
const id = await orders.insert({ customer: 'c-17', total: 49.9 });
const { results } = await orders.find({ total: { $gte: 20 } }, { sort: { field: 'total', order: 'desc' }, limit: 10 });
const rows = await db.database('shop').sql('SELECT status, COUNT(*) AS n FROM orders WHERE total > ? GROUP BY status', [20]);
```

```python
# Python — pip install opendbs (standard library only)
from opendbs import OpenDBS
db = OpenDBS(["http://10.0.0.5:4402", "http://10.0.0.6:4402"], api_key="…")
orders = db.database("shop").rack("orders")
orders.insert({"customer": "c-17", "total": 49.9})
print(orders.find({"total": {"$gte": 20}}, limit=10))
```

```php
// PHP 8 — composer require opendbs/client (curl)
$db = new OpenDBS\Client('http://10.0.0.5:4402,http://10.0.0.6:4402', ['apiKey' => getenv('OPENDBS_KEY')]);
$db->database('shop')->rack('orders')->insert(['customer' => 'c-17', 'total' => 49.9]);
```

```dart
// Dart / Flutter — pub.dev: opendbs (drivers/flutter)
final db = OpenDBS.cluster(['http://10.0.0.5:4402', 'http://10.0.0.6:4402'], apiKey: '…');
await db.database('shop').rack('orders').insert({'customer': 'c-17', 'total': 49.9});
```

---

## Scaling: workers, replication, sharding

| | What it does | How to turn it on |
|---|---|---|
| **Query workers** | Large scans, sorted top-K and GROUP BY use several CPU cores | On by default (`QUERY_WORKERS`, default min(8, cores/2)) |
| **Replication & failover** | 3+ servers hold identical copies. One primary takes the writes; replicas serve reads and forward writes. If the primary fails, a new one is elected in about 3 seconds. `REPLICATION_SYNC=majority` means an acknowledged write survives any single failure. | `CLUSTER_*` settings on every member |
| **Sharding** | One rack is spread over several OpenDBS servers (each may itself be a cluster). Writes go to the shard that owns the document; queries run on all shards in parallel and are merged; GROUP BY is computed on each shard and combined. Shards can be added or removed with a rebalance while reads continue. | Admin panel → **Sharding** |

Step-by-step setup, day-to-day operation and troubleshooting for both are in the **[Admin Guide](docs/ADMIN_GUIDE.md)** ([cluster](docs/ADMIN_GUIDE.md#replication-and-failover-cluster), [sharding](docs/ADMIN_GUIDE.md#sharding)).

---

## Security

- **Encryption at rest:** data files, write logs and backups are encrypted (AES-256-XTS for the disk engine, AES-256-GCM for the memory engine and backups).
- **Durability:** a write is acknowledged only after it is fsynced (group commit).
- **Passwords and keys:** passwords are hashed with bcrypt. API keys are stored only as SHA-256 hashes. Sessions are HS256 JWTs that can be revoked.
- **Two-factor sign-in:** TOTP is supported; `ADMIN_REQUIRE_2FA` makes it mandatory for admins.
- **Access control:** permissions are per database (read / write / delete), and so is each SQL statement. Access keys can be limited by IP / CIDR and given an expiry date. The admin API can have its own IP allow-list.
- **Request protection:** rate limits (stricter for login), size limits, validation of identifiers and query operators, protection against prototype pollution, ReDoS-safe regex and LIKE, caps on result sizes, and an audit log.
- **Cluster and shard traffic:** messages between cluster members are encrypted and authenticated with a key derived from `CLUSTER_SECRET`. API keys for shards are stored encrypted.

Read [SECURITY.md](SECURITY.md) for the security model, the hardening applied in 1.0.1, and how to report a vulnerability.

---

## Configuration

All settings are environment variables (`.env`). Most can also be changed in the admin panel under **Settings**; a restart applies them. The most important ones:

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` enforces a strong JWT secret, hides error details and closes CORS |
| `PORT` / `HOST` | `4402` / `0.0.0.0` | Listen address |
| `DB_PATH` | `./data` | Data directory |
| `STORAGE_ENGINE` | `disk` | `disk` (encrypted B-tree, larger than RAM) or `memory` |
| `CACHE_SIZE_MB` | `512` | RAM cache for the disk engine |
| `JWT_SECRET` | — | Required in production (32+ random characters) |
| `ADMIN_PASSWORD` | — | Password of the first `admin` user |
| `DB_ENCRYPTION_KEY` / `DB_ENCRYPTION_KEY_FILE` | `./opendbs.key` | Data-encryption key source |
| `WAL_FSYNC` | `true` | Acknowledge writes only once on disk |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy |
| `CORS_ORIGINS` | — | Allowed browser origins |
| `RATE_LIMIT_MAX` | `300` | Requests per minute per IP |
| `QUERY_WORKERS` | auto | Parallel query threads (`0` = off) |
| `ADMIN_PANEL_ENABLED` / `ADMIN_PANEL_PATH` / `ADMIN_ALLOWED_IPS` | `true` / `/admin` / — | Admin panel |
| `ADMIN_REQUIRE_2FA` | `false` | Require 2FA for admin sessions |
| `CLUSTER_*`, `REPLICATION_SYNC` | off | Replication (see the Admin Guide) |
| `BACKUP_*` | daily, 7 days, local | Automatic backups (also editable on the Backups page) |

`.env.example` documents every variable.

---

## Performance

These figures were measured on a development laptop (hybrid 8+ core CPU, NVMe SSD, Windows 11) with the test suites in this project. They are not a formal benchmark; treat them as orders of magnitude.

| Workload | Result |
|---|---|
| Bulk insert, disk engine | 20,000 documents in ~0.24 s |
| Loading 1,000,000 documents with 2 indexes | ~14,000 documents/s; ~320 MB RSS with a 128 MB cache; reopening takes < 0.1 s |
| Range + equality query on 20,000 documents | full scan ~350 ms → indexed ~23 ms → cached ~8 ms |
| SQL GROUP BY over a large rack | 1 thread ~3.0 s → parallel workers ~0.3–0.45 s (6–9×) |
| Cluster failover (primary killed) | new primary in ~2.5–3.5 s; with `majority`, no acknowledged write lost |

---

## Documentation

| Document | For |
|---|---|
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Running OpenDBS: installation, admin panel, users and keys, backups, cluster, sharding, hardening, troubleshooting |
| [QUICKSTART.md](QUICKSTART.md) | API walkthrough with curl examples |
| [SECURITY.md](SECURITY.md) | Security model, 1.0.1 fixes, reporting vulnerabilities |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
| Admin panel → **API docs** | Every endpoint, with examples and a playground |

---

## Other platforms (building the engine)

This repository contains the ready-to-run server (`dist/`, `public/`, `drivers/`) and the source of the Rust storage engine (`rust-engine/`). The prebuilt engine, `opendbs-engine.win32-x64-msvc.node`, is for Windows x64. For Linux or macOS, build the engine once with a Rust toolchain (1.70+):

```bash
npx @napi-rs/cli@2 build --platform --release --cargo-cwd rust-engine
# → opendbs-engine.<platform>.node next to package.json (e.g. linux-x64-gnu, darwin-arm64)
```

Supported names: `win32-x64-msvc`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `darwin-x64` and `darwin-arm64`. The server picks the right file automatically.

---

## License

**Creative Commons Attribution-NonCommercial 4.0** — see [LICENSE.md](LICENSE.md). Non-commercial use is free with attribution. Commercial use requires a separate licence from the maintainers.
