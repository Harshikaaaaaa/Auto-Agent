import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@features/tools/connectors';
import { NodeType } from '@/shared/types';
import {
    PlanValidationError,
    buildNodeFromPlanStep,
    generateWorkflowPlan,
    planToWorkflow,
    type PlanStep
} from '../workflowPlanGenerator';

/**
 * Task 8 acceptance tests.
 *
 * The reported defect, verbatim: the prompt below produced a step called
 * "Save results to Google Sheets", a tool the user never mentioned. It happened
 * because the planner pattern-matched /save|store|log/ before any model was
 * consulted, and nothing checked the result against the tool catalog.
 *
 * These tests are the gate against that returning. The model is stubbed at the
 * server boundary (`requestPlan`), because the point under test is what the
 * planner ACCEPTS, not what a provider happens to answer.
 */

const SCRAPE_PROMPT =
    'create data scrape from website and save it summarize as markdown file and allow me to download';

vi.mock('@features/ai/services/aiClient', () => ({
    requestPlan: vi.fn()
}));

// Imported after the mock declaration so the mocked module is the one bound.
const { requestPlan } = await import('@features/ai/services/aiClient');
const mockRequestPlan = vi.mocked(requestPlan);

/** Queue one raw model answer per attempt, in order. */
function respondWith(...answers: unknown[]) {
    mockRequestPlan.mockReset();
    for (const answer of answers) {
        mockRequestPlan.mockResolvedValueOnce({
            plan: answer,
            meta: { provider: 'test', model: 'test-model', attempts: 1 }
        });
    }
}

/** The plan a correct model returns for the reported prompt. */
const SCRAPE_PLAN = {
    title: 'Scrape a page to a downloadable Markdown file',
    description: 'Fetch a page, extract its content, format it as Markdown and download it.',
    estimatedTime: 'Fast',
    steps: [
        {
            id: 'start',
            order: 1,
            type: 'trigger',
            label: 'Start',
            description: 'Capture the target URL.',
            toolId: null,
            toolAction: null,
            unsupported: false,
            unsupportedReason: null,
            inputs: [],
            outputs: ['source_url']
        },
        {
            id: 'fetch',
            order: 2,
            type: 'tool',
            label: 'Fetch the page',
            description: 'Download the page HTML.',
            toolId: 'web',
            toolAction: 'fetch_page',
            inputs: ['source_url'],
            outputs: ['raw_content']
        },
        {
            id: 'extract',
            order: 3,
            type: 'tool',
            label: 'Extract the readable content',
            description: 'Strip navigation and scripts.',
            toolId: 'content',
            toolAction: 'extract_content',
            inputs: ['raw_content'],
            outputs: ['extracted_text']
        },
        {
            id: 'markdown',
            order: 4,
            type: 'tool',
            label: 'Summarise as Markdown',
            description: 'Compose a Markdown document.',
            toolId: 'content',
            toolAction: 'to_markdown',
            inputs: ['extracted_text'],
            outputs: ['markdown']
        },
        {
            id: 'download',
            order: 5,
            type: 'tool',
            label: 'Download the file',
            description: 'Deliver the Markdown file to the browser.',
            toolId: 'files',
            toolAction: 'download_file',
            inputs: ['markdown'],
            outputs: ['saved_filename']
        }
    ]
};

beforeEach(() => {
    mockRequestPlan.mockReset();
});

