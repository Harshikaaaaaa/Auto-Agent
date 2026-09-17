import type { Edge, Node } from 'reactflow';
import { NodeType } from '@/shared/types';

// ==================== REACT FLOW BRIDGE TYPES ====================

/**
 * A React Flow edge carrying AutoAgent's conditional-routing expression.
 *
 * React Flow's own `Edge` has no `condition` field, so every place that reads
 * routing conditions must use this type. The expression is evaluated by the
 * safe evaluator (never `new Function`) — see `safeExpression.ts`.
 */
export type FlowEdge = Edge & { condition?: string };

/** A React Flow node whose data payload is an AutoAgent `NodeData`. */
export type FlowNode = Node<NodeData>;

/**
 * A reusable workflow block offered in the node palette.
 *
 * Tool-backed templates carry `toolId`/`toolAction`; helper/logic templates
 * carry only a state contract. Both shapes live in one array in the UI, so the
 * fields that only one variant uses are optional.
 */
export interface ReusableNodeTemplate {
    id?: string;
    label: string;
    description: string;
    nodeType: NodeType;
    toolId?: string;
    toolName?: string;
    toolAction?: string;
    inputKeys?: string[];
    outputKeys?: string[];
    stateContract?: NodeStateContract;
}

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
