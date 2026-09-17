/**
 * Base URL for the AutoAgent backend.
 *
 * Empty string means "same origin", which is the correct production setup: the
 * built assets and the API are served from one host, so no CORS and no
 * hardcoded localhost. In development, Vite proxies `/api` to the API port (see
 * `vite.config.ts`), so the same relative paths work in both environments.
 *
 * Override only when the API genuinely lives elsewhere (for example a separate
 * API host in staging) via `VITE_API_BASE_URL`.
 */
const rawBase = (import.meta.env?.VITE_API_BASE_URL ?? '') as string;

/** Normalised base with no trailing slash. */
export const API_BASE_URL = rawBase.replace(/\/+$/, '');

/** Build an absolute-or-relative API URL from a root-relative path. */
export function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${suffix}`;
}
