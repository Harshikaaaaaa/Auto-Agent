import { z } from 'zod';
import { NodeType } from '@/shared/types';
import { requestPatch } from '@features/ai/services/aiClient';
import {
  actionRequiresApproval,
  describeCatalog,
  getExternalInputKeys,
  getTool,
  type CatalogTool,
} from '@features/tools/toolRegistry';
import { validateCondition } from '@features/workflow/services/safeExpression';
import type { NodeData, WorkflowEdge, WorkflowNode } from '@features/workflow/types';

/**
 * Chat-driven graph editing.
 *
 * The version this replaces was a keyword ladder that could not fail to do
 * something. It checked the message for "rename", "delete" and "clear", and if
 * none matched it picked a node template — starting with
 * `reusableHelperNodes.find(label matches approval|validation|wait|condition|summary)`,
 * a search that never even looked at the user's message — and added it. So
 * "I didn't mention Google Sheets in the prompt, fix it" added an "If Condition"
 * node: the instruction was a removal, and the code had no way to express one it
 * had not hardcoded, so it fell through to adding something unrelated.
 *
 * Now the model returns OPERATIONS against the real graph, every operation is
 * validated against that graph and the tool catalog before anything is applied,
 * and there is NO fallback. An instruction that cannot be mapped produces a
 * question or an error — never an arbitrary node.
 *
 * Operations, not a replacement graph, for two reasons: an edit stays reviewable
 * as a list of changes, and it cannot silently discard the nodes a user
 * configured by hand.
 */

// ------------------------------------------------------------------- types

export const PATCH_NODE_TYPES = [
  'tool',
  'ai_agent',
  'logic',
  'output',
  'approval',
  'validation',
] as const;
export type PatchNodeType = (typeof PATCH_NODE_TYPES)[number];

export type GraphOperation =
  | {
      op: 'addNode';
      label: string;
      nodeType: PatchNodeType;
      description: string;
      toolId: string | null;
      toolAction: string | null;
      /** Existing node id to insert after, or null for the end. */
      after: string | null;
    }
  | { op: 'removeNode'; nodeId: string }
  | {
      op: 'replaceNode';
      nodeId: string;
      label: string;
      nodeType: PatchNodeType;
      description: string;
      toolId: string | null;
      toolAction: string | null;
    }
  | {
      op: 'updateNodeConfig';
      nodeId: string;
      label: string | null;
      description: string | null;
      config: Record<string, unknown>;
    }
  | { op: 'addEdge'; source: string; target: string; condition: string | null }
  | { op: 'removeEdge'; source: string; target: string }
  | { op: 'reorder'; nodeIds: string[] }
  | { op: 'setCondition'; source: string; target: string; condition: string }
  | { op: 'replanAll'; reason: string };

export interface GraphPatch {
  /** One line describing the change, for the chat transcript. */
  summary: string;
  /** A question to put back to the user when the instruction was ambiguous. */
  clarification: string | null;
  operations: GraphOperation[];
}

/**
 * Operations that lose work: a node's configuration, or the whole graph.
 *
 * These are surfaced for confirmation rather than applied on the strength of one
 * chat message. Undo does not currently record canvas history, so an unwanted
 * removal would not be recoverable.
 */
const DESTRUCTIVE_OPS = new Set<GraphOperation['op']>(['removeNode', 'replaceNode', 'replanAll']);

export function isDestructive(patch: GraphPatch): boolean {
  return patch.operations.some((operation) => DESTRUCTIVE_OPS.has(operation.op));
}

/** Raised when the model cannot produce operations that fit the graph. */
export class PatchValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      'I could not turn that into a valid change to this workflow, and the ' +
        'retry failed too:\n- ' +
        issues.join('\n- '),
    );
    this.name = 'PatchValidationError';
    this.issues = issues;
  }
}

// ------------------------------------------------------------------ schema

