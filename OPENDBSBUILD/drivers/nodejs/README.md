# opendbs

The official Node.js client for [OpenDBS](https://github.com/endurasolution/opendbs/tree/main/OPENDBSBUILD), a document and SQL database server.

- No dependencies. It uses Node's built-in `fetch`, with connections kept alive.
- Works with one server or a whole cluster. Give several URLs and the client moves to another member when one fails, including during a failover election.
- Retries are safe. Every write carries an `Idempotency-Key`, so a retry after a network error is never applied twice.
- TypeScript types are included.

Requires Node.js 18 or newer and an OpenDBS 1.0 server.

```bash
npm install opendbs
```

## Connect

```js
const { OpenDBS } = require('opendbs');

// With an API key (admin panel → API keys; can be limited to databases and IPs)
const client = new OpenDBS({ url: 'http://localhost:4402', apiKey: process.env.OPENDBS_KEY });

// Or with a user. The client signs in on the first call and again when the session expires.
const client2 = new OpenDBS({ url: 'http://localhost:4402', username: 'app', password: process.env.OPENDBS_PASSWORD });

// A cluster: list the members
const client3 = new OpenDBS({ url: 'http://10.0.0.5:4402,http://10.0.0.6:4402,http://10.0.0.7:4402', apiKey: process.env.OPENDBS_KEY });
```

Options: `url` (string, comma-separated list or array), `apiKey`, `username`, `password`, `totp` (2FA code), `token`, `timeoutMs` (default 30000), `failoverMs` (how long to keep trying other members, default 20000).

## Documents

```js
const shop = client.database('shop');
await client.createDatabase('shop');
await shop.createRack('events');                       // NoSQL rack: any JSON
await shop.createTable('customers', {                  // SQL table: typed columns
  name:  { type: 'string', required: true },
  email: { type: 'string', required: true, unique: true },
  age:   { type: 'integer' },
});

const customers = shop.table('customers');
const id  = await customers.insert({ name: 'Asha', email: 'asha@example.com', age: 31 });
const ids = await customers.insertMany([{ name: 'Ravi', email: 'ravi@example.com', age: 45 }]);   // all or nothing

const { results, total } = await customers.find(
  { age: { $gte: 18 }, $or: [{ name: 'Asha' }, { name: 'Ravi' }] },
  { limit: 20, skip: 0, sort: { field: 'age', order: 'desc' } },
);
const one = await customers.get(id);                   // null when missing
await customers.patch(id, { age: 32 });                // merge fields
await customers.update(id, { name: 'Asha', email: 'asha@example.com', age: 33 });   // replace
await customers.delete(id);
await customers.createIndex(['name', 'age']);          // compound index
```

## SQL

```js
// ? (or $1) placeholders are never parsed as SQL: use them for any user input.
const { result } = await shop.sql(
  `SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spent
     FROM customers c JOIN orders o ON o.customer_id = c.id
    WHERE o.total > ?
    GROUP BY c.name HAVING COUNT(*) > 1 ORDER BY spent DESC`,
  [20],
);
```

## Aggregation, search, transactions

```js
const byCity = await shop.rack('events').aggregate([
  { $match: { type: 'purchase' } },
  { $group: { _id: '$city', revenue: { $sum: '$amount' } } },
  { $sort: { revenue: -1 } },
]);

await shop.rack('products').fuzzySearch('name', 'lapptop');
await shop.rack('products').vectorSearch('embedding', [0.12, 0.4, 0.9], 10);

// Atomic across racks. tx.insert() returns a reference to the new id.
await client.transaction((tx) => {
  const order = tx.insert('shop', 'orders', { customer_id: '1', total: 40 });
  tx.insert('shop', 'order_items', { order_id: order, sku: 'LAMP-1', qty: 1 });
  tx.patch('shop', 'stock', '7', { qty: 11 });
});
```

## Errors

Failed requests throw an `OpenDBSError` with `status` (the HTTP status) and `body` (the server's response).

```js
const { OpenDBSError } = require('opendbs');
try { await customers.insert({ name: 'Dup', email: 'asha@example.com' }); }
catch (e) { if (e instanceof OpenDBSError && e.status === 400) console.log(e.message); }
```

## Upgrading from 1.0.0

Code written for 1.0.0 keeps working. The 1.0.0 methods that take the database and rack as arguments are still there: `login(username, password)`, `insert(db, rack, doc)`, `find(db, rack, query)`, `findOne`, `update`, `delete`, `sql(db, query)`, `search`, `fuzzySearch`, `vectorSearch`, `rangeSearch`, `patternSearch`, `listRacks`, `createRack(db, { name, type, schema })`, `deleteRack`, `clearRack`, `deleteDatabase`, `register`, `regenerateApiKey`, `getSqlCredentials`, and the backup methods. They return the same values as before. The `baseURL` option is accepted as another name for `url`.

Two differences:

- `axios` is no longer a dependency. Errors are `OpenDBSError` (with `status` and `body`) instead of axios errors (with `response.status`).
- `ignoreSSL` is no longer supported. To trust a self-signed certificate, start Node with `NODE_EXTRA_CA_CERTS=/path/to/cert.pem`.

## License

[CC BY-NC 4.0](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/LICENSE.md). Non-commercial use is free with attribution.
