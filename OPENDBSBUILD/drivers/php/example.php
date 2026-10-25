<?php
// php example.php http://localhost:4402 <API key>
require __DIR__ . '/vendor/autoload.php';

use OpenDBS\Client;
use OpenDBS\OpenDBSException;

$client = new Client($argv[1] ?? 'http://localhost:4402', ['apiKey' => $argv[2] ?? getenv('OPENDBS_KEY')]);

try {
    $client->createDatabase('demo');
} catch (OpenDBSException $e) {
    echo 'createDatabase: ', $e->getMessage(), "\n"; // e.g. it already exists
}
$db = $client->database('demo');
try {
    $db->createTable('books', ['title' => ['type' => 'string', 'required' => true], 'year' => ['type' => 'integer']]);
} catch (OpenDBSException $e) {
}

$books = $db->table('books');
$books->insertMany([
    ['title' => 'Dune', 'year' => 1965],
    ['title' => 'Neuromancer', 'year' => 1984],
    ['title' => 'Hyperion', 'year' => 1989],
]);

$page = $books->find(['year' => ['$gte' => 1980]], ['sort' => ['field' => 'year', 'order' => 'desc']]);
echo $page['total'], " books since 1980:\n";
foreach ($page['results'] as $b) {
    echo "  {$b['title']} ({$b['year']})\n";
}

$res = $db->sql('SELECT COUNT(*) AS n FROM books WHERE year < ?', [1970]);
echo 'Before 1970: ', $res['result'][0]['n'], "\n";

$client->dropDatabase('demo');
