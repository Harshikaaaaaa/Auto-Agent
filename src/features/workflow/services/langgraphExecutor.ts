import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { Node as FlowNode, Edge } from 'reactflow';
import { ExecutionLog, GraphState as FlowGenGraphState } from '@features/workflow/types';
import { executeNodeAction } from '@features/ai/services/aiService';
import { WorkflowContextBuffer } from '@features/ai/types';
import { getTool } from '@features/tools/toolRegistry';

/**
 * LangGraph State Definition
 * Represents the complete state that flows through the workflow graph
 */
const WorkflowState = Annotation.Root({
    // Core workflow data - all dynamic keys from nodes
    data: Annotation<Record<string, any>>({
        reducer: (current, update) => ({ ...current, ...update }),
        default: () => ({})
    }),

    // Execution metadata
    metadata: Annotation<{
        runId: string;
        startedAt: string;
        currentNodeId: string | null;
        status: 'running' | 'completed' | 'failed' | 'paused';
        error?: string;
    }>({
        reducer: (current, update) => ({ ...current, ...update }),
        default: () => ({
            runId: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            currentNodeId: null,
            status: 'running' as const
        })
    }),

    // Execution history for context awareness
    history: Annotation<Array<{
        nodeLabel: string;
        nodeId: string;
        outputKeys: string[];
        output: Record<string, any>;
        timestamp: string;
    }>>({
        reducer: (current, update) => [...current, ...update],
        default: () => []
    }),

    // Original user prompt for AI context
    originalPrompt: Annotation<string>({
        reducer: (_, update) => update,
        default: () => ''
    }),

    // Execution logs for UI display
    logs: Annotation<ExecutionLog[]>({
        reducer: (current, update) => [...current, ...update],
        default: () => []
    })
});

type WorkflowStateType = typeof WorkflowState.State;

/**
 * Creates a LangGraph node function from an AutoAgent node definition
 */
function createLangGraphNode(
    flowNode: FlowNode,
    originalPrompt: string
) {
    return async (state: WorkflowStateType): Promise<Partial<WorkflowStateType>> => {
        const stateContract = flowNode.data.stateContract || { inputKeys: [], outputKeys: [] };
        const inputKeys = stateContract.inputKeys || [];
        const outputKeys = stateContract.outputKeys || [];
        const reducer = stateContract.reducer || 'overwrite';

        // Extract input data based on inputKeys
        const inputState: Record<string, any> = {};
        for (const key of inputKeys) {
            if (state.data[key] !== undefined) {
                inputState[key] = state.data[key];
            }
        }

        try {
            let nodeOutput: Record<string, any>;

            // === Tool Node Execution ===
            const { toolId, toolAction } = flowNode.data;
            if (toolId && toolAction) {
                const tool = getTool(toolId);
                if (!tool) throw new Error(`Tool "${toolId}" not found in registry.`);
                if (!tool.isAuthenticated()) {
                    throw new Error(`Tool "${toolId}" is not authenticated. Connect it first.`);
                }

                const action = tool.actions.find(a => a.name === toolAction);
                if (!action) {
                    throw new Error(`Action "${toolAction}" not found on tool "${toolId}".`);
                }

                const mergedInput: Record<string, any> = { ...inputState };
                const reservedNodeKeys = new Set([
                    'label', 'description', 'icon', 'color', 'type', 'toolId', 'toolAction',
                    'stateContract', 'routerConfig', 'breakpoint', 'isRunning', 'lastSuccess',
                    'output', 'initialState'
                ]);

                for (const [key, value] of Object.entries(flowNode.data || {})) {
                    if (!reservedNodeKeys.has(key) && value !== undefined) {
                        mergedInput[key] = value;
                    }
                }

                if (flowNode.data.initialState && typeof flowNode.data.initialState === 'object') {
                    for (const [key, value] of Object.entries(flowNode.data.initialState)) {
                        if (value !== undefined) {
                            mergedInput[key] = value;
                        }
                    }
                }

                for (const key of action.inputKeys) {
                    if (mergedInput[key] === undefined && state.data[key] !== undefined) {
                        mergedInput[key] = state.data[key];
                    }
                }

                nodeOutput = await action.execute(mergedInput);
            }
            // === Trigger Node with Initial State ===
            else if (flowNode.data.initialState) {
                nodeOutput = {};
                for (const key of outputKeys) {
                    if (flowNode.data.initialState[key] !== undefined) {
                        nodeOutput[key] = flowNode.data.initialState[key];
                    }
                }
            }
            // === AI Agent Node ===
            else if (outputKeys.length > 0) {
                // Build context buffer for AI awareness
                const contextBuffer: WorkflowContextBuffer = {
                    originalPrompt: state.originalPrompt || originalPrompt,
                    fullGraphState: state.data,
                    executionHistory: state.history.map(h => ({
                        nodeLabel: h.nodeLabel,
                        outputKeys: h.outputKeys,
                        outputSummary: JSON.stringify(h.output, null, 2)
                    }))
                };

                nodeOutput = await executeNodeAction(
                    flowNode.data.label,
                    flowNode.data.description || "",
                    inputState,
                    outputKeys,
                    contextBuffer
                );
            }
            // === Passthrough Node ===
            else {
                nodeOutput = {};
            }

            // Apply reducer strategy to merge output into state
            const updatedData = { ...state.data };
            for (const [key, value] of Object.entries(nodeOutput)) {
                switch (reducer) {
                    case 'append': {
                        const existing = updatedData[key];
                        updatedData[key] = Array.isArray(existing)
                            ? [...existing, value]
                            : existing !== undefined
                                ? [existing, value]
                                : [value];
                        break;
                    }

                    case 'merge':
                        if (typeof updatedData[key] === 'object' && typeof value === 'object' && !Array.isArray(value)) {
                            updatedData[key] = { ...updatedData[key], ...value };
                        } else {
                            updatedData[key] = value;
                        }
                        break;

                    case 'overwrite':
                    default:
                        updatedData[key] = value;
                        break;
                }
            }

            // Build execution log
            const executionLog: ExecutionLog = {
                node: flowNode.data.label,
                time: new Date().toLocaleTimeString(),
                output: JSON.stringify(nodeOutput, null, 2),
                stateSnapshot: { ...updatedData }
            };

            // Build history entry
            const historyEntry = {
                nodeLabel: flowNode.data.label,
                nodeId: flowNode.id,
                outputKeys,
                output: nodeOutput,
                timestamp: new Date().toISOString()
            };

            // Check for tool failures
            const isToolFailure = flowNode.data.toolId && (
                (nodeOutput.email_status && String(nodeOutput.email_status).toLowerCase().includes('error')) ||
                (nodeOutput.status && String(nodeOutput.status).toLowerCase().includes('error'))
            );

            if (isToolFailure) {
                throw new Error(
                    `Tool action failed: ${nodeOutput.email_status || nodeOutput.status || 'Unknown error'}`
                );
            }

            return {
                data: updatedData,
                metadata: {
                    ...state.metadata,
                    currentNodeId: flowNode.id
                },
                history: [historyEntry],
                logs: [executionLog]
            };

        } catch (err) {
            const errorLog: ExecutionLog = {
                node: flowNode.data.label,
                time: new Date().toLocaleTimeString(),
                output: `Error: ${err instanceof Error ? err.message : String(err)}`,
                stateSnapshot: state.data
            };

            return {
                metadata: {
                    ...state.metadata,
                    currentNodeId: flowNode.id,
                    status: 'failed',
                    error: String(err)
                },
                logs: [errorLog]
            };
        }
    };
}

