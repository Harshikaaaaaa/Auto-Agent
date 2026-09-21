# AutoAgent

An AI workflow builder with a full SaaS billing layer: describe what you want to
automate in plain words, and AutoAgent plans the steps, wires the tools, and runs
the workflow. It ships with user accounts, a credits/subscription/top-up billing
engine, Razorpay payments, per-model usage metering, and an admin console.

- **Frontend:** React 18 + TypeScript + Vite, React Flow canvas, Tailwind.
- **Backend:** Node.js (ESM) + Express 5, MySQL, Pino logging, Helmet/CSP,
  per-IP rate limiting.
- **AI providers:** OpenRouter, Google Gemini, OpenAI, and local Ollama.
- **Payments:** Razorpay (no SDK — REST + HMAC), integer-only money math.

The app serves both the UI and the API on one origin (default
**http://localhost:3234**).

---

## Table of contents

- [Requirements](#requirements)
- [Quick start (local, with Docker/Finch)](#quick-start-local-with-dockerfinch)
- [Local development (without containers)](#local-development-without-containers)
- [Demo credentials](#demo-credentials)
- [Configuration (environment variables)](#configuration-environment-variables)
- [AI providers](#ai-providers)
- [Payments (Razorpay)](#payments-razorpay)
- [Admin console](#admin-console)
- [Testing & quality gate](#testing--quality-gate)
- [Production deployment](#production-deployment)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## Requirements

- **Node.js 20+** and npm
- **MySQL 8+** (the app stores workflows, users, wallets, payments, and usage)
- One of: **Docker** or **Finch** (for the container workflow), OR a local MySQL
- Optional: **Ollama** for a free local model; **Chromium** is bundled in the
  image for JavaScript page rendering

---

## Quick start (local, with Docker/Finch)

This is the fastest path — it runs the app plus a MySQL container together.

1. **Clone and enter the project**

   ```bash
   git clone <repo-url> AutoAgent
   cd AutoAgent
   ```

2. **Create your `.env`** from the template and fill in the required values:

   ```bash
   cp .env.example .env
   ```

   At minimum set (see [Configuration](#configuration-environment-variables)):

   ```env
   APP_PASSWORD=<at least 12 characters>
   SESSION_SECRET=<32+ random hex chars>
   CREDENTIAL_SECRET=<32+ random hex chars>
   DB_PASSWORD=<a strong db password>
   # one AI provider key, e.g.
   AI_PROVIDER=gemini
   GEMINI_API_KEY=<your key>
   ```

   Generate secrets:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   > **Local HTTP note:** for a plain-HTTP localhost run, the provided `.env`
   > keeps `SESSION_COOKIE_SECURE=false` and `OAUTH_ALLOW_INSECURE_REDIRECT=true`
   > so the session cookie and assets are not blocked. `docker-compose.yml`
   > forces `NODE_ENV=production` for a production-parity build.

3. **Build and start**

   With Docker:

   ```bash
   docker compose up --build
   ```

   With Finch:

   ```bash
   finch compose up --build
   ```

4. **Open the app:** http://localhost:3234

5. **Create the first account:** sign up in the UI. To make an admin, either set
   `ADMIN_BOOTSTRAP_EMAIL` + `APP_PASSWORD` before first boot (the first account
   with that email becomes admin), or promote a user later (see
   [Admin console](#admin-console)).

### Rebuilding after a code change

The compose build can serve a stale bundle from cache, so rebuild with
`--no-cache`:

```bash
finch compose build --no-cache app
finch compose up -d --force-recreate app
```

> **Finch + Chromium:** the Chromium download can time out inside the VM during
> the image build. If it does, the image still builds (Chromium is only needed
> for JS page rendering). To copy Chromium from a previously-working container
> into the new image, see [Troubleshooting](#troubleshooting).

---

## Local development (without containers)

Run MySQL yourself, then the API and the Vite dev server separately.

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start MySQL** and create the database (the app auto-migrates on boot when
   `DB_AUTO_MIGRATE=true`):

   ```sql
   CREATE DATABASE autoagent;
   ```

3. **Configure `.env.local`** (loaded automatically) — point `DB_*` at your
   local MySQL. For pure local dev you may set `AUTH_ENABLED=false` (rejected in
   production) to skip login.

4. **Run the API server** (serves the API on `PORT`, default 3234):

   ```bash
   npm run server
   ```

5. **Run the frontend dev server** (hot reload):

   ```bash
   npm run dev
   ```

   Vite serves the UI on its own port and proxies API calls to the server. For a
   production-style single-origin run, build the client and let the server serve
   it:

   ```bash
   npm run build
   npm run server   # serves dist/ + the API on http://localhost:3234
   ```

### Useful scripts

| Script                            | What it does                                   |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | Vite dev server (frontend, hot reload)         |
| `npm run server`                  | Node API server (serves API + built UI)        |
| `npm run build`                   | Typecheck + build the client bundle to `dist/` |
| `npm run typecheck`               | `tsc --noEmit`                                 |
| `npm run lint` / `lint:fix`       | ESLint                                         |
| `npm run format` / `format:check` | Prettier                                       |
| `npm run test`                    | Vitest (unit + integration)                    |
| `npm run test:watch`              | Vitest watch mode                              |
| `npm run verify`                  | typecheck + lint + test                        |

---

## Demo credentials

> **Local demo only.** These exist on a fresh local database seeded for testing.
> They are **not** production credentials. Change or delete them before any real
> deployment.

| Role  | Email                  | Password       |
| ----- | ---------------------- | -------------- |
| Admin | `admin@autoagent.test` | `AdminPass123` |
| User  | `user@autoagent.test`  | `UserPass123`  |

- The **admin** sees an **Admin** entry in the top-right account menu →
  `/admin`.
- The **user** account is on the Free plan with signup credits.
- To recreate them on a fresh DB: sign up both via the UI, then promote the
  admin (see [Admin console](#admin-console)).

---

## Configuration (environment variables)

Full reference lives in [`.env.example`](./.env.example). The essentials:

### Required (server refuses risky/incomplete configs)

| Variable            | Notes                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_PASSWORD`      | Operator password, **≥ 12 chars**. Bootstraps the first admin.                                                                                                                                   |
| `SESSION_SECRET`    | HMAC key for session cookies, **≥ 32 chars**. Rotating it logs everyone out.                                                                                                                     |
| `CREDENTIAL_SECRET` | AES-256-GCM key that encrypts stored OAuth tokens **and** admin-managed settings at rest, **≥ 32 chars**. Rotating it makes stored secrets undecryptable. **Env-only — never stored in the DB.** |
| `DB_PASSWORD`       | Required when `NODE_ENV=production`.                                                                                                                                                             |

### Core

| Variable                | Default       | Notes                                     |
| ----------------------- | ------------- | ----------------------------------------- |
| `NODE_ENV`              | `development` | `production` enables all security guards. |
| `PORT`                  | `3234`        | App + API port.                           |
| `CORS_ALLOWED_ORIGINS`  | —             | Comma-separated allowlist (no wildcard).  |
| `AUTH_ENABLED`          | `true`        | `false` allowed only in non-production.   |
| `SESSION_TTL_HOURS`     | `12`          | Session lifetime.                         |
| `SESSION_COOKIE_SECURE` | prod=`true`   | Set `false` for plain-HTTP localhost.     |

### Database

| Variable                                      | Default                                     | Notes                                        |
| --------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_NAME` | `127.0.0.1` / `3306` / `root` / `autoagent` |                                              |
| `DB_SSL`                                      | `false`                                     | Enforced in prod when `DB_HOST` is remote.   |
| `DB_TRUST_PRIVATE_NETWORK`                    | `false`                                     | Set `true` for the compose internal network. |
| `DB_AUTO_MIGRATE`                             | `true`                                      | Runs migrations on boot.                     |
| `TEST_DB_NAME`                                | `autoagent_test`                            | DB used by integration tests.                |

### Billing

| Variable                              | Default | Notes                              |
| ------------------------------------- | ------- | ---------------------------------- |
| `SIGNUP_FREE_CREDITS`                 | `1000`  | Granted to a new Free user.        |
| `BILLING_EXCHANGE_RATE_PAISE_PER_USD` | `10000` | ₹100/USD.                          |
| `DEFAULT_MARKUP_X10`                  | `25`    | 2.5× markup, stored ×10.           |
| `OPENROUTER_FEE_BPS`                  | `550`   | OpenRouter 5.5% fee, basis points. |

> **Money is integer-only** everywhere (credits, paise, micro-USD) — no floats.
> `$1` of direct provider cost → **25,000 credits**; via OpenRouter (×1.055) →
> **≈ 26,375 credits**.

### Many of these are also editable at runtime from the Admin console

Provider keys/models, the active provider, Google OAuth client, Razorpay keys,
and a couple of feature toggles can be set in **Admin → Settings** without a
restart. A DB value set there **overrides** the environment; otherwise the `.env`
value is used. Secrets are stored encrypted and never shown in full. Boot/
security secrets (`CREDENTIAL_SECRET`, `SESSION_SECRET`, `DB_PASSWORD`,
`APP_PASSWORD`) stay **env-only** by design.

---

## AI providers

Set `AI_PROVIDER` to the default provider and supply that provider's key:

| Provider   | Env                                      | Notes                                   |
| ---------- | ---------------------------------------- | --------------------------------------- |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Carries a 5.5% platform fee in billing. |
| Gemini     | `GEMINI_API_KEY`, `GEMINI_MODEL`         |                                         |
| OpenAI     | `OPENAI_API_KEY`, `OPENAI_MODEL`         |                                         |
| Ollama     | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`        | Local; no key; **billed at 0**.         |

Test the effective provider from **Admin → Settings → Test AI connection**, or
`GET /api/ai/health`.

---

## Payments (Razorpay)

Razorpay is **built** and works in test mode. It uses REST + HMAC (no SDK).

### 1. Keys

Get **test** keys from the Razorpay dashboard and set them either in `.env` or
in **Admin → Settings → Razorpay**:

```env
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=          # optional on localhost (see below)
```

### 2. How a payment settles (three paths, exactly-once)

Credits/plans are **never** granted from the browser's word alone — the server
confirms every payment. A payment settles through whichever of these lands
first (all idempotent, so it is credited exactly once):

1. **Browser verify callback** — the checkout returns a signed
   `{order_id, payment_id, signature}`; the server verifies the HMAC and settles.
2. **Reconcile on page load** — the Billing pages ask Razorpay's Orders API
   whether the order was actually captured, and settle it. **This is what makes
   payments work on localhost**, where the callback may be skipped and a webhook
   cannot reach you.
3. **Webhook** (`payment.captured` / `payment.failed`) — for production.

### 3. Webhook (optional on localhost, recommended in production)

- **URL:** `https://<your-public-host>/api/billing/webhook`
- **Event:** `payment.captured` (and optionally `payment.failed`)
- **Secret:** must equal `RAZORPAY_WEBHOOK_SECRET`.
- On **localhost** the webhook cannot be reached; the reconcile path above
  covers it, so the webhook is **not required** to test end-to-end.

### 4. Plan changes

The Plans page marks your current plan and labels others **Upgrade/Downgrade**
with the exact charge. A plan change starts a **new full-price billing period**
and resets the monthly credit allowance (purchased + bonus credits are kept).
**There is no proration.**

---

## Admin console

Reachable at **`/admin`** for admin accounts (top-right account menu → Admin).

- **Dashboard** — users, active subscriptions, MRR, revenue (month/total),
  credits outstanding + used this month, recent payments.
- **Users** — search, per-user drilldown, change role (user/admin),
  suspend/reactivate, **assign a plan (no payment)**, and a fully-audited manual
  credit adjustment.
- **Plans / Packages / Coupons** — list, create, edit, enable/disable.
- **Rate Card** — full per-model pricing editor (input/cached/output/reasoning
  prices, markup, fee, min charge, max tokens, per-plan-allowed flags) + add new
  rates. Editing a rate affects **new** requests only; historical usage keeps its
  billed rate.
- **Settings** — runtime provider keys, Razorpay keys, Google OAuth, active
  provider, toggles (see [Configuration](#configuration-environment-variables)).

### Making a user an admin

If you did not use `ADMIN_BOOTSTRAP_EMAIL`, promote an existing account in MySQL:

```sql
UPDATE users SET role='admin' WHERE email='you@example.com';
```

Then log out/in. (Or, if you already have one admin, promote others from
**Admin → Users**.)

---

## Testing & quality gate

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint (baseline: 0 errors)
npm run test           # Vitest — DB tests run when MySQL is reachable, else skip
npm run build          # client bundle
node scripts/assert-no-secrets-in-bundle.mjs   # fails if a secret leaks into dist/
npm run format:check
```

DB-backed tests use a real MySQL and a dedicated database. Example:

```bash
env DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD='' \
    TEST_DB_NAME=autoagent_test npm run test
```

If MySQL is not reachable, those suites **skip** rather than fail.

---

## Production deployment

The app is a single container that serves the UI and the API.

### Checklist

1. **Set real secrets as environment variables** (not committed):
   `APP_PASSWORD`, `SESSION_SECRET`, `CREDENTIAL_SECRET`, `DB_PASSWORD`, provider
   key(s), and Razorpay keys.
2. **`NODE_ENV=production`** — enables every guard (auth required, HTTPS cookie,
   HSTS, DB TLS check, no dev bypass).
3. **HTTPS** — serve behind TLS. Keep `SESSION_COOKIE_SECURE=true` (the default
   in production). Do **not** set `OAUTH_ALLOW_INSECURE_REDIRECT`.
4. **Database** — a password-protected MySQL. Use `DB_SSL=true` for any DB that
   crosses an untrusted network. `DB_TRUST_PRIVATE_NETWORK=true` is only for a
   private bridge (e.g. the compose network).
5. **CORS** — set `CORS_ALLOWED_ORIGINS` to your real origin(s); no wildcard.
6. **Migrations** — `DB_AUTO_MIGRATE=true` runs them on boot, or run them as a
   separate step and set it `false`.
7. **Razorpay webhook** — register
   `https://<host>/api/billing/webhook` for `payment.captured` and set
   `RAZORPAY_WEBHOOK_SECRET`.
8. **Google OAuth** (optional) — set all three of `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (a partial config is
   rejected) plus `CREDENTIAL_SECRET`, and add the redirect URI to the OAuth
   client verbatim (https).
9. **Health checks** — probe **`/readyz`** (ready) and **`/healthz`** (live).

### Build & run (containers)

```bash
docker compose up --build -d        # or: finch compose up --build -d
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:3234/readyz   # expect 200
```

The compose file forces `NODE_ENV=production` and reads secrets from `.env` via
`${VAR}` substitution (Finch ignores `env_file`, so secrets are also listed
explicitly in the `environment:` block — keep them in sync with `.env.example`).

---

## Project structure

```
AutoAgent/
├── server/                 # Node/Express backend (ESM + JSDoc)
│   ├── api.js              # app assembly, middleware, boot, migrations
│   ├── auth/               # sessions, password hashing (scrypt), auth routes
│   ├── ai/                 # provider adapters, usage normalization, AI routes
│   ├── billing/            # credit math, wallet grant, signup grant
│   ├── payments/           # Razorpay REST/HMAC, order/verify/webhook/reconcile
│   ├── admin/              # admin console API
│   ├── config/             # env schema (zod), settings resolver, protected paths
│   ├── db/                 # MySQL pool, migrations, repositories
│   ├── oauth/ google/      # Google OAuth (server-side) + proxied tool calls
│   ├── fetch/              # SSRF-guarded web fetch + headless render
│   ├── middleware/         # Helmet/CSP, rate limits, request logging
│   └── **/__tests__/       # Vitest tests
├── src/                    # React + TypeScript frontend
│   ├── app/                # App shell, routing, error boundary
│   ├── features/
│   │   ├── workflow/       # the workflow canvas (default route)
│   │   ├── billing/        # /billing/* — wallet, plans, add credits, usage
│   │   ├── admin/          # /admin/* — admin console
│   │   ├── auth/           # AuthGate, account menu, session client
│   │   └── ai/ tools/      # AI + tool client services
│   └── config/             # API base, constants
├── scripts/                # e.g. assert-no-secrets-in-bundle.mjs
├── Dockerfile, docker-compose.yml
├── .env.example            # full config reference
└── docs/                   # design notes and plans
```

---

## Troubleshooting

**Payment succeeded but plan/credits didn't change (localhost).**
The billing pages reconcile on load — open **Billing → Overview** or
**Payments** and it settles automatically. Ensure your Razorpay **test** keys
are set. (Under the hood, `POST /api/billing/reconcile` asks Razorpay's Orders
API and settles captured-but-pending orders.)

**Checkout popup doesn't open / blank.**
The CSP allows only `checkout.razorpay.com`. Make sure keys are set and you did
a hard refresh after deploying. Invalid keys make the popup fail immediately.

**Admin console / Settings page is cut off.**
Fixed — the console scrolls internally. Hard-refresh to pick up the latest
bundle.

**"Invalid server configuration" on boot.**
The env schema (zod) rejected something — the log names the exact variable.
Common causes: `SESSION_SECRET` < 32 chars, `APP_PASSWORD` < 12 chars,
`DB_PASSWORD` empty in production, a partial Google OAuth config, or
`AI_PROVIDER` set to a provider whose key is missing.

**Finch build: Chromium download timed out.**
The image still builds; only JS rendering (`FETCH_RENDER_ENABLED`) needs
Chromium. To inject it from a working container into the fresh image:

```bash
finch run -d --name aa-chromium-install --user root --entrypoint sh autoagent-app:latest -c "sleep 3600"
finch exec --user root aa-chromium-install sh -c "rm -rf /ms-playwright && mkdir -p /ms-playwright"
finch exec <running-app-container> sh -c "cd / && tar cf - ms-playwright" \
  | finch exec -i --user root aa-chromium-install sh -c "cd / && tar xf -"
finch exec --user root aa-chromium-install sh -c "chmod -R a+rX /ms-playwright"
finch commit aa-chromium-install autoagent-app:latest
finch rm -f aa-chromium-install
finch compose up -d --force-recreate app
```

**Tests fail with DB errors.**
They need a reachable MySQL. If you don't have one, they skip; if MySQL is up
but the test can't connect, check `DB_*` and `TEST_DB_NAME`.

---

## Security notes

- **Auth everywhere.** Every route except `/healthz`, `/readyz`, and
  `/api/auth/*` requires a session. Admin routes additionally require the admin
  role (a non-admin gets a 403).
- **Secrets at rest.** OAuth tokens and admin-managed settings are AES-256-GCM
  encrypted with `CREDENTIAL_SECRET`, which lives only in the environment. A DB
  dump contains no usable keys.
- **Money integrity.** All amounts are integers; the credit formula is pure
  integer math with a minimum-charge floor. Payments are idempotent
  (unique gateway id + `FOR UPDATE`), so a duplicate confirmation never
  double-grants.
- **No secrets in the bundle.** Only `VITE_`-prefixed vars reach the browser;
  `scripts/assert-no-secrets-in-bundle.mjs` fails the build if a secret leaks.
- **Hardened HTTP.** Helmet, a strict CSP (only `checkout.razorpay.com` is
  allowed as a third-party script origin), per-IP rate limits, and no
  `x-powered-by`.
- **Never commit** `.env`, real API keys, or the demo credentials to a public
  repo.
