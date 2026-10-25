<?php
declare(strict_types=1);

namespace OpenDBS;

/**
 * OpenDBS client for PHP 8.0+ (needs ext-curl and ext-json).
 *
 *   $client = new \OpenDBS\Client('http://localhost:4402', ['apiKey' => getenv('OPENDBS_KEY')]);
 *   $users  = $client->database('shop')->rack('users');
 *   $id     = $users->insert(['name' => 'Asha', 'age' => 31]);
 *   $page   = $users->find(['age' => ['$gte' => 18]], ['limit' => 20, 'sort' => ['field' => 'age', 'order' => 'desc']]);
 *
 * One curl handle is reused for every request (HTTP keep-alive).
 */
class OpenDBSException extends \RuntimeException
{
    public function __construct(string $message, public int $status = 0, public mixed $body = null)
    {
        parent::__construct($message, $status);
    }
}

class Client
{
    /** @var string[] cluster members to fail over between */
    private array $urls;
    private int $current = 0;
    private float $failover;
    private ?string $apiKey;
    private ?string $username;
    private ?string $password;
    private ?string $totp;
    private ?string $token = null;
    private int $timeout;
    private bool $verifyTls;
    /** @var \CurlHandle|null */
    private $curl = null;

    /**
     * @param string|string[] $url one server, or several cluster members (array or comma-separated)
     * @param array{apiKey?:string, username?:string, password?:string, totp?:string, token?:string, timeout?:int, failover?:float, ignoreSSL?:bool} $options
     *        failover: seconds to keep trying other members while one is down (default 20)
     *        ignoreSSL: accept self-signed certificates (development only)
     *        Without apiKey, username/password or token, call login($username, $password) first.
     */
    public function __construct($url, array $options = [])
    {
        $list = is_array($url) ? $url : explode(',', (string)$url);
        $this->urls = array_values(array_filter(array_map(fn ($u) => rtrim(trim((string)$u), '/'), $list)));
        if (!$this->urls) {
            throw new \InvalidArgumentException('url is required');
        }
        $this->failover = (float)($options['failover'] ?? 20);
        $this->apiKey = $options['apiKey'] ?? null;
        $this->username = $options['username'] ?? null;
        $this->password = $options['password'] ?? null;
        $this->totp = $options['totp'] ?? null;
        $this->token = $options['token'] ?? null;
        $this->timeout = (int)($options['timeout'] ?? 30);
        $this->verifyTls = empty($options['ignoreSSL']);
    }

    public function __destruct()
    {
        if ($this->curl) {
            curl_close($this->curl);
        }
    }

    /** The member requests currently go to. */
    public function url(): string
    {
        return $this->urls[$this->current];
    }

    /**
     * Sends a request, failing over to the next member while one is down or has no primary (503).
     * Writes are retried only when the connection was refused (the request never reached a server).
     * @return mixed
     */
    private function raw(string $method, string $path, mixed $body = null, bool $auth = true)
    {
        $deadline = microtime(true) + $this->failover;
        $read = $method === 'GET' || $method === 'HEAD';
        // Writes carry an idempotency key: a retry after a lost connection gets the first
        // attempt's result instead of being applied twice (server >= 0.5).
        $key = !$read && strpos($path, '/api/auth/') !== 0 ? bin2hex(random_bytes(16)) : null;
        for ($attempt = 1; ; $attempt++) {
            try {
                return $this->rawOnce($method, $path, $body, $auth, $key);
            } catch (OpenDBSException $e) {
                $refused = $e->status === 0 && $e->body === CURLE_COULDNT_CONNECT;
                $noPrimary = $e->status === 503 && !(is_array($e->body) && !empty($e->body['savedOnPrimary']));
                if (!($noPrimary || $refused || (($read || $key !== null) && $e->status === 0))) {
                    throw $e;
                }
                $this->current = ($this->current + 1) % count($this->urls);
                if (microtime(true) >= $deadline) {
                    throw $e;
                }
                if ($attempt % count($this->urls) === 0) {
                    usleep(400000);
                }
            }
        }
    }

