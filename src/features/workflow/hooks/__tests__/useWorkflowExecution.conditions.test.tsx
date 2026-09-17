import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Node } from 'reactflow';
import { NodeType } from '@/shared/types';
import type { FlowEdge } from '@features/workflow/types';
import { useWorkflowExecution } from '../useWorkflowExecution';

/**
 * Conditional routing through the real execution hook.
 *
 * Proves two things end to end: legitimate conditions still route correctly
 * after moving off `new Function`, and a malicious condition stored in a loaded
 * workflow is refused rather than executed.
 */

/** A node that emits fixed state, so no AI call is made during the test. */
function stateNode(id: string, initialState: Record<string, unknown>, outputKeys: string[]): Node {
  return {
    id,
    type: 'ai_agent',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: NodeType.AI_AGENT,
      initialState,
      stateContract: { inputKeys: [], outputKeys },
    },
  };
}

function edge(source: string, target: string, condition?: string): FlowEdge {
  return { id: `${source}->${target}`, source, target, condition } as FlowEdge;
}

/** Run a graph to completion and report which nodes executed. */
async function runGraph(nodes: Node[], edges: FlowEdge[]) {
  const executed: string[] = [];
  const setNodes = vi.fn((updater: unknown) => {
    if (typeof updater === 'function') {
      (updater as (n: Node[]) => Node[])(nodes);
    }
  });

  const { result } = renderHook(() => useWorkflowExecution(nodes, edges, setNodes));

  await act(async () => {
    await result.current.executeFlow();
  });

  await waitFor(() => {
    expect(['completed', 'failed', 'paused', 'cancelled']).toContain(result.current.runtimeStatus);
  });

  for (const log of result.current.executionLogs) executed.push(log.node);
  return { executed, result };
}

describe('conditional routing with the safe evaluator', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Any network call would mean a node fell through to the AI path.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no node in this test should call the network');
      }),
    );
  });

  it('follows the branch whose condition is true and skips the other', async () => {
    const nodes = [
      stateNode('start', { score: 80 }, ['score']),
      stateNode('high', { tier: 'high' }, ['tier']),
      stateNode('low', { tier: 'low' }, ['tier']),
    ];
    const edges = [edge('start', 'high', 'score > 50'), edge('start', 'low', 'score <= 50')];

    const { executed } = await runGraph(nodes, edges);

    expect(executed).toContain('start');
    expect(executed).toContain('high');
    expect(executed).not.toContain('low');
  });

  it('routes the other way when the state changes', async () => {
    const nodes = [
      stateNode('start', { score: 10 }, ['score']),
      stateNode('high', { tier: 'high' }, ['tier']),
      stateNode('low', { tier: 'low' }, ['tier']),
    ];
    const edges = [edge('start', 'high', 'score > 50'), edge('start', 'low', 'score <= 50')];

    const { executed } = await runGraph(nodes, edges);

    expect(executed).toContain('low');
    expect(executed).not.toContain('high');
  });

  it('still understands JavaScript-style conditions from existing saved workflows', async () => {
    // `===` and `&&` are not native to the expression grammar; they are
    // normalised. Saved workflows must keep working.
    const nodes = [
      stateNode('start', { sentiment: 'positive', score: 90 }, ['sentiment', 'score']),
      stateNode('praise', { action: 'praise' }, ['action']),
      stateNode('triage', { action: 'triage' }, ['action']),
    ];
    const edges = [
      edge('start', 'praise', "sentiment === 'positive' && score > 50"),
      edge('start', 'triage', "sentiment !== 'positive'"),
    ];

    const { executed } = await runGraph(nodes, edges);

    expect(executed).toContain('praise');
    expect(executed).not.toContain('triage');
  });

  it('refuses a malicious condition instead of executing it', async () => {
    // This is the attack the previous `new Function` implementation enabled: a
    // condition arriving from shared storage running as real JavaScript.
    const escaped = vi.fn();
    (globalThis as Record<string, unknown>).__conditionEscaped = escaped;

    const nodes = [
      stateNode('start', { score: 80 }, ['score']),
      stateNode('target', { reached: true }, ['reached']),
    ];
    const edges = [edge('start', 'target', "constructor.constructor('__conditionEscaped()')()")];

    const { executed } = await runGraph(nodes, edges);

    // The payload never ran, and the undecidable branch was not taken.
    expect(escaped).not.toHaveBeenCalled();
    expect(executed).toContain('start');
    expect(executed).not.toContain('target');

    delete (globalThis as Record<string, unknown>).__conditionEscaped;
  });

  it('does not take a branch whose condition cannot be parsed', async () => {
    const nodes = [
      stateNode('start', { score: 80 }, ['score']),
      stateNode('target', { reached: true }, ['reached']),
    ];
    const edges = [edge('start', 'target', 'score >')];

    const { executed } = await runGraph(nodes, edges);

    expect(executed).toContain('start');
    expect(executed).not.toContain('target');
  });

  it('follows unconditional edges', async () => {
    const nodes = [
      stateNode('start', { score: 80 }, ['score']),
      stateNode('next', { done: true }, ['done']),
    ];
    const edges = [edge('start', 'next')];

    const { executed } = await runGraph(nodes, edges);

    expect(executed).toContain('start');
    expect(executed).toContain('next');
  });
});
