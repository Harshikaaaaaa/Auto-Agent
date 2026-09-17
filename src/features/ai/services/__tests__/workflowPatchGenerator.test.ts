import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@features/tools/connectors';
import { NodeType } from '@/shared/types';
import type { WorkflowEdge, WorkflowNode } from '@features/workflow/types';
import {
    applyPatch,
    describeOperation,
    generateGraphPatch,
    isDestructive,
    PatchValidationError,
    type GraphOperation,
    type GraphPatch
} from '../workflowPatchGenerator';

/**
 * Task 10 tests.
 *
 * The reported defect: with a Google Sheets step on the canvas the user typed
 * "I didnt mnentioned googlesheets in promt fix it" and the app added an
 * "If Condition" node. The old handler checked the message for rename/delete/
 * clear and, failing those, ran
 * `reusableHelperNodes.find(label matches approval|validation|wait|condition|...)`
 * — a search that never looked at the message at all — and added whatever it
 * found. It could not fail to do something, and it had no way to express a
 * removal it had not hardcoded.
 *
 * The guarantee these tests protect: an instruction either becomes operations
 * that are valid against THIS graph, or it becomes a question or an error. Never
 * an unrelated node.
 */

vi.mock('@features/ai/services/aiClient', () => ({
    requestPatch: vi.fn()
}));

const { requestPatch } = await import('@features/ai/services/aiClient');
const mockRequestPatch = vi.mocked(requestPatch);

function respondWith(...answers: unknown[]) {
    mockRequestPatch.mockReset();
    for (const answer of answers) {
        mockRequestPatch.mockResolvedValueOnce({
            patch: answer,
            meta: { provider: 'test', model: 'test-model', attempts: 1 }
        });
    }
}

function node(
    id: string,
    label: string,
    extra: Partial<WorkflowNode['data']> = {},
    x = 0
): WorkflowNode {
    return {
        id,
        type: extra.toolId ? NodeType.TOOL : NodeType.AI_AGENT,
        position: { x, y: 0 },
        data: { label, type: extra.toolId ? NodeType.TOOL : NodeType.AI_AGENT, ...extra }
    };
}

function edge(source: string, target: string, condition?: string): WorkflowEdge {
    return { id: `edge_${source}_${target}`, source, target, ...(condition ? { condition } : {}) };
}

/** The graph from the report: a scrape flow that ends in Google Sheets. */
const SHEETS_GRAPH = {
    nodes: [
        node('start', 'Start', {}, 0),
        node('fetch', 'Fetch the page', { toolId: 'web', toolAction: 'fetch_page' }, 250),
        node(
            'save_sheets',
            'Save results to Google Sheets',
            { toolId: 'google_sheets', toolAction: 'append_row' },
            500
        )
    ],
    edges: [edge('start', 'fetch'), edge('fetch', 'save_sheets')]
};

const REPORTED_MESSAGE = 'I didnt mnentioned googlesheets in promt fix it';

beforeEach(() => {
    mockRequestPatch.mockReset();
});

