import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

if (!mysqlAvailable) {
  // Visible rather than silent: a skipped persistence suite should be noticed.
  console.warn(
    '[workflowRepository.test] MySQL is not reachable; skipping persistence integration tests.',
  );
}

const OWNER = 'operator';
const OTHER_OWNER = 'someone-else';

describe.skipIf(!mysqlAvailable)('workflow repository (MySQL)', () => {
  let pool;
  let repository;
  let migrations;

  beforeAll(async () => {
    // Its own schema: vitest runs test files in parallel, and sharing one test
    // database would let suites truncate each other's rows mid-test.
    ({ pool, repository, migrations } = await loadDbModules(vi, {
      DB_NAME: `${TEST_DB_NAME}_repo`,
    }));
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.closePool();
    restoreEnv(originalEnv);
  });

  const sampleInput = (name) => ({
    name,
    nodes: [{ id: 'n1', type: 'trigger', data: { label: 'Start' } }],
    edges: [{ source: 'n1', target: 'n2', condition: 'score > 50' }],
    initialState: { score: 80 },
    metadata: { tags: ['test'] },
  });

  describe('create and read', () => {
    it('round-trips a workflow including JSON columns', async () => {
      const created = await repository.createWorkflow(OWNER, sampleInput('Round trip'));

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.version).toBe(1);
      expect(created.nodes[0].data.label).toBe('Start');
      // The condition string must survive storage untouched, since the evaluator
      // parses it verbatim.
      expect(created.edges[0].condition).toBe('score > 50');
      expect(created.initialState).toEqual({ score: 80 });
      expect(created.metadata.tags).toEqual(['test']);
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("lists only the calling owner's workflows", async () => {
      await repository.createWorkflow(OWNER, sampleInput('Mine'));
      await repository.createWorkflow(OTHER_OWNER, sampleInput('Theirs'));

      const mine = await repository.listWorkflows(OWNER);
      expect(mine).toHaveLength(1);
      expect(mine[0].name).toBe('Mine');
    });

    it("does not leak another owner's workflow through its id", async () => {
      const theirs = await repository.createWorkflow(OTHER_OWNER, sampleInput('Theirs'));

      // Knowing the id must not be enough to read it.
      expect(await repository.getWorkflowById(OWNER, theirs.id)).toBeNull();
      expect(await repository.getWorkflowById(OTHER_OWNER, theirs.id)).not.toBeNull();
    });

    it('rejects a duplicate name for the same owner', async () => {
      await repository.createWorkflow(OWNER, sampleInput('Unique'));

      await expect(repository.createWorkflow(OWNER, sampleInput('Unique'))).rejects.toThrow(
        /already have a workflow named/i,
      );
    });

    it('allows two owners to use the same name', async () => {
      // Uniqueness is per owner, not global.
      await repository.createWorkflow(OWNER, sampleInput('Shared name'));
      await expect(
        repository.createWorkflow(OTHER_OWNER, sampleInput('Shared name')),
      ).resolves.toBeTruthy();
    });
  });

  describe('no lost updates', () => {
    it('persists concurrent saves of DIFFERENT workflows', async () => {
      // This is the exact failure of the old JSON store: it read the whole array,
      // mutated it, and rewrote the file, so one of two concurrent saves vanished.
      const names = Array.from({ length: 12 }, (_, i) => `Concurrent ${i}`);

      await Promise.all(
        names.map((name) => repository.upsertWorkflowByName(OWNER, sampleInput(name))),
      );

      const saved = await repository.listWorkflows(OWNER);
      expect(saved).toHaveLength(names.length);
      expect(saved.map((w) => w.name).sort()).toEqual([...names].sort());
    });

    it('reports a conflict instead of silently overwriting the same row', async () => {
      const created = await repository.createWorkflow(OWNER, sampleInput('Contended'));

      // Two editors both loaded version 1 and both save.
      const first = repository.updateWorkflow(
        OWNER,
        created.id,
        { metadata: { editor: 'first' } },
        created.version,
      );
      const second = repository.updateWorkflow(
        OWNER,
        created.id,
        { metadata: { editor: 'second' } },
        created.version,
      );

      const results = await Promise.allSettled([first, second]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one wins; the loser is told rather than losing its work quietly.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.name).toBe('WorkflowConflictError');
      expect(rejected[0].reason.currentVersion).toBe(2);
    });

    it('increments the version on every update', async () => {
      const created = await repository.createWorkflow(OWNER, sampleInput('Versioned'));
      expect(created.version).toBe(1);

      const once = await repository.updateWorkflow(OWNER, created.id, { metadata: { a: 1 } }, 1);
      expect(once.version).toBe(2);

      const twice = await repository.updateWorkflow(OWNER, created.id, { metadata: { a: 2 } }, 2);
      expect(twice.version).toBe(3);
    });

    it('allows an update without a version, for callers that do not track it', async () => {
      const created = await repository.createWorkflow(OWNER, sampleInput('Unchecked'));
      const updated = await repository.updateWorkflow(OWNER, created.id, { metadata: { x: 1 } });
      expect(updated.version).toBe(2);
    });
  });

  describe('upsert by name', () => {
    it('replaces content and bumps the version rather than duplicating', async () => {
      const first = await repository.upsertWorkflowByName(OWNER, sampleInput('Save me'));
      const second = await repository.upsertWorkflowByName(OWNER, {
        ...sampleInput('Save me'),
        nodes: [{ id: 'n9', type: 'output' }],
      });

      expect(second.id).toBe(first.id);
      expect(second.version).toBe(2);
      expect(second.nodes).toHaveLength(1);
      expect(second.nodes[0].id).toBe('n9');
      expect(await repository.listWorkflows(OWNER)).toHaveLength(1);
    });
  });

  describe('update and delete', () => {
    it('returns null when updating a workflow that does not exist', async () => {
      const result = await repository.updateWorkflow(OWNER, crypto.randomUUID(), { metadata: {} });
      expect(result).toBeNull();
    });

    it('rejects renaming onto a name the owner already uses', async () => {
      await repository.createWorkflow(OWNER, sampleInput('Taken'));
      const other = await repository.createWorkflow(OWNER, sampleInput('Free'));

      await expect(
        repository.updateWorkflow(OWNER, other.id, { name: 'Taken' }, other.version),
      ).rejects.toThrow(/already have a workflow named/i);
    });

    it('deletes by id and reports whether anything was removed', async () => {
      const created = await repository.createWorkflow(OWNER, sampleInput('Delete me'));

      expect(await repository.deleteWorkflowById(OWNER, created.id)).toBe(true);
      expect(await repository.deleteWorkflowById(OWNER, created.id)).toBe(false);
      expect(await repository.listWorkflows(OWNER)).toHaveLength(0);
    });

    it("will not delete another owner's workflow", async () => {
      const theirs = await repository.createWorkflow(OTHER_OWNER, sampleInput('Protected'));

      expect(await repository.deleteWorkflowById(OWNER, theirs.id)).toBe(false);
      expect(await repository.getWorkflowById(OTHER_OWNER, theirs.id)).not.toBeNull();
    });
  });

  describe('run records', () => {
    it('accumulates run history and counts', async () => {
      await repository.createWorkflow(OWNER, sampleInput('Runs'));

      await repository.recordRun(OWNER, 'Runs', { status: 'completed', provider: 'openrouter' });
      const second = await repository.recordRun(OWNER, 'Runs', {
        status: 'failed',
        provider: 'gemini',
      });

      expect(second.runCount).toBe(2);
      expect(second.lastExecutionStatus).toBe('failed');
      expect(second.runHistory).toHaveLength(2);
      expect(second.runHistory[1].provider).toBe('gemini');
    });

    it('bounds run history so metadata cannot grow without limit', async () => {
      await repository.createWorkflow(OWNER, sampleInput('Busy'));

      for (let i = 0; i < 25; i += 1) {
        await repository.recordRun(OWNER, 'Busy', { status: 'completed' });
      }

      const final = await repository.recordRun(OWNER, 'Busy', { status: 'completed' });
      expect(final.runHistory).toHaveLength(20);
      expect(final.runCount).toBe(26);
    });

    it('returns null for an unknown workflow', async () => {
      expect(await repository.recordRun(OWNER, 'Nope', { status: 'completed' })).toBeNull();
    });
  });

  describe('migrations', () => {
    it('is idempotent when run again', async () => {
      // A second run must apply nothing, so a restart is safe.
      const applied = await migrations.runMigrations();
      expect(applied).toEqual([]);
    });
  });

  describe('legacy JSON import', () => {
    let tempDir;

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    });

    function writeLegacyFile(contents) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoagent-legacy-'));
      const filePath = path.join(tempDir, 'workflows.json');
      fs.writeFileSync(
        filePath,
        typeof contents === 'string' ? contents : JSON.stringify(contents),
      );
      return filePath;
    }

    it('imports workflows from the old file format', async () => {
      const filePath = writeLegacyFile([
        {
          name: 'Imported A',
          nodes: [{ id: 'a1' }],
          edges: [],
          savedAt: '2026-01-01T00:00:00.000Z',
          metadata: { runCount: 3 },
        },
        { name: 'Imported B', nodes: [], edges: [] },
      ]);

      const result = await migrations.importLegacyWorkflows({ ownerId: OWNER, filePath });

      expect(result.imported).toBe(2);
      const saved = await repository.listWorkflows(OWNER);
      expect(saved.map((w) => w.name).sort()).toEqual(['Imported A', 'Imported B']);
      const a = saved.find((w) => w.name === 'Imported A');
      expect(a.metadata.runCount).toBe(3);
    });

    it('does not duplicate rows when run twice', async () => {
      const filePath = writeLegacyFile([{ name: 'Once', nodes: [], edges: [] }]);

      const first = await migrations.importLegacyWorkflows({ ownerId: OWNER, filePath });
      const second = await migrations.importLegacyWorkflows({ ownerId: OWNER, filePath });

      expect(first.imported).toBe(1);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(await repository.listWorkflows(OWNER)).toHaveLength(1);
    });

    it('leaves the source file in place so it can be verified before deletion', async () => {
      const filePath = writeLegacyFile([{ name: 'Kept', nodes: [], edges: [] }]);
      await migrations.importLegacyWorkflows({ ownerId: OWNER, filePath });
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('skips entries with no usable name', async () => {
      const filePath = writeLegacyFile([{ nodes: [], edges: [] }, { name: '   ' }]);
      const result = await migrations.importLegacyWorkflows({ ownerId: OWNER, filePath });
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
    });

    it('tolerates a corrupt file instead of crashing startup', async () => {
      const filePath = writeLegacyFile('{ this is not json');
      const result = await migrations.importLegacyWorkflows({ ownerId: OWNER, filePath });
      expect(result.imported).toBe(0);
    });

    it('reports nothing to do when the file is absent', async () => {
      const result = await migrations.importLegacyWorkflows({
        ownerId: OWNER,
        filePath: '/tmp/definitely-not-here-autoagent.json',
      });
      expect(result).toEqual({ imported: 0, skipped: 0, source: null });
    });
  });
});
