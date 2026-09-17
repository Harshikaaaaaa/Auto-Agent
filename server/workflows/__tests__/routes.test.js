import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * HTTP behaviour of the saved-workflow API against a real MySQL and a real
 * Express stack, so status codes, validation, and owner scoping are exercised as
 * deployed.
 */

const originalEnv = { ...process.env };
const realFetch = globalThis.fetch.bind(globalThis);
const mysqlAvailable = await isMysqlAvailable();

if (!mysqlAvailable) {
  console.warn('[workflows/routes.test] MySQL is not reachable; skipping workflow API tests.');
}

describe.skipIf(!mysqlAvailable)('workflow API', () => {
  let server;
  let baseUrl;
  let pool;
  /** Lets a test choose which owner the request is attributed to. */
  let currentOwner = 'operator';

  beforeAll(async () => {
    // Its own schema, so this suite cannot collide with the repository suite
    // running in parallel.
    ({ pool } = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_api` }));

    const routes = await import('../routes.js');

    const app = express();
    app.use(cookieParser());
    app.use(express.json({ limit: '1mb' }));
    // Stand in for requireSession: these tests are about the routes, and the
    // session gate itself is covered in the security suite.
    app.use('/api/workflows', (req, _res, next) => {
      req.session = { sub: currentOwner };
      next();
    });
    routes.setupWorkflowRoutes(app);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    currentOwner = 'operator';
    await truncateAll(pool);
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.closePool();
    restoreEnv(originalEnv);
  });

  async function api(path, { method = 'GET', body } = {}) {
    const response = await realFetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 204 and similar have no body.
    }
    return { status: response.status, json };
  }

  const validBody = (name = 'My workflow') => ({
    name,
    nodes: [{ id: 'n1', type: 'trigger' }],
    edges: [],
  });

  describe('POST /api/workflows', () => {
    it('saves a workflow and returns its id and version', async () => {
      const { status, json } = await api('/api/workflows', {
        method: 'POST',
        body: validBody(),
      });

      expect(status).toBe(200);
      expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(json.version).toBe(1);
      expect(json.name).toBe('My workflow');
    });

    it('overwrites on a second save with the same name', async () => {
      const first = await api('/api/workflows', { method: 'POST', body: validBody('Same') });
      const second = await api('/api/workflows', {
        method: 'POST',
        body: { ...validBody('Same'), nodes: [{ id: 'n2', type: 'output' }] },
      });

      expect(second.json.id).toBe(first.json.id);
      expect(second.json.version).toBe(2);

      const list = await api('/api/workflows');
      expect(list.json).toHaveLength(1);
    });

    it('rejects a missing name', async () => {
      const { status, json } = await api('/api/workflows', {
        method: 'POST',
        body: { nodes: [], edges: [] },
      });

      expect(status).toBe(400);
      expect(json.error).toBe('invalid_request');
      expect(json.issues.some((i) => i.path === 'name')).toBe(true);
    });

    it('rejects a blank name rather than storing an unnamed workflow', async () => {
      const { status } = await api('/api/workflows', {
        method: 'POST',
        body: { name: '   ', nodes: [], edges: [] },
      });
      expect(status).toBe(400);
    });

    it('rejects a node array that is not an array of objects with ids', async () => {
      const { status, json } = await api('/api/workflows', {
        method: 'POST',
        body: { name: 'Bad nodes', nodes: ['not-a-node'], edges: [] },
      });
      expect(status).toBe(400);
      expect(json.issues.length).toBeGreaterThan(0);
    });

    it('rejects an absurd number of nodes', async () => {
      const nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}` }));
      const { status } = await api('/api/workflows', {
        method: 'POST',
        body: { name: 'Too big', nodes, edges: [] },
      });
      expect(status).toBe(400);
    });

    it('preserves edge conditions verbatim', async () => {
      const { json } = await api('/api/workflows', {
        method: 'POST',
        body: {
          name: 'Branching',
          nodes: [{ id: 'a' }, { id: 'b' }],
          edges: [{ source: 'a', target: 'b', condition: "tier === 'gold' && score > 50" }],
        },
      });

      expect(json.edges[0].condition).toBe("tier === 'gold' && score > 50");
    });
  });

  describe('POST /api/workflows/create', () => {
    it('creates a workflow and returns 201', async () => {
      const { status, json } = await api('/api/workflows/create', {
        method: 'POST',
        body: validBody('Created'),
      });
      expect(status).toBe(201);
      expect(json.version).toBe(1);
    });

    it('returns 409 when the name is already used', async () => {
      await api('/api/workflows/create', { method: 'POST', body: validBody('Dup') });
      const { status, json } = await api('/api/workflows/create', {
        method: 'POST',
        body: validBody('Dup'),
      });

      expect(status).toBe(409);
      expect(json.error).toBe('name_taken');
    });
  });

  describe('GET /api/workflows/:id', () => {
    it('returns the workflow', async () => {
      const created = await api('/api/workflows', { method: 'POST', body: validBody('Readable') });
      const { status, json } = await api(`/api/workflows/${created.json.id}`);

      expect(status).toBe(200);
      expect(json.name).toBe('Readable');
    });

    it('returns 404 for an unknown id', async () => {
      const { status, json } = await api(`/api/workflows/${crypto.randomUUID()}`);
      expect(status).toBe(404);
      expect(json.error).toBe('not_found');
    });

    it('returns 400 for an id that is not a uuid', async () => {
      const { status, json } = await api('/api/workflows/not-a-uuid');
      expect(status).toBe(400);
      expect(json.error).toBe('invalid_id');
    });
  });

  describe('PUT /api/workflows/:id', () => {
    it('updates and bumps the version', async () => {
      const created = await api('/api/workflows', { method: 'POST', body: validBody('Editable') });

      const { status, json } = await api(`/api/workflows/${created.json.id}`, {
        method: 'PUT',
        body: { name: 'Renamed', version: created.json.version },
      });

      expect(status).toBe(200);
      expect(json.name).toBe('Renamed');
      expect(json.version).toBe(2);
    });

    it('returns 409 with the current version when the client version is stale', async () => {
      const created = await api('/api/workflows', { method: 'POST', body: validBody('Contested') });
      await api(`/api/workflows/${created.json.id}`, {
        method: 'PUT',
        body: { metadata: { round: 1 }, version: 1 },
      });

      // Second editor still thinks it is on version 1.
      const { status, json } = await api(`/api/workflows/${created.json.id}`, {
        method: 'PUT',
        body: { metadata: { round: 2 }, version: 1 },
      });

      expect(status).toBe(409);
      expect(json.error).toBe('version_conflict');
      expect(json.currentVersion).toBe(2);
    });

    it('returns 404 for an unknown id', async () => {
      const { status } = await api(`/api/workflows/${crypto.randomUUID()}`, {
        method: 'PUT',
        body: { name: 'Nope' },
      });
      expect(status).toBe(404);
    });
  });

  describe('DELETE /api/workflows/:id', () => {
    it('deletes and returns 204', async () => {
      const created = await api('/api/workflows', { method: 'POST', body: validBody('Doomed') });

      const { status } = await api(`/api/workflows/${created.json.id}`, { method: 'DELETE' });
      expect(status).toBe(204);

      const list = await api('/api/workflows');
      expect(list.json).toHaveLength(0);
    });

    it('returns 404 when it does not exist', async () => {
      const { status } = await api(`/api/workflows/${crypto.randomUUID()}`, { method: 'DELETE' });
      expect(status).toBe(404);
    });
  });

  describe('owner scoping', () => {
    it("never exposes another owner's workflow over HTTP", async () => {
      currentOwner = 'owner-a';
      const theirs = await api('/api/workflows', { method: 'POST', body: validBody('Private') });

      currentOwner = 'owner-b';
      expect((await api('/api/workflows')).json).toHaveLength(0);
      expect((await api(`/api/workflows/${theirs.json.id}`)).status).toBe(404);
      expect((await api(`/api/workflows/${theirs.json.id}`, { method: 'DELETE' })).status).toBe(
        404,
      );

      // Still intact for its real owner.
      currentOwner = 'owner-a';
      expect((await api(`/api/workflows/${theirs.json.id}`)).status).toBe(200);
    });
  });

  describe('POST /api/workflows/runs', () => {
    it('records a run outcome as its own row', async () => {
      await api('/api/workflows', { method: 'POST', body: validBody('Runnable') });

      const { status, json } = await api('/api/workflows/runs', {
        method: 'POST',
        body: {
          name: 'Runnable',
          status: 'completed',
          provider: 'openrouter',
          model: 'gpt-oss-120b',
          durationMs: 3200,
          nodeCount: 4,
        },
      });

      expect(status).toBe(201);
      expect(json.run.status).toBe('completed');
      expect(json.run.model).toBe('gpt-oss-120b');
      expect(json.run.durationMs).toBe(3200);
      expect(json.run.nodeCount).toBe(4);
      expect(json.run.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns 404 for an unknown workflow name', async () => {
      const { status } = await api('/api/workflows/runs', {
        method: 'POST',
        body: { name: 'Missing', status: 'completed' },
      });
      expect(status).toBe(404);
    });

    it('rejects an invalid status', async () => {
      const { status } = await api('/api/workflows/runs', {
        method: 'POST',
        body: { name: 'Runnable', status: 'exploded' },
      });
      expect(status).toBe(400);
    });
  });

  describe('run history reads', () => {
    it('lists a workflow’s runs newest-first', async () => {
      const created = await api('/api/workflows', {
        method: 'POST',
        body: validBody('Historied'),
      });

      await api('/api/workflows/runs', {
        method: 'POST',
        body: { name: 'Historied', status: 'completed' },
      });
      await api('/api/workflows/runs', {
        method: 'POST',
        body: { name: 'Historied', status: 'failed', failureKind: 'auth' },
      });

      const { status, json } = await api(`/api/workflows/${created.json.id}/runs`);
      expect(status).toBe(200);
      expect(json.runs).toHaveLength(2);
      expect(json.runs[0].status).toBe('failed');
      expect(json.runs[0].failureKind).toBe('auth');
    });

    it('lists recent runs across all workflows', async () => {
      await api('/api/workflows', { method: 'POST', body: validBody('A') });
      await api('/api/workflows', { method: 'POST', body: validBody('B') });
      await api('/api/workflows/runs', {
        method: 'POST',
        body: { name: 'A', status: 'completed' },
      });
      await api('/api/workflows/runs', {
        method: 'POST',
        body: { name: 'B', status: 'completed' },
      });

      const { status, json } = await api('/api/workflows/runs');
      expect(status).toBe(200);
      expect(json.runs.length).toBeGreaterThanOrEqual(2);
    });

    it('does not confuse /api/workflows/runs with a workflow id', async () => {
      // `runs` is registered before `:id`; if the order regressed this would 400.
      const { status } = await api('/api/workflows/runs');
      expect(status).toBe(200);
    });

    it('returns 404 listing runs for an unknown workflow id', async () => {
      // A well-formed but nonexistent uuid v4 (variant nibble 8-b).
      const { status } = await api('/api/workflows/11111111-1111-4111-8111-111111111111/runs');
      expect(status).toBe(404);
    });
  });

  describe('concurrent saves over HTTP', () => {
    it('persists every one of many simultaneous distinct saves', async () => {
      // The regression that motivated moving off the JSON file.
      const names = Array.from({ length: 10 }, (_, i) => `Parallel ${i}`);

      const results = await Promise.all(
        names.map((name) => api('/api/workflows', { method: 'POST', body: validBody(name) })),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      const list = await api('/api/workflows');
      expect(list.json).toHaveLength(names.length);
    });
  });
});
