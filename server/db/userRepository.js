import crypto from 'crypto';
import { getPool, withTransaction } from './pool.js';
import { hashPassword } from '../auth/password.js';

/**
 * Data access for user accounts.
 *
 * A user owns exactly one `owners` row (the tenancy anchor every other table
 * scopes to). `owner_id` is the stable, opaque subject that goes into the
 * session and into every data query; the account's email/role/status live here.
 *
 * The credit wallet and the Free subscription that a new user needs are created
 * by the billing layer, not here — this module only owns the identity record.
 * Kept pure (no express, no logger); domain conflicts surface as typed errors.
 */

const MYSQL_DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

/** Raised when signing up with an email that already exists. */
export class EmailTakenError extends Error {
  constructor(email) {
    super(`An account with the email "${email}" already exists.`);
    this.name = 'EmailTakenError';
    this.email = email;
  }
}

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/** Public shape — never includes the password hash or the verification token. */
function mapPublic(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    email: row.email,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/** Normalise an email for storage and lookup. */
export function normalizeEmail(email) {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Create a user and its owning tenancy row in one transaction.
 *
 * @throws {EmailTakenError} when the email is already registered.
 */
export async function createUser({ email, password, role = 'user', ownerId, connection } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('createUser requires an email');
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('createUser requires a password');
  }

  const id = crypto.randomUUID();
  const owner = ownerId ?? id; // owner_id defaults to the user id — one tenant per user.
  const now = new Date();
  const passwordHash = hashPassword(password);
  const verificationToken = crypto.randomBytes(24).toString('base64url');

  const run = async (conn) => {
    await conn.query(
      'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
      [owner, now],
    );
    await conn.query(
      `INSERT INTO users
         (id, owner_id, email, password_hash, role, status, email_verified,
          email_verification_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
      [id, owner, normalized, passwordHash, role, verificationToken, now, now],
    );
  };

  try {
    if (connection) await run(connection);
    else await withTransaction(run);
  } catch (err) {
    if (err?.code === MYSQL_DUPLICATE_ENTRY) throw new EmailTakenError(normalized);
    throw err;
  }

  return { user: (await findUserById(id)) ?? null, verificationToken };
}

/** The full row incl. password hash — for the login path only. */
export async function findAuthByEmail(email) {
  const [rows] = await getPool().query(
    `SELECT id, owner_id, email, password_hash, role, status, email_verified,
            created_at, updated_at
       FROM users WHERE email = ? LIMIT 1`,
    [normalizeEmail(email)],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Public user by id, or null. */
export async function findUserById(id) {
  const [rows] = await getPool().query(
    `SELECT id, owner_id, email, role, status, email_verified, created_at, updated_at
       FROM users WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows.length > 0 ? mapPublic(rows[0]) : null;
}

/** Public user by owner_id (the session subject), or null. */
export async function findUserByOwnerId(ownerId) {
  const [rows] = await getPool().query(
    `SELECT id, owner_id, email, role, status, email_verified, created_at, updated_at
       FROM users WHERE owner_id = ? LIMIT 1`,
    [ownerId],
  );
  return rows.length > 0 ? mapPublic(rows[0]) : null;
}

/** Mark an account verified when the token matches. Returns the owner_id or null. */
export async function verifyEmailToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const [rows] = await getPool().query(
    'SELECT id, owner_id FROM users WHERE email_verification_token = ? LIMIT 1',
    [token],
  );
  if (rows.length === 0) return null;
  await getPool().query(
    `UPDATE users SET email_verified = 1, email_verification_token = NULL, updated_at = ?
       WHERE id = ?`,
    [new Date(), rows[0].id],
  );
  return rows[0].owner_id;
}

/** Total account count. Used to decide whether a bootstrap admin is needed. */
export async function countUsers() {
  const [rows] = await getPool().query('SELECT COUNT(*) AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

/** List accounts for the admin console, newest first. */
export async function listUsers({ limit = 50, search } = {}) {
  const safeLimit = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 500);
  if (search) {
    const [rows] = await getPool().query(
      `SELECT id, owner_id, email, role, status, email_verified, created_at, updated_at
         FROM users WHERE email LIKE ? ORDER BY created_at DESC LIMIT ?`,
      [`%${String(search).toLowerCase()}%`, safeLimit],
    );
    return rows.map(mapPublic);
  }
  const [rows] = await getPool().query(
    `SELECT id, owner_id, email, role, status, email_verified, created_at, updated_at
       FROM users ORDER BY created_at DESC LIMIT ?`,
    [safeLimit],
  );
  return rows.map(mapPublic);
}
