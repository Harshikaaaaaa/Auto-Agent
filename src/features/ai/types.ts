
export interface AIService {
    generateWorkflow(prompt: string): Promise<any>;
    executeNodeAction(
        nodeLabel: string,
        nodeDescription: string,
        inputState: Record<string, any>,
        outputKeys: string[],
        contextBuffer?: WorkflowContextBuffer
    ): Promise<Record<string, any>>;
}

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