describe('the reported defect', () => {
    it('removes the Google Sheets step instead of adding something unrelated', async () => {
        respondWith({
            summary: 'Removed the Google Sheets step.',
            clarification: null,
            operations: [{ op: 'removeNode', nodeId: 'save_sheets' }]
        });

        const patch = await generateGraphPatch(REPORTED_MESSAGE, SHEETS_GRAPH);

        expect(patch.operations).toEqual([{ op: 'removeNode', nodeId: 'save_sheets' }]);
        // The specific wrong behaviour: nothing is added.
        expect(patch.operations.some(op => op.op === 'addNode')).toBe(false);

        const result = applyPatch(SHEETS_GRAPH, patch);
        expect(result.nodes.map(n => n.id)).toEqual(['start', 'fetch']);
        expect(result.applied).toEqual(['Removed “Save results to Google Sheets”']);
    });

    it('asks a question rather than adding a node when the instruction is unclear', async () => {
        respondWith({
            summary: '',
            clarification: 'Which step did you want removed?',
            operations: []
        });

        const patch = await generateGraphPatch('fix it', SHEETS_GRAPH);

        expect(patch.operations).toEqual([]);
        expect(patch.clarification).toBe('Which step did you want removed?');

        // And applying an empty patch changes nothing at all.
        const result = applyPatch(SHEETS_GRAPH, patch);
        expect(result.nodes).toHaveLength(3);
        expect(result.edges).toHaveLength(2);
        expect(result.applied).toEqual([]);
    });

    it('rejects a "did nothing and said nothing" answer', async () => {
        respondWith(
            { summary: 'ok', clarification: null, operations: [] },
            {
                summary: 'Removed the Google Sheets step.',
                clarification: null,
                operations: [{ op: 'removeNode', nodeId: 'save_sheets' }]
            }
        );

        await generateGraphPatch(REPORTED_MESSAGE, SHEETS_GRAPH);

        expect(mockRequestPatch).toHaveBeenCalledTimes(2);
        expect(String(mockRequestPatch.mock.calls[1][0].repairFeedback)).toContain(
            'no operations and no clarification'
        );
    });

    it('sends the real graph, not a summary of it', async () => {
        respondWith({
            summary: 'ok',
            clarification: null,
            operations: [{ op: 'removeNode', nodeId: 'save_sheets' }]
        });

        await generateGraphPatch(REPORTED_MESSAGE, SHEETS_GRAPH);
        const sent = mockRequestPatch.mock.calls[0][0];

        expect(sent.graph.nodes.map(n => n.id)).toEqual(['start', 'fetch', 'save_sheets']);
        expect(sent.graph.nodes[2]).toMatchObject({
            toolId: 'google_sheets',
            toolAction: 'append_row'
        });
        expect(sent.graph.edges).toHaveLength(2);
        expect(sent.catalog.map(tool => tool.id)).toContain('google_sheets');
        // First attempt carries the instruction verbatim and no repair feedback.
        expect(sent.message).toBe(REPORTED_MESSAGE);
        expect(sent.repairFeedback).toBeUndefined();
    });
});

