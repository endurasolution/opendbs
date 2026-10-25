#!/bin/bash
# Runs bench.js against each database, alone, in a fresh container and volume per run.
#   bash run.sh [runs] [database...]       e.g.  bash run.sh 3   |   bash run.sh 1 opendbs postgres
#   ROWS=100000 OPENDBS_IMAGE=endurasolution/opendbs:1.0.1 bash run.sh 3
# Results are appended to results.jsonl; node summarize.js prints the medians.
export MSYS_NO_PATHCONV=1
B="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
RUNS=${1:-3}; shift
DBS=${@:-opendbs postgres mysql mongo sqlite}
LIMITS="--cpus 4 --memory 4g"
OUT="$B/results.jsonl"
OPENDBS_IMAGE=${OPENDBS_IMAGE:-endurasolution/opendbs:1.0.1}
docker network create benchnet >/dev/null 2>&1
# Database drivers, installed for Linux inside a container
[ -d "$B/node_modules" ] || docker run --rm -v "$B":/bench -w /bench node:22-bookworm npm install --no-audit --no-fund

wait_for() { for i in $(seq 1 120); do eval "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timeout waiting: $1" >&2; return 1; }

start_server() {
  case $1 in
    postgres) docker run -d --name postgres --network benchnet $LIMITS -v bench_pg:/var/lib/postgresql/data \
                -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench postgres:16-bookworm \
                -c shared_buffers=1GB -c max_connections=100 >/dev/null
              wait_for "docker exec postgres psql -U bench -h 127.0.0.1 -d bench -c 'SELECT 1'" ;;
    mysql)    docker run -d --name mysql --network benchnet $LIMITS -v bench_my:/var/lib/mysql \
                -e MYSQL_ROOT_PASSWORD=bench -e MYSQL_DATABASE=bench mysql:8.4 --innodb-buffer-pool-size=1G >/dev/null
              wait_for "docker exec mysql mysql -uroot -pbench -h127.0.0.1 -e 'SELECT 1' bench" ;;
    mongo)    docker run -d --name mongo --network benchnet $LIMITS -v bench_mongo:/data/db mongo:7.0 --wiredTigerCacheSizeGB 1 >/dev/null
              wait_for "docker exec mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok'" ;;
    opendbs)  docker run -d --name opendbs --network benchnet $LIMITS -v bench_odbs:/data \
                -e ADMIN_PASSWORD=Bench-Pass-2026! -e CACHE_SIZE_MB=1024 -e RATE_LIMIT_MAX=100000000 \
                "$OPENDBS_IMAGE" >/dev/null
              wait_for "docker exec opendbs node -e \"fetch('http://127.0.0.1:4402/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\"" ;;
    sqlite)   : ;;
  esac
}

stop_server() {
  docker rm -f postgres mysql mongo opendbs >/dev/null 2>&1
  docker volume rm bench_pg bench_my bench_mongo bench_odbs bench_sqlite >/dev/null 2>&1
}

for run in $(seq 1 "$RUNS"); do
  for db in $DBS; do
    stop_server
    start_server "$db" || { echo "$db failed to start"; continue; }
    sleep 3
    line=$(docker run --rm --name benchclient --network benchnet $LIMITS -v "$B/..":/odbs -w /odbs/benchmarks -v bench_sqlite:/data \
             -e ROWS=${ROWS:-100000} -e OPENDBS_PASSWORD='Bench-Pass-2026!' node:22-bookworm node bench.js "$db" 2>&1 | tee /dev/stderr | grep '^RESULT ' | sed 's/^RESULT //')
    [ -n "$line" ] && echo "{\"run\":$run,\"key\":\"$db\",\"r\":$line}" >> "$OUT"
    echo "== run $run $db done"
  done
done
stop_server
