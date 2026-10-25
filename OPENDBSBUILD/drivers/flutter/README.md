# opendbs

The official Dart and Flutter client for [OpenDBS](https://github.com/endurasolution/opendbs/tree/main/OPENDBSBUILD), a document and SQL database server.

- **Everywhere Dart runs:** Flutter (Android, iOS, web, desktop) and plain Dart on servers.
- **Clusters:** give several URLs and the client moves to another member when one fails, including during a failover election.
- **Safe retries:** every write carries an `Idempotency-Key`, so a retry after a network error is never applied twice.

Requires an OpenDBS 1.0 server.

```yaml
dependencies:
  opendbs: ^1.0.1
```

## Connect

```dart
import 'package:opendbs/opendbs.dart';

// With an API key (admin panel → API keys; can be limited to databases and IPs)
final client = OpenDBS('http://localhost:4402', apiKey: 'opendbs_...');

// Or with a user. The client signs in on the first call and again when the session expires.
final client2 = OpenDBS('http://localhost:4402', username: 'app', password: '...');

// A cluster
final client3 = OpenDBS.cluster(
  ['http://10.0.0.5:4402', 'http://10.0.0.6:4402', 'http://10.0.0.7:4402'],
  apiKey: 'opendbs_...',
);
```

Options: `apiKey`, `username`, `password`, `totp` (2FA code), `token`, `timeout` (default 30 s), `failover` (how long to keep trying other members, default 20 s), `ignoreSSL` (accept self-signed certificates on mobile and desktop, for development only), `httpClient`.

> In a Flutter app that ships to users, prefer an API key limited to the databases the app needs, or sign users in with their own accounts. Anything built into an app can be extracted from it.

## Documents

```dart
await client.createDatabase('shop');
final shop = client.database('shop');
await shop.createRack('events');                      // NoSQL rack: any JSON
await shop.createTable('customers', {                 // SQL table: typed columns
  'name': {'type': 'string', 'required': true},
  'email': {'type': 'string', 'required': true, 'unique': true},
  'age': {'type': 'integer'},
});

final customers = shop.table('customers');
final id = await customers.insert({'name': 'Asha', 'email': 'asha@example.com', 'age': 31});
await customers.insertMany([{'name': 'Ravi', 'email': 'ravi@example.com', 'age': 45}]);   // all or nothing

final page = await customers.find(
  {'age': {r'$gte': 18}},
  sort: 'age', order: 'desc', limit: 20, skip: 0,
);
print('${page.total} customers, first: ${page.results.first['name']}');

final one = await customers.get(id);                  // null when missing
await customers.patch(id, {'age': 32});               // merge fields
await customers.delete(id);
await customers.createIndex(['name', 'age']);         // compound index
```

Write query operators as raw strings (`r'$gte'`) so Dart doesn't treat `$` as interpolation.

## SQL

```dart
// ? (or $1) placeholders are never parsed as SQL: use them for any user input.
final res = await shop.sql(
  'SELECT c.name, COUNT(*) AS orders FROM customers c '
  'JOIN orders o ON o.customer_id = c.id WHERE o.total > ? GROUP BY c.name',
  [20],
);
for (final row in res['result']) {
  print('${row['name']}: ${row['orders']}');
}
```

## Aggregation, search, transactions

```dart
final byCity = await shop.rack('events').aggregate([
  {r'$match': {'type': 'purchase'}},
  {r'$group': {'_id': r'$city', 'revenue': {r'$sum': r'$amount'}}},
  {r'$sort': {'revenue': -1}},
]);

await shop.rack('products').fuzzySearch('name', 'lapptop');
await shop.rack('products').vectorSearch('embedding', [0.12, 0.4, 0.9], k: 10);

// Atomic across racks. tx.insert() returns a reference to the new id.
await client.transaction((tx) {
  final order = tx.insert('shop', 'orders', {'customer_id': '1', 'total': 40});
  tx.insert('shop', 'order_items', {'order_id': order, 'sku': 'LAMP-1'});
  tx.patch('shop', 'stock', '7', {'qty': 11});
});
```

## Errors

Failed requests throw an `OpenDBSException` with `message`, `statusCode` (the HTTP status, or 0 if there was no response) and `body`.

```dart
try {
  await customers.insert({'name': 'Dup', 'email': 'asha@example.com'});
} on OpenDBSException catch (e) {
  if (e.statusCode == 400) print(e.message);
}
```

## Upgrading from 1.0.0

Code written for 1.0.0 keeps working. Its methods are still there and return the same values: `login(username, password)`, `register`, `listDatabases`, `createDatabase`, `deleteDatabase`, `listRacks`, `createRack(db, name, type:, schema:)`, `deleteRack`, `insert(db, rack, doc)`, `find(db, rack, query:)`, `sql(db, query)`, `search`, and `fuzzySearch`. `fuzzySearch` called the wrong endpoint in 1.0.0; this is fixed.

The package no longer depends on Flutter or `dart:io`, so it also works on the web and in plain Dart.

## Tests

`test/` holds integration tests that run against a live server:

```bash
OPENDBS_URL=http://localhost:4402 OPENDBS_KEY=<admin API key> OPENDBS_ADMIN_PASSWORD=<admin password> dart test
```
