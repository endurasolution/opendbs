import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'transport_stub.dart' if (dart.library.io) 'transport_io.dart'
    as transport;

/// A request the server refused, or one that could not be sent.
class OpenDBSException implements Exception {
  final String message;

  /// HTTP status, or 0 when no response was received.
  final int statusCode;

  /// The server's response body, when there was one.
  final dynamic body;

  OpenDBSException(this.message, this.statusCode, [this.body]);

  @override
  String toString() => 'OpenDBSException: $message (Status: $statusCode)';
}

/// Client for an OpenDBS server or cluster.
///
/// ```dart
/// final client = OpenDBS('http://localhost:4402', apiKey: 'opendbs_...');
/// final users = client.database('shop').rack('users');
/// final id = await users.insert({'name': 'Asha', 'age': 31});
/// final page = await users.find({'age': {r'$gte': 18}}, limit: 20);
/// ```
///
/// [baseURL] may list several cluster members, comma-separated; requests move
/// to another member when one is down. Writes carry an `Idempotency-Key`, so a
/// retry after a lost connection is never applied twice.
class OpenDBS {
  /// The URL (or comma-separated URLs) given to the constructor.
  final String baseURL;
  final List<String> urls;
  final bool ignoreSSL;
  final String? apiKey;
  final Duration timeout;

  /// How long to keep trying other members when one is down (covers an election).
  final Duration failover;

  String? _token;
  String? _username;
  String? _password;
  String? _totp;
  int _current = 0;
  final http.Client _client;

  OpenDBS(
    this.baseURL, {
    String? token,
    this.apiKey,
    String? username,
    String? password,
    String? totp,
    this.ignoreSSL = false,
    this.timeout = const Duration(seconds: 30),
    this.failover = const Duration(seconds: 20),
    http.Client? httpClient,
  })  : urls = baseURL
            .split(',')
            .map((u) => u.trim().replaceAll(RegExp(r'/+$'), ''))
            .where((u) => u.isNotEmpty)
            .toList(),
        _client =
            httpClient ?? transport.createHttpClient(ignoreSSL: ignoreSSL) {
    if (urls.isEmpty) throw ArgumentError('OpenDBS: baseURL is required');
    _token = token;
    _username = username;
    _password = password;
    _totp = totp;
  }

  /// Several cluster members.
  factory OpenDBS.cluster(
    List<String> urls, {
    String? token,
    String? apiKey,
    String? username,
    String? password,
    String? totp,
    bool ignoreSSL = false,
    Duration timeout = const Duration(seconds: 30),
    Duration failover = const Duration(seconds: 20),
    http.Client? httpClient,
  }) =>
      OpenDBS(urls.join(','),
          token: token,
          apiKey: apiKey,
          username: username,
          password: password,
          totp: totp,
          ignoreSSL: ignoreSSL,
          timeout: timeout,
          failover: failover,
          httpClient: httpClient);

  /// The member requests currently go to.
  String get url => urls[_current];

  String? get token => _token;

  /// Use an existing session token.
  void setToken(String token) {
    _token = token;
  }

  /// Closes the underlying HTTP connections.
  void close() => _client.close();

  // ── Transport ───────────────────────────────────────────────────────────

