import { describe, expect, it } from 'vitest';
import '@features/tools/connectors';
import { NodeType } from '@/shared/types';
import type { WorkflowNode } from '@features/workflow/types';
import {
  humanizeKey,
  inputsToCollect,
  missingExternalInputs,
  missingRequiredInputs,
  requiredInputsForRun,
} from '../externalInputs';

/**
 * The required-input logic that drives both the run gate and the chat-based
 * input collector. What matters: a value nothing upstream produces is asked
 * for; a value a step produces, or that is already filled, is not.
 */

function node(
  id: string,
  label: string,
  contract: {
    inputKeys?: string[];
    outputKeys?: string[];
    externalInputKeys?: string[];
  },
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type: 'tool',
    position: { x: 0, y: 0 },
    data: {
      label,
      type: NodeType.TOOL,
      stateContract: {
        inputKeys: contract.inputKeys ?? [],
        outputKeys: contract.outputKeys ?? [],
        externalInputKeys: contract.externalInputKeys,
      },
      ...extra,
    },
  };
}

/**
 * A trigger node. Its entry input is declared on `externalInputKeys` (as the
 * planner now records it), NOT inferred from raw outputKeys.
 */
function triggerNode(id: string, label: string, entryInputs: string[]): WorkflowNode {
  return {
    id,
    type: 'trigger',
    position: { x: 0, y: 0 },
    data: {
      label,
      type: NodeType.TRIGGER,
      stateContract: { inputKeys: [], outputKeys: entryInputs, externalInputKeys: entryInputs },
    },
  };
}

// The scrape -> extract -> markdown -> download graph from the product.
const SCRAPE_GRAPH: WorkflowNode[] = [
  triggerNode('trigger', 'Webpage URL Input', ['source_url']),
  node('fetch', 'Fetch Webpage', {
    inputKeys: ['source_url'],
    externalInputKeys: ['source_url'],
    outputKeys: ['raw_content'],
  }),
  node('extract', 'Extract Content', {
    inputKeys: ['raw_content'],
    outputKeys: ['extracted_text'],
  }),
];

describe('humanizeKey', () => {
  it('turns a state key into a readable label', () => {
    expect(humanizeKey('source_url')).toBe('source url');
    expect(humanizeKey('spreadsheetId')).toBe('spreadsheetId');
    expect(humanizeKey('to-address')).toBe('to address');
  });
});

describe('requiredInputsForRun', () => {
  it("treats a trigger node's output as a user-supplied entry input", () => {
    // The scrape graph's trigger "outputs" source_url, but a trigger computes
    // nothing — that value must come from the user. This is the exact case that
    // let a run start with an empty URL before the fix.
    const required = requiredInputsForRun(SCRAPE_GRAPH);
    expect(required.map((r) => r.key)).toContain('source_url');
    const sourceUrl = required.find((r) => r.key === 'source_url');
    expect(sourceUrl?.nodeLabel).toBe('Webpage URL Input');
  });

  it('does not ask for a value a real (non-trigger) step produces', () => {
    // raw_content is produced by the Fetch step, so no node should require it.
    const required = requiredInputsForRun(SCRAPE_GRAPH);
    expect(required.map((r) => r.key)).not.toContain('raw_content');
    expect(required.map((r) => r.key)).not.toContain('extracted_text');
  });

  it('requires an external input no step produces', () => {
    const graph: WorkflowNode[] = [
      node('fetch', 'Fetch Webpage', {
        inputKeys: ['source_url'],
        externalInputKeys: ['source_url'],
        outputKeys: ['raw_content'],
      }),
    ];
    const required = requiredInputsForRun(graph);
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({
      key: 'source_url',
      label: 'source url',
      nodeId: 'fetch',
      nodeLabel: 'Fetch Webpage',
      value: '',
    });
  });

  it('NEVER asks for internal wiring keys (inputKeys/outputKeys), only declared externals', () => {
    // The reported bug: a step listed content/records/filename as inputs/outputs
    // and the collector asked the user for them. Those are internal state — only
    // externalInputKeys should ever be asked for.
    const graph: WorkflowNode[] = [
      node('extract', 'Extract Content', {
        inputKeys: ['raw_content', 'content', 'records'],
        outputKeys: ['extracted_text', 'filename', 'links'],
        // No externalInputKeys declared: nothing is asked for.
      }),
    ];
    expect(requiredInputsForRun(graph)).toHaveLength(0);
  });

  it('ignores generic model-derived keys', () => {
    const graph: WorkflowNode[] = [
      node('summarize', 'Summarize', {
        inputKeys: ['text', 'context', 'summary'],
        externalInputKeys: ['text', 'context', 'summary'],
      }),
    ];
    expect(requiredInputsForRun(graph)).toHaveLength(0);
  });

  it('deduplicates a key required by more than one node', () => {
    const graph: WorkflowNode[] = [
      node('a', 'A', { externalInputKeys: ['spreadsheetId'] }),
      node('b', 'B', { externalInputKeys: ['spreadsheetId'] }),
    ];
    const required = requiredInputsForRun(graph);
    expect(required).toHaveLength(1);
    expect(required[0].key).toBe('spreadsheetId');
  });

  it('pre-fills a value already present on the node', () => {
    const graph: WorkflowNode[] = [
      node(
        'fetch',
        'Fetch',
        { externalInputKeys: ['source_url'] },
        { source_url: 'https://example.com' },
      ),
    ];
    expect(requiredInputsForRun(graph)[0].value).toBe('https://example.com');
  });
});

