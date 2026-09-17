import type { Workflow } from '@features/workflow/types';
import { describeCatalog } from '@features/tools/toolRegistry';
import '@features/tools/connectors';
import type { WorkflowContextBuffer } from '../types';
import { requestNodeExecution, requestWorkflow } from './aiClient';
import { normalizeGeneratedWorkflow } from './workflowNormalizer';

/**
 * Gemini-backed AI operations.
 *
 * The `@google/genai` SDK call moved to the server (`/api/ai/*`) so the API key
 * is never shipped to the browser. This module supplies the live tool catalog,
 * pins the provider, and post-processes the result.
 */

export const generateWorkflow = async (prompt: string): Promise<Workflow> => {
  const { workflow } = await requestWorkflow({
    prompt,
    catalog: describeCatalog(),
    provider: 'gemini',
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
      provider: 'gemini',
    });
    return output;
  } catch (error) {
    console.error('Error executing node action (Gemini):', error);
    return Object.fromEntries(
      outputKeys.map((key) => [
        key,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    );
  }
};
