import { MemorySaver, Checkpoint } from "@langchain/langgraph";
import { Node as FlowNode, Edge } from 'reactflow';
import { buildLangGraph, WorkflowStateType } from './langgraphExecutor';

const CHECKPOINT_STORAGE_KEY = 'autoagent_checkpoints';

/**
 * A MemorySaver wrapper that also persists checkpoint data to localStorage,
 * so workflow progress survives page refreshes.
 */
class LocalStorageSaver extends MemorySaver {
    /** Save a serialized snapshot after every checkpoint update */
    async put(config: any, checkpoint: any, metadata: any): Promise<any> {
        const result = await super.put(config, checkpoint, metadata);
        this.persistToStorage();
        return result;
    }

    /** Restore checkpoints from localStorage (best effort) */
    hydrateFromStorage(): void {
        try {
            const raw = localStorage.getItem(CHECKPOINT_STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            // The MemorySaver stores data in its internal .storage Map;
            // we repopulate it from the serialized form.
            if (data && typeof data === 'object') {
                for (const [key, value] of Object.entries(data)) {
                    (this as any).storage?.set?.(key, value);
                }
            }
        } catch (err) {
            console.warn('[LocalStorageSaver] Failed to hydrate:', err);
        }
    }

    /** Serialize the current checkpoint storage to localStorage */
    private persistToStorage(): void {
        try {
            const storage = (this as any).storage;
            if (storage instanceof Map) {
                const obj: Record<string, any> = {};
                for (const [key, value] of storage.entries()) {
                    obj[key] = value;
                }
                localStorage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(obj));
            }
        } catch (err) {
            console.warn('[LocalStorageSaver] Failed to persist:', err);
        }
    }

    /** Clear persisted data */
    clearStorage(): void {
        localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
    }
}

/**
 * Workflow checkpoint manager using LangGraph's built-in checkpointing.
 * Enables pause/resume, time-travel debugging, and state persistence.
 */
export class WorkflowCheckpointManager {
    private checkpointer: LocalStorageSaver;

    constructor() {
        this.checkpointer = new LocalStorageSaver();
        this.checkpointer.hydrateFromStorage();
    }

    /**
     * Compile a graph with checkpointing enabled
     */
    compileWithCheckpoints(
        nodes: FlowNode[],
        edges: Edge[],
        originalPrompt: string = ''
    ) {
        const graph = buildLangGraph(nodes, edges, originalPrompt);
        return graph.compile({ checkpointer: this.checkpointer });
    }

    /**
     * Execute workflow with automatic checkpointing
     */
    async executeWithCheckpoints(
        nodes: FlowNode[],
        edges: Edge[],
        initialState: Record<string, any> = {},
        originalPrompt: string = '',
        threadId: string = crypto.randomUUID()
    ): Promise<{
        finalState: WorkflowStateType;
        checkpoints: Checkpoint[];
        threadId: string;
    }> {
        const compiledGraph = this.compileWithCheckpoints(nodes, edges, originalPrompt);

        const config = {
            configurable: {
                thread_id: threadId
            }
        };

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

        const checkpointList: Checkpoint[] = [];

        // Execute with streaming to capture checkpoints
        const stream = await compiledGraph.stream(startState, config);

        let finalState: WorkflowStateType | null = null;

        for await (const output of stream) {
            for (const [_, nodeState] of Object.entries(output)) {
                finalState = nodeState as unknown as WorkflowStateType;

                // Get checkpoint after each node
                const currentCheckpoint = await this.checkpointer.get(config);
                if (currentCheckpoint) {
                    checkpointList.push(currentCheckpoint as any);
                }
            }
        }

        return {
            finalState: finalState as WorkflowStateType,
            checkpoints: checkpointList,
            threadId
        };
    }