  static final _rnd = Random.secure();
  static String _uuid() {
    final b = List<int>.generate(16, (_) => _rnd.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }

  Future<dynamic> _raw(String method, String path,
      {dynamic body,
      Map<String, dynamic>? queryParams,
      bool auth = true}) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (auth) {
      if (apiKey != null) {
        headers['X-Api-Key'] = apiKey!;
      } else if (_token != null) {
        headers['Authorization'] = 'Bearer $_token';
      }
    }
    if (body != null) headers['Content-Type'] = 'application/json';
    final read = method == 'GET' || method == 'HEAD';
    final keyed = !read && !path.startsWith('/api/auth/');
    if (keyed) headers['Idempotency-Key'] = _uuid();
    final qs = queryParams == null || queryParams.isEmpty
        ? ''
        : '?${Uri(queryParameters: queryParams.map((k, v) => MapEntry(k, '$v'))).query}';
    final deadline = DateTime.now().add(failover);
    Object? lastErr;
    for (var attempt = 1;; attempt++) {
      http.Response? res;
      try {
        final req = http.Request(method, Uri.parse('$url$path$qs'))
          ..headers.addAll(headers);
        if (body != null) req.body = jsonEncode(body);
        res = await http.Response.fromStream(
                await _client.send(req).timeout(timeout))
            .timeout(timeout);
      } catch (e) {
        // Another member can take the request if this one is down. Un-keyed writes only when surely not sent.
        if (!read && !keyed && !transport.notSent(e)) {
          throw OpenDBSException(e.toString(), 0);
        }
        lastErr = OpenDBSException(e.toString(), 0);
      }
      if (res != null) {
        dynamic data;
        try {
          data = res.body.isEmpty ? null : jsonDecode(res.body);
        } catch (_) {
          data = res.body;
        }
        if (res.statusCode < 400) return data;
        var msg = res.reasonPhrase ?? 'HTTP ${res.statusCode}';
        if (data is Map) {
          msg = (data['error'] == 'Forbidden' && data['message'] != null
                  ? data['message']
                  : data['error'] ?? data['message'] ?? msg)
              .toString();
        } else if (data is String && data.isNotEmpty) {
          msg = data;
        }
        final err = OpenDBSException(msg, res.statusCode, data);
        // 503 = no primary right now (election) / member unavailable: nothing was written, try again.
        if (res.statusCode != 503 ||
            (data is Map && data['savedOnPrimary'] == true)) {
          throw err;
        }
        lastErr = err;
      }
      _current = (_current + 1) % urls.length;
      if (DateTime.now().isAfter(deadline)) throw lastErr!;
      if (attempt % urls.length == 0) {
        await Future<void>.delayed(const Duration(milliseconds: 400));
      }
    }
  }

  /// Authenticated request; signs in (again) automatically when a username and password are known.
  Future<dynamic> request(String method, String path,
      {dynamic body, Map<String, dynamic>? queryParams}) async {
    if (apiKey == null &&
        _token == null &&
        _username != null &&
        _password != null) {
      await login();
    }
    try {
      return await _raw(method, path, body: body, queryParams: queryParams);
    } on OpenDBSException catch (e) {
      if (e.statusCode == 401 &&
          apiKey == null &&
          _username != null &&
          _password != null) {
        await login();
        return _raw(method, path, body: body, queryParams: queryParams);
      }
      rethrow;
    }
  }

  // ── Authentication ──────────────────────────────────────────────────────

  /// Signs in with the given credentials, or with the ones given to the constructor.
  /// They are kept, so the client signs in again when the session expires.
  /// Returns `{token, user}`.
  Future<Map<String, dynamic>> login(
      [String? username, String? password, String? totp]) async {
    if (username != null) {
      _username = username;
      _password = password;
      if (totp != null) _totp = totp;
    }
    if (_username == null || _password == null) {
      throw OpenDBSException(
          'OpenDBS: give apiKey, or username and password', 0);
    }
    var data = Map<String, dynamic>.from(await _raw('POST', '/api/auth/login',
        body: {'username': _username, 'password': _password}, auth: false));
    if (data['twoFactorRequired'] == true) {
      if (_totp == null) {
        throw OpenDBSException(
            'This account uses two-factor authentication: pass totp',
            401,
            data);
      }
      data = Map<String, dynamic>.from(await _raw('POST', '/api/auth/login/2fa',
          body: {'challenge': data['challenge'], 'code': _totp}, auth: false));
    }
    setToken(data['token'] as String);
    return data;
  }

  Future<Map<String, dynamic>> register(Map<String, dynamic> userData) async =>
      Map<String, dynamic>.from(await _raw('POST', '/api/auth/register',
          body: userData, auth: false));

