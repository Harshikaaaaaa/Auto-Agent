import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Node } from 'reactflow';
import { NodeType } from '@/shared/types';
import type { FlowEdge } from '@features/workflow/types';
import { registerTool } from '@features/tools/toolRegistry';
import { useWorkflowExecution } from '../useWorkflowExecution';

/**
 * The approval gate at execution time.
 *
 * Approval used to be decided by a hardcoded list of tool ids, which gated
 * harmless reads and would silently miss any connector added later. It is now
 * derived from each action's side-effect classification, and these tests run the
 * real engine to prove it.
 */

const executed: string[] = [];

/** Register purpose-built tools so the test does not depend on real credentials. */
function registerTestTools() {
  registerTool({
    id: 'test_sender',
    name: 'Test Sender',
    description: 'Sends things that cannot be unsent.',
    icon: 'Send',
    color: '#000000',
    category: 'communication',
    scopes: [],
    costProfile: { latencyMs: 10, cost: 0, reliability: 9 },
    actions: [
      {
        name: 'send',
        description: 'Send a message that cannot be recalled.',
        capabilities: ['chat.send'],
        sideEffect: 'irreversible',
        requiresAuth: false,
        inputSchema: { text: { type: 'string', description: 'Body.' } },
        outputSchema: { sent: { type: 'boolean', description: 'Whether it went out.' } },
        execute: async () => {
          executed.push('send');
          return { sent: true };
        },
      },
      {
        name: 'peek',
        description: 'Read something harmless.',
        capabilities: ['chat.read'],
        sideEffect: 'read',
        requiresAuth: false,
        inputSchema: {},
        outputSchema: { seen: { type: 'boolean', description: 'Whether it read anything.' } },
        execute: async () => {
          executed.push('peek');
          return { seen: true };
        },
      },
      {
        name: 'append',
        description: 'Add a row that can be corrected later.',
        capabilities: ['spreadsheet.write'],
        sideEffect: 'write',
        requiresAuth: false,
        inputSchema: {},
        outputSchema: { appended: { type: 'boolean', description: 'Whether it wrote.' } },
        execute: async () => {
          executed.push('append');
          return { appended: true };
        },
      },
    ],
    isAuthenticated: () => true,
    authenticate: async () => {},
    disconnect: () => {},
  });
}

function toolNode(id: string, toolAction: string, extra: Record<string, unknown> = {}): Node {
  return {
    id,
    type: 'tool',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: NodeType.TOOL,
      toolId: 'test_sender',
      toolAction,
      stateContract: { inputKeys: [], outputKeys: Object.keys({ result: 1 }) },
      ...extra,
    },
  };
}

/** Run a single-node graph, capturing any approval request. */
async function runNode(node: Node, approve: boolean) {
  const approvals: Array<{ nodeId: string; nodeLabel: string; message: string }> = [];
  const onApprovalRequired = vi.fn(async (payload: (typeof approvals)[number]) => {
    approvals.push(payload);
    return approve;
  });

  const { result } = renderHook(() =>
    useWorkflowExecution([node], [] as FlowEdge[], vi.fn(), onApprovalRequired),
  );

  await act(async () => {
    await result.current.executeFlow();
  });
  await waitFor(() => {
    expect(['completed', 'failed', 'paused', 'cancelled']).toContain(result.current.runtimeStatus);
  });

  return { approvals, onApprovalRequired, status: result.current.runtimeStatus };
}

describe('approval derived from side-effect classification', () => {
  beforeEach(() => {
    localStorage.clear();
    executed.length = 0;
    registerTestTools();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('pauses for approval before an irreversible action', async () => {
    const { onApprovalRequired, approvals } = await runNode(toolNode('sender', 'send'), true);

    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    expect(approvals[0].nodeId).toBe('sender');
    // Approved, so it went through.
    expect(executed).toContain('send');
  });

  it('does not run the irreversible action when approval is refused', async () => {
    const { status } = await runNode(toolNode('sender', 'send'), false);

    // This is the property that matters: refusing must actually stop the send.
    expect(executed).not.toContain('send');
    expect(status).toBe('paused');
  });

  it('does not ask for approval before a read', async () => {
    const { onApprovalRequired } = await runNode(toolNode('reader', 'peek'), true);

    expect(onApprovalRequired).not.toHaveBeenCalled();
    expect(executed).toContain('peek');
  });

  it('does not ask for approval before a correctable write', async () => {
    const { onApprovalRequired } = await runNode(toolNode('writer', 'append'), true);

    expect(onApprovalRequired).not.toHaveBeenCalled();
    expect(executed).toContain('append');
  });

  it('still honours an explicit requiresApproval opt-in on a read', async () => {
    const node = toolNode('cautious-reader', 'peek', { requiresApproval: true });
    const { onApprovalRequired } = await runNode(node, true);

    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
  });

  it('cannot be opted OUT of for an irreversible action', async () => {
    // A saved workflow must not be able to disable the gate on a send.
    const node = toolNode('sneaky-sender', 'send', { requiresApproval: false });
    const { onApprovalRequired } = await runNode(node, false);

    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    expect(executed).not.toContain('send');
  });
});
