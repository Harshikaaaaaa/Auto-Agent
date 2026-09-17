/**
 * Route prefixes that require a valid session.
 *
 * Kept as data, in one place, so the set can be asserted by tests. A path that
 * is missing here is silently anonymous, which is how `/workflows` was left
 * readable and deletable by anyone: the guard was registered for
 * `/api/workflows` while the routes were actually mounted at `/workflows`.
 */

/** Model calls. Metered separately because they cost money. */
export const AI_PATHS = ['/api/ai'];

/**
 * Saved workflows.
 *
 * `/api/workflows` is the real prefix. The legacy `/workflows` prefix is kept in
 * this list even though its routes were removed with the JSON store: if it is
 * ever reintroduced it will be guarded by default rather than anonymous, which is
 * exactly the mistake this file exists to prevent.
 */
export const WORKFLOW_PATHS = ['/workflows', '/api/workflows'];

/** WhatsApp bridge: sends messages, reads messages, wipes credentials. */
export const WHATSAPP_PATHS = ['/status', '/qr', '/send', '/messages', '/disconnect'];

/**
 * Paths that must stay reachable without a session.
 * Health probes need to work before anyone signs in, and the auth endpoints are
 * how a session is obtained in the first place.
 */
export const PUBLIC_PATHS = [
  '/healthz',
  '/readyz',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
];

/** Every session-gated prefix, for assertions and documentation. */
export const ALL_PROTECTED_PATHS = [...AI_PATHS, ...WORKFLOW_PATHS, ...WHATSAPP_PATHS];