  Future<Map<String, dynamic>> me() async =>
      Map<String, dynamic>.from(await request('GET', '/api/auth/me'));

  /// `{name, version, builtAt, commit}`.
  Future<Map<String, dynamic>> version() async =>
      Map<String, dynamic>.from(await request('GET', '/api/version'));

  // ── Databases ───────────────────────────────────────────────────────────

  Future<List<dynamic>> listDatabases({bool includeRacks = false}) async {
    final res = await request('GET', '/api/databases',
        queryParams: includeRacks ? {'include_racks': true} : null);
    return (res['databases'] as List?) ?? [];
  }

  Future<Map<String, dynamic>> createDatabase(String name) async =>
      Map<String, dynamic>.from(
          await request('POST', '/api/databases', body: {'name': name}));

  Future<Map<String, dynamic>> dropDatabase(String name) async =>
      Map<String, dynamic>.from(
          await request('DELETE', '/api/databases/${_enc(name)}'));

  Future<Map<String, dynamic>> deleteDatabase(String name) =>
      dropDatabase(name);

  Database database(String name) => Database._(this, name);

  /// Atomic multi-rack transaction. Values returned by [TxBuilder.insert] are
  /// references that resolve to the new id inside the transaction:
  ///
  /// ```dart
  /// await client.transaction((tx) {
  ///   final order = tx.insert('shop', 'orders', {'total': 40});
  ///   tx.insert('shop', 'order_items', {'order_id': order, 'sku': 'A1'});
  /// });
  /// ```
  Future<Map<String, dynamic>> transaction(
      FutureOr<void> Function(TxBuilder tx) build) async {
    final tx = TxBuilder._();
    await build(tx);
    return Map<String, dynamic>.from(await request('POST', '/api/transactions',
        body: {'operations': tx.operations}));
  }

  // ── 1.0.0 API: database and rack passed as arguments ────────────────────

  Future<List<dynamic>> listRacks(String database) =>
      this.database(database).listRacks();

  Future<Map<String, dynamic>> createRack(String database, String name,
          {String type = 'nosql', Map<String, dynamic>? schema}) async =>
      Map<String, dynamic>.from(await request(
          'POST', '/api/databases/${_enc(database)}/racks', body: {
        'name': name,
        'type': type,
        if (schema != null) 'schema': schema
      }));

  Future<Map<String, dynamic>> deleteRack(String database, String rack) =>
      this.database(database).dropRack(rack);

  /// Returns the server response (`{id}`).
  Future<Map<String, dynamic>> insert(
          String database, String rack, Map<String, dynamic> document) async =>
      Map<String, dynamic>.from(await request(
          'POST', '${_rackPath(database, rack)}/documents',
          body: document));

  /// Equality filters as query parameters. Returns the documents.
  Future<List<dynamic>> find(String database, String rack,
      {Map<String, dynamic>? query, bool populate = false}) async {
    final params = <String, dynamic>{...?query, if (populate) 'populate': true};
    final res = await request('GET', '${_rackPath(database, rack)}/documents',
        queryParams: params);
    return (res['results'] as List?) ?? [];
  }

  /// Returns the statement results.
  Future<dynamic> sql(String database, String query,
      [List<dynamic>? params]) async {
    final res = await this.database(database).sql(query, params);
    return res.containsKey('results') ? res['results'] : res;
  }

  /// [queryBody] = `{query, limit?, skip?, sort?}`. Returns the documents.
  Future<List<dynamic>> search(
      String database, String rack, Map<String, dynamic> queryBody) async {
    final res = await request('POST', '${_rackPath(database, rack)}/search',
        body: queryBody);
    return (res['results'] as List?) ?? [];
  }

  Future<List<dynamic>> fuzzySearch(
          String database, String rack, String field, String query) async =>
      ((await this
          .database(database)
          .rack(rack)
          .fuzzySearch(field, query))['results'] as List?) ??
      [];