describe('validation against this graph', () => {
    it('rejects an operation on a node that does not exist', async () => {
        respondWith(
            { operations: [{ op: 'removeNode', nodeId: 'sheets_node' }] },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch(REPORTED_MESSAGE, SHEETS_GRAPH);

        const retry = String(mockRequestPatch.mock.calls[1][0].repairFeedback);
        expect(retry).toContain('"sheets_node"');
        expect(retry).toContain('not a node in this workflow');
        // The real ids are listed so the retry has something to aim at.
        expect(retry).toContain('save_sheets');
        // The instruction itself is unchanged; feedback rides its own field so it
        // is not buried inside the prompt's untrusted-data fence.
        expect(mockRequestPatch.mock.calls[1][0].message).toBe(REPORTED_MESSAGE);
    });

    it('rejects a fabricated toolId', async () => {
        respondWith(
            {
                operations: [
                    {
                        op: 'addNode',
                        label: 'Save to Notion',
                        nodeType: 'tool',
                        toolId: 'notion',
                        toolAction: 'create_page',
                        after: 'fetch'
                    }
                ]
            },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('save it to notion', SHEETS_GRAPH);

        const retry = String(mockRequestPatch.mock.calls[1][0].repairFeedback);
        expect(retry).toContain('"notion"');
        expect(retry).toContain('not in the catalog');
    });

    it('rejects an action the tool does not have', async () => {
        respondWith(
            {
                operations: [
                    {
                        op: 'replaceNode',
                        nodeId: 'save_sheets',
                        label: 'Delete the sheet',
                        nodeType: 'tool',
                        toolId: 'google_sheets',
                        toolAction: 'delete_spreadsheet'
                    }
                ]
            },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('delete the sheet', SHEETS_GRAPH);

        const retry = String(mockRequestPatch.mock.calls[1][0].repairFeedback);
        expect(retry).toContain('"delete_spreadsheet"');
        expect(retry).toContain('does not have');
    });

    it('rejects a tool node that binds nothing', async () => {
        respondWith(
            { operations: [{ op: 'addNode', label: 'Do the thing', nodeType: 'tool' }] },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('add a step', SHEETS_GRAPH);

        expect(String(mockRequestPatch.mock.calls[1][0].repairFeedback)).toContain(
            'names no toolId/toolAction'
        );
    });

    it('rejects an unsupported node type', async () => {
        respondWith(
            { operations: [{ op: 'addNode', label: 'Wait a bit', nodeType: 'sleep' }] },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('wait first', SHEETS_GRAPH);

        expect(String(mockRequestPatch.mock.calls[1][0].repairFeedback)).toContain('nodeType "sleep"');
    });

    it('rejects an operation it does not support', async () => {
        respondWith(
            { operations: [{ op: 'dropDatabase', nodeId: 'save_sheets' }] },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('nuke it', SHEETS_GRAPH);

        expect(String(mockRequestPatch.mock.calls[1][0].repairFeedback)).toContain(
            'is not an operation I support'
        );
    });

    it('rejects a routing condition the evaluator cannot use', async () => {
        respondWith(
            {
                operations: [
                    { op: 'setCondition', source: 'fetch', target: 'save_sheets', condition: '((((' }
                ]
            },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('only save on success', SHEETS_GRAPH);

        // A condition the compiler rejects would fail closed at run time and
        // silently skip the branch, so it is caught here instead.
        expect(String(mockRequestPatch.mock.calls[1][0].repairFeedback)).toContain(
            'condition the evaluator cannot use'
        );
    });

    it('accepts a JS-style condition, which the evaluator normalises', async () => {
        respondWith({
            summary: 'Only save positive results.',
            operations: [
                {
                    op: 'setCondition',
                    source: 'fetch',
                    target: 'save_sheets',
                    condition: "sentiment === 'positive'"
                }
            ]
        });

        const patch = await generateGraphPatch('only save positive ones', SHEETS_GRAPH);

        expect(mockRequestPatch).toHaveBeenCalledTimes(1);
        expect(patch.operations[0]).toMatchObject({ op: 'setCondition' });
    });

    it('refuses a self-loop', async () => {
        respondWith(
            { operations: [{ op: 'addEdge', source: 'fetch', target: 'fetch' }] },
            { operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        );

        await generateGraphPatch('loop it', SHEETS_GRAPH);

        expect(String(mockRequestPatch.mock.calls[1][0].repairFeedback)).toContain('to itself');
    });

    it('throws after one failed repair rather than applying something wrong', async () => {
        const bad = { operations: [{ op: 'removeNode', nodeId: 'no_such_node' }] };
        respondWith(bad, bad);

        await expect(generateGraphPatch(REPORTED_MESSAGE, SHEETS_GRAPH)).rejects.toThrow(
            PatchValidationError
        );
        expect(mockRequestPatch).toHaveBeenCalledTimes(2);
    });

    it('accepts a patch wrapped in a redundant "patch" key', async () => {
        respondWith({
            patch: { summary: 'ok', operations: [{ op: 'removeNode', nodeId: 'save_sheets' }] }
        });

        const patch = await generateGraphPatch(REPORTED_MESSAGE, SHEETS_GRAPH);

        expect(mockRequestPatch).toHaveBeenCalledTimes(1);
        expect(patch.operations).toHaveLength(1);
    });
});

describe('applying operations', () => {
    /** Apply a hand-built patch without going near the model. */
    function apply(
        graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
        ...operations: GraphOperation[]
    ) {
        return applyPatch(graph, { summary: '', clarification: null, operations });
    }

    it('never adds a node unless an addNode operation says so', () => {
        const before = SHEETS_GRAPH.nodes.length;

        for (const operation of [
            { op: 'removeNode', nodeId: 'save_sheets' },
            { op: 'removeEdge', source: 'fetch', target: 'save_sheets' },
            { op: 'updateNodeConfig', nodeId: 'fetch', label: 'Grab it', description: null, config: {} },
            { op: 'reorder', nodeIds: ['save_sheets', 'fetch', 'start'] }
        ] as GraphOperation[]) {
            const result = apply(SHEETS_GRAPH, operation);
            expect(result.nodes.length).toBeLessThanOrEqual(before);
        }
    });

    it('does not mutate the graph it was given', () => {
        apply(SHEETS_GRAPH, { op: 'removeNode', nodeId: 'save_sheets' });
        expect(SHEETS_GRAPH.nodes).toHaveLength(3);
        expect(SHEETS_GRAPH.edges).toHaveLength(2);
    });

    it('closes the chain when a middle step is removed', () => {
        const result = apply(SHEETS_GRAPH, { op: 'removeNode', nodeId: 'fetch' });

        expect(result.nodes.map(n => n.id)).toEqual(['start', 'save_sheets']);
        // Removing a middle step must not cut the workflow in half.
        expect(result.edges.map(e => `${e.source}->${e.target}`)).toEqual(['start->save_sheets']);
    });

    it('carries the incoming condition across a removed step', () => {
        const graph = {
            nodes: SHEETS_GRAPH.nodes,
            edges: [edge('start', 'fetch', "ok == true"), edge('fetch', 'save_sheets')]
        };

        const result = apply(graph, { op: 'removeNode', nodeId: 'fetch' });

        expect(result.edges[0]).toMatchObject({
            source: 'start',
            target: 'save_sheets',
            condition: 'ok == true'
        });
    });

    it('splices an added node into the chain rather than orphaning the tail', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'addNode',
            label: 'Summarise as Markdown',
            nodeType: 'tool',
            description: 'Format it.',
            toolId: 'content',
            toolAction: 'to_markdown',
            after: 'fetch'
        });

        expect(result.nodes.map(n => n.id)).toEqual([
            'start',
            'fetch',
            'summarise_as_markdown',
            'save_sheets'
        ]);
        expect(result.edges.map(e => `${e.source}->${e.target}`)).toEqual([
            'start->fetch',
            'fetch->summarise_as_markdown',
            'summarise_as_markdown->save_sheets'
        ]);
        expect(result.applied).toEqual(['Added “Summarise as Markdown” after “Fetch the page”']);
    });

    it('takes an added tool nodes state keys from the action schema', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'addNode',
            label: 'Email the summary',
            nodeType: 'tool',
            description: '',
            toolId: 'gmail',
            toolAction: 'send_email',
            after: 'save_sheets'
        });

        const added = result.nodes[result.nodes.length - 1];
        expect(added.data.toolId).toBe('gmail');
        expect(added.data.stateContract?.inputKeys).toContain('to');
        expect(added.data.stateContract?.externalInputKeys).toContain('to');
        // Sending cannot be undone, so the gate is set from the registry.
        expect(added.data.requiresApproval).toBe(true);
    });

    it('does not gate an added read-only node', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'addNode',
            label: 'Read the inbox',
            nodeType: 'tool',
            description: '',
            toolId: 'gmail',
            toolAction: 'read_inbox',
            after: 'start'
        });

        const added = result.nodes.find(n => n.id === 'read_the_inbox');
        expect(added?.data.requiresApproval).toBe(false);
    });

    it('gives a unique id to a node whose label collides with an existing id', () => {
        // "Start" slugs to `start`, which is already taken.
        const result = apply(SHEETS_GRAPH, {
            op: 'addNode',
            label: 'Start',
            nodeType: 'ai_agent',
            description: '',
            toolId: null,
            toolAction: null,
            after: 'start'
        });

        // A collision would merge two graph nodes into one.
        expect(new Set(result.nodes.map(n => n.id)).size).toBe(result.nodes.length);
        expect(result.nodes.map(n => n.id)).toEqual([
            'start',
            'start_2',
            'fetch',
            'save_sheets'
        ]);
    });

    it('gives two nodes added in one patch distinct ids', () => {
        const spec = {
            op: 'addNode' as const,
            nodeType: 'ai_agent' as const,
            description: '',
            toolId: null,
            toolAction: null
        };
        const result = apply(
            SHEETS_GRAPH,
            { ...spec, label: 'Review it', after: 'fetch' },
            { ...spec, label: 'Review it', after: 'fetch' }
        );

        expect(new Set(result.nodes.map(n => n.id)).size).toBe(result.nodes.length);
        expect(result.nodes.map(n => n.id)).toContain('review_it');
        expect(result.nodes.map(n => n.id)).toContain('review_it_2');
    });

    it('replaces a node in place, keeping its id and position', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'replaceNode',
            nodeId: 'save_sheets',
            label: 'Download as Markdown',
            nodeType: 'tool',
            description: 'Deliver the file.',
            toolId: 'files',
            toolAction: 'download_file'
        });

        const replaced = result.nodes.find(n => n.id === 'save_sheets');
        expect(replaced?.data.label).toBe('Download as Markdown');
        expect(replaced?.data.toolId).toBe('files');
        expect(replaced?.position).toEqual({ x: 500, y: 0 });
        // The edges around it survive, so a replace is not a delete plus an add.
        expect(result.edges.map(e => `${e.source}->${e.target}`)).toEqual([
            'start->fetch',
            'fetch->save_sheets'
        ]);
    });

    it('merges updateNodeConfig into node data', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'updateNodeConfig',
            nodeId: 'save_sheets',
            label: 'Append the row',
            description: null,
            config: { spreadsheetId: 'abc123' }
        });

        const updated = result.nodes.find(n => n.id === 'save_sheets');
        expect(updated?.data.label).toBe('Append the row');
        expect(updated?.data.spreadsheetId).toBe('abc123');
        // Untouched fields survive.
        expect(updated?.data.toolAction).toBe('append_row');
    });

    it('adds an edge once', () => {
        const result = apply(
            SHEETS_GRAPH,
            { op: 'addEdge', source: 'start', target: 'save_sheets', condition: null },
            { op: 'addEdge', source: 'start', target: 'save_sheets', condition: null }
        );

        expect(result.edges.filter(e => e.source === 'start' && e.target === 'save_sheets')).toHaveLength(1);
    });

    it('sets a condition on an existing edge', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'setCondition',
            source: 'fetch',
            target: 'save_sheets',
            condition: "fetch_status == 200"
        });

        expect(result.edges.find(e => e.target === 'save_sheets')?.condition).toBe(
            'fetch_status == 200'
        );
        expect(result.edges).toHaveLength(2);
    });

    it('creates the edge when a condition is set on a pair that is not connected', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'setCondition',
            source: 'start',
            target: 'save_sheets',
            condition: 'skip_fetch == true'
        });

        expect(result.edges).toHaveLength(3);
        expect(result.edges[2]).toMatchObject({
            source: 'start',
            target: 'save_sheets',
            condition: 'skip_fetch == true'
        });
    });

    it('removes an edge without touching the nodes', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'removeEdge',
            source: 'fetch',
            target: 'save_sheets'
        });

        expect(result.nodes).toHaveLength(3);
        expect(result.edges).toHaveLength(1);
    });

    it('reorders and rebuilds the chain to match', () => {
        const result = apply(SHEETS_GRAPH, {
            op: 'reorder',
            nodeIds: ['start', 'save_sheets', 'fetch']
        });

        expect(result.nodes.map(n => n.id)).toEqual(['start', 'save_sheets', 'fetch']);
        expect(result.edges.map(e => `${e.source}->${e.target}`)).toEqual([
            'start->save_sheets',
            'save_sheets->fetch'
        ]);
    });

    it('clears everything on replanAll and says so', () => {
        const result = apply(SHEETS_GRAPH, { op: 'replanAll', reason: 'Start over.' });

        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
        expect(result.applied[0]).toContain('Cleared the canvas');
    });
});

