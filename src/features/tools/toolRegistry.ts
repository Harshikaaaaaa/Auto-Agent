import {
  Capability,
  FieldSchema,
  FieldSchemaMap,
  SideEffect,
  Tool,
  ToolAction,
  ToolActionDefinition,
  ToolDefinition,
  ToolStatus,
} from './types';

// ==================== TOOL REGISTRY ====================

const tools = new Map<string, Tool>();

/**
 * The field every action uses to report failure.
 *
 * Declared here and injected into every action's output schema rather than
 * copy-pasted into each connector, so it cannot be forgotten. The execution
 * engine reads ONLY this field to decide whether an action failed — see
 * `detectActionFailure`. Before Task 12 it sniffed `email_status` and `status`
 * for the substrings 'error' and 'failed', which reported Gmail's
 * "Authentication expired", "rate limit exceeded" and "was rejected by Gmail"
 * results as successful sends.
 */
export const ACTION_ERROR_KEY = 'error';

const ACTION_ERROR_FIELD: FieldSchema = {
  type: 'string',
  description:
    'Set to a human-readable reason when the action failed. Absent or empty means it succeeded.',
};

/**
 * Fill in the fields the registry owns.
 *
 * `inputKeys`/`outputKeys` are DERIVED from the schemas rather than declared
 * alongside them, so the two cannot drift apart. A connector that declares its
 * own key list has it overwritten, and that is intentional.
 *
 * The `error` output is added to every action here. A connector that declares its
 * own keeps that description.
 */
function normalizeAction(action: ToolActionDefinition): ToolAction {
  const outputSchema: FieldSchemaMap = {
    ...action.outputSchema,
    [ACTION_ERROR_KEY]: action.outputSchema[ACTION_ERROR_KEY] ?? ACTION_ERROR_FIELD,
  };

  return {
    ...action,
    outputSchema,
    inputKeys: Object.keys(action.inputSchema),
    outputKeys: Object.keys(outputSchema),
  };
}

/** Register a tool in the central registry */
export function registerTool(tool: ToolDefinition | Tool): void {
  const actions = tool.actions.map(normalizeAction);

  // A tool's capabilities are the union of what its actions can do, so the two
  // can never disagree.
  const capabilities = Array.from(
    new Set(actions.flatMap((action) => action.capabilities)),
  ) as Capability[];

  tools.set(tool.id, { ...tool, actions, capabilities } as Tool);
}

// ==================== SAFETY CLASSIFICATION ====================

/**
 * Whether an action must be approved by a human before it runs.
 *
 * An `irreversible` action ALWAYS requires approval — an email cannot be unsent
 * and a message cannot be unposted. This is deliberately not overridable by
 * workflow data: a saved workflow must not be able to opt out of the gate.
 *
 * This replaces a hardcoded list of tool ids in the execution hook, which went
 * stale the moment a connector was added.
 */
export function actionRequiresApproval(toolId?: string, actionName?: string): boolean {
  if (!toolId || !actionName) return false;
  const action = getTool(toolId)?.actions.find((a) => a.name === actionName);
  return action?.sideEffect === 'irreversible';
}

/** Side-effect class of an action, or undefined when it is not registered. */
export function getActionSideEffect(toolId?: string, actionName?: string): SideEffect | undefined {
  if (!toolId || !actionName) return undefined;
  return getTool(toolId)?.actions.find((a) => a.name === actionName)?.sideEffect;
}

/**
 * Every registered action that provides a capability, best first.
 *
 * Ordered by reliability then latency, so Task 12 can fall back to the next best
 * provider when one fails.
 */
export function findActionsByCapability(
  capability: Capability,
): Array<{ toolId: string; toolName: string; action: ToolAction }> {
  const matches: Array<{ toolId: string; toolName: string; action: ToolAction }> = [];

  for (const tool of getAllTools()) {
    for (const action of tool.actions) {
      if (action.capabilities.includes(capability)) {
        matches.push({ toolId: tool.id, toolName: tool.name, action });
      }
    }
  }

  return matches.sort((a, b) => {
    const aProfile = a.action.costProfile ?? getTool(a.toolId)?.costProfile;
    const bProfile = b.action.costProfile ?? getTool(b.toolId)?.costProfile;
    const reliability = (bProfile?.reliability ?? 0) - (aProfile?.reliability ?? 0);
    if (reliability !== 0) return reliability;
    return (aProfile?.latencyMs ?? 0) - (bProfile?.latencyMs ?? 0);
  });
}

