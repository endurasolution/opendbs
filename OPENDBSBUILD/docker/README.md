# OpenDBS

OpenDBS is a document **and** SQL database server: Node.js with a Rust storage engine. One server gives you:

- **Schemaless JSON racks** and **typed SQL tables** in the same database
- **SQL**: joins, subqueries, CTEs, window functions, upserts, transactions
- **Encrypted, crash-safe storage**: an on-disk B-tree (AES-256-XTS), so data can be larger than RAM
- **Replication with automatic failover** and **sharding** across servers
- **Search**: indexes, full-text / fuzzy search, vector search, aggregation pipelines
- **An admin panel** for databases, users, API keys, backups, cluster and shards

Version **1.0.1** is the first stable release.

## Tags

| Tag | Contents |
|---|---|
| `1.0.1`, `latest` | OpenDBS 1.0.1, linux/amd64 |

## Quick start

```bash
docker run -d --name opendbs \
  -p 4402:4402 \
  -v opendbs-data:/data \
  -e ADMIN_PASSWORD='choose-a-strong-password' \
  endurasolution/opendbs:1.0.1
```

- Admin panel: `http://localhost:4402/admin/` (user `admin`)
- Health check: `curl http://localhost:4402/health`
- `docker logs opendbs` shows the first-start output. If `ADMIN_PASSWORD` is not set, a random admin password is printed there **once**.

## Data and keys

The container runs as the unprivileged user `node` with `NODE_ENV=production`. Everything that must survive an upgrade is in the volume **`/data`**:

| Path | What |
|---|---|
| `/data/db` | Databases |
| `/data/backups` | Local backups |
| `/data/opendbs.key` | Data-encryption key, generated on the first start unless you pass `DB_ENCRYPTION_KEY` |
| `/data/jwt_secret` | Session-signing secret, generated on the first start unless you pass `JWT_SECRET` |

**Back up `/data/opendbs.key`.** Without it, the data and the backups can't be read. For production, pass the key from a secrets manager instead, so it isn't stored next to the data:

```bash
-e DB_ENCRYPTION_KEY="$(openssl rand -hex 32)"   # store this value safely
```

A bind mount must be writable by uid 1000: `chown -R 1000:1000 /srv/opendbs`.

## docker compose

```yaml
services:
  opendbs:
    image: endurasolution/opendbs:1.0.1
    restart: unless-stopped
    ports: ["4402:4402"]
    volumes: ["opendbs-data:/data"]
    environment:
      ADMIN_PASSWORD: "choose-a-strong-password"
volumes:
  opendbs-data:
```

## Configuration

Every setting is an environment variable. The most used ones are below; the full list is in [`.env.example`](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/.env.example).

| Variable | Default in the image | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | random, printed once | Password of the first `admin` user |
| `DB_ENCRYPTION_KEY` | `/data/opendbs.key` | Data-encryption key (64 hex characters) |
| `JWT_SECRET` | `/data/jwt_secret` | Session-signing secret (32+ characters; the same on every cluster member) |
| `STORAGE_ENGINE` | `disk` | `disk` (encrypted B-tree) or `memory` |
| `CACHE_SIZE_MB` | `512` | RAM cache for the disk engine |
| `CORS_ORIGINS` | none | Browser origins allowed to call the API |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy |
| `ADMIN_PANEL_ENABLED` / `WEB_INTERFACE_ENABLED` | `true` / `true` | Admin panel at `/admin/`, user web interface at `/web/` |
| `ADMIN_ALLOWED_IPS`, `ADMIN_REQUIRE_2FA` | — | Restrict the admin panel |
| `CLUSTER_*`, `REPLICATION_SYNC` | off | Replication and failover. Set `CLUSTER_ADVERTISE_URL` to an address the other members can reach |
| `BACKUP_*` | daily, local | Automatic backups (local, S3 or FTP) |

## Upgrading

Take a backup in the admin panel, then pull the new tag and re-create the container with the same `/data` volume and the same environment variables.

## Documentation

- [README](https://github.com/endurasolution/opendbs/tree/main/OPENDBSBUILD): API, SQL, client libraries (Node.js, Python, PHP)
- [Admin Guide](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/docs/ADMIN_GUIDE.md): production checklist, backups, cluster, sharding, security
- [Security](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/SECURITY.md) and [Changelog](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/CHANGELOG.md)

## License

[Creative Commons Attribution-NonCommercial 4.0](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/LICENSE.md). Non-commercial use is free with attribution. Commercial use requires a separate licence from the maintainers.
