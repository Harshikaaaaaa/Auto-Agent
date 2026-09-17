import { useState, useCallback, useRef } from 'react';
import { Node, Edge } from 'reactflow';
import { ExecutionLog, GraphState } from '@features/workflow/types';
import { executeNodeAction } from '@features/ai/services/aiService';
import { WorkflowContextBuffer } from '@features/ai/types';
import { getTool } from '@features/tools/toolRegistry';
import '@features/tools/connectors'; // ensure all tools are registered

const EXECUTION_CHECKPOINT_KEY = 'autoagent_runtime_checkpoint';

type RuntimeExecutionCheckpoint = {
    runId: string;
    status: 'running' | 'paused' | 'failed' | 'completed';
    currentNodeId: string | null;
    completedNodeIds: string[];
    executedSignatures: string[];
    graphState: GraphState;
    startedAt: string;
    lastUpdatedAt: string;
    nodesSnapshot: Array<{ id: string; label: string; type?: string }>;
    edgesSnapshot: Array<{ id: string; source: string; target: string; condition?: string }>;
};

function saveRuntimeCheckpoint(checkpoint: RuntimeExecutionCheckpoint) {
    try {
        localStorage.setItem(EXECUTION_CHECKPOINT_KEY, JSON.stringify(checkpoint));
    } catch (err) {
        console.warn('[WorkflowExecution] Failed to persist checkpoint:', err);
    }
}