    /**
     * Resume execution from a specific checkpoint
     */
    async resumeFromCheckpoint(
        nodes: FlowNode[],
        edges: Edge[],
        threadId: string,
        originalPrompt: string = ''
    ): Promise<WorkflowStateType> {
        const compiledGraph = this.compileWithCheckpoints(nodes, edges, originalPrompt);

        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        // Get the latest checkpoint for this thread
        const checkpoint = await this.checkpointer.get(config);
        if (!checkpoint) {
            throw new Error(`No checkpoint found for thread ${threadId}`);
        }

        // Continue execution from checkpoint
        const stream = await compiledGraph.stream(null, config);

        let finalState: WorkflowStateType | null = null;
        for await (const output of stream) {
            for (const [_, nodeState] of Object.entries(output)) {
                finalState = nodeState as unknown as WorkflowStateType;
            }
        }

        return finalState as WorkflowStateType;
    }

    /**
     * Get execution history for a thread
     */
    async getThreadHistory(threadId: string): Promise<Checkpoint[]> {
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const checkpoints: any[] = [];
        for await (const checkpoint of this.checkpointer.list(config)) {
            checkpoints.push(checkpoint);
        }

        return checkpoints;
    }

    /**
     * Clear checkpoints for a specific thread
     */
    async clearThread(threadId: string): Promise<void> {
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        await this.checkpointer.put(config, null as any, { source: 'clear' } as any);
    }

    /**
     * Export checkpoint state for external persistence
     */
    async exportCheckpoint(threadId: string): Promise<string> {
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const checkpoint = await this.checkpointer.get(config);
        return JSON.stringify(checkpoint, null, 2);
    }

    /**
     * Import checkpoint state from external source
     */
    async importCheckpoint(threadId: string, checkpointData: string): Promise<void> {
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const checkpoint = JSON.parse(checkpointData);
        await this.checkpointer.put(config, checkpoint, { source: 'import' } as any);
    }
}

/**
 * Create a singleton instance for the app
 */
export const workflowCheckpointManager = new WorkflowCheckpointManager();

/**
 * Human-in-the-loop workflow support
 * Allows pausing execution and waiting for human approval/input
 */
export class HumanInTheLoopWorkflow {
    private pendingApprovals: Map<string, {
        resolve: (approved: boolean, data?: any) => void;
        nodeId: string;
        state: WorkflowStateType;
    }>;

    constructor() {
        this.pendingApprovals = new Map();
    }

    /**
     * Request human approval at a specific node
     */
    async requestApproval(
        approvalId: string,
        nodeId: string,
        state: WorkflowStateType,
        timeoutMs?: number
    ): Promise<{ approved: boolean; data?: any }> {
        return new Promise((resolve, reject) => {
            this.pendingApprovals.set(approvalId, {
                resolve: (approved, data) => resolve({ approved, data }),
                nodeId,
                state
            });

            if (timeoutMs) {
                setTimeout(() => {
                    if (this.pendingApprovals.has(approvalId)) {
                        this.pendingApprovals.delete(approvalId);
                        reject(new Error(`Approval timeout for ${approvalId}`));
                    }
                }, timeoutMs);
            }
        });
    }

    /**
     * Approve a pending request
     */
    approve(approvalId: string, data?: any): boolean {
        const approval = this.pendingApprovals.get(approvalId);
        if (!approval) return false;

        approval.resolve(true, data);
        this.pendingApprovals.delete(approvalId);
        return true;
    }

    /**
     * Reject a pending request
     */
    reject(approvalId: string): boolean {
        const approval = this.pendingApprovals.get(approvalId);
        if (!approval) return false;

        approval.resolve(false);
        this.pendingApprovals.delete(approvalId);
        return true;
    }

    /**
     * Get all pending approvals
     */
    getPendingApprovals(): Array<{
        id: string;
        nodeId: string;
        state: WorkflowStateType;
    }> {
        return Array.from(this.pendingApprovals.entries()).map(([id, approval]) => ({
            id,
            nodeId: approval.nodeId,
            state: approval.state
        }));
    }

    /**
     * Clear all pending approvals
     */
    clearAll(): void {
        for (const [, approval] of this.pendingApprovals.entries()) {
            approval.resolve(false);
        }
        this.pendingApprovals.clear();
    }
}

export const humanInTheLoopWorkflow = new HumanInTheLoopWorkflow();
