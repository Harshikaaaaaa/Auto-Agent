import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Google proxy route.
 *
 * This is the browser's ONLY path to Google, and the property under test is that
 * it is an allowlist of named operations, not a URL proxy: the browser cannot
 * name an endpoint, only an operation. `getAccessToken` is mocked (the OAuth flow
 * is tested elsewhere) and the outbound Google call is a fake fetch, so these
 * tests need neither credentials nor network.
 */

const originalEnv = { ...process.env };
const realFetch = globalThis.fetch.bind(globalThis);

let server;
let baseUrl;
/** The fake Google endpoint; each test sets its next response. */
let googleResponder;

async function call(body) {
    const res = await realFetch(`${baseUrl}/api/google/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // leave null
    }
    return { status: res.status, json };
}

beforeAll(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
        AUTOAGENT_SKIP_ENV_FILES: '1',
        AUTH_ENABLED: 'false',
        AI_PROVIDER: 'ollama',
        CREDENTIAL_SECRET: 'proxy-test-credential-secret-32-characters-min',
        GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3234/api/oauth/google/callback',
        LOG_LEVEL: 'silent',
    });
    vi.resetModules();

    // The proxy asks the OAuth module for a token; stub it so no credential store
    // or network is needed.
    vi.doMock('../../oauth/google.js', async () => {
        const actual = await vi.importActual('../../oauth/google.js');
        return {
            ...actual,
            getAccessToken: vi.fn(async () => 'test-access-token'),
        };
    });

    const { setupGoogleRoutes } = await import('../routes.js');

    // A per-test controllable fake for the Google call itself.
    const fetchImpl = vi.fn(async () => googleResponder());

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    // Stand in for requireSession, which api.js mounts in front of this route.
    app.use((req, _res, next) => {
        req.session = { sub: 'operator' };
        next();
    });
    setupGoogleRoutes(app, { fetchImpl });

    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    vi.doUnmock('../../oauth/google.js');
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
});

beforeEach(() => {
    // Default: Google says OK with an empty JSON body.
    googleResponder = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
});

describe('operation allowlist', () => {
    it('rejects an unknown operation', async () => {
        const { status, json } = await call({ operation: 'gmail_delete_everything', params: {} });
        expect(status).toBe(400);
        expect(json.error).toBe('invalid_request');
    });

    it('rejects a request with no operation', async () => {
        const { status } = await call({ params: {} });
        expect(status).toBe(400);
    });

    it('validates parameters against the operation schema', async () => {
        // sheets_get_values needs spreadsheetId + range.
        const { status, json } = await call({
            operation: 'sheets_get_values',
            params: { spreadsheetId: 'sheet-1' }, // range missing
        });
        expect(status).toBe(400);
        expect(json.error).toBe('invalid_params');
    });
});

describe('a valid call', () => {
    it('normalises the result to the declared fields, dropping the rest', async () => {
        googleResponder = () =>
            new Response(
                JSON.stringify({ range: 'Sheet1!A1:B2', values: [['a', 'b']], extra: 'dropped' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );

        const { status, json } = await call({
            operation: 'sheets_get_values',
            params: { spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2' },
        });

        expect(status).toBe(200);
        // Only the declared fields survive; 'extra' is dropped by operation.parse.
        expect(json.result).toEqual({ range: 'Sheet1!A1:B2', values: [['a', 'b']] });
    });

    it('never returns a token to the browser', async () => {
        const { json } = await call({
            operation: 'gmail_list_messages',
            params: { maxResults: 3 },
        });
        expect(JSON.stringify(json)).not.toContain('test-access-token');
    });
});

describe('upstream failures are classified', () => {
    const cases = [
        [401, 'google_auth_failed', 401],
        [403, 'google_auth_failed', 401],
        [429, 'google_rate_limited', 429],
        [404, 'google_not_found', 404],
        [500, 'google_unavailable', 502],
    ];

    it.each(cases)('maps Google %i to %s (HTTP %i)', async (googleStatus, code, httpStatus) => {
        googleResponder = () =>
            new Response(JSON.stringify({ error: { message: 'nope' } }), { status: googleStatus });

        const { status, json } = await call({
            operation: 'gmail_list_messages',
            params: {},
        });

        expect(status).toBe(httpStatus);
        expect(json.error).toBe(code);
        // A Google error body must not leak a token or a stack.
        expect(JSON.stringify(json)).not.toContain('test-access-token');
    });
});
