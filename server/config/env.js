import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

/**
 * Load environment files before validation.
 *
 * Uses Node's built-in `process.loadEnvFile` so no dotenv dependency is needed.
 * Existing process env always wins, which is what a container/CI deployment
 * expects. Files are optional: in production the env is injected, not filed.
 */
function loadEnvFiles() {
  // Tests need a deterministic environment, not whatever is on the developer's
  // disk, so they can opt out of env-file loading entirely.
  if (process.env.AUTOAGENT_SKIP_ENV_FILES === '1') return;

  const candidates = ['.env', '.env.local'];
  for (const file of candidates) {
    const full = path.join(projectRoot, file);
    if (!fs.existsSync(full)) continue;
    try {
      process.loadEnvFile(full);
    } catch (err) {
      // A malformed env file must not crash startup silently.
      console.warn(`[env] Could not load ${file}: ${err.message}`);
    }
  }
}

loadEnvFiles();

const booleanish = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const csv = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? defaultValue)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

/**
 * An optional secret. An empty string means "not set" rather than "invalid":
 * container and CI configs routinely declare `KEY=` with no value, and that
 * should behave the same as omitting the variable.
 */
const optionalSecret = () =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional());

const intWithDefault = (defaultValue, { min, max } = {}) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(
      z
        .number()
        .int()
        .min(min ?? 0)
        .max(max ?? Number.MAX_SAFE_INTEGER),
    );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intWithDefault(3234, { min: 1, max: 65535 }),

    // ---- Client origin allowlist ----
    CORS_ALLOWED_ORIGINS: csv('http://localhost:3233,http://127.0.0.1:3233'),

    // ---- Authentication ----
    /**
     * Auth may only be disabled for local development. Production startup fails
     * if this is false, because every route below it touches real accounts,
     * real mailboxes, and real saved data.
     */
    AUTH_ENABLED: booleanish(true),
    /** Shared password for the single-operator deployment. */
    APP_PASSWORD: optionalSecret(),
    /** HMAC key for session cookies. Rotating it invalidates all sessions. */
    SESSION_SECRET: optionalSecret(),
    SESSION_TTL_HOURS: intWithDefault(12, { min: 1, max: 720 }),
    /** Send the Secure cookie flag. Required in production; off for plain-HTTP dev. */
    SESSION_COOKIE_SECURE: booleanish(undefined),

    // ---- Rate limiting (per IP) ----
    RATE_LIMIT_WINDOW_MS: intWithDefault(60_000, { min: 1_000, max: 3_600_000 }),
    /** General API budget per window. */
    RATE_LIMIT_MAX: intWithDefault(300, { min: 1, max: 100_000 }),
    /** AI calls cost money and tokens, so they get a tighter budget. */
    RATE_LIMIT_AI_MAX: intWithDefault(30, { min: 1, max: 10_000 }),
    /** Login attempts are throttled hard to slow credential guessing. */
    RATE_LIMIT_AUTH_MAX: intWithDefault(10, { min: 1, max: 1_000 }),
    /** Outbound message sends are throttled to limit spam blast radius. */
    RATE_LIMIT_SEND_MAX: intWithDefault(20, { min: 1, max: 10_000 }),

    // ---- Logging ----
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // ---- Database (MySQL) ----
    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_PORT: intWithDefault(3306, { min: 1, max: 65535 }),
    DB_USER: z.string().min(1).default('root'),
    /** Empty is tolerated for a local dev server, but never in production. */
    DB_PASSWORD: z.string().optional().default(''),
    DB_NAME: z.string().min(1).default('autoagent'),
    DB_CONNECTION_LIMIT: intWithDefault(10, { min: 1, max: 100 }),
    /** Require TLS to the database. Should be on for any non-local database. */
    DB_SSL: booleanish(false),
    /** Create the schema on boot. Convenient locally; use migrations in prod. */
    DB_AUTO_MIGRATE: booleanish(true),

    // ---- AI provider selection ----
    AI_PROVIDER: z.enum(['openrouter', 'gemini', 'ollama']).default('openrouter'),
    AI_REQUEST_TIMEOUT_MS: intWithDefault(60_000, { min: 1_000, max: 300_000 }),
    /** Allow the browser to request a provider other than AI_PROVIDER. */
    AI_ALLOW_CLIENT_PROVIDER_OVERRIDE: booleanish(true),

    // ---- Provider credentials. Server-side only: never sent to the browser. ----
    OPENROUTER_API_KEY: optionalSecret(),
    OPENROUTER_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
    OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),

    GEMINI_API_KEY: optionalSecret(),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash'),
    GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),

    OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
    OLLAMA_MODEL: z.string().min(1).default('deepseek-r1:8b'),

    // ---- Feature flags ----
    /** WhatsApp bridge is opt-in; see Task 17. */
    WHATSAPP_ENABLED: booleanish(false),
  })
  .superRefine((cfg, ctx) => {
    // Fail fast, and name the exact variable, when the selected provider has no
    // credential. A missing key must not surface later as a confusing 401 from
    // inside a workflow run.
    const requirements = {
      openrouter: 'OPENROUTER_API_KEY',
      gemini: 'GEMINI_API_KEY',
      ollama: null, // local, no credential
    };
    const required = requirements[cfg.AI_PROVIDER];
    if (required && !cfg[required]) {
      ctx.addIssue({
        code: 'custom',
        path: [required],
        message:
          `AI_PROVIDER is "${cfg.AI_PROVIDER}" but ${required} is not set. ` +
          `Set ${required}, or change AI_PROVIDER to a provider you have configured.`,
      });
    }

    // Auth must never be off in production: these routes send email, post
    // messages, and read saved workflows.
    if (!cfg.AUTH_ENABLED && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_ENABLED'],
        message:
          'AUTH_ENABLED=false is not allowed when NODE_ENV=production. ' +
          'An unauthenticated deployment exposes connector actions and saved workflows to anyone.',
      });
    }

    if (cfg.AUTH_ENABLED) {
      if (!cfg.APP_PASSWORD) {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_PASSWORD'],
          message:
            'APP_PASSWORD is required when AUTH_ENABLED is true. ' +
            'Set a strong password, or set AUTH_ENABLED=false for local development only.',
        });
      } else if (cfg.APP_PASSWORD.length < 12) {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_PASSWORD'],
          message: 'APP_PASSWORD must be at least 12 characters.',
        });
      }

      if (!cfg.SESSION_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message:
            'SESSION_SECRET is required when AUTH_ENABLED is true. ' +
            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
        });
      } else if (cfg.SESSION_SECRET.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'SESSION_SECRET must be at least 32 characters of high-entropy material.',
        });
      }
    }

    // A production database must be password protected. An empty password is a
    // convenience of local Homebrew MySQL, not something to ship.
    if (cfg.NODE_ENV === 'production' && !cfg.DB_PASSWORD) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_PASSWORD'],
        message:
          'DB_PASSWORD is required when NODE_ENV=production. ' +
          'An unauthenticated database exposes every saved workflow.',
      });
    }

    // Connecting to a remote database in the clear would put workflow contents
    // on the wire unencrypted.
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (cfg.NODE_ENV === 'production' && !cfg.DB_SSL && !localHosts.has(cfg.DB_HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_SSL'],
        message:
          `DB_SSL must be enabled in production when DB_HOST ("${cfg.DB_HOST}") is not local, ` +
          'otherwise database traffic is unencrypted.',
      });
    }
  })
  .transform((cfg) => ({
    ...cfg,
    // Secure cookies are mandatory in production and default off elsewhere so
    // plain-HTTP local development still works.
    SESSION_COOKIE_SECURE:
      cfg.SESSION_COOKIE_SECURE === undefined
        ? cfg.NODE_ENV === 'production'
        : cfg.SESSION_COOKIE_SECURE,
  }));

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately explicit: a misconfigured server should not boot half-working.
  console.error(`\n[env] Invalid server configuration:\n${issues}\n`);
  throw new Error('Invalid server configuration. See the errors above.');
}

export const env = Object.freeze(parsed.data);

/** Providers that actually have a usable credential right now. */
export function availableProviders() {
  const available = [];
  if (env.OPENROUTER_API_KEY) available.push('openrouter');
  if (env.GEMINI_API_KEY) available.push('gemini');
  // Ollama needs no key; reachability is probed at startup instead.
  available.push('ollama');
  return available;
}

/**
 * Config safe to expose to the browser.
 * Contains no credentials — only which providers and models are usable.
 */
export function publicAiConfig() {
  return {
    defaultProvider: env.AI_PROVIDER,
    allowProviderOverride: env.AI_ALLOW_CLIENT_PROVIDER_OVERRIDE,
    providers: {
      openrouter: { configured: Boolean(env.OPENROUTER_API_KEY), model: env.OPENROUTER_MODEL },
      gemini: { configured: Boolean(env.GEMINI_API_KEY), model: env.GEMINI_MODEL },
      ollama: { configured: true, model: env.OLLAMA_MODEL },
    },
  };
}
