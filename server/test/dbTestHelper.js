import mysql from 'mysql2/promise';

/**
 * Test support for the MySQL-backed persistence layer.
 *
 * These are integration tests against a real MySQL, because the behaviour being
 * verified — transactions, unique constraints, row locking, optimistic locking —
 * is the database's behaviour. A fake would prove nothing about it.
 *
 * When no MySQL is reachable the suites skip rather than fail, so a contributor
 * without a local server still gets a green run. CI runs a MySQL service
 * container, so they do execute there.
 */

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'autoagent_test';

const connectionSettings = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  connectTimeout: 3000,
};

/** Whether a MySQL server is reachable with the configured credentials. */
export async function isMysqlAvailable() {
  let connection;
  try {
    connection = await mysql.createConnection(connectionSettings);
    await connection.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
}

/**
 * Point the env module at the test database and load the db modules fresh.
 *
 * env.js validates and freezes on import, so process.env has to be set before
 * the module graph is imported. `vi.resetModules()` is the caller's job.
 */
export async function loadDbModules(vi, overrides = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'f'.repeat(64),
    LOG_LEVEL: 'silent',
    DB_HOST: connectionSettings.host,
    DB_PORT: String(connectionSettings.port),
    DB_USER: connectionSettings.user,
    DB_PASSWORD: connectionSettings.password,
    DB_NAME: TEST_DB_NAME,
    // Present so credentialCrypto can derive its key when a suite touches the
    // credential repository. Harmless for the workflow suites that ignore it.
    CREDENTIAL_SECRET: 'test-credential-secret-padded-to-thirty-two-chars',
    ...overrides,
  });

  vi.resetModules();

  const pool = await import('../db/pool.js');
  const migrations = await import('../db/migrations.js');
  const repository = await import('../db/workflowRepository.js');
  const credentials = await import('../db/credentialRepository.js');
  const runs = await import('../db/runRepository.js');

  await pool.ensureDatabaseExists();
  await migrations.runMigrations();

  return { pool, migrations, repository, credentials, runs };
}

/**
 * Remove all rows between tests.
 * Deleting owners cascades to workflows, so ordering is handled by the schema.
 */
export async function truncateAll(pool) {
  // workflow_runs and tool_credentials both cascade from owners, but are deleted
  // explicitly (before workflows/owners) so the helper does not depend on
  // migrations 003/004 having run in a given suite.
  await pool.getPool().query('DELETE FROM workflow_runs');
  await pool.getPool().query('DELETE FROM tool_credentials');
  await pool.getPool().query('DELETE FROM workflows');
  await pool.getPool().query('DELETE FROM owners');
}

/** Restore the ambient environment after a suite. */
export function restoreEnv(original) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
}
