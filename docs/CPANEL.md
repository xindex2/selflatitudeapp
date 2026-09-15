# Installing on cPanel

This is a **Node.js** application, not a PHP one. Softaculous, WordPress Manager and MultiPHP play
no part in installing it. It needs a Node process running continuously, and it keeps its data in a
SQLite file rather than MySQL.

That single fact decides everything below, so start here.

---

## Step 0. Find out which path applies to your account

Sign in to cPanel and look at the **Software** section.

| What you see | Path to follow |
|---|---|
| **Setup Node.js App** is listed | [Path A](#path-a--setup-nodejs-app-recommended). This is the clean route. |
| It is **not** listed | Ask your host to enable it (below). If they will not, try [Path B](#path-b--ssh-with-a-cron-keepalive). |

> On the account this was written for (`appselflatitude` / `selflatitude.app`, cPanel 110), **Setup
> Node.js App is not present**. Its Software section shows only WordPress Manager, PHP PEAR
> Packages, Perl Modules, RubyGems, Site Software, Optimize Website, MultiPHP Manager, MultiPHP INI
> Editor and Softaculous. Path A will not work until the host turns Node.js support on.

### Asking the host to enable it

Send them this:

> Please enable the **CloudLinux Node.js Selector** (it appears in cPanel as *Setup Node.js App*
> under Software) for the account `appselflatitude`, with Node.js 20 or 22 available. We are
> deploying a Node.js application on `selflatitude.app`.

Most cPanel hosts running CloudLinux can switch this on per account in a few minutes. It is the
difference between a ten-minute install and a fragile workaround, so it is worth asking before
anything else.

### If the answer is no

Be aware of what Path B costs you, and consider the alternative honestly:

- The app is kept alive by a cron job rather than a supervisor, so a crash means up to five minutes
  of downtime.
- Streaming replies may arrive all at once instead of word by word, depending on how the host's
  Apache is configured.
- Many shared hosts forbid long-running processes in their terms of service, and some kill them
  automatically.

The build brief specifies a dedicated server (Xeon E-2356G, ~60 GB RAM). If that machine is
available, deploy there with [docs/DEPLOY.md](DEPLOY.md) instead — it is a better home for this app
than shared hosting, and takes about the same effort. A small VPS (any provider, 1 GB RAM is plenty)
works just as well.

---

## What you need either way

- **Node.js 20 or newer** on the server.
- **SSH access that actually connects** (cPanel → Security → SSH Access). There is no way around
  this: the client has to be compiled once. See [Setting up SSH](#setting-up-ssh) — on many shared
  plans SSH is firewalled until you ask the host to open it.
- A domain or subdomain pointed at the account, with SSL issued (cPanel → Security → SSL/TLS, or
  AutoSSL). The app requires HTTPS in production.
- An **OpenAI Platform API key**, and SMTP credentials for outgoing email. Both are entered in the
  app's admin area after installation, not in a file.

Decide where things live before you start:

| Thing | Location | Why |
|---|---|---|
| Application code | `/home/appselflatitude/selflatitudeapp` | **Outside `public_html`.** |
| Database and uploads | `/home/appselflatitude/companion-data` | Outside `public_html`, so the SQLite file with everyone's journals can never be downloaded over the web. |
| Public URL | `https://selflatitude.app` | Served through the proxy, not from files on disk. |

> Never put the application or its `data` folder inside `public_html`. If you do, anyone can
> download `companion.db` — every conversation, journal entry and encrypted key in one file.

---

## Setting up SSH

cPanel's **Security → SSH Access** page only manages *keys*. Whether the SSH port is reachable at
all is a separate setting that many shared hosts keep closed until you ask.

### 1. Check whether SSH is even reachable

Before doing any key work, run this on your own machine:

```bash
nc -z -G 5 selflatitude.app 22 && echo "open" || echo "blocked"
```

- **open** — carry on to step 2.
- **blocked** — the port is firewalled. No amount of key configuration will help; you have to ask the
  host (see [If SSH is blocked](#if-ssh-is-blocked)). Some hosts use a non-standard port such as
  2222, so it is worth asking which port rather than assuming it is off.

### 2. Create a key on your own machine

Generate the key locally so the private half never leaves your computer:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_selflatitude -C "appselflatitude@selflatitude.app"
cat ~/.ssh/id_ed25519_selflatitude.pub
```

### 3. Authorise it in cPanel

cPanel → **Security → SSH Access → Manage SSH Keys → Import Key**:

- Leave the private key box empty.
- Paste the **public** key (the `ssh-ed25519 AAAA…` line) into the public key box.
- Give it a name, then **Import**.

Then — and this is the step people miss — click **Manage** next to the imported key and press
**Authorize**. An imported key that has not been authorised will not let you in.

### 4. Connect

Add this to `~/.ssh/config` on your machine:

```
Host selflatitude
    HostName selflatitude.app
    User appselflatitude
    Port 22
    IdentityFile ~/.ssh/id_ed25519_selflatitude
    IdentitiesOnly yes
```

Then `ssh selflatitude`. If it hangs, the port is filtered. If it says "Permission denied
(publickey)", the key is not authorised — go back to step 3.

### If SSH is blocked

You cannot install this application without either *Setup Node.js App* or a working shell. Both come
from the same place: your host. Open one support ticket and ask for the better option first:

> Hello,
>
> For the account **appselflatitude** (`selflatitude.app`) I need to run a Node.js application.
>
> 1. Please enable the **CloudLinux Node.js Selector** — it appears in cPanel as *Setup Node.js App*
>    under Software — with Node.js 20 or 22 available. This is my preferred option.
> 2. If that is not possible on this plan, please enable **SSH access** for the account and tell me
>    which port and hostname to use, and whether `mod_proxy` and `mod_proxy_http` are available for
>    `.htaccess` rules.
>
> Could you also confirm whether long-running background processes are permitted on this plan?
>
> Thank you.

The answer to that last question matters. If long-running processes are not allowed, this app cannot
live on the plan at all, no matter which option they enable, and the right move is the dedicated
server in the build brief or a small VPS with [docs/DEPLOY.md](DEPLOY.md).

### Finding out what is on the server without a shell

While you wait, cPanel's **Advanced → Cron Jobs** can run a one-off command, which is enough to learn
what you are dealing with. Add a cron job set to run once in a few minutes:

```
cd ~ && { echo "--- $(date)"; uname -a; echo "node: $(command -v node || echo none) $(node -v 2>/dev/null)"; echo "npm: $(command -v npm || echo none)"; echo "git: $(command -v git || echo none)"; echo "gcc: $(command -v gcc || echo none)"; free -m 2>/dev/null | head -2; } > ~/probe.txt 2>&1
```

Then read `probe.txt` in **File Manager** (it will be in your home directory, above `public_html`).
Delete the cron job afterwards. That tells you whether Node, npm, git and a compiler are present
before you commit to a path.

---

## Path A — Setup Node.js App (recommended)

> If *Setup Node.js App* is missing from your Software section, this path is not available yet.
> See [If SSH is blocked](#if-ssh-is-blocked) for the message to send your host. Note that **Site
> Software** is an unrelated legacy feature for PHP scripts — "Contact your host to install the Site
> Software packages" is not about Node.js.

### 1. Get the code onto the server

cPanel → **Files → Git™ Version Control** → *Create*:

- **Clone URL**: `https://github.com/xindex2/selflatitudeapp.git`
- **Repository Path**: `/home/appselflatitude/selflatitudeapp`
- **Repository Name**: `selflatitudeapp`

If the repository is private, create a GitHub personal access token with `repo` scope and use
`https://<token>@github.com/xindex2/selflatitudeapp.git` as the clone URL.

### 2. Create the application

cPanel → **Software → Setup Node.js App** → *Create Application*:

| Field | Value |
|---|---|
| Node.js version | 20 or 22 |
| Application mode | Production |
| Application root | `selflatitudeapp` |
| Application URL | `selflatitude.app` |
| Application startup file | `app.js` |

Click **Create**. cPanel builds a virtual environment and shows a command near the top of the page
that looks like this — **copy it**, you need it in the next step:

```
source /home/appselflatitude/nodevenv/selflatitudeapp/22/bin/activate && cd /home/appselflatitude/selflatitudeapp
```

### 3. Add the environment variables

Still on the Setup Node.js App page, use **Add Variable** for each of these. Generate the two
secrets first — in SSH, run `openssl rand -base64 48` twice and use a different result for each.

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://selflatitude.app` |
| `DB_PATH` | `/home/appselflatitude/companion-data/companion.db` |
| `UPLOAD_DIR` | `/home/appselflatitude/companion-data/uploads` |
| `ENCRYPTION_KEY` | first `openssl rand -base64 48` result |
| `SESSION_SECRET` | second `openssl rand -base64 48` result |
| `BOOTSTRAP_ADMIN_EMAIL` | your email address |
| `BOOTSTRAP_ADMIN_PASSWORD` | a strong temporary password you will change at first sign-in |

Leave `PORT` alone — Passenger sets it.

> `ENCRYPTION_KEY` protects every stored secret: students' own OpenAI keys, your platform key, the
> SMTP password, the JVZoo secret, authenticator secrets. **Save both values in a password manager
> now.** Losing `ENCRYPTION_KEY` makes all of those permanently unreadable. The app refuses to start
> if either is short or looks like a placeholder.

### 4. Install and build

SSH in and run the command you copied in step 2, then:

```bash
mkdir -p /home/appselflatitude/companion-data/uploads

npm ci
npm run build
```

`npm run build` compiles the API to `server/dist` and the React client to `client/dist`. It takes a
couple of minutes. `npm ci` compiles `better-sqlite3`, which needs a compiler — if it fails with a
`node-gyp` error, see [Troubleshooting](#troubleshooting).

### 5. Start it

Back in cPanel → Setup Node.js App, click **Restart**. Open `https://selflatitude.app` — you should
see the sign-in page.

Now go to [First run](#first-run).

---

## Path B — SSH with a cron keepalive

Use this only when the host will not enable Node.js support. It needs a working shell first — see
[Setting up SSH](#setting-up-ssh). Check also that a proxy is possible, because the whole approach
depends on it.

### 1. Check that Apache will proxy to a local port

Create `public_html/.htaccess` containing:

```apache
RewriteEngine On
RewriteRule ^proxytest$ http://127.0.0.1:5111/api/health [P,L]
```

Then in SSH:

```bash
# something to answer the test
python3 -m http.server 5111 &
curl -I https://selflatitude.app/proxytest
kill %1
```

- A `200` or `404` from the little Python server: proxying works, carry on.
- A **500** or a message about `[P]` not being allowed: `mod_proxy` is off for your account.
  **Stop here** — ask the host to enable `mod_proxy` and `mod_proxy_http`, or use a VPS.

### 2. Install Node if it is missing

```bash
node -v    # want v20 or newer
```

If it is missing or too old:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22
node -v
```

### 3. Clone, configure, build

```bash
cd ~
git clone https://github.com/xindex2/selflatitudeapp.git selflatitudeapp
cd selflatitudeapp
mkdir -p /home/appselflatitude/companion-data/uploads

cp .env.example server/.env
nano server/.env
```

Set these in `server/.env`:

```bash
NODE_ENV=production
PORT=5111
APP_URL=https://selflatitude.app
DB_PATH=/home/appselflatitude/companion-data/companion.db
UPLOAD_DIR=/home/appselflatitude/companion-data/uploads
ENCRYPTION_KEY=       # openssl rand -base64 48
SESSION_SECRET=       # openssl rand -base64 48  (a different one)
BOOTSTRAP_ADMIN_EMAIL=you@example.com
BOOTSTRAP_ADMIN_PASSWORD=a-strong-temporary-password
```

Then:

```bash
chmod 600 server/.env
npm ci
npm run build
```

### 4. Point the domain at it

Replace `public_html/.htaccess` with:

```apache
RewriteEngine On

# Do not compress or buffer: the chat replies stream.
SetEnv no-gzip 1
SetEnv proxy-sendchunked 1

RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}/$1 [R=301,L]

RewriteRule ^(.*)$ http://127.0.0.1:5111/$1 [P,L]
```

### 5. Keep it running

The repository includes `scripts/keepalive.sh`, which starts the app if it is not answering. Start it
once by hand:

```bash
./scripts/keepalive.sh
tail -f ~/logs/companion.log
```

Then cPanel → **Advanced → Cron Jobs** → add, every five minutes:

```
*/5 * * * * /home/appselflatitude/selflatitudeapp/scripts/keepalive.sh >/dev/null 2>&1
```

If cron cannot find `node`, edit the script and set `NODE_BIN` to the full path from
`command -v node`.

Open `https://selflatitude.app`.

---

## First run

1. Sign in with the `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` you set.
2. **Profile → Password**: change it immediately.
3. **Settings → Two-step verification**: set up an authenticator app. The Super Admin sections stay
   locked until you do — on a live site this cannot be turned off.
4. **Administration → OpenAI connection**: paste your OpenAI Platform key. Nothing generates replies
   without it.
5. **Administration → Email**: SMTP host, port, username, password and From address, then **Send a
   test email**. Password resets, sign-in codes and welcome emails all depend on this. You can create
   a mailbox under cPanel → Email Accounts and use `mail.selflatitude.app` on port 465 with SSL.
6. **Administration → Plans**: check the two seeded plans and adjust prices and durations.
7. **Administration → JVZoo & payments**: copy the IPN URL shown there —
   `https://selflatitude.app/api/webhooks/jvzoo` — into your JVZoo product settings, paste your JVZoo
   secret key, map each product code to a plan, then turn the integration on.
8. **Administration → Companion**: upload the Foundations course files and publish.

Make one real test purchase before announcing it, and confirm the sale appears in the payments log
as *Account created and plan applied*.

---

## Updating

**Path A:** cPanel → Git Version Control → *Pull or Deploy* → *Update from Remote*. Then in SSH,
inside the virtual environment:

```bash
npm ci && npm run build
```

Then **Restart** in Setup Node.js App.

**Path B:**

```bash
cd ~/selflatitudeapp
git pull
npm ci && npm run build
pkill -f 'node server/dist/index.js'
./scripts/keepalive.sh
```

The database migrates itself on startup; there is no separate migration step.

---

## Backups

The whole application state is two things: `companion-data/companion.db` and
`companion-data/uploads`. Everything else can be rebuilt from the repository.

cPanel's **Backup Wizard** covers your home directory, which includes both — but keep a second copy
somewhere else, because a backup that only exists on the same server is not a backup. Add a cron job:

```
30 3 * * * cd /home/appselflatitude/selflatitudeapp && BACKUP_PASSPHRASE='a-long-passphrase' ./scripts/backup.sh /home/appselflatitude/backups >/dev/null 2>&1
```

That writes an encrypted, checksummed archive and keeps the last thirty. Download them regularly, or
push them off-site with `rclone`. Store `BACKUP_PASSPHRASE` in your password manager, separately from
the server.

Test a restore before you need one:

```bash
BACKUP_PASSPHRASE='a-long-passphrase' ./scripts/restore.sh /home/appselflatitude/backups/companion-<stamp>.tar.gz.enc
```

---

## Troubleshooting

**`npm ci` fails building `better-sqlite3`**
It needs either a prebuilt binary for your Node version or a compiler. Try `npm ci --build-from-source`.
If that fails with a `node-gyp` error, your Node version is probably too new for the prebuilt
binaries — switch to Node 20 or 22 and try again. If there is no compiler at all, ask the host to
install `gcc-c++` and `make`.

**"Refusing to start: ENCRYPTION_KEY looks like a placeholder"**
Working as intended. Generate real values with `openssl rand -base64 48` and set both
`ENCRYPTION_KEY` and `SESSION_SECRET` to different results.

**Sign-in fails with `bad_origin`**
`APP_URL` does not match the address in the browser. Set it to exactly
`https://selflatitude.app` and restart. If the site answers on both the apex and `www`, add the other
one to `ALLOWED_ORIGINS`.

**Replies appear all at once instead of streaming**
Apache is buffering the response. On Path B, make sure `SetEnv no-gzip 1` is in your `.htaccess`.
Some hosts buffer regardless; the app still works, the text just arrives in one go.

**"The Companion is not connected to OpenAI yet"**
Add the key under Administration → OpenAI connection.

**Emails are not arriving**
Administration → Email → **Send a test email** reports the exact error from the mail server. Check
cPanel → Email Deliverability for SPF and DKIM on the domain.

**The site is down and comes back a few minutes later (Path B)**
The keepalive cron is doing its job after a crash. Check `~/logs/companion.log` for why it stopped.
Repeated crashes usually mean the host is killing long-running processes — that is the signal to move
to a VPS or get Node.js support enabled.

**Checking whether it is running at all**

```bash
curl -s http://127.0.0.1:5111/api/health     # expect {"ok":true,...}
ps aux | grep 'server/dist/index.js'
tail -50 ~/logs/companion.log
```

---

## A note on fit

cPanel is built for PHP applications that Apache starts on demand. This app is a long-running Node
process with its own database. It can be made to work on cPanel, and Path A works well when the host
enables Node.js support — but if you find yourself fighting Path B, that is the hosting telling you
something. The dedicated server in the build brief, or a small VPS with
[docs/DEPLOY.md](DEPLOY.md), will cost less time than working around a platform that was not designed
for this.