    /** @return mixed */
    private function rawOnce(string $method, string $path, mixed $body = null, bool $auth = true, ?string $idempotencyKey = null)
    {
        if (!$this->curl) {
            $this->curl = curl_init();
        } else {
            // Clear options from the previous request; the open connection is kept for reuse.
            curl_reset($this->curl);
        }
        $headers = ['Accept: application/json'];
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        if ($auth) {
            if ($this->apiKey) {
                $headers[] = 'X-Api-Key: ' . $this->apiKey;
            } elseif ($this->token) {
                $headers[] = 'Authorization: Bearer ' . $this->token;
            }
        }
        $payload = null;
        if ($body !== null) {
            $payload = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            $headers[] = 'Content-Type: application/json';
        }
        $opts = [
            CURLOPT_URL => $this->urls[$this->current] . $path,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeout,
        ];
        if (!$this->verifyTls) {
            $opts[CURLOPT_SSL_VERIFYPEER] = false;
            $opts[CURLOPT_SSL_VERIFYHOST] = 0;
        }
        // Only requests that carry JSON get a body (an empty POSTFIELDS would make
        // curl add a form-encoded Content-Type the server rejects).
        if ($payload !== null) {
            $opts[CURLOPT_POSTFIELDS] = $payload;
        }
        curl_setopt_array($this->curl, $opts);
        $text = curl_exec($this->curl);
        if ($text === false) {
            // body carries the curl error number (lets raw() tell "refused" from "dropped mid-request")
            throw new OpenDBSException('Connection failed: ' . curl_error($this->curl), 0, curl_errno($this->curl));
        }
        $status = (int)curl_getinfo($this->curl, CURLINFO_RESPONSE_CODE);
        $data = $text === '' ? null : json_decode($text, true);
        if ($status >= 400) {
            $msg = is_array($data)
                ? (($data['error'] ?? null) === 'Forbidden' && isset($data['message']) ? $data['message'] : ($data['error'] ?? $data['message'] ?? null))
                : null;
            throw new OpenDBSException($msg ?: "HTTP $status", $status, $data);
        }
        return $data;
    }

    /**
     * Signs in with the constructor's credentials, or with the ones given here (they are kept,
     * so the client signs in again when the session expires). Returns ['token' => …, 'user' => …].
     */
    public function login(?string $username = null, ?string $password = null, ?string $totp = null): array
    {
        if ($username !== null) {
            $this->username = $username;
            $this->password = $password;
            if ($totp !== null) {
                $this->totp = $totp;
            }
        }
        if (!$this->username || !$this->password) {
            throw new \InvalidArgumentException('Give apiKey, or username and password');
        }
        $data = $this->raw('POST', '/api/auth/login', ['username' => $this->username, 'password' => $this->password], false);
        if (!empty($data['twoFactorRequired'])) {
            if (!$this->totp) {
                throw new OpenDBSException('This account uses two-factor authentication: pass totp', 401, $data);
            }
            $data = $this->raw('POST', '/api/auth/login/2fa', ['challenge' => $data['challenge'], 'code' => (string)$this->totp], false);
        }
        $this->token = $data['token'];
        return $data;
    }

    /** Use an existing session token. */
    public function setToken(string $token): void
    {
        $this->token = $token;
    }

    public function token(): ?string
    {
        return $this->token;
    }

    /** @return mixed */
    public function request(string $method, string $path, mixed $body = null)
    {
        $canLogin = !$this->apiKey && $this->username && $this->password;
        if (!$this->apiKey && !$this->token && $canLogin) {
            $this->login();
        }
        try {
            return $this->raw($method, $path, $body);
        } catch (OpenDBSException $e) {
            if ($e->status === 401 && $canLogin) {
                $this->login();
                return $this->raw($method, $path, $body);
            }
            throw $e;
        }
    }

    public function version(): array { return $this->request('GET', '/api/version'); }
    public function me(): array { return $this->request('GET', '/api/auth/me'); }
    public function listDatabases(bool $includeRacks = false): array
    {
        return $this->request('GET', '/api/databases' . ($includeRacks ? '?include_racks=true' : ''))['databases'];
    }
    public function createDatabase(string $name): array { return $this->request('POST', '/api/databases', ['name' => $name]); }
    public function dropDatabase(string $name): array { return $this->request('DELETE', '/api/databases/' . rawurlencode($name)); }
    public function database(string $name): Database { return new Database($this, $name); }

    /**
     * Atomic multi-rack transaction.
     *   $client->transaction(function (TxBuilder $tx) {
     *       $order = $tx->insert('shop', 'orders', ['total' => 40]);
     *       $tx->insert('shop', 'order_items', ['order_id' => $order, 'sku' => 'A1']);
     *   });
     * @param array|callable $opsOrFn
     */
    public function transaction($opsOrFn): array
    {
        $ops = $opsOrFn;
        if (is_callable($opsOrFn)) {
            $tx = new TxBuilder();
            $opsOrFn($tx);
            $ops = $tx->ops;
        }
        return $this->request('POST', '/api/transactions', ['operations' => $ops]);
    }

    // ── 1.0.0 API: database and rack passed as arguments ──
    // The first client took the database and rack as arguments. These methods
    // keep that code working; new code can use database() / rack().

