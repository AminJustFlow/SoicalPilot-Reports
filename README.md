# SocialPilot to Dropbox Auto-Archiver

Production-ready Node.js 20+ service that:

1. Watches an IMAP inbox in near real time (IDLE + reconnect loop).
2. Filters SocialPilot report emails.
3. Extracts the first SocialPilot S3 report URL from plain text or HTML.
4. Downloads and validates PDF content.
5. Uploads to Dropbox with period-aware filenames using `yymmdd` date segments.
6. Prevents duplicates across restarts using SQLite (IMAP UID + Message-ID).

It can also process scheduled Google Analytics 4 PDF attachments when GA4 support is explicitly enabled and exact administrator-managed property/report mappings exist.

## Google Analytics 4 Reports

GA4 support is disabled by default, so existing SocialPilot installations retain their current behavior. To configure it:

1. Open `/ga4` and add an exact GA4 property route. The property name must match the name sent by Google, such as `Socha Companies GA4`.
2. Choose the Dropbox destination. The client code is configurable, normalized to uppercase, and may be inferred from an explicit folder mapping such as `(SFG)`.
3. Add exact report definitions and canonical filename labels.
4. Set `GA4_ENABLED=true` and restart the service.

A reviewed JSON configuration can also be imported into an explicitly selected database. The command refuses the configured production database unless `--allow-production-db` is intentionally supplied:

```bash
npm run ga4:import-config -- --db ./data/ga4-validation.sqlite --config ./config/socha-ga4.json
```

The expected sender is `noreply-analytics@google.com`. Attached PDFs are validated by MIME type, `%PDF-` signature, and configured size limit. Only exact normalized property/report mappings are used; ambiguous or unknown metadata is held for review.

Socha reports follow the superseding convention:

```text
YYMMDD-{CLIENT_CODE}-{REPORT_NAME}.pdf
```

For example, a September 2026 report becomes `261001-SOC-Reports_snapshot.pdf`. Property names, `GA4`, and sequential report numbers are intentionally omitted. Standard GA4 report titles are converted to the approved canonical report names. Use a shared monthly destination template to keep files directly in one monthly folder:

```text
/Socha-Companies-(SOC)/Projects/Analytics/Website-Analytics/{batchDate}-SOC-{reportingMonth}-GA4-Analytics
```

Supported destination placeholders are `{batchDate}`, `{reportingMonth}`, and `{clientCode}`. No property subfolder is added automatically.

If a generated destination and filename already belongs to the identical PDF, the duplicate is skipped. Different content at that same destination is held as `pending_collision`; the service never overwrites it or adds an arbitrary numeric suffix. Pending PDFs are retained under `GA4_PENDING_DIR` and can be retried from `/ga4` after mappings are corrected.

## Features

- IMAP IDLE watcher with exponential backoff reconnect.
- Duplicate report guard:
  - Skips upload when a matching report key or report URL was already processed
- Subject-based route suggestions:
  - Extracts client names from subjects and lists de-duplicated route keys in `/routes`
- Two-step import control (manual start mode):
  - `Fetch Route Keys` scans mailbox subjects and builds route key suggestions
  - `Start Downloading` begins IMAP report processing after routes are configured
- Routing rule backup/restore:
  - `Export Rules` downloads all current route rules as JSON
  - `Import Rules` uploads JSON in `merge` or `replace` mode
- Web admin reset:
  - `Clear DB + Restart` button clears `processed_messages` and exits process so a supervisor (Docker/PM2/service) can restart clean
- Sender and subject filter:
  - `from` contains `socialpilot` OR `from` equals `support@socialpilot.co`
  - AND `subject` contains `Report generated`
- Dropbox routing:
  - Route keys stored in SQLite (client code or email)
  - Rules can be added/edited/deleted from local web UI: `/routes`
  - Example subject client codes: `-FMB-FB-Report`, `-SFG-FB-Report`, `-900-FB-Report`
  - If no rule matches, the message is held (`pending_route`) and no download/upload happens until mapped
- `DRY_RUN` mode: downloads and validates PDFs but skips Dropbox upload.
- Health endpoint on localhost: `GET /health`.
- Structured logs with timestamps and log levels (Pino).
- Graceful shutdown for `SIGINT` and `SIGTERM`.
- Docker Compose with restart policy.

## Requirements

- Node.js 20+
- Microsoft 365 mailbox with IMAP enabled
- One upload backend:
  - `local_fs` (recommended on laptop with Dropbox app installed), or
  - `dropbox_api` (recommended for AWS/server deployments)

## Microsoft 365 IMAP Setup