describe('the reported defect', () => {
    it('does not bind Google Sheets to a prompt that never mentioned it', async () => {
        respondWith(SCRAPE_PLAN);

        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(plan.requiredTools).not.toContain('google_sheets');
        expect(plan.steps.some(step => step.toolId === 'google_sheets')).toBe(false);
        // Nor smuggled in as prose.
        expect(JSON.stringify(plan).toLowerCase()).not.toContain('google sheets');
    });

    it('binds the fetch, markdown and download steps that the prompt asked for', async () => {
        respondWith(SCRAPE_PLAN);

        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);
        const bound = plan.steps
            .filter(step => step.toolId)
            .map(step => `${step.toolId}.${step.toolAction}`);

        expect(bound).toEqual([
            'web.fetch_page',
            'content.extract_content',
            'content.to_markdown',
            'files.download_file'
        ]);
        expect(plan.requiredTools).toEqual(['web', 'content', 'files']);
        expect(plan.unsupportedCapabilities).toEqual([]);
    });

    it('sends the request once when the plan is valid', async () => {
        respondWith(SCRAPE_PLAN);

        await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(mockRequestPlan).toHaveBeenCalledTimes(1);
        expect(mockRequestPlan.mock.calls[0][0]).toMatchObject({ prompt: SCRAPE_PROMPT });
        // No repair feedback on a first attempt.
        expect(mockRequestPlan.mock.calls[0][0].repairFeedback).toBeUndefined();
    });

    it('passes keyword rankings only as hints, never as the decision', async () => {
        respondWith(SCRAPE_PLAN);

        await generateWorkflowPlan(SCRAPE_PROMPT);
        const sent = mockRequestPlan.mock.calls[0][0];

        // The lexical ranker still fires on "save" and friends. That is fine as a
        // hint; what matters is that nothing it suggests reached the plan unless
        // the model chose it.
        expect(Array.isArray(sent.hints)).toBe(true);
        expect(sent.catalog.map(tool => tool.id)).toContain('web');
    });

    it('still binds Gmail when the user does ask for email', async () => {
        respondWith({
            title: 'Email the summary',
            description: 'Send the summary by email.',
            estimatedTime: 'Fast',
            steps: [
                {
                    id: 'start',
                    type: 'trigger',
                    label: 'Start',
                    outputs: ['summary']
                },
                {
                    id: 'send',
                    type: 'tool',
                    label: 'Email the summary',
                    description: 'Send it to the recipient.',
                    toolId: 'gmail',
                    toolAction: 'send_email',
                    inputs: ['summary'],
                    outputs: ['email_status']
                }
            ]
        });

        const plan = await generateWorkflowPlan('email the summary to me');

        expect(plan.requiredTools).toEqual(['gmail']);
        expect(plan.steps[1]).toMatchObject({ toolId: 'gmail', toolAction: 'send_email' });
    });
});

describe('catalog validation', () => {
    it('rejects a fabricated toolId and repairs with specific feedback', async () => {
        respondWith(
            {
                title: 'Post to Notion',
                steps: [
                    { id: 'start', type: 'trigger', label: 'Start' },
                    {
                        id: 'save',
                        type: 'tool',
                        label: 'Save to Notion',
                        toolId: 'notion',
                        toolAction: 'create_page'
                    }
                ]
            },
            SCRAPE_PLAN
        );

        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(mockRequestPlan).toHaveBeenCalledTimes(2);
        const feedback = String(mockRequestPlan.mock.calls[1][0].repairFeedback);
        expect(feedback).toContain('"notion"');
        expect(feedback).toContain('not in the catalog');
        // The valid ids are listed so the retry has something to aim at.
        expect(feedback).toContain('google_sheets');
        expect(plan.steps.some(step => step.toolId === 'notion')).toBe(false);
    });

    it('rejects a real tool with an action it does not have', async () => {
        respondWith(
            {
                title: 'Delete the sheet',
                steps: [
                    { id: 'start', type: 'trigger', label: 'Start' },
                    {
                        id: 'wipe',
                        type: 'tool',
                        label: 'Delete the spreadsheet',
                        toolId: 'google_sheets',
                        toolAction: 'delete_spreadsheet'
                    }
                ]
            },
            SCRAPE_PLAN
        );

        await generateWorkflowPlan(SCRAPE_PROMPT);

        const feedback = String(mockRequestPlan.mock.calls[1][0].repairFeedback);
        expect(feedback).toContain('"delete_spreadsheet"');
        expect(feedback).toContain('does not have');
    });

    it('throws after one failed repair rather than shipping a bad plan', async () => {
        const bad = {
            title: 'Post to Notion',
            steps: [
                { id: 'start', type: 'trigger', label: 'Start' },
                {
                    id: 'save',
                    type: 'tool',
                    label: 'Save to Notion',
                    toolId: 'notion',
                    toolAction: 'create_page'
                }
            ]
        };
        respondWith(bad, bad);

        await expect(generateWorkflowPlan(SCRAPE_PROMPT)).rejects.toThrow(PlanValidationError);
        expect(mockRequestPlan).toHaveBeenCalledTimes(2);
    });

    it('rejects a step that is both bound and unsupported', async () => {
        respondWith(
            {
                title: 'Contradiction',
                steps: [
                    { id: 'start', type: 'trigger', label: 'Start' },
                    {
                        id: 'send',
                        type: 'tool',
                        label: 'Send it',
                        toolId: 'gmail',
                        toolAction: 'send_email',
                        unsupported: true,
                        unsupportedReason: 'no email tool'
                    }
                ]
            },
            SCRAPE_PLAN
        );

        await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(String(mockRequestPlan.mock.calls[1][0].repairFeedback)).toContain(
            'never both'
        );
    });

    it('rejects an unsupported step with no reason', async () => {
        respondWith(
            {
                title: 'Silent gap',
                steps: [
                    { id: 'start', type: 'trigger', label: 'Start' },
                    { id: 'sms', type: 'process', label: 'Text the customer', unsupported: true }
                ]
            },
            SCRAPE_PLAN
        );

        await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(String(mockRequestPlan.mock.calls[1][0].repairFeedback)).toContain(
            'no unsupportedReason'
        );
    });

    it('rejects a tool-typed step that binds nothing', async () => {
        respondWith(
            {
                title: 'Vague',
                steps: [
                    { id: 'start', type: 'trigger', label: 'Start' },
                    { id: 'do_it', type: 'tool', label: 'Do the thing' }
                ]
            },
            SCRAPE_PLAN
        );

        await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(String(mockRequestPlan.mock.calls[1][0].repairFeedback)).toContain(
            'binds no toolId/toolAction'
        );
    });

    it('rejects output that is not a plan at all', async () => {
        respondWith({ nope: true }, SCRAPE_PLAN);

        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(mockRequestPlan).toHaveBeenCalledTimes(2);
        expect(String(mockRequestPlan.mock.calls[1][0].repairFeedback)).toContain('steps');
        expect(plan.steps).toHaveLength(5);
    });
});

