import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONFIG } from '@features/ai/config';
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

vi.mock('@features/ai/services/aiClient', () => ({
    requestNodeExecution: vi.fn()
}));

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
        meta: { provider: 'openrouter', model: 'test-model', attempts: 1 }
    });
});

describe('there is one execution engine', () => {
    const deleted = [
        'src/features/workflow/services/langgraphExecutor.ts',
        'src/features/workflow/services/checkpointManager.ts',
        'src/features/workflow/hooks/useWorkflowExecutionLangGraph.ts',
        'src/features/workflow/components/LangGraphDemo.tsx'
    ];

    it.each(deleted)('%s stays deleted', file => {
        expect(existsSync(join(process.cwd(), file))).toBe(false);
    });

    it('keeps the surviving engine', () => {
        expect(
            existsSync(join(process.cwd(), 'src/features/workflow/hooks/useWorkflowExecution.ts'))
        ).toBe(true);
    });

    it('does not import a LangChain runtime into the browser bundle', () => {
        const offenders = sourceFiles()
            .filter(file => {
                const source = readFileSync(file, 'utf8');
                // Only real imports count. The code exporters legitimately emit
                // LangGraph *Python* source as text, which must not trip this.
                return /from\s+['"]@langchain\/|require\(['"]@langchain\//.test(source);
            })
            .map(file => relative(process.cwd(), file));

        expect(offenders).toEqual([]);
    });

    it('has removed the legacy whole-graph generation path', () => {
        const legacy = [
            'src/features/ai/services/workflowNormalizer.ts',
            'src/features/ai/services/geminiService.ts',
            'src/features/ai/services/ollamaService.ts',
            'src/features/ai/services/openRouterService.ts'
        ];
        for (const file of legacy) {
            expect(existsSync(join(process.cwd(), file))).toBe(false);
        }

        // `requestWorkflow` reached /api/ai/workflow, which ran model output
        // through keyword-based tool binding — the reported defect's mechanism.
        const client = readFileSync(
            join(process.cwd(), 'src/features/ai/services/aiClient.ts'),
            'utf8'
        );
        expect(client).not.toContain('requestWorkflow');
        expect(client).not.toContain('/api/ai/workflow');
    });

    it('leaves the Python export templates alone', () => {
        // Exporting a workflow AS a LangGraph project is a product feature and is
        // unrelated to running one in the browser.
        const exporter = readFileSync(
            join(process.cwd(), 'src/features/workflow/services/workflowCodeExporter.ts'),
            'utf8'
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
                executionHistory: []
            }
        );

        expect(output).toEqual({ result: 'done' });
        expect(mockRequest).toHaveBeenCalledTimes(1);
        expect(mockRequest.mock.calls[0][0]).toMatchObject({
            nodeLabel: 'Summarise the page',
            nodeDescription: 'Write three bullets.',
            inputState: { extracted_text: 'hello' },
            outputKeys: ['summary'],
            provider: AI_CONFIG.provider
        });
    });

    it('passes the context buffer through so a node sees earlier results', async () => {
        await executeNodeAction('Step', '', {}, ['out'], {
            originalPrompt: 'do it',
            fullGraphState: { a: 1 },
            executionHistory: [{ nodeLabel: 'First', outputKeys: ['a'], outputSummary: '1' }]
        });

        expect(mockRequest.mock.calls[0][0].context).toMatchObject({
            originalPrompt: 'do it',
            executionHistory: [{ nodeLabel: 'First', outputKeys: ['a'], outputSummary: '1' }]
        });
    });

    it('reports a failure under every declared output key', async () => {
        mockRequest.mockRejectedValueOnce(new Error('provider unavailable'));

        const output = await executeNodeAction('Step', '', {}, ['summary', 'title']);

        // Preserved from the three modules this replaced. It is the wrong shape —
        // the run is recorded as completed with error strings as data — and Task 12
        // owns changing it. Pinned here so the change is deliberate.
        expect(output).toEqual({
            summary: 'Error: provider unavailable',
            title: 'Error: provider unavailable'
        });
    });
});
