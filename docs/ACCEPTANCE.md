# Production Hardening — Acceptance Record

This is the end-to-end acceptance pass (Task 19) for the 19-task production
hardening effort. It records what was verified and how, so the
"production-deployable" claim is auditable.

Baseline: `c99d4c0` (snapshot before hardening). Eighteen change commits follow.

## Verification gates (all green)

Run from a clean tree against a local MySQL:

| Gate | Command | Result |
| --- | --- | --- |
| Type safety | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | 0 errors, 43 warnings (tracked `no-explicit-any` / effect-setState debt) |
| Tests | `npm run test` | 648 passing, 36 files |
| Production build | `npm run build` | clean, no chunk-size warning |
| No secrets in bundle | `node scripts/assert-no-secrets-in-bundle.mjs` | clean (5 built files scanned) |
| Formatting | `npm run format:check` | clean |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format:check, test (with a
MySQL service), build, and the secret scan on every push.

## Reported defects — fixed and locked

Two defects were reported. Both now have named regression tests **and** were
re-confirmed live against a running server.

### Defect 1 — a scrape/markdown/download prompt wrongly produced Google Sheets

- **Unit test:** `workflowPlanGenerator.test.ts` → "does not bind Google Sheets
  to a prompt that never mentioned it" asserts no step binds `google_sheets`,
  `requiredTools` excludes it, and the string "google sheets" appears nowhere.
- **Live:** POSTing the exact reported prompt — _"create data scrape from
  website and save it summarize as markdown file and allow me to download"_ — to
  `POST /api/ai/plan`, **with `google_sheets` present and available in the
  catalog**, returned a plan bound to `web.fetch_page → content.extract_content
  → content.to_markdown → files.download_file` and **zero** `google_sheets`
  bindings. The tools the prompt asked for, and nothing it did not.

### Defect 2 — chat "I didnt mnentioned googlesheets in promt fix it" added an unrelated "If Condition" node

- **Unit test:** `workflowPatchGenerator.test.ts` → "removes the Google Sheets
  step instead of adding something unrelated", using the exact reported message
  against a graph that ends in a Google Sheets step. The old keyword ladder that
  "could not fail to do something" is gone; an instruction now becomes
  operations valid against the current graph, or a question, or an error — never
  an unrelated node.

## Deploy story — verified

- The server serves the built SPA and the API from one origin. Booted with a
  build present: logs "serving built frontend", `GET /` returns the app shell,
  `GET /healthz` and the API routes stay intact, and the SPA fallback does not
  swallow `/api` or health paths (`server/__tests__/frontend.test.js`).
- `Dockerfile` (multi-stage) + `docker-compose.yml` (app + MySQL with a named
  volume, health checks, and `depends_on: service_healthy`) + `.dockerignore`.
  See `docs/DEPLOYMENT.md`.
- **Built and run live with Finch** (`finch build`, `finch compose up`): the
  image builds (frontend compile + in-image secret scan both pass), the stack
  comes up, and from the host `GET /` returns the app shell, `GET /readyz`
  reports `database: up` (proving the app↔db link over the private compose
  network), `GET /api/workflows` without a session is `401` (auth enforced in
  production mode), and responses carry an `X-Request-Id`. The compose file was
  made Finch-portable: secrets are passed via `${VAR}` substitution rather than
  relying on `env_file` (which nerdctl-compose ignores), and empty optional env
  vars now read as unset so a `${VAR:-}` substitution cannot fail validation.
- The WhatsApp bridge is off by default and starts only when
  `WHATSAPP_ENABLED=true`; disabled, it emits no Baileys connection noise and
  its endpoints report `disabled`.

## Carried forward for the operator (action required)

1. **Rotate `GEMINI_API_KEY` and `OPENROUTER_API_KEY`.** They were compiled into
   earlier client bundles (`dist/`) and must be treated as public. The current
   build ships no secret (enforced by the CI secret scan), but the already-leaked
   keys are still live until rotated.
2. **Live Google consent was not exercised end-to-end.** The server-side OAuth
   flow is committed and unit-tested with the provider mocked, but verifying real
   consent needs a Google Cloud OAuth *Web application* client with
   `GOOGLE_OAUTH_REDIRECT_URI` registered. See `docs/DEPLOYMENT.md`.
3. **Unused dependencies `@google/genai` and `ollama`.** Confirmed imported
   nowhere in `src/` or `server/` (the server talks to Gemini and Ollama over
   plain HTTP). Removal was declined earlier; they remain in `package.json`.
   Removing them would shrink the dependency surface with no functional change.
