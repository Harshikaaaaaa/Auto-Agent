import crypto from 'crypto';

/**
 * Password hashing for user accounts.
 *
 * Uses Node's built-in scrypt (a memory-hard KDF) rather than pulling in a
 * native bcrypt/argon2 dependency: scrypt is in the standard library, needs no
 * build toolchain in the container image or CI, and is a sound password hash
 * when parameterised well. The same primitive already derives the AES key for
 * OAuth-token encryption (server/lib/credentialCrypto.js), so it is a known
 * quantity in this codebase.
 *
 * Stored format is self-describing so parameters can change later without
 * invalidating old hashes:  `scrypt$N$r$p$<saltB64>$<hashB64>`.
 */

// OWASP-recommended scrypt parameters (N=2^17). Encoded into the stored hash so
// a future increase does not strand existing rows.
const N = 1 << 17;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/** Hash a plaintext password. Returns the self-describing encoded string. */
export function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword requires a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(plain, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Constant-time comparison, and never throws on a malformed stored value — a
 * corrupt hash simply fails to verify.
 */
export function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = crypto.scryptSync(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}