describe('honest gaps', () => {
    it('keeps an unsupported step unsupported instead of substituting a tool', async () => {
        respondWith({
            title: 'Text the customer',
            description: 'Send an SMS.',
            estimatedTime: 'Fast',
            steps: [
                { id: 'start', type: 'trigger', label: 'Start', outputs: ['message'] },
                {
                    id: 'sms',
                    type: 'process',
                    label: 'Send an SMS',
                    description: 'Text the customer the update.',
                    unsupported: true,
                    unsupportedReason: 'No connected tool can send SMS.',
                    inputs: ['message'],
                    outputs: []
                }
            ]
        });

        const plan = await generateWorkflowPlan('text the customer when the order ships');

        expect(plan.requiredTools).toEqual([]);
        expect(plan.unsupportedCapabilities).toEqual(['No connected tool can send SMS.']);
        expect(plan.steps[1]).toMatchObject({
            unsupported: true,
            toolId: null,
            toolAction: null
        });
    });

    it('gives an unsupported node no output keys, so execution cannot fake it', () => {
        const step: PlanStep = {
            id: 'sms',
            order: 2,
            type: 'process',
            label: 'Send an SMS',
            description: 'Text the customer.',
            toolId: null,
            toolAction: null,
            unsupported: true,
            unsupportedReason: 'No connected tool can send SMS.',
            inputs: ['message'],
            outputs: ['sms_status'],
            externalInputs: []
        };

        const data = buildNodeFromPlanStep(step);

        expect(data.unsupported).toBe(true);
        expect(data.unsupportedReason).toBe('No connected tool can send SMS.');
        // The executor routes any node with output keys and no tool to the LLM.
        // An empty list is what keeps that from happening.
        expect(data.stateContract?.outputKeys).toEqual([]);
    });
});

describe('no fabrication', () => {
    it('does not pad a short plan to a step count', async () => {
        respondWith({
            title: 'Two steps',
            steps: [
                { id: 'start', type: 'trigger', label: 'Start', outputs: ['source_url'] },
                {
                    id: 'fetch',
                    type: 'tool',
                    label: 'Fetch the page',
                    toolId: 'web',
                    toolAction: 'fetch_page',
                    inputs: ['source_url'],
                    outputs: ['raw_content']
                }
            ]
        });

        const plan = await generateWorkflowPlan('fetch a page');

        expect(plan.steps).toHaveLength(2);
        expect(plan.steps.map(step => step.label)).toEqual(['Start', 'Fetch the page']);
    });

    it('derives requiredTools from the steps and never defaults it', async () => {
        respondWith({
            title: 'No tools at all',
            steps: [
                { id: 'start', type: 'trigger', label: 'Start' },
                { id: 'think', type: 'process', label: 'Summarise the text', outputs: ['summary'] }
            ]
        });

        const plan = await generateWorkflowPlan('summarise this text');

        expect(plan.requiredTools).toEqual([]);
    });
});

