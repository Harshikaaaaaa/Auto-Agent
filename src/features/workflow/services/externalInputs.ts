import type { NodeData, WorkflowNode } from '@features/workflow/types';
import { getExternalInputFields, type ExternalInputField } from '@features/tools/toolRegistry';

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

/** One value the user may/must supply before a run, with where it will be written. */
export interface RequiredInput {
  /** The state key, e.g. `source_url`. */
  key: string;
  /** A human label derived from the key, e.g. "source url". */
  label: string;
  /** The node that first asked for it (for messaging). */
  nodeId: string;
  /** The node's own label, e.g. "Fetch Webpage". */
  nodeLabel: string;
  /** Any value already on the node (so an edit form can pre-fill it). */
  value: string;
  /** What this value is for, in this flow — shown under the field. */
  description: string;
  /** Whether the run cannot proceed without it. Optional ones can be skipped. */
  required: boolean;
  /** A hint the UI can validate/annotate against (url, email, phone…). */
  format?: ExternalInputField['format'];
}

/**
 * Keys that are produced by the model at run time rather than supplied by the
 * user — a step writes them, so asking the user for them would be wrong.
 */
const GENERIC_DERIVED_KEYS = new Set([
  'input',
  'query',
  'context',
  'result',
  'raw_data',
  'categorized_results',
  'message',
  'text',
  'body',
  'data',
  'rows',
  'values',
  'summary',
]);

/** Turn a state key into a readable label: `source_url` -> "source url". */
export function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The external inputs a run still needs, de-duplicated across the graph.
 *
 * A value is asked for ONLY when it is a real external input of a bound tool
 * action — i.e. the tool's own schema marks that field `external: true`. That is
 * the single authoritative signal, and it carries the field's description,
 * required flag and format. Everything else a node "declares" (raw_content,
 * extracted_text, content, records, filename, …) is internal state that some
 * step produces, so the user is never asked for it. A value already present — on
 * node data or `initialState` — clears the ask.
 *
 * Shared by the run gate and the chat collector so they never disagree.
 */
export function requiredInputsForRun(nodes: WorkflowNode[]): RequiredInput[] {
  // Field metadata (description, required flag, format) for every `external: true`
  // field of a bound tool action. This is what lets us explain a value and know
  // whether it is required — but it is NOT the list of what to ask for; that
  // comes from each node's declared externalInputKeys below.
  const fieldMeta = new Map<string, ExternalInputField>();
  for (const node of nodes) {
    for (const field of getExternalInputFields(node.data.toolId, node.data.toolAction)) {
      if (!fieldMeta.has(field.key)) fieldMeta.set(field.key, field);
    }
  }

  // Keys a real (non-trigger) step produces are the workflow's own to fill, so
  // they are never asked of the user. A trigger computes nothing, so its
  // outputs are NOT counted as produced.
  const isTrigger = (node: WorkflowNode) => {
    const t = String(node.data.type ?? node.type ?? '').toLowerCase();
    return t.includes('trigger');
  };
  const producedKeys = new Set<string>();
  for (const node of nodes) {
    if (isTrigger(node)) continue;
    for (const key of node.data.stateContract?.outputKeys ?? []) producedKeys.add(key);
  }

  const seen = new Map<string, RequiredInput>();
  for (const node of nodes) {
    // The ONLY source of "ask the user for this": the node's declared external
    // inputs. Never inputKeys/outputKeys — those are internal wiring, and
    // trusting them is what asked for records/content/filename by mistake.
    const declared = node.data.stateContract?.externalInputKeys ?? [];
    for (const key of declared) {
      if (seen.has(key)) continue;
      if (GENERIC_DERIVED_KEYS.has(key)) continue;
      // A value a real step produces is not the user's to give.
      if (producedKeys.has(key)) continue;
      // page_url and source_url are the same entry value.
      if (key === 'page_url' && declared.includes('source_url')) continue;

      const existing = externalInputValue(node, key) || String(node.data.initialState?.[key] ?? '');
      const meta = fieldMeta.get(key);
      seen.set(key, {
        key,
        label: humanizeKey(key),
        nodeId: node.id,
        nodeLabel: node.data.label,
        value: existing,
        // A registry field explains itself; a planner-only entry input (e.g. a
        // trigger's target_url) gets a sensible generic description.
        description: meta?.description ?? `The ${humanizeKey(key)} this workflow needs to start.`,
        // Registry fields carry an explicit required flag; a planner entry input
        // with no bound field is required (the flow cannot start without it).
        required: meta ? meta.required : true,
        format: meta?.format,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * REQUIRED inputs whose value is still blank — the run cannot start until these
 * are filled. Optional inputs are excluded (a blank optional does not block).
 */
export function missingRequiredInputs(nodes: WorkflowNode[]): RequiredInput[] {
  return requiredInputsForRun(nodes).filter(
    (input) => input.required && input.value.trim().length === 0,
  );
}

/**
 * What the run-input card should show: every required-and-blank input, PLUS any
 * optional input (blank or not) so the user can choose to provide it. Returns []
 * when nothing needs the user's attention, so the run proceeds silently.
 */
export function inputsToCollect(nodes: WorkflowNode[]): RequiredInput[] {
  const all = requiredInputsForRun(nodes);
  const missingRequired = all.filter((i) => i.required && i.value.trim().length === 0);
  if (missingRequired.length === 0) return [];
  // Something is required, so present the required-blank ones and the optional
  // ones together; a filled required input is not re-asked.
  return all.filter((i) => (i.required && i.value.trim().length === 0) || !i.required);
}
