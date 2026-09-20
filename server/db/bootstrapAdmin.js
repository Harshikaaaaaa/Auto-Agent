import { getPool } from './pool.js';
import { createUser } from './userRepository.js';
import { grantSignupCredits } from '../billing/signupGrant.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Move the app from single-operator to multi-user without losing data.
 *
 * The app began with a shared password whose session subject was the literal
 * 'operator', and every workflow / Google credential / run is scoped to that
 * owner_id. This creates the FIRST admin *user* bound to that same
 * owner_id='operator' row, so all of that existing data becomes the admin's the
 * moment accounts exist — nothing is orphaned or re-owned.
 *
 * Runs only when: there are zero users AND an ADMIN_BOOTSTRAP_EMAIL and
 * APP_PASSWORD are configured. It is a no-op afterwards (once a user exists),
 * and never overwrites an existing account. When the prerequisites are missing
 * it logs and skips rather than failing boot — a fresh install simply signs up
 * its first user through the normal flow.
 *
 * @returns {Promise<{ created: boolean, reason?: string }>}
 */
export async function bootstrapAdminIfNeeded() {
  const [rows] = await getPool().query('SELECT COUNT(*) AS n FROM users');
  const userCount = Number(rows[0]?.n ?? 0);
  if (userCount > 0) return { created: false, reason: 'users_exist' };

  const email = env.ADMIN_BOOTSTRAP_EMAIL;
  const password = env.APP_PASSWORD;
  if (!email || !password) {
    logger.info(
      'no users yet and ADMIN_BOOTSTRAP_EMAIL/APP_PASSWORD not both set; ' +
        'skipping admin bootstrap — sign up the first account through /api/auth/signup',
    );
    return { created: false, reason: 'not_configured' };
  }

  // Reuse the legacy 'operator' owner_id so its existing data is inherited.
  const OPERATOR_OWNER = 'operator';
  try {
    await createUser({ email, password, role: 'admin', ownerId: OPERATOR_OWNER });
    await grantSignupCredits(OPERATOR_OWNER);
    logger.info({ email }, 'bootstrapped first admin user (inherited operator data)');
    return { created: true };
  } catch (err) {
    if (err?.name === 'EmailTakenError') return { created: false, reason: 'email_taken' };
    logger.error({ err }, 'admin bootstrap failed');
    return { created: false, reason: 'error' };
  }
}
