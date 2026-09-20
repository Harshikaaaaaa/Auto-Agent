import { describe, expect, it } from 'vitest';
import { getExternalInputKeys, getTool } from '@features/tools/toolRegistry';
// Registers every connector as a side-effect, so getTool('gmail') resolves.
import '@features/tools/connectors';
import type { WorkflowNode } from '@features/workflow/types';
import { refreshNodeContracts } from '../refreshNodes';

// A real registered action to derive the "correct" contract from, so the test
// tracks the registry rather than hard-coding key names that could drift.
const TOOL_ID = 'gmail';
const ACTION = 'read_inbox';
const action = getTool(TOOL_ID)!.actions.find((a) => a.name === ACTION)!;

function node(id: string, data: Partial<WorkflowNode['data']>): WorkflowNode {
  return {
    id,
    type: 'tool',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'tool' as never, ...data },
  };
}

describe('refreshNodeContracts', () => {
  it('re-derives a tool node whose contract drifted from the schema', () => {
    const stale = node('read', {
      label: 'Read Inbox',
      toolId: TOOL_ID,
      toolAction: ACTION,
      // Deliberately wrong keys, as an old node built before a schema change.
      stateContract: { inputKeys: ['old_input'], outputKeys: ['old_output'] },
    });

    const result = refreshNodeContracts([stale]);

    expect(result.changed).toBe(1);
    expect(result.changedLabels).toEqual(['Read Inbox']);
    const refreshed = result.nodes[0].data.stateContract;
    expect(refreshed?.inputKeys).toEqual(action.inputKeys);
    expect(refreshed?.outputKeys).toEqual(action.outputKeys);
    expect(refreshed?.externalInputKeys).toEqual(getExternalInputKeys(TOOL_ID, ACTION));
  });

  it('is a no-op when the contract already matches the schema', () => {
    const current = node('read', {
      label: 'Read Inbox',
      toolId: TOOL_ID,
      toolAction: ACTION,
      stateContract: {
        inputKeys: action.inputKeys,
        outputKeys: action.outputKeys,
        externalInputKeys: getExternalInputKeys(TOOL_ID, ACTION),
      },
    });

    const result = refreshNodeContracts([current]);

    expect(result.changed).toBe(0);
    // The exact same node object is returned when nothing changed.
    expect(result.nodes[0]).toBe(current);
  });

  it('leaves a generic (non-tool) node untouched', () => {
    const generic = node('summarise', {
      label: 'Summarise',
      stateContract: { inputKeys: ['content'], outputKeys: ['summary'] },
    });

    const result = refreshNodeContracts([generic]);

    expect(result.changed).toBe(0);
    expect(result.nodes[0]).toBe(generic);
  });

  it('leaves a node whose tool/action is no longer registered untouched', () => {
    const orphan = node('gone', {
      label: 'Dead Tool',
      toolId: 'no_such_tool',
      toolAction: 'no_such_action',
      stateContract: { inputKeys: ['x'], outputKeys: ['y'] },
    });

    const result = refreshNodeContracts([orphan]);

    expect(result.changed).toBe(0);
    expect(result.nodes[0]).toBe(orphan);
    // Not blanked — data loss would be worse than a stale contract.
    expect(result.nodes[0].data.stateContract?.inputKeys).toEqual(['x']);
  });

  it('preserves an existing reducer while refreshing the keys', () => {
    const withReducer = node('read', {
      label: 'Read Inbox',
      toolId: TOOL_ID,
      toolAction: ACTION,
      stateContract: { inputKeys: ['stale'], outputKeys: ['stale'], reducer: 'append' },
    });

    const result = refreshNodeContracts([withReducer]);

    expect(result.changed).toBe(1);
    expect(result.nodes[0].data.stateContract?.reducer).toBe('append');
    expect(result.nodes[0].data.stateContract?.inputKeys).toEqual(action.inputKeys);
  });

  it('does not mutate the input nodes', () => {
    const stale = node('read', {
      label: 'Read Inbox',
      toolId: TOOL_ID,
      toolAction: ACTION,
      stateContract: { inputKeys: ['old'], outputKeys: ['old'] },
    });
    refreshNodeContracts([stale]);
    expect(stale.data.stateContract?.inputKeys).toEqual(['old']);
  });
});