describe('normalisation', () => {
    it('renumbers order and de-duplicates colliding step ids', async () => {
        respondWith({
            title: 'Messy',
            steps: [
                { id: 'step', order: 7, type: 'trigger', label: 'Start' },
                { id: 'step', order: 7, type: 'process', label: 'Think' },
                { id: 'step', type: 'output', label: 'Return' }
            ]
        });

        const plan = await generateWorkflowPlan('do something');

        expect(plan.steps.map(step => step.order)).toEqual([1, 2, 3]);
        // Colliding ids would merge two graph nodes into one.
        expect(new Set(plan.steps.map(step => step.id)).size).toBe(3);
        expect(plan.steps.map(step => step.id)).toEqual(['step', 'step_2', 'step_3']);
    });

    it('derives a missing step type instead of failing', async () => {
        respondWith({
            title: 'Untyped',
            steps: [
                { id: 'start', label: 'Start' },
                {
                    id: 'fetch',
                    label: 'Fetch the page',
                    toolId: 'web',
                    toolAction: 'fetch_page'
                },
                { id: 'think', label: 'Summarise' }
            ]
        });

        const plan = await generateWorkflowPlan('fetch and summarise');

        expect(plan.steps.map(step => step.type)).toEqual(['trigger', 'tool', 'process']);
    });

    it('accepts a plan wrapped in a redundant "plan" key', async () => {
        respondWith({ plan: SCRAPE_PLAN });

        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);

        expect(mockRequestPlan).toHaveBeenCalledTimes(1);
        expect(plan.steps).toHaveLength(5);
    });

    it('falls back to Medium for an unrecognised estimate', async () => {
        respondWith({
            title: 'Odd estimate',
            estimatedTime: 'about a fortnight',
            steps: [{ id: 'start', type: 'trigger', label: 'Start' }]
        });

        const plan = await generateWorkflowPlan('anything');

        expect(plan.estimatedTime).toBe('Medium');
    });
});

describe('node building', () => {
    it('takes state keys from the bound action schema, not the model prose', () => {
        const step: PlanStep = {
            id: 'send',
            order: 2,
            type: 'tool',
            label: 'Email the summary',
            description: 'Send it.',
            toolId: 'gmail',
            toolAction: 'send_email',
            unsupported: false,
            unsupportedReason: null,
            // Deliberately wrong: the schema must win.
            inputs: ['whatever_the_model_said'],
            outputs: ['whatever_the_model_said'],
            externalInputs: []
        };

        const data = buildNodeFromPlanStep(step);

        expect(data.type).toBe(NodeType.TOOL);
        expect(data.toolId).toBe('gmail');
        expect(data.toolAction).toBe('send_email');
        expect(data.stateContract?.inputKeys).not.toContain('whatever_the_model_said');
        expect(data.stateContract?.inputKeys).toContain('to');
        expect(data.stateContract?.outputKeys).toContain('email_status');
    });

    it('marks an irreversible action as requiring approval', () => {
        const data = buildNodeFromPlanStep({
            id: 'send',
            order: 2,
            type: 'tool',
            label: 'Email the summary',
            description: '',
            toolId: 'gmail',
            toolAction: 'send_email',
            unsupported: false,
            unsupportedReason: null,
            inputs: [],
            outputs: [],
            externalInputs: []
        });

        expect(data.requiresApproval).toBe(true);
    });

    it('does not gate a read-only action', () => {
        const data = buildNodeFromPlanStep({
            id: 'fetch',
            order: 2,
            type: 'tool',
            label: 'Fetch the page',
            description: '',
            toolId: 'web',
            toolAction: 'fetch_page',
            unsupported: false,
            unsupportedReason: null,
            inputs: [],
            outputs: [],
            externalInputs: []
        });

        expect(data.requiresApproval).toBe(false);
    });
});

describe('planToWorkflow', () => {
    it('builds one node per step, linked in order, with no invented nodes', async () => {
        respondWith(SCRAPE_PLAN);
        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);

        const workflow = planToWorkflow(plan);

        expect(workflow.nodes).toHaveLength(plan.steps.length);
        expect(workflow.nodes.map(node => node.id)).toEqual(plan.steps.map(step => step.id));
        expect(workflow.edges).toHaveLength(plan.steps.length - 1);
        expect(workflow.edges[0]).toMatchObject({ source: 'start', target: 'fetch' });
        expect(workflow.nodes[0].type).toBe(NodeType.TRIGGER);
        expect(workflow.nodes[1]).toMatchObject({
            type: NodeType.TOOL,
            data: { toolId: 'web', toolAction: 'fetch_page' }
        });
    });

    it('records the URL as a user-supplied input the run will need', async () => {
        respondWith(SCRAPE_PLAN);
        const plan = await generateWorkflowPlan(SCRAPE_PROMPT);

        const fetchStep = plan.steps.find(step => step.toolAction === 'fetch_page');
        expect(fetchStep?.externalInputs).toContain('source_url');

        const fetchNode = planToWorkflow(plan).nodes.find(node => node.id === 'fetch');
        expect(fetchNode?.data.stateContract?.externalInputKeys).toContain('source_url');
    });
});
