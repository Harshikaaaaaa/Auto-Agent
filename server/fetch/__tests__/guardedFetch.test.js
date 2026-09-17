import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'http';

/**
 * Transport behaviour of the guarded fetch, over real HTTP.
 *
 * A local test server stands in for a remote site. `resolveAddresses` is
 * injected so a fake public hostname resolves to it — URL validation is NOT
 * injected, so every redirect target is still judged by the real policy. That is
 * what makes the "public host redirects to the metadata endpoint" test
 * meaningful rather than circular.
 */

const originalEnv = { ...process.env };

/** Fake public hostname pointed at the local test server. */
const TEST_HOST = 'test-site.example';

let server;
let port;
let guardedFetch;
let routes;

/** Behaviour for the next request, set per test. */
let handler = (_req, res) => res.end('ok');

beforeAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'h'.repeat(64),
    LOG_LEVEL: 'silent',
    FETCH_MAX_BYTES: '2048',
    FETCH_MAX_REDIRECTS: '3',
    FETCH_TIMEOUT_MS: '1000',
  });
  vi.resetModules();

  routes = await import('../routes.js');
  guardedFetch = routes.guardedFetch;

  server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

afterEach(() => {
  handler = (_req, res) => res.end('ok');
});

/** Resolver that sends the fake public host to the local test server. */
const resolveToTestServer = async (hostname) => {
  if (hostname === TEST_HOST) return [{ address: '127.0.0.1', family: 4 }];
  // Anything else goes through the real policy, which will refuse it.
  const { resolveAllowedAddresses } = await import('../../lib/ssrfGuard.js');
  return resolveAllowedAddresses(hostname);
};

const fetchTestUrl = (path = '/', options = {}) =>
  guardedFetch({
    url: `http://${TEST_HOST}:${port}${path}`,
    resolveAddresses: resolveToTestServer,
    ...options,
  });

describe('successful fetches', () => {
  it('returns the body, status and content type', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>hello</body></html>');
    };

    const result = await fetchTestUrl('/page');

    expect(result.status).toBe(200);
    expect(result.body).toContain('hello');
    expect(result.contentType).toContain('text/html');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.finalUrl).toContain('/page');
  });

  it('sends a descriptive user agent rather than impersonating a browser', async () => {
    let seenUserAgent = '';
    handler = (req, res) => {
      seenUserAgent = req.headers['user-agent'];
      res.end('ok');
    };

    await fetchTestUrl('/');
    expect(seenUserAgent).toContain('AutoAgentBot');
  });

  it('drops caller headers that could forge identity to an internal service', async () => {
    let seen = {};
    handler = (req, res) => {
      seen = req.headers;
      res.end('ok');
    };

    await fetchTestUrl('/', {
      headers: {
        Authorization: 'Bearer stolen-token',
        Cookie: 'session=stolen',
        'X-Forwarded-For': '10.0.0.1',
        'Accept-Language': 'en-GB',
      },
    });

    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(seen['x-forwarded-for']).toBeUndefined();
    // The allowlisted one does get through.
    expect(seen['accept-language']).toBe('en-GB');
  });

  it('passes an error status through instead of throwing', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
    };

    const result = await fetchTestUrl('/missing');
    expect(result.status).toBe(404);
  });
});

