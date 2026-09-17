import type { Workflow } from '@features/workflow/types';
import { describeCatalog } from '@features/tools/toolRegistry';
import '@features/tools/connectors';
import type { WorkflowContextBuffer } from '../types';
import { requestNodeExecution, requestWorkflow } from './aiClient';
import { normalizeGeneratedWorkflow } from './workflowNormalizer';

/**
 * Ollama-backed AI operations.
 *
 * The Ollama call moved to the server (`/api/ai/*`). Even though Ollama needs no
 * API key, routing it through the server keeps one code path for prompts,
 * timeouts, and error handling, and avoids the browser talking to a local
 * daemon directly.
 */

export const generateWorkflow = async (prompt: string): Promise<Workflow> => {
  const { workflow } = await requestWorkflow({
    prompt,
    catalog: describeCatalog(),
    provider: 'ollama',
  });
  return normalizeGeneratedWorkflow(workflow);
};

export const executeNodeAction = async (
  nodeLabel: string,
  nodeDescription: string,
  inputState: Record<string, unknown>,
  outputKeys: string[],
  contextBuffer?: WorkflowContextBuffer,
): Promise<Record<string, unknown>> => {
  try {
    const { output } = await requestNodeExecution({
      nodeLabel,
      nodeDescription,
      inputState,
      outputKeys,
      context: contextBuffer,
      provider: 'ollama',
    });
    return output;
  } catch (error) {
    console.error('Error executing node action (Ollama):', error);
    return Object.fromEntries(
      outputKeys.map((key) => [
        key,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    );
  }
};