/**
 * Safely evaluates a condition expression against state data.
 */
function evaluateConditionExpr(condition: string, stateData: Record<string, any>): boolean {
    try {
        const keys = Object.keys(stateData);
        const values = keys.map(k => stateData[k]);
        // eslint-disable-next-line no-new-func
        const fn = new Function(...keys, `"use strict"; return (${condition});`);
        return Boolean(fn(...values));
    } catch (err) {
        console.warn(`[LangGraph Condition] Failed to evaluate "${condition}":`, err);
        return false;
    }
}

/**
 * Builds a LangGraph StateGraph from AutoAgent nodes and edges.
 * Supports conditional edges: edges with a `condition` property are routed
 * using LangGraph's `addConditionalEdges()`.
 */
export function buildLangGraph(
    nodes: FlowNode[],
    edges: Edge[],
    originalPrompt: string = ''
): StateGraph<typeof WorkflowState> {
    const graph = new StateGraph(WorkflowState);

    // Add all nodes to the graph
    for (const node of nodes) {
        graph.addNode(node.id as any, createLangGraphNode(node, originalPrompt));
    }

    // Determine the entry point (node with no incoming edges)
    const nodesWithIncomingEdges = new Set(edges.map(e => e.target));
    const entryNodes = nodes.filter(n => !nodesWithIncomingEdges.has(n.id));

    if (entryNodes.length > 0) {
        graph.setEntryPoint(entryNodes[0].id as any);
    } else if (nodes.length > 0) {
        // Fallback: use first node as entry
        graph.setEntryPoint(nodes[0].id as any);
    }

    // Group edges by source to detect conditional vs unconditional routing
    const edgesBySource = new Map<string, (Edge & { condition?: string })[]>();
    for (const edge of edges) {
        const existing = edgesBySource.get(edge.source) || [];
        existing.push(edge as Edge & { condition?: string });
        edgesBySource.set(edge.source, existing);
    }

    // Track which source nodes we've already wired
    const wiredSources = new Set<string>();

    for (const [source, outEdges] of edgesBySource.entries()) {
        const hasConditions = outEdges.some(e => e.condition);

        if (hasConditions) {
            // Use addConditionalEdges: create a routing function that evaluates
            // each edge's condition against the current state and returns the target
            const routeMap: Record<string, string> = {};
            let defaultTarget: string = END;

            for (const e of outEdges) {
                if (e.condition) {
                    routeMap[e.condition] = e.target;
                } else {
                    // An edge without condition on a conditional node = default route
                    defaultTarget = e.target;
                }
            }

            // Find the source node to check for routerConfig default
            const sourceNode = nodes.find(n => n.id === source);
            if (sourceNode?.data?.routerConfig?.defaultRoute) {
                defaultTarget = sourceNode.data.routerConfig.defaultRoute;
            }

            // The routing function receives state and returns the next node
            const routingFn = (state: any) => {
                const stateData = state.data || {};
                for (const [condition, target] of Object.entries(routeMap)) {
                    if (evaluateConditionExpr(condition, stateData)) {
                        console.log(`[LangGraph Router] "${source}" → "${target}" (condition: ${condition})`);
                        return target;
                    }
                }
                console.log(`[LangGraph Router] "${source}" → "${defaultTarget}" (default)`);
                return defaultTarget;
            };

            // Build the path map for addConditionalEdges
            const pathMap: Record<string, string> = {};
            for (const e of outEdges) {
                pathMap[e.target] = e.target;
            }
            if (defaultTarget !== END) {
                pathMap[defaultTarget] = defaultTarget;
            } else {
                pathMap[END] = END;
            }

            graph.addConditionalEdges(source as any, routingFn as any, pathMap as any);
            wiredSources.add(source);
        } else {
            // All unconditional edges: add them normally
            for (const e of outEdges) {
                graph.addEdge(e.source as any, e.target as any);
            }
            wiredSources.add(source);
        }
    }

    // Determine terminal nodes (nodes with no outgoing edges)
    const nodesWithOutgoingEdges = new Set(edges.map(e => e.source));
    const terminalNodes = nodes.filter(n => !nodesWithOutgoingEdges.has(n.id));

    // Add edges from terminal nodes to END
    for (const terminalNode of terminalNodes) {
        graph.addEdge(terminalNode.id as any, END);
    }

    return graph;
}

