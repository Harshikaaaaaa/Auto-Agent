
import { generateWorkflow as generateGemini, executeNodeAction as executeGemini } from './geminiService';
import { generateWorkflow as generateOllama, executeNodeAction as executeOllama } from './ollamaService';
import { generateWorkflow as generateOpenRouter, executeNodeAction as executeOpenRouter } from './openRouterService';
import { AI_CONFIG } from '../config';
import { Workflow } from '@features/workflow/types';
import { WorkflowContextBuffer } from '../types';

/**
 * Generates a workflow using the configured AI provider.
 */
export const generateWorkflow = async (prompt: string): Promise<Workflow> => {
    switch (AI_CONFIG.provider) {
        case 'ollama':
            return generateOllama(prompt);
        case 'gemini':
            return generateGemini(prompt);
        case 'openrouter':
            return generateOpenRouter(prompt);
        default:
            console.warn(`Unknown provider "${AI_CONFIG.provider}", defaulting to Gemini.`);
            return generateGemini(prompt);
    }
};

/**
 * Executes a node action using the configured AI provider.
 */
export const executeNodeAction = async (
    nodeLabel: string,
    nodeDescription: string,
    inputState: Record<string, any>,
    outputKeys: string[],
    contextBuffer?: WorkflowContextBuffer
): Promise<Record<string, any>> => {
    switch (AI_CONFIG.provider) {
        case 'ollama':
            return executeOllama(nodeLabel, nodeDescription, inputState, outputKeys, contextBuffer);
        case 'gemini':
            return executeGemini(nodeLabel, nodeDescription, inputState, outputKeys, contextBuffer);
        case 'openrouter':
            return executeOpenRouter(nodeLabel, nodeDescription, inputState, outputKeys, contextBuffer);
        default:
            console.warn(`Unknown provider "${AI_CONFIG.provider}", defaulting to Gemini.`);
            return executeGemini(nodeLabel, nodeDescription, inputState, outputKeys, contextBuffer);
    }
};
