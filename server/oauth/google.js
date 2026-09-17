import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
    readCredential,
    saveCredential,
    updateAccessToken,
} from '../db/credentialRepository.js';

/**
 * Google OAuth, server side.
 *
 * The browser previously ran the Google Identity Services *implicit* flow: it
 * received an access token directly and kept it in localStorage. That has two
 * problems beyond the obvious one of a readable credential. The implicit flow
 * issues no refresh token, so the only way to renew was to re-run the token
 * client — which is why a five-minute `setInterval` sat in the registry silently
 * re-requesting consent, and why a token could expire mid-run and fail a send.
 *
 * This is the authorization-code flow with PKCE. The client secret and the
 * exchange live here, the refresh token never leaves the server, and renewal is
 * a normal HTTP call rather than a hidden popup.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** Renew this long before expiry, so a slow request cannot outlive the token. */
const REFRESH_MARGIN_MS = 120_000;

/**
 * Scopes per tool, and the ONLY scopes that can be requested.
 *
 * Declared server side so the browser cannot ask for more than the tool needs.
 * These mirror the connectors' declared scopes; a tool absent from here cannot be
 * connected at all.
 */
export const GOOGLE_TOOL_SCOPES = {
    gmail: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
    google_sheets: ['https://www.googleapis.com/auth/spreadsheets'],
    google_drive: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
    ],
};

export const GOOGLE_TOOL_IDS = Object.keys(GOOGLE_TOOL_SCOPES);

export function isGoogleTool(toolId) {
    return Object.prototype.hasOwnProperty.call(GOOGLE_TOOL_SCOPES, toolId);
}

/** Whether the server is configured to run the flow at all. */
export function isGoogleOAuthConfigured() {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
}

/** An OAuth failure with an HTTP status and a reason code the UI can branch on. */
export class OAuthError extends Error {
    constructor(message, { status = 400, reason = 'oauth_error', cause } = {}) {
        super(message, { cause });
        this.name = 'OAuthError';
        this.status = status;
        this.reason = reason;
    }
}

// ------------------------------------------------------------------- PKCE

function base64url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

/**
 * A fresh PKCE pair plus CSRF state.
 *
 * PKCE matters even with a confidential client here: the redirect lands on a URL
 * an attacker could try to replay, and the verifier binds the code to the browser
 * that started the flow.
 */
export function createAuthorizationChallenge() {
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64url(crypto.randomBytes(16));
    return { codeVerifier, codeChallenge, state };
}

/** The Google consent URL to send the user to. */
export function buildAuthorizationUrl({ toolId, codeChallenge, state }) {
    const scopes = GOOGLE_TOOL_SCOPES[toolId];
    if (!scopes) throw new OAuthError(`"${toolId}" is not a Google tool.`, { reason: 'unknown_tool' });

    const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // offline + consent is what produces a refresh token. Without it Google
        // returns an access token only, and renewal needs the user again.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
    });

    return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// --------------------------------------------------------------- token calls

/**
 * POST to Google's token endpoint.
 *
 * The response body is never echoed to the client: it contains tokens, and an
 * error body can contain the client id. Failures are logged server side and
 * reported as a reason code.
 */
async function postToken(body, { fetchImpl = fetch } = {}) {
    let response;
    try {
        response = await fetchImpl(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body).toString(),
        });
    } catch (cause) {
        throw new OAuthError('Could not reach Google to exchange the authorization.', {
            status: 502,
            reason: 'provider_unreachable',
            cause,
        });
    }

    const text = await response.text();
    let parsed = {};
    try {
        parsed = JSON.parse(text);
    } catch {
        // Google returned something unexpected; treated as a failure below.
    }

    if (!response.ok) {
        logger.warn(
            { status: response.status, error: parsed.error, description: parsed.error_description },
            'google token endpoint rejected the request',
        );
        const expired = parsed.error === 'invalid_grant';
        throw new OAuthError(
            expired
                ? 'Google rejected the stored authorization. Reconnect the tool.'
                : 'Google rejected the token request.',
            { status: expired ? 401 : 502, reason: expired ? 'invalid_grant' : 'token_exchange_failed' },
        );
    }

    if (!parsed.access_token) {
        throw new OAuthError('Google returned no access token.', {
            status: 502,
            reason: 'token_exchange_failed',
        });
    }

    return parsed;
}

function expiryFrom(payload, now = Date.now()) {
    const seconds = Number(payload.expires_in);
    return Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null;
}

/** Exchange the authorization code and persist the credential. */
export async function exchangeCodeForCredential({
    ownerId,
    toolId,
    code,
    codeVerifier,
    fetchImpl = fetch,
}) {
    const payload = await postToken(
        {
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
            grant_type: 'authorization_code',
            code,
            code_verifier: codeVerifier,
        },
        { fetchImpl },
    );

    const granted = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];

    await saveCredential({
        ownerId,
        toolId,
        provider: 'google',
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? null,
        expiresAt: expiryFrom(payload),
        scopes: granted.length > 0 ? granted : GOOGLE_TOOL_SCOPES[toolId],
    });

    return {
        toolId,
        scopes: granted,
        /** True when renewal is possible without the user. */
        offline: Boolean(payload.refresh_token),
    };
}

/**
 * A usable access token for this owner and tool, refreshing when needed.
 *
 * SERVER ONLY — the return value is a live bearer token.
 */
export async function getAccessToken(ownerId, toolId, { fetchImpl = fetch, now = Date.now() } = {}) {
    const credential = await readCredential(ownerId, toolId);
    if (!credential) {
        throw new OAuthError(`${toolId} is not connected. Connect it first.`, {
            status: 401,
            reason: 'not_connected',
        });
    }

    const stillValid = credential.expiresAt === null || credential.expiresAt - now > REFRESH_MARGIN_MS;
    if (stillValid) return credential.accessToken;

    if (!credential.refreshToken) {
        // Nothing to renew with. Say so plainly rather than sending a token we
        // know is expired and reporting Google's 401 instead.
        throw new OAuthError(
            `The ${toolId} authorization expired and cannot be renewed automatically. Reconnect it.`,
            { status: 401, reason: 'refresh_unavailable' },
        );
    }

    const payload = await postToken(
        {
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: credential.refreshToken,
        },
        { fetchImpl },
    );

    await updateAccessToken({
        ownerId,
        toolId,
        accessToken: payload.access_token,
        expiresAt: expiryFrom(payload, now),
    });

    logger.info({ toolId }, 'refreshed google access token');
    return payload.access_token;
}

/**
 * Tell Google to forget the grant. Best effort: the local row is deleted by the
 * caller either way, because leaving a credential the user asked to remove is
 * worse than a stale grant on Google's side.
 */
export async function revokeCredential(ownerId, toolId, { fetchImpl = fetch } = {}) {
    const credential = await readCredential(ownerId, toolId);
    if (!credential) return false;

    // The refresh token revokes the whole grant; the access token only itself.
    const token = credential.refreshToken ?? credential.accessToken;

    try {
        await fetchImpl(REVOKE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            // In the BODY, not the query string. The browser used to put the
            // token in the URL, where it lands in logs and history.
            body: new URLSearchParams({ token }).toString(),
        });
        return true;
    } catch (err) {
        logger.warn({ err, toolId }, 'google revoke failed; removing the local credential anyway');
        return false;
    }
}
