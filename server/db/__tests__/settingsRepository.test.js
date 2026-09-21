import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * The settings store + config resolver.
 *
 * Guarantees:
 *   - a value round-trips through encrypt/decrypt (stored ciphertext, read back
 *     plaintext);
 *   - the ciphertext in the column is NOT the plaintext (encrypted at rest);
 *   - the resolver returns the DB value when set, else the env fallback;
 *   - clearing a setting falls back to env again.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let settings;
let settingsService;

beforeAll(async () => {
  if (!mysqlAvailable) return;
  const m = await loadDbModules(vi, {
    DB_NAME: `${TEST_DB_NAME}_settings`,
    // A known env fallback to assert DB-wins-else-env against.
    OPENAI_API_KEY: 'env-openai-key',
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'env-gemini-key',
  });
  pool = m.pool;
  settings = m.settings;
  settingsService = await import('../../config/settingsService.js');
  await settings.loadSettingsCache();
});

afterEach(async () => {
  if (mysqlAvailable && pool) {
    await truncateAll(pool);
    await settings.loadSettingsCache(); // reset cache to empty after truncate
  }
});

afterAll(async () => {
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

describe.skipIf(!mysqlAvailable)('settingsRepository encrypt/decrypt', () => {
  it('round-trips a value and stores it encrypted', async () => {
    await settings.setSetting('OPENAI_API_KEY', 'sk-live-secret-123', 'admin-1');

    expect(await settings.getSetting('OPENAI_API_KEY')).toBe('sk-live-secret-123');

    // The stored column must be ciphertext, not the plaintext.
    const [rows] = await pool
      .getPool()
      .query('SELECT value_enc, updated_by FROM app_settings WHERE setting_key = ?', [
        'OPENAI_API_KEY',
      ]);
    expect(rows[0].value_enc).not.toContain('sk-live-secret-123');
    expect(rows[0].value_enc).toMatch(/^v1\./);
    expect(rows[0].updated_by).toBe('admin-1');
  });

  it('clearing a setting deletes the row', async () => {
    await settings.setSetting('OPENAI_MODEL', 'gpt-4o', 'admin-1');
    expect(await settings.getSetting('OPENAI_MODEL')).toBe('gpt-4o');
    await settings.setSetting('OPENAI_MODEL', '', 'admin-1');
    expect(await settings.getSetting('OPENAI_MODEL')).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('config resolver (DB wins, else env)', () => {
  it('returns the env fallback when no DB override is set', async () => {
    expect(settingsService.resolveString('OPENAI_API_KEY')).toBe('env-openai-key');
    expect(settingsService.resolveProviderName()).toBe('gemini');
  });

  it('prefers the DB override once set, then falls back after clearing', async () => {
    await settings.setSetting('OPENAI_API_KEY', 'db-openai-key', 'admin-1');
    await settings.loadSettingsCache();
    expect(settingsService.resolveString('OPENAI_API_KEY')).toBe('db-openai-key');
    expect(settingsService.sourceOf('OPENAI_API_KEY')).toBe('db');

    await settings.setSetting('OPENAI_API_KEY', '', 'admin-1');
    await settings.loadSettingsCache();
    expect(settingsService.resolveString('OPENAI_API_KEY')).toBe('env-openai-key');
    expect(settingsService.sourceOf('OPENAI_API_KEY')).toBe('env');
  });

  it('overrides the active AI provider from the DB', async () => {
    await settings.setSetting('AI_PROVIDER', 'openai', 'admin-1');
    await settings.loadSettingsCache();
    expect(settingsService.resolveProviderName()).toBe('openai');
  });

  it('never returns a secret value through settingsStatus, only a mask', async () => {
    await settings.setSetting('RAZORPAY_KEY_SECRET', 'rzp-secret-abcd1234', 'admin-1');
    await settings.loadSettingsCache();
    const status = settingsService.settingsStatus();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('rzp-secret-abcd1234');
    const row = status.find((s) => s.key === 'RAZORPAY_KEY_SECRET');
    expect(row.configured).toBe(true);
    expect(row.masked).toBe('••••1234');
  });
});
