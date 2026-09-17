import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * MySQL connection pool.
 *
 * A single shared pool for the process. Created lazily so importing this module
 * (which tests and scripts do) never opens a socket on its own.
 */

let pool = null;

/** Connection settings, without the password, for safe logging. */
export function describeConnection() {
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    database: env.DB_NAME,
    ssl: env.DB_SSL,
  };
}

function buildPool({ database = env.DB_NAME } = {}) {
  return mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    // Fail rather than queue without bound: an unbounded queue turns a database
    // outage into a memory leak and a pile of requests that time out anyway.
    queueLimit: 50,
    // Keep sockets alive so a pooled connection is not silently dropped.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // Dates come back as strings; the app treats timestamps as ISO strings and
    // converting here would produce local-time surprises.
    dateStrings: true,
    // Interpret DATETIME columns as UTC in both directions. Without this, mysql2
    // converts an outbound JS Date to the server's local timezone and reads it
    // back as a naive string the app then labels 'Z' — so a stored instant comes
    // back shifted by the server's offset. Pinning to UTC keeps a round-tripped
    // timestamp faithful.
    timezone: 'Z',
    // Guards against a query hanging a request indefinitely.
    connectTimeout: 10_000,
    ...(env.DB_SSL ? { ssl: { minVersion: 'TLSv1.2' } } : {}),
  });
}

/** Get (or lazily create) the shared pool. */
export function getPool() {
  if (!pool) pool = buildPool();
  return pool;
}

/**
 * Run a callback inside a transaction, committing on success and rolling back on
 * any error. Used for every multi-statement write so a partial write cannot be
 * left behind.
 */
export async function withTransaction(fn) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'transaction rollback failed');
    }
    throw err;
  } finally {
    connection.release();
  }
}

/** Close the pool. Called on shutdown and between test suites. */
export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

/**
 * Create the configured database if it does not exist.
 *
 * Connects with no database selected, because you cannot create a schema from
 * inside it. Identifier is validated rather than interpolated blindly: a
 * database name cannot be a bound parameter in `CREATE DATABASE`.
 */
export async function ensureDatabaseExists() {
  if (!/^[A-Za-z0-9_]+$/.test(env.DB_NAME)) {
    throw new Error(
      `DB_NAME "${env.DB_NAME}" is not a valid identifier (letters, digits and underscore only).`,
    );
  }

  const bootstrap = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectTimeout: 10_000,
    ...(env.DB_SSL ? { ssl: { minVersion: 'TLSv1.2' } } : {}),
  });

  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\` ` +
        'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    );
  } finally {
    await bootstrap.end();
  }
}

/** True when the database is reachable. Used by /readyz and by tests. */
export async function isDatabaseReachable() {
  try {
    const [rows] = await getPool().query('SELECT 1 AS ok');
    return rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}
