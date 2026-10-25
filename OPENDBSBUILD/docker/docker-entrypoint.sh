#!/bin/sh
# Prepares /data on the first start, then runs the server.
#
# Everything that must survive a container upgrade lives in the volume:
#   /data/db           databases            (DB_PATH)
#   /data/backups      backups              (BACKUP_PATH)
#   /data/jwt_secret   session-signing key  (only when JWT_SECRET is not set)
#   /data/opendbs.key  data-encryption key  (only when DB_ENCRYPTION_KEY[_FILE] is not set)
set -e

DATA="${OPENDBS_DATA:-/data}"

if ! touch "$DATA/.write-test" 2>/dev/null; then
    echo "OpenDBS: $DATA is not writable by uid $(id -u). For a bind mount run:" >&2
    echo "  chown -R $(id -u):$(id -g) <host folder>   (or start the container with --user)" >&2
    exit 1
fi
rm -f "$DATA/.write-test"
mkdir -p "${DB_PATH:-$DATA/db}" "${BACKUP_PATH:-$DATA/backups}"

umask 077
random_hex() {
    node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"
}

if [ -z "$JWT_SECRET" ]; then
    [ -s "$DATA/jwt_secret" ] || random_hex 48 > "$DATA/jwt_secret"
    JWT_SECRET="$(cat "$DATA/jwt_secret")"
    export JWT_SECRET
fi

if [ -z "$DB_ENCRYPTION_KEY" ] && [ -z "$DB_ENCRYPTION_KEY_FILE" ] && [ "$ENCRYPTION_AT_REST" != "false" ]; then
    if [ ! -s "$DATA/opendbs.key" ]; then
        random_hex 32 > "$DATA/opendbs.key"
        echo "OpenDBS: generated the data-encryption key $DATA/opendbs.key. Back it up:" >&2
        echo "  without it the data and the backups cannot be read." >&2
    fi
    DB_ENCRYPTION_KEY_FILE="$DATA/opendbs.key"
    export DB_ENCRYPTION_KEY_FILE
fi

exec "$@"
