import { getPool, withTransaction } from './pool.js';

/**
 * Data access for saved workflows.
 *
 * Replaces the previous JSON file store, which read the entire array, mutated it
 * in memory, and rewrote the whole file on every save. Two concurrent saves
 * therefore lost one of the writes outright. Here each workflow is a row, writes
 * are per-row and transactional, and a same-row conflict is reported rather than
 * silently overwritten.
 */

/** Raised when an update targets a version that is no longer current. */
export class WorkflowConflictError extends Error {
  constructor(currentVersion) {
    super('This workflow was changed by someone else since you loaded it.');
    this.name = 'WorkflowConflictError';
    this.currentVersion = currentVersion;
  }
}

/** Raised when a name is already taken by another workflow for the same owner. */
export class WorkflowNameTakenError extends Error {
  constructor(name) {
    super(`You already have a workflow named "${name}".`);
    this.name = 'WorkflowNameTakenError';
    this.workflowName = name;
  }
}

const MYSQL_DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

/**
 * MySQL returns JSON columns already parsed, but a column written as a string by
 * an older client can come back as a string. Normalise both.
 */
function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toIsoString(value) {
  if (!value) return null;
  // `dateStrings: true` gives 'YYYY-MM-DD HH:MM:SS.mmm' in UTC.
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/** Shape returned to the API layer. */
function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    nodes: parseJsonColumn(row.nodes, []),
    edges: parseJsonColumn(row.edges, []),
    initialState: parseJsonColumn(row.initial_state, undefined),
    metadata: parseJsonColumn(row.metadata, {}),
    version: row.version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    // Kept for compatibility with clients that read `savedAt`.
    savedAt: toIsoString(row.updated_at),
  };
}

/** Ensure the owner row exists so the workflow foreign key can be satisfied. */
export async function ensureOwner(ownerId, connection = getPool()) {
  await connection.query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [ownerId, new Date()],
  );
}

/** List an owner's workflows, most recently updated first. */
export async function listWorkflows(ownerId) {
  const [rows] = await getPool().query(
    `SELECT id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at
       FROM workflows
      WHERE owner_id = ?
      ORDER BY updated_at DESC`,
    [ownerId],
  );
  return rows.map(mapRow);
}

