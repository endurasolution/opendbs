# opendbs

The official Python client for [OpenDBS](https://github.com/endurasolution/opendbs/tree/main/OPENDBSBUILD), a document and SQL database server.

- **No dependencies:** standard library only, with a kept-alive HTTP connection.
- **Clusters:** give several URLs and the client moves to another member when one fails, including during a failover election.
- **Safe retries:** every write carries an `Idempotency-Key`, so a retry after a network error is never applied twice.

Requires Python 3.8 or newer and an OpenDBS 1.0 server.

```bash
pip install opendbs
```

## Connect

```python
import os
from opendbs import OpenDBS

# With an API key (admin panel → API keys; can be limited to databases and IPs)
client = OpenDBS("http://localhost:4402", api_key=os.environ["OPENDBS_KEY"])

# Or with a user. The client signs in on the first call and again when the session expires.
client = OpenDBS("http://localhost:4402", username="app", password=os.environ["OPENDBS_PASSWORD"])

# A cluster: list the members
client = OpenDBS(["http://10.0.0.5:4402", "http://10.0.0.6:4402", "http://10.0.0.7:4402"], api_key="...")
```

Options: `api_key`, `username`, `password`, `totp` (2FA code), `token`, `timeout` (seconds, default 30), `failover` (seconds to keep trying other members, default 20), `verify_tls` (default `True`).

A client keeps one connection open and is not thread-safe: create one per thread. It can be used as a context manager (`with OpenDBS(...) as client:`).

## Documents

```python
client.create_database("shop")
shop = client.database("shop")
shop.create_rack("events")                       # NoSQL rack: any JSON
shop.create_table("customers", {                 # SQL table: typed columns
    "name": {"type": "string", "required": True},
    "email": {"type": "string", "required": True, "unique": True},
    "age": {"type": "integer"},
})

customers = shop.table("customers")
new_id = customers.insert({"name": "Asha", "email": "asha@example.com", "age": 31})
customers.insert_many([{"name": "Ravi", "email": "ravi@example.com", "age": 45}])   # all or nothing

page = customers.find({"age": {"$gte": 18}}, sort=("age", "desc"), limit=20, skip=0)
print(page["total"], [c["name"] for c in page["results"]])

doc = customers.get(new_id)                      # None when missing
customers.patch(new_id, {"age": 32})             # merge fields
customers.update(new_id, {"name": "Asha", "email": "asha@example.com", "age": 33})   # replace
customers.delete(new_id)
customers.create_index(["name", "age"])          # compound index
```

## SQL

```python
# ? (or $1) placeholders are never parsed as SQL: use them for any user input.
res = shop.sql(
    "SELECT c.name, COUNT(*) AS orders FROM customers c "
    "JOIN orders o ON o.customer_id = c.id WHERE o.total > ? GROUP BY c.name",
    [20],
)
for row in res["result"]:
    print(row["name"], row["orders"])
```

## Aggregation, search, transactions

```python
by_city = shop.rack("events").aggregate([
    {"$match": {"type": "purchase"}},
    {"$group": {"_id": "$city", "revenue": {"$sum": "$amount"}}},
    {"$sort": {"revenue": -1}},
])

shop.rack("products").fuzzy_search("name", "lapptop")
shop.rack("products").vector_search("embedding", [0.12, 0.4, 0.9], k=10)

# Atomic across racks. tx.insert() returns a reference to the new id.
def work(tx):
    order = tx.insert("shop", "orders", {"customer_id": "1", "total": 40})
    tx.insert("shop", "order_items", {"order_id": order, "sku": "LAMP-1"})
    tx.patch("shop", "stock", "7", {"qty": 11})

client.transaction(work)
```

## Errors

Failed requests raise `OpenDBSError` with `status` (the HTTP status, or 0 if there was no response) and `body` (the server's response).

```python
from opendbs import OpenDBSError

try:
    customers.insert({"name": "Dup", "email": "asha@example.com"})
except OpenDBSError as e:
    if e.status == 400:
        print(e)
```

## Upgrading from 1.0.0 / 1.0.1

Code written for the earlier client keeps working. Its methods are still there and return the same values: `login(username, password)`, `set_token`, `register`, `regenerate_api_key`, `list_databases(include_racks=)`, `create_database`, `delete_database`, `list_racks`, `create_rack(db, name, type=, schema=)`, `delete_rack`, `clear_rack`, `insert(db, rack, doc)`, `find(db, rack, query)`, `find_one(db, rack, id)`, `update`, `delete`, `sql(db, query)`, `search`, `fuzzy_search`, `vector_search`, `create_backup` and `list_backups`. The `base_url`, `token` and `ignore_ssl` arguments are accepted too.

Differences:

- `requests` is no longer a dependency.
- Errors are `OpenDBSError` (with `status` and `body`). It is still an `Exception`, so `except Exception` keeps working, but the message no longer starts with "OpenDBS Error:".
- `fuzzy_search` and `vector_search` called the wrong endpoint in the earlier client. They work now.

## License

[CC BY-NC 4.0](https://github.com/endurasolution/opendbs/blob/main/OPENDBSBUILD/LICENSE.md). Non-commercial use is free with attribution.