/** Input fields the user must supply, which cannot come from upstream state. */
export function getExternalInputKeys(toolId?: string, actionName?: string): string[] {
  if (!toolId || !actionName) return [];
  const action = getTool(toolId)?.actions.find((a) => a.name === actionName);
  if (!action) return [];
  return Object.entries(action.inputSchema)
    .filter(([, schema]) => schema.external)
    .map(([key]) => key);
}

/** Get a tool by ID */
export function getTool(id: string): Tool | undefined {
  return tools.get(id);
}

/** Get all registered tools */
export function getAllTools(): Tool[] {
  return Array.from(tools.values());
}

/** Get only authenticated tools */
export function getAuthenticatedTools(): Tool[] {
  return getAllTools().filter((t) => t.isAuthenticated());
}

export interface ReusableToolTemplate {
  id: string;
  toolId: string;
  toolName: string;
  toolAction: string;
  label: string;
  description: string;
  inputKeys: string[];
  outputKeys: string[];
  score: number;
}

export interface CapabilityMatch {
  toolId: string;
  toolName: string;
  actionName: string;
  score: number;
  rationale: string[];
}

/** One input field as sent to the planner. */
export interface CatalogField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  /** Must be supplied by the user; cannot come from an earlier step. */
  external: boolean;
  format?: string;
  enum?: readonly string[];
}

/** One action as sent to the planner. */
export interface CatalogAction {
  name: string;
  description: string;
  capabilities: readonly Capability[];
  sideEffect: SideEffect;
  requiresAuth: boolean;
  requiresApproval: boolean;
  inputs: CatalogField[];
  outputs: CatalogField[];
  /** Kept for consumers that only need the flat key lists. */
  inputKeys: string[];
  outputKeys: string[];
}

/** One tool as sent to the planner. */
export interface CatalogTool {
  id: string;
  name: string;
  description: string;
  category: string;
  capabilities: readonly Capability[];
  authenticated: boolean;
  actions: CatalogAction[];
}

function describeFields(schema: Record<string, import('./types').FieldSchema>): CatalogField[] {
  return Object.entries(schema).map(([name, field]) => ({
    name,
    type: field.type,
    description: field.description,
    required: Boolean(field.required),
    external: Boolean(field.external),
    ...(field.format ? { format: field.format } : {}),
    ...(field.enum ? { enum: field.enum } : {}),
  }));
}

/**
 * Compact, serialisable description of every registered tool.
 *
 * This is what the planner sends to the model, and it is the ONLY source of truth
 * the model may bind a step to. If a capability is absent here, the planner marks
 * the step unsupported rather than substituting a different tool.
 *
 * Cost/latency/reliability hints are deliberately NOT included: they exist for
 * routing decisions the server makes, and spending prompt tokens on them would
 * invite the model to optimise for the wrong thing.
 */
export function describeCatalog(): CatalogTool[] {
  return getAllTools().map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    capabilities: tool.capabilities ?? [],
    authenticated: tool.isAuthenticated(),
    actions: tool.actions.map((action) => ({
      name: action.name,
      description: action.description,
      capabilities: action.capabilities,
      sideEffect: action.sideEffect,
      requiresAuth: action.requiresAuth,
      requiresApproval: action.sideEffect === 'irreversible',
      inputs: describeFields(action.inputSchema),
      outputs: describeFields(action.outputSchema),
      inputKeys: action.inputKeys,
      outputKeys: action.outputKeys,
    })),
  }));
}

/** Every capability provided by at least one registered action. */
export function getAvailableCapabilities(): Capability[] {
  return Array.from(
    new Set(getAllTools().flatMap((tool) => tool.actions.flatMap((a) => a.capabilities))),
  ).sort();
}

export function getToolCapabilityMatches(searchText: string): CapabilityMatch[] {
  return rankToolMatches(searchText);
}

