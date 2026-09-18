#!/usr/bin/env node
/**
 * CI gate: no secret may appear in the built client bundle.
 *
 * Before this check existed, `vite.config.ts` inlined GEMINI_API_KEY and
 * OPENROUTER_API_KEY via `define`, so both keys were recoverable from dist/ by
 * anyone who loaded the app. This script fails the build if that ever happens
 * again.
 *
 * Two independent checks:
 *   1. VALUE scan  — the actual value of every non-public env var must not
 *                    appear anywhere in dist/. This is the check that matters.
 *   2. SHAPE scan  — known credential patterns (for example an OpenRouter
 *                    `sk-or-...` key) must not appear, which catches secrets
 *                    that were hardcoded rather than passed via env.
 *
 * Exit codes: 0 clean, 1 secret found, 2 nothing to check (dist/ missing).
 *
 * Secret values are never printed. Only the variable NAME is reported.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectRoot, 'dist');

/**
 * Variables allowed to appear in client code.
 * `VITE_`-prefixed values are public by Vite's contract. A Google OAuth client
 * id is public by design (it is shown in the browser during the OAuth flow).
 */
const PUBLIC_PREFIXES = ['VITE_'];
// Non-secret identifiers that are safe to appear in the client bundle. Model
// names and base URLs are public by design — the UI shows the configured model,
// and AI_PROVIDER is a plain enum. Only credentials are secret; these are not.
const PUBLIC_NAMES = new Set([
  'NODE_ENV',
  'PORT',
  'AI_PROVIDER',
  'OPENROUTER_MODEL',
  'OPENROUTER_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'OLLAMA_MODEL',
  'OLLAMA_BASE_URL',
  'DB_NAME',
]);

/** Values shorter than this are too generic to match reliably. */
const MIN_SECRET_LENGTH = 12;

/** Credential shapes that must never be committed or bundled. */
const SECRET_PATTERNS = [
  { name: 'OpenRouter API key', re: /\bsk-or-v1-[A-Za-z0-9]{16,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
];

function isPublicName(name) {
  if (PUBLIC_NAMES.has(name)) return true;
  return PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Parse KEY=VALUE files without evaluating them. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function collectFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else files.push(full);
  }
  return files;
}

function main() {
  if (!fs.existsSync(distDir)) {
    console.error('[secrets] dist/ not found. Run the build before this check.');
    process.exit(2);
  }

  // Candidate secrets: env files on disk plus the live process env.
  const candidates = {
    ...readEnvFile(path.join(projectRoot, '.env')),
    ...readEnvFile(path.join(projectRoot, '.env.local')),
    ...process.env,
  };

  const files = collectFiles(distDir);
  // Text-like assets only; images cannot meaningfully contain a pasted key.
  const textFiles = files.filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map)$/i.test(f));

  const findings = [];
  let valuesChecked = 0;

  for (const file of textFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(projectRoot, file);

    // ---- 1. VALUE scan ----
    for (const [name, value] of Object.entries(candidates)) {
      if (!value || typeof value !== 'string') continue;
      if (value.length < MIN_SECRET_LENGTH) continue;
      if (isPublicName(name)) continue;
      valuesChecked += 1;
      if (content.includes(value)) {
        findings.push(
          `${rel}: contains the value of ${name}. ` +
            `Remove it from client code and read it server-side instead.`,
        );
      }
    }

    // ---- 2. SHAPE scan ----
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(content)) {
        findings.push(`${rel}: matches the shape of a ${name}.`);
      }
    }
  }

  const unique = [...new Set(findings)];

  if (unique.length > 0) {
    console.error('\n[secrets] FAILED — secret material found in the built bundle:\n');
    for (const finding of unique) console.error(`  - ${finding}`);
    console.error(
      '\nProvider credentials must only be read by the server (server/ai/providers.js).\n' +
        'If a key was exposed, rotate it: a build that shipped is already public.\n',
    );
    process.exit(1);
  }

  console.log(
    `[secrets] OK — scanned ${textFiles.length} built file(s); ` +
      `no secret values or credential patterns found.`,
  );
  if (valuesChecked === 0) {
    console.log('[secrets] note: no non-public env values were available to compare against.');
  }
}

main();
