# OpenDBS Administrator Guide

For **OpenDBS 1.0.1**. This guide is for the people who install, secure and run OpenDBS servers. It covers:

- installation and production setup;
- the admin panel, users and API keys;
- backups and encryption keys;
- replication with automatic failover (cluster);
- sharding;
- hardening, upgrades and troubleshooting.

For the application API, see the [README](../README.md) and the admin panel's **API docs** page.

---

## Contents

1. [How OpenDBS is organised](#1-how-opendbs-is-organised)
2. [Installation and first start](#2-installation-and-first-start)
3. [Production checklist](#production-checklist)
4. [Running as a service, behind HTTPS](#4-running-as-a-service-behind-https)
5. [The admin panel](#5-the-admin-panel)
6. [Users, permissions and API keys](#6-users-permissions-and-api-keys)
7. [Storage and the encryption key](#7-storage-and-the-encryption-key)
8. [Backups and restore](#8-backups-and-restore)
9. [Monitoring and the audit log](#9-monitoring-and-the-audit-log)
10. [Replication and failover (cluster)](#replication-and-failover-cluster)
11. [Sharding](#sharding)
12. [Security hardening](#12-security-hardening)
13. [Upgrading](#13-upgrading)
14. [Troubleshooting](#14-troubleshooting)
15. [Admin API reference](#15-admin-api-reference)

---

## 1. How OpenDBS is organised

```
Server (one process, port 4402)
 ├─ database  "shop"
 │   ├─ rack "orders"     (NoSQL: any JSON documents)
 │   └─ rack "customers"  (SQL table: typed columns)
 ├─ database  "_opendbs_system"   (users, API keys, sharding config, … — admins only)
 └─ files under DB_PATH
     ├─ .storage/opendbs.odb      encrypted B-tree: all data + indexes (disk engine)
     ├─ .audit/audit.log          audit trail
     ├─ .config/backup.json       backup settings saved from the panel
     ├─ .master.key               key that seals stored secrets (2FA, shard API keys, backup passwords)
     └─ .jwt_secret               generated session-signing secret (development only)
```

- Several servers can form a **cluster**: replicas hold copies of the same data.
- A server can also **shard** a rack over several servers (or clusters).
- The two features combine.

---

## 2. Installation and first start

**Requirements**

- Node.js 18 or newer (20+ recommended).
- An SSD.
- RAM for the cache (`CACHE_SIZE_MB`, default 512 MB) plus about 200 MB.
- The release build includes the Rust engine for Windows x64. For other platforms, build it from source (`npm run build:rust`).

**Install**

```bash
cd OPENDBSBUILD
npm install --omit=dev
cp .env.example .env
```

Edit `.env`; the [production checklist](#production-checklist) lists what to change. Then start the server:

```bash
npm start            # node dist/index.js
```

**First start**

- The user `admin` is created. Its password comes from `ADMIN_PASSWORD`. If that is empty, a random password is **printed once** to the console, together with an API key.
- A data-encryption key is written to `./opendbs.key`, unless you set `DB_ENCRYPTION_KEY` or `DB_ENCRYPTION_KEY_FILE`. **Copy it to a safe place now** (see [§7](#7-storage-and-the-encryption-key)).
- The admin panel is at `http://<host>:4402/admin/`, or at your `ADMIN_PANEL_PATH`.

The server refuses to start, rather than risk data, if:

- the encryption key does not match the existing data;
- `NODE_ENV=production` and `JWT_SECRET` is missing or shorter than 32 characters;
- the cluster settings are invalid (for example `CLUSTER_SECRET` is shorter than 32 characters).

---

## Production checklist

| ✔ | Setting / action | Why |
|---|---|---|
| ☐ | `NODE_ENV=production` | Requires a strong `JWT_SECRET`; hides internal error details; closes CORS unless `CORS_ORIGINS` is set; hides the version from anonymous callers |
| ☐ | `JWT_SECRET` = 64 random hex chars | Signs sessions. In a cluster use the **same** value on every member |
| ☐ | `ADMIN_PASSWORD` set; then sign in and enable **2FA** (Settings) | Protects the most powerful account |
| ☐ | `DB_ENCRYPTION_KEY` from a secrets manager (or `DB_ENCRYPTION_KEY_FILE` on another volume) | The key file next to the data protects little; without the key nothing can be read |
| ☐ | HTTPS in front (nginx / Caddy / load balancer) and `TRUST_PROXY=true` **only** then | Credentials travel in headers |
| ☐ | `CORS_ORIGINS=https://your-app.example.com` | Only your web apps may call the API from a browser |
| ☐ | `ADMIN_PANEL_PATH` changed, `ADMIN_ALLOWED_IPS` set, `ADMIN_REQUIRE_2FA=true` (after every admin has 2FA) | Keeps the admin surface small |
| ☐ | Applications use **access keys** limited to their databases, permissions and IPs | Least privilege; a leaked key can be revoked on its own |
| ☐ | `WAL_FSYNC=true` (default) | Acknowledged writes survive power loss |
| ☐ | Backups: schedule + **off-site** destination (S3 / FTP), restore tested | Disasters, mistakes, ransomware |
| ☐ | Firewall: only the proxy may reach port 4402. Cluster members and shard routers need to reach each other on it | Smaller attack surface |
| ☐ | `SHOW_ENVONWEB=false` (default), `EXPOSE_VERSION` empty | No configuration or version disclosure |
| ☐ | OS: run as an unprivileged user; data directory readable only by that user | Protects `opendbs.key`, `.master.key` and the data |

---

## 4. Running as a service, behind HTTPS

**systemd (Linux)**

```ini
# /etc/systemd/system/opendbs.service
[Unit]
Description=OpenDBS
After=network.target

[Service]
User=opendbs
WorkingDirectory=/opt/opendbs
EnvironmentFile=/opt/opendbs/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
# graceful stop: OpenDBS flushes and closes the store on SIGTERM
KillSignal=SIGTERM
TimeoutStopSec=30
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

**Windows**

Run `node dist\index.js` from the build folder as a service with a wrapper such as NSSM or WinSW. Set the working directory to the build folder.

**nginx (TLS termination)**

```nginx
server {
    listen 443 ssl http2;
    server_name db.example.com;
    ssl_certificate     /etc/letsencrypt/live/db.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/db.example.com/privkey.pem;
    client_max_body_size 50m;            # match BODY_LIMIT_MB

    location / {
        proxy_pass http://127.0.0.1:4402;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

With a proxy in front, set `TRUST_PROXY=true` so rate limits and IP allow-lists see the real client address. **Never** set it when clients can reach OpenDBS directly: they could then fake their IP with a header.

**Health checks**

- `GET /health` returns `{"status":"ok"}`.
- In a cluster, `GET /api/cluster/status` returns `{"role":"leader"|"follower", "primary":true|false, "leaderId":…}`. A load balancer that should send writes only to the primary can check `primary`. The drivers don't need this; they follow the primary themselves.

---

## 5. The admin panel

Only users with the **admin** role can sign in. The panel signs out after `ADMIN_SESSION_TIMEOUT_MINUTES` without activity.

| Page | What you do there |
|---|---|
| **Overview** | Server health, storage engine, cache and disk usage, encryption and fsync status, query planner statistics, a security checklist |
| **Databases** | Create and delete databases and racks; browse, search, add, edit and delete documents; export a database or rack; SQL table columns; indexes (exact / unique / compound, full-text, vector) |
| **SQL console** | Run SQL against a database; `EXPLAIN` shows how a query will run |
| **Backups** | Run a backup now; schedule, retention and destination (local / S3 / FTP); upload, download, inspect, restore and delete backups |
| **Cluster** | Replication role of this node, the primary, every member's lag; step down, elect, force primary |
| **Sharding** | Register shards; create sharded racks; documents per shard; rebalance |
| **Users** | Create users, set roles and per-database permissions, reset passwords and 2FA |
| **API keys** | Access keys for applications: permissions, IP allow-list, expiry, enable / disable, rotate |
| **Audit log** | Sign-ins, failed sign-ins, permission changes, deletions, restores, cluster and sharding actions |
| **API docs / Playground** | Every endpoint with examples; send requests from the browser |
| **Speed test** | Write/read benchmark on a temporary database (does not touch your data) |
| **Settings** | Your 2FA; server settings (`.env`) grouped as Server, Security, Performance and Cluster. Saving writes `.env`; restart to apply |

---

## 6. Users, permissions and API keys

**Roles**

- `admin`: everything, including the system database and the admin API.
- `user`: only what their permissions allow.

**Permissions** are set per database, as any of `read`, `write` and `delete`. The database `*` covers every database, including ones created later.

- REST operations are checked against these permissions.
- So is every SQL statement: SELECT needs read; INSERT / UPDATE / CREATE / ALTER need write; DELETE / DROP / TRUNCATE need delete.
- A script that mixes statements needs the highest permission any of them requires.

**Two kinds of API key**

| | Personal API key | Access key (API keys page) |
|---|---|---|
| Belongs to | a user (same rights as that user) | an application |
| Limits | the user's permissions | its own database permissions, IP / CIDR allow-list, expiry date |
| Lifecycle | regenerated by the user | created, disabled, rotated or deleted by an admin; usage is recorded |

Prefer access keys for applications. Give each application its own key, with only the databases and permissions it needs, and restrict it to the application servers' IPs. Keys are shown **once** and stored only as hashes.

**Two-factor authentication (TOTP)**

- Users enable 2FA under Settings by scanning a QR code; they receive 10 one-time recovery codes.
- An admin can reset another user's 2FA from the Users page.
- `ADMIN_REQUIRE_2FA=true` blocks admin sessions without a second factor; they can only reach the 2FA setup.

**Sessions** are JWTs valid for `JWT_EXPIRATION_DAYS`. Changing a user's password or role, or resetting their 2FA, signs them out everywhere (their existing tokens stop working).

---

## 7. Storage and the encryption key

| `STORAGE_ENGINE` | Use it for |
|---|---|
| `disk` (default) | Everything. All data and indexes live in one encrypted B-tree (`DB_PATH/.storage/opendbs.odb`, AES-256-XTS) with a RAM cache. Data can be much larger than RAM, and writes are ACID. Required for replication |
| `memory` | Small data that must be as fast as possible. Everything is held in RAM and saved as encrypted per-rack snapshots plus a write-ahead log |

Switching `STORAGE_ENGINE` converts the existing data on the next start.

**The encryption key**

- **Where it comes from**, in order: `DB_ENCRYPTION_KEY` (64 hex characters), `DB_ENCRYPTION_KEY_FILE`, or `./opendbs.key` (created on first start).
- **What it encrypts:** the data file, the write-ahead logs and every backup.
- **Without it, nothing can be recovered.** Keep at least two copies outside the server, for example in a password manager and a secrets vault.
- **Backups need the same key** as the server that made them. In a cluster, give every member the same `DB_ENCRYPTION_KEY`, so that a backup from any member can be restored on any other.
- **Changing the key in place is not supported in 1.0.1.** To move to a new key, start a fresh server with the new key and copy the data into it through the API (for example export each rack as JSON from the Databases page and insert it with a bulk insert).

**Durability.** With `WAL_FSYNC=true`, a write is acknowledged only after it is on disk. Concurrent writes share one fsync (group commit).

---

## 8. Backups and restore

**Automatic backups** are configured on the Backups page, or with the `BACKUP_*` settings:

- **Schedule:** daily or weekly, or a cron expression.
- **Retention:** how many days of backups to keep.
- **Destination:**
  - local directory (`BACKUP_PATH`);
  - S3-compatible storage (bucket, region, keys, prefix);
  - FTP.

  **Test destination** uploads and deletes a test file.

Settings saved on the page are stored in `DB_PATH/.config/backup.json` (passwords sealed with the master key) and override the `BACKUP_*` values.

**What a backup contains:** all databases, or the databases a non-admin user can read, as a compressed archive with a manifest. The rack files inside are encrypted with the server's key. Users and API keys are part of `_opendbs_system`, which is included in admin backups.

**Restore** (admins only), from the Backups page or `POST /api/backup/restore`:

- `databases`: restore only some databases (default: all in the backup).
- `replace` (default `true`): racks that exist now but are not in the backup are removed. `false` merges instead.
- `safetyBackup` (default `true`): a `prerestore` backup of the current state is taken first, so a mistaken restore can be undone.
- The backup is fully validated, including the key, before anything is changed.

**Off-site copies:**

- **Download** a backup and keep it elsewhere, or use an S3 / FTP destination.
- **Upload** (`POST /api/backup/upload`, raw `.tar.gz`) brings a backup to another server, which must use the same encryption key.

**With a cluster:**

- Back up **one** member; all members hold the same data.
- Restore on the **primary**; the replicas pick it up.
- When a member joins with data that differs from the cluster's, its own data is first saved as a `prerestore` backup in its `BACKUP_PATH`, then replaced.

**With sharding**, see [Sharding → backups](#backups-of-a-sharded-rack).

> Test a restore regularly on a spare server. A backup you have never restored is only a hope.

---

## 9. Monitoring and the audit log

- **`GET /health`**: liveness check.
- **Overview page**, or `GET /api/admin/overview`:
  - document and rack counts, storage size and cache hit rate;
  - the encryption algorithm and fsync count;
  - query planner statistics (indexed and full-scan queries);
  - parallel query workers;
  - the security checklist.
- **Cluster page**, or `GET /api/admin/cluster`:
  - each member's role, contact time and replication lag;
  - entries applied, full syncs and the last error.

  Alert when a member's *Behind* value keeps growing, or when *Last contact* exceeds a few seconds.
- **Sharding page**, or `GET /api/admin/sharding`: rack states, bucket counts and routing statistics.
- **Audit log**, at `DB_PATH/.audit/audit.log` (JSON lines, rotated at 10 MB) and on the Audit log page. It records:
  - sign-ins, failed sign-ins and 2FA events;
  - user and permission changes;
  - API key operations;
  - rack, column and database deletions;
  - backups and restores;
  - settings changes;
  - cluster and sharding actions.

  The audit log is kept on each node; it is not replicated.

---

## Replication and failover (cluster)

### What you get

```
            writes ─▶ ┌───────────┐  log  ┌───────────┐
 clients ─┬─────────▶ │  primary  │ ─────▶│  replica  │  reads served locally,
          │  reads    └───────────┘ ────┐ └───────────┘  writes forwarded
          └─────────────────────────────┼─▶┌───────────┐
                                        └─▶│  replica  │
                                           └───────────┘
```

- **One primary** applies every write and records it in a replication log, in the same atomic commit as the data.
- **Replicas** pull the log continuously and apply it. They hold an identical copy and serve **reads** (queries, search, SQL SELECT) from it.
- A write sent to a replica is **forwarded** to the primary; the client doesn't need to know which member is the primary. The replica then waits until it has applied the write, so the client reads its own write on the next request.
- **Automatic failover:**
  - If the primary stops answering for `CLUSTER_ELECTION_TIMEOUT_MS`, the remaining members elect a new one. This takes about 3 seconds with the default timeout.
  - A primary that loses contact with the majority stops accepting writes, so two primaries can never accept writes at the same time.
- **Write concern:**
  - `REPLICATION_SYNC=async` (default): a write is acknowledged once the primary has committed it. The fastest option; a failover can lose the last few hundred milliseconds of writes.
  - `REPLICATION_SYNC=majority`: a write is acknowledged once most members have it. **No acknowledged write is ever lost** when one member fails. Writes get a little slower, and they are refused (503) when no majority is reachable.
- **Everything replicates:** all databases, users, API keys, sharding configuration and settings stored in the data. Members also share the session-signing secret and the master key, so a login on one member works on all of them.
- **Each node keeps its own:** `.env`, the backup settings, the audit log and rate-limit counters.

### Requirements

- **3 or more members** (an odd number: 3 or 5). Two members can't elect a new primary after one fails; a majority of 2 is 2.
- `STORAGE_ENGINE=disk` on every member.
- Members can reach each other over HTTP(S) on their API port.
- **Clocks within 5 minutes of each other** (use NTP). Messages older than that are rejected.
- The same `CLUSTER_SECRET` on every member: at least 32 random characters. It authenticates and encrypts all member-to-member traffic.
- Recommended: the same `JWT_SECRET` and `DB_ENCRYPTION_KEY` on every member.

### Setting up a 3-member cluster

On **every** member, set (each with its own URL and peers):

```ini
STORAGE_ENGINE=disk
CLUSTER_ENABLED=true
CLUSTER_SECRET=<same 64-hex value everywhere>     # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CLUSTER_NODE_ID=db1                               # unique: db1 / db2 / db3
CLUSTER_ADVERTISE_URL=http://10.0.0.5:4402        # how the OTHERS reach this member
CLUSTER_PEERS=http://10.0.0.6:4402,http://10.0.0.7:4402   # the OTHER members
REPLICATION_SYNC=majority                         # or async
JWT_SECRET=<same on all>
DB_ENCRYPTION_KEY=<same on all>
```

Start all three. Within a few seconds one becomes primary; its console prints `👑 Cluster: db1 is now PRIMARY`. The others copy its data (`🔄 full sync … ✅ full sync done`). Check the **Cluster** page on any member: one primary, two replicas, *Behind* = 0.

**Turning an existing server into a cluster**

- Configure the existing server as one of the members, and start it **first**.
- Then start the two new, empty servers. A member without cluster history never wins an election against one that has data, so the new servers copy the existing data instead of erasing it.
- If a new member did have data, that data is saved as a `prerestore` backup before being replaced.

**Clients**

Give the drivers all members:

```js
new OpenDBS({ url: 'http://10.0.0.5:4402,http://10.0.0.6:4402,http://10.0.0.7:4402', apiKey })
```

- If a member is down, the drivers move on to the next one and keep retrying through an election (about 20 s by default).
- Every write carries an `Idempotency-Key`, so a retried write is applied once. If a network error leaves it unclear whether the write happened, the retry returns the original response.
- Plain HTTP clients can use any member, or a load balancer in front of all of them.

### Day-to-day operations

| Task | How |
|---|---|
| **Planned maintenance on the primary** | Cluster page → **Step down** (`POST /api/admin/cluster/step-down`). Another member takes over within seconds. Then restart or patch the old primary; it rejoins as a replica |
| **Rolling restart or upgrade** | Restart the replicas one at a time, waiting until *Behind* = 0 after each. Then step down the primary and restart it |
| **Prefer a member as primary** | `CLUSTER_PRIORITY` (higher wins; `0` = never primary, for example a backup or reporting replica) |
| **Add a member** | Add its URL to `CLUSTER_PEERS` on all existing members and restart them one by one. Start the new member with the full peer list. It copies the data automatically |
| **Remove a member** | Stop it, remove its URL from `CLUSTER_PEERS` on the others, and restart them one by one. Keep an odd number of members |
| **Replace a failed member** | Start a new, empty server with the same `CLUSTER_ADVERTISE_URL` and node id. It copies the data |
| **Member was down for a long time** | It catches up from the log if the primary still has the entries (`CLUSTER_LOG_RETENTION`, default 100,000 entries); otherwise it does a full copy automatically |
| **Majority lost for good** (2 of 3 members destroyed) | On the surviving member: Cluster page → **Force primary** (type `FORCE`). It accepts writes without a majority. Rebuild the other members as new, empty servers. **Only do this if the other members will never come back**: their newer writes would be discarded when they rejoin |

### Settings reference

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_ENABLED` | `false` | Turn replication on |
| `CLUSTER_NODE_ID` | its address | Unique member name |
| `CLUSTER_ADVERTISE_URL` | — | How other members reach this one (must match their `CLUSTER_PEERS` entry) |
| `CLUSTER_PEERS` | — | The other members' URLs, comma-separated |
| `CLUSTER_SECRET` | — | Shared secret, 32+ characters |
| `REPLICATION_SYNC` | `async` | `async` or `majority` |
| `CLUSTER_ELECTION_TIMEOUT_MS` | `5000` | How long the primary may be silent before an election |
| `CLUSTER_WRITE_TIMEOUT_MS` | `10000` | `majority`: how long a write waits for acknowledgements before failing with 503 |
| `CLUSTER_LOG_RETENTION` | `100000` | Log entries kept for lagging replicas |
| `CLUSTER_PRIORITY` | `1` | Election preference; `0` = never primary |

### Cluster troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `CLUSTER_SECRET must be set to at least 32 random characters` at start | Set it, identical on every member |
| Cluster page: member *never* contacted, error `Cluster message rejected` | Different `CLUSTER_SECRET` on that member |
| Error `Cluster message expired` | Clocks differ by more than 5 minutes: enable NTP |
| A member stays "unknown" | Its `CLUSTER_ADVERTISE_URL` doesn't match the entry in the others' `CLUSTER_PEERS`, or a firewall blocks the port |
| Writes return 503 `No primary is available` | An election is in progress (a few seconds); or fewer than a majority of members are up |
| Writes return 503 with `majority` | Not enough replicas acknowledged within `CLUSTER_WRITE_TIMEOUT_MS`; check replica health and lag |
| A replica keeps doing full copies | It was offline longer than `CLUSTER_LOG_RETENTION` covers, or its data diverged; raise the retention if this is routine |
| Sessions don't work on a replica right after setup | Its first full copy hasn't finished; it adopts the cluster's secrets when it does |
| `429` on login although few attempts were made on this member | Logins sent to a replica are forwarded to the primary, where the per-IP login limit (10 per 5 minutes) is counted for the whole cluster. Applications should use API keys rather than signing in repeatedly |

> **Upgrading a cluster to 1.0.1:** 1.0.1 adds a *dataset lineage* check that closes a first-start race (see [CHANGELOG](../CHANGELOG.md)). After the upgrade, each replica makes **one** full copy from the primary. This is automatic; allow time for it on large datasets.

---

## Sharding

### What it is

Sharding spreads **one rack** over several OpenDBS servers. Use it when a rack outgrows one server's disk, cache or CPU. Replication gives you copies of all the data; sharding gives each server a part of it. The two combine: each shard can itself be a cluster.

```
                    ┌──────────────┐
 clients ──────────▶│    router    │  (an ordinary OpenDBS server: "local" can also hold a part)
 normal API / SQL   └──────┬───────┘
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌────────────┐   ┌────────────┐   ┌────────────┐
   │  shard s1  │   │  shard s2  │   │  shard s3  │   (each: a server or a cluster)
   └────────────┘   └────────────┘   └────────────┘
```

- **The router.** The server where you configure sharding. Clients keep using its normal REST API, SQL and drivers. Unsharded racks keep working on it as before.
- **The shard key.** It decides where each document lives. The key's value is hashed into one of **4096 buckets**, and each bucket belongs to one shard.
  - `id`: documents are spread evenly.
  - A field, for example `customer_id`: all documents with the same value live together, and queries on that field go to one shard only.
- **Ids.** A document's id encodes its bucket, so reading, updating or deleting by id goes straight to the right shard.
- **Queries.**
  - A query is sent to every shard that can hold matches, in parallel. That means all shards, unless the query fixes the shard key or the id.
  - The results are merged in the same order one server would return them.
  - `GROUP BY` and aggregates are computed on each shard (using all its cores) and combined on the router.

### Requirements

- Each shard is a separate OpenDBS 1.0.1 server or cluster, reachable from the router over HTTP(S).
- On each shard, create an **access key** (API keys page) for the router:
  - **read, write and delete** on the sharded databases (or `*`);
  - allowed IPs: the router's address.

  The router stores it encrypted. Requests made with it are exempt from the shard's rate limit.
- Use HTTPS, or a private network, between the router and the shards.

### Setting up

1. **Admin → Sharding → Add shard.**
   - Name: for example `s1`.
   - URL(s): for a clustered shard, list every member, comma-separated; the router fails over between them.
   - The access key.

   The router checks the shard is reachable and accepts the key before saving it.
2. **New sharded rack.** Choose:
   - the database and rack name;
   - the type (NoSQL, or SQL with columns);
   - the shard key;
   - the shards to spread over. `local` means the router itself.

   The rack is created, with its schema and indexes, on every chosen shard.
3. Use the rack as usual: insert, query, SQL, indexes, drivers.

```bash
# the same calls as for any rack — the router does the rest
curl -X POST https://db.example.com/api/databases/shop/racks/orders/documents -H "x-api-key: $KEY" \
  -H 'content-type: application/json' -d '{"customer_id": 4711, "total": 49.9}'
curl -X POST https://db.example.com/api/sql/query -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"database":"shop","query":"SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id"}'
```

**Moving an existing rack to sharding.** A rack that already has data can't be converted in place. Create a new sharded rack and copy the data with SQL:

```sql
INSERT INTO orders_sharded SELECT * FROM orders
```

Then point your application at the new rack and drop the old one.

### Choosing the shard key

| Choose | When | Effect |
|---|---|---|
| `id` | No natural grouping, or you mostly read by id | Perfectly even spread; queries on other fields go to all shards |
| A high-cardinality field you filter by (`customer_id`, `tenant_id`, `device_id`) | Most queries are "for one customer / tenant" | Those queries touch one shard; a customer's data stays together |
| **Avoid:** low-cardinality fields (`status`, `country`), or values that grow over time (`created_at`) | — | Uneven shards (hot spots) |

- The shard key **can't be changed** later, for the rack or for a document. Updating a document's shard-key field is refused; delete and re-insert it instead.
- Documents without the shard-key field are spread by id.

### What works on a sharded rack

| Feature | Works? | Notes |
|---|---|---|
| Insert, bulk insert | ✔ | A bulk insert is all-or-nothing across shards |
| Get / update / patch / delete by id | ✔ | Goes to one shard |
| Queries, sort, skip / limit, count | ✔ | `skip + limit` is limited to `MAX_QUERY_LIMIT`; page deeply by filtering on the sort field instead |
| Range / pattern / fuzzy / vector search | ✔ | Fuzzy and vector search take the best matches from each shard, merged by score |
| Aggregation pipeline | ✔ | A leading `$match` runs on the shards; later stages run on the router, so keep the matched set reasonable |
| SQL SELECT (joins, GROUP BY, windows, subqueries) | ✔ | GROUP BY with COUNT / SUM / AVG / MIN / MAX / STDDEV … is computed on the shards; joins with unsharded tables work |
| SQL INSERT / UPDATE / DELETE | ✔ | Each row is written on its shard; a multi-row UPDATE is **not atomic across shards** |
| SQL DDL (ALTER, CREATE / DROP INDEX, TRUNCATE, DROP) | ✔ | Applied on every shard |
| `BEGIN … COMMIT`, `/api/transactions` | ✘ | Refused for sharded racks: transactions are per server |
| Unique columns | ⚠ | Unique **per shard**, unless the column is the shard key |
| `populate` | ⚠ | Resolves references to racks on the same shard only |

### Adding or removing shards: rebalance

1. Register the new shard (**Add shard**).
2. On the rack, click **Rebalance** and tick the complete list of shards the rack should use. Untick shards to retire them.
3. The router moves buckets so that every chosen shard holds an equal share. It keeps buckets where they are wherever possible, so only the necessary documents move.

**While documents are copied:**

- **writes to that rack pause.** They get HTTP 503 with "being rebalanced; retry"; the drivers retry automatically.
- **Reads keep working**, and never see a document twice or miss one.

**After the copy:**

- The routing switches over, writes resume, and the copies left on the old shards are deleted. The rack shows *finishing move* until this is done.
- If the router is interrupted mid-move (crash or failover), it finishes or undoes the move automatically within a minute of coming back.
- A shard can be removed from the Sharding page only once no rack uses it.

### When a shard is down

- Requests that need it fail clearly with **503** (`Shard 's2' is unreachable`). They never return incomplete results silently.
- Requests that only need other shards keep working: by id, by shard key, or for racks not on that shard.
- Make shards highly available by running **each shard as a cluster** and listing all its members in the shard's URLs.

### High availability for the router

- The sharding configuration lives in the router's system database, so it replicates when the router is a cluster.
- Replicas of the router serve sharded reads themselves and forward writes to the router primary.
- Clients list all router members, as with any cluster.

### Backups of a sharded rack

- Each shard holds part of the data, so **back up every shard and the router**. The router holds the configuration, plus the `local` part if it is used.
- Restore each server from its own backup.
- Backups taken at different moments are not a single consistent snapshot across shards. If you need one, pause writes to the rack while all the backups run.

### Security notes

- **Shard API keys** are stored sealed with the router's master key, and are never shown again after you save them.
- **Do not write to a shard server directly.** Racks on a shard are ordinary racks, so a document written there behind the router's back may be invisible or in the wrong place. Give applications keys for the **router**, not the shards.
- **Internal endpoints.** On the router, the shard-internal endpoints (`/api/shard/...`) only accept writes from the router itself.

---

## 12. Security hardening

Start with the [production checklist](#production-checklist). In addition:

- **Network**
  - Only the reverse proxy should reach OpenDBS.
  - Cluster members and shard routers talk to each other on the API port; restrict that port to their addresses.
  - Prefer HTTPS between data centres.
- **Least privilege**
  - Use one access key per application, with only the permissions it needs, an IP allow-list and an expiry date where possible.
  - Review the API keys page and the audit log regularly.
- **Admin surface**
  - Use an unguessable `ADMIN_PANEL_PATH`, `ADMIN_ALLOWED_IPS` and required 2FA.
  - Turn the panel off where it isn't needed (`ADMIN_PANEL_ENABLED=false`); the database API keeps working.
- **Secrets**
  - Keep `DB_ENCRYPTION_KEY`, `JWT_SECRET` and `CLUSTER_SECRET` in a secrets manager, not in the repository.
  - If you suspect a leak, rotate `JWT_SECRET` (this signs everyone out) and `CLUSTER_SECRET` (restart all members together).
- **Queries**
  - Regular expressions are checked against catastrophic-backtracking patterns, and LIKE is matched without backtracking.
  - String functions and recursive queries have size caps, and results are limited by `MAX_QUERY_LIMIT`.
  - Lower `BODY_LIMIT_MB` and `MAX_QUERY_LIMIT` if your applications don't need large requests.
- **Rate limits:** `RATE_LIMIT_MAX` applies per IP per minute. Login has a stricter fixed limit (10 attempts per 5 minutes).
- **Updates:** apply OpenDBS releases promptly; [SECURITY.md](../SECURITY.md) lists fixed issues.

---

## 13. Upgrading

**Single server**

1. Take a backup (Backups → *Run backup now*), and keep a copy of `opendbs.key` and `.env`.
2. Stop the server.
3. Replace the build: `dist/`, `public/`, `drivers/`, `package.json` and the `.node` engine file. Keep `data/`, `backups/`, `.env` and `opendbs.key`. If you build from source, `node scripts/build-production.js` does exactly this.
4. Run `npm install --omit=dev`.
5. Start the server and check the Overview page and the version (login screen or `GET /api/version`).

**Cluster**

1. Upgrade the replicas one at a time.
2. Step down the primary, then upgrade it.
3. Mixed versions are fine for the short time a rolling upgrade takes. Don't run them longer than that.

**Sharding**

1. Upgrade the shards first.
2. Then upgrade the router.

**Going back:** stop the server, restore the previous build files and start it. Your data stays compatible within 1.0.x.

---

## 14. Troubleshooting

| Problem | What to check |
|---|---|
| Server exits at start: *encryption key does not match* | The wrong `DB_ENCRYPTION_KEY` or key file for this data. Find the right key; OpenDBS never discards data it can't decrypt |
| *JWT_SECRET … production* | `NODE_ENV=production` needs a 32+ character `JWT_SECRET` |
| *Admin panel NOT started* | `ADMIN_PANEL_PATH` is invalid (1–4 segments; can't start with /api, /web or /health) |
| `401 Unauthorized` | Missing or expired token (sign in again), a wrong API key, or an access key that is disabled or expired |
| `403` with an IP message | The access key's allow-list doesn't include the caller's IP. Behind a proxy, set `TRUST_PROXY=true` |
| `403 No write permission…` | The user or key lacks that permission on the database; for SQL, see which statement needs what (§6) |
| `429 Too many requests` | Rate limit reached: raise `RATE_LIMIT_MAX`, or spread the load |
| `400 Regex pattern is potentially unsafe` | The pattern repeats a group that itself repeats (`(a+)+`, `(a\|b)*`); use a character class such as `[ab]+` |
| Queries are slow | `EXPLAIN` in the SQL console shows full scans: add an index on the filtered field. Raise `CACHE_SIZE_MB` if the cache hit rate is low |
| Disk usage grows | Old backups (retention), or a large replication log (`CLUSTER_LOG_RETENTION`) |
| Cluster or sharding issues | See [cluster troubleshooting](#cluster-troubleshooting) and the shard's error on the Sharding page (*Documents* button) |

Logs go to the console (stdout/stderr). Set `LOG_LEVEL=info` (or `debug`) for more detail.

---

## 15. Admin API reference

All endpoints need an admin session or an admin API key, and honour `ADMIN_ALLOWED_IPS`.

| Method & path | Purpose |
|---|---|
| `GET /api/admin/overview` | Server, engine and security status |
| `GET /api/admin/audit?limit=100` | Audit log |
| `GET/POST/PATCH/DELETE /api/admin/access-keys[/:id]`, `POST …/:id/rotate` | Access keys |
| `GET/PUT /api/admin/backup-config`, `POST …/test`, `POST /api/admin/backup/run` | Backup settings |
| `GET/PUT /api/admin/env-settings` | Server settings (`.env`) |
| `GET /api/admin/cluster` | Cluster status of this node |
| `POST /api/admin/cluster/step-down` · `/elect` · `/force-primary` (`{"confirm":"FORCE"}`) | Cluster actions |
| `GET /api/admin/sharding` | Shards, sharded racks, statistics |
| `POST /api/admin/sharding/shards` `{name, urls, apiKey}` | Register a shard |
| `POST /api/admin/sharding/shards/:name/test` · `DELETE /api/admin/sharding/shards/:name` | Test / remove a shard |
| `POST /api/admin/sharding/racks` `{database, rack, type, schema?, key, shards}` | Create a sharded rack |
| `GET /api/admin/sharding/racks/:database/:rack` | Documents per shard |
| `POST /api/admin/sharding/racks/:database/:rack/rebalance` `{shards}` | Rebalance |
| `GET /api/cluster/status` (public) | `role` / `primary` / `leaderId` for health checks |

The admin panel's **API docs** page lists these with example bodies, together with the full data API.