/**
 * Executes a workflow using LangGraph with streaming support
 */
export async function executeLangGraphWorkflow(
    nodes: FlowNode[],
    edges: Edge[],
    initialState: Record<string, any> = {},
    originalPrompt: string = '',
    onNodeUpdate?: (nodeId: string, isRunning: boolean, success?: boolean, output?: string) => void,
    onStateUpdate?: (state: FlowGenGraphState) => void,
    onLogUpdate?: (log: ExecutionLog) => void
): Promise<{
    finalState: WorkflowStateType;
    success: boolean;
}> {
    const graph = buildLangGraph(nodes, edges, originalPrompt);
    const compiledGraph = graph.compile();

    const startState: Partial<WorkflowStateType> = {
        data: initialState,
        originalPrompt,
        metadata: {
            runId: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            currentNodeId: null,
            status: 'running'
        },
        history: [],
        logs: []
    };

    let finalState: WorkflowStateType | null = null;

    try {
        // Stream the execution to get real-time updates
        const stream = await compiledGraph.stream(startState);

        for await (const output of stream) {
            // output is a map of {nodeId: state}
            for (const [nodeId, nodeState] of Object.entries(output)) {
                if (nodeId === '__end__') continue;

                finalState = nodeState as unknown as WorkflowStateType;

                // Notify about node execution
                if (onNodeUpdate) {
                    const isSuccess = finalState.metadata.status !== 'failed';
                    const lastLog = finalState.logs[finalState.logs.length - 1];
                    onNodeUpdate(nodeId, false, isSuccess, lastLog?.output);
                }

                // Update state callback
                if (onStateUpdate) {
                    const flowGenState: FlowGenGraphState = {
                        ...finalState.data,
                        __metadata: finalState.metadata as any
                    };
                    onStateUpdate(flowGenState);
                }

                // Update log callback
                if (onLogUpdate && finalState.logs.length > 0) {
                    const latestLog = finalState.logs[finalState.logs.length - 1];
                    onLogUpdate(latestLog);
                }
            }
        }

        // Get final state if stream didn't provide it
        if (!finalState) {
            const result = await compiledGraph.invoke(startState);
            finalState = result as WorkflowStateType;
        }

        // Update final metadata
        if (finalState && finalState.metadata.status !== 'failed') {
            finalState.metadata.status = 'completed';
            finalState.metadata.currentNodeId = null;
        }

        return {
            finalState: finalState as WorkflowStateType,
            success: finalState?.metadata.status === 'completed'
        };

    } catch (error) {
        console.error('[LangGraph] Execution error:', error);

        if (!finalState) {
            finalState = {
                ...startState,
                metadata: {
                    runId: startState.metadata!.runId,
                    startedAt: startState.metadata!.startedAt,
                    currentNodeId: null,
                    status: 'failed',
                    error: String(error)
                }
            } as WorkflowStateType;
        }

        return {
            finalState,
            success: false
        };
    }
}

/**
 * Export types for use in other modules
 */
export type { WorkflowStateType };
export { WorkflowState };