describe('redirects', () => {
  it('follows a redirect and reports the final URL', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `http://${TEST_HOST}:${port}/end` });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('arrived');
    };

    const result = await fetchTestUrl('/start');

    expect(result.body).toBe('arrived');
    expect(result.finalUrl).toContain('/end');
    expect(result.redirects).toHaveLength(1);
  });

  it('REFUSES a public host that redirects to the cloud metadata endpoint', async () => {
    // The attack this exists for: the first hop looks innocuous, and the
    // redirect target is where credentials live.
    handler = (_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    };

    await expect(fetchTestUrl('/redirect-to-metadata')).rejects.toThrow(
      /private or reserved range/i,
    );
  });

  it('REFUSES a redirect to loopback', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:3306/' });
      res.end();
    };

    await expect(fetchTestUrl('/redirect-to-loopback')).rejects.toThrow(
      /private or reserved range/i,
    );
  });

  it('REFUSES a redirect to a file URL', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    };

    await expect(fetchTestUrl('/redirect-to-file')).rejects.toThrow(/only http and https/i);
  });

  it('stops after the redirect limit', async () => {
    let hop = 0;
    handler = (_req, res) => {
      hop += 1;
      res.writeHead(302, { Location: `http://${TEST_HOST}:${port}/hop-${hop}` });
      res.end();
    };

    await expect(fetchTestUrl('/hop-0')).rejects.toThrow(/redirected more than 3 times/i);
  });

  it('detects a redirect loop', async () => {
    handler = (req, res) => {
      const next = req.url === '/a' ? '/b' : '/a';
      res.writeHead(302, { Location: `http://${TEST_HOST}:${port}${next}` });
      res.end();
    };

    await expect(fetchTestUrl('/a')).rejects.toThrow(/loop/i);
  });
});

describe('size limits', () => {
  it('rejects a response whose declared length is over the cap', async () => {
    const body = 'x'.repeat(5000); // cap is 2048 for this suite
    handler = (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(body.length),
      });
      res.end(body);
    };

    await expect(fetchTestUrl('/big')).rejects.toThrow(/over the 2048 byte limit/i);
  });

  it('rejects an oversized response that declares no length', async () => {
    // Chunked encoding with no Content-Length: the cap has to be enforced while
    // streaming, or a lying server bypasses it.
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      for (let i = 0; i < 10; i += 1) res.write('y'.repeat(500));
      res.end();
    };

    await expect(fetchTestUrl('/streaming-big')).rejects.toThrow(/exceeded the 2048 byte limit/i);
  });

  it('honours a smaller per-request cap', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('z'.repeat(1000));
    };

    await expect(fetchTestUrl('/medium', { maxBytes: 100 })).rejects.toThrow(/byte limit/i);
  });

  it('cannot be raised above the server cap by the request', async () => {
    const body = 'x'.repeat(4000);
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
    };

    // Asking for 10MB must not lift the 2048 byte server limit.
    await expect(fetchTestUrl('/big', { maxBytes: 10_000_000 })).rejects.toThrow(/byte limit/i);
  });

  it('accepts a response inside the cap', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('small enough');
    };

    const result = await fetchTestUrl('/small');
    expect(result.body).toBe('small enough');
  });
});

describe('timeouts', () => {
  it('gives up on a server that never responds', async () => {
    handler = () => {
      // Deliberately never respond; the 1000ms timeout must fire.
    };

    await expect(fetchTestUrl('/hang')).rejects.toThrow(/did not respond within 1000ms/i);
  }, 10_000);
});

describe('content types', () => {
  it('rejects binary content instead of proxying it', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2, 3]));
    };

    await expect(fetchTestUrl('/binary')).rejects.toThrow(/cannot read/i);
  });

  it('rejects an image', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50]));
    };

    await expect(fetchTestUrl('/image')).rejects.toThrow(/cannot read/i);
  });

  it('accepts JSON', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    };

    const result = await fetchTestUrl('/api');
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});

describe('the real policy applies without injection', () => {
  it('refuses loopback when the guarded resolver is used', async () => {
    // No resolver override: this is the production path.
    await expect(guardedFetch({ url: `http://127.0.0.1:${port}/` })).rejects.toThrow(
      /private or reserved range/i,
    );
  });

  it('refuses the metadata endpoint', async () => {
    await expect(
      guardedFetch({ url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow(/private or reserved range/i);
  });

  it('refuses localhost by name', async () => {
    await expect(guardedFetch({ url: `http://localhost:${port}/` })).rejects.toThrow(
      /host is not allowed/i,
    );
  });
});
