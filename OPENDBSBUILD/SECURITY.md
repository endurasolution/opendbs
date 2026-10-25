# Security

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✔ security fixes |
| < 1.0 | ✘ please upgrade |

## Reporting a vulnerability

Please report vulnerabilities **privately** through the project's GitHub repository (**Security → Report a vulnerability**). Do not open a public issue.

Include:

- the version;
- your configuration (storage engine, cluster or sharding);
- steps to reproduce;
- the impact you expect.

You will get an acknowledgement, and a fix or a mitigation, before any public disclosure.

## Security model

**Authentication**

- Users sign in with username and password, plus optional TOTP 2FA. Passwords are hashed with bcrypt.
- Sessions are HS256 JWTs with a fixed issuer. They are revoked when the password, the role or the 2FA settings change.
- Applications use API keys. Keys are stored only as SHA-256 hashes; an admin-issued access key can have database permissions, an IP / CIDR allow-list and an expiry date.

**Authorization**

- Permissions (`read` / `write` / `delete`) are set per database.
- Every REST call is checked against them, and so is **every SQL statement**. A script needs the highest permission any of its statements requires.
- The system database (users, keys, configuration) and the admin API are restricted to admins. The admin API can additionally have its own IP allow-list and required 2FA.

**Data protection**

- **Encryption at rest:**
  - disk engine: AES-256-XTS on the storage file;
  - memory engine, write-ahead log and backups: AES-256-GCM.
- Stored secrets (2FA seeds, shard API keys, backup credentials) are sealed with a separate master key.
- With fsync enabled (the default), a write is acknowledged only once it is durable.

**Cluster and shards**

- Traffic between cluster members is encrypted and authenticated (AES-256-GCM, with a key derived from `CLUSTER_SECRET` by HKDF), timestamped against replay, and throttled for senders who fail authentication.
- The sharding router calls shards with per-shard access keys that it stores sealed. Internal shard endpoints accept writes only from the router process itself.

**Input handling**

- Database, rack and field names are validated.
- Query operators are allow-listed, prototype-pollution keys are stripped or refused, and request bodies and nesting depth are limited.
- Regex patterns are checked for catastrophic backtracking; LIKE uses a linear-time matcher.
- String functions, joins and recursive queries have caps; results are limited by `MAX_QUERY_LIMIT`.

**Operational defences**

- Rate limits apply per IP, with a stricter limit on login.
- Security headers are sent (CSP, nosniff, frame-ancestors 'none'; a stricter CSP for the admin panel).
- CORS is closed in production unless configured.
- Error details are hidden in production.
- An audit log records sign-ins, permission changes, deletions, restores and cluster and sharding actions.

**What OpenDBS does not do for you**

- It does not terminate TLS. Put HTTPS in front of it (see the [Admin Guide](docs/ADMIN_GUIDE.md#4-running-as-a-service-behind-https)).
- It cannot protect the encryption key if the key file sits next to the data on a compromised machine. Use `DB_ENCRYPTION_KEY` from a secrets manager.
- It does not provide transactions across shards.

## Fixed in 1.0.1

Found by a code review and by attack tests against a running server (`tests/security-test.js`, 70 checks).

- Items 1–7 were **reproduced against 0.6.0** with that test:
  - #1 froze the server: every later request timed out.
  - #3 crashed the process.
  - #6 overwrote a stored document.
  - #7 replayed another user's response to an unauthenticated caller.

  All seven are verified fixed in 1.0.1.
- Items 8–11 were found in code review and fixed.

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | High | **ReDoS:** `$regex`, SQL `REGEXP` and `REGEXP_*` accepted patterns such as `(a\|a)*b`; one request froze the whole server | Structural check: no repeated group that contains repetition or alternation, no backreferences, at most 6 unbounded repetitions; also applied to SQL |
| 2 | High | **LIKE backtracking:** `LIKE '%a%a%…b'` on long values stalled the server | Linear-time LIKE matcher, used in SQL and in pushed-down filters (`$like`) |
| 3 | High | **Memory exhaustion:** `LPAD`/`RPAD`/`REPEAT`/`SPACE`/`REPLACE` could build GB-sized strings and crash the process | Results capped at 16 million characters |
| 4 | High | **Router bypass:** the `x-opendbs-shard-request` header let any client write directly to the router's local copy of a sharded rack, breaking id allocation and routing | Only in-process router calls (secret per-process token) skip routing |
| 5 | Medium | Internal shard write endpoints were usable on the router by any user with write permission | Refused for sharded racks unless called by the router itself |
| 6 | Medium | Documents stored with explicit ids didn't advance the id counter, so a later insert could overwrite one | Id counter advanced past stored ids |
| 7 | Medium | **Idempotency:** recorded responses were replayed before authentication and to other users with the same key, and could contain new API keys (stored in the system database and in backups) | Records bound to the verified caller; admin, auth, settings, backup and read requests never recorded |
| 8 | Low | `/api/cluster/status` (public) exposed member URLs, log positions and document counts | Returns only `role`, `primary` and `leaderId` |
| 9 | Low | Cluster RPC was exempt from rate limiting and accepted 50 MB bodies from anyone | 4 MB limit; throttling of senders that fail authentication |
| 10 | Low | A captured forwarded-IP header could be replayed on a different request within 5 minutes | Header bound to the request's method and URL |
| 11 | Low | The per-session 2FA flag was written onto a user object shared by all concurrent sessions | Each request gets its own copy |

There was also an integrity fix in replication: the dataset lineage check closes a first-start race in which a replica could diverge (see [CHANGELOG.md](CHANGELOG.md)).

Verified unchanged in 1.0.1, among other things:

- **JWT:** `alg=none`, forged and tampered tokens are rejected.
- **Login:** the same answer for an unknown user and a wrong password; login is rate limited.
- **SQL permissions:** a statement hidden behind another (`SELECT …; DELETE …`, or `WITH … INSERT`) still needs its own permission.
- **Isolation:** other databases and the system database are unreachable without permission.
- **Access keys:** IP allow-lists can't be bypassed with `X-Forwarded-For` while `TRUST_PROXY` is off.
- **Input handling:** path traversal and `__proto__` / `constructor` pollution are refused, as are unknown operators (`$where`, `$function`), oversized bodies and deeply nested queries.
- **Backups:** download path traversal is refused.
- **Headers:** security headers are present.
- **Dependencies:** `npm audit` on the production dependencies reports **0 vulnerabilities** (2026-10-25).