const rawOperationSchema = z.object({
  op: z.string().min(1).max(40),
  label: z.string().max(300).nullish(),
  nodeType: z.string().max(40).nullish(),
  description: z.string().max(2_000).nullish(),
  nodeId: z.string().max(200).nullish(),
  toolId: z.string().max(120).nullish(),
  toolAction: z.string().max(120).nullish(),
  after: z.string().max(200).nullish(),
  source: z.string().max(200).nullish(),
  target: z.string().max(200).nullish(),
  condition: z.string().max(500).nullish(),
  nodeIds: z.array(z.string().max(200)).max(200).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
  reason: z.string().max(1_000).nullish(),
});

const rawPatchSchema = z.object({
  summary: z.string().max(500).nullish(),
  clarification: z.string().max(1_000).nullish(),
  operations: z.array(rawOperationSchema).max(40).nullish(),
});

type RawOperation = z.infer<typeof rawOperationSchema>;

// ----------------------------------------------------------------- helpers

function text(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Unwrap `{ patch: {...} }`, which some providers emit despite the format rule. */
function unwrapPatch(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.operations) && record.patch && typeof record.patch === 'object') {
      return record.patch;
    }
  }
  return raw;
}

const NODE_TYPE_BY_PATCH_TYPE: Record<PatchNodeType, NodeType> = {
  tool: NodeType.TOOL,
  ai_agent: NodeType.AI_AGENT,
  logic: NodeType.LOGIC,
  output: NodeType.OUTPUT,
  approval: NodeType.APPROVAL,
  validation: NodeType.VALIDATION,
};

function normalisePatchNodeType(value: string | null | undefined): PatchNodeType | undefined {
  const candidate = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return PATCH_NODE_TYPES.find((type) => type === candidate);
}

/** The graph as the model needs to see it: ids, labels and bindings only. */
export function describeGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      label: node.data?.label ?? '',
      type: String(node.data?.type ?? node.type ?? ''),
      toolId: node.data?.toolId ?? null,
      toolAction: node.data?.toolAction ?? null,
    })),
    edges: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      condition: edge.condition ?? null,
    })),
  };
}

// -------------------------------------------------------------- validation

/**
 * Check every operation against the live graph and the catalog.
 *
 * Same split as the planner: ids and positions are the validator's business and
 * get normalised, but anything that makes a CLAIM — a node that does not exist, a
 * tool that does not exist, an action a tool does not have, a routing condition
 * the evaluator cannot parse — is reported and sent back for repair rather than
 * guessed at.
 */
