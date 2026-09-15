#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh.
# Usage: ./scripts/restore.sh backups/companion-2026....tar.gz.enc
# Stops the app, replaces the database and uploads, starts the app.
# Test this on staging before you need it in production.
set -euo pipefail
umask 077

FILE="${1:?backup file required}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Whichever digest tool this machine has.
if command -v shasum >/dev/null 2>&1; then SHA_CHECK="shasum -a 256 -c"
elif command -v sha256sum >/dev/null 2>&1; then SHA_CHECK="sha256sum -c"
else SHA_CHECK=""; fi

if [[ "$FILE" == *.enc ]]; then
  : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE required to decrypt}"
  # Verify the archive has not been altered before trusting its contents.
  if [ -f "$FILE.sha256" ] && [ -n "$SHA_CHECK" ]; then
    DIR="$(dirname "$FILE")"
    (cd "$DIR" && $SHA_CHECK "$(basename "$FILE").sha256" >/dev/null) \
      || { echo "Checksum does not match: this backup has been altered or is damaged. Refusing to restore."; exit 1; }
    echo "Checksum verified."
  else
    echo "No checksum available for this backup, so its integrity cannot be verified. Continuing."
  fi
  # Backups may have been written with any of these key derivations; try each in turn.
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$FILE" -out "$TMP/backup.tar.gz" 2>/dev/null \
    || openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$FILE" -out "$TMP/backup.tar.gz" 2>/dev/null \
    || openssl enc -d -aes-256-cbc -pass env:BACKUP_PASSPHRASE -in "$FILE" -out "$TMP/backup.tar.gz" \
    || { echo "Could not decrypt: check BACKUP_PASSPHRASE."; exit 1; }
else
  cp "$FILE" "$TMP/backup.tar.gz"
fi

# A wrong passphrase decrypts to noise rather than failing, so check the result really is
# an archive before touching the live data.
gzip -t "$TMP/backup.tar.gz" 2>/dev/null \
  || { echo "This does not decrypt to a valid backup. Check BACKUP_PASSPHRASE."; exit 1; }

tar -C "$TMP" -xzf "$TMP/backup.tar.gz"

if docker compose ps app >/dev/null 2>&1; then
  docker compose stop app
  docker compose run --rm --no-deps -T app sh -c 'rm -f /data/db/companion.db /data/db/companion.db-wal /data/db/companion.db-shm && rm -rf /data/uploads && mkdir -p /data/db /data/uploads'
  docker compose cp "$TMP/companion.db" app:/data/db/companion.db
  docker compose cp "$TMP/uploads/." app:/data/uploads
  docker compose start app
else
  DB_PATH="${DB_PATH:-server/data/companion.db}"
  UPLOAD_DIR="${UPLOAD_DIR:-server/uploads}"
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
  cp "$TMP/companion.db" "$DB_PATH"
  rm -rf "$UPLOAD_DIR" && cp -R "$TMP/uploads" "$UPLOAD_DIR"
fi
echo "Restore complete."
