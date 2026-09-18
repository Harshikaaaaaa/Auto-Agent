import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './lib/logger.js';

/**
 * Serve the built single-page app from the same origin as the API.
 *
 * This is what makes the whole same-origin architecture hold together in one
 * container: the browser loads the app and calls `/api/...` on the same host,
 * so the SameSite=Strict session cookie is sent, no CORS entry is needed, and
 * the CSP has no third-party origins to allow. Without this the frontend would
 * have to be served by a separate web server with a reverse proxy for `/api`.
 *
 * Registered only when a build exists (dist/index.html). In development the app
 * is served by the Vite dev server on another port, so this is a no-op and the
 * API is the only thing on this origin.
 *
 * @param {import('express').Express} app
 * @param {string} [distDir] absolute path to the built client; defaults to ../dist
 * @returns {boolean} whether the frontend was mounted
 */
export function serveFrontend(app, distDir) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dir = distDir ?? path.resolve(__dirname, '..', 'dist');
  const indexHtml = path.join(dir, 'index.html');

  if (!fs.existsSync(indexHtml)) {
    logger.info(
      { dir },
      'no built frontend found; serving API only (run `npm run build` to bundle the app)',
    );
    return false;
  }

  // Fingerprinted assets (JS/CSS/fonts) are safe to cache for a long time; the
  // HTML entry must not be, so a deploy is picked up immediately.
  app.use(
    express.static(dir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // SPA history fallback: any non-API GET that is not a real file returns the
  // app shell so client-side routing works on a hard refresh. API and health
  // paths are excluded so a genuine 404 there is not masked by the HTML.
  app.get(/^\/(?!api\/|healthz|readyz).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    // The shell must always be revalidated so a deploy is picked up at once.
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexHtml);
  });

  logger.info({ dir }, 'serving built frontend');
  return true;
}
