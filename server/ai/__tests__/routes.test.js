import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

/**
 * Route-level tests against a real Express server on an ephemeral port.
 *
 * Uses the real HTTP stack (no supertest dependency) so body parsing, status
 * codes, and JSON error shapes are all exercised as deployed.
 */

const originalEnv = { ...process.env };
const TEST_KEY = 'sk-or-v1-routetestkey0123456789abcdefghij';

let server;
let baseUrl;
let setupAiRoutes;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stub the upstream provider with a fixed JSON completion. */
function stubProvider(content) {
  const mock = vi.fn(async () => jsonResponse({ choices: [{ message: { content } }] }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function post(path, body) {
  // `realFetch` is captured before any stubbing so tests can still make
  // requests to their own server while the provider fetch is mocked.
  const res = await realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Leave json null; some assertions only need the status.
  }
  return { status: res.status, json, text };
}

const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: TEST_KEY,
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'a'.repeat(64),
    LOG_LEVEL: 'silent',
  });
  vi.resetModules();
  ({ setupAiRoutes } = await import('../routes.js'));

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  setupAiRoutes(app);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mirrors the shape produced by the client's describeCatalog(). */
const MINIMAL_CATALOG = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Email',
    category: 'communication',
    capabilities: ['email.send'],
    authenticated: true,
    actions: [
      {
        name: 'send_email',
        description: 'Send an email',
        capabilities: ['email.send'],
        sideEffect: 'irreversible',
        requiresAuth: true,
        requiresApproval: true,
        inputs: [
          {
            name: 'to',
            type: 'string',
            description: 'Recipient address.',
            required: true,
            external: true,
            format: 'email',
          },
          { name: 'subject', type: 'string', description: 'Subject line.', required: true },
        ],
        outputs: [{ name: 'email_status', type: 'string', description: 'Outcome.' }],
        inputKeys: ['to', 'subject'],
        outputKeys: ['email_status'],
      },
    ],
  },
];

describe('POST /api/ai/plan', () => {
  it('rejects a request with no prompt', async () => {
    const { status, json } = await post('/api/ai/plan', { catalog: [] });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expect(json.issues.some((i) => i.path === 'prompt')).toBe(true);
  });

  it('rejects an over-long prompt instead of forwarding it upstream', async () => {
    const fetchMock = stubProvider('{}');
    const { status } = await post('/api/ai/plan', { prompt: 'x'.repeat(8_001), catalog: [] });
    expect(status).toBe(400);
    // Critically, no upstream call (and no token spend) happened.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a model id containing path characters', async () => {
    // The model id is interpolated into a provider URL path for Gemini.
    const fetchMock = stubProvider('{}');
    const { status, json } = await post('/api/ai/plan', {
      prompt: 'do a thing',
      catalog: [],
      model: '../../etc/passwd?x=1',
    });
    expect(status).toBe(400);
    expect(json.issues.some((i) => i.path === 'model')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the parsed plan and provider metadata', async () => {
    stubProvider(JSON.stringify({ title: 'A plan', steps: [{ id: 'start', order: 1 }] }));
    const { status, json } = await post('/api/ai/plan', {
      prompt: 'send an email',
      catalog: MINIMAL_CATALOG,
    });

    expect(status).toBe(200);
    expect(json.plan.title).toBe('A plan');
    expect(json.meta.provider).toBe('openrouter');
    expect(json.meta.attempts).toBe(1);
  });

  it('includes the catalog in the prompt sent upstream', async () => {
    const fetchMock = stubProvider('{"title":"x","steps":[]}');
    await post('/api/ai/plan', { prompt: 'send an email', catalog: MINIMAL_CATALOG });

    const sentPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(sentPrompt).toContain('gmail');
    expect(sentPrompt).toContain('send_email');
    // The anti-substitution rule must actually reach the model.
    expect(sentPrompt).toMatch(/unsupported/i);
    expect(sentPrompt).toMatch(/Do NOT substitute/i);
  });

  it('renders the capability metadata the planner needs', async () => {
    const fetchMock = stubProvider('{"title":"x","steps":[]}');
    await post('/api/ai/plan', { prompt: 'send an email', catalog: MINIMAL_CATALOG });

    const sentPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;

    // Safety class and the approval consequence.
    expect(sentPrompt).toContain('sideEffect: irreversible');
    expect(sentPrompt).toContain('pauses for human approval');
    // Capability tags, so the model can reason about what is available at all.
    expect(sentPrompt).toContain('email.send');
    // Which inputs the user must supply, versus what an earlier step can produce.
    expect(sentPrompt).toContain('user-supplied');
    expect(sentPrompt).toContain('required');
    expect(sentPrompt).toContain('communication');
  });

  it('does not spend prompt tokens on cost hints', async () => {
    const fetchMock = stubProvider('{"title":"x","steps":[]}');
    await post('/api/ai/plan', { prompt: 'send an email', catalog: MINIMAL_CATALOG });

    const sentPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(sentPrompt).not.toContain('latencyMs');
    expect(sentPrompt).not.toContain('reliability');
  });

  it('maps a provider auth failure to a safe error without the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`{"error":"bad key ${TEST_KEY}"}`, { status: 401 })),
    );
    const { status, json, text } = await post('/api/ai/plan', { prompt: 'hello', catalog: [] });

    expect(status).toBe(502);
    expect(json.error).toBe('provider_error');
    expect(text).not.toContain(TEST_KEY);
  });

  it('passes a rate limit through as 429 and flags it retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    const { status, json } = await post('/api/ai/plan', { prompt: 'hello', catalog: [] });

    expect(status).toBe(429);
    expect(json.retryable).toBe(true);
  });
});

