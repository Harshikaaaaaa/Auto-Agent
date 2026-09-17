
/**
 * Context buffer that flows through the entire workflow execution,
 * giving each node full awareness of the workflow's state and history.
 */
export interface WorkflowContextBuffer {
    /** The original user prompt that generated this workflow */
    originalPrompt: string;
    /** Full accumulated graph state (all keys, not just inputKeys) */
    fullGraphState: Record<string, any>;
    /** Ordered log of what each previous node produced */
    executionHistory: Array<{
        nodeLabel: string;
        outputKeys: string[];
        outputSummary: string;
    }>;
}
