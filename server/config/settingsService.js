import { env } from './env.js';
import { getCachedSetting, getCachedSettingKeys } from '../db/settingsRepository.js';

/**
 * The config resolver.
 *
 * Every runtime consumer that used to read `env.X` for a Category-A key reads it
 * through here instead: a DB override (set by an admin in the console, cached in
 * settingsRepository) WINS, else the environment value is used. So the existing
 * .env keeps working unchanged and anything set in the admin UI takes precedence
 * without a container recreate.
 *
 * Category-B secrets (CREDENTIAL_SECRET, SESSION_SECRET, DB_PASSWORD, APP_PASSWORD,
 * and boot/security posture like NODE_ENV) are deliberately NOT managed here:
 * CREDENTIAL_SECRET is the key that decrypts everything stored, DB_PASSWORD is
 * needed before the DB exists, and rotating SESSION_SECRET from a request would
 * void the admin's own session. Those remain env-only.
 */

/**
 * The managed keys and how to treat each one.
 *   kind: 'secret' (masked, never returned) | 'text' | 'bool' | 'enum'
 *   The key name is BOTH the env var name and the app_settings.setting_key,
 *   so there is one canonical name everywhere.
 */
export const MANAGED_SETTINGS = Object.freeze([
  // Active provider + override toggle
  { key: 'AI_PROVIDER', kind: 'enum', options: ['openrouter', 'gemini', 'ollama', 'openai'] },

  // OpenRouter
  { key: 'OPENROUTER_API_KEY', kind: 'secret' },
  { key: 'OPENROUTER_MODEL', kind: 'text' },

  // Gemini
  { key: 'GEMINI_API_KEY', kind: 'secret' },
  { key: 'GEMINI_MODEL', kind: 'text' },

  // OpenAI
  { key: 'OPENAI_API_KEY', kind: 'secret' },
  { key: 'OPENAI_MODEL', kind: 'text' },

  // Google OAuth (client id is not secret, but keep it managed alongside)
  { key: 'GOOGLE_CLIENT_ID', kind: 'text' },
  { key: 'GOOGLE_CLIENT_SECRET', kind: 'secret' },

  // Razorpay
  { key: 'RAZORPAY_KEY_ID', kind: 'text' },
  { key: 'RAZORPAY_KEY_SECRET', kind: 'secret' },
  { key: 'RAZORPAY_WEBHOOK_SECRET', kind: 'secret' },

  // Feature toggles
  { key: 'FETCH_RENDER_ENABLED', kind: 'bool' },
  { key: 'WHATSAPP_ENABLED', kind: 'bool' },
]);

const MANAGED_BY_KEY = new Map(MANAGED_SETTINGS.map((s) => [s.key, s]));

/** Is this a key the admin console is allowed to manage? */
export function isManagedKey(key) {
  return MANAGED_BY_KEY.has(key);
}

/**
 * Resolve a STRING/secret setting: DB override if set, else env fallback.
 * Returns undefined/'' the same way env does (so `if (!resolveString(...))`
 * still means "not configured").
 */
export function resolveString(key) {
  const override = getCachedSetting(key);
  if (override !== undefined && override !== null && override !== '') return override;
  return env[key];
}

/** Resolve a boolean setting. DB stores 'true'/'false'; env is already boolean. */
export function resolveBool(key) {
  const override = getCachedSetting(key);
  if (override !== undefined && override !== null && override !== '') {
    return ['1', 'true', 'yes', 'on'].includes(String(override).toLowerCase());
  }
  return Boolean(env[key]);
}

/**
 * Resolve the enum AI_PROVIDER. Falls back to env; an invalid DB value is
 * ignored (defends against a hand-edited row).
 */
export function resolveProviderName() {
  const override = getCachedSetting('AI_PROVIDER');
  const options = MANAGED_BY_KEY.get('AI_PROVIDER').options;
  if (override && options.includes(override)) return override;
  return env.AI_PROVIDER;
}

/** Where a key's effective value comes from right now. */
export function sourceOf(key) {
  const override = getCachedSetting(key);
  if (override !== undefined && override !== null && override !== '') return 'db';
  // env value present?
  const envVal = env[key];
  if (envVal === undefined || envVal === null || envVal === '' || envVal === false) {
    // `false` boolean or empty means "not configured"; report env only if truthy
    // for secrets/text, but booleans are always "env" (they always have a value).
    const meta = MANAGED_BY_KEY.get(key);
    if (meta && meta.kind === 'bool') return 'env';
    return 'unset';
  }
  return 'env';
}

/**
 * Browser-safe AI config that reflects DB overrides (resolver), not just env.
 * Same shape as env.publicAiConfig() so the routes are a drop-in swap; contains
 * no credentials — only which providers/models are usable and which is active.
 */
export function resolvedPublicAiConfig() {
  return {
    defaultProvider: resolveProviderName(),
    allowProviderOverride: env.AI_ALLOW_CLIENT_PROVIDER_OVERRIDE,
    providers: {
      openrouter: {
        configured: Boolean(resolveString('OPENROUTER_API_KEY')),
        model: resolveString('OPENROUTER_MODEL'),
      },
      gemini: {
        configured: Boolean(resolveString('GEMINI_API_KEY')),
        model: resolveString('GEMINI_MODEL'),
      },
      openai: {
        configured: Boolean(resolveString('OPENAI_API_KEY')),
        model: resolveString('OPENAI_MODEL'),
      },
      ollama: { configured: true, model: env.OLLAMA_MODEL },
    },
  };
}

/** Mask a secret to a short suffix, never the whole value. */
function maskSecret(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

/**
 * A browser-safe status view of every managed setting: configured?, source
 * (db|env|unset), and — for non-secret text/enum/bool — the effective value.
 * SECRET values are NEVER returned in full; only a masked suffix.
 */
export function settingsStatus() {
  const dbKeys = getCachedSettingKeys();
  return MANAGED_SETTINGS.map((meta) => {
    const { key, kind } = meta;
    const source = sourceOf(key);
    const base = {
      key,
      kind,
      source,
      managedInDb: dbKeys.has(key),
      configured: false,
    };
    if (kind === 'secret') {
      const effective = resolveString(key);
      return {
        ...base,
        configured: Boolean(effective),
        masked: maskSecret(effective),
      };
    }
    if (kind === 'bool') {
      const val = resolveBool(key);
      return { ...base, configured: true, value: val };
    }
    if (kind === 'enum') {
      const val = resolveProviderName();
      return { ...base, configured: Boolean(val), value: val, options: meta.options };
    }
    // text
    const val = resolveString(key);
    return { ...base, configured: Boolean(val), value: val ?? null };
  });
}
