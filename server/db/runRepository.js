import { getPool, withTransaction } from './pool.js';

/**
 * Data access for workflow run history.
 *
 * Run history used to be a 20-entry JSON array nested in `workflows.metadata`
 * (see the old `recordRun` in workflowRepository.js): write-only, lossy, and
 * unbounded per workflow only by truncation. Runs are their own rows now, in the
 * `workflow_runs` table (migration 004), so a run is a first-class record with a
 * duration, node/failure counts, and a failure reason — the things an operator
 * needs to answer "what happened on the last run".
 */

/** How many runs to retain per workflow. Older rows are pruned after each insert. */
export const MAX_RUNS_PER_WORKFLOW = 50;

const RUN_STATUSES = new Set(['completed', 'failed', 'running', 'cancelled']);

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/** Parse a DATETIME(3) string / Date into a Date, or null when unusable. */
function toDate(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(value);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

/** Clamp a value to a non-negative integer, or null. */
function toUintOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 4_294_967_295);
}

/** The public shape returned to the API layer. Never leaks internal columns. */
function mapRow(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status,
    provider: row.provider ?? null,
    model: row.model ?? null,
    durationMs: row.duration_ms ?? null,
    nodeCount: row.node_count ?? null,
    failureCount: row.failure_count ?? null,
    failureKind: row.failure_kind ?? null,
    error: row.error ?? null,
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
    createdAt: toIsoString(row.created_at),
  };
}

/**
 * Record one run against a saved workflow, looked up by owner + name.
 *
 * Best effort from the caller's point of view: a run already happened, so the
 * server never fails a request because it could not annotate it — but the route
 * still surfaces "no such workflow" so an unsaved workflow is not silently lost.
 *
 * Also refreshes the lightweight summary counters on `workflows.metadata`
 * (`runCount`, `lastRunAt`, `lastExecutionStatus`) so existing GET responses keep
 * carrying them without a join. The bounded 20-entry `runHistory` array is NOT
 * written any more — the rows below are the record.
 *
 * @returns the inserted run (mapped), or null when the workflow does not exist.
 */
export async function recordRun(ownerId, name, run = {}) {
  const status = RUN_STATUSES.has(run.status) ? run.status : 'completed';

  return withTransaction(async (connection) => {
    const [rows] = await connection.query(
      'SELECT id, metadata FROM workflows WHERE owner_id = ? AND name = ? FOR UPDATE',
      [ownerId, name],
    );
    if (rows.length === 0) return null;

    const workflowId = rows[0].id;
    const id = crypto.randomUUID();
    const now = new Date();
    const startedAt = toDate(run.startedAt);
    const finishedAt = toDate(run.finishedAt) ?? now;

    await connection.query(
      `INSERT INTO workflow_runs
         (id, workflow_id, owner_id, workflow_name, status, provider, model,
          duration_ms, node_count, failure_count, failure_kind, error,
          started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workflowId,
        ownerId,
        name.slice(0, 255),
        status,
        run.provider ? String(run.provider).slice(0, 120) : null,
        run.model ? String(run.model).slice(0, 120) : null,
        toUintOrNull(run.durationMs),
        toUintOrNull(run.nodeCount),
        toUintOrNull(run.failureCount),
        run.failureKind ? String(run.failureKind).slice(0, 40) : null,
        run.error ? String(run.error).slice(0, 500) : null,
        startedAt,
        finishedAt,
        now,
      ],
    );

    // Prune to the most recent MAX_RUNS_PER_WORKFLOW so history cannot grow
    // without bound. Delete by anti-join against the newest ids rather than an
    // OFFSET, which MySQL does not allow inside a DELETE subquery on the same
    // table without the wrapping derived table.
    await connection.query(
      `DELETE FROM workflow_runs
        WHERE workflow_id = ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM workflow_runs
               WHERE workflow_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?
            ) AS keep
          )`,
      [workflowId, workflowId, MAX_RUNS_PER_WORKFLOW],
    );

    // Refresh the summary counters kept on the workflow for at-a-glance reads.
    // updated_at is intentionally NOT touched: a run is not an edit, and bumping
    // it would reorder the workflow list on every execution.
    const metadata = parseMetadata(rows[0].metadata);
    const nextMetadata = {
      ...metadata,
      provider: run.provider ?? metadata.provider ?? 'unknown',
      lastExecutionStatus: status,
      lastRunAt: finishedAt.toISOString(),
      runCount: Number(metadata.runCount ?? 0) + 1,
    };
    // Drop the legacy bounded array; the rows are the record now.
    delete nextMetadata.runHistory;

    await connection.query('UPDATE workflows SET metadata = ? WHERE id = ?', [
      JSON.stringify(nextMetadata),
      workflowId,
    ]);

    const [inserted] = await connection.query(
      `SELECT id, workflow_id, owner_id, workflow_name, status, provider, model,
              duration_ms, node_count, failure_count, failure_kind, error,
              started_at, finished_at, created_at
         FROM workflow_runs WHERE id = ?`,
      [id],
    );
    return inserted.length > 0 ? mapRow(inserted[0]) : null;
  });
}

function parseMetadata(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) ?? {};
  } catch {
    return {};
  }
}

/**
 * List runs for an owner, most recent first.
 *
 * @param {string} ownerId
 * @param {{ workflowId?: string, limit?: number }} [opts]
 *        When `workflowId` is given, scoped to that workflow (still owner-checked).
 */
export async function listRuns(ownerId, { workflowId, limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Math.round(Number(limit) || 25), 1), 200);
  const pool = getPool();

  const columns = `id, workflow_id, owner_id, workflow_name, status, provider, model,
                   duration_ms, node_count, failure_count, failure_kind, error,
                   started_at, finished_at, created_at`;

  if (workflowId) {
    const [rows] = await pool.query(
      `SELECT ${columns} FROM workflow_runs
        WHERE owner_id = ? AND workflow_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [ownerId, workflowId, safeLimit],
    );
    return rows.map(mapRow);
  }

  const [rows] = await pool.query(
    `SELECT ${columns} FROM workflow_runs
      WHERE owner_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [ownerId, safeLimit],
  );
  return rows.map(mapRow);
}
