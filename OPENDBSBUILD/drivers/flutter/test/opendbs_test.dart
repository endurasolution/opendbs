// Integration tests against a running OpenDBS server. Skipped unless
// OPENDBS_URL is set:
//   OPENDBS_URL=http://localhost:4402 OPENDBS_KEY=<admin API key> \
//   OPENDBS_ADMIN_PASSWORD=<admin password> dart test
import 'dart:io';

import 'package:opendbs/opendbs.dart';
import 'package:test/test.dart';

void main() {
  final env = Platform.environment;
  final url = env['OPENDBS_URL'];
  final key = env['OPENDBS_KEY'];
  final adminPassword = env['OPENDBS_ADMIN_PASSWORD'];
  final skip = url == null || key == null || adminPassword == null
      ? 'set OPENDBS_URL, OPENDBS_KEY and OPENDBS_ADMIN_PASSWORD'
      : null;

  group('rack API', () {
    late OpenDBS c;
    const dbName = 'drv_dart';
    setUpAll(() async {
      c = OpenDBS(url!, apiKey: key);
      try {
        await c.dropDatabase(dbName);
      } on OpenDBSException catch (_) {}
      await c.createDatabase(dbName);
    });
    tearDownAll(() async {
      await c.dropDatabase(dbName);
      c.close();
    });

    test('documents, SQL, aggregation, transactions', () async {
      expect(
          (await c.version())['version'], matches(RegExp(r'^\d+\.\d+\.\d+$')));
      final db = c.database(dbName);
      await db.createTable('people', {
        'name': {'type': 'string', 'required': true},
        'age': {'type': 'integer'},
        'email': {'type': 'string', 'unique': true},
      });
      await db.createRack('events');
      final people = db.table('people');
      final id =
          await people.insert({'name': 'Asha', 'age': 31, 'email': 'a@x.io'});
      final ids = await people.insertMany([
        {'name': 'Ravi', 'age': 45, 'email': 'r@x.io'},
        {'name': 'Zed', 'age': 19, 'email': 'z@x.io'},
      ]);
      expect(ids, hasLength(2));
      final page = await people.find({
        'age': {r'$gte': 20}
      }, sort: 'age', order: 'desc');
      expect(page.total, 2);
      expect(page.results.first['name'], 'Ravi');
      expect((await people.get(id))!['email'], 'a@x.io');
      expect(await people.get('999999'), isNull);
      await people.patch(id, {'age': 32});
      expect((await people.findOne({'name': 'Asha'}))!['age'], 32);
      expect(await people.count(), 3);
      await expectLater(
          people.insert({'name': 'Dup', 'email': 'a@x.io'}),
          throwsA(isA<OpenDBSException>()
              .having((e) => e.statusCode, 'statusCode', 400)));
      await people.createIndex(['name', 'age']);
      expect((await people.indexes()).any((i) => i['field'] == 'name+age'),
          isTrue);

      final events = db.rack('events');
      await events.insertMany([
        {'who': id, 'amount': 10},
        {'who': id, 'amount': 15},
        {'who': ids[0], 'amount': 7},
      ]);
      final agg = await events.aggregate([
        {
          r'$group': {
            '_id': r'$who',
            'total': {r'$sum': r'$amount'}
          }
        },
        {
          r'$sort': {'total': -1}
        },
      ]);
      expect(agg.first, {'_id': id, 'total': 25});

      final tx = await c.transaction((t) {
        final p = t.insert(
            dbName, 'people', {'name': 'Tx', 'age': 50, 'email': 't@x.io'});
        t.insert(dbName, 'events', {'who': p, 'amount': 99});
      });
      expect(tx['committed'], isTrue);
      await expectLater(c.transaction((t) {
        t.insert(dbName, 'people', {'name': 'Bad1', 'email': 'b@x.io'});
        t.insert(dbName, 'people', {'name': 'Bad2', 'email': 'b@x.io'});
      }), throwsA(isA<OpenDBSException>()));
      expect(await people.count({'email': 'b@x.io'}), 0);

      final sql = await db.sql(
          'SELECT p.name, SUM(e.amount) AS spent FROM people p JOIN events e ON e.who = p.id '
          'WHERE e.amount > ? GROUP BY p.name ORDER BY spent DESC',
          [5]);
      expect(sql['result'][0]['name'], 'Tx');
      expect(sql['result'][0]['spent'], 99);

      await people.delete(ids[1]);
      expect(await people.get(ids[1]), isNull);
      await events.clear();
      expect(await events.count(), 0);
    });

    test('fails over to the next member', () async {
      // First URL refuses connections; reads and keyed writes move on.
      final f = OpenDBS('http://127.0.0.1:1,$url', apiKey: key);
      expect(await f.listDatabases(), contains(dbName));
      final id = await f.database(dbName).rack('events').insert({'n': 1});
      expect(id, isNotEmpty);
      f.close();
    });
  }, skip: skip);

  group('1.0.0 API', () {
    const dbName = 'drv_dart_v1';
    test('login, racks, documents, SQL, search', () async {
      final c = OpenDBS(url!);
      final login = await c.login('admin', adminPassword!);
      expect(login['token'], isA<String>());
      expect(login['user']['username'], 'admin');
      try {
        await c.deleteDatabase(dbName);
      } on OpenDBSException catch (_) {}
      expect((await c.createDatabase(dbName))['database'], dbName);
      await c.createRack(dbName, 'users', type: 'nosql');
      await c.createRack(dbName, 'orders', type: 'sql', schema: {
        'order_no': {'type': 'number', 'required': true},
        'total': {'type': 'number'},
      });
      expect((await c.listRacks(dbName)).map((r) => r['name']).toSet(),
          {'users', 'orders'});
      final ins = await c.insert(
          dbName, 'users', {'name': 'Dart Vader', 'city': 'Pune', 'age': 40});
      expect(ins['id'], isNotNull);
      await c
          .insert(dbName, 'users', {'name': 'Ada', 'city': 'Goa', 'age': 36});
      await c.sql(
          dbName, 'INSERT INTO orders (order_no, total) VALUES (999, 123.45)');
      final rows =
          await c.sql(dbName, 'SELECT total FROM orders WHERE order_no = 999');
      expect(rows, isA<List>());
      expect(rows.first['result'][0]['total'], 123.45);
      expect((await c.find(dbName, 'users')).length, 2);
      expect(
          (await c.find(dbName, 'users', query: {'city': 'Pune'}))
              .single['name'],
          'Dart Vader');
      final found = await c.search(dbName, 'users', {
        'query': {
          'age': {r'$gt': 38}
        }
      });
      expect(found.single['name'], 'Dart Vader');
      final fuzzy = await c.fuzzySearch(dbName, 'users', 'name', 'Dart Vadr');
      expect(fuzzy, isNotEmpty);
      final dbs = await c.listDatabases(includeRacks: true);
      expect(dbs.map((d) => d is Map ? d['name'] : d), contains(dbName));
      await c.deleteRack(dbName, 'orders');
      await c.deleteDatabase(dbName);
      c.close();
    });

    test('username and password in the constructor sign in automatically',
        () async {
      final c = OpenDBS(url!, username: 'admin', password: adminPassword);
      expect(await c.listDatabases(), isA<List>());
      expect(c.token, isNotNull);
      final t = OpenDBS(url, token: c.token);
      expect((await t.me())['user'] ?? (await t.me()), isNotNull);
      c.close();
      t.close();
    });

    test('no credentials: the server answers 401', () async {
      final c = OpenDBS(url!);
      await expectLater(
          c.listDatabases(),
          throwsA(isA<OpenDBSException>()
              .having((e) => e.statusCode, 'statusCode', 401)));
      c.close();
    });
  }, skip: skip);
}
