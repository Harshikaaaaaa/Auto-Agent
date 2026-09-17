import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { deleteCredential, listConnections } from '../db/credentialRepository.js';
import {
    GOOGLE_TOOL_IDS,
    OAuthError,
    buildAuthorizationUrl,
    createAuthorizationChallenge,
    exchangeCodeForCredential,
    isGoogleOAuthConfigured,
    revokeCredential,
} from './google.js';

/**
 * OAuth connect / disconnect / status.
 *
 * The browser's whole involvement is: open the start URL in a popup, and read
 * `/api/oauth/connections` afterwards. No token is ever sent to it.
 */

/** Holds the PKCE verifier between the start call and the callback. */
export const OAUTH_STATE_COOKIE = 'autoagent_oauth';
/** Long enough to finish a consent screen, short enough to be uninteresting. */
const STATE_TTL_MS = 10 * 60 * 1000;

const toolIdSchema = z.enum(GOOGLE_TOOL_IDS);

const startQuerySchema = z.object({
    toolId: toolIdSchema,
});

const callbackQuerySchema = z.object({
    code: z.string().min(1).max(2048).optional(),
    state: z.string().min(1).max(256).optional(),
    error: z.string().max(256).optional(),
});

const disconnectBodySchema = z.object({
    toolId: toolIdSchema,
});

function stateCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax', // must survive the redirect back from Google
        secure: env.SESSION_COOKIE_SECURE,
        path: '/api/oauth',
        maxAge: STATE_TTL_MS,
    };
}

/**
 * The page the popup lands on after the exchange.
 *
 * It posts the outcome to the window that opened it and closes. Rendered as a
 * tiny self-contained document rather than redirecting into the SPA, so the
 * result cannot be mistaken for a normal navigation and no token-shaped value is
 * ever placed in a URL the browser keeps.
 */
function completionPage({ ok, toolId, reason }) {
    const payload = JSON.stringify({ source: 'autoagent-oauth', ok, toolId, reason: reason ?? null });
    const heading = ok ? 'Connected' : 'Connection failed';
    const detail = ok
        ? 'You can close this window.'
        : `${reason ?? 'Something went wrong.'} You can close this window.`;

    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${heading}</title></head>
<body style="font-family:system-ui;background:#0a0a0a;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
  <main style="text-align:center">
    <h1 style="font-size:1.1rem">${heading}</h1>
    <p style="opacity:.7;font-size:.85rem">${detail}</p>
  </main>
  <script>
    // JSON.stringify output is embedded as a literal, so no user text is
    // interpolated into executable positions.
    try { window.opener && window.opener.postMessage(${payload}, window.location.origin); } catch (e) {}
    setTimeout(function () { window.close(); }, ${ok ? 400 : 2500});
  </script>
</body>
</html>`;
}

function handle(fn) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof OAuthError) {
                return res.status(err.status).json({ error: err.reason, message: err.message });
            }
            logger.error({ err, path: req.originalUrl }, 'unexpected OAuth route error');
            return res
                .status(500)
                .json({ error: 'internal_error', message: 'The connection could not be completed.' });
        }
    };
}

export function setupOAuthRoutes(app) {
    /**
     * Which tools are connected. No token material, by construction — this is the
     * only connection information the browser gets.
     */
    app.get(
        '/api/oauth/connections',
        handle(async (req, res) => {
            const connections = await listConnections(req.session.sub);
            res.json({
                configured: isGoogleOAuthConfigured(),
                supportedTools: GOOGLE_TOOL_IDS,
                connections,
            });
        }),
    );

    /** Begin the flow: stash the PKCE verifier and redirect to Google. */
    app.get(
        '/api/oauth/google/start',
        handle(async (req, res) => {
            if (!isGoogleOAuthConfigured()) {
                throw new OAuthError(
                    'Google OAuth is not configured on the server. Set GOOGLE_CLIENT_ID, ' +
                        'GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI.',
                    { status: 503, reason: 'not_configured' },
                );
            }

            const parsed = startQuerySchema.safeParse(req.query);
            if (!parsed.success) {
                throw new OAuthError(
                    `toolId must be one of: ${GOOGLE_TOOL_IDS.join(', ')}.`,
                    { reason: 'unknown_tool' },
                );
            }

            const { toolId } = parsed.data;
            const { codeVerifier, codeChallenge, state } = createAuthorizationChallenge();

            // The verifier and the expected state ride in an httpOnly cookie
            // rather than server memory, so the flow survives a restart and a
            // multi-replica deployment without a shared store.
            res.cookie(
                OAUTH_STATE_COOKIE,
                JSON.stringify({ toolId, state, codeVerifier, issuedAt: Date.now() }),
                stateCookieOptions(),
            );

            res.redirect(buildAuthorizationUrl({ toolId, codeChallenge, state }));
        }),
    );

    /** Google redirects here with the code. */
    app.get(
        '/api/oauth/google/callback',
        handle(async (req, res) => {
            const parsed = callbackQuerySchema.safeParse(req.query);
            const raw = req.cookies?.[OAUTH_STATE_COOKIE];
            res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/oauth' });

            const fail = (reason) =>
                res.status(200).type('html').send(completionPage({ ok: false, toolId: null, reason }));

            if (!parsed.success) return fail('That callback was malformed.');
            if (parsed.data.error) {
                // The user clicked Deny, or Google refused. Not an error worth a 500.
                return fail('The connection was not approved.');
            }
            if (!parsed.data.code || !parsed.data.state) return fail('That callback was incomplete.');
            if (!raw) return fail('The connection attempt expired. Try again.');

            let pending;
            try {
                pending = JSON.parse(raw);
            } catch {
                return fail('The connection attempt could not be verified. Try again.');
            }

            // CSRF: the state Google echoed must match the one we issued.
            if (pending.state !== parsed.data.state) {
                logger.warn('oauth state mismatch on callback');
                return fail('The connection attempt could not be verified. Try again.');
            }
            if (Date.now() - Number(pending.issuedAt) > STATE_TTL_MS) {
                return fail('The connection attempt expired. Try again.');
            }

            try {
                const result = await exchangeCodeForCredential({
                    ownerId: req.session.sub,
                    toolId: pending.toolId,
                    code: parsed.data.code,
                    codeVerifier: pending.codeVerifier,
                });

                logger.info(
                    { toolId: result.toolId, offline: result.offline },
                    'connected google tool',
                );
                return res
                    .status(200)
                    .type('html')
                    .send(completionPage({ ok: true, toolId: result.toolId }));
            } catch (err) {
                const reason =
                    err instanceof OAuthError ? err.message : 'The connection could not be completed.';
                logger.warn({ err, toolId: pending.toolId }, 'google oauth exchange failed');
                return fail(reason);
            }
        }),
    );

    /** Revoke with Google and delete the stored credential. */
    app.post(
        '/api/oauth/google/disconnect',
        handle(async (req, res) => {
            const parsed = disconnectBodySchema.safeParse(req.body);
            if (!parsed.success) {
                throw new OAuthError(`toolId must be one of: ${GOOGLE_TOOL_IDS.join(', ')}.`, {
                    reason: 'unknown_tool',
                });
            }

            const { toolId } = parsed.data;
            const revoked = await revokeCredential(req.session.sub, toolId);
            const removed = await deleteCredential(req.session.sub, toolId);

            res.json({ toolId, removed, revoked });
        }),
    );
}