function validatePatch(
  raw: z.infer<typeof rawPatchSchema>,
  nodes: WorkflowNode[],
  catalog: CatalogTool[],
): { patch: GraphPatch; issues: string[] } {
  const issues: string[] = [];
  const nodeIds = nodes.map((node) => node.id);
  const knownNodeIds = new Set(nodeIds);

  const actionNamesByTool = new Map<string, string[]>();
  for (const tool of catalog) {
    actionNamesByTool.set(
      tool.id,
      tool.actions.map((action) => action.name),
    );
  }
  const catalogToolIds = catalog.map((tool) => tool.id);

  /** Validate a tool binding. Returns the pair only when it is real. */
  const checkBinding = (
    where: string,
    toolId: string | undefined,
    toolAction: string | undefined,
    required: boolean,
  ): { toolId: string | null; toolAction: string | null } => {
    if (!toolId && !toolAction) {
      if (required) {
        issues.push(
          `${where} has nodeType "tool" but names no toolId/toolAction. ` +
            `Bind an action from the catalog or use a different nodeType.`,
        );
      }
      return { toolId: null, toolAction: null };
    }
    if (!toolId) {
      issues.push(`${where} names toolAction "${toolAction}" but no toolId.`);
      return { toolId: null, toolAction: null };
    }
    if (!toolAction) {
      issues.push(`${where} names toolId "${toolId}" but no toolAction.`);
      return { toolId: null, toolAction: null };
    }
    if (!actionNamesByTool.has(toolId)) {
      issues.push(
        `${where} names toolId "${toolId}", which is not in the catalog. ` +
          `The only valid tool ids are: ${catalogToolIds.join(', ')}.`,
      );
      return { toolId: null, toolAction: null };
    }
    const actions = actionNamesByTool.get(toolId) ?? [];
    if (!actions.includes(toolAction)) {
      issues.push(
        `${where} names action "${toolAction}", which tool "${toolId}" does not have. ` +
          `Valid actions for "${toolId}": ${actions.join(', ')}.`,
      );
      return { toolId: null, toolAction: null };
    }
    return { toolId, toolAction };
  };

  /** Validate a node reference. */
  const checkNodeId = (where: string, field: string, value: string | undefined): string | null => {
    if (!value) {
      issues.push(`${where} is missing "${field}".`);
      return null;
    }
    if (!knownNodeIds.has(value)) {
      issues.push(
        `${where} refers to ${field} "${value}", which is not a node in this workflow. ` +
          `The existing node ids are: ${nodeIds.join(', ') || '(none)'}.`,
      );
      return null;
    }
    return value;
  };

  const operations: GraphOperation[] = [];

  for (const [index, rawOp] of (raw.operations ?? []).entries()) {
    const op = (rawOp.op ?? '').trim();
    const where = `Operation ${index + 1} ("${op}")`;
    const operation = validateOne(rawOp, op, where);
    if (operation) operations.push(operation);
  }

  function validateOne(rawOp: RawOperation, op: string, where: string): GraphOperation | null {
    switch (op) {
      case 'addNode': {
        const label = text(rawOp.label);
        if (!label) {
          issues.push(`${where} has no label.`);
          return null;
        }
        const nodeType = normalisePatchNodeType(rawOp.nodeType);
        if (!nodeType) {
          issues.push(
            `${where} has nodeType "${rawOp.nodeType ?? ''}". ` +
              `It must be one of: ${PATCH_NODE_TYPES.join(', ')}.`,
          );
          return null;
        }
        const binding = checkBinding(
          where,
          text(rawOp.toolId),
          text(rawOp.toolAction),
          nodeType === 'tool',
        );
        // `after` is optional, but a named anchor has to exist.
        const after = text(rawOp.after);
        if (after && !knownNodeIds.has(after)) {
          issues.push(
            `${where} asks to insert after "${after}", which is not a node in this ` +
              `workflow. The existing node ids are: ${nodeIds.join(', ') || '(none)'}.`,
          );
          return null;
        }
        return {
          op: 'addNode',
          label,
          nodeType,
          description: text(rawOp.description) ?? '',
          toolId: binding.toolId,
          toolAction: binding.toolAction,
          after: after ?? null,
        };
      }

      case 'removeNode': {
        const nodeId = checkNodeId(where, 'nodeId', text(rawOp.nodeId));
        return nodeId ? { op: 'removeNode', nodeId } : null;
      }

      case 'replaceNode': {
        const nodeId = checkNodeId(where, 'nodeId', text(rawOp.nodeId));
        if (!nodeId) return null;
        const label = text(rawOp.label);
        if (!label) {
          issues.push(`${where} has no label.`);
          return null;
        }
        const nodeType = normalisePatchNodeType(rawOp.nodeType);
        if (!nodeType) {
          issues.push(
            `${where} has nodeType "${rawOp.nodeType ?? ''}". ` +
              `It must be one of: ${PATCH_NODE_TYPES.join(', ')}.`,
          );
          return null;
        }
        const binding = checkBinding(
          where,
          text(rawOp.toolId),
          text(rawOp.toolAction),
          nodeType === 'tool',
        );
        return {
          op: 'replaceNode',
          nodeId,
          label,
          nodeType,
          description: text(rawOp.description) ?? '',
          toolId: binding.toolId,
          toolAction: binding.toolAction,
        };
      }

      case 'updateNodeConfig': {
        const nodeId = checkNodeId(where, 'nodeId', text(rawOp.nodeId));
        if (!nodeId) return null;
        return {
          op: 'updateNodeConfig',
          nodeId,
          label: text(rawOp.label) ?? null,
          description: text(rawOp.description) ?? null,
          config: rawOp.config ?? {},
        };
      }

      case 'addEdge': {
        const source = checkNodeId(where, 'source', text(rawOp.source));
        const target = checkNodeId(where, 'target', text(rawOp.target));
        if (!source || !target) return null;
        if (source === target) {
          issues.push(`${where} connects "${source}" to itself.`);
          return null;
        }
        const condition = text(rawOp.condition) ?? null;
        if (condition && !checkConditionExpression(where, condition)) return null;
        return { op: 'addEdge', source, target, condition };
      }

      case 'removeEdge': {
        const source = checkNodeId(where, 'source', text(rawOp.source));
        const target = checkNodeId(where, 'target', text(rawOp.target));
        return source && target ? { op: 'removeEdge', source, target } : null;
      }

      case 'setCondition': {
        const source = checkNodeId(where, 'source', text(rawOp.source));
        const target = checkNodeId(where, 'target', text(rawOp.target));
        if (!source || !target) return null;
        const condition = text(rawOp.condition);
        if (!condition) {
          issues.push(`${where} has no condition expression.`);
          return null;
        }
        if (!checkConditionExpression(where, condition)) return null;
        return { op: 'setCondition', source, target, condition };
      }

      case 'reorder': {
        const requested = (rawOp.nodeIds ?? []).map((id) => id.trim()).filter(Boolean);
        if (requested.length === 0) {
          issues.push(`${where} lists no nodeIds.`);
          return null;
        }
        const unknown = requested.filter((id) => !knownNodeIds.has(id));
        if (unknown.length > 0) {
          issues.push(
            `${where} lists ${unknown.map((id) => `"${id}"`).join(', ')}, which ` +
              `${unknown.length === 1 ? 'is not a node' : 'are not nodes'} in this ` +
              `workflow. The existing node ids are: ${nodeIds.join(', ') || '(none)'}.`,
          );
          return null;
        }
        return { op: 'reorder', nodeIds: Array.from(new Set(requested)) };
      }

      case 'replanAll': {
        return { op: 'replanAll', reason: text(rawOp.reason) ?? 'Start the workflow over.' };
      }

      default:
        issues.push(
          `${where} is not an operation I support. Use one of: addNode, removeNode, ` +
            `replaceNode, updateNodeConfig, addEdge, removeEdge, reorder, setCondition, ` +
            `replanAll.`,
        );
        return null;
    }
  }

  /**
   * A routing condition is evaluated by the restricted expression evaluator, so
   * an expression it cannot parse would fail closed at run time and silently
   * skip the branch. Better to reject it now and say why.
   */
  function checkConditionExpression(where: string, condition: string): boolean {
    // `validateCondition` returns null when the expression is usable, or the
    // compiler's reason when it is not.
    const problem = validateCondition(condition);
    if (problem) {
      issues.push(
        `${where} has a condition the evaluator cannot use: ${problem}. ` +
          `Conditions compare state keys, for example: sentiment == 'positive'.`,
      );
      return false;
    }
    return true;
  }

  const clarification = text(raw.clarification) ?? null;

  // "No operations and no question" is not an answer. Reporting it gives the
  // retry something to act on, instead of the user seeing nothing happen.
  if (operations.length === 0 && !clarification && issues.length === 0) {
    issues.push(
      'You returned no operations and no clarification. Either emit the operations ' +
        'that satisfy the instruction, or ask one specific question in "clarification".',
    );
  }

  return {
    patch: {
      summary: text(raw.summary) ?? '',
      clarification,
      operations,
    },
    issues,
  };
}

