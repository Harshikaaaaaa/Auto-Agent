import { getPool } from './pool.js';
import { decryptSecret, encryptSecret } from '../lib/credentialCrypto.js';
import { logger } from '../lib/logger.js';

/**
 * Storage for admin-managed runtime settings (migration 008).
 *
 * Every value is encrypted at rest with AES-256-GCM (see credentialCrypto.js),
 * so a database dump never contains a usable API key. Values go in and out of
 * this module in plaintext; the ciphertext never leaves it.
 *
 * A small in-process cache lets the synchronous config resolver
 * (server/config/settingsService.js) read a DB override without an await on the
 * hot path. The cache is:
 *   - populated by loadSettingsCache() at boot,
 *   - refreshed (that one key) on every write,
 * so a running process always sees its own writes immediately. In the
 * single-container deployment this is authoritative; a future multi-instance
 * deployment would add a short TTL or pub/sub — noted, not needed today.
 */

/** setting_key -> plaintext value. Empty until loadSettingsCache() runs. */
const cache = new Map();
let cacheLoaded = false;

/** Read + decrypt every setting into the in-process cache. Best-effort. */
export async function loadSettingsCache() {
  try {
    const [rows] = await getPool().query('SELECT setting_key, value_enc FROM app_settings');
    cache.clear();
    for (const row of rows) {
      try {
        cache.set(row.setting_key, decryptSecret(row.value_enc));
      } catch (err) {
        // A row that will not decrypt (e.g. CREDENTIAL_SECRET was rotated) is
        // skipped, not fatal: the resolver falls back to env for that key.
        logger.warn({ err, key: row.setting_key }, 'could not decrypt an app setting; skipping');
      }
    }
    cacheLoaded = true;
    logger.info({ count: cache.size }, 'loaded app settings cache');
  } catch (err) {
    // The table may not exist yet on a very first boot before migrations, or the
    // DB may be briefly unreachable. Non-fatal — the resolver uses env until the
    // next successful load.
    logger.warn({ err }, 'could not load app settings cache; using environment only');
  }
}

/** True once the cache has been loaded at least once. */
export function isCacheLoaded() {
  return cacheLoaded;
}

/**
 * The cached plaintext value for a key, or undefined when unset. Synchronous —
 * this is what the config resolver calls per request.
 */
export function getCachedSetting(key) {
  return cache.get(key);
}

/** Every cached key -> value (plaintext). For the resolver's status view. */
export function getCachedSettingKeys() {
  return new Set(cache.keys());
}

/** Read + decrypt a single setting straight from the DB, or null. */
export async function getSetting(key) {
  const [rows] = await getPool().query('SELECT value_enc FROM app_settings WHERE setting_key = ?', [
    key,
  ]);
  if (rows.length === 0) return null;
  try {
    return decryptSecret(rows[0].value_enc);
  } catch {
    return null;
  }
}

/**
 * Upsert a setting. A null/empty value DELETES the override (falling back to
 * env). Updates the in-process cache so the change is live immediately.
 *
 * @param {string} key
 * @param {string|null} value  plaintext; null/'' clears the override
 * @param {string} [updatedBy] admin owner_id, for the audit column
 */
export async function setSetting(key, value, updatedBy = null) {
  if (value === null || value === undefined || String(value).length === 0) {
    await getPool().query('DELETE FROM app_settings WHERE setting_key = ?', [key]);
    cache.delete(key);
    return;
  }
  const enc = encryptSecret(String(value));
  const now = new Date();
  await getPool().query(
    `INSERT INTO app_settings (setting_key, value_enc, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value_enc = VALUES(value_enc),
                             updated_by = VALUES(updated_by),
                             updated_at = VALUES(updated_at)`,
    [key, enc, updatedBy, now, now],
  );
  cache.set(key, String(value));
}

/**
 * Which keys have a DB override set (from the cache), so the admin UI can show
 * "managed here" vs "from environment" without ever returning the values.
 */
export function listConfiguredKeys() {
  return Array.from(cache.keys());
}
