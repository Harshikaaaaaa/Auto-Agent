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

    // ---- Client origin allowlist (enforced in Task 3) ----
    CORS_ALLOWED_ORIGINS: csv('http://localhost:3233,http://127.0.0.1:3233'),

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
  });

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
