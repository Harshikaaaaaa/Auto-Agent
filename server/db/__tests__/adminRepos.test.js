import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * The admin CRUD repo methods added for the console: user role/status, plan +
 * package + coupon updates. Each returns the updated row and rejects bad input.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let users;
let subscriptions;
let packages;
let coupons;

beforeAll(async () => {
  if (!mysqlAvailable) return;
  const m = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_adminrepos` });
  pool = m.pool;
  users = m.users;
  subscriptions = m.subscriptions;
  packages = m.packages;
  coupons = m.coupons;
});

afterEach(async () => {
  if (mysqlAvailable && pool) await truncateAll(pool);
});

afterAll(async () => {
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

describe.skipIf(!mysqlAvailable)('userRepository role/status', () => {
  it('sets role and status, and rejects unknown values', async () => {
    const { user } = await users.createUser({ email: 'r@example.com', password: 'pw12345678' });

    const asAdmin = await users.setUserRole(user.ownerId, 'admin');
    expect(asAdmin.role).toBe('admin');

    const suspended = await users.setUserStatus(user.ownerId, 'suspended');
    expect(suspended.status).toBe('suspended');

    await expect(users.setUserRole(user.ownerId, 'root')).rejects.toThrow();
    await expect(users.setUserStatus(user.ownerId, 'frozen')).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('plan / package / coupon updates', () => {
  it('creates + updates a plan (integer-safe)', async () => {
    const created = await subscriptions.createPlan({
      code: `p_${Date.now().toString(36)}`,
      displayName: 'Repo plan',
      pricePaise: 10000,
      includedCredits: 5000,
    });
    const updated = await subscriptions.updatePlan(created.id, {
      pricePaise: 20000,
      enabled: false,
    });
    expect(updated.pricePaise).toBe(20000);
    expect(updated.enabled).toBe(false);
  });

  it('creates + updates a package', async () => {
    const created = await packages.createPackage({
      code: `pk_${Date.now().toString(36)}`,
      displayName: 'Repo pack',
      pricePaise: 9900,
      credits: 10000,
    });
    const updated = await packages.updatePackage(created.id, { bonusCredits: 500, enabled: false });
    expect(updated.bonusCredits).toBe(500);
    expect(updated.enabled).toBe(false);
  });

  it('creates + updates a coupon', async () => {
    const created = await coupons.createCoupon({
      code: `C_${Date.now().toString(36)}`,
      couponType: 'percentage',
      percentBps: 1500,
    });
    const off = await coupons.updateCoupon(created.id, { enabled: false, maxRedemptions: 100 });
    expect(off.enabled).toBe(false);
    expect(off.maxRedemptions).toBe(100);
  });
});