describe('missingRequiredInputs', () => {
  it('reports a blank external input as missing', () => {
    const graph: WorkflowNode[] = [node('fetch', 'Fetch', { externalInputKeys: ['source_url'] })];
    expect(missingRequiredInputs(graph).map((i) => i.key)).toEqual(['source_url']);
  });

  it('clears once the value is supplied on node data', () => {
    const graph: WorkflowNode[] = [
      node(
        'fetch',
        'Fetch',
        { externalInputKeys: ['source_url'] },
        { source_url: 'https://x.com' },
      ),
    ];
    expect(missingRequiredInputs(graph)).toHaveLength(0);
  });

  it('clears once the value is supplied via initialState', () => {
    const graph: WorkflowNode[] = [
      node(
        'fetch',
        'Fetch',
        { externalInputKeys: ['source_url'] },
        { initialState: { source_url: 'https://x.com' } },
      ),
    ];
    expect(missingRequiredInputs(graph)).toHaveLength(0);
  });

  it('requires the scrape graph’s entry URL (the trigger does not compute it)', () => {
    // The trigger declares source_url as an output, but nothing computes it, so
    // it is missing until the user supplies it.
    expect(missingRequiredInputs(SCRAPE_GRAPH).map((i) => i.key)).toEqual(['source_url']);
  });

  it('clears the scrape graph once the entry URL is provided', () => {
    const filled = SCRAPE_GRAPH.map((n) =>
      n.id === 'trigger'
        ? { ...n, data: { ...n.data, initialState: { source_url: 'https://example.com' } } }
        : n,
    );
    expect(missingRequiredInputs(filled)).toHaveLength(0);
  });
});

describe('field metadata from the real tool registry', () => {
  /** A node bound to a real registered action, so field metadata resolves. */
  function boundNode(
    id: string,
    label: string,
    toolId: string,
    toolAction: string,
    contract: { inputKeys?: string[]; outputKeys?: string[]; externalInputKeys?: string[] },
  ): WorkflowNode {
    return {
      id,
      type: 'tool',
      position: { x: 0, y: 0 },
      data: {
        label,
        type: NodeType.TOOL,
        toolId,
        toolAction,
        stateContract: {
          inputKeys: contract.inputKeys ?? [],
          outputKeys: contract.outputKeys ?? [],
          externalInputKeys: contract.externalInputKeys,
        },
      },
    };
  }

  it('carries a required flag and description for a required input (web.fetch_page source_url)', () => {
    const graph = [
      boundNode('fetch', 'Fetch Webpage', 'web', 'fetch_page', {
        externalInputKeys: ['source_url'],
      }),
    ];
    const [input] = requiredInputsForRun(graph);
    expect(input.key).toBe('source_url');
    expect(input.required).toBe(true);
    expect(input.description).toMatch(/url/i);
    expect(input.format).toBe('url');
  });

  it('marks an unflagged external field OPTIONAL (slack channel override)', () => {
    const graph = [
      boundNode('notify', 'Notify Slack', 'slack', 'send_message', {
        externalInputKeys: ['channel'],
      }),
    ];
    const [input] = requiredInputsForRun(graph);
    expect(input.key).toBe('channel');
    expect(input.required).toBe(false);
    expect(input.description).toMatch(/channel/i);
  });

  it('does not BLOCK a run on a blank optional field', () => {
    const graph = [
      boundNode('notify', 'Notify Slack', 'slack', 'send_message', {
        externalInputKeys: ['channel'],
      }),
    ];
    // No required-and-blank inputs -> nothing blocks, nothing to collect.
    expect(missingRequiredInputs(graph)).toHaveLength(0);
    expect(inputsToCollect(graph)).toHaveLength(0);
  });

  it('shows optional fields alongside a required one in the collector', () => {
    const graph = [
      boundNode('fetch', 'Fetch Webpage', 'web', 'fetch_page', {
        externalInputKeys: ['source_url'],
      }),
      boundNode('notify', 'Notify Slack', 'slack', 'send_message', {
        externalInputKeys: ['channel'],
      }),
    ];
    const toCollect = inputsToCollect(graph);
    const byKey = Object.fromEntries(toCollect.map((i) => [i.key, i]));
    // source_url is required-and-blank -> triggers the card; channel rides along.
    expect(byKey.source_url?.required).toBe(true);
    expect(byKey.channel?.required).toBe(false);
    // The gate blocks only on the required one.
    expect(missingRequiredInputs(graph).map((i) => i.key)).toEqual(['source_url']);
  });
});

describe('missingExternalInputs (existing pre-flight helper) still works', () => {
  it('treats an initialState value as available', () => {
    const graph: WorkflowNode[] = [
      node(
        'fetch',
        'Fetch',
        { externalInputKeys: ['source_url'] },
        { initialState: { source_url: 'https://x.com' } },
      ),
    ];
    const available = new Set(['source_url']);
    expect(missingExternalInputs(graph, available)).toHaveLength(0);
  });
});
