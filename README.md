# SocialPilot to Dropbox Auto-Archiver

Production-ready Node.js 20+ service that:

1. Watches an IMAP inbox in near real time (IDLE + reconnect loop).
2. Filters SocialPilot report emails.
3. Extracts the first SocialPilot S3 report URL from plain text or HTML.
4. Downloads and validates PDF content.
5. Uploads to Dropbox with period-aware filenames using `yymmdd` date segments.
6. Prevents duplicates across restarts using SQLite (IMAP UID + Message-ID).

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
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3100
DB_PATH=/app/data/processed_messages.sqlite
```

Store secrets in AWS Secrets Manager or SSM Parameter Store, then inject them as container environment variables. Do not install Dropbox Desktop on AWS and do not set `LOCAL_DROPBOX_ROOT` for AWS.

Persist `/app/data` with EFS, an EC2 volume, or another durable volume if you need SQLite state to survive container replacement. Without persistent storage, the app can reprocess old messages after redeploys.

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