  Future<List<dynamic>> vectorSearch(
          String database, String rack, String field, List<num> vector,
          {int k = 5}) async =>
      ((await this
          .database(database)
          .rack(rack)
          .vectorSearch(field, vector, k: k))['results'] as List?) ??
      [];
}

String _enc(String s) => Uri.encodeComponent(s);
String _rackPath(String database, String rack) =>
    '/api/databases/${_enc(database)}/racks/${_enc(rack)}';

/// Records the operations of a [OpenDBS.transaction].
class TxBuilder {
  TxBuilder._();
  final List<Map<String, dynamic>> operations = [];
  String _ref() => '\$${operations.length - 1}.id';

  /// Returns a reference to the new document's id, usable in later operations' data.
  String insert(String database, String rack, Map<String, dynamic> data) {
    operations.add(
        {'op': 'insert', 'database': database, 'rack': rack, 'data': data});
    return _ref();
  }

  String update(
      String database, String rack, String id, Map<String, dynamic> data) {
    operations.add({
      'op': 'update',
      'database': database,
      'rack': rack,
      'id': id,
      'data': data
    });
    return _ref();
  }

  String patch(
      String database, String rack, String id, Map<String, dynamic> data) {
    operations.add({
      'op': 'patch',
      'database': database,
      'rack': rack,
      'id': id,
      'data': data
    });
    return _ref();
  }

  String delete(String database, String rack, String id) {
    operations
        .add({'op': 'delete', 'database': database, 'rack': rack, 'id': id});
    return _ref();
  }
}

class Database {
  Database._(this.client, this.name);
  final OpenDBS client;
  final String name;
  String _p([String rest = '']) => '/api/databases/${_enc(name)}$rest';

  Future<List<dynamic>> listRacks() async =>
      ((await client.request('GET', _p('/racks')))['racks'] as List?) ?? [];

  /// NoSQL rack (free-form JSON documents).
  Future<Map<String, dynamic>> createRack(String rack) async =>
      Map<String, dynamic>.from(await client.request('POST', _p('/racks'),
          body: {'name': rack, 'type': 'nosql'}));

  /// SQL rack (table): `schema = {column: {type, required?, unique?, defaultValue?}}`.
  Future<Map<String, dynamic>> createTable(
          String table, Map<String, dynamic> schema) async =>
      Map<String, dynamic>.from(await client.request('POST', _p('/racks'),
          body: {'name': table, 'type': 'sql', 'schema': schema}));

  Future<Map<String, dynamic>> dropRack(String rack) async =>
      Map<String, dynamic>.from(
          await client.request('DELETE', _p('/racks/${_enc(rack)}')));

  Rack rack(String rack) => Rack._(this, rack);
  Rack table(String table) => Rack._(this, table);

  /// Runs SQL (one or more statements). [params] fill `?` / `$1` placeholders and are
  /// never parsed as SQL: use them for any user input.
  /// Returns `{result, rowCount, columns?, results}`.
  Future<Map<String, dynamic>> sql(String query,
          [List<dynamic>? params]) async =>
      Map<String, dynamic>.from(await client.request(
          'POST', '/api/sql/${_enc(name)}/execute',
          body: {'query': query, if (params != null) 'params': params}));

  Future<Map<String, dynamic>> stats() async =>
      Map<String, dynamic>.from(await client.request('GET', _p('/stats')));
}

/// Result of [Rack.find].
class FindResult {
  FindResult._(Map<String, dynamic> m)
      : results = List<Map<String, dynamic>>.from(
            ((m['results'] as List?) ?? [])
                .map((e) => Map<String, dynamic>.from(e as Map))),
        total = (m['total'] as num?)?.toInt() ?? 0,
        count = (m['count'] as num?)?.toInt() ?? 0;
  final List<Map<String, dynamic>> results;

  /// Matching documents in the rack (ignores limit / skip).
  final int total;

  /// Documents in this page.
  final int count;
}

class Rack {
  Rack._(this.db, this.name) : client = db.client;
  final Database db;
  final OpenDBS client;
  final String name;
  String _p([String rest = '']) => '${_rackPath(db.name, name)}$rest';

