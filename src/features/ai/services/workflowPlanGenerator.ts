import { z } from 'zod';
import { NodeType } from '@/shared/types';
import { requestPlan } from '@features/ai/services/aiClient';
import {
    actionRequiresApproval,
    describeCatalog,
    getExternalInputKeys,
    getTool,
    rankToolMatches,
    type CapabilityMatch,
    type CatalogAction,
    type CatalogTool
} from '@features/tools/toolRegistry';
import type { NodeData, Workflow, WorkflowEdge, WorkflowNode } from '@features/workflow/types';

/**
 * Workflow planning.
 *
 * ONE route: the request, the tool catalog and weak keyword hints go to the
 * server, the model returns a plan, and the plan is validated against the
 * catalog before anything is built from it.
 *
 * What this deliberately does NOT do:
 *
 *  - It does not pattern-match the prompt to decide what the workflow is. The
 *    previous implementation did, and a prompt asking for a Markdown file it
 *    could download came back as "Save results to Google Sheets" because
 *    /save|store|log/ matched. Keyword rankings are still computed, but they
 *    are passed as hints the model may ignore, never as a decision.
 *  - It does not substitute a "close enough" tool. A step either binds a
 *    toolId/toolAction that exists in the catalog, or it is marked unsupported
 *    with a reason the user can read. A wrong tool is worse than an honest gap.
 *  - It does not pad a plan to hit a step count, and it does not invent
 *    required tools. Every derived field comes from the steps themselves.
 *
 * When the model breaks those rules the plan is rejected and retried ONCE with
 * the specific failures as feedback — re-asking the same question would most
 * likely reproduce the same answer. A second failure throws.
 */

// ------------------------------------------------------------------- types

export const PLAN_STEP_TYPES = ['trigger', 'process', 'decision', 'tool', 'output'] as const;
export type PlanStepType = (typeof PLAN_STEP_TYPES)[number];

export const PLAN_ESTIMATES = ['Fast', 'Medium', 'Slow'] as const;
export type PlanEstimate = (typeof PLAN_ESTIMATES)[number];

/**
 * One validated step.
 *
 * The invariant that matters: `toolId`/`toolAction` are either BOTH a real
 * catalog action or BOTH null, and a step with `unsupported: true` always has
 * both null plus a reason.
 */
export interface PlanStep {
    id: string;
    order: number;
    type: PlanStepType;
    label: string;
    description: string;
    /** A tool id that exists in the catalog, or null. */
    toolId: string | null;
    /** An action that exists on `toolId`, or null. */
    toolAction: string | null;
    /** No registered tool provides what this step needs. */
    unsupported: boolean;
    /** Why the step is unsupported. Non-null whenever `unsupported` is true. */
    unsupportedReason: string | null;
    /** State keys the step reads. */
    inputs: string[];
    /** State keys the step writes. */
    outputs: string[];
    /** Values the user must supply before the workflow can run. */
    externalInputs: string[];
}

export interface WorkflowPlan {
    title: string;
    description: string;
    estimatedTime: PlanEstimate;
    steps: PlanStep[];
    /** DERIVED from the steps that actually bind a tool. Never guessed. */
    requiredTools: string[];
    /** DERIVED: the reasons steps could not be satisfied, for the preview. */
    unsupportedCapabilities: string[];
    /** DERIVED: the bindings the planner chose, for the preview. */
    capabilityMatches: CapabilityMatch[];
}

/** Raised when the model cannot produce a plan that satisfies the catalog. */
export class PlanValidationError extends Error {
    readonly issues: string[];

    constructor(issues: string[]) {
        super(
            'The plan the model returned did not match the available tools, and the ' +
            'retry failed too:\n- ' + issues.join('\n- ')
        );
        this.name = 'PlanValidationError';
        this.issues = issues;
    }
}

// ------------------------------------------------------------------ schema

/**
 * Shape check on untrusted model output.
 *
 * Fields are `nullish` rather than required-with-default because models emit
 * `null` for "not applicable" at least as often as they omit the key, and both
 * should be treated the same. Semantic checks happen afterwards, where a failure
 * can be explained back to the model in words.
 */