// -------------------------------------------------------------- generation

/** One request plus one informed repair attempt. */
const MAX_PATCH_ATTEMPTS = 2;

/**
 * Turn a chat instruction into validated operations on the current graph.
 *
 * @throws PatchValidationError when no valid operation set can be produced.
 * @throws AiRequestError when the server or provider call fails.
 */
export async function generateGraphPatch(
  message: string,
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  model?: string,
): Promise<GraphPatch> {
  const catalog = describeCatalog();
  const described = describeGraph(graph.nodes, graph.edges);

  let repairFeedback: string | undefined;
  let issues: string[] = ['the model returned no usable operations'];

  for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt += 1) {
    const { patch: raw } = await requestPatch({
      message,
      graph: described,
      catalog,
      model,
      // Its own field, not appended to the instruction: the server fences
      // the instruction as untrusted data and tells the model to ignore
      // directions inside it, so repair guidance placed there would be
      // ignored by design.
      repairFeedback,
    });

    const parsed = rawPatchSchema.safeParse(unwrapPatch(raw));
    if (parsed.success) {
      const result = validatePatch(parsed.data, graph.nodes, catalog);
      if (result.issues.length === 0) return result.patch;
      issues = result.issues;
    } else {
      issues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
    }

    repairFeedback = issues.join('\n- ');
  }

  throw new PatchValidationError(issues);
}