/** Fetch one workflow, scoped to its owner so ids are not cross-readable. */
export async function getWorkflowById(ownerId, id) {
  const [rows] = await getPool().query(
    `SELECT id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at
       FROM workflows
      WHERE owner_id = ? AND id = ?
      LIMIT 1`,
    [ownerId, id],
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Fetch one workflow by name. Supports clients that still address by name. */
export async function getWorkflowByName(ownerId, name) {
  const [rows] = await getPool().query(
    `SELECT id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at
       FROM workflows
      WHERE owner_id = ? AND name = ?
      LIMIT 1`,
    [ownerId, name],
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Create a workflow.
 * @throws {WorkflowNameTakenError} when the owner already has that name.
 */
export async function createWorkflow(ownerId, input) {
  const id = crypto.randomUUID();
  const now = new Date();

  try {
    await withTransaction(async (connection) => {
      await ensureOwner(ownerId, connection);
      await connection.query(
        `INSERT INTO workflows
           (id, owner_id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          ownerId,
          input.name,
          JSON.stringify(input.nodes ?? []),
          JSON.stringify(input.edges ?? []),
          input.initialState === undefined ? null : JSON.stringify(input.initialState),
          JSON.stringify(input.metadata ?? {}),
          now,
          now,
        ],
      );
    });
  } catch (err) {
    if (err?.code === MYSQL_DUPLICATE_ENTRY) throw new WorkflowNameTakenError(input.name);
    throw err;
  }

  return getWorkflowById(ownerId, id);
}

/**
 * Update a workflow using optimistic locking.
 *
 * `expectedVersion` is the version the caller read. The UPDATE only matches while
 * that is still current, so a concurrent edit results in a reported conflict
 * rather than one user's work vanishing.
 *
 * @throws {WorkflowConflictError} when the row moved on.
 * @throws {WorkflowNameTakenError} when renaming onto an existing name.
 */
export async function updateWorkflow(ownerId, id, input, expectedVersion) {
  return withTransaction(async (connection) => {
    // Lock the row for the duration of the transaction so the check and the
    // write cannot interleave with another writer.
    const [existingRows] = await connection.query(
      'SELECT version FROM workflows WHERE owner_id = ? AND id = ? FOR UPDATE',
      [ownerId, id],
    );
    if (existingRows.length === 0) return null;

    const currentVersion = existingRows[0].version;
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (Number(expectedVersion) !== Number(currentVersion)) {
        throw new WorkflowConflictError(currentVersion);
      }
    }

    const sets = [];
    const params = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(input.name);
    }
    if (input.nodes !== undefined) {
      sets.push('nodes = ?');
      params.push(JSON.stringify(input.nodes));
    }
    if (input.edges !== undefined) {
      sets.push('edges = ?');
      params.push(JSON.stringify(input.edges));
    }
    if (input.initialState !== undefined) {
      sets.push('initial_state = ?');
      params.push(input.initialState === null ? null : JSON.stringify(input.initialState));
    }
    if (input.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(input.metadata));
    }

    sets.push('version = version + 1');
    sets.push('updated_at = ?');
    params.push(new Date());

    try {
      await connection.query(
        `UPDATE workflows SET ${sets.join(', ')} WHERE owner_id = ? AND id = ? AND version = ?`,
        [...params, ownerId, id, currentVersion],
      );
    } catch (err) {
      if (err?.code === MYSQL_DUPLICATE_ENTRY) throw new WorkflowNameTakenError(input.name);
      throw err;
    }

    const [rows] = await connection.query(
      `SELECT id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at
         FROM workflows WHERE owner_id = ? AND id = ? LIMIT 1`,
      [ownerId, id],
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  });
}

/**
 * Create or replace a workflow addressed by name.
 *
 * This is what the canvas "Save" button needs: the user names a workflow and
 * expects saving again to overwrite it. Implemented as a single atomic upsert, so
 * concurrent saves of DIFFERENT workflows can never lose each other the way the
 * whole-file rewrite did.
 */
export async function upsertWorkflowByName(ownerId, input) {
  const now = new Date();

  await withTransaction(async (connection) => {
    await ensureOwner(ownerId, connection);
    await connection.query(
      `INSERT INTO workflows
         (id, owner_id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         nodes         = VALUES(nodes),
         edges         = VALUES(edges),
         initial_state = VALUES(initial_state),
         metadata      = VALUES(metadata),
         version       = version + 1,
         updated_at    = VALUES(updated_at)`,
      [
        crypto.randomUUID(),
        ownerId,
        input.name,
        JSON.stringify(input.nodes ?? []),
        JSON.stringify(input.edges ?? []),
        input.initialState === undefined ? null : JSON.stringify(input.initialState),
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      ],
    );
  });

  return getWorkflowByName(ownerId, input.name);
}

/** Delete by id. @returns true when a row was removed. */
export async function deleteWorkflowById(ownerId, id) {
  const [result] = await getPool().query('DELETE FROM workflows WHERE owner_id = ? AND id = ?', [
    ownerId,
    id,
  ]);
  return result.affectedRows > 0;
}

/** Delete by name. @returns true when a row was removed. */
export async function deleteWorkflowByName(ownerId, name) {
  const [result] = await getPool().query('DELETE FROM workflows WHERE owner_id = ? AND name = ?', [
    ownerId,
    name,
  ]);
  return result.affectedRows > 0;
}

/**
 * Append a run record to a workflow's metadata.
 *
 * Read-modify-write of one JSON column inside a transaction with the row locked,
 * so two runs finishing at once cannot drop each other's entry.
 */
export async function recordRun(ownerId, name, { status, provider }) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query(
      'SELECT metadata, version FROM workflows WHERE owner_id = ? AND name = ? FOR UPDATE',
      [ownerId, name],
    );
    if (rows.length === 0) return null;

    const metadata = parseJsonColumn(rows[0].metadata, {}) ?? {};
    const history = Array.isArray(metadata.runHistory) ? metadata.runHistory : [];

    const nextMetadata = {
      ...metadata,
      provider: provider ?? metadata.provider ?? 'unknown',
      lastExecutionStatus: status,
      lastRunAt: new Date().toISOString(),
      runCount: Number(metadata.runCount ?? 0) + 1,
      // Bounded so metadata cannot grow without limit. Task 16 moves full run
      // history into its own table.
      runHistory: [
        ...history,
        { status, provider: provider ?? 'unknown', timestamp: new Date().toISOString() },
      ].slice(-20),
    };

    await connection.query(
      'UPDATE workflows SET metadata = ?, updated_at = ? WHERE owner_id = ? AND name = ?',
      [JSON.stringify(nextMetadata), new Date(), ownerId, name],
    );

    return nextMetadata;
  });
}