describe('POST /api/ai/node', () => {
  it('requires at least one output key', async () => {
    const { status, json } = await post('/api/ai/node', {
      nodeLabel: 'Summarize',
      outputKeys: [],
    });
    expect(status).toBe(400);
    expect(json.issues.some((i) => i.path === 'outputKeys')).toBe(true);
  });

  it('returns the node output', async () => {
    stubProvider('{"summary":"done"}');
    const { status, json } = await post('/api/ai/node', {
      nodeLabel: 'Summarize',
      nodeDescription: 'Summarize the input',
      inputState: { text: 'hello world' },
      outputKeys: ['summary'],
    });

    expect(status).toBe(200);
    expect(json.output).toEqual({ summary: 'done' });
  });

  it('passes prior execution context into the prompt', async () => {
    const fetchMock = stubProvider('{"summary":"done"}');
    await post('/api/ai/node', {
      nodeLabel: 'Summarize',
      outputKeys: ['summary'],
      context: {
        originalPrompt: 'the original goal',
        fullGraphState: { raw_data: 'abc' },
        executionHistory: [{ nodeLabel: 'Scrape', outputKeys: ['raw_data'] }],
      },
    });

    const sentPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(sentPrompt).toContain('the original goal');
    expect(sentPrompt).toContain('Scrape');
    expect(sentPrompt).toContain('raw_data');
  });

  it('accepts a very large input and context without a shape rejection', async () => {
    // A whole scraped article in the input and a large prior-output summary in
    // context must NOT be rejected as "did not match the expected shape" — the
    // AI node takes any size the workflow produces.
    stubProvider('{"summary":"done"}');
    const huge = 'x'.repeat(300_000);
    const { status, json } = await post('/api/ai/node', {
      nodeLabel: 'Summarize Content',
      nodeDescription: 'Summarize.',
      inputState: { extracted_text: huge },
      outputKeys: ['summary'],
      context: {
        originalPrompt: huge,
        executionHistory: [{ nodeLabel: 'Extract', outputSummary: huge }],
      },
    });

    expect(status).toBe(200);
    expect(json.output).toEqual({ summary: 'done' });
  });
});

describe('POST /api/ai/patch', () => {
  it('requires a graph', async () => {
    const { status } = await post('/api/ai/patch', { message: 'remove the sheets step' });
    expect(status).toBe(400);
  });

  it('returns operations and lists existing node ids in the prompt', async () => {
    const fetchMock = stubProvider(
      JSON.stringify({ summary: 'removed', operations: [{ op: 'removeNode', nodeId: 'n2' }] }),
    );
    const { status, json } = await post('/api/ai/patch', {
      message: 'I did not mention Google Sheets, fix it',
      graph: {
        nodes: [
          { id: 'n1', label: 'Start', type: 'trigger' },
          { id: 'n2', label: 'Save to Sheets', type: 'tool', toolId: 'google_sheets' },
        ],
        edges: [{ source: 'n1', target: 'n2' }],
      },
      catalog: MINIMAL_CATALOG,
    });

    expect(status).toBe(200);
    expect(json.patch.operations[0]).toEqual({ op: 'removeNode', nodeId: 'n2' });

    const sentPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(sentPrompt).toContain('id="n2"');
    // The rule that prevents the "added If Condition" defect must be present.
    expect(sentPrompt).toMatch(/Do not add an unrelated node/i);
  });

  it('supports returning a clarifying question instead of guessing', async () => {
    stubProvider(
      JSON.stringify({ summary: 'unclear', clarification: 'Which step?', operations: [] }),
    );
    const { status, json } = await post('/api/ai/patch', {
      message: 'change it',
      graph: { nodes: [{ id: 'n1' }] },
      catalog: [],
    });

    expect(status).toBe(200);
    expect(json.patch.operations).toEqual([]);
    expect(json.patch.clarification).toBe('Which step?');
  });

  it('puts retry feedback in its own section, not inside the user instruction', async () => {
    const fetchMock = stubProvider(JSON.stringify({ summary: 'ok', operations: [] }));
    await post('/api/ai/patch', {
      message: 'remove the sheets step',
      graph: { nodes: [{ id: 'n1', label: 'Start' }] },
      catalog: [],
      repairFeedback: 'Operation 1 refers to nodeId "n9", which is not a node.',
    });

    const sentPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(sentPrompt).toContain('YOUR PREVIOUS ANSWER WAS REJECTED');
    expect(sentPrompt).toContain('is not a node');

    // The instruction section is fenced as untrusted data the model is told not
    // to take orders from. Feedback placed there would be ignored by design, so
    // it has to appear BEFORE that block.
    expect(sentPrompt.indexOf('YOUR PREVIOUS ANSWER WAS REJECTED')).toBeLessThan(
      sentPrompt.indexOf('USER INSTRUCTION'),
    );
  });
});

describe('GET /api/ai/config', () => {
  it('reports provider availability without exposing any key', async () => {
    const res = await realFetch(`${baseUrl}/api/ai/config`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain(TEST_KEY);
    const json = JSON.parse(text);
    expect(json.defaultProvider).toBe('openrouter');
    expect(json.providers.openrouter.configured).toBe(true);
  });
});
