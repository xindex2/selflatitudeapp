# Deployment runbook

Target: SelfLatitude's existing Linux server (Xeon E-2356G, ~60 GB RAM, 1.6 TB SSD). The app is tiny; OpenAI does the inference. Keep it separate from any WordPress/marketing installation and do not reuse old credentials.

## 1. One-time setup

```bash
# On the server
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker

git clone <selflatitude-owned-repo> /opt/selflatitude-companion
cd /opt/selflatitude-companion
cp .env.example .env
```

Edit `.env`:

```
NODE_ENV=production
APP_URL=https://companion.selflatitude.com
ENCRYPTION_KEY=<openssl rand -base64 48>
SESSION_SECRET=<openssl rand -base64 48>
OPENAI_API_KEY=<SelfLatitude's OpenAI project key>
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... MAIL_FROM="SelfLatitude Companion <no-reply@selflatitude.com>"
BOOTSTRAP_ADMIN_EMAIL=owner@selflatitude.com
BOOTSTRAP_ADMIN_PASSWORD=<temporary strong password - change after first login>
```

`ENCRYPTION_KEY` seals every stored secret: students' own OpenAI keys, SelfLatitude's platform key, the SMTP password, the JVZoo secret, and authenticator secrets. **Losing it makes all of those unreadable.** `SESSION_SECRET` keys session cookies and single-use links; changing it signs everyone out. Generate both with `openssl rand -base64 48`, keep them different, and store them in a password manager. The app refuses to start in production if either is short, low-variety, or looks like a placeholder.

### Rotating the encryption key

Do this if the key may have been exposed. Stop the app and take a backup first.

```bash
docker compose stop app
OLD_ENCRYPTION_KEY='<current key>' ENCRYPTION_KEY='<new key>' npm run rotate-key -w server
# then update ENCRYPTION_KEY in .env
docker compose up -d app
```

Run it with no `OLD_ENCRYPTION_KEY` after upgrading from an earlier release: it re-seals values that still use the original format under the current key. It is safe to run more than once.

### TLS certificate (Let's Encrypt)

```bash
mkdir -p deploy/certs
# First issue (nginx not yet running): standalone mode
sudo certbot certonly --standalone -d companion.selflatitude.com
sudo cp /etc/letsencrypt/live/companion.selflatitude.com/{fullchain,privkey}.pem deploy/certs/
sudo chown $USER deploy/certs/*.pem
```

Renewal: add a cron entry that runs `certbot renew --webroot -w <certbot-www volume>` (or standalone with a short nginx stop) and then copies the pems and runs `docker compose exec nginx nginx -s reload`. The compose file mounts `certbot-www` for webroot challenges.

Edit `deploy/nginx.conf` and replace `companion.selflatitude.com` with the real hostname.

## 2. Start / stop / update

```bash
docker compose up -d --build      # start (or rebuild after an update)
docker compose logs -f app        # follow logs (no private content is logged)
docker compose stop               # stop
docker compose down               # stop and remove containers (data volume persists)

# Update to a new release
git pull
docker compose up -d --build
```

Migrations run automatically on startup (`schema.sql` is idempotent).

First login: sign in as the bootstrap admin → Settings → change password → enable two-step verification. Then the Super Admin area unlocks.

## 2b. Connect the services (in the admin area, after first sign-in)

1. **OpenAI connection** - paste SelfLatitude's OpenAI Platform key. Nothing in the Companion works without it.
2. **Email** - SMTP host, port, username, password and From address, then use **Send a test email**. Password resets, sign-in codes and welcome emails all depend on this.
3. **Plans** - check the seeded plans ($497 Foundations + first year, $297 annual renewal) and adjust prices, duration and included usage.
4. **JVZoo & payments** - copy the IPN URL shown on that page (`https://<your-domain>/api/webhooks/jvzoo`) into the JVZoo product's *JVZoo IPN URL* field, paste your JVZoo secret key into the admin page, map each JVZoo product code (`cproditem`) to a plan, then turn the integration on. Make a real test purchase (or use JVZoo's test tools) and confirm the sale appears in the payments log with "Account created and plan applied".
5. **Sign-in policy** - public sign-up is off by default. Leave it off if every account should come from a purchase.

Notes:
- The IPN endpoint must be reachable over HTTPS from the public internet; it is unauthenticated by design and verified with JVZoo's signature.
- The app always answers `200 ok` to JVZoo so it does not retry forever. Failures are recorded in the payments log with the reason.
- A notification is applied once per receipt and transaction type. If you need to re-run one, use **Clear for replay** on that row and resend it from JVZoo.
- Map every product you sell, including upsells and downsells, to a plan. An unmapped sale falls back to the plan marked as default, which may grant the wrong amount of access.
- Refunds reverse the specific purchase, so map product codes correctly before you go live: the plan attached to a sale is what a later refund takes back.

