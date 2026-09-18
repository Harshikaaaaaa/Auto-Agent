import { describe, expect, it } from 'vitest';
import { NodeType } from '@/shared/types';
import type { WorkflowNode } from '@features/workflow/types';
import {
  humanizeKey,
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

/** A trigger node whose declared output is really a user-supplied entry input. */
function triggerNode(id: string, label: string, outputKeys: string[]): WorkflowNode {
  return {
    id,
    type: 'trigger',
    position: { x: 0, y: 0 },
    data: {
      label,
      type: NodeType.TRIGGER,
      stateContract: { inputKeys: [], outputKeys },
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