    public function register(array $userData): array { return $this->raw('POST', '/api/auth/register', $userData, false); }
    public function deleteDatabase(string $name): array { return $this->dropDatabase($name); }
    public function listRacks(string $database): array { return $this->database($database)->listRacks(); }

    public function createRack(string $database, string $name, string $type = 'nosql', ?array $schema = null): array
    {
        $body = ['name' => $name, 'type' => $type];
        if ($schema) {
            $body['schema'] = $schema;
        }
        return $this->request('POST', '/api/databases/' . rawurlencode($database) . '/racks', $body);
    }

    public function deleteRack(string $database, string $rack): array { return $this->database($database)->dropRack($rack); }
    public function clearRack(string $database, string $rack): array { return $this->database($database)->rack($rack)->clear(); }

    /** Returns the server response (['id' => …] or ['ids' => […]]). */
    public function insert(string $database, string $rack, array $document): array
    {
        return $this->request('POST', self::rackPath($database, $rack) . '/documents', $document);
    }

    /** Equality filters as query parameters, e.g. find('shop', 'users', ['city' => 'Pune']). Returns the documents. */
    public function find(string $database, string $rack, array $query = [], bool $populate = false): array
    {
        $query = array_map(fn ($v) => is_bool($v) ? ($v ? 'true' : 'false') : $v, $query);
        if ($populate) {
            $query['populate'] = 'true';
        }
        $qs = http_build_query($query);
        return $this->request('GET', self::rackPath($database, $rack) . '/documents' . ($qs !== '' ? "?$qs" : ''))['results'] ?? [];
    }

    public function findOne(string $database, string $rack, string $id, bool $populate = false): ?array
    {
        return $this->find($database, $rack, ['id' => $id], $populate)[0] ?? null;
    }

    public function update(string $database, string $rack, string $id, array $updates): array { return $this->database($database)->rack($rack)->update($id, $updates); }
    public function delete(string $database, string $rack, string $id): array { return $this->database($database)->rack($rack)->delete($id); }

    /** Returns the statement results. */
    public function sql(string $database, string $query, ?array $params = null): array
    {
        $res = $this->database($database)->sql($query, $params);
        return $res['results'] ?? $res;
    }

    /** $queryBody = ['query' => […], 'limit' => …, 'skip' => …, 'sort' => …]. Returns the documents. */
    public function search(string $database, string $rack, array $queryBody): array
    {
        return $this->request('POST', self::rackPath($database, $rack) . '/search', $queryBody)['results'] ?? [];
    }

    public function fuzzySearch(string $database, string $rack, string $field, string $query): array
    {
        return $this->database($database)->rack($rack)->fuzzySearch($field, $query)['results'] ?? [];
    }

    public function vectorSearch(string $database, string $rack, string $field, array $vector, int $k = 5): array
    {
        return $this->database($database)->rack($rack)->vectorSearch($field, $vector, $k)['results'] ?? [];
    }

    public function createBackup(): array { return $this->request('POST', '/api/backup/create'); }
    public function listBackups(): array { return $this->request('GET', '/api/backup/list')['backups'] ?? []; }

    /** Download URL of a one-rack backup (needs the same credentials). */
    public function quickBackupRackUrl(string $database, string $rack): string
    {
        return $this->url() . '/api/backup/quick?' . http_build_query(['database' => $database, 'rack' => $rack]);
    }

    private static function rackPath(string $database, string $rack): string
    {
        return '/api/databases/' . rawurlencode($database) . '/racks/' . rawurlencode($rack);
    }
}

/**
 * The 1.0.0 class name and constructor: new OpenDBS($baseURL, $token, ['ignoreSSL' => true]).
 * Same as Client.
 */
class OpenDBS extends Client
{
    public function __construct($baseURL, ?string $token = null, array $options = [])
    {
        parent::__construct($baseURL, $token !== null ? $options + ['token' => $token] : $options);
    }
}

class TxBuilder
{
    public array $ops = [];

    private function add(array $op): string
    {
        $this->ops[] = $op;
        return '$' . (count($this->ops) - 1) . '.id';
    }

    public function insert(string $db, string $rack, array $data): string { return $this->add(['op' => 'insert', 'database' => $db, 'rack' => $rack, 'data' => $data]); }
    public function update(string $db, string $rack, string $id, array $data): string { return $this->add(['op' => 'update', 'database' => $db, 'rack' => $rack, 'id' => $id, 'data' => $data]); }
    public function patch(string $db, string $rack, string $id, array $data): string { return $this->add(['op' => 'patch', 'database' => $db, 'rack' => $rack, 'id' => $id, 'data' => $data]); }
    public function delete(string $db, string $rack, string $id): string { return $this->add(['op' => 'delete', 'database' => $db, 'rack' => $rack, 'id' => $id]); }
}