const rawStepSchema = z.object({
    id: z.string().max(200).nullish(),
    order: z.number().finite().nullish(),
    type: z.string().max(40).nullish(),
    label: z.string().min(1).max(300),
    description: z.string().max(4_000).nullish(),
    toolId: z.string().max(120).nullish(),
    toolAction: z.string().max(120).nullish(),
    unsupported: z.boolean().nullish(),
    unsupportedReason: z.string().max(1_000).nullish(),
    inputs: z.array(z.string().max(200)).max(60).nullish(),
    outputs: z.array(z.string().max(200)).max(60).nullish(),
    externalInputs: z.array(z.string().max(200)).max(60).nullish()
});

const rawPlanSchema = z.object({
    title: z.string().max(300).nullish(),
    description: z.string().max(4_000).nullish(),
    estimatedTime: z.string().max(40).nullish(),
    steps: z.array(rawStepSchema).min(1).max(24)
});

type RawPlan = z.infer<typeof rawPlanSchema>;

// ----------------------------------------------------------------- helpers

/** Trimmed string, or undefined for null/empty. Models send both. */
function text(value: string | null | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(value => value.trim().length > 0)));
}

function slug(value: string, fallback: string): string {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    return cleaned.length > 0 ? cleaned : fallback;
}

function normaliseStepType(value: string | null | undefined): PlanStepType | undefined {
    const candidate = (value ?? '').trim().toLowerCase();
    return PLAN_STEP_TYPES.find(type => type === candidate);
}

function normaliseEstimate(value: string | null | undefined): PlanEstimate {
    const candidate = (value ?? '').trim().toLowerCase();
    return PLAN_ESTIMATES.find(estimate => estimate.toLowerCase() === candidate) ?? 'Medium';
}

/**
 * Some providers wrap the answer as `{ "plan": { ... } }` despite being told not
 * to. Unwrapping one level is cheaper than burning a retry on it.
 */
function unwrapPlan(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = raw as Record<string, unknown>;
        if (!Array.isArray(record.steps) && record.plan && typeof record.plan === 'object') {
            return record.plan;
        }
    }
    return raw;
}

interface CatalogIndex {
    toolIds: string[];
    toolNames: Map<string, string>;
    actionNamesByTool: Map<string, string[]>;
    actions: Map<string, CatalogAction>;
}

function indexCatalog(catalog: CatalogTool[]): CatalogIndex {
    const toolNames = new Map<string, string>();
    const actionNamesByTool = new Map<string, string[]>();
    const actions = new Map<string, CatalogAction>();

    for (const tool of catalog) {
        toolNames.set(tool.id, tool.name);
        actionNamesByTool.set(tool.id, tool.actions.map(action => action.name));
        for (const action of tool.actions) {
            actions.set(`${tool.id}.${action.name}`, action);
        }
    }

    return { toolIds: catalog.map(tool => tool.id), toolNames, actionNamesByTool, actions };
}

// -------------------------------------------------------------- validation

/**
 * Turn raw model output into a plan, collecting every rule it broke.
 *
 * Two different kinds of correction happen here, and the distinction is the
 * whole point:
 *
 *  - NORMALISED silently: things that carry no claim about capability — step
 *    ids, `order` numbering, a missing or misspelled `type`. Rewriting these
 *    cannot make the plan say it can do something it cannot.
 *  - REPORTED as an issue: anything about tool binding. A toolId that is not in
 *    the catalog, an action the tool does not have, a step that is both bound
 *    and unsupported, an unsupported step with no reason. These are sent back to
 *    the model verbatim; they are never patched over.
 */