describe('destructive classification', () => {
    const patch = (...operations: GraphOperation[]): GraphPatch => ({
        summary: '',
        clarification: null,
        operations
    });

    it('treats operations that lose configuration as destructive', () => {
        expect(isDestructive(patch({ op: 'removeNode', nodeId: 'a' }))).toBe(true);
        expect(isDestructive(patch({ op: 'replanAll', reason: 'x' }))).toBe(true);
        expect(
            isDestructive(
                patch({
                    op: 'replaceNode',
                    nodeId: 'a',
                    label: 'b',
                    nodeType: 'ai_agent',
                    description: '',
                    toolId: null,
                    toolAction: null
                })
            )
        ).toBe(true);
    });

    it('treats additive and cosmetic operations as safe', () => {
        expect(
            isDestructive(patch({ op: 'addEdge', source: 'a', target: 'b', condition: null }))
        ).toBe(false);
        expect(isDestructive(patch({ op: 'reorder', nodeIds: ['a', 'b'] }))).toBe(false);
        expect(
            isDestructive(
                patch({
                    op: 'updateNodeConfig',
                    nodeId: 'a',
                    label: null,
                    description: null,
                    config: {}
                })
            )
        ).toBe(false);
    });
});

describe('describeOperation', () => {
    it('names steps by label, not by id', () => {
        expect(
            describeOperation({ op: 'removeNode', nodeId: 'save_sheets' }, SHEETS_GRAPH.nodes)
        ).toBe('Remove “Save results to Google Sheets”');

        expect(
            describeOperation(
                { op: 'reorder', nodeIds: ['save_sheets', 'fetch'] },
                SHEETS_GRAPH.nodes
            )
        ).toBe('Reorder to: Save results to Google Sheets → Fetch the page');
    });

    it('falls back to the id for a node that is not there', () => {
        expect(describeOperation({ op: 'removeNode', nodeId: 'ghost' }, SHEETS_GRAPH.nodes)).toBe(
            'Remove “ghost”'
        );
    });
});
