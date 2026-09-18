# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# AutoAgent production image.
#
# One image serves both the built single-page app and the API from a single
# origin (see server/frontend.js) — which is what the same-origin session
# cookie, the CORS allowlist, and the CSP all assume.
#
# Multi-stage: the build stage compiles the frontend with the full dev
# toolchain; the runtime stage ships only production dependencies plus the
# built assets, so no build tools or source-only packages reach production.
# ─────────────────────────────────────────────────────────────────────────────

# ---- Build stage: compile the frontend ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install with the lockfile for a reproducible dependency tree. Copying only the
# manifests first lets Docker cache this layer until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

# Build the client. The server is plain JS and needs no build step.
COPY . .
RUN npm run build:only \
  # Fail the image build if a secret ever ends up in the bundle, exactly as CI does.
  && node scripts/assert-no-secrets-in-bundle.mjs

# ---- Runtime stage: production dependencies + built assets ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only — no vite, eslint, vitest, etc.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Tier-2 web scraping renders JavaScript pages with headless Chromium
# (server/fetch/render.js), used only when FETCH_RENDER_ENABLED=true. Install
# the browser and its OS libraries here so the toggle works without a rebuild.
# Browsers go to a world-readable path so the unprivileged `node` user can
# launch them; the install itself needs root for the apt system libraries.
#
# The install is BEST-EFFORT and retried: the browser binary is a large
# download and the build network is sometimes flaky. If it ultimately fails the
# image still builds — the render tier imports Playwright lazily and degrades to
# the plain fetch when Chromium is absent, so the only cost of a failed download
# is that JavaScript rendering is unavailable until the image is rebuilt.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The OS libraries Chromium needs; installed separately so an apt failure and a
# browser-download failure are distinguishable, and this layer caches.
RUN npx playwright install-deps chromium || echo "WARNING: playwright OS deps did not install; rendering may not work"
RUN for attempt in 1 2 3; do \
      npx playwright install chromium && break; \
      echo "playwright chromium download attempt $attempt failed; retrying"; \
      sleep 5; \
    done; \
    if [ -d /ms-playwright ]; then chmod -R a+rx /ms-playwright; \
    else echo "WARNING: Chromium was not installed; JavaScript rendering will be unavailable"; fi

# The server, and the frontend built in the previous stage.
COPY server ./server
COPY --from=build /app/dist ./dist

# Run as the unprivileged user the base image already provides.
USER node

EXPOSE 3234

# Liveness/readiness are plain HTTP; compose and orchestrators can probe /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3234)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/api.js"]