## 2c. Security notes for this deployment

- The app must sit behind the reverse proxy. It trusts `X-Forwarded-For` for rate limiting, so it should not be reachable directly from the internet; the compose file only exposes it to nginx.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production, so they require HTTPS. State-changing requests carrying another site's `Origin` are refused: the allowed set is `APP_URL` plus anything in `ALLOWED_ORIGINS`. If the site answers on both the apex and `www`, list the other one there, or sign-ins from it will be blocked with `bad_origin`.
- Sign-in attempts are limited both per address and per account. Ten failures against one account block further attempts on it for fifteen minutes.
- Changing a password signs every other device out and invalidates outstanding reset and one-time links.
- Two-step verification is enforced on every endpoint, and cannot be changed or removed from a session that has not passed the current factor. The "require two-step for administrators" setting cannot be turned off on a live site; the server refuses the change.
- Backups contain sealed secrets, not plaintext ones, but they still contain private journals and conversations. Keep `BACKUP_PASSPHRASE` somewhere other than the server. Backup files are written owner-readable with a checksum beside them, and a restore refuses an altered archive or a wrong passphrase.
- `APP_URL` starting with `https://` is treated as a real deployment even if `NODE_ENV` is missed, so the development key fallbacks and console email printing can never apply to a live instance.
- The payment webhook is the only unauthenticated endpoint. Its signature is 32 bits, which is JVZoo's design and cannot be changed, so the app caps signature failures at 50 an hour across all callers and stops recording attempts beyond that. Restrict the endpoint to JVZoo's published source addresses at nginx as well:

```nginx
location = /api/webhooks/jvzoo {
    # allow <jvzoo ip>;   # add each address JVZoo publishes
    # deny all;
    proxy_pass http://companion_app;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
```

- A payment never lifts a suspension. If a suspended student buys again, the sale is recorded and their dates are updated, but an administrator must reactivate the account deliberately.

## 3. Backups

Data lives in the `companion-data` Docker volume: `/data/db/companion.db` (SQLite, WAL) and `/data/uploads` (course files).

```bash
export BACKUP_PASSPHRASE='<long passphrase from the password manager>'
./scripts/backup.sh /var/backups/companion
```

Schedule nightly via cron and copy off-server, e.g. with rclone to object storage:

```
15 3 * * * cd /opt/selflatitude-companion && BACKUP_PASSPHRASE=... ./scripts/backup.sh /var/backups/companion && rclone copy /var/backups/companion remote:selflatitude-companion-backups
```

Backups are AES-256 encrypted archives. Test a restore on staging **before launch** and quarterly:

```bash
BACKUP_PASSPHRASE=... ./scripts/restore.sh /var/backups/companion/companion-<stamp>.tar.gz.enc
```

Deleted records do not come back from an *older* backup unless you restore that backup; if you must restore after a user deletion, re-apply the deletion (Privacy requests list shows open deletion requests).

## 4. Staging

Run a second copy on the same server with a different `.env` (`APP_URL`, port mapping, separate volume name) or on a separate host. Never point staging at the production database volume. Use a separate OpenAI project key for staging.

## 5. Bare-metal alternative (no Docker)

```bash
npm ci && npm run build
NODE_ENV=production node server/dist/index.js     # behind pm2 or a systemd unit, port 4000
```

Use `deploy/nginx-bare-metal.conf`, which serves `client/dist` directly and proxies `/api`. Set `DB_PATH` and `UPLOAD_DIR` to a durable location outside the repo.

## 6. Ownership checklist

SelfLatitude must own: the git repository, domain/DNS, server and SSH keys, the OpenAI project and billing, the SMTP account, the backup destination, and all Super Admin credentials (each admin with their own account + MFA; no shared logins).

## 7. Third-party services and expected cost

| Service | Purpose | Cost |
|---|---|---|
| OpenAI API | Replies + embeddings | Usage-based. At the default gpt-4.1-mini pricing a typical reply costs well under $0.01; the $5/member/month ceiling is enforced by the app. Embeddings for indexing course files are negligible. |
| SMTP (e.g. Postmark, SES) | Password resets, one-time links | Free tier to a few $/month |
| Let's Encrypt | TLS | Free |
| Object storage for backups | Off-server backups | ~$1/month |
