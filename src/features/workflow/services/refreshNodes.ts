/**
 * Re-derive every tool-bound node's state contract from the live tool registry.
 *
 * Data between nodes flows by NAME through one shared state object: a node reads
 * the `stateContract.inputKeys` it declares and the run engine resolves each
 * against the alias groups. Those keys are DERIVED from the bound action's
 * schema at the moment the node is created — by `buildNodeFromPlanStep` for a
 * planned node and `nodeDataFor` for a chat-added one. So a node created before
 * an action's schema changed, or before an alias group was extended, can carry a
 * stale contract that no longer lines up with what the rest of the graph
 * produces, and fails `invalid_input` at run time even though the fix already
 * shipped.
 *
 * "Refresh Nodes" recomputes those contracts in place from the registry, the
 * same way the planner and patcher do, so a node picks up a corrected schema
 * without regenerating the whole workflow. It is deliberately narrow:
 *
 *   - Only `stateContract` is touched. Labels, descriptions, positions, config,
 *     version history, `initialState`, edges — everything else is preserved.
 *   - Only tool-bound nodes are recomputed (their keys come from the schema).
 *     A generic/AI node's keys are the planner's prose, not derivable here, so
 *     it is left exactly as-is.
 *   - A node whose tool/action is no longer registered is left untouched rather
 *     than blanked, so an unknown binding degrades to "no change", never data
 *     loss.
 *
 * Pure and idempotent: refreshing an already-current graph returns node objects
 * whose contracts equal what they already were.
 */
import { getExternalInputKeys, getTool } from '@features/tools/toolRegistry';
import type { NodeStateContract, WorkflowNode } from '@features/workflow/types';

export interface RefreshResult {
  nodes: WorkflowNode[];
  /** Count of nodes whose contract actually changed — for the toast/transcript. */
  changed: number;
  /** Labels of the changed nodes, for a specific message. */
  changedLabels: string[];
}

/** True when two contracts declare the same three key lists (order-sensitive). */
function contractsEqual(a?: NodeStateContract, b?: NodeStateContract): boolean {
  const same = (x?: string[], y?: string[]) =>
    (x ?? []).length === (y ?? []).length && (x ?? []).every((v, i) => v === (y ?? [])[i]);
  return (
    same(a?.inputKeys, b?.inputKeys) &&
    same(a?.outputKeys, b?.outputKeys) &&
    same(a?.externalInputKeys, b?.externalInputKeys)
  );
}

export function refreshNodeContracts(nodes: WorkflowNode[]): RefreshResult {
  const changedLabels: string[] = [];

  const next = nodes.map((node) => {
    const { toolId, toolAction } = node.data;
    // Only a bound tool node has a schema to re-derive from.
    if (!toolId || !toolAction) return node;

    const action = getTool(toolId)?.actions.find((a) => a.name === toolAction);
    // Unknown binding: leave it rather than blanking a contract.
    if (!action) return node;

    const fresh: NodeStateContract = {
      // The schema owns these, exactly as the planner/patcher derive them.
      inputKeys: action.inputKeys,
      outputKeys: action.outputKeys,
      externalInputKeys: getExternalInputKeys(toolId, toolAction),
      // Preserve any reducer the node already carried; it is not schema-derived.
      ...(node.data.stateContract?.reducer ? { reducer: node.data.stateContract.reducer } : {}),
    };

    if (contractsEqual(node.data.stateContract, fresh)) return node;

    changedLabels.push(node.data.label);
    return { ...node, data: { ...node.data, stateContract: fresh } };
  });

  return { nodes: next, changed: changedLabels.length, changedLabels };
}
