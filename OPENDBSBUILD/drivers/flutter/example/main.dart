import 'package:opendbs/opendbs.dart';

/// Run against a local server:
///   dart run example/main.dart http://localhost:4402 <API key>
Future<void> main(List<String> args) async {
  final client = OpenDBS(
    args.isNotEmpty ? args[0] : 'http://localhost:4402',
    apiKey: args.length > 1 ? args[1] : null,
  );

  try {
    await client.createDatabase('demo');
  } on OpenDBSException catch (e) {
    print('createDatabase: ${e.message}'); // e.g. it already exists
  }
  final db = client.database('demo');

  try {
    await db.createTable('books', {
      'title': {'type': 'string', 'required': true},
      'year': {'type': 'integer'},
    });
  } on OpenDBSException catch (_) {}

  final books = db.table('books');
  await books.insertMany([
    {'title': 'Dune', 'year': 1965},
    {'title': 'Neuromancer', 'year': 1984},
    {'title': 'Hyperion', 'year': 1989},
  ]);

  final page = await books.find({
    'year': {r'$gte': 1980},
  }, sort: 'year', order: 'desc');
  print('${page.total} books since 1980:');
  for (final b in page.results) {
    print('  ${b['title']} (${b['year']})');
  }

  final res =
      await db.sql('SELECT COUNT(*) AS n FROM books WHERE year < ?', [1970]);
  print('Before 1970: ${res['result'][0]['n']}');

  await client.dropDatabase('demo');
  client.close();
}