/** Normalize text to compare prompts against tool/action names reliably. */
function normalizeToolText(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds the best matching built-in tool action based on the user prompt or node text. */
export function findReusableToolTemplate(searchText: string): ReusableToolTemplate | null {
  const matches = rankToolMatches(searchText);
  if (matches.length === 0) return null;

  const best = matches[0];
  const tool = getTool(best.toolId);
  const action = tool?.actions.find((a) => a.name === best.actionName);
  if (!tool || !action) return null;

  return {
    id: `${tool.id}_${action.name}`,
    toolId: tool.id,
    toolName: tool.name,
    toolAction: action.name,
    label: `${tool.name}: ${action.name.replace(/_/g, ' ')}`,
    description: action.description,
    inputKeys: action.inputKeys,
    outputKeys: action.outputKeys,
    score: best.score,
  };
}

/** Rank built-in tools and actions for a given prompt using semantic capability matching. */
export function rankToolMatches(searchText: string): CapabilityMatch[] {
  const normalized = normalizeToolText(searchText);
  if (!normalized) return [];

  const candidates: CapabilityMatch[] = [];

  for (const tool of getAllTools()) {
    const toolVariants = [tool.name, tool.id, tool.description, ...(tool.capabilities || [])]
      .map(normalizeToolText)
      .filter(Boolean);

    for (const action of tool.actions) {
      const actionVariants = [
        action.name,
        action.name.replace(/_/g, ' '),
        action.description,
        ...(action.capabilities || []),
        `${tool.name} ${action.name}`,
        `${tool.name} ${action.name.replace(/_/g, ' ')}`,
      ]
        .map(normalizeToolText)
        .filter(Boolean);

      let score = 0;
      const rationale: string[] = [];

      for (const variant of [...toolVariants, ...actionVariants]) {
        if (!variant) continue;

        if (normalized.includes(variant)) {
          score += 12;
          rationale.push(`matches ${variant}`);
        }

        if (variant.split(' ').every((word) => normalized.includes(word))) {
          score += 6;
          rationale.push(`contains key words from ${variant}`);
        }

        if (
          normalized.includes(tool.name.toLowerCase()) ||
          normalized.includes(action.name.replace(/_/g, ' ').toLowerCase())
        ) {
          score += 5;
        }
      }

      if (tool.capabilities?.some((cap) => normalized.includes(normalizeToolText(cap)))) {
        score += 8;
      }

      if (action.capabilities?.some((cap) => normalized.includes(normalizeToolText(cap)))) {
        score += 10;
      }

      if (score > 0) {
        candidates.push({
          toolId: tool.id,
          toolName: tool.name,
          actionName: action.name,
          score,
          rationale: [...new Set(rationale)],
        });
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 10);
}

/** Get status summary for all tools (used by UI) */
export function getToolStatuses(): ToolStatus[] {
  return getAllTools().map((t) => ({
    id: t.id,
    name: t.name,
    icon: t.icon,
    color: t.color,
    category: t.category,
    authenticated: t.isAuthenticated(),
    capabilities: t.capabilities ?? [],
    actions: t.actions.map((a) => ({
      name: a.name,
      description: a.description,
      sideEffect: a.sideEffect,
      requiresAuth: a.requiresAuth,
      capabilities: a.capabilities,
      // Surfaced so the UI can show which steps will pause for approval.
      requiresApproval: a.sideEffect === 'irreversible',
    })),
  }));
}

// ==================== CONNECTION STATE ====================

/**
 * Which tools the SERVER says are connected.
 *
 * There is no token here, and no localStorage. Until Task 13 this module owned a
 * `tool_auth_<id>` localStorage store holding raw Google access tokens in plain
 * text, a GIS silent-refresh helper, and a five-minute `setInterval` that
 * re-requested consent in the background. All of it is gone: the server holds the
 * credential, refreshes it with a refresh token, and exposes only the fact of a
 * connection.
 *
 * A cached snapshot is kept because `Tool.isAuthenticated()` is synchronous and is
 * called from `describeCatalog()` and `getToolStatuses()` during render. It is
 * refreshed by `useTools` from `/api/oauth/connections`; a stale snapshot only
 * ever means the UI shows a connect prompt a moment late, because the server
 * checks the credential again on every call it makes.
 */
const connectedToolIds = new Set<string>();

/** Replace the snapshot. Called with the server's answer, nothing else. */
export function setConnectedTools(toolIds: readonly string[]): void {
  connectedToolIds.clear();
  for (const id of toolIds) connectedToolIds.add(id);
}

/** Whether the server reported this tool as connected. */
export function isToolConnected(toolId: string): boolean {
  return connectedToolIds.has(toolId);
}

/** For tests, and for sign-out. */
export function clearConnectedTools(): void {
  connectedToolIds.clear();
}
