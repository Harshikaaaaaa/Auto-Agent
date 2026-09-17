import { AI_CONFIG } from '../config';
import type { WorkflowContextBuffer } from '../types';
import { requestNodeExecution } from './aiClient';
import '@features/tools/connectors';

/**
 * The AI call the execution engine makes.
 *
 * There is one of these now. Until Task 11 there were four modules doing it:
 * `aiService` switched on `AI_CONFIG.provider` to pick between geminiService,
 * ollamaService and openRouterService — three files that had become
 * byte-for-byte identical apart from the provider string they passed, once
 * Task 2 moved the actual provider calls to the server. The switch existed to
 * choose a string.
 *
 * Those modules also carried `generateWorkflow`, the legacy whole-graph
 * generator. Nothing in the UI called it: planning goes through
 * `workflowPlanGenerator`, which validates every tool binding against the
 * catalog. The legacy path did not — it ran model output through
 * `bindNodesToRegisteredTools`, which attached a tool because a node's label
 * happened to contain a matching word. That is the mechanism behind the reported
 * "Save results to Google Sheets" defect, so it is gone rather than left
 * reachable.
 */

/** Provider the server should use, or 'auto' to let it decide. */
function configuredProvider(): 'ollama' | 'gemini' | 'openrouter' {
    return AI_CONFIG.provider;
}

/**
 * Run one AI-backed workflow node.
 *
 * NOTE ON ERRORS: a failure is reported as the error text under each declared
 * output key rather than thrown. That means the engine records the node as
 * completed with error strings as its data — a real defect, but changing it
 * moves failure semantics for every node type at once, which is Task 12's
 * subject. Preserved verbatim here so this change stays a deletion.
 */
export const executeNodeAction = async (
    nodeLabel: string,
    nodeDescription: string,
    inputState: Record<string, unknown>,
    outputKeys: string[],
    contextBuffer?: WorkflowContextBuffer
): Promise<Record<string, unknown>> => {
    const provider = configuredProvider();

    try {
        const { output } = await requestNodeExecution({
            nodeLabel,
            nodeDescription,
            inputState,
            outputKeys,
            context: contextBuffer,
            provider
        });
        return output;
    } catch (error) {
        console.error(`Error executing node action (${provider}):`, error);
        return Object.fromEntries(
            outputKeys.map(key => [
                key,
                `Error: ${error instanceof Error ? error.message : String(error)}`
            ])
        );
    }
};
