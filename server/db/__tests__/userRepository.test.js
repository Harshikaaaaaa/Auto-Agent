import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let users;
let signupGrant;

beforeAll(async () => {
  if (!mysqlAvailable) {
    console.warn('[userRepository.test] MySQL not reachable — skipping');
    return;
  }
  const modules = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_users` });
  pool = modules.pool;
  users = modules.users;
  signupGrant = modules.signupGrant;
});

afterEach(async () => {
  if (mysqlAvailable && pool) await truncateAll(pool);
});

afterAll(async () => {
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

describe.skipIf(!mysqlAvailable)('userRepository', () => {
  it('creates a user and finds it by email, id, and owner', async () => {
    const { user } = await users.createUser({
      email: 'Alice@Example.com',
      password: 'hunter2hunter2',
    });
    expect(user.email).toBe('alice@example.com'); // normalized
    expect(user.role).toBe('user');

    const byId = await users.findUserById(user.id);
    expect(byId?.email).toBe('alice@example.com');

    const byOwner = await users.findUserByOwnerId(user.ownerId);
    expect(byOwner?.id).toBe(user.id);

    const auth = await users.findAuthByEmail('alice@example.com');
    expect(auth?.password_hash).toBeTruthy();
    expect(auth?.owner_id).toBe(user.ownerId);
  });

  it('rejects a duplicate email with EmailTakenError', async () => {
    await users.createUser({ email: 'dup@example.com', password: 'hunter2hunter2' });
    await expect(
      users.createUser({ email: 'dup@example.com', password: 'another-one-here' }),
    ).rejects.toMatchObject({ name: 'EmailTakenError' });
  });

  it('verifies an email via its token exactly once', async () => {
    const { user, verificationToken } = await users.createUser({
      email: 'verify@example.com',
      password: 'hunter2hunter2',
    });
    expect((await users.findUserById(user.id)).emailVerified).toBe(false);

    const owner = await users.verifyEmailToken(verificationToken);
    expect(owner).toBe(user.ownerId);
    expect((await users.findUserById(user.id)).emailVerified).toBe(true);

    // Token is consumed — a second use fails.
    expect(await users.verifyEmailToken(verificationToken)).toBeNull();
  });

  it('lists and counts users, and searches by email', async () => {
    await users.createUser({ email: 'a@example.com', password: 'hunter2hunter2', role: 'admin' });
    await users.createUser({ email: 'b@example.com', password: 'hunter2hunter2' });
    expect(await users.countUsers()).toBe(2);
    const all = await users.listUsers();
    expect(all).toHaveLength(2);
    const found = await users.listUsers({ search: 'a@' });
    expect(found.map((u) => u.email)).toContain('a@example.com');
  });

  it('provisions a wallet with signup credits and a Free subscription', async () => {
    const { user } = await users.createUser({
      email: 'wallet@example.com',
      password: 'hunter2hunter2',
    });
    const result = await signupGrant.grantSignupCredits(user.ownerId);
    expect(result.alreadyProvisioned).toBe(false);

    const [walletRows] = await pool
      .getPool()
      .query('SELECT bonus_credits FROM credit_wallets WHERE owner_id = ?', [user.ownerId]);
    expect(Number(walletRows[0].bonus_credits)).toBe(1000); // SIGNUP_FREE_CREDITS default

    const [ledgerRows] = await pool
      .getPool()
      .query('SELECT transaction_type, credits FROM credit_transactions WHERE owner_id = ?', [
        user.ownerId,
      ]);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].transaction_type).toBe('BONUS');
    expect(Number(ledgerRows[0].credits)).toBe(1000);

    // Re-running is idempotent: no second wallet, no double grant.
    const again = await signupGrant.grantSignupCredits(user.ownerId);
    expect(again.alreadyProvisioned).toBe(true);
  });

  it('seeds the four plans and five packages', async () => {
    const [plans] = await pool.getPool().query('SELECT code FROM subscription_plans');
    expect(plans.map((p) => p.code).sort()).toEqual(['business', 'free', 'pro', 'starter']);
    const [packages] = await pool.getPool().query('SELECT COUNT(*) AS n FROM credit_packages');
    expect(Number(packages[0].n)).toBe(5);
  });
});
