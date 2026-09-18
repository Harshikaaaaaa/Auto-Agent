# Deploying AutoAgent

AutoAgent ships as a single container that serves both the web app and the API
from one origin, backed by a MySQL database. This is deliberate: the session
cookie is `SameSite=Strict`, the browser calls the API same-origin, and the
Content-Security-Policy allows no third-party origins — all of which assume the
app and API share a host.

## Contents

- [Prerequisites](#prerequisites)
- [Quick start with Docker Compose](#quick-start-with-docker-compose)
- [Configuration reference](#configuration-reference)
- [Secrets: generating and rotating](#secrets-generating-and-rotating)
- [Connecting Google tools](#connecting-google-tools)
- [Database migrations and backups](#database-migrations-and-backups)
- [Health checks](#health-checks)
- [Running without Docker](#running-without-docker)

## Prerequisites

- Docker with the Compose plugin (`docker compose`), **or** Node.js 22+ and a
  reachable MySQL 8.4+ / 9.x server for a non-container run.
- An AI provider: an OpenRouter key, a Gemini key, or a local Ollama instance.

## Quick start with Docker Compose

1. Copy the example config and fill it in:

   ```bash
   cp .env.example .env
   ```

   At minimum set, in `.env`:
   - `APP_PASSWORD` — the operator login password (12+ characters).
   - `SESSION_SECRET` — 32+ random characters (see below to generate).
   - `DB_PASSWORD` — the MySQL root password the stack will use.
   - Your AI provider key, e.g. `OPENROUTER_API_KEY`, matching `AI_PROVIDER`.

2. Build and start:

   ```bash
   docker compose up --build     # Docker
   # or
   finch compose up --build      # Finch — same files, no changes needed
   ```

   Under Docker Compose, MySQL starts first and the app waits on its health
   check. Finch/nerdctl-compose ignores `depends_on: service_healthy`, so the app
   may lose one boot race with the database and is restarted automatically
   (`restart: unless-stopped`) once MySQL is accepting connections — the end
   state is identical. Either way the app runs migrations on boot
   (`DB_AUTO_MIGRATE=true`) and refuses to start if it cannot prepare the
   database.

   Both `docker compose` and `finch compose` read config from `.env` by
   `${VAR}` substitution, so no Docker-only features are required.

3. Open <http://localhost:3234> and sign in with `APP_PASSWORD`.

Data persists in the `autoagent_db` named volume across `docker compose down`.
To wipe it deliberately, run `docker compose down -v`.

The compose file sets the container-specific values for you: `NODE_ENV=production`,
`DB_HOST=db`, and `DB_TRUST_PRIVATE_NETWORK=true` (the database port is never
published to the host, so TLS between the app and db containers is not required).

## Configuration reference

Every variable is documented in `.env.example`. The ones that matter most for a
deployment:

| Variable | Purpose | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` in any real deployment | Turns on `Secure` cookies and the stricter startup checks. |
| `PORT` | Port the server listens on | Default `3234`. |
| `APP_PASSWORD` | Operator login password | Required unless `AUTH_ENABLED=false`; 12+ chars. |
| `SESSION_SECRET` | HMAC key for session cookies | 32+ chars. Rotating it signs everyone out. |
| `AUTH_ENABLED` | Master auth switch | **Must be true in production** — the server rejects `false` there. |
| `AI_PROVIDER` | `openrouter` \| `gemini` \| `ollama` | The matching key must be set. |
| `OPENROUTER_API_KEY` / `GEMINI_API_KEY` | Provider credential | Server-side only; never reaches the browser. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Database connection | `DB_PASSWORD` is required in production. |
| `DB_SSL` | Require TLS to the database | Enforced in production for a non-local `DB_HOST`. |
| `DB_TRUST_PRIVATE_NETWORK` | Opt out of the TLS requirement for a trusted private network | Only for a Docker Compose bridge or equivalent; the compose file sets it. |
| `DB_AUTO_MIGRATE` | Create/upgrade the schema on boot | See below. |
| `WHATSAPP_ENABLED` | Turn the WhatsApp bridge on | Off by default; see below. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` | Google OAuth | All three together, or none. |
| `CREDENTIAL_SECRET` | Encrypts stored OAuth tokens at rest | Required when Google OAuth is configured. |
| `CORS_ALLOWED_ORIGINS` | Browser origins allowed to call the API | Only relevant if the app is served from a different origin than the API. |

### `DB_AUTO_MIGRATE`

When `true` (the default) the server creates the database if needed and applies
any pending schema migrations on boot. This is convenient for a single-container
deployment. For a stricter pipeline, set it to `false` and run migrations as a
separate deploy step (they are ordered and idempotent, tracked in the
`schema_migrations` table).

### `WHATSAPP_ENABLED`

The WhatsApp bridge is **off by default**. It uses an unofficial client library
(Baileys) and links a real WhatsApp account, which carries an account-ban risk.
When off, the bridge never starts — no linked-device socket, no console QR code —
and its endpoints report `disabled` so the UI degrades cleanly. Turn it on only
if you intend to link an account, then open `/qr` while signed in to scan.

## Secrets: generating and rotating

Generate a random 32-byte secret (for `SESSION_SECRET` and `CREDENTIAL_SECRET`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotation semantics:

- **`SESSION_SECRET`** — rotating invalidates every existing session. This is the
  break-glass control: rotate it to sign everyone out immediately.
- **`CREDENTIAL_SECRET`** — rotating makes every stored Google token
  undecryptable. After rotating, every connected tool must be reconnected.
- **Provider keys (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`)** — rotate at the
  provider, then update the environment and restart. These are read only by the
  server and are never compiled into the browser bundle; the CI/`Dockerfile`
  secret scan (`scripts/assert-no-secrets-in-bundle.mjs`) fails the build if a
  secret ever appears in `dist/`.

> If any provider key was ever shipped in an older build, treat it as public and
> rotate it. Anything that reached `dist/` was downloadable by every visitor.

## Connecting Google tools

Gmail, Sheets, and Drive use server-side OAuth (authorization-code + PKCE); the
browser never holds a token.

1. In the Google Cloud console, create an **OAuth 2.0 Client ID** of type
   **Web application**.
2. Add your callback URL to the client's **Authorised redirect URIs**, verbatim.
   It must match `GOOGLE_OAUTH_REDIRECT_URI` exactly, e.g.
   `https://your-host/api/oauth/google/callback`. In production this URL must use
   `https`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`,
   and `CREDENTIAL_SECRET`. All three Google variables are required together — a
   partial configuration is rejected at startup.
4. Restart, then use the connect button in the app; consent happens in a popup.

Leave all three Google variables unset to disable connecting Google tools
entirely.

## Database migrations and backups

Migrations run automatically on boot when `DB_AUTO_MIGRATE=true`. They are
append-only and recorded in `schema_migrations`, so a restart converges to the
same schema no matter which version it started from.

Back up the MySQL data with the standard tools. Against the compose stack:

```bash
# Backup
docker compose exec db sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' > backup.sql

# Restore (into a running, empty database)
docker compose exec -T db sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < backup.sql
```

The `autoagent_db` volume already persists data across restarts; a `mysqldump`
is for off-host backups and point-in-time snapshots.

## Health checks

- `GET /healthz` — liveness. Returns `{ "status": "ok" }` as soon as the process
  is up. Unauthenticated.
- `GET /readyz` — readiness. Returns 200 only when the database is reachable,
  503 otherwise. The container `HEALTHCHECK` and the compose health check both
  probe this, and orchestrators should gate traffic on it.

Every response also carries an `X-Request-Id` header (generated, or echoed from
a sane inbound one) that correlates the server logs for that request.

## Running without Docker

```bash
npm ci
npm run build          # compile the frontend into dist/
cp .env.example .env   # then fill it in; point DB_* at your MySQL
node server/api.js
```

The server serves `dist/` automatically when it exists, so a production run is
just `node server/api.js` behind a TLS-terminating reverse proxy. In development
run the API (`npm run server`) and the Vite dev server (`npm run dev`)
separately; Vite proxies `/api` to the server, and `dist/` is absent so the
server runs API-only.
