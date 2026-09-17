import type { Workflow } from '@features/workflow/types';
import { describeCatalog } from '@features/tools/toolRegistry';
import '@features/tools/connectors';
import type { WorkflowContextBuffer } from '../types';
import { requestNodeExecution, requestWorkflow } from './aiClient';
import { normalizeGeneratedWorkflow } from './workflowNormalizer';

/**
 * OpenRouter-backed AI operations.
 *
 * The provider call itself now happens on the server (`/api/ai/*`), which holds
 * the API key. This module only supplies the live tool catalog, pins the
 * provider, and post-processes the result. No credential is read here.
 */

export const generateWorkflow = async (prompt: string): Promise<Workflow> => {
  const { workflow } = await requestWorkflow({
    prompt,
    catalog: describeCatalog(),
    provider: 'openrouter',
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
      provider: 'openrouter',
    });
    return output;
  } catch (error) {
    // Preserve the existing contract: a failed node reports the error through
    // its declared output keys so the run can surface it per-key.
    console.error('Error executing node action (OpenRouter):', error);
    return Object.fromEntries(
      outputKeys.map((key) => [
        key,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    );
  }
};
