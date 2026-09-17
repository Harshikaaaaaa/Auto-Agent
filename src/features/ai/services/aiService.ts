import { AI_CONFIG } from '../config';
import type { WorkflowContextBuffer } from '../types';
import { AiRequestError, requestNodeExecution } from './aiClient';
import {
  NodeExecutionError,
  classifyFailureMessage,
  type FailureKind,
} from '@features/workflow/services/nodeFailure';
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

/** Map a transport-level AI error onto the engine's failure taxonomy. */
function kindForRequestError(error: AiRequestError): FailureKind {
  if (error.status === 401 || error.status === 403) return 'auth';
  if (error.status === 429) return 'rate_limit';
  if (error.status === 400) return 'invalid_input';
  // status 0 is "could not reach the server", which the client marks retryable.
  if (error.retryable) return 'transient';
  return classifyFailureMessage(error.message);
}

/**
 * Run one AI-backed workflow node.
 *
 * THROWS on failure. It used to return the error text under each declared output
 * key, which meant the engine merged `{ summary: 'Error: provider unavailable' }`
 * into graph state, logged the node as completed, and let the next node treat
 * that sentence as a summary. A run that did nothing looked successful.
 */
export const executeNodeAction = async (
  nodeLabel: string,
  nodeDescription: string,
  inputState: Record<string, unknown>,
  outputKeys: string[],
  contextBuffer?: WorkflowContextBuffer,
): Promise<Record<string, unknown>> => {
  const provider = configuredProvider();

  try {
    const { output } = await requestNodeExecution({
      nodeLabel,
      nodeDescription,
      inputState,
      outputKeys,
      context: contextBuffer,
      provider,
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind =
      error instanceof AiRequestError
        ? kindForRequestError(error)
        : classifyFailureMessage(message);

    throw new NodeExecutionError(`${nodeLabel}: ${message}`, { kind, cause: error });
  }
};