1. Enable IMAP for the mailbox:
   - Microsoft 365 Admin Center -> Users -> Active users -> select user -> Mail -> Manage email apps -> enable `IMAP`.
2. Register an Entra ID (Azure AD) app for OAuth2:
   - Azure Portal -> Entra ID -> App registrations -> New registration.
   - Add delegated API permissions:
     - `IMAP.AccessAsUser.All`
     - `offline_access`
   - Grant admin consent if your tenant requires it.
3. Use these IMAP settings in `.env`:
   - `IMAP_HOST=outlook.office365.com`
   - `IMAP_PORT=993`
   - `IMAP_SECURE=true`
   - `IMAP_USER=<mailbox address>`
   - `IMAP_AUTH_METHOD=oauth2`
   - `IMAP_OAUTH_TENANT_ID=<tenant id>`
   - `IMAP_OAUTH_CLIENT_ID=<azure app client id>`
   - `IMAP_OAUTH_CLIENT_SECRET=<azure app client secret (if confidential app)>`
   - `IMAP_OAUTH_REFRESH_TOKEN=<valid refresh token for mailbox user>`

Notes:

- Basic IMAP auth (`AUTHENTICATE PLAIN`) is blocked in many Microsoft tenants.
- If you use `IMAP_AUTH_METHOD=password`, the mailbox must explicitly allow legacy IMAP auth.

## Upload Backend Options

### Option A: Local Dropbox Folder (No API Token)

Use this when Dropbox desktop app is already syncing on the same laptop:

1. Set in `.env`:
   - `UPLOAD_BACKEND=local_fs`
   - `LOCAL_DROPBOX_ROOT=<your local Dropbox folder path>`
2. Keep route folders as relative-style paths, for example:
   - `/SocialPilot Reports/FMB`
   - `/SocialPilot Reports/SFG`

The app writes files directly to that local folder tree, and Dropbox desktop syncs them.

### Option B: Dropbox API v2 Token

Use this when running on a machine without Dropbox desktop sync, including AWS.

1. Set in `.env`:
   - `UPLOAD_BACKEND=dropbox_api`
   - Preferred for long-running deployments:
     - `DROPBOX_APP_KEY=<app key>`
     - `DROPBOX_APP_SECRET=<app secret>`
     - `DROPBOX_REFRESH_TOKEN=<refresh token>`
   - Temporary/testing only:
     - `DROPBOX_ACCESS_TOKEN=<short-lived token>`
2. Create Dropbox app credentials as follows:
   1. Go to Dropbox App Console: https://www.dropbox.com/developers/apps
   2. Create app:
      - API: Scoped access
      - Access: App Folder or Full Dropbox (choose based on your policy)
   3. In Permissions, enable:
      - `files.content.write`
      - `files.content.read`
      - `files.metadata.read`
      - `files.metadata.write`
   4. Generate an access token for quick testing, or complete OAuth once with offline access to get a refresh token for AWS.

For AWS, use the refresh-token setup. Dropbox access tokens are commonly short-lived; the service can now exchange `DROPBOX_REFRESH_TOKEN` for fresh access tokens automatically.

Dropbox Business / team folders:

- Keep the app as a user/file app with Full Dropbox access when you only need folders the connected user can access.
- Do not add `team_data.*` scopes unless you are building a team-admin app.
- Set `DROPBOX_PATH_ROOT_MODE=auto` so the service roots file calls at the account/team root when Dropbox reports a separate team root namespace.
- Set `DROPBOX_FOLDER_PREFIX=/Just-Flow-Corporate` when route rules are stored relative to that team folder.
- If Dropbox support gives you a specific namespace ID, use `DROPBOX_PATH_ROOT_MODE=namespace_id` and `DROPBOX_PATH_ROOT_NAMESPACE_ID=<namespace id>`.

## Environment Variables

Required:

- `IMAP_HOST`
- `IMAP_USER`
- `IMAP_AUTH_METHOD` (`password` or `oauth2`)
- `UPLOAD_BACKEND` (`local_fs` or `dropbox_api`)
- `DROPBOX_FOLDER_DEFAULT`

Common optional:

- `IMAP_PORT` (default `993`)
- `IMAP_SECURE` (default based on port)
- `IMAP_PASS` (required only for `IMAP_AUTH_METHOD=password`)
- `IMAP_OAUTH_ACCESS_TOKEN` (optional static access token)
- `IMAP_OAUTH_CLIENT_ID` (required for oauth2 refresh flow)
- `IMAP_OAUTH_CLIENT_SECRET` (optional for public client, common for confidential client)
- `IMAP_OAUTH_REFRESH_TOKEN` (required for headless oauth2 mode)
- `IMAP_OAUTH_TENANT_ID` (default `common`)
- `IMAP_OAUTH_SCOPE` (default `https://outlook.office.com/IMAP.AccessAsUser.All offline_access`)
- `IMAP_OAUTH_TOKEN_ENDPOINT` (optional override)
- `LOCAL_DROPBOX_ROOT` (required when `UPLOAD_BACKEND=local_fs`)
- `DROPBOX_ACCESS_TOKEN` (accepted when `UPLOAD_BACKEND=dropbox_api`, best for temporary testing)
- `DROPBOX_APP_KEY` (required with `DROPBOX_REFRESH_TOKEN`)
- `DROPBOX_APP_SECRET` (recommended with `DROPBOX_REFRESH_TOKEN` for confidential Dropbox apps)
- `DROPBOX_REFRESH_TOKEN` (recommended when `UPLOAD_BACKEND=dropbox_api` on AWS)
- `DROPBOX_PATH_ROOT_MODE` (`auto`, `home`, `none`, or `namespace_id`; default `auto`)
- `DROPBOX_PATH_ROOT_NAMESPACE_ID` (required only with `DROPBOX_PATH_ROOT_MODE=namespace_id`)
- `DROPBOX_FOLDER_PREFIX` (optional Dropbox API base folder, for example `/Just-Flow-Corporate`)
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` (protect `/routes` and admin APIs with HTTP Basic Auth)
- `IMAP_MAILBOX` (default `INBOX`)
- `IMAP_SEARCH_WINDOW_DAYS` (default `30`)
- `IMPORT_START_MODE` (`manual` or `auto`, default `manual`)
- `IMAP_RECONNECT_BASE_DELAY_MS` (default `2000`)
- `IMAP_RECONNECT_MAX_DELAY_MS` (default `60000`)
- `DRY_RUN` (`true`/`false`, default `false`)
- `HEALTH_HOST` (default `127.0.0.1`)
- `HEALTH_PORT` (default `3100`)
- `DB_PATH` (default `./data/processed_messages.sqlite`)
- `DROPBOX_FOLDER_900` (optional bootstrap rule for `900@justflownh.com`)
- `MAIL_TO_DROPBOX_MAP_JSON` (optional bootstrap rules as JSON)
- `GA4_ENABLED` (`true`/`false`, default `false`)
- `GA4_MAX_PDF_BYTES` (default `26214400`, or 25 MiB)
- `GA4_PENDING_DIR` (default `./data/ga4-pending`)

See `.env.example` for full list.

## Quick Start (Local)

1. Install dependencies:

```bash
npm install
```

2. Create and edit env file:

```bash
cp .env.example .env
```

3. Start service:

```bash
npm start
```

4. Check health endpoint:

```bash
curl http://127.0.0.1:3100/health
```

Expected healthy response:

```text
OK
```

5. Open routing UI and configure routes before starting downloads:

```text
http://127.0.0.1:3100/routes
```

Each rule maps one route key to one Dropbox folder path.
Use lowercase keys in UI (`fmb`, `sfg`, `900`, or full email).
In manual mode:

1. Click `Fetch Route Keys`
2. Create folder rules for suggested keys
3. Click `Start Downloading`

Tip (Windows + `UPLOAD_BACKEND=local_fs`):

- In the route form, use `Browse...` next to `Dropbox Folder` to open the in-page folder browser (scoped to `LOCAL_DROPBOX_ROOT`).
  Tip (rules portability):
- Use `Export Rules` to back up mappings.
- Use `Import Rules` to restore with `Merge` (upsert) or `Replace` (overwrite all existing rules).

## Docker Deployment

Run with one command:

```bash
docker compose up --build -d
```

Compose file includes:

- `restart: unless-stopped`
- container healthcheck against `http://127.0.0.1:${HEALTH_PORT:-3100}/health`
- localhost-only port mapping for web UI and health endpoint (`127.0.0.1:${HEALTH_PORT}`)
- `HEALTH_HOST=0.0.0.0` override inside container so published port is reachable
- persistent `./data` volume for SQLite

## AWS Deployment

Recommended target: ECS/Fargate or an EC2 instance running this Docker image.

Use Dropbox API mode instead of the local Dropbox folder:

```env
UPLOAD_BACKEND=dropbox_api
DROPBOX_APP_KEY=<dropbox app key>
DROPBOX_APP_SECRET=<dropbox app secret>
DROPBOX_REFRESH_TOKEN=<dropbox refresh token>
DROPBOX_FOLDER_DEFAULT=/SocialPilot-Reports
DROPBOX_PATH_ROOT_MODE=auto
DROPBOX_FOLDER_PREFIX=/Just-Flow-Corporate
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3100
DB_PATH=/app/data/processed_messages.sqlite
ADMIN_USERNAME=<admin username>
ADMIN_PASSWORD=<strong admin password>
```

