## 1.0.1

For OpenDBS server 1.0.

* New API: `client.database('shop').rack('users')` with `insert`, `insertMany`, `find` (MongoDB-style queries, sort, paging), `findOne`, `count`, `get`, `update`, `patch`, `delete`, `clear`, `aggregate`, indexes, fuzzy and vector search; `createTable` with typed columns; SQL with `?` parameters; atomic `transaction()`.
* API keys (`apiKey:`), and username/password with automatic sign-in and two-factor codes (`totp:`).
* Cluster failover: give several URLs (`OpenDBS.cluster([...])` or comma-separated) and requests move to another member when one is down.
* Safe retries: every write carries an `Idempotency-Key`.
* Works on the web (the package no longer requires `dart:io`), and in plain Dart without Flutter.
* `fuzzySearch()` called the wrong endpoint. Fixed.
* `OpenDBSException` now also has the response `body`.
* The 1.0.0 methods (`login`, `insert(db, rack, doc)`, `find`, `sql(db, query)`, `search`, `createRack(db, name, type:, schema:)`, …) keep working and return the same values.

## 1.0.0

* Initial release of the OpenDBS Flutter Client Library.
* Support for Database, Rack, Document management.
* Support for SQL execution.
* Support for Fuzzy and Vector Search.
