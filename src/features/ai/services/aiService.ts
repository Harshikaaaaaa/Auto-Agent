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

/**
 * Provider to request for a node call.
 *
 * 'auto' — so the SERVER's AI_PROVIDER decides. The client config hardcodes
 * 'openrouter', which was overriding the operator's server-side choice: a
 * workflow ran on OpenRouter's 128K-token model even when the server was set to
 * Gemini (1M tokens), so a large page hit a context limit it would not have hit
 * on the configured provider. Deferring to the server fixes that and keeps the
 * key handling server-side.
 */
function configuredProvider(): 'ollama' | 'gemini' | 'openrouter' | 'auto' {
  return 'auto';
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
 * Does this error mean the input exceeded the MODEL's context window? This is
 * the one size limit the app cannot remove — it belongs to the provider. When
 * we hit it, chunk-and-combine is the way through, not a hard failure.
 */
function isContextLengthError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('context length') ||
    message.includes('context window') ||
    message.includes('maximum context') ||
    message.includes('too many tokens') ||
    message.includes('reduce the length') ||
    (message.includes('token') && message.includes('maximum'))
  );
}

/** The largest string field in the input, which is the one worth chunking. */
function largestStringKey(inputState: Record<string, unknown>): string | null {
  let key: string | null = null;
  let len = 0;
  for (const [k, v] of Object.entries(inputState)) {
    if (typeof v === 'string' && v.length > len) {
      len = v.length;
      key = k;
    }
  }
  return key;
}

/** Split text into N roughly-equal chunks on paragraph/line boundaries. */
function chunkText(text: string, parts: number): string[] {
  const target = Math.ceil(text.length / parts);
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      // Prefer to break at a paragraph, then a line, then a space, so a chunk
      // is not cut mid-word.
      const window = text.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
      );
      if (breakAt > target * 0.5) end = start + breakAt + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Run one AI-backed workflow node.
 *
 * THROWS on failure. It used to return the error text under each declared output
 * key, which meant the engine merged `{ summary: 'Error: provider unavailable' }`
 * into graph state, logged the node as completed, and let the next node treat
 * that sentence as a summary. A run that did nothing looked successful.
 *
 * The app imposes NO input-size limit. If the MODEL rejects the input for
 * exceeding its context window (the one ceiling that is the provider's, not
 * ours), the node does NOT fail: it splits the largest input into chunks that
 * fit, runs the node on each, and runs once more to combine the partial
 * results — a map/reduce that works for any size and any model, like a
 * summarization chain. `_depth` guards against unbounded recursion.
 */
export const executeNodeAction = async (
  nodeLabel: string,
  nodeDescription: string,
  inputState: Record<string, unknown>,
  outputKeys: string[],
  contextBuffer?: WorkflowContextBuffer,
  _depth = 0,
): Promise<Record<string, unknown>> => {
  const provider = configuredProvider();

  try {
    const { output } = await requestNodeExecution({
      nodeLabel,
      nodeDescription,
      // No app-imposed input cap: the whole content is sent. The only remaining
      // ceiling is the model's context window, handled by chunking below.
      inputState,
      outputKeys,
      context: contextBuffer,
      provider,
    });
    return output;
  } catch (error) {
    // The model's context window is the one limit we cannot remove — so when we
    // hit it, split and combine rather than fail. Cap the recursion so a
    // pathological case cannot loop forever.
    const chunkKey = largestStringKey(inputState);
    if (isContextLengthError(error) && chunkKey && _depth < 3) {
      const whole = String(inputState[chunkKey]);
      // Two chunks per level halves the size each time; depth 3 allows up to 8x.
      const pieces = chunkText(whole, 2);
      if (pieces.length > 1) {
        const partials: string[] = [];
        for (const piece of pieces) {
          const partial = await executeNodeAction(
            nodeLabel,
            nodeDescription,
            { ...inputState, [chunkKey]: piece },
            outputKeys,
            contextBuffer,
            _depth + 1,
          );
          // Collect whatever the node produced under its output keys.
          partials.push(
            outputKeys
              .map((k) => partial[k])
              .filter((v) => typeof v === 'string' && v.length > 0)
              .join('\n'),
          );
        }
        // Combine the partial results in one final pass over a much smaller input.
        return executeNodeAction(
          nodeLabel,
          `${nodeDescription}\n\nCombine these partial results into one final result.`,
          { ...inputState, [chunkKey]: partials.join('\n\n---\n\n') },
          outputKeys,
          contextBuffer,
          _depth + 1,
        );
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const kind =
      error instanceof AiRequestError
        ? kindForRequestError(error)
        : classifyFailureMessage(message);

    throw new NodeExecutionError(`${nodeLabel}: ${message}`, { kind, cause: error });
  }
};
