import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * Integration tests for the run-history repository against a real MySQL.
 *
 * What they verify — insert, per-workflow pruning, owner scoping, the
 * summary-counter refresh, and cascade-on-workflow-delete — is the database's
 * behaviour, so a fake would prove nothing.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

if (!mysqlAvailable) {
  console.warn('[runRepository.test] MySQL is not reachable; skipping run-history tests.');
}

const OWNER = 'operator';
const OTHER_OWNER = 'someone-else';

describe.skipIf(!mysqlAvailable)('run repository (MySQL)', () => {
  let pool;
  let repository;
  let runs;

  beforeAll(async () => {
    ({ pool, repository, runs } = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_runs` }));
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
    edges: [],
  });

  it('records a run as its own row with the observability fields', async () => {
    await repository.createWorkflow(OWNER, sampleInput('Scrape'));

    const record = await runs.recordRun(OWNER, 'Scrape', {
      status: 'completed',
      provider: 'openrouter',
      model: 'gpt-oss-120b',
      durationMs: 4200,
      nodeCount: 5,
      failureCount: 0,
      startedAt: '2026-09-17T10:00:00.000Z',
      finishedAt: '2026-09-17T10:00:04.200Z',
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.status).toBe('completed');
    expect(record.provider).toBe('openrouter');
    expect(record.model).toBe('gpt-oss-120b');
    expect(record.durationMs).toBe(4200);
    expect(record.nodeCount).toBe(5);
    expect(record.startedAt).toBe('2026-09-17T10:00:00.000Z');
    expect(record.finishedAt).toBe('2026-09-17T10:00:04.200Z');
  });

  it('carries the failure reason on a failed run', async () => {
    await repository.createWorkflow(OWNER, sampleInput('Flaky'));

    const record = await runs.recordRun(OWNER, 'Flaky', {
      status: 'failed',
      failureKind: 'auth',
      failureCount: 1,
      error: 'Gmail is not authenticated. Connect it first.',
    });

    expect(record.status).toBe('failed');
    expect(record.failureKind).toBe('auth');
    expect(record.failureCount).toBe(1);
    expect(record.error).toContain('not authenticated');
  });

  it('lists runs for a workflow most-recent-first', async () => {
    const wf = await repository.createWorkflow(OWNER, sampleInput('History'));

    await runs.recordRun(OWNER, 'History', { status: 'completed' });
    await runs.recordRun(OWNER, 'History', { status: 'failed' });
    await runs.recordRun(OWNER, 'History', { status: 'completed' });

    const list = await runs.listRuns(OWNER, { workflowId: wf.id });
    expect(list).toHaveLength(3);
    // The last recorded run is first.
    expect(list[0].status).toBe('completed');
    expect(list.every((r) => r.workflowId === wf.id)).toBe(true);
  });

  it('prunes to the retention cap per workflow', async () => {
    const wf = await repository.createWorkflow(OWNER, sampleInput('Busy'));
    const cap = runs.MAX_RUNS_PER_WORKFLOW;

    for (let i = 0; i < cap + 5; i += 1) {
      await runs.recordRun(OWNER, 'Busy', { status: 'completed' });
    }

    const list = await runs.listRuns(OWNER, { workflowId: wf.id, limit: cap + 50 });
    expect(list).toHaveLength(cap);
  });

  it('refreshes the workflow summary counters without bumping version', async () => {
    const created = await repository.createWorkflow(OWNER, sampleInput('Counted'));

    await runs.recordRun(OWNER, 'Counted', { status: 'completed', provider: 'openrouter' });
    await runs.recordRun(OWNER, 'Counted', { status: 'failed', provider: 'gemini' });

    const after = await repository.getWorkflowById(OWNER, created.id);
    expect(after.metadata.runCount).toBe(2);
    expect(after.metadata.lastExecutionStatus).toBe('failed');
    expect(after.metadata.lastRunAt).toBeTruthy();
    // A run is not an edit: the optimistic-lock version must not advance.
    expect(after.version).toBe(created.version);
    // The legacy bounded array must be gone.
    expect(after.metadata.runHistory).toBeUndefined();
  });

  it('returns null for an unknown workflow', async () => {
    expect(await runs.recordRun(OWNER, 'Nope', { status: 'completed' })).toBeNull();
  });

  it('does not leak another owner’s runs', async () => {
    await repository.createWorkflow(OWNER, sampleInput('Mine'));
    const theirs = await repository.createWorkflow(OTHER_OWNER, sampleInput('Theirs'));
    await runs.recordRun(OWNER, 'Mine', { status: 'completed' });
    await runs.recordRun(OTHER_OWNER, 'Theirs', { status: 'completed' });

    const mine = await runs.listRuns(OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0].workflowName).toBe('Mine');

    // Scoping by another owner's workflow id still yields nothing for me.
    const spoof = await runs.listRuns(OWNER, { workflowId: theirs.id });
    expect(spoof).toHaveLength(0);
  });

  it('drops a workflow’s runs when the workflow is deleted (cascade)', async () => {
    const wf = await repository.createWorkflow(OWNER, sampleInput('Doomed'));
    await runs.recordRun(OWNER, 'Doomed', { status: 'completed' });
    expect(await runs.listRuns(OWNER, { workflowId: wf.id })).toHaveLength(1);

    await repository.deleteWorkflowById(OWNER, wf.id);
    expect(await runs.listRuns(OWNER, { workflowId: wf.id })).toHaveLength(0);
  });
});
