import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiRequestError } from '@features/ai/services/aiClient';
import { NodeExecutionError } from '@features/workflow/services/nodeFailure';
import { executeNodeAction } from '../aiService';

/**
 * Task 11 tests.
 *
 * The project shipped TWO execution engines. `useWorkflowExecution` was the one
 * the canvas used; `langgraphExecutor` + `checkpointManager` +
 * `useWorkflowExecutionLangGraph` were a parallel implementation nothing
 * imported. They had already diverged — Task 4 had to replace `new Function`
 * in both, and Task 6's approval-from-side-effect rule only ever landed in one.
 * Two engines means every future fix has to be applied twice or silently isn't.
 *
 * Alongside them, `aiService` switched over three provider modules that Task 2
 * had reduced to byte-identical wrappers differing only in a string.
 *
 * The structural assertions below are the guard: a reintroduced second engine,
 * or a browser-side LangChain import, fails the suite rather than being noticed
 * in review.
 */

// Only the request function is faked. AiRequestError is the real class, because
// aiService branches on `instanceof`.
vi.mock('@features/ai/services/aiClient', async () => {
  const actual = await vi.importActual<typeof import('@features/ai/services/aiClient')>(
    '@features/ai/services/aiClient',
  );
  return { ...actual, requestNodeExecution: vi.fn() };
});

const { requestNodeExecution } = await import('@features/ai/services/aiClient');
const mockRequest = vi.mocked(requestNodeExecution);

const SRC_ROOT = join(process.cwd(), 'src');

/** Every .ts/.tsx file under src/, excluding tests. */
function sourceFiles(dir = SRC_ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({
    output: { result: 'done' },
    meta: { provider: 'openrouter', model: 'test-model', attempts: 1 },
  });
});

describe('there is one execution engine', () => {
  const deleted = [
    'src/features/workflow/services/langgraphExecutor.ts',
    'src/features/workflow/services/checkpointManager.ts',
    'src/features/workflow/hooks/useWorkflowExecutionLangGraph.ts',
    'src/features/workflow/components/LangGraphDemo.tsx',
  ];

  it.each(deleted)('%s stays deleted', (file) => {
    expect(existsSync(join(process.cwd(), file))).toBe(false);
  });

  it('keeps the surviving engine', () => {
    expect(
      existsSync(join(process.cwd(), 'src/features/workflow/hooks/useWorkflowExecution.ts')),
    ).toBe(true);
  });

  it('does not import a LangChain runtime into the browser bundle', () => {
    const offenders = sourceFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        // Only real imports count. The code exporters legitimately emit
        // LangGraph *Python* source as text, which must not trip this.
        return /from\s+['"]@langchain\/|require\(['"]@langchain\//.test(source);
      })
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });

  it('has removed the legacy whole-graph generation path', () => {
    const legacy = [
      'src/features/ai/services/workflowNormalizer.ts',
      'src/features/ai/services/geminiService.ts',
      'src/features/ai/services/ollamaService.ts',
      'src/features/ai/services/openRouterService.ts',
    ];
    for (const file of legacy) {
      expect(existsSync(join(process.cwd(), file))).toBe(false);
    }

    // `requestWorkflow` reached /api/ai/workflow, which ran model output
    // through keyword-based tool binding — the reported defect's mechanism.
    const client = readFileSync(
      join(process.cwd(), 'src/features/ai/services/aiClient.ts'),
      'utf8',
    );
    expect(client).not.toContain('requestWorkflow');
    expect(client).not.toContain('/api/ai/workflow');
  });

  it('leaves the Python export templates alone', () => {
    // Exporting a workflow AS a LangGraph project is a product feature and is
    // unrelated to running one in the browser.
    const exporter = readFileSync(
      join(process.cwd(), 'src/features/workflow/services/workflowCodeExporter.ts'),
      'utf8',
    );
    expect(exporter).toContain('from langgraph.graph import StateGraph');
  });
});

