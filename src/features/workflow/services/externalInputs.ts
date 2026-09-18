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
 * A key is required when some node declares it (via `externalInputKeys`, or its
 * `inputKeys` as a fallback) AND nothing upstream produces it AND it is not a
 * generic model-derived key. A value already present — on the node's data or its
 * `initialState` — clears it. This is the single source of truth shared by the
 * run gate and the chat collector, so they never disagree.
 */
export function requiredInputsForRun(nodes: WorkflowNode[]): RequiredInput[] {
  // A key is genuinely PRODUCED only by a node that actually computes it at run
  // time — a tool/AI/logic step. A trigger node that "outputs" source_url is not
  // computing anything; it is declaring a value the user must supply. Counting
  // its outputs as produced is exactly what let a run start with an empty URL.
  const isTrigger = (node: WorkflowNode) => {
    const t = String(node.data.type ?? node.type ?? '').toLowerCase();
    return t.includes('trigger');
  };

  const producedKeys = new Set<string>();
  for (const node of nodes) {
    if (isTrigger(node)) continue;
    for (const key of node.data.stateContract?.outputKeys ?? []) producedKeys.add(key);
  }

  // Field metadata (description, required, format) lives on the bound action in
  // the tool registry, keyed by the input name — collect it from every tool
  // node so a key surfaced by a trigger can still be explained by the tool that
  // consumes it (e.g. source_url's description comes from web.fetch_page).
  const fieldMeta = new Map<string, ExternalInputField>();
  for (const node of nodes) {
    for (const field of getExternalInputFields(node.data.toolId, node.data.toolAction)) {
      if (!fieldMeta.has(field.key)) fieldMeta.set(field.key, field);
    }
  }

  const seen = new Map<string, RequiredInput>();
  const consider = (node: WorkflowNode, key: string) => {
    if (producedKeys.has(key) || GENERIC_DERIVED_KEYS.has(key)) return;
    if (seen.has(key)) return;
    const existing = externalInputValue(node, key) || String(node.data.initialState?.[key] ?? '');
    const meta = fieldMeta.get(key);
    seen.set(key, {
      key,
      label: humanizeKey(key),
      nodeId: node.id,
      nodeLabel: node.data.label,
      value: existing,
      description: meta?.description ?? '',
      // A trigger-surfaced entry input with no bound field is required by
      // default (the flow needs it to start); otherwise trust the schema flag.
      required: meta ? meta.required : true,
      format: meta?.format,
    });
  };

  for (const node of nodes) {
    const contract = node.data.stateContract ?? { inputKeys: [], outputKeys: [] };

    // A trigger's declared outputs are the workflow's entry inputs — the user
    // provides them — so they are required unless something already fills them.
    if (isTrigger(node)) {
      for (const key of contract.outputKeys ?? []) consider(node, key);
      continue;
    }

    const declared =
      contract.externalInputKeys && contract.externalInputKeys.length > 0
        ? contract.externalInputKeys
        : (contract.inputKeys ?? []);
    for (const key of declared) {
      // A page_url is the same thing as a source_url when both are declared.
      if (key === 'page_url' && declared.includes('source_url')) continue;
      consider(node, key);
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
