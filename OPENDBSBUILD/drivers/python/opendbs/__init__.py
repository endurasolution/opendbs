"""OpenDBS client for Python 3.8+ (standard library only).

    from opendbs import OpenDBS

    client = OpenDBS("http://localhost:4402", api_key=os.environ["OPENDBS_KEY"])
    users = client.database("shop").rack("users")
    new_id = users.insert({"name": "Asha", "age": 31})
    page = users.find({"age": {"$gte": 18}}, limit=20, sort=("age", "desc"))
    rows = client.database("shop").sql("SELECT name, COUNT(*) AS n FROM users GROUP BY name")["result"]

One persistent (keep-alive) HTTP connection per client. A client is not
thread-safe; create one per thread.
"""

from __future__ import annotations

import http.client
import json
import ssl
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union
from urllib.parse import quote, urlencode, urlparse

__all__ = ["OpenDBS", "OpenDBSError", "Database", "Rack", "TxBuilder"]
__version__ = "1.0.2"


class OpenDBSError(Exception):
    def __init__(self, message: str, status: int = 0, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


def _q(s: str) -> str:
    return quote(str(s), safe="")


class OpenDBS:
    def __init__(
        self,
        url: Union[str, Sequence[str], None] = None,
        api_key: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        totp: Optional[str] = None,
        timeout: float = 30.0,
        verify_tls: bool = True,
        failover: float = 20.0,
        token: Optional[str] = None,
        ignore_ssl: bool = False,
        base_url: Optional[str] = None,
    ):
        """url: one server, or several cluster members (list or comma-separated) to fail over between.

        failover: seconds to keep trying other members while one is down (covers an election).
        token: an existing session token. Without api_key, username/password or token,
        call login(username, password) first.
        base_url, ignore_ssl: names used by the 1.0.x client for url and verify_tls=False.
        """
        url = url if url is not None else base_url
        if not url:
            raise ValueError("url is required")
        # The 1.0.x client's second positional argument was a session token.
        if api_key and not api_key.startswith("opendbs_") and api_key.count(".") == 2 and token is None:
            api_key, token = None, api_key
        if ignore_ssl:
            verify_tls = False
        urls = list(url) if isinstance(url, (list, tuple)) else str(url).split(",")
        self._targets: List[Tuple[str, str, Optional[int], str]] = []
        for one in urls:
            u = urlparse(one.strip().rstrip("/"))
            if u.scheme not in ("http", "https") or not u.hostname:
                raise ValueError("url must look like http://host:port")
            self._targets.append((u.scheme, u.hostname, u.port, u.path or ""))
        self._current = 0
        self._failover = failover
        self._timeout = timeout
        self._ctx = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()  # noqa: S323
        self.api_key, self.username, self.password, self.totp = api_key, username, password, totp
        self.token: Optional[str] = token
        self._conn: Optional[http.client.HTTPConnection] = None

    @property
    def base_url(self) -> str:
        return self.url

    @property
    def url(self) -> str:
        scheme, host, port, base = self._targets[self._current]
        return f"{scheme}://{host}{':' + str(port) if port else ''}{base}"

    # ── transport ──
    def _connection(self) -> http.client.HTTPConnection:
        if self._conn is None:
            scheme, host, port, _ = self._targets[self._current]
            if scheme == "https":
                self._conn = http.client.HTTPSConnection(host, port, timeout=self._timeout, context=self._ctx)
            else:
                self._conn = http.client.HTTPConnection(host, port, timeout=self._timeout)
        return self._conn

    def _next_member(self) -> None:
        self.close()
        self._current = (self._current + 1) % len(self._targets)

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "OpenDBS":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _raw(self, method: str, path: str, body: Any = None, auth: bool = True) -> Any:
        headers = {"Accept": "application/json", "Connection": "keep-alive"}
        if auth:
            if self.api_key:
                headers["X-Api-Key"] = self.api_key
            elif self.token:
                headers["Authorization"] = f"Bearer {self.token}"
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        read_only = method in ("GET", "HEAD")
        # Writes carry an idempotency key: a retry after a lost connection gets the first
        # attempt's result instead of being applied twice (server >= 0.5).
        keyed = not read_only and not path.startswith("/api/auth/")
        if keyed:
            headers["Idempotency-Key"] = uuid.uuid4().hex
        deadline = time.monotonic() + self._failover
        attempt = 0
        while True:
            attempt += 1
            last: Optional[BaseException] = None
            try:
                conn = self._connection()
                conn.request(method, self._targets[self._current][3] + path, body=payload, headers=headers)
                res = conn.getresponse()
                raw = res.read()
            except ConnectionRefusedError as e:  # never reached a server: safe to retry anywhere
                last = e
            except (http.client.HTTPException, ConnectionError, OSError) as e:
                # A dropped keep-alive connection is retried once on the same member; writes no further.
                self.close()
                if attempt == 1:
                    continue
                if not read_only and not keyed:
                    raise
                last = e
            if last is None:
                text = raw.decode("utf-8") if raw else ""
                try:
                    data = json.loads(text) if text else None
                except ValueError:
                    data = text
                if res.status < 400:
                    return data
                msg = None
                if isinstance(data, dict):
                    msg = data.get("message") if data.get("error") == "Forbidden" else (data.get("error") or data.get("message"))
                err = OpenDBSError(msg or f"HTTP {res.status}", res.status, data)
                # 503 = no primary right now (election) / member unavailable: nothing was written, try again.
                if res.status != 503 or (isinstance(data, dict) and data.get("savedOnPrimary")):
                    raise err
                last = err
            self._next_member()
            if time.monotonic() >= deadline:
                raise last
            if attempt % len(self._targets) == 0:
                time.sleep(0.4)

    def login(self, username: Optional[str] = None, password: Optional[str] = None, totp: Optional[str] = None) -> Dict[str, Any]:
        """Sign in with the constructor's credentials, or with the ones given here (they are kept,
        so the client signs in again when the session expires). Returns {"token", "user"}."""
        if username is not None:
            self.username, self.password = username, password
            if totp is not None:
                self.totp = totp
        if not (self.username and self.password):
            raise ValueError("give api_key, or username and password")
        data = self._raw("POST", "/api/auth/login", {"username": self.username, "password": self.password}, auth=False)
        if data.get("twoFactorRequired"):
            if not self.totp:
                raise OpenDBSError("This account uses two-factor authentication: pass totp=", 401, data)
            data = self._raw("POST", "/api/auth/login/2fa", {"challenge": data["challenge"], "code": str(self.totp)}, auth=False)
        self.token = data["token"]
        return data

    def set_token(self, token: str) -> None:
        """Use an existing session token."""
        self.token = token

    def request(self, method: str, path: str, body: Any = None) -> Any:
        if not self.api_key and not self.token and self.username and self.password:
            self.login()
        try:
            return self._raw(method, path, body)
        except OpenDBSError as e:
            if e.status == 401 and not self.api_key and self.username and self.password:
                self.login()
                return self._raw(method, path, body)
            raise

    # ── server ──
    def version(self) -> Dict[str, Any]:
        return self.request("GET", "/api/version")

    def me(self) -> Dict[str, Any]:
        return self.request("GET", "/api/auth/me")

    def list_databases(self, include_racks: bool = False) -> List[Any]:
        return self.request("GET", "/api/databases" + ("?include_racks=true" if include_racks else ""))["databases"]

    def create_database(self, name: str) -> Any:
        return self.request("POST", "/api/databases", {"name": name})

    def drop_database(self, name: str) -> Any:
        return self.request("DELETE", f"/api/databases/{_q(name)}")

    def database(self, name: str) -> "Database":
        return Database(self, name)

    def transaction(self, ops_or_fn: Union[List[Dict[str, Any]], Callable[["TxBuilder"], None]]) -> Dict[str, Any]:
        """Atomic multi-rack transaction.

            def work(tx):
                order = tx.insert("shop", "orders", {"total": 40})
                tx.insert("shop", "order_items", {"order_id": order, "sku": "A1"})
            client.transaction(work)
        """
        ops = ops_or_fn
        if callable(ops_or_fn):
            builder = TxBuilder()
            ops_or_fn(builder)
            ops = builder.ops
        return self.request("POST", "/api/transactions", {"operations": ops})

    # ── 1.0.x API: database and rack passed as arguments ──
    # The first published client took the database and rack as arguments. These
    # methods keep that code working; new code can use database() / rack().

    def register(self, user_data: Dict[str, Any]) -> Any:
        return self._raw("POST", "/api/auth/register", user_data, auth=False)

    def regenerate_api_key(self) -> Any:
        return self.request("POST", "/api/auth/regenerate-api-key")

    def delete_database(self, name: str) -> Any:
        return self.drop_database(name)

    def list_racks(self, database: str) -> List[Dict[str, Any]]:
        return self.database(database).list_racks()

    def create_rack(self, database: str, name: str, type: str = "nosql", schema: Optional[Dict[str, Any]] = None) -> Any:
        body: Dict[str, Any] = {"name": name, "type": type}
        if schema:
            body["schema"] = schema
        return self.request("POST", f"/api/databases/{_q(database)}/racks", body)

    def delete_rack(self, database: str, rack: str) -> Any:
        return self.database(database).drop_rack(rack)

    def clear_rack(self, database: str, rack: str) -> Any:
        return self.database(database).rack(rack).clear()

    def insert(self, database: str, rack: str, document: Any) -> Any:
        """Returns the server response ({"id": ...} or {"ids": [...]})."""
        return self.request("POST", f"{_rack_path(database, rack)}/documents", document)

    def find(self, database: str, rack: str, query: Optional[Dict[str, Any]] = None, populate: bool = False) -> List[Dict[str, Any]]:
        """Equality filters as query parameters, e.g. find("shop", "users", {"city": "Pune"})."""
        params = {k: (str(v).lower() if isinstance(v, bool) else v) for k, v in (query or {}).items()}
        if populate:
            params["populate"] = "true"
        qs = urlencode(params)
        return self.request("GET", f"{_rack_path(database, rack)}/documents" + (f"?{qs}" if qs else "")).get("results", [])

    def find_one(self, database: str, rack: str, doc_id: str, populate: bool = False) -> Optional[Dict[str, Any]]:
        res = self.find(database, rack, {"id": doc_id}, populate)
        return res[0] if res else None

    def update(self, database: str, rack: str, doc_id: str, updates: Dict[str, Any]) -> Any:
        return self.database(database).rack(rack).update(doc_id, updates)

    def delete(self, database: str, rack: str, doc_id: str) -> Any:
        return self.database(database).rack(rack).delete(doc_id)

    def sql(self, database: str, query: str, params: Optional[Sequence[Any]] = None) -> Any:
        """Returns the statement results."""
        res = self.database(database).sql(query, params)
        return res["results"] if isinstance(res, dict) and "results" in res else res

    def search(self, database: str, rack: str, query_body: Dict[str, Any]) -> List[Dict[str, Any]]:
        """query_body = {"query": {...}, "limit": ..., "skip": ..., "sort": ...}"""
        return self.request("POST", f"{_rack_path(database, rack)}/search", query_body).get("results", [])

    def fuzzy_search(self, database: str, rack: str, field: str, query: str) -> List[Dict[str, Any]]:
        return self.database(database).rack(rack).fuzzy_search(field, query).get("results", [])

    def vector_search(self, database: str, rack: str, field: str, vector: Sequence[float], k: int = 5) -> List[Dict[str, Any]]:
        return self.database(database).rack(rack).vector_search(field, vector, k).get("results", [])

    def create_backup(self) -> Any:
        return self.request("POST", "/api/backup/create")

    def list_backups(self) -> List[Any]:
        return self.request("GET", "/api/backup/list").get("backups", [])


def _rack_path(database: str, rack: str) -> str:
    return f"/api/databases/{_q(database)}/racks/{_q(rack)}"


class TxBuilder:
    def __init__(self) -> None:
        self.ops: List[Dict[str, Any]] = []

    def _add(self, op: Dict[str, Any]) -> str:
        self.ops.append(op)
        return f"${len(self.ops) - 1}.id"

    def insert(self, database: str, rack: str, data: Dict[str, Any]) -> str:
        return self._add({"op": "insert", "database": database, "rack": rack, "data": data})

    def update(self, database: str, rack: str, id: str, data: Dict[str, Any]) -> str:
        return self._add({"op": "update", "database": database, "rack": rack, "id": id, "data": data})

    def patch(self, database: str, rack: str, id: str, data: Dict[str, Any]) -> str:
        return self._add({"op": "patch", "database": database, "rack": rack, "id": id, "data": data})

    def delete(self, database: str, rack: str, id: str) -> str:
        return self._add({"op": "delete", "database": database, "rack": rack, "id": id})


class Database:
    def __init__(self, client: OpenDBS, name: str):
        self.client, self.name = client, name

    def _p(self, rest: str = "") -> str:
        return f"/api/databases/{_q(self.name)}{rest}"

    def list_racks(self) -> List[Dict[str, Any]]:
        return self.client.request("GET", self._p("/racks"))["racks"]

    def create_rack(self, name: str) -> Any:
        """NoSQL rack: free-form JSON documents."""
        return self.client.request("POST", self._p("/racks"), {"name": name, "type": "nosql"})

    def create_table(self, name: str, schema: Dict[str, Dict[str, Any]]) -> Any:
        """SQL rack: schema = {"email": {"type": "string", "required": True, "unique": True}, ...}"""
        return self.client.request("POST", self._p("/racks"), {"name": name, "type": "sql", "schema": schema})

    def drop_rack(self, name: str) -> Any:
        return self.client.request("DELETE", self._p(f"/racks/{_q(name)}"))

    def rack(self, name: str) -> "Rack":
        return Rack(self, name)

    table = rack

    def sql(self, query: str, params: Optional[Sequence[Any]] = None) -> Dict[str, Any]:
        """Run SQL (several ;-separated statements and BEGIN … COMMIT allowed).

        params fill ? / $1 placeholders and are never parsed as SQL — use them for user input.
        """
        body: Dict[str, Any] = {"query": query}
        if params is not None:
            body["params"] = list(params)
        return self.client.request("POST", f"/api/sql/{_q(self.name)}/execute", body)

    def stats(self) -> Dict[str, Any]:
        return self.client.request("GET", self._p("/stats"))


class Rack:
    def __init__(self, db: Database, name: str):
        self.db, self.client, self.name = db, db.client, name

    def _p(self, rest: str = "") -> str:
        return f"/api/databases/{_q(self.db.name)}/racks/{_q(self.name)}{rest}"

    def insert(self, doc: Dict[str, Any]) -> str:
        return self.client.request("POST", self._p("/documents"), doc)["id"]

    def insert_many(self, docs: Sequence[Dict[str, Any]]) -> List[str]:
        """All-or-nothing bulk insert."""
        return self.client.request("POST", self._p("/documents"), list(docs))["ids"]

    def find(
        self,
        query: Optional[Dict[str, Any]] = None,
        skip: int = 0,
        limit: Optional[int] = None,
        sort: Optional[Tuple[str, str]] = None,
        populate: bool = False,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"query": query or {}, "skip": skip, "populate": populate}
        if limit is not None:
            body["limit"] = limit
        if sort:
            body["sort"] = {"field": sort[0], "order": sort[1] if len(sort) > 1 else "asc"}
        return self.client.request("POST", self._p("/search"), body)

    def find_one(self, query: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        res = self.find(query, limit=1)["results"]
        return res[0] if res else None

    def count(self, query: Optional[Dict[str, Any]] = None) -> int:
        return self.find(query, limit=1)["total"]

    def get(self, id: str) -> Optional[Dict[str, Any]]:
        try:
            return self.client.request("GET", self._p(f"/documents/{_q(id)}"))
        except OpenDBSError as e:
            if e.status == 404:
                return None
            raise

    def update(self, id: str, doc: Dict[str, Any]) -> Any:
        return self.client.request("PUT", self._p(f"/documents/{_q(id)}"), doc)

    def patch(self, id: str, fields: Dict[str, Any]) -> Any:
        return self.client.request("PATCH", self._p(f"/documents/{_q(id)}"), fields)

    def delete(self, id: str) -> Any:
        return self.client.request("DELETE", self._p(f"/documents/{_q(id)}"))

    def clear(self) -> Any:
        return self.client.request("DELETE", self._p("/clear"))

    def aggregate(self, pipeline: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return self.client.request("POST", self._p("/aggregate"), {"pipeline": pipeline})["results"]

    def create_index(self, fields: Union[str, Sequence[str]], unique: bool = False) -> Any:
        body = {"field": fields, "unique": unique} if isinstance(fields, str) else {"fields": list(fields), "unique": unique}
        return self.client.request("POST", self._p("/indexes"), body)

    def drop_index(self, name: Union[str, Sequence[str]]) -> Any:
        n = name if isinstance(name, str) else "+".join(name)
        return self.client.request("DELETE", self._p(f"/indexes/{_q(n)}"))

    def indexes(self) -> List[Dict[str, Any]]:
        return self.client.request("GET", self._p("/indexes"))["details"]

    def fuzzy_search(self, field: str, query: str, threshold: float = 0.6) -> Dict[str, Any]:
        return self.client.request("POST", self._p("/search/fuzzy"), {"field": field, "query": query, "threshold": threshold})

    def vector_search(self, field: str, vector: Sequence[float], k: int = 10) -> Dict[str, Any]:
        return self.client.request("POST", self._p("/search/vector"), {"field": field, "vector": list(vector), "k": k})
