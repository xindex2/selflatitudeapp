#!/usr/bin/env bash
# Encrypted backup of the SQLite database + uploaded course files.
# Usage: ./scripts/backup.sh /path/to/backup/dir
# Requires: docker compose (production) or a local checkout (development), openssl.
# Set BACKUP_PASSPHRASE in the environment (never commit it). Copy the resulting
# .tar.gz.enc OFF the server (rclone / scp / object storage) - see docs/DEPLOY.md.
set -euo pipefail
umask 077   # backups contain private journals and conversations: owner-readable only

DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"

if docker compose ps app >/dev/null 2>&1 && docker compose ps app | grep -q running; then
  # Production: consistent snapshot via sqlite backup API inside the container
  docker compose exec -T app node -e "
    const D=require('better-sqlite3'); const db=new D(process.env.DB_PATH,{readonly:true});
    db.backup('/data/backup.db').then(()=>{console.log('snapshot ok')})"
  docker compose cp app:/data/backup.db "$TMP/companion.db"
  docker compose exec -T app rm -f /data/backup.db
  docker compose cp app:/data/uploads "$TMP/uploads"
else
  # Development / bare metal
  DB_PATH="${DB_PATH:-server/data/companion.db}"
  UPLOAD_DIR="${UPLOAD_DIR:-server/uploads}"
  sqlite3 "$DB_PATH" ".backup '$TMP/companion.db'"
  cp -R "$UPLOAD_DIR" "$TMP/uploads"
fi

# Older openssl builds (notably the LibreSSL that ships with macOS) lack -iter and even
# -pbkdf2. Pick the strongest key derivation this machine actually supports.
enc_args() {
  if : | openssl enc -aes-256-cbc -pbkdf2 -iter 2 -pass pass:probe -out /dev/null 2>/dev/null; then
    echo "-pbkdf2 -iter 600000"
  elif : | openssl enc -aes-256-cbc -pbkdf2 -pass pass:probe -out /dev/null 2>/dev/null; then
    echo "-pbkdf2"
  else
    echo ""
  fi
}

tar -C "$TMP" -czf "$TMP/backup.tar.gz" companion.db uploads
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  OUT="$DEST/companion-$STAMP.tar.gz.enc"
  KDF="$(enc_args)"
  if [ -z "$KDF" ]; then
    echo "WARNING: this openssl is too old for PBKDF2 key derivation, so the passphrase is only"
    echo "         lightly stretched. Take production backups on the server, not from macOS."
  elif [ "$KDF" = "-pbkdf2" ]; then
    echo "NOTE: this openssl does not support -iter, so the default iteration count is used."
  fi
  # shellcheck disable=SC2086
  openssl enc -aes-256-cbc $KDF -salt -pass env:BACKUP_PASSPHRASE \
    -in "$TMP/backup.tar.gz" -out "$OUT"
  # CBC gives no integrity check of its own, so record a digest to verify before restoring.
  if command -v shasum >/dev/null 2>&1; then SHA_SUM="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then SHA_SUM="sha256sum"
  else SHA_SUM=""; fi
  if [ -n "$SHA_SUM" ]; then
    (cd "$DEST" && $SHA_SUM "$(basename "$OUT")" > "$(basename "$OUT").sha256")
    chmod 600 "$OUT.sha256"
  fi
  chmod 600 "$OUT"
  echo "Encrypted backup written: $OUT"
else
  cp "$TMP/backup.tar.gz" "$DEST/companion-$STAMP.tar.gz"
  chmod 600 "$DEST/companion-$STAMP.tar.gz"
  echo "WARNING: BACKUP_PASSPHRASE not set - backup is NOT encrypted: $DEST/companion-$STAMP.tar.gz"
  echo "         It contains private journals and conversations. Set BACKUP_PASSPHRASE and run again."
fi

# Keep the last 30 backups locally
ls -1t "$DEST"/companion-*.tar.gz* 2>/dev/null | tail -n +31 | xargs -r rm -f
