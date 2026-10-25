# OpenDBS client libraries

Official clients for **Node.js**, **Python** and **PHP**. They talk to the OpenDBS REST API over a kept-alive
HTTP(S) connection, so there is nothing to compile and no driver binaries to install.

Authenticate with an **API key** (create one in the admin panel → API keys; it can be limited to certain
databases and IP addresses) or with a **username/password** (plus a 2FA code if the account uses 2FA).

| | Node.js | Python | PHP |
|---|---|---|---|
| Folder | `nodejs/` | `python/` | `php/` |
| Install | `npm install opendbs` (or `npm install ./drivers/nodejs`) | `pip install ./drivers/python` | `composer require opendbs/client` (path repo) or `require 'drivers/php/src/OpenDBS.php'` |
| Needs | Node 18+ | Python 3.8+ (stdlib only) | PHP 8.0+ with curl, json |

## Node.js

```js
const { OpenDBS } = require('opendbs');
const client = new OpenDBS({ url: 'http://localhost:4402', apiKey: process.env.OPENDBS_KEY });

const shop = client.database('shop');
await shop.createTable('customers', {
  name:  { type: 'string', required: true },
  email: { type: 'string', required: true, unique: true },
  age:   { type: 'integer' },
});
const customers = shop.table('customers');
const id = await customers.insert({ name: 'Asha', email: 'asha@example.com', age: 31 });
const { results, total } = await customers.find({ age: { $gte: 18 } }, { limit: 20, sort: { field: 'age', order: 'desc' } });

// SQL with JOIN / GROUP BY
const { result } = await shop.sql(`
  SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spent
  FROM customers c JOIN orders o ON o.customer_id = c.id
  GROUP BY c.name HAVING COUNT(*) > 1 ORDER BY spent DESC`);

// Aggregation pipeline (NoSQL)
const byCity = await shop.rack('events').aggregate([
  { $match: { type: 'purchase' } },
  { $group: { _id: '$city', revenue: { $sum: '$amount' }, buyers: { $addToSet: '$user' } } },
  { $sort: { revenue: -1 } },
]);

// Atomic transaction across racks
await client.transaction((tx) => {
  const order = tx.insert('shop', 'orders', { customer_id: id, total: 40 });
  tx.insert('shop', 'order_items', { order_id: order, sku: 'LAMP-1', qty: 1 });
  tx.patch('shop', 'stock', '7', { qty: 11 });
});
```

## Python

```python
from opendbs import OpenDBS

with OpenDBS("http://localhost:4402", api_key=os.environ["OPENDBS_KEY"]) as client:
    shop = client.database("shop")
    customers = shop.table("customers")
    new_id = customers.insert({"name": "Asha", "email": "asha@example.com", "age": 31})
    page = customers.find({"age": {"$gte": 18}}, limit=20, sort=("age", "desc"))
    rows = shop.sql("SELECT name, age FROM customers WHERE age BETWEEN 18 AND 40")["result"]

    def work(tx):
        order = tx.insert("shop", "orders", {"customer_id": new_id, "total": 40})
        tx.insert("shop", "order_items", {"order_id": order, "sku": "LAMP-1"})
    client.transaction(work)
```

## PHP

```php
require 'drivers/php/src/OpenDBS.php';

$client = new \OpenDBS\Client('http://localhost:4402', ['apiKey' => getenv('OPENDBS_KEY')]);
$customers = $client->database('shop')->table('customers');
$id = $customers->insert(['name' => 'Asha', 'email' => 'asha@example.com', 'age' => 31]);
$page = $customers->find(['age' => ['$gte' => 18]], ['limit' => 20]);
$rows = $client->database('shop')->sql("SELECT * FROM customers WHERE age > 30")['result'];

$client->transaction(function (\OpenDBS\TxBuilder $tx) use ($id) {
    $order = $tx->insert('shop', 'orders', ['customer_id' => $id, 'total' => 40]);
    $tx->insert('shop', 'order_items', ['order_id' => $order, 'sku' => 'LAMP-1']);
});
```

Errors raise `OpenDBSError` (Node, Python) / `OpenDBS\OpenDBSException` (PHP) with the HTTP `status`
and the server's message.