function normalisePlan(
    raw: RawPlan,
    catalog: CatalogTool[],
    promptFallbackTitle: string
): { plan: WorkflowPlan; issues: string[] } {
    const index = indexCatalog(catalog);
    const issues: string[] = [];
    const usedIds = new Set<string>();

    const steps: PlanStep[] = raw.steps.map((rawStep, position) => {
        const where = `Step ${position + 1} ("${rawStep.label}")`;
        const toolId = text(rawStep.toolId);
        const toolAction = text(rawStep.toolAction);
        const unsupported = rawStep.unsupported === true;
        const unsupportedReason = text(rawStep.unsupportedReason);

        // ---- binding: reported, never patched ----
        let bound = false;
        if (toolId || toolAction) {
            if (!toolId) {
                issues.push(`${where} sets toolAction "${toolAction}" but no toolId.`);
            } else if (!toolAction) {
                issues.push(`${where} sets toolId "${toolId}" but no toolAction.`);
            } else if (!index.actionNamesByTool.has(toolId)) {
                issues.push(
                    `${where} binds toolId "${toolId}", which is not in the catalog. ` +
                    `The only valid tool ids are: ${index.toolIds.join(', ')}.`
                );
            } else if (!index.actions.has(`${toolId}.${toolAction}`)) {
                issues.push(
                    `${where} binds action "${toolAction}", which tool "${toolId}" does not have. ` +
                    `Valid actions for "${toolId}": ${(index.actionNamesByTool.get(toolId) ?? []).join(', ')}.`
                );
            } else {
                bound = true;
            }
        }

        if (unsupported && (toolId || toolAction)) {
            issues.push(
                `${where} is marked unsupported but also binds "${toolId ?? '?'}.${toolAction ?? '?'}". ` +
                'A step is either bound to a catalog action or unsupported, never both.'
            );
        }

        if (unsupported && !unsupportedReason) {
            issues.push(
                `${where} is marked unsupported but gives no unsupportedReason. ` +
                'The user has to be told what is missing.'
            );
        }

        // ---- type: derived when absent, reported when it contradicts ----
        const declaredType = normaliseStepType(rawStep.type);
        let type: PlanStepType =
            declaredType ?? (bound ? 'tool' : position === 0 ? 'trigger' : 'process');

        if (declaredType === 'tool' && !bound && !unsupported) {
            issues.push(
                `${where} has type "tool" but binds no toolId/toolAction and is not marked ` +
                'unsupported. Bind a catalog action or set "unsupported": true with a reason.'
            );
        }

        // A trigger starts the workflow; it never performs an external action.
        if (bound && type === 'trigger') type = 'tool';
        if (position === 0 && !bound && !unsupported) type = 'trigger';

        // ---- ids: normalised, because a collision would merge two nodes ----
        const base = slug(text(rawStep.id) ?? rawStep.label, `step_${position + 1}`);
        let id = base;
        for (let suffix = 2; usedIds.has(id); suffix += 1) {
            id = `${base}_${suffix}`;
        }
        usedIds.add(id);

        // External inputs come from the action's own schema as well as the
        // model's list, so a required user-supplied field cannot be forgotten.
        const declaredExternal = rawStep.externalInputs ?? [];
        const schemaExternal = bound
            ? (index.actions.get(`${toolId}.${toolAction}`)?.inputs ?? [])
                .filter(field => field.external)
                .map(field => field.name)
            : [];

        return {
            id,
            order: position + 1,
            type,
            label: rawStep.label.trim(),
            description: text(rawStep.description) ?? '',
            toolId: bound ? toolId! : null,
            toolAction: bound ? toolAction! : null,
            unsupported,
            unsupportedReason: unsupported ? unsupportedReason ?? null : null,
            inputs: unique(rawStep.inputs ?? []),
            outputs: unique(rawStep.outputs ?? []),
            externalInputs: unique([...declaredExternal, ...schemaExternal])
        };
    });

    const requiredTools = unique(steps.map(step => step.toolId ?? ''));

    const unsupportedCapabilities = unique(
        steps.filter(step => step.unsupported).map(step => step.unsupportedReason ?? '')
    );

    // What the planner actually chose — not what keyword matching suggested.
    // Score is a flat "selected" marker; a lexical score here would imply the
    // ranking made the decision, which is precisely what it no longer does.
    const capabilityMatches: CapabilityMatch[] = steps
        .filter(step => step.toolId && step.toolAction)
        .map(step => ({
            toolId: step.toolId!,
            toolName: index.toolNames.get(step.toolId!) ?? step.toolId!,
            actionName: step.toolAction!,
            score: 100,
            rationale: [`chosen by the planner for "${step.label}"`]
        }));

    return {
        plan: {
            title: text(raw.title) ?? promptFallbackTitle.slice(0, 80),
            description: text(raw.description) ?? '',
            estimatedTime: normaliseEstimate(raw.estimatedTime),
            steps,
            requiredTools,
            unsupportedCapabilities,
            capabilityMatches
        },
        issues
    };
}

// -------------------------------------------------------------- generation

