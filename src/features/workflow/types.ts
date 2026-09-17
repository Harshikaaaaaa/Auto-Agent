import { NodeType } from '@/shared/types';

// ==================== GRAPH STATE ====================

/** The shared state object that flows through the entire graph */
export interface GraphState {
    [key: string]: any;
    __metadata: GraphMetadata;
}

export interface GraphMetadata {
    runId: string;
    startedAt: string;
    currentNodeId: string | null;
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
    error?: string;
}

/** Declares which state keys a node reads and writes */
export interface NodeStateContract {
    inputKeys: string[];
    outputKeys: string[];
    reducer?: 'overwrite' | 'append' | 'merge';
}

// ==================== CONDITIONAL ROUTING ====================

/**
 * Configuration for a router (logic) node.
 * The node evaluates `stateKey` from the graph state and
 * routes to one of the named output ports.
 */
export interface RouterNodeConfig {
    /** The state key whose value determines the route */
    stateKey: string;
    /** Map of value → target node id */
    routes: Record<string, string>;
    /** Default target node id when no route matches */
    defaultRoute?: string;
}

// ==================== NODE & EDGE ====================

export interface NodeData {
    label: string;
    type: NodeType;
    description?: string;
    icon?: string;
    color?: string;
    stateContract?: NodeStateContract;
    // Tool integration
    toolId?: string;        // references a tool from the central registry
    toolAction?: string;    // specific action to invoke (e.g. 'send_email')
    // Router configuration (for logic/router nodes)
    routerConfig?: RouterNodeConfig;
    // Debugging
    breakpoint?: 'before' | 'after' | 'both';
    // Runtime state
    isRunning?: boolean;
    lastSuccess?: boolean;
    output?: string;
    // Runtime safety gates
    requiresApproval?: boolean;
    approvalMessage?: string;
    // Other dynamic fields (e.g. initialState, configuredRecipient)
    [key: string]: any;
}

export interface WorkflowNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: NodeData;
}

export interface WorkflowEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    /** Condition expression evaluated against graph state (e.g. "sentiment === 'positive'") */
    condition?: string;
}

// ==================== WORKFLOW ====================

export interface Workflow {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    initialState?: Record<string, any>;
}

// ==================== EXECUTION ====================

export interface ExecutionLog {
    node: string;
    time: string;
    output: string;
    status?: 'running' | 'completed' | 'failed' | 'retrying';
    stateSnapshot?: Record<string, any>;
    /** Duration in milliseconds */
    durationMs?: number;
}