class Database
{
    public function __construct(public Client $client, public string $name) {}

    private function p(string $rest = ''): string { return '/api/databases/' . rawurlencode($this->name) . $rest; }

    public function listRacks(): array { return $this->client->request('GET', $this->p('/racks'))['racks']; }
    /** NoSQL rack (free-form JSON documents). */
    public function createRack(string $name): array { return $this->client->request('POST', $this->p('/racks'), ['name' => $name, 'type' => 'nosql']); }
    /** SQL rack: ['email' => ['type' => 'string', 'required' => true, 'unique' => true], …] */
    public function createTable(string $name, array $schema): array { return $this->client->request('POST', $this->p('/racks'), ['name' => $name, 'type' => 'sql', 'schema' => $schema]); }
    public function dropRack(string $name): array { return $this->client->request('DELETE', $this->p('/racks/' . rawurlencode($name))); }
    public function rack(string $name): Rack { return new Rack($this, $name); }
    public function table(string $name): Rack { return new Rack($this, $name); }
    /**
     * Run SQL (several ;-separated statements and BEGIN … COMMIT allowed).
     * $params fill ? / $1 placeholders and are never parsed as SQL — use them for user input.
     */
    public function sql(string $query, ?array $params = null): array
    {
        $body = ['query' => $query];
        if ($params !== null) $body['params'] = array_values($params);
        return $this->client->request('POST', '/api/sql/' . rawurlencode($this->name) . '/execute', $body);
    }
}

class Rack
{
    private Client $client;

    public function __construct(public Database $db, public string $name)
    {
        $this->client = $db->client;
    }

    private function p(string $rest = ''): string
    {
        return '/api/databases/' . rawurlencode($this->db->name) . '/racks/' . rawurlencode($this->name) . $rest;
    }

    public function insert(array $doc): string { return $this->client->request('POST', $this->p('/documents'), $doc)['id']; }
    /** All-or-nothing bulk insert. */
    public function insertMany(array $docs): array { return $this->client->request('POST', $this->p('/documents'), array_values($docs))['ids']; }
    /** @param array{skip?:int, limit?:int, sort?:array{field:string, order?:string}, populate?:bool} $options */
    public function find(array $query = [], array $options = []): array
    {
        return $this->client->request('POST', $this->p('/search'), ['query' => (object)$query] + $options);
    }
    public function findOne(array $query = []): ?array { return $this->find($query, ['limit' => 1])['results'][0] ?? null; }
    public function count(array $query = []): int { return (int)$this->find($query, ['limit' => 1])['total']; }
    public function get(string $id): ?array
    {
        try {
            return $this->client->request('GET', $this->p('/documents/' . rawurlencode($id)));
        } catch (OpenDBSException $e) {
            if ($e->status === 404) return null;
            throw $e;
        }
    }
    public function update(string $id, array $doc): array { return $this->client->request('PUT', $this->p('/documents/' . rawurlencode($id)), $doc); }
    public function patch(string $id, array $fields): array { return $this->client->request('PATCH', $this->p('/documents/' . rawurlencode($id)), $fields); }
    public function delete(string $id): array { return $this->client->request('DELETE', $this->p('/documents/' . rawurlencode($id))); }
    public function clear(): array { return $this->client->request('DELETE', $this->p('/clear')); }
    public function aggregate(array $pipeline): array { return $this->client->request('POST', $this->p('/aggregate'), ['pipeline' => $pipeline])['results']; }
    /** @param string|string[] $fields */
    public function createIndex($fields, bool $unique = false): array
    {
        $body = is_array($fields) ? ['fields' => array_values($fields), 'unique' => $unique] : ['field' => $fields, 'unique' => $unique];
        return $this->client->request('POST', $this->p('/indexes'), $body);
    }
    /** @param string|string[] $name */
    public function dropIndex($name): array
    {
        return $this->client->request('DELETE', $this->p('/indexes/' . rawurlencode(is_array($name) ? implode('+', $name) : $name)));
    }
    public function indexes(): array { return $this->client->request('GET', $this->p('/indexes'))['details']; }
    /** Returns ['results' => […], 'count' => …]. */
    public function fuzzySearch(string $field, string $query, float $threshold = 0.6): array
    {
        return $this->client->request('POST', $this->p('/search/fuzzy'), ['field' => $field, 'query' => $query, 'threshold' => $threshold]);
    }
    /** Returns ['results' => […], 'count' => …]. */
    public function vectorSearch(string $field, array $vector, int $k = 10): array
    {
        return $this->client->request('POST', $this->p('/search/vector'), ['field' => $field, 'vector' => array_values($vector), 'k' => $k]);
    }
}