describe('executeNodeAction', () => {
  it('forwards the node to the server with the configured provider', async () => {
    const output = await executeNodeAction(
      'Summarise the page',
      'Write three bullets.',
      { extracted_text: 'hello' },
      ['summary'],
      {
        originalPrompt: 'summarise it',
        fullGraphState: { extracted_text: 'hello' },
        executionHistory: [],
      },
    );

    expect(output).toEqual({ result: 'done' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0]).toMatchObject({
      nodeLabel: 'Summarise the page',
      nodeDescription: 'Write three bullets.',
      inputState: { extracted_text: 'hello' },
      outputKeys: ['summary'],
      // 'auto' so the SERVER's AI_PROVIDER decides, rather than the client
      // forcing a provider that may have a smaller context window.
      provider: 'auto',
    });
  });

  it('sends a large input verbatim — the app imposes no size cap', async () => {
    // The app must never truncate or reject for size; only the AI provider's
    // own token limit applies. A big scraped article goes through unchanged.
    const huge = 'x'.repeat(500_000);
    await executeNodeAction('Summarize Content', 'Summarize.', { extracted_text: huge }, [
      'summary',
    ]);

    const sent = String(mockRequest.mock.calls[0][0].inputState?.extracted_text ?? '');
    expect(sent).toBe(huge); // untouched, no truncation marker
    expect(sent).not.toContain('truncated');
  });

  it('chunks and combines when the MODEL rejects the input for context length', async () => {
    // The one limit we cannot remove is the model's context window. When the
    // provider rejects the whole input, the node must split it, summarize each
    // chunk, and combine — not fail.
    const big = 'sentence one. '.repeat(2000); // large enough to split meaningfully
    let call = 0;
    mockRequest.mockReset();
    mockRequest.mockImplementation(async (req: { inputState?: Record<string, unknown> }) => {
      call += 1;
      const text = String(req.inputState?.extracted_text ?? '');
      // First call = the whole input: the model rejects it for context length.
      if (call === 1 && text.length > 5_000) {
        throw new AiRequestError('This endpoint maximum context length is 131072 tokens.', {
          status: 400,
          provider: 'openrouter',
        });
      }
      // Chunk calls and the combine call succeed.
      return {
        output: { summary: `partial-${call}` },
        meta: { provider: 'openrouter', model: 'test', attempts: 1 },
      };
    });

    const output = await executeNodeAction(
      'Summarize Content',
      'Summarize.',
      { extracted_text: big },
      ['summary'],
    );

    // It recovered: a summary came back rather than a thrown failure, and more
    // than one request was made (the chunks + the combine pass).
    expect(output).toHaveProperty('summary');
    expect(call).toBeGreaterThan(1);
  });

  it('passes the context buffer through so a node sees earlier results', async () => {
    await executeNodeAction('Step', '', {}, ['out'], {
      originalPrompt: 'do it',
      fullGraphState: { a: 1 },
      executionHistory: [{ nodeLabel: 'First', outputKeys: ['a'], outputSummary: '1' }],
    });

    expect(mockRequest.mock.calls[0][0].context).toMatchObject({
      originalPrompt: 'do it',
      executionHistory: [{ nodeLabel: 'First', outputKeys: ['a'], outputSummary: '1' }],
    });
  });

  it('throws instead of writing the error under every output key', async () => {
    mockRequest.mockRejectedValueOnce(new Error('provider unavailable'));

    // Until Task 12 this resolved to
    // `{ summary: 'Error: provider unavailable', title: 'Error: ...' }`.
    // The engine merged that into graph state, logged the node as completed,
    // and the next step summarised the sentence "Error: provider unavailable"
    // as if it were content.
    await expect(executeNodeAction('Step', '', {}, ['summary', 'title'])).rejects.toThrow(
      NodeExecutionError,
    );
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'invalid_input'],
  ])('maps HTTP %i onto the %s failure kind', async (status, expected) => {
    mockRequest.mockRejectedValueOnce(
      new AiRequestError('upstream said no', { status, code: 'provider_error' }),
    );

    await expect(executeNodeAction('Step', '', {}, ['out'])).rejects.toMatchObject({
      kind: expected,
    });
  });

  it('treats an unreachable server as transient, so the engine retries it', async () => {
    mockRequest.mockRejectedValueOnce(
      new AiRequestError('Could not reach the AutoAgent server.', {
        status: 0,
        code: 'network_error',
        retryable: true,
      }),
    );

    await expect(executeNodeAction('Step', '', {}, ['out'])).rejects.toMatchObject({
      kind: 'transient',
      retryable: true,
    });
  });
});