// ----------------------------------------------------------------- applying

const NODE_SPACING_X = 220;
const NODE_SPACING_Y = 100;

/** Build node data for an added or replaced node, reading the action's schema. */
function nodeDataFor(spec: {
  label: string;
  nodeType: PatchNodeType;
  description: string;
  toolId: string | null;
  toolAction: string | null;
}): NodeData {
  const type = NODE_TYPE_BY_PATCH_TYPE[spec.nodeType];

  if (spec.toolId && spec.toolAction) {
    const action = getTool(spec.toolId)?.actions.find((a) => a.name === spec.toolAction);
    if (action) {
      return {
        label: spec.label,
        description: spec.description,
        type: NodeType.TOOL,
        toolId: spec.toolId,
        toolAction: spec.toolAction,
        // Surfaced for the UI; the registry still enforces the gate.
        requiresApproval: actionRequiresApproval(spec.toolId, spec.toolAction),
        stateContract: {
          inputKeys: action.inputKeys,
          outputKeys: action.outputKeys,
          externalInputKeys: getExternalInputKeys(spec.toolId, spec.toolAction),
        },
      };
    }
  }

  return {
    label: spec.label,
    description: spec.description,
    type,
    stateContract: { inputKeys: ['input'], outputKeys: ['result'] },
  };
}