  /// Inserts a document; returns its id.
  Future<String> insert(Map<String, dynamic> doc) async =>
      '${(await client.request('POST', _p('/documents'), body: doc))['id']}';

  /// All-or-nothing bulk insert; returns the ids.
  Future<List<String>> insertMany(List<Map<String, dynamic>> docs) async =>
      List<String>.from(((await client.request('POST', _p('/documents'),
              body: docs))['ids'] as List)
          .map((e) => '$e'));

  /// MongoDB-style query: `{'age': {r'$gte': 18}, r'$or': [...]}` (`{}` = all documents).
  /// [sort] is a field name, [order] `asc` or `desc`.
  Future<FindResult> find(Map<String, dynamic> query,
          {int? skip,
          int? limit,
          String? sort,
          String order = 'asc',
          bool populate = false}) async =>
      FindResult._(Map<String, dynamic>.from(
          await client.request('POST', _p('/search'), body: {
        'query': query,
        if (skip != null) 'skip': skip,
        if (limit != null) 'limit': limit,
        if (sort != null) 'sort': {'field': sort, 'order': order},
        if (populate) 'populate': true,
      })));

  Future<Map<String, dynamic>?> findOne(
      [Map<String, dynamic> query = const {}]) async {
    final r = (await find(query, limit: 1)).results;
    return r.isEmpty ? null : r.first;
  }

  Future<int> count([Map<String, dynamic> query = const {}]) async =>
      (await find(query, limit: 1)).total;

  /// The document, or null when it doesn't exist.
  Future<Map<String, dynamic>?> get(String id) async {
    try {
      return Map<String, dynamic>.from(
          await client.request('GET', _p('/documents/${_enc(id)}')));
    } on OpenDBSException catch (e) {
      if (e.statusCode == 404) return null;
      rethrow;
    }
  }

  /// Replaces a document.
  Future<dynamic> update(String id, Map<String, dynamic> doc) =>
      client.request('PUT', _p('/documents/${_enc(id)}'), body: doc);

  /// Merges fields into a document.
  Future<dynamic> patch(String id, Map<String, dynamic> fields) =>
      client.request('PATCH', _p('/documents/${_enc(id)}'), body: fields);

  Future<dynamic> delete(String id) =>
      client.request('DELETE', _p('/documents/${_enc(id)}'));
  Future<dynamic> clear() => client.request('DELETE', _p('/clear'));

  /// Aggregation pipeline: `[{r'$match': ...}, {r'$group': ...}, {r'$sort': ...}]`.
  Future<List<dynamic>> aggregate(List<Map<String, dynamic>> pipeline) async =>
      ((await client.request('POST', _p('/aggregate'),
          body: {'pipeline': pipeline}))['results'] as List?) ??
      [];

  /// Index one field, or several (compound).
  Future<dynamic> createIndex(List<String> fields, {bool unique = false}) =>
      client.request('POST', _p('/indexes'),
          body: fields.length == 1
              ? {'field': fields.first, 'unique': unique}
              : {'fields': fields, 'unique': unique});

  Future<dynamic> dropIndex(List<String> fields) =>
      client.request('DELETE', _p('/indexes/${_enc(fields.join('+'))}'));
  Future<List<dynamic>> indexes() async =>
      ((await client.request('GET', _p('/indexes')))['details'] as List?) ?? [];

  /// `{results, count}`.
  Future<Map<String, dynamic>> fuzzySearch(String field, String query,
          {double threshold = 0.6}) async =>
      Map<String, dynamic>.from(await client.request(
          'POST', _p('/search/fuzzy'),
          body: {'field': field, 'query': query, 'threshold': threshold}));

  /// `{results, count}`.
  Future<Map<String, dynamic>> vectorSearch(String field, List<num> vector,
          {int k = 10}) async =>
      Map<String, dynamic>.from(await client.request(
          'POST', _p('/search/vector'),
          body: {'field': field, 'vector': vector, 'k': k}));
}
