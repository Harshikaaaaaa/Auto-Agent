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
