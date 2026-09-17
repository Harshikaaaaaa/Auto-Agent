import { useState, useCallback } from 'react';
import { Node, Edge } from 'reactflow';
import { ExecutionLog, GraphState } from '@features/workflow/types';
import { executeLangGraphWorkflow, WorkflowStateType } from '@features/workflow/services/langgraphExecutor';
import '@features/tools/connectors';

/**
 * React hook for executing workflows using LangGraph.
 * Provides better state management, checkpointing, and memory across nodes.
 */
export const useWorkflowExecutionLangGraph = (
    nodes: Node[],
    edges: Edge[],
    setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void
) => {
    const [isExecuting, setIsExecuting] = useState(false);
    const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);
    const [graphState, setGraphState] = useState<GraphState | null>(null);
    const [langGraphState, setLangGraphState] = useState<WorkflowStateType | null>(null);

    const executeFlow = useCallback(async () => {
        if (nodes.length === 0) return;

        setIsExecuting(true);
        setExecutionLogs([]);
        setGraphState(null);
        setLangGraphState(null);

        // Extract initial state from nodes
        const initialData: Record<string, any> = {};
        nodes.forEach(n => {
            if (n.data.initialState) {
                Object.assign(initialData, n.data.initialState);
            }
        });

        // Extract original user prompt from initial state
        const originalPrompt = (initialData as any).user_request
            || (initialData as any).userRequest
            || (initialData as any).prompt
            || (initialData as any).request
            || '';

        // Define callbacks for real-time updates
        const handleNodeUpdate = (
            nodeId: string,
            isRunning: boolean,
            success?: boolean,
            output?: string
        ) => {
            setNodes(nds => nds.map(n =>
                n.id === nodeId
                    ? {
                        ...n,
                        data: {
                            ...n.data,
                            isRunning,
                            lastSuccess: success,
                            output
                        }
                    }
                    : n
            ));
        };

        const handleStateUpdate = (state: GraphState) => {
            setGraphState({ ...state });
        };

        const handleLogUpdate = (log: ExecutionLog) => {
            setExecutionLogs(prev => [...prev, log]);
        };

        // Mark the starting node as running
        const entryPoint = nodes.find(n =>
            !edges.some(e => e.target === n.id)
        );
        if (entryPoint) {
            handleNodeUpdate(entryPoint.id, true);
        }

        // Execute the workflow using LangGraph
        const result = await executeLangGraphWorkflow(
            nodes,
            edges,
            initialData,
            originalPrompt,
            handleNodeUpdate,
            handleStateUpdate,
            handleLogUpdate
        );

        setLangGraphState(result.finalState);

        // Convert LangGraph state to AutoAgent GraphState format
        const finalFlowGenState: GraphState = {
            ...result.finalState.data,
            __metadata: result.finalState.metadata as any
        };
        setGraphState(finalFlowGenState);

        // Update all logs from final state
        setExecutionLogs(result.finalState.logs);

        setIsExecuting(false);

        return result;
    }, [nodes, edges, setNodes]);

    const clearLogs = useCallback(() => {
        setExecutionLogs([]);
        setGraphState(null);
        setLangGraphState(null);
    }, []);

    /**
     * Access to execution history for debugging and analysis
     */
    const getExecutionHistory = useCallback(() => {
        return langGraphState?.history || [];
    }, [langGraphState]);

    /**
     * Get detailed state snapshot at any point
     */
    const getStateSnapshot = useCallback(() => {
        if (!langGraphState) return null;

        return {
            data: langGraphState.data,
            metadata: langGraphState.metadata,
            history: langGraphState.history,
            logs: langGraphState.logs
        };
    }, [langGraphState]);

    return {
        isExecuting,
        executionLogs,
        graphState,
        langGraphState,
        executeFlow,
        clearLogs,
        getExecutionHistory,
        getStateSnapshot
    };
};

export default useWorkflowExecutionLangGraph;
