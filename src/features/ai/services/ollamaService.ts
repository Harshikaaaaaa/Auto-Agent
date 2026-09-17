import ollama from 'ollama';
import { Workflow } from '@features/workflow/types';
import { findReusableToolTemplate, getAllTools } from '@features/tools/toolRegistry';
import '@features/tools/connectors'; // Ensure tools are registered
import { WorkflowContextBuffer } from '../types';
import { AI_CONFIG } from '../config';

// Helper to clean JSON response (similar to geminiService)
function cleanJsonResponse(text: string): string {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```[a-z]*\n/i, '');
        cleaned = cleaned.replace(/\n```$/g, '');
    }
    return cleaned.trim();
}

/**
 * Generates a state graph workflow using Ollama.
 */
export const generateWorkflow = async (prompt: string): Promise<Workflow> => {
    const tools = getAllTools();
    const toolsList = tools.length === 0
        ? 'No external tools are registered.'
        : 'The following tools are registered in the system:\n' +
        tools.map(t => {
            const authed = t.isAuthenticated();
            return `- **${t.name}** (id: "${t.id}") — ${authed ? '✅ CONNECTED' : '⚠️ NOT YET CONNECTED'}\n` +
                `  Actions: ${t.actions.map(a => `"${a.name}" (Inputs: [${a.inputKeys.join(', ')}]) — ${a.description}`).join('; ')}`;
        }).join('\n');

    // Simplified prompt for smaller models like llama3.2:1b
    const systemPrompt = `You are an expert automation architect.
Your goal is to design a STATEFUL GRAPH workflow based on the user's request.

## CORE CONCEPT
- A shared STATE OBJECT flows through the graph.
- Each node reads from inputKeys and writes to outputKeys.

## NODE TYPES
- 'trigger': Entry point.
- 'ai_agent': Processing node.
- 'tool': Utility node.
- 'logic': Router for branching.
- 'output': Terminal node.

## AVAILABLE TOOLS
${toolsList}

## CRITICAL RULES FOR TOOLS
1. If the user request matches a tool (e.g. "send email"), you MUST create a 'tool' node.
2. Set 'toolId' and 'toolAction' exactly as listed above.
3. 'inputKeys' must match the tool action's inputs.

## RESPONSE FORMAT
Return ONLY a valid JSON object with this structure:
{
  "nodes": [
    {
      "id": "string",
      "type": "trigger" | "ai_agent" | "tool" | "logic" | "output",
      "position": { "x": number, "y": number },
      "data": {
        "label": "string",
        "type": "string",
        "description": "string",
        "toolId": "string (optional)",
        "toolAction": "string (optional)",
        "stateContract": {
          "inputKeys": ["string"],
          "outputKeys": ["string"]
        },
        "routerConfig": {
          "stateKey": "string",
          "routes": { "value": "target_node_id" },
          "defaultRoute": "target_node_id"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "string",
      "source": "string",
      "target": "string",
      "label": "string (optional)",
      "condition": "string (optional, JS expression)"
    }
  ],
  "initialState": { "key": "value" }
}
`;

    const userMessage = `USER REQUEST: "${prompt}"\n\nDesign the workflow. Return JSON only.`;

    try {
        console.log(`[Ollama] Generating workflow with model: ${AI_CONFIG.ollamaModel}`);
        const response = await ollama.chat({
            model: AI_CONFIG.ollamaModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            format: 'json', // Force JSON output
            stream: false
        });

        const text = cleanJsonResponse(response.message.content);
        console.log('[Ollama] Raw response:', text);

        const workflow = JSON.parse(text) as Workflow;

        // Post-processing: auto-bind tools if missed (copying logic from geminiService)
        // ... (reuse the logic if possible, or duplicate for now to verify)
        // For simplicity, let's start with basic generation.
        // If the model follows the "CRITICAL RULES FOR TOOLS" well, we might not need heavy post-processing.
        // But smaller models often miss details, so let's include a lightweight binder.

        // ── Post-process: auto-bind tool nodes ──────────────────────
        const registeredTools = getAllTools();
        for (const node of workflow.nodes) {
            if (node.type === 'output' || node.type === 'trigger') continue;
            if (node.data.toolId && node.data.toolAction) continue;

            const label = (node.data.label || '').toLowerCase();
            const desc = (node.data.description || '').toLowerCase();
            const nodeText = label + ' ' + desc;

            const builtInMatch = findReusableToolTemplate(nodeText);
            if (builtInMatch) {
                node.data.toolId = builtInMatch.toolId;
                node.data.toolAction = builtInMatch.toolAction;
                node.type = 'tool';
                node.data.type = 'tool' as any;
                node.data.stateContract = { inputKeys: builtInMatch.inputKeys, outputKeys: builtInMatch.outputKeys };
                continue;
            }

            for (const tool of registeredTools) {
                const toolKeywords = [tool.name.toLowerCase(), tool.id.toLowerCase()];
                if (toolKeywords.some(kw => nodeText.includes(kw))) {
                    // Simple heuristic: match action name
                    for (const action of tool.actions) {
                        if (nodeText.includes(action.name.replace(/_/g, ' ')) || nodeText.includes(action.name)) {
                            node.data.toolId = tool.id;
                            node.data.toolAction = action.name;
                            node.type = 'tool';
                            node.data.type = 'tool' as any;
                            if (!node.data.stateContract) {
                                node.data.stateContract = { inputKeys: action.inputKeys, outputKeys: action.outputKeys };
                            }
                            break;
                        }
                    }
                    if (node.data.toolId) break;
                }
            }
        }

        return workflow;
    } catch (e) {
        console.error("Ollama Generation Error:", e);
        throw new Error("Failed to generate workflow via Ollama.", { cause: e });
    }
};

/**
 * Executes a single node's action using Ollama.
 */
export const executeNodeAction = async (
    nodeLabel: string,
    nodeDescription: string,
    inputState: Record<string, any>,
    outputKeys: string[],
    contextBuffer?: WorkflowContextBuffer
): Promise<Record<string, any>> => {

    // Construct prompt
    let systemPrompt = `You are a node in a workflow.
Node Label: ${nodeLabel}
Instructions: ${nodeDescription}

Your task is to process the INPUT STATE and produce the OUTPUT KEYS.
Return ONLY valid JSON content matching the output keys.
`;

    if (contextBuffer) {
        systemPrompt += `\nCONTEXT:
Original Goal: "${contextBuffer.originalPrompt}"
Previous Outputs: ${contextBuffer.executionHistory.map(h => `${h.nodeLabel}: ${h.outputSummary}`).join('; ')}
`;
    }

    const userContent = `
INPUT STATE: ${JSON.stringify(inputState)}
REQUIRED OUTPUT KEYS: ${JSON.stringify(outputKeys)}

Generate the output JSON.
`;

    try {
        console.log(`[Ollama] Executing node "${nodeLabel}" with model: ${AI_CONFIG.ollamaModel}`);
        const response = await ollama.chat({
            model: AI_CONFIG.ollamaModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            format: 'json',
            stream: false
        });

        const text = cleanJsonResponse(response.message.content);
        return JSON.parse(text);

    } catch (error) {
        console.error('Ollama Execution Error:', error);
        return Object.fromEntries(outputKeys.map(k => [k, `Error: ${String(error)}`]));
    }
};