function loadRuntimeCheckpoint(): RuntimeExecutionCheckpoint | null {
    try {
        const raw = localStorage.getItem(EXECUTION_CHECKPOINT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as RuntimeExecutionCheckpoint;
        if (!parsed || !parsed.graphState || !parsed.runId) return null;
        return parsed;
    } catch (err) {
        console.warn('[WorkflowExecution] Failed to restore checkpoint:', err);
        return null;
    }
}

function clearRuntimeCheckpoint() {
    try {
        localStorage.removeItem(EXECUTION_CHECKPOINT_KEY);
    } catch (err) {
        console.warn('[WorkflowExecution] Failed to clear checkpoint:', err);
    }
}

/**
 * Safely evaluates a condition expression against graph state.
 * Supports simple expressions like "sentiment === 'positive'" or "score > 50".
 * Returns true if no condition is specified (unconditional edge).
 */
function evaluateCondition(condition: string | undefined, state: Record<string, any>): boolean {
    if (!condition || condition.trim() === '') return true;

    try {
        // Build a safe evaluation context with only state keys
        const { __metadata, ...cleanState } = state;
        const keys = Object.keys(cleanState);
        const values = keys.map(k => cleanState[k]);

        // Create a function that has state keys as parameters
        // eslint-disable-next-line no-new-func
        const fn = new Function(...keys, `"use strict"; return (${condition});`);
        return Boolean(fn(...values));
    } catch (err) {
        console.warn(`[Condition] Failed to evaluate "${condition}":`, err);
        return false;
    }
}

/**
 * Merges a node's output into the graph state using the specified reducer strategy.
 */
function mergeIntoState(
    state: GraphState,
    output: Record<string, any>,
    reducer: 'overwrite' | 'append' | 'merge' = 'overwrite'
): GraphState {
    const newState = { ...state };

    for (const [key, value] of Object.entries(output)) {
        if (key === '__metadata') continue; // protect metadata

        switch (reducer) {
            case 'append':
                const existing = newState[key];
                newState[key] = Array.isArray(existing)
                    ? [...existing, value]
                    : existing !== undefined
                        ? [existing, value]
                        : [value];
                break;

            case 'merge':
                if (typeof newState[key] === 'object' && typeof value === 'object' && !Array.isArray(value)) {
                    newState[key] = { ...newState[key], ...value };
                } else {
                    newState[key] = value;
                }
                break;

            case 'overwrite':
            default:
                newState[key] = value;
                break;
        }
    }

    return newState;
}

export const useWorkflowExecution = (
    nodes: Node[],
    edges: Edge[],
    setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void,
    onApprovalRequired?: (payload: { nodeId: string; nodeLabel: string; message: string }) => Promise<boolean>
) => {
    const [isExecuting, setIsExecuting] = useState(false);
    const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);
    const [graphState, setGraphState] = useState<GraphState | null>(null);
    const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
    const [currentNodeLabel, setCurrentNodeLabel] = useState<string | null>(null);
    const [runtimeStatus, setRuntimeStatus] = useState<'idle' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed'>('idle');
    const executionControlRef = useRef({
        pauseRequested: false,
        cancelRequested: false,
        retryCounts: {} as Record<string, number>,
        executedSignatures: new Set<string>()
    });

    const pauseExecution = useCallback(() => {
        executionControlRef.current.pauseRequested = true;
        setRuntimeStatus('paused');
    }, []);

    const resumeExecution = useCallback(() => {
        executionControlRef.current.pauseRequested = false;
        setRuntimeStatus('running');
    }, []);

    const cancelExecution = useCallback(() => {
        executionControlRef.current.cancelRequested = true;
        setRuntimeStatus('cancelled');
    }, []);

    const executeFlow = useCallback(async () => {
        if (nodes.length === 0) return;

        const restoredCheckpoint = loadRuntimeCheckpoint();
        const canResume = restoredCheckpoint && restoredCheckpoint.status !== 'completed' && restoredCheckpoint.status !== 'failed';
        const restoredCompleted = new Set(canResume ? (restoredCheckpoint.completedNodeIds || []) : []);

        executionControlRef.current = {
            pauseRequested: false,
            cancelRequested: false,
            retryCounts: {},
            executedSignatures: new Set<string>()
        };

        if (restoredCheckpoint?.executedSignatures?.length) {
            restoredCheckpoint.executedSignatures.forEach(sig => executionControlRef.current.executedSignatures.add(sig));
        }
        setRuntimeStatus('running');
        setIsExecuting(true);
        setExecutionLogs([]);

        // Initialize GraphState
        // Check if the workflow provided initialState via the first node's data
        const initialData: Record<string, any> = {};

        // Gather any initialState from nodes (stored during generation)
        nodes.forEach(n => {
            if (n.data.initialState) {
                Object.assign(initialData, n.data.initialState);
            }
        });

        let state: GraphState = canResume && restoredCheckpoint
            ? restoredCheckpoint.graphState
            : {
                ...initialData,
                __metadata: {
                    runId: crypto.randomUUID(),
                    startedAt: new Date().toISOString(),
                    currentNodeId: null,
                    status: 'running'
                }
            };

        setGraphState(state);

        // ── Build the context buffer for cross-node memory ──
        // Extract the original user prompt from initialState (stored during generation)
        const originalPrompt = (initialData as any).user_request
            || (initialData as any).userRequest
            || (initialData as any).prompt
            || (initialData as any).request
            || '';

        const contextBuffer: WorkflowContextBuffer = {
            originalPrompt,
            fullGraphState: { ...state },
            executionHistory: []
        };
        // ─────────────────────────────────────────────────────

        const visited = new Set<string>();

        // Topological sort using Kahn's algorithm
        const inDegree = new Map<string, number>();
        nodes.forEach(n => inDegree.set(n.id, 0));
        edges.forEach(e => inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1));

        const queue = nodes
            .filter(n => (inDegree.get(n.id) || 0) === 0)
            .map(n => n.id)
            .filter(n => !restoredCompleted.has(n));

        while (queue.length > 0) {
            if (executionControlRef.current.cancelRequested) {
                setRuntimeStatus('cancelled');
                setIsExecuting(false);
                return;
            }

            while (executionControlRef.current.pauseRequested) {
                setRuntimeStatus('paused');
                await new Promise(resolve => setTimeout(resolve, 200));
                if (executionControlRef.current.cancelRequested) {
                    setRuntimeStatus('cancelled');
                    setIsExecuting(false);
                    return;
                }
            }

            const nodeId = queue.shift()!;
            if (visited.has(nodeId)) continue;
            visited.add(nodeId);

            const node = nodes.find(n => n.id === nodeId);
            if (!node) continue;

            // Update metadata
            state = {
                ...state,
                __metadata: { ...state.__metadata, currentNodeId: nodeId }
            };
            setCurrentNodeId(nodeId);
            setCurrentNodeLabel(node.data.label || nodeId);

            // Mark running
            setNodes(nds => nds.map(n =>
                n.id === nodeId
                    ? { ...n, data: { ...n.data, isRunning: true } }
                    : n
            ));

            const stateContract = node.data.stateContract || { inputKeys: [], outputKeys: [] };
            const reducer = stateContract.reducer || 'overwrite';

            // Safely get inputKeys and outputKeys with fallbacks
            const inputKeys = stateContract.inputKeys || [];
            const outputKeys = stateContract.outputKeys || [];

            // Extract input slice from state (only the keys this node reads)
            const inputState: Record<string, any> = {};
            for (const key of inputKeys) {
                if (state[key] !== undefined) {
                    inputState[key] = state[key];
                }
            }

            const nodeStartTime = performance.now();

            try {
                let nodeOutput: Record<string, any>;

                const requiresApproval = Boolean(node.data.requiresApproval) || (
                    Boolean(node.data.toolId) && ['gmail', 'slack', 'whatsapp', 'google_sheets', 'google_drive'].includes(node.data.toolId)
                );

                const signature = JSON.stringify({
                    nodeId: node.id,
                    label: node.data.label,
                    toolId: node.data.toolId,
                    toolAction: node.data.toolAction,
                    input: inputState,
                    stateKeySnapshot: Object.keys(state).sort()
                });

                if (executionControlRef.current.executedSignatures.has(signature)) {
                    console.warn(`[Execution] Skipping duplicate node execution for ${node.data.label || node.id}`);
                    nodeOutput = { status: 'skipped', skipped: true, nodeId: node.id, reason: 'Duplicate execution prevented' };
                    state = mergeIntoState(state, nodeOutput, reducer);
                    setGraphState({ ...state });
                    continue;
                }

                if (requiresApproval && onApprovalRequired) {
                    const approved = await onApprovalRequired({
                        nodeId: node.id,
                        nodeLabel: node.data.label || node.id,
                        message: node.data.approvalMessage || `Approve this risky action before continuing: ${node.data.label || 'Workflow step'}`
                    });

                    if (!approved) {
                        state = {
                            ...state,
                            __metadata: { ...state.__metadata, status: 'paused', currentNodeId: nodeId }
                        };
                        setGraphState({ ...state });
                        setRuntimeStatus('paused');
                        setIsExecuting(false);
                        return;
                    }
                }

                // Check if this node is bound to a tool action
                const { toolId, toolAction } = node.data;
                if (toolId && toolAction) {
                    const tool = getTool(toolId);
                    if (!tool) throw new Error(`Tool "${toolId}" not found in registry.`);
                    if (!tool.isAuthenticated()) throw new Error(`Tool "${toolId}" is not authenticated. Connect it first.`);

                    const action = tool.actions.find(a => a.name === toolAction);
                    if (!action) throw new Error(`Action "${toolAction}" not found on tool "${toolId}".`);

                    // Build input: start with stateContract keys, then apply node-specific configured fields,
                    // then fill remaining action keys from the graph state.
                    const mergedInput: Record<string, any> = { ...inputState };

                    const reservedNodeKeys = new Set([
                        'label', 'description', 'icon', 'color', 'type', 'toolId', 'toolAction',
                        'stateContract', 'routerConfig', 'breakpoint', 'isRunning', 'lastSuccess',
                        'output', 'initialState'
                    ]);

                    for (const [key, value] of Object.entries(node.data || {})) {
                        if (!reservedNodeKeys.has(key) && value !== undefined) {
                            mergedInput[key] = value;
                        }
                    }

                    if (node.data.initialState && typeof node.data.initialState === 'object') {
                        for (const [key, value] of Object.entries(node.data.initialState)) {
                            if (value !== undefined) {
                                mergedInput[key] = value;
                            }
                        }
                    }

                    for (const key of action.inputKeys) {
                        if (mergedInput[key] === undefined && state[key] !== undefined) {
                            mergedInput[key] = state[key];
                        }
                    }

                    if (node.data.configuredRecipient) {
                        mergedInput.to = node.data.configuredRecipient;
                    }

                    nodeOutput = await action.execute(mergedInput);
                } else if (node.data.initialState) {
                    // Node has initialState — use it directly as output
                    nodeOutput = {};
                    for (const key of outputKeys) {
                        if (node.data.initialState[key] !== undefined) {
                            nodeOutput[key] = node.data.initialState[key];
                        }
                    }
                } else if (outputKeys.length > 0) {
                    // No tool binding and no initialState — call Gemini AI to process this node
                    // Pass the context buffer so AI has full workflow awareness
                    nodeOutput = await executeNodeAction(
                        node.data.label,
                        node.data.description || "",
                        inputState,
                        outputKeys,
                        contextBuffer
                    );
                } else {
                    // Node with no output keys is a passthrough
                    nodeOutput = {};
                }

                // Merge output into graph state
                state = mergeIntoState(state, nodeOutput, reducer);
                restoredCompleted.add(nodeId);
                executionControlRef.current.executedSignatures.add(signature);
                setGraphState({ ...state });
                saveRuntimeCheckpoint({
                    runId: state.__metadata.runId,
                    status: 'running',
                    currentNodeId: nodeId,
                    completedNodeIds: Array.from(restoredCompleted),
                    executedSignatures: Array.from(executionControlRef.current.executedSignatures),
                    graphState: { ...state },
                    startedAt: state.__metadata.startedAt,
                    lastUpdatedAt: new Date().toISOString(),
                    nodesSnapshot: nodes.map(n => ({ id: n.id, label: n.data.label || n.id, type: n.type })),
                    edgesSnapshot: edges.map(e => ({ id: e.id, source: e.source, target: e.target, condition: e.condition }))
                });

                // Update context buffer with this node's output
                contextBuffer.fullGraphState = { ...state };
                contextBuffer.executionHistory.push({
                    nodeLabel: node.data.label,
                    outputKeys: outputKeys,
                    outputSummary: JSON.stringify(nodeOutput, null, 2)
                });

                // Build human-readable output for logs
                const outputSummary = JSON.stringify(nodeOutput, null, 2);
                const nodeDurationMs = Math.round(performance.now() - nodeStartTime);

                // Create state snapshot (exclude metadata for readability)
                const { __metadata, ...stateWithoutMeta } = state;
                const stateSnapshot = { ...stateWithoutMeta };

                setExecutionLogs(prev => [...prev, {
                    node: node.data.label,
                    time: new Date().toLocaleTimeString(),
                    output: outputSummary,
                    status: 'completed',
                    stateSnapshot,
                    durationMs: nodeDurationMs
                }]);

                // Check if this was a tool action that failed
                // Tool actions often return error status in specific output keys
                const isToolFailure = node.data.toolId && (
                    (nodeOutput.email_status && String(nodeOutput.email_status).toLowerCase().includes('error')) ||
                    (nodeOutput.email_status && String(nodeOutput.email_status).toLowerCase().includes('validation failed')) ||
                    (nodeOutput.status && String(nodeOutput.status).toLowerCase().includes('error')) ||
                    (nodeOutput.status && String(nodeOutput.status).toLowerCase().includes('failed'))
                );

                if (isToolFailure) {
                    console.error('[WORKFLOW] Tool action failed:', nodeOutput);
                    throw new Error(`Tool action failed: ${nodeOutput.email_status || nodeOutput.status || 'Unknown error'}`);
                }

                setNodes(nds => nds.map(n =>
                    n.id === nodeId
                        ? { ...n, data: { ...n.data, isRunning: false, lastSuccess: true, output: outputSummary } }
                        : n
                ));
            } catch (err) {
                const retryCount = executionControlRef.current.retryCounts[nodeId] || 0;
                const maxRetries = 2;

                if (retryCount < maxRetries && !(err instanceof Error && (err.message.includes('not authenticated') || err.message.includes('connect it first')))) {
                    executionControlRef.current.retryCounts[nodeId] = retryCount + 1;
                    visited.delete(nodeId);
                    queue.unshift(nodeId);

                    setExecutionLogs(prev => [...prev, {
                        node: node.data.label,
                        time: new Date().toLocaleTimeString(),
                        output: `Retrying node after failure (${retryCount + 1}/${maxRetries}) — ${String(err)}`,
                        status: 'retrying',
                        stateSnapshot: { ...state }
                    }]);

                    setNodes(nds => nds.map(n =>
                        n.id === nodeId
                            ? { ...n, data: { ...n.data, isRunning: false, lastSuccess: false } }
                            : n
                    ));
                    continue;
                }

                console.error(`Error executing node ${nodeId}:`, err);
                setExecutionLogs(prev => [...prev, {
                    node: node.data.label,
                    time: new Date().toLocaleTimeString(),
                    output: String(err),
                    status: 'failed',
                    stateSnapshot: { ...state }
                }]);
                state = {
                    ...state,
                    __metadata: { ...state.__metadata, status: 'failed', error: String(err) }
                };
                setGraphState({ ...state });
                setRuntimeStatus('failed');
                saveRuntimeCheckpoint({
                    runId: state.__metadata.runId,
                    status: 'failed',
                    currentNodeId: nodeId,
                    completedNodeIds: Array.from(restoredCompleted),
                    executedSignatures: Array.from(executionControlRef.current.executedSignatures),
                    graphState: { ...state },
                    startedAt: state.__metadata.startedAt,
                    lastUpdatedAt: new Date().toISOString(),
                    nodesSnapshot: nodes.map(n => ({ id: n.id, label: n.data.label || n.id, type: n.type })),
                    edgesSnapshot: edges.map(e => ({ id: e.id, source: e.source, target: e.target, condition: e.condition }))
                });

                setNodes(nds => nds.map(n =>
                    n.id === nodeId
                        ? { ...n, data: { ...n.data, isRunning: false, lastSuccess: false } }
                        : n
                ));
                setIsExecuting(false);
                return;
            }

            // Determine which outgoing edges to follow.
            // For logic/router nodes, evaluate edge conditions against current state.
            // For normal nodes, all outgoing edges are followed.
            const outgoingEdges = edges.filter(e => e.source === nodeId) as (Edge & { condition?: string })[];
            const hasConditions = outgoingEdges.some(e => e.condition);

            let activeChildren: string[];
            if (hasConditions) {
                // Only follow edges whose condition evaluates to true
                activeChildren = outgoingEdges
                    .filter(e => evaluateCondition(e.condition, state))
                    .map(e => e.target);

                // If no condition matched and node has a routerConfig with defaultRoute, use it
                if (activeChildren.length === 0 && node.data.routerConfig?.defaultRoute) {
                    activeChildren = [node.data.routerConfig.defaultRoute];
                }

                console.log(`[Router] Node "${node.data.label}" routed to: ${activeChildren.join(', ') || '(no match)'}`);
            } else {
                activeChildren = outgoingEdges.map(e => e.target);
            }

            // Decrement in-degree for active children; enqueue when all parents done
            for (const childId of activeChildren) {
                const newDegree = (inDegree.get(childId) || 1) - 1;
                inDegree.set(childId, newDegree);
                if (newDegree === 0) {
                    queue.push(childId);
                }
            }
        }

        // Only mark 'completed' if no node error set it to 'failed'
        if (executionControlRef.current.cancelRequested) {
            state = {
                ...state,
                __metadata: { ...state.__metadata, currentNodeId: null, status: 'paused' }
            };
            setRuntimeStatus('cancelled');
            saveRuntimeCheckpoint({
                runId: state.__metadata.runId,
                status: 'paused',
                currentNodeId: null,
                completedNodeIds: Array.from(restoredCompleted),
                executedSignatures: Array.from(executionControlRef.current.executedSignatures),
                graphState: { ...state },
                startedAt: state.__metadata.startedAt,
                lastUpdatedAt: new Date().toISOString(),
                nodesSnapshot: nodes.map(n => ({ id: n.id, label: n.data.label || n.id, type: n.type })),
                edgesSnapshot: edges.map(e => ({ id: e.id, source: e.source, target: e.target, condition: e.condition }))
            });
        } else if (state.__metadata.status !== 'failed') {
            state = {
                ...state,
                __metadata: { ...state.__metadata, currentNodeId: null, status: 'completed' }
            };
            setRuntimeStatus('completed');
            saveRuntimeCheckpoint({
                runId: state.__metadata.runId,
                status: 'completed',
                currentNodeId: null,
                completedNodeIds: Array.from(restoredCompleted),
                executedSignatures: Array.from(executionControlRef.current.executedSignatures),
                graphState: { ...state },
                startedAt: state.__metadata.startedAt,
                lastUpdatedAt: new Date().toISOString(),
                nodesSnapshot: nodes.map(n => ({ id: n.id, label: n.data.label || n.id, type: n.type })),
                edgesSnapshot: edges.map(e => ({ id: e.id, source: e.source, target: e.target, condition: e.condition }))
            });
            clearRuntimeCheckpoint();
        } else {
            state = {
                ...state,
                __metadata: { ...state.__metadata, currentNodeId: null }
            };
            setRuntimeStatus('failed');
        }
        setGraphState({ ...state });
        setCurrentNodeId(null);
        setCurrentNodeLabel(null);
        setIsExecuting(false);
    }, [nodes, edges, setNodes]);

    const clearLogs = useCallback(() => {
        setExecutionLogs([]);
        setGraphState(null);
        clearRuntimeCheckpoint();
    }, []);

    return {
        isExecuting,
        executionLogs,
        graphState,
        currentNodeId,
        currentNodeLabel,
        runtimeStatus,
        executeFlow,
        pauseExecution,
        resumeExecution,
        cancelExecution,
        clearLogs,
        hasSavedCheckpoint: !!loadRuntimeCheckpoint()
    };
};