/** One request plus one informed repair attempt. */
const MAX_PLAN_ATTEMPTS = 2;

/**
 * Plan a workflow for `prompt`.
 *
 * @throws PlanValidationError when the model cannot produce a catalog-valid plan.
 * @throws AiRequestError when the server or provider call fails.
 */
export async function generateWorkflowPlan(prompt: string, model?: string): Promise<WorkflowPlan> {
    const catalog = describeCatalog();

    // Weak lexical signal, passed as a hint the model is told it may ignore.
    // It is NOT consulted here and cannot influence the outcome on its own.
    const hints = rankToolMatches(prompt)
        .slice(0, 8)
        .map(match => ({ toolId: match.toolId, actionName: match.actionName, score: match.score }));

    let repairFeedback: string | undefined;
    let issues: string[] = ['the model returned no usable plan'];

    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
        const { plan: raw } = await requestPlan({ prompt, catalog, hints, model, repairFeedback });

        const parsed = rawPlanSchema.safeParse(unwrapPlan(raw));
        if (parsed.success) {
            const result = normalisePlan(parsed.data, catalog, prompt);
            if (result.issues.length === 0) return result.plan;
            issues = result.issues;
        } else {
            issues = parsed.error.issues.map(
                issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`
            );
        }

        repairFeedback = issues.join('\n');
    }

    throw new PlanValidationError(issues);
}

// ------------------------------------------------------------ graph building

const NODE_TYPE_FOR_STEP: Record<PlanStepType, NodeType> = {
    trigger: NodeType.TRIGGER,
    process: NodeType.AI_AGENT,
    decision: NodeType.LOGIC,
    tool: NodeType.TOOL,
    output: NodeType.OUTPUT
};

/**
 * Build a node's data from an already-validated plan step.
 *
 * Deterministic on purpose: no LLM call, no keyword matching, no second opinion.
 * The plan was validated against the catalog, so the only thing left to do is
 * read the bound action's schema. The previous implementation asked the model
 * again per node and ran the answer through another keyword ladder, which is how
 * a plan could say one thing and the canvas show another.
 */
export function buildNodeFromPlanStep(step: PlanStep): NodeData {
    const base = {
        label: step.label,
        description: step.description,
        type: NODE_TYPE_FOR_STEP[step.type]
    };

    // An unsupported step is a placeholder for a gap. It gets NO output keys, so
    // the executor cannot quietly hand it to an LLM and pretend it ran.
    if (step.unsupported) {
        return {
            ...base,
            unsupported: true,
            unsupportedReason:
                step.unsupportedReason ?? 'No connected tool provides this capability.',
            stateContract: { inputKeys: step.inputs, outputKeys: [] }
        };
    }

    if (step.toolId && step.toolAction) {
        const action = getTool(step.toolId)?.actions.find(a => a.name === step.toolAction);
        if (action) {
            return {
                ...base,
                type: NodeType.TOOL,
                toolId: step.toolId,
                toolAction: step.toolAction,
                // Surfaced for the UI. Enforcement stays in the registry, so a
                // saved workflow cannot opt out of an irreversible action's gate.
                requiresApproval: actionRequiresApproval(step.toolId, step.toolAction),
                stateContract: {
                    // The schema owns these keys, not the model's prose.
                    inputKeys: action.inputKeys,
                    outputKeys: action.outputKeys,
                    externalInputKeys: getExternalInputKeys(step.toolId, step.toolAction)
                }
            };
        }
    }

    return {
        ...base,
        stateContract: {
            inputKeys: step.inputs,
            outputKeys: step.outputs.length > 0 ? step.outputs : ['result']
        }
    };
}

/** Turn a validated plan into a linear graph. */
export function planToWorkflow(plan: WorkflowPlan): Workflow {
    const nodes: WorkflowNode[] = plan.steps.map((step, index) => ({
        id: step.id,
        type: NODE_TYPE_FOR_STEP[step.type],
        position: { x: 300 + index * 250, y: 0 },
        data: buildNodeFromPlanStep(step)
    }));

    const edges: WorkflowEdge[] = nodes.slice(1).map((node, index) => ({
        id: `edge_${nodes[index].id}_${node.id}`,
        source: nodes[index].id,
        target: node.id
    }));

    return { nodes, edges, initialState: {} };
}
