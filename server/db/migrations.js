import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './pool.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_JSON_PATH = path.resolve(__dirname, '..', 'data', 'workflows.json');

/**
 * Ordered schema migrations.
 *
 * Append-only: never edit an applied migration, add a new one. Each runs once
 * and is recorded in `schema_migrations`, so a deployment converges to the same
 * schema regardless of which version it started from.
 */
const MIGRATIONS = [
  {
    id: '001_create_owners',
    statements: [
      `CREATE TABLE IF NOT EXISTS owners (
         id           VARCHAR(64)  NOT NULL,
         created_at   DATETIME(3)  NOT NULL,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '002_create_workflows',
    statements: [
      // `name` is unique PER OWNER, not globally, so two operators can each
      // have a workflow called "Lead follow-up".
      //
      // `version` powers optimistic locking: an update must state the version it
      // read, so a concurrent edit is reported instead of silently overwritten.
      `CREATE TABLE IF NOT EXISTS workflows (
         id            CHAR(36)     NOT NULL,
         owner_id      VARCHAR(64)  NOT NULL,
         name          VARCHAR(255) NOT NULL,
         nodes         JSON         NOT NULL,
         edges         JSON         NOT NULL,
         initial_state JSON         NULL,
         metadata      JSON         NULL,
         version       INT UNSIGNED NOT NULL DEFAULT 1,
         created_at    DATETIME(3)  NOT NULL,
         updated_at    DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_workflows_owner_name (owner_id, name),
         KEY idx_workflows_owner_updated (owner_id, updated_at),
         CONSTRAINT fk_workflows_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '003_create_tool_credentials',
    statements: [
      // OAuth tokens for connected tools, one row per owner per tool.
      //
      // The browser used to hold these in localStorage in plain text. They live
      // here now, and both token columns are AES-256-GCM ciphertext (see
      // `credentialCrypto.js`) so a database dump does not contain usable Google
      // credentials. The columns are TEXT because the encrypted envelope is
      // several times longer than the token and Google does not bound token
      // length.
      `CREATE TABLE IF NOT EXISTS tool_credentials (
         owner_id           VARCHAR(64)  NOT NULL,
         tool_id            VARCHAR(64)  NOT NULL,
         provider           VARCHAR(32)  NOT NULL,
         access_token_enc   TEXT         NOT NULL,
         refresh_token_enc  TEXT         NULL,
         expires_at         DATETIME(3)  NULL,
         scopes             JSON         NOT NULL,
         connected_at       DATETIME(3)  NOT NULL,
         updated_at         DATETIME(3)  NOT NULL,
         PRIMARY KEY (owner_id, tool_id),
         CONSTRAINT fk_tool_credentials_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
];

/** Ensure the bookkeeping table exists before anything else. */
async function ensureMigrationsTable(connection) {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         VARCHAR(191) NOT NULL,
       applied_at DATETIME(3)  NOT NULL,
       PRIMARY KEY (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );
}

/**
 * Apply any migrations that have not run yet.
 * @returns the ids that were applied during this call.
 */
export async function runMigrations() {
  const pool = getPool();
  await ensureMigrationsTable(pool);

  const [appliedRows] = await pool.query('SELECT id FROM schema_migrations');
  const applied = new Set(appliedRows.map((row) => row.id));
  const justApplied = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    // DDL in MySQL is not transactional, so each migration is recorded
    // immediately after its statements succeed. Statements are written to be
    // idempotent (IF NOT EXISTS) so a partial failure can be retried safely.
    for (const statement of migration.statements) {
      await pool.query(statement);
    }
    await pool.query('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      migration.id,
      new Date(),
    ]);

    justApplied.push(migration.id);
    logger.info({ migration: migration.id }, 'applied database migration');
  }

  return justApplied;
}

/**
 * One-time import of the legacy `server/data/workflows.json` file.
 *
 * The old store was a single JSON array keyed by name, rewritten in full on every
 * save. Rows are inserted with `INSERT IGNORE` so re-running this never clobbers
 * anything already in the database, and the source file is left untouched so the
 * operator can verify before deleting it.
 *
 * @returns {Promise<{ imported: number, skipped: number, source: string|null }>}
 */
export async function importLegacyWorkflows({ ownerId, filePath = LEGACY_JSON_PATH } = {}) {
  if (!ownerId) throw new Error('importLegacyWorkflows requires an ownerId');

  if (!fs.existsSync(filePath)) {
    return { imported: 0, skipped: 0, source: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.warn({ err, filePath }, 'legacy workflow file is not valid JSON; skipping import');
    return { imported: 0, skipped: 0, source: filePath };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { imported: 0, skipped: 0, source: filePath };
  }

  const pool = getPool();
  await pool.query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [ownerId, new Date()],
  );

  let imported = 0;
  let skipped = 0;

  for (const entry of parsed) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      skipped += 1;
      continue;
    }

    const now = new Date();
    const savedAt = entry.savedAt ? new Date(entry.savedAt) : now;
    const createdAt = Number.isNaN(savedAt.getTime()) ? now : savedAt;

    const [result] = await pool.query(
      `INSERT IGNORE INTO workflows
         (id, owner_id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        ownerId,
        name.slice(0, 255),
        JSON.stringify(Array.isArray(entry.nodes) ? entry.nodes : []),
        JSON.stringify(Array.isArray(entry.edges) ? entry.edges : []),
        entry.initialState ? JSON.stringify(entry.initialState) : null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        1,
        createdAt,
        createdAt,
      ],
    );

    if (result.affectedRows === 1) imported += 1;
    else skipped += 1;
  }

  if (imported > 0 || skipped > 0) {
    logger.info(
      { imported, skipped, source: filePath },
      'legacy workflow import finished (source file left in place)',
    );
  }

  return { imported, skipped, source: filePath };
}

/** Migration ids, for tests and diagnostics. */
export const MIGRATION_IDS = MIGRATIONS.map((m) => m.id);
