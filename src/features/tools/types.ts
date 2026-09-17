// ==================== TOOL SYSTEM TYPES ====================

/**
 * Capability taxonomy.
 *
 * A capability is *what* a step needs done, independent of *which* tool does it.
 * This is what lets the planner ask "is there anything that can send an email?"
 * and answer honestly, and what lets Task 12 route to an alternative when one
 * provider fails.
 *
 * Adding a value here is deliberate: if a request needs a capability that is not
 * in this list and not provided by any registered action, the planner must mark
 * the step unsupported rather than substituting something else.
 */
export const CAPABILITIES = [
    // Messaging
    'email.send',
    'email.read',
    'chat.send',
    'chat.read',
    // Spreadsheets
    'spreadsheet.read',
    'spreadsheet.write',
    // Files and storage
    'file.list',
    'file.upload',
    'file.download',
    // Web and content (implemented in Task 7)
    'web.fetch',
    'content.extract',
    'content.format',
    'file.deliver',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * How much damage an action can do.
 *
 * - `read`         observes only; safe to retry, safe to run unattended
 * - `write`        changes data that can be corrected afterwards
 * - `irreversible` cannot be undone once it happens (an email is sent, a message
 *                  is posted). These ALWAYS require human approval — see
 *                  `actionRequiresApproval` in the registry.
 */
export type SideEffect = 'read' | 'write' | 'irreversible';

/** Description of one input or output field. */
export interface FieldSchema {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description: string;
    /** The action cannot run without this value. */
    required?: boolean;
    /**
     * The value has to come from the user, not from upstream workflow state.
     * A spreadsheet id or a target URL is external; a summary produced by an
     * earlier step is not. Pre-run validation collects these.
     */
    external?: boolean;
    /** Narrows a string field, so the planner and UI can validate it. */
    format?: 'email' | 'url' | 'phone' | 'date-time' | 'markdown' | 'html' | 'mime-type';
    /** Permitted values for a string field. */
    enum?: readonly string[];
    /** Element shape, when `type` is 'array'. */
    items?: Omit<FieldSchema, 'required' | 'external'>;
}

/** Field name to schema. */
export type FieldSchemaMap = Record<string, FieldSchema>;

/**
 * Rough operational hints, used for capability routing rather than billing.
 * Deliberately coarse: precise numbers would be fiction.
 */
export interface CostProfile {
    /** Typical wall-clock time for one call, in milliseconds. */
    latencyMs: number;
    /** 0 (free) to 10 (expensive). */
    cost: number;
    /** 0 (flaky) to 10 (dependable). */
    reliability: number;
}

/** A single action a tool can perform inside a workflow node. */
export interface ToolAction {
    name: string; // e.g. 'send_email'
    description: string;

    /** What this action can do, from the shared taxonomy. */
    capabilities: readonly Capability[];

    /** How dangerous this action is. Drives the approval gate. */
    sideEffect: SideEffect;

    /** Whether the tool must be connected before this action can run. */
    requiresAuth: boolean;

    /** Declared inputs. This is the source of truth for `inputKeys`. */
    inputSchema: FieldSchemaMap;
    /** Declared outputs. This is the source of truth for `outputKeys`. */
    outputSchema: FieldSchemaMap;

    /**
     * State keys this action reads / writes.
     *
     * DERIVED from the schemas by `registerTool`, so the two can never disagree.
     * Do not set these by hand.
     */
    inputKeys: string[];
    outputKeys: string[];

    /** Operational hints for routing. Falls back to the tool's profile. */
    costProfile?: CostProfile;

    execute: (input: Record<string, any>) => Promise<Record<string, any>>;
}

/**
 * An action as authored in a connector: the derived key lists are filled in by
 * `registerTool`, so a connector only declares the schemas.
 */
export type ToolActionDefinition = Omit<ToolAction, 'inputKeys' | 'outputKeys'> &
    Partial<Pick<ToolAction, 'inputKeys' | 'outputKeys'>>;

/** A registered tool/connector (e.g. Gmail, Slack, Sheets). */
export interface Tool {
    id: string;
    name: string;
    description: string;
    icon: string;                   // lucide-react icon name
    color: string;                  // hex color for UI
    category: string;               // e.g. communication, storage, spreadsheet
    /** Union of its actions' capabilities. Derived by `registerTool`. */
    capabilities?: readonly Capability[];
    scopes: string[];               // OAuth scopes required
    actions: ToolAction[];
    /** Default operational hints for actions that do not specify their own. */
    costProfile?: CostProfile;
    isAuthenticated: () => boolean;
    authenticate: () => Promise<void>;
    disconnect: () => void;
}

/** A tool as authored in a connector, before the registry derives fields. */
export type ToolDefinition = Omit<Tool, 'actions' | 'capabilities'> & {
    actions: ToolActionDefinition[];
    capabilities?: readonly Capability[];
};

/** Persisted OAuth token for a tool */
export interface ToolAuth {
    toolId: string;
    accessToken: string;
    expiresAt: number;              // epoch ms
    scopes: string[];
}

/** Tool status for UI display */
export interface ToolStatus {
    id: string;
    name: string;
    icon: string;
    color: string;
    category: string;
    authenticated: boolean;
    capabilities: readonly Capability[];
    actions: {
        name: string;
        description: string;
        sideEffect: SideEffect;
        requiresAuth: boolean;
        capabilities: readonly Capability[];
        requiresApproval: boolean;
    }[];
}
