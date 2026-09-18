import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node } from 'reactflow';
import { NodeType } from '@/shared/types';
import type { FlowEdge } from '@features/workflow/types';
import { registerTool } from '@features/tools/toolRegistry';
import { useWorkflowExecution } from '../useWorkflowExecution';

/**
 * The permanent fix for the producer/consumer key-mismatch bug: a consumer node
 * receives an upstream value even when the producer wrote it under a SYNONYMOUS
 * key name (e.g. a Summarize node writes `result`, a converter reads
 * `extracted_text`). The engine resolves declared input keys through the
 * central alias table rather than requiring an exact name match.
 *
 * These tests register a tool whose actions record the input they were handed,
 * then run two-node graphs and assert what the consumer actually received.
 */

/** Inputs each action was called with, keyed by action name. */
let received: Record<string, Record<string, unknown>> = {};

function registerAliasTools() {
  registerTool({
    id: 'test_alias',
    name: 'Test Alias',
    description: 'Records the input each action receives.',
    icon: 'Zap',
    color: '#000000',
    category: 'testing',
    scopes: [],
    costProfile: { latencyMs: 1, cost: 0, reliability: 5 },
    actions: [
      {
        // Produces `result` (the generic AI-node output key).
        name: 'produce_result',
        description: 'Writes result.',
        capabilities: ['content.format'],
        sideEffect: 'read',
        requiresAuth: false,
        inputSchema: {},
        outputSchema: { result: { type: 'string', description: 'The result.' } },
        execute: async () => ({ result: 'THE SUMMARY' }),
      },
      {
        // Consumes `extracted_text` — a synonym of `result`.
        name: 'consume_text',
        description: 'Reads extracted_text.',
        capabilities: ['content.format'],
        sideEffect: 'read',
        requiresAuth: false,
        inputSchema: {
          extracted_text: { type: 'string', description: 'Body text.' },
        },
        outputSchema: { done: { type: 'boolean', description: 'Done.' } },
        execute: async (input) => {
          received.consume_text = input;
          return { done: true };
        },
      },
    ],
    isAuthenticated: () => true,
    authenticate: async () => {},
    disconnect: () => {},
  });
}

function toolNode(id: string, toolAction: string, inputKeys: string[], outputKeys: string[]): Node {
  return {
    id,
    type: 'tool',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: NodeType.TOOL,
      toolId: 'test_alias',
      toolAction,
      stateContract: { inputKeys, outputKeys },
    },
  };
}

async function run(nodes: Node[], edges: FlowEdge[]) {
  const { result } = renderHook(() =>
    useWorkflowExecution(nodes, edges, vi.fn(), async () => true),
  );
  await act(async () => {
    await result.current.executeFlow();
  });
}

beforeEach(() => {
  received = {};
  registerAliasTools();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('state-key alias reconciliation', () => {
  it('feeds a consumer that reads a SYNONYM of what the producer wrote', async () => {
    // producer writes `result`; consumer declares `extracted_text`. They are in
    // the same alias group, so the consumer must receive the produced value.
    await run(
      [
        toolNode('p', 'produce_result', [], ['result']),
        toolNode('c', 'consume_text', ['extracted_text'], ['done']),
      ],
      [{ id: 'e', source: 'p', target: 'c' } as FlowEdge],
    );

    expect(received.consume_text?.extracted_text).toBe('THE SUMMARY');
  });

  it('prefers an EXACT match over an alias', async () => {
    // Seed both the exact key and a synonym on the trigger's initialState; the
    // consumer must get the exact `extracted_text`, not the synonym.
    const trigger: Node = {
      id: 'root',
      type: 'trigger',
      position: { x: 0, y: 0 },
      data: {
        label: 'root',
        type: NodeType.TRIGGER,
        initialState: { extracted_text: 'EXACT', result: 'SYNONYM' },
        stateContract: { inputKeys: [], outputKeys: ['extracted_text', 'result'] },
      },
    };
    await run(
      [trigger, toolNode('c', 'consume_text', ['extracted_text'], ['done'])],
      [{ id: 'e', source: 'root', target: 'c' } as FlowEdge],
    );

    expect(received.consume_text?.extracted_text).toBe('EXACT');
  });
});
