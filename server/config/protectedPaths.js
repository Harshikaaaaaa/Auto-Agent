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
 * Outbound fetch. Anonymous or unlimited access here would turn the server into
 * a network scanner and an open proxy, so it is gated and separately budgeted.
 */
export const FETCH_PATHS = ['/api/fetch'];

/**
 * Connected-tool OAuth, and the proxy that calls Google with the stored token.
 *
 * These MUST be session-gated. `/api/oauth/*` binds a Google grant to whoever is
 * signed in, and `/api/google/call` spends that grant — anonymous access would
 * let a stranger send mail from the operator's account. The OAuth callback is
 * included: it is the request that writes the credential.
 */
export const CONNECTOR_PATHS = ['/api/oauth', '/api/google'];

/**
 * Billing & wallet endpoints. Session-gated: they read a user's balances, spend
 * credits, and start payments, so they must be bound to whoever is signed in.
 * (The Razorpay webhook is public-but-signature-verified and is registered
 * BEFORE this guard — see server/payments/routes.js.)
 */
export const BILLING_PATHS = ['/api/billing'];

/**
 * Admin console APIs. Session-gated here; the admin ROLE check is a second
 * middleware (requireAdmin) layered on top, so a signed-in non-admin still gets
 * 403 rather than reaching the handler.
 */
export const ADMIN_PATHS = ['/api/admin'];

/**
 * Paths that must stay reachable without a session.
 * Health probes need to work before anyone signs in, and the auth endpoints are
 * how a session is obtained in the first place.
 */
export const PUBLIC_PATHS = [
  '/healthz',
  '/readyz',
  '/api/auth/signup',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/verify',
  '/api/auth/me',
];

/** Every session-gated prefix, for assertions and documentation. */
export const ALL_PROTECTED_PATHS = [
  ...AI_PATHS,
  ...WORKFLOW_PATHS,
  ...WHATSAPP_PATHS,
  ...FETCH_PATHS,
  ...CONNECTOR_PATHS,
  ...BILLING_PATHS,
  ...ADMIN_PATHS,
];
