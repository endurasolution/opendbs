# opendbs/client

The official PHP client for [OpenDBS](https://github.com/endurasolution/opendbs/tree/main/OPENDBSBUILD), a document and SQL database server.

- **No dependencies:** uses PHP's curl extension, with one kept-alive connection per client.
- **Clusters:** give several URLs and the client moves to another member when one fails, including during a failover election.
- **Safe retries:** every write carries an `Idempotency-Key`, so a retry after a network error is never applied twice.

Requires PHP 8.0 or newer (with the `curl` and `json` extensions) and an OpenDBS 1.0 server.

```bash
composer require opendbs/client
```

## Connect

```php
require 'vendor/autoload.php';

use OpenDBS\Client;

// With an API key (admin panel → API keys; can be limited to databases and IPs)
$client = new Client('http://localhost:4402', ['apiKey' => getenv('OPENDBS_KEY')]);

// Or with a user. The client signs in on the first call and again when the session expires.
$client = new Client('http://localhost:4402', ['username' => 'app', 'password' => getenv('OPENDBS_PASSWORD')]);

// A cluster: list the members
$client = new Client('http://10.0.0.5:4402,http://10.0.0.6:4402,http://10.0.0.7:4402', ['apiKey' => '...']);
```

Options: `apiKey`, `username`, `password`, `totp` (2FA code), `token`, `timeout` (seconds, default 30), `failover` (seconds to keep trying other members, default 20), `ignoreSSL` (accept self-signed certificates, for development only).

## Documents

```php
$client->createDatabase('shop');
$shop = $client->database('shop');
$shop->createRack('events');                      // NoSQL rack: any JSON
$shop->createTable('customers', [                 // SQL table: typed columns
    'name'  => ['type' => 'string', 'required' => true],
    'email' => ['type' => 'string', 'required' => true, 'unique' => true],
    'age'   => ['type' => 'integer'],
]);

$customers = $shop->table('customers');
$id = $customers->insert(['name' => 'Asha', 'email' => 'asha@example.com', 'age' => 31]);
$customers->insertMany([['name' => 'Ravi', 'email' => 'ravi@example.com', 'age' => 45]]);   // all or nothing

$page = $customers->find(['age' => ['$gte' => 18]], ['sort' => ['field' => 'age', 'order' => 'desc'], 'limit' => 20]);
echo $page['total'], ' customers, first: ', $page['results'][0]['name'], "\n";

$doc = $customers->get($id);                      // null when missing
$customers->patch($id, ['age' => 32]);            // merge fields
$customers->delete($id);
$customers->createIndex(['name', 'age']);         // compound index
```

Write query operators in single quotes (`'$gte'`) so PHP doesn't treat `$` as a variable.

## SQL

```php
// ? (or $1) placeholders are never parsed as SQL: use them for any user input.
$res = $shop->sql(
    'SELECT c.name, COUNT(*) AS orders FROM customers c
       JOIN orders o ON o.customer_id = c.id WHERE o.total > ? GROUP BY c.name',
    [20]
);
foreach ($res['result'] as $row) {
    echo $row['name'], ': ', $row['orders'], "\n";
}
```

## Aggregation, search, transactions

```php
$byCity = $shop->rack('events')->aggregate([
    ['$match' => ['type' => 'purchase']],
    ['$group' => ['_id' => '$city', 'revenue' => ['$sum' => '$amount']]],
    ['$sort' => ['revenue' => -1]],
]);

$shop->rack('products')->fuzzySearch('name', 'lapptop');
$shop->rack('products')->vectorSearch('embedding', [0.12, 0.4, 0.9], 10);

// Atomic across racks. $tx->insert() returns a reference to the new id.
$client->transaction(function (\OpenDBS\TxBuilder $tx) {
    $order = $tx->insert('shop', 'orders', ['customer_id' => '1', 'total' => 40]);
    $tx->insert('shop', 'order_items', ['order_id' => $order, 'sku' => 'LAMP-1']);
    $tx->patch('shop', 'stock', '7', ['qty' => 11]);
});
```

## Errors

Failed requests throw `OpenDBS\OpenDBSException` with `$status` (the HTTP status, also the exception code; 0 if there was no response) and `$body` (the server's response).

```php
try {
    $customers->insert(['name' => 'Dup', 'email' => 'asha@example.com']);
} catch (\OpenDBS\OpenDBSException $e) {
    if ($e->status === 400) echo $e->getMessage();
}
```

## Upgrading from the 1.0.0 client

Code written for the earlier Guzzle-based client keeps working: `new OpenDBS\OpenDBS($baseURL, $token, ['ignoreSSL' => true])` and its methods are still there and return the same values (`login($username, $password)`, `createRack($db, $name, $type, $schema)`, `insert($db, $rack, $doc)`, `find($db, $rack, $query)`, `findOne`, `update`, `delete`, `sql($db, $query)`, `search`, `fuzzySearch`, `vectorSearch`, backups, …).

Differences:

- Guzzle is no longer a dependency, and PHP 8.0 or newer is required.
- Errors are `OpenDBS\OpenDBSException`. It is still an `\Exception` whose code is the HTTP status, so existing `catch (\Exception $e)` blocks keep working.

## License

[CC BY-NC 4.0](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/LICENSE.md). Non-commercial use is free with attribution.