Store secrets in AWS Secrets Manager or SSM Parameter Store, then inject them as container environment variables. Do not install Dropbox Desktop on AWS and do not set `LOCAL_DROPBOX_ROOT` for AWS.

Persist `/app/data` with EFS, an EC2 volume, or another durable volume if you need SQLite state to survive container replacement. Without persistent storage, the app can reprocess old messages after redeploys.

`/health` is intentionally left unauthenticated for platform health checks. The routes UI and management APIs require `ADMIN_USERNAME` and `ADMIN_PASSWORD` when those variables are set.

## Graceful Shutdown

The app handles:

- `SIGINT` (Ctrl+C)
- `SIGTERM` (container stop / orchestrator stop)

Shutdown behavior:

1. Mark service as unhealthy (`/health` returns `NOT_OK`).
2. Abort IMAP watcher loop.
3. Close SQLite and HTTP health server.
4. Exit cleanly.

## Logging

Structured JSON logs include:

- `time` (ISO timestamp)
- `level` (string severity)
- contextual metadata (uid, retries, upload path, etc.)

Use `LOG_LEVEL` to control verbosity (`debug`, `info`, `warn`, `error`).

## Recovery Runbook: Microsoft Token and SSL Certificate

Use this runbook when `Fetch Route Keys` reports that the Microsoft refresh token
expired, or when the HTTPS certificate needs attention.

### Replace an Expired Microsoft Refresh Token

The Entra app registration must contain this Web redirect URI:

```text
http://localhost:53682/callback
```

On the local Windows computer containing this repository:

1. Open PowerShell in the project directory.
2. Install dependencies if needed, then start reauthorization:

   ```powershell
   npm install
   npm run microsoft:reauthorize
   ```

3. If a browser does not open, copy the Microsoft sign-in URL printed in the
   terminal and open it manually.
4. Sign in as the mailbox configured by `IMAP_USER` and approve access.
5. Wait for `Authorization succeeded`. The helper safely replaces
   `IMAP_OAUTH_REFRESH_TOKEN` in the local `.env` and clears the old access token.
6. Open the local `.env` in a text editor and copy the new
   `IMAP_OAUTH_REFRESH_TOKEN` value. Never paste this value into chat, logs, or a
   shell command that could save it in command history.

On the EC2 instance:

1. Change to the directory containing `docker-compose.yml` and `.env`:

   ```bash
   cd /path/to/SoicalPilot-Reports
   ```

2. Edit `.env` and replace only the `IMAP_OAUTH_REFRESH_TOKEN` value:

   ```bash
   nano .env
   ```

   In `nano`, save with `Ctrl+O`, press `Enter`, and exit with `Ctrl+X`.

3. Recreate the container so it loads the changed environment. A plain
   `docker restart` does not reload values from `.env`.

   ```bash
   sudo docker compose up -d --force-recreate socialpilot-dropbox
   ```

4. Wait for startup and verify the service:

   ```bash
   sleep 15
   sudo docker compose ps
   curl -fsS http://127.0.0.1:3100/health
   ```

   The health request should print `OK`.

5. If health fails or `Fetch Route Keys` still fails, inspect logs:

   ```bash
   sudo docker compose logs --tail=200 socialpilot-dropbox
   ```

### Check or Renew the HTTPS Certificate

First determine whether HTTPS is provided by Certbot on EC2 or by AWS Certificate
Manager (ACM).

For an Nginx/Certbot installation on EC2:

```bash
sudo systemctl is-active nginx
sudo certbot certificates
sudo systemctl list-timers --all | grep -i certbot
sudo certbot renew --dry-run
```

If the dry run succeeds, normal renewal should be automatic. To renew a
certificate that is currently due and reload Nginx:

```bash
sudo certbot renew
sudo nginx -t
sudo systemctl reload nginx
```

Do not routinely use `--force-renewal`; unnecessary forced renewals can hit the
certificate authority's rate limits.

If HTTPS uses an Application Load Balancer or CloudFront with ACM, do not run
Certbot on EC2. In the AWS Certificate Manager console, confirm that:

- the certificate status is `Issued`;
- the certificate is attached to the load balancer or CloudFront distribution;
- the ACM DNS-validation CNAME record still exists.

An attached, DNS-validated ACM certificate renews automatically while its
validation record remains in DNS.
