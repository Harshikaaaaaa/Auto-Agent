import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node } from 'reactflow';
import { NodeType } from '@/shared/types';
import type { FlowEdge } from '@features/workflow/types';

/**
 * The "use cached output" toggle for AI nodes.
 *
 * When a generic/AI node has `useCachedOutput` on and a previous `cachedOutput`,
 * the engine must REPLAY that result instead of calling the model again — the
 * point is to iterate on downstream steps without re-paying for the AI step.
 * The AI call is mocked so we can assert it was (or was not) made.
 */

vi.mock('@features/ai/services/aiService', () => ({
  executeNodeAction: vi.fn(async () => ({ result: 'FRESH FROM AI' })),
}));

const { executeNodeAction } = await import('@features/ai/services/aiService');
const mockAi = vi.mocked(executeNodeAction);
const { useWorkflowExecution } = await import('../useWorkflowExecution');

/** A generic AI node (no tool binding) that writes `result`. */
function aiNode(id: string, data: Record<string, unknown> = {}): Node {
  return {
    id,
    type: 'ai_agent',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: NodeType.AI_AGENT,
      description: 'Do the thing.',
      stateContract: { inputKeys: [], outputKeys: ['result'] },
      ...data,
    },
  };
}

async function run(nodes: Node[], edges: FlowEdge[] = []) {
  const { result } = renderHook(() =>
    useWorkflowExecution(nodes, edges, vi.fn(), async () => true),
  );
  let logs;
  await act(async () => {
    const summary = await result.current.executeFlow();
    logs = summary.logs;
  });
  return logs;
}

beforeEach(() => {
  mockAi.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('use cached output', () => {
  it('calls the AI when caching is off', async () => {
    await run([aiNode('a')]);
    expect(mockAi).toHaveBeenCalledTimes(1);
  });

  it('replays the cached output and does NOT call the AI when caching is on', async () => {
    await run([
      aiNode('a', {
        useCachedOutput: true,
        cachedOutput: { result: 'CACHED VALUE' },
      }),
    ]);
    // The AI was never called — the cached result was used instead.
    expect(mockAi).not.toHaveBeenCalled();
  });

  it('still calls the AI when caching is on but no cache exists yet', async () => {
    await run([aiNode('a', { useCachedOutput: true })]);
    // Nothing to replay, so it must run for real to create the first cache.
    expect(mockAi).toHaveBeenCalledTimes(1);
  });

  it('replays the existing "Last Output" (data.output) when there is no cachedOutput', async () => {
    // A node that ran BEFORE the caching feature has only data.output (a JSON
    // string), not cachedOutput. The toggle must still be able to replay it.
    await run([
      aiNode('a', {
        useCachedOutput: true,
        output: JSON.stringify({ result: 'FROM LAST OUTPUT' }),
      }),
    ]);
    expect(mockAi).not.toHaveBeenCalled();
  });

  it('replays a plain-text Last Output as result', async () => {
    // If Last Output is not JSON, it is still replayable, wrapped as `result`.
    await run([aiNode('a', { useCachedOutput: true, output: 'a plain summary' })]);
    expect(mockAi).not.toHaveBeenCalled();
  });
});
