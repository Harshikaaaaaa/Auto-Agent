import type { NodeData, WorkflowNode } from '@features/workflow/types';

/**
 * External inputs: the values a workflow cannot produce for itself.
 *
 * A spreadsheet id, a target URL, a recipient address — no upstream step emits
 * them, so unless the user supplies one the step will run with the field empty
 * and fail somewhere less obvious. The planner records them on each node's state
 * contract (derived from the bound action's schema, where `external: true`), and
 * these helpers are the one place that reads them back.
 *
 * Lives outside the component that first needed it because the same question
 * gets asked in two places: the plan preview, before a graph is accepted, and
 * pre-run validation, before a graph executes.
 */

/** Keys on this node that the user has to fill in. */
export function externalInputKeysOf(data: NodeData): string[] {
  return data.stateContract?.externalInputKeys ?? [];
}

/** Current value of an external input, as a string. Empty when unset. */
export function externalInputValue(node: WorkflowNode, key: string): string {
  const value = node.data[key];
  return value === undefined || value === null ? '' : String(value);
}

/** External inputs on this node that are still blank. */
export function missingExternalKeys(node: WorkflowNode): string[] {
  return externalInputKeysOf(node.data).filter(
    (key) => externalInputValue(node, key).trim().length === 0,
  );
}

/**
 * Every unfilled external input across a graph, in node order.
 *
 * `alreadyAvailable` names state keys the run will start with — anything a node
 * carries in `initialState`. A key supplied that way is not missing even though
 * the node's own data does not hold it, which is why the pre-run check passes it.
 */
export function missingExternalInputs(
  nodes: WorkflowNode[],
  alreadyAvailable: ReadonlySet<string> = new Set(),
): Array<{ nodeId: string; label: string; key: string }> {
  return nodes.flatMap((node) =>
    missingExternalKeys(node)
      .filter((key) => !alreadyAvailable.has(key))
      .map((key) => ({
        nodeId: node.id,
        label: node.data.label,
        key,
      })),
  );
}
