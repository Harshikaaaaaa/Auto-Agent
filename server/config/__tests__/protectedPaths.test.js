import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AI_PATHS,
  ALL_PROTECTED_PATHS,
  PUBLIC_PATHS,
  WHATSAPP_PATHS,
  WORKFLOW_PATHS,
} from '../protectedPaths.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Guards the route-protection list itself.
 *
 * This exists because of a real gap: the session guard was registered for
 * `/api/workflows` while the routes were mounted at `/workflows`, leaving saved
 * workflows readable and deletable by anyone who could reach the port. A test
 * that reads the actual route registrations catches that class of mistake.
 */
describe('protected paths', () => {
  it('covers the legacy /workflows prefix as well as /api/workflows', () => {
    expect(WORKFLOW_PATHS).toContain('/workflows');
    expect(WORKFLOW_PATHS).toContain('/api/workflows');
  });

  it('covers every WhatsApp bridge route', () => {
    // Each of these either sends messages, reads them, or destroys credentials.
    for (const route of ['/status', '/qr', '/send', '/messages', '/disconnect']) {
      expect(WHATSAPP_PATHS).toContain(route);
    }
  });

  it('covers the AI routes', () => {
    expect(AI_PATHS).toContain('/api/ai');
  });

  it('covers the outbound fetch route', () => {
    // Anonymous access here would be a network scanner.
    expect(ALL_PROTECTED_PATHS).toContain('/api/fetch');
  });

  it('does not mark a public path as protected', () => {
    for (const publicPath of PUBLIC_PATHS) {
      expect(ALL_PROTECTED_PATHS).not.toContain(publicPath);
    }
  });

  /**
   * Read every route actually registered in the server sources and assert each
   * one is either explicitly public or covered by a protected prefix.
   */
  it('guards every route registered by the server', () => {
    const sources = [
      'api.js',
      'workflows/routes.js',
      'ai/routes.js',
      'auth/session.js',
      'fetch/routes.js',
      'oauth/routes.js',
      'google/routes.js',
    ];
    const registered = new Set();

    for (const file of sources) {
      const full = path.join(serverDir, file);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, 'utf8');
      // Matches app.get('/x'), app.post("/x"), app.delete('/x/:id'), etc.
      const routeRe = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
      for (const match of content.matchAll(routeRe)) {
        registered.add(match[2]);
      }
    }

    // Sanity check that the scan found the real routes rather than nothing.
    expect(registered.has('/api/workflows')).toBe(true);
    expect(registered.has('/api/ai/plan')).toBe(true);
    // The OAuth callback WRITES a credential, so it must be covered too.
    expect(registered.has('/api/oauth/google/callback')).toBe(true);
    expect(registered.has('/api/google/call')).toBe(true);
    expect(registered.size).toBeGreaterThan(8);

    const unguarded = [...registered].filter((route) => {
      if (PUBLIC_PATHS.includes(route)) return false;
      return !ALL_PROTECTED_PATHS.some(
        (prefix) => route === prefix || route.startsWith(`${prefix}/`),
      );
    });

    expect(unguarded).toEqual([]);
  });
});