/** A unique node id derived from a label. */
function nodeIdFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'node';
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}_${suffix}`;
  }
  taken.add(id);
  return id;
}

export interface PatchResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** One human-readable line per change actually made, for the transcript. */
  applied: string[];
}

/**
 * Apply a validated patch. Pure: it returns a new graph and never mutates input.
 *
 * Every branch corresponds to an operation the model asked for. There is no
 * "otherwise add something" path, which is the whole point.
 */
export function applyPatch(
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  patch: GraphPatch,
): PatchResult {
  let nodes = graph.nodes.map((node) => ({ ...node, data: { ...node.data } }));
  let edges = graph.edges.map((edge) => ({ ...edge }));
  const applied: string[] = [];
  const taken = new Set(nodes.map((node) => node.id));

  for (const operation of patch.operations) {
    switch (operation.op) {
      case 'replanAll': {
        nodes = [];
        edges = [];
        applied.push(`Cleared the canvas — ${operation.reason}`);
        break;
      }

      case 'addNode': {
        const id = nodeIdFor(operation.label, taken);
        const anchorIndex = operation.after
          ? nodes.findIndex((node) => node.id === operation.after)
          : nodes.length - 1;
        const anchor = anchorIndex >= 0 ? nodes[anchorIndex] : undefined;

        const node: WorkflowNode = {
          id,
          type: NODE_TYPE_BY_PATCH_TYPE[operation.nodeType],
          position: anchor
            ? {
                x: anchor.position.x + NODE_SPACING_X,
                y: anchor.position.y + NODE_SPACING_Y,
              }
            : { x: 420, y: 220 },
          data: nodeDataFor(operation),
        };

        // Inserted in sequence, so "after X" also means "between X and
        // whatever followed X" rather than just "somewhere on screen".
        const insertAt = anchorIndex >= 0 ? anchorIndex + 1 : nodes.length;
        nodes = [...nodes.slice(0, insertAt), node, ...nodes.slice(insertAt)];

        if (anchor) {
          const downstream = edges.filter((edge) => edge.source === anchor.id);
          edges = [
            ...edges.filter((edge) => edge.source !== anchor.id),
            { id: `edge_${anchor.id}_${id}`, source: anchor.id, target: id },
            // The old outgoing edges are re-hung off the new node so an
            // insert splices into the chain instead of orphaning the tail.
            ...downstream.map((edge) => ({
              ...edge,
              id: `edge_${id}_${edge.target}`,
              source: id,
            })),
          ];
          applied.push(`Added “${operation.label}” after “${anchor.data.label}”`);
        } else {
          applied.push(`Added “${operation.label}”`);
        }
        break;
      }

      case 'removeNode': {
        const removed = nodes.find((node) => node.id === operation.nodeId);
        if (!removed) break;
        const incoming = edges.filter((edge) => edge.target === operation.nodeId);
        const outgoing = edges.filter((edge) => edge.source === operation.nodeId);

        edges = edges.filter(
          (edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId,
        );

        // Close the chain, so removing a middle step does not cut the
        // workflow in half.
        for (const before of incoming) {
          for (const after of outgoing) {
            if (before.source === after.target) continue;
            const id = `edge_${before.source}_${after.target}`;
            if (edges.some((edge) => edge.id === id)) continue;
            edges.push({
              id,
              source: before.source,
              target: after.target,
              ...(before.condition ? { condition: before.condition } : {}),
            });
          }
        }

        nodes = nodes.filter((node) => node.id !== operation.nodeId);
        applied.push(`Removed “${removed.data.label}”`);
        break;
      }

      case 'replaceNode': {
        const index = nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) break;
        const previous = nodes[index];
        nodes = nodes.map((node, at) =>
          at === index
            ? {
                ...node,
                type: NODE_TYPE_BY_PATCH_TYPE[operation.nodeType],
                data: nodeDataFor(operation),
              }
            : node,
        );
        applied.push(`Replaced “${previous.data.label}” with “${operation.label}”`);
        break;
      }

      case 'updateNodeConfig': {
        const target = nodes.find((node) => node.id === operation.nodeId);
        if (!target) break;
        nodes = nodes.map((node) =>
          node.id === operation.nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  ...operation.config,
                  ...(operation.label ? { label: operation.label } : {}),
                  ...(operation.description ? { description: operation.description } : {}),
                },
              }
            : node,
        );
        applied.push(`Updated “${operation.label ?? target.data.label}”`);
        break;
      }

      case 'addEdge': {
        const exists = edges.some(
          (edge) => edge.source === operation.source && edge.target === operation.target,
        );
        if (exists) break;
        edges = [
          ...edges,
          {
            id: `edge_${operation.source}_${operation.target}`,
            source: operation.source,
            target: operation.target,
            ...(operation.condition ? { condition: operation.condition } : {}),
          },
        ];
        applied.push(
          `Connected “${labelOf(nodes, operation.source)}” to “${labelOf(nodes, operation.target)}”`,
        );
        break;
      }

      case 'removeEdge': {
        const before = edges.length;
        edges = edges.filter(
          (edge) => !(edge.source === operation.source && edge.target === operation.target),
        );
        if (edges.length !== before) {
          applied.push(
            `Disconnected “${labelOf(nodes, operation.source)}” from “${labelOf(nodes, operation.target)}”`,
          );
        }
        break;
      }

      case 'setCondition': {
        let changed = false;
        edges = edges.map((edge) => {
          if (edge.source === operation.source && edge.target === operation.target) {
            changed = true;
            return { ...edge, condition: operation.condition };
          }
          return edge;
        });
        if (changed) {
          applied.push(
            `Set the route from “${labelOf(nodes, operation.source)}” to run when ${operation.condition}`,
          );
        } else {
          // No edge to carry it: add one rather than dropping the request.
          edges = [
            ...edges,
            {
              id: `edge_${operation.source}_${operation.target}`,
              source: operation.source,
              target: operation.target,
              condition: operation.condition,
            },
          ];
          applied.push(
            `Connected “${labelOf(nodes, operation.source)}” to “${labelOf(nodes, operation.target)}” when ${operation.condition}`,
          );
        }
        break;
      }

      case 'reorder': {
        const listed = operation.nodeIds
          .map((id) => nodes.find((node) => node.id === id))
          .filter((node): node is WorkflowNode => Boolean(node));
        const rest = nodes.filter((node) => !operation.nodeIds.includes(node.id));
        const ordered = [...listed, ...rest];

        // Re-space along the row so the visual order matches the new
        // sequence; the edges are rebuilt to follow it.
        const first = nodes[0]?.position ?? { x: 300, y: 0 };
        nodes = ordered.map((node, at) => ({
          ...node,
          position: { x: first.x + at * NODE_SPACING_X, y: first.y },
        }));
        edges = nodes.slice(1).map((node, at) => ({
          id: `edge_${nodes[at].id}_${node.id}`,
          source: nodes[at].id,
          target: node.id,
        }));
        applied.push(`Reordered the steps: ${nodes.map((node) => node.data.label).join(' → ')}`);
        break;
      }
    }
  }

  return { nodes, edges, applied };
}

function labelOf(nodes: WorkflowNode[], id: string): string {
  return nodes.find((node) => node.id === id)?.data.label ?? id;
}

/**
 * One line describing what an operation WOULD do, before it is applied.
 *
 * Used by the confirmation prompt, so the user agrees to a named change rather
 * than to the word "apply". Node labels are resolved against the current graph
 * because an id like `save_to_sheets_2` means nothing to a reader.
 */
export function describeOperation(operation: GraphOperation, nodes: WorkflowNode[]): string {
  switch (operation.op) {
    case 'addNode':
      return operation.after
        ? `Add “${operation.label}” after “${labelOf(nodes, operation.after)}”`
        : `Add “${operation.label}”`;
    case 'removeNode':
      return `Remove “${labelOf(nodes, operation.nodeId)}”`;
    case 'replaceNode':
      return `Replace “${labelOf(nodes, operation.nodeId)}” with “${operation.label}”${
        operation.toolId ? ` (${operation.toolId}.${operation.toolAction})` : ''
      }`;
    case 'updateNodeConfig':
      return `Update “${labelOf(nodes, operation.nodeId)}”`;
    case 'addEdge':
      return `Connect “${labelOf(nodes, operation.source)}” to “${labelOf(nodes, operation.target)}”`;
    case 'removeEdge':
      return `Disconnect “${labelOf(nodes, operation.source)}” from “${labelOf(nodes, operation.target)}”`;
    case 'setCondition':
      return `Route “${labelOf(nodes, operation.source)}” to “${labelOf(nodes, operation.target)}” when ${operation.condition}`;
    case 'reorder':
      return `Reorder to: ${operation.nodeIds.map((id) => labelOf(nodes, id)).join(' → ')}`;
    case 'replanAll':
      return `Clear the whole canvas — ${operation.reason}`;
  }
}
