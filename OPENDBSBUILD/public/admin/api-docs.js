'use strict';

/*
 * OpenDBS REST API reference, rendered by the admin panel's "API docs" page
 * and used to prefill the Playground. Path parameters are written :name.
 *
 * auth: 'none' | 'user' (JWT or X-Api-Key) | 'admin'
 * perm: database permission the caller needs (read / write / delete)
 */
window.OPENDBS_API_DOCS = {
    intro: [
        ['Base URL', 'Same origin as this panel, e.g. http://localhost:4402'],
        ['Auth: JWT', 'POST /api/auth/login, then send  Authorization: Bearer <token>'],
        ['Auth: API key', 'Send  X-Api-Key: <key>. Personal keys belong to a user; access keys (API Keys page) carry their own database permissions and IP allow-list.'],
        ['Errors', 'JSON { "error": "message" } with a 4xx/5xx status. 401 = not authenticated, 403 = not allowed (permission or IP), 429 = rate limited.'],
        ['Racks', 'NoSQL racks store free-form JSON documents. SQL racks are tables: every row is validated against typed columns and unknown columns are rejected.'],
        ['Client libraries', 'Node.js, Python and PHP clients are in the drivers/ folder (see drivers/README.md). They wrap these endpoints with keep-alive connections.'],
        ['Durability & encryption', 'Data files and logs are AES-256-GCM encrypted at rest. With WAL_FSYNC on (default) a write is acknowledged only after it is on disk; concurrent writes share one fsync (group commit).'],
        ['Query operators', '$eq $ne $gt $gte $lt $lte $in $nin $exists $regex(+$options) $size $all $elemMatch $type $not, and top-level $and $or $nor $not. Dotted paths ("address.city") reach nested fields; array fields match if any element matches.'],
    ],
    groups: [
        {
            name: 'Authentication & users',
            endpoints: [
                { method: 'GET', path: '/api/version', auth: 'none', summary: 'OpenDBS version, build time and commit. Public when EXPOSE_VERSION=true (default outside production), otherwise login required.' },
                { method: 'POST', path: '/api/auth/login', auth: 'none', summary: 'Log in and receive a JWT.', body: { username: 'admin', password: 'your-password' } },
                { method: 'GET', path: '/api/auth/me', auth: 'user', summary: 'The current user (or access key identity).' },
                { method: 'POST', path: '/api/auth/login/2fa', auth: 'none', summary: 'Second login step when 2FA is on: the challenge from /login plus a 6-digit code or a recovery code.', body: { challenge: '<challenge from /login>', code: '123456' } },
                { method: 'PUT', path: '/api/auth/me/password', auth: 'user', summary: 'Change your password (needs the current one). Signs out other sessions; returns a fresh token.', body: { currentPassword: 'OldPassw0rd', password: 'NewPassw0rd' } },
                { method: 'GET', path: '/api/auth/2fa', auth: 'user', summary: 'Two-factor status and recovery codes left.' },
                { method: 'POST', path: '/api/auth/2fa/setup', auth: 'user', summary: 'Start 2FA setup: returns the secret, otpauth:// URL and a QR code.' },
                { method: 'POST', path: '/api/auth/2fa/enable', auth: 'user', summary: 'Confirm setup with a code from the app. Returns 10 one-time recovery codes.', body: { code: '123456' } },
                { method: 'POST', path: '/api/auth/2fa/recovery-codes', auth: 'user', summary: 'Replace recovery codes (needs a current app code).', body: { code: '123456' } },
                { method: 'POST', path: '/api/auth/2fa/disable', auth: 'user', summary: 'Turn 2FA off (password + code).', body: { password: 'Passw0rd', code: '123456' } },
                { method: 'POST', path: '/api/auth/regenerate-api-key', auth: 'user', summary: 'Issue a new personal API key (the old one stops working).' },
                { method: 'GET', path: '/api/auth/users', auth: 'admin', summary: 'List users.' },
                { method: 'POST', path: '/api/auth/register', auth: 'admin', summary: 'Create a user. "*" grants a permission on every database.', body: { username: 'alice', password: 'Passw0rd123', role: 'user', permissions: { shop: ['read', 'write'] } } },
                { method: 'PATCH', path: '/api/auth/users/:userId', auth: 'admin', summary: 'Change role, permissions or password. { "resetTwoFactor": true } turns off 2FA for a user who lost their phone.', body: { role: 'user', permissions: { '*': ['read'] } } },
                { method: 'DELETE', path: '/api/auth/users/:userId', auth: 'admin', summary: 'Delete a user.' },
            ],
        },
        {
            name: 'Databases',
            endpoints: [
                { method: 'GET', path: '/api/databases?include_racks=true', auth: 'user', summary: 'Databases you can access (with their racks).' },
                { method: 'POST', path: '/api/databases', auth: 'user', summary: 'Create a database.', body: { name: 'shop' } },
                { method: 'GET', path: '/api/databases/:database/stats', auth: 'user', perm: 'read', summary: 'Rack and document counts.' },
                { method: 'DELETE', path: '/api/databases/:database', auth: 'user', perm: 'delete', summary: 'Delete a database and all its racks.' },
            ],
        },
        {
            name: 'Racks & SQL columns',
            endpoints: [
                { method: 'GET', path: '/api/databases/:database/racks', auth: 'user', perm: 'read', summary: 'List racks with type, count and schema.' },
                { method: 'POST', path: '/api/databases/:database/racks', auth: 'user', perm: 'write', summary: 'Create a NoSQL rack (free-form JSON).', body: { name: 'events', type: 'nosql' } },
                {
                    method: 'POST', path: '/api/databases/:database/racks', auth: 'user', perm: 'write', summary: 'Create a SQL rack (table). Column types: string, integer, number, boolean, date, array, object.',
                    body: { name: 'customers', type: 'sql', schema: { name: { type: 'string', required: true }, email: { type: 'string', required: true, unique: true }, age: { type: 'integer' }, active: { type: 'boolean', defaultValue: true }, joined: { type: 'date' } } },
                },
                { method: 'GET', path: '/api/databases/:database/racks/:rack/schema', auth: 'user', perm: 'read', summary: 'Rack type and column definitions.' },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/columns', auth: 'user', perm: 'write', summary: 'ALTER TABLE ADD COLUMN (SQL racks). Existing rows get the default.', body: { name: 'country', type: 'string', defaultValue: 'IN' } },
                { method: 'PATCH', path: '/api/databases/:database/racks/:rack/columns/:field', auth: 'user', perm: 'write', summary: 'Rename a column or change its type/constraints. Existing values are converted; nothing changes if any row can\'t be.', body: { name: 'full_name', type: 'string', required: true } },
                { method: 'DELETE', path: '/api/databases/:database/racks/:rack/columns/:field', auth: 'user', perm: 'delete', summary: 'ALTER TABLE DROP COLUMN (removes the data too).' },
                { method: 'GET', path: '/api/databases/:database/racks/:rack/count', auth: 'user', perm: 'read', summary: 'Number of documents.' },
                { method: 'DELETE', path: '/api/databases/:database/racks/:rack/clear', auth: 'user', perm: 'delete', summary: 'Delete every document, keep the rack.' },
                { method: 'DELETE', path: '/api/databases/:database/racks/:rack', auth: 'user', perm: 'delete', summary: 'Delete the rack.' },
            ],
        },
        {
            name: 'Documents / rows',
            endpoints: [
                { method: 'POST', path: '/api/databases/:database/racks/:rack/documents', auth: 'user', perm: 'write', summary: 'Insert one document. Send an array to bulk insert (all-or-nothing).', body: { name: 'Pat', email: 'pat@example.com', age: 31 } },
                { method: 'GET', path: '/api/databases/:database/racks/:rack/documents?_limit=20&_skip=0&_sort=age&_order=desc', auth: 'user', perm: 'read', summary: 'List with paging and sorting. Add field=value filters, or _q={JSON query}. Returns results, count and total.' },
                { method: 'GET', path: '/api/databases/:database/racks/:rack/documents/:id', auth: 'user', perm: 'read', summary: 'Get one by id (?populate=true resolves "rack:id" references).' },
                { method: 'PUT', path: '/api/databases/:database/racks/:rack/documents/:id', auth: 'user', perm: 'write', summary: 'Replace a document (creates one if the id does not exist).', body: { name: 'Pat', email: 'pat@example.com', age: 32 } },
                { method: 'PATCH', path: '/api/databases/:database/racks/:rack/documents/:id', auth: 'user', perm: 'write', summary: 'Merge fields into a document.', body: { age: 33 } },
                { method: 'DELETE', path: '/api/databases/:database/racks/:rack/documents/:id', auth: 'user', perm: 'delete', summary: 'Delete a document.' },
            ],
        },
        {
            name: 'Aggregation & transactions',
            endpoints: [
                {
                    method: 'POST', path: '/api/databases/:database/racks/:rack/aggregate', auth: 'user', perm: 'read',
                    summary: 'Aggregation pipeline: $match $group $lookup (join) $unwind $project $addFields $sort $skip $limit $count $sortByCount $replaceRoot. A leading $match uses indexes.',
                    body: { pipeline: [{ $match: { status: 'paid' } }, { $lookup: { from: 'customers', localField: 'customer_id', foreignField: 'id', as: 'customer' } }, { $unwind: '$customer' }, { $group: { _id: '$customer.city', revenue: { $sum: '$total' }, orders: { $count: {} } } }, { $sort: { revenue: -1 } }, { $limit: 10 }] },
                },
                {
                    method: 'POST', path: '/api/transactions', auth: 'user', perm: 'write / delete (per operation)',
                    summary: 'All-or-nothing across racks (and databases). "$N.id" refers to the id created by operation N. Conflicting concurrent writes → 409, retry.',
                    body: { database: 'shop', operations: [{ op: 'insert', rack: 'orders', data: { customer_id: '1', total: 40 } }, { op: 'insert', rack: 'order_items', data: { order_id: '$0.id', sku: 'LAMP-1', qty: 1 } }, { op: 'patch', rack: 'stock', id: '7', data: { qty: 11 } }] },
                },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'read', summary: 'SQL JOIN + GROUP BY + HAVING.', body: { query: 'SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spent FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name HAVING COUNT(*) > 1 ORDER BY spent DESC' } },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'write', summary: 'SQL transaction: BEGIN … COMMIT (or ROLLBACK). Any error rolls everything back.', body: { query: "BEGIN; INSERT INTO orders (customer_id, total) VALUES ('1', 40); UPDATE stock SET qty = 11 WHERE id = 7; COMMIT;" } },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/indexes', auth: 'user', perm: 'write', summary: 'Compound index over several fields (optionally a unique combination).', body: { fields: ['room', 'day'], unique: true } },
            ],
        },
        {
            name: 'Search',
            endpoints: [
                { method: 'POST', path: '/api/databases/:database/racks/:rack/search', auth: 'user', perm: 'read', summary: 'Query with operators, paging and sorting.', body: { query: { age: { $gte: 18 }, $or: [{ city: 'Pune' }, { city: 'Delhi' }] }, sort: { field: 'age', order: 'desc' }, skip: 0, limit: 20 } },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/search/fuzzy', auth: 'user', perm: 'read', summary: 'Typo-tolerant text search (fast with a text index).', body: { field: 'name', query: 'jhon', threshold: 0.6 } },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/search/range', auth: 'user', perm: 'read', summary: 'Numeric range shortcut.', body: { field: 'price', min: 10, max: 100 } },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/search/pattern', auth: 'user', perm: 'read', summary: 'Regex match.', body: { field: 'email', pattern: '@example\\.com$', options: 'i' } },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/search/vector', auth: 'user', perm: 'read', summary: 'Nearest-neighbour search over an embedding field.', body: { field: 'embedding', vector: [0.1, 0.2, 0.3], k: 5 } },
            ],
        },
        {
            name: 'Indexes',
            endpoints: [
                { method: 'POST', path: '/api/databases/:database/racks/:rack/indexes', auth: 'user', perm: 'write', summary: 'Hash/range index. unique:true also rejects duplicates.', body: { field: 'email', unique: true } },
                { method: 'GET', path: '/api/databases/:database/racks/:rack/indexes', auth: 'user', perm: 'read', summary: 'List indexes (with details).' },
                { method: 'DELETE', path: '/api/databases/:database/racks/:rack/indexes/:field', auth: 'user', perm: 'delete', summary: 'Drop an index.' },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/text-indexes', auth: 'user', perm: 'write', summary: 'Full-text (trigram) index for fuzzy search.', body: { field: 'name' } },
                { method: 'POST', path: '/api/databases/:database/racks/:rack/vector-indexes', auth: 'user', perm: 'write', summary: 'Vector (HNSW) index.', body: { field: 'embedding' } },
            ],
        },
        {
            name: 'SQL',
            endpoints: [
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'read / write / delete (by statement)', summary: 'Run SQL. SELECT needs read; INSERT/UPDATE/CREATE need write; DELETE/DROP need delete.', body: { query: "SELECT * FROM customers WHERE age >= 18 ORDER BY age DESC LIMIT 10" } },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'write', summary: 'CREATE TABLE with types and constraints.', body: { query: 'CREATE TABLE products (title VARCHAR(200) NOT NULL, price DECIMAL(10,2), stock INT DEFAULT 0, sku VARCHAR(40) UNIQUE)' } },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'write', summary: 'INSERT one or many rows (all-or-nothing).', body: { query: "INSERT INTO products (title, price, sku) VALUES ('Desk lamp', 24.5, 'LMP-1'), ('Chair', 80, 'CHR-1')" } },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'write', summary: 'UPDATE by any condition (WHERE is required).', body: { query: "UPDATE products SET stock = 0 WHERE price > 50 AND sku LIKE 'CHR%'" } },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'write', summary: 'ALTER TABLE: ADD / DROP / MODIFY / RENAME COLUMN.', body: { query: "ALTER TABLE products ADD COLUMN color VARCHAR(20) DEFAULT 'black'" } },
                { method: 'POST', path: '/api/sql/:database/execute', auth: 'user', perm: 'read', summary: 'Several statements at once; every result is returned in "results".', body: { query: 'SHOW TABLES; DESCRIBE products; SELECT COUNT(*) FROM products;' } },
            ],
        },
        {
            name: 'Backups',
            endpoints: [
                { method: 'POST', path: '/api/backup/create', auth: 'user', summary: 'Create a backup (admins: everything; others: their databases).' },
                { method: 'GET', path: '/api/backup/list', auth: 'user', summary: 'List backups you can see.' },
                { method: 'GET', path: '/api/backup/quick?database=:database&rack=:rack', auth: 'user', perm: 'read', summary: 'Export a rack as JSON (omit rack for a zip of the database).' },
                { method: 'GET', path: '/api/backup/:backupName/contents', auth: 'user', summary: 'What is inside a backup: date, OpenDBS version, databases and racks with sizes.' },
                { method: 'POST', path: '/api/backup/restore', auth: 'admin', summary: 'Restore a backup. Optional: only some databases; replace=false to merge; a safety copy of current data is taken first unless safetyBackup=false.', body: { backupName: 'backup_full_2026-01-01T00-00-00-000Z.tar.gz', databases: ['shop'], replace: true, safetyBackup: true } },
                { method: 'POST', path: '/api/backup/upload', auth: 'admin', summary: 'Upload a backup file (raw body, Content-Type: application/gzip, up to 1 GB). It is validated, then appears in the list.' },
                { method: 'DELETE', path: '/api/backup/:backupName', auth: 'admin', summary: 'Delete a backup file from this server.' },
                { method: 'GET', path: '/api/admin/backup/remote', auth: 'admin', summary: 'List backups stored on the S3/FTP destination.' },
                { method: 'POST', path: '/api/admin/backup/remote/fetch', auth: 'admin', summary: 'Copy a remote backup to this server so it can be restored.', body: { backupName: 'backup_full_2026-01-01T00-00-00-000Z.tar.gz' } },
            ],
        },
        {
            name: 'Admin',
            endpoints: [
                { method: 'GET', path: '/api/admin/overview', auth: 'admin', summary: 'Server, engine and security status.' },
                { method: 'GET', path: '/api/admin/audit?limit=100', auth: 'admin', summary: 'Audit log.' },
                { method: 'GET', path: '/api/admin/access-keys', auth: 'admin', summary: 'List API access keys.' },
                { method: 'POST', path: '/api/admin/access-keys', auth: 'admin', summary: 'Create an access key. allowedIps: ["*"] = anywhere, or IPs/CIDRs. The key is returned once.', body: { name: 'mobile-app', permissions: { shop: ['read', 'write'] }, allowedIps: ['203.0.113.10', '10.0.0.0/8'], expiresAt: '2027-01-01' } },
                { method: 'PATCH', path: '/api/admin/access-keys/:id', auth: 'admin', summary: 'Change permissions, IPs, expiry or enable/disable.', body: { enabled: false } },
                { method: 'POST', path: '/api/admin/access-keys/:id/rotate', auth: 'admin', summary: 'Replace the secret (the old key stops working).' },
                { method: 'DELETE', path: '/api/admin/access-keys/:id', auth: 'admin', summary: 'Delete an access key.' },
                { method: 'POST', path: '/api/admin/flush', auth: 'admin', summary: 'Write all pending changes to snapshots now.' },
                { method: 'GET', path: '/api/admin/backup-config', auth: 'admin', summary: 'Automatic-backup settings (secrets masked) and next/last run.' },
                { method: 'PUT', path: '/api/admin/backup-config', auth: 'admin', summary: 'Change schedule, retention and destination. Applied immediately.', body: { enabled: true, schedule: '30 2 * * *', retentionDays: 14, type: 's3', s3: { bucket: 'my-backups', region: 'ap-south-1', accessKey: 'AKIA…', secretKey: '…', prefix: 'opendbs' } } },
                { method: 'POST', path: '/api/admin/backup-config/test', auth: 'admin', summary: 'Upload and delete a test file at the destination (same body as PUT).' },
                { method: 'POST', path: '/api/admin/backup/run', auth: 'admin', summary: 'Run a backup now with the current settings.' },
                { method: 'GET', path: '/api/admin/env-settings', auth: 'admin', summary: 'Editable server settings with their current values.' },
                { method: 'PUT', path: '/api/admin/env-settings', auth: 'admin', summary: 'Change server settings (.env). Restart to apply.', body: { WAL_FSYNC: 'true', RATE_LIMIT_MAX: '600' } },
                { method: 'POST', path: '/api/admin/benchmark', auth: 'admin', summary: 'Write/read speed test on a temporary database (size: 1000, 10000, 50000 or 100000).', body: { size: 10000 } },
            ],
        },
        {
            name: 'Cluster & sharding',
            endpoints: [
                { method: 'GET', path: '/api/cluster/status', auth: 'none', summary: 'Public health check: { role, primary, leaderId } (details: GET /api/admin/cluster).' },
                { method: 'GET', path: '/api/admin/cluster', auth: 'admin', summary: 'This node, the primary and every member with its replication lag.' },
                { method: 'POST', path: '/api/admin/cluster/step-down', auth: 'admin', summary: 'The primary hands over to another member.' },
                { method: 'POST', path: '/api/admin/cluster/elect', auth: 'admin', summary: 'Ask the members to elect this node (needs a majority and an up-to-date copy).' },
                { method: 'POST', path: '/api/admin/cluster/force-primary', auth: 'admin', summary: 'Become primary without a majority (last resort).', body: { confirm: 'FORCE' } },
                { method: 'GET', path: '/api/admin/sharding', auth: 'admin', summary: 'Shards, sharded racks (bucket counts per shard) and routing statistics.' },
                { method: 'POST', path: '/api/admin/sharding/shards', auth: 'admin', summary: 'Register another OpenDBS server (or replicated cluster: all its URLs) as a shard. apiKey is a key on that server.', body: { name: 'shard2', urls: 'http://10.0.0.12:4402,http://10.0.0.13:4402', apiKey: 'odbs_…' } },
                { method: 'POST', path: '/api/admin/sharding/shards/:name/test', auth: 'admin', summary: 'Check that a shard answers and accepts its key.' },
                { method: 'DELETE', path: '/api/admin/sharding/shards/:name', auth: 'admin', summary: 'Unregister a shard (no rack may still use it).' },
                { method: 'POST', path: '/api/admin/sharding/racks', auth: 'admin', summary: 'Create a sharded rack. key: "id" (spread evenly) or a field; queries on the key go to one shard. "local" = this server.', body: { database: 'shop', rack: 'orders', type: 'nosql', key: 'customer_id', shards: ['local', 'shard2'] } },
                { method: 'GET', path: '/api/admin/sharding/racks/:database/:rack', auth: 'admin', summary: 'Documents and buckets on each shard.' },
                { method: 'POST', path: '/api/admin/sharding/racks/:database/:rack/rebalance', auth: 'admin', summary: 'Spread the rack evenly over these shards (add or retire shards). Writes pause while documents move; reads continue.', body: { shards: ['local', 'shard2', 'shard3'] } },
            ],
        },
    ],
};
