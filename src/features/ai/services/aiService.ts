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
/**
 * The most text (characters) to send to the model for any ONE input value.
 *
 * A scraped article can be hundreds of KB; the whole raw HTML far more. Sending
 * that verbatim blows past the server's 1 MB request-body limit (a 413 that
 * surfaces as an invalid_input node failure) and wastes tokens for no benefit —
 * a summary does not need every byte. Each large value is trimmed to a generous
 * but bounded slice, with a marker so the model knows it was cut. Well under the
 * body limit even across several inputs.
 */
const MAX_AI_INPUT_CHARS = 120_000;

/** Trim oversized string values in the input so the AI request stays in bounds. */
function boundInputState(inputState: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputState)) {
    if (typeof value === 'string' && value.length > MAX_AI_INPUT_CHARS) {
      bounded[key] =
        value.slice(0, MAX_AI_INPUT_CHARS) +
        `\n\n[…truncated ${value.length - MAX_AI_INPUT_CHARS} more characters for length]`;
    } else {
      bounded[key] = value;
    }
  }
  return bounded;
}

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
      // Cap oversized inputs so a large scraped page cannot exceed the server's
      // request-body limit and fail the node.
      inputState: boundInputState(inputState),
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
