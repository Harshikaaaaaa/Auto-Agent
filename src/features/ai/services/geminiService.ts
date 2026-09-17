import { GoogleGenAI, Type } from "@google/genai";
import { Workflow } from '@features/workflow/types';
import { findReusableToolTemplate, getAllTools } from '@features/tools/toolRegistry'; // Ensure tools are registered
import '@features/tools/connectors';
import { WorkflowContextBuffer } from '../types';
import { AI_CONFIG } from '../config';

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

function cleanJsonResponse(text: string): string {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```[a-z]*\n/i, '');
        cleaned = cleaned.replace(/\n```$/g, '');
    }
    return cleaned.trim();
}

/**
 * Generates a state graph workflow from a natural language prompt using Gemini.
 */
export const generateWorkflow = async (prompt: string): Promise<Workflow> => {

    // ... (Keep existing prompt logic, maybe refactor to share with Ollama later) ...
    // For now, let's keep the detailed prompt as is, but ensure we use AI_CONFIG.geminiModel

    const aiPrompt = `You are an expert automation architect designing a STATEFUL GRAPH workflow.

USER REQUEST: "${prompt}"

## CORE CONCEPT: MANAGED STATE GRAPH
This is NOT a simple pipeline. You are designing a directed graph where:
- A shared STATE OBJECT flows through the entire graph.
- Each node READS specific keys from the state and WRITES specific keys back.
- The state accumulates data as it flows through nodes.

## NODE TYPES
- 'trigger': The entry point that initializes the state.
- 'ai_agent': An intelligent processing node.
- 'tool': A utility node.
- 'logic': A ROUTER/DECISION node.
- 'output': A terminal node.

## STATE CONTRACT (CRITICAL)
Every node MUST include a 'stateContract':
- 'inputKeys': Array of state key names this node reads.
- 'outputKeys': Array of state key names this node writes.

## CONDITIONAL EDGES (BRANCHING)
- Use 'logic' nodes for branching.
- Add 'routerConfig' to logic nodes.
- Add 'condition' property to edges from logic nodes.

## ARCHITECTURE RULES
1. ROOT NODE: ID 'root', y: 0.
2. POSITIONING: Top-down layout.
3. EDGES: Represent data flow.

## INITIAL STATE
Generate an 'initialState' object.

## AVAILABLE TOOLS
${(() => {
            const tools = getAllTools();
            if (tools.length === 0) return 'No external tools are registered.';
            return 'The following tools are registered in the system:\n' +
                tools.map(t => {
                    const authed = t.isAuthenticated();
                    return `- **${t.name}** (id: "${t.id}") — ${authed ? '✅ CONNECTED' : '⚠️ NOT YET CONNECTED'}\n` +
                        `  Actions: ${t.actions.map(a => `"${a.name}" (Inputs: [${a.inputKeys.join(', ')}]) — ${a.description}`).join('; ')}`;
                }).join('\n') +
                '\n\n**CRITICAL RULES FOR TOOL NODES:**\n' +
                '1. When the user\'s request involves functionality matching a registered tool, you MUST create a node with `toolId` and `toolAction`.\n' +
                '2. Set the node type to "tool".\n' +
                '3. The node\'s stateContract.inputKeys MUST match the action\'s input keys EXACTLY.\n' +
                '4. Do NOT verify auth status yourself.\n';
        })()}

Return a strictly valid JSON object with 'nodes', 'edges', and 'initialState'.`;

    const response = await ai.models.generateContent({
        model: AI_CONFIG.geminiModel,
        contents: aiPrompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    nodes: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                id: { type: Type.STRING },
                                type: { type: Type.STRING },
                                position: {
                                    type: Type.OBJECT,
                                    properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                                    required: ["x", "y"]
                                },
                                data: {
                                    type: Type.OBJECT,
                                    properties: {
                                        label: { type: Type.STRING },
                                        type: { type: Type.STRING },
                                        description: { type: Type.STRING },
                                        toolId: { type: Type.STRING },
                                        toolAction: { type: Type.STRING },
                                        stateContract: { type: Type.STRING },
                                        routerConfig: { type: Type.STRING }
                                    },
                                    required: ["label", "type", "description"]
                                }
                            },
                            required: ["id", "type", "position", "data"]
                        }
                    },
                    edges: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                id: { type: Type.STRING },
                                source: { type: Type.STRING },
                                target: { type: Type.STRING },
                                label: { type: Type.STRING },
                                condition: { type: Type.STRING }
                            },
                            required: ["id", "source", "target"]
                        }
                    },
                    initialState: { type: Type.STRING }
                },
                required: ["nodes", "edges"]
            }
        }
    });


    try {
        const text = cleanJsonResponse(response.text || '');
        const workflow = JSON.parse(text) as Workflow;

        // Parse JSON strings in fields
        if (typeof workflow.initialState === 'string') {
            try { workflow.initialState = JSON.parse(workflow.initialState); } catch { workflow.initialState = {}; }
        }

        for (const node of workflow.nodes) {
            if (node.data?.stateContract && typeof node.data.stateContract === 'string') {
                try { node.data.stateContract = JSON.parse(node.data.stateContract); } catch { node.data.stateContract = { inputKeys: [], outputKeys: [] }; }
            }
            if (node.data?.routerConfig && typeof node.data.routerConfig === 'string') {
                try { node.data.routerConfig = JSON.parse(node.data.routerConfig); } catch { node.data.routerConfig = undefined; }
            }
        }

        // ── Post-process: auto-bind tool nodes ──────────────────────
        const registeredTools = getAllTools();
        for (const node of workflow.nodes) {
            if (node.type === 'output' || node.type === 'trigger') continue;
            if (node.data.toolId && node.data.toolAction) continue;

            const label = (node.data.label || '').toLowerCase();
            const desc = (node.data.description || '').toLowerCase();
            const text = label + ' ' + desc;

            const builtInMatch = findReusableToolTemplate(text);
            if (builtInMatch) {
                node.data.toolId = builtInMatch.toolId;
                node.data.toolAction = builtInMatch.toolAction;
                node.type = 'tool';
                node.data.type = 'tool' as any;
                node.data.stateContract = { inputKeys: builtInMatch.inputKeys, outputKeys: builtInMatch.outputKeys };
                console.log(`[AutoAgent] Reused built-in node "${node.data.label}" → ${builtInMatch.toolId}.${builtInMatch.toolAction}`);
                continue;
            }

            for (const tool of registeredTools) {
                const toolKeywords = [tool.name.toLowerCase(), tool.id.toLowerCase()];
                const mentionsTool = toolKeywords.some(kw => text.includes(kw));
                if (!mentionsTool) continue;

                for (const action of tool.actions) {
                    const actionWords = action.name.replace(/_/g, ' ').toLowerCase();
                    if (text.includes(actionWords) || text.includes(action.name)) {
                        node.data.toolId = tool.id;
                        node.data.toolAction = action.name;
                        node.type = 'tool';
                        node.data.type = 'tool' as any;

                        if (!node.data.stateContract) {
                            node.data.stateContract = { inputKeys: action.inputKeys, outputKeys: action.outputKeys };
                        }
                        console.log(`[AutoAgent] Auto-bound node "${node.data.label}" → ${tool.id}.${action.name}`);
                        break;
                    }
                }

                if (node.data.toolId) break;
            }
        }

        console.log('[AutoAgent] Generated workflow:', JSON.stringify(workflow, null, 2));
        return workflow;
    } catch (e) {
        console.error("JSON Error:", response.text, e);
        throw new Error("Failed to generate state graph.", { cause: e });
    }
};

/**
 * Executes a single node's action using Gemini AI.
 */
export const executeNodeAction = async (
    nodeLabel: string,
    nodeDescription: string,
    inputState: Record<string, any>,
    outputKeys: string[],
    contextBuffer?: WorkflowContextBuffer
): Promise<Record<string, any>> => {
    try {
        const hasInput = Object.keys(inputState).length > 0;

        let prompt = `You are a node in a managed state graph. Your job is to process input state and produce output for the specified keys.\n\n`;

        if (contextBuffer) {
            prompt += `## WORKFLOW CONTEXT\n`;
            prompt += `### Original User Request:\n"${contextBuffer.originalPrompt}"\n\n`;

            const { __metadata, ...cleanState } = contextBuffer.fullGraphState;
            const stateKeys = Object.keys(cleanState);
            if (stateKeys.length > 0) {
                prompt += `### Full Accumulated State:\n${JSON.stringify(cleanState, null, 2)}\n\n`;
            }

            if (contextBuffer.executionHistory.length > 0) {
                prompt += `### Execution History:\n`;
                for (const entry of contextBuffer.executionHistory) {
                    prompt += `- **${entry.nodeLabel}** produced: ${entry.outputKeys.join(', ')}\n`;
                }
                prompt += `\n`;
            }
            prompt += `CRITICAL: Build upon previous results.\n\n`;
        }

        prompt += `## Node: ${nodeLabel}\n`;
        if (nodeDescription) prompt += `## Instructions: ${nodeDescription}\n`;

        if (hasInput) {
            prompt += `\n## Input State:\n${JSON.stringify(inputState, null, 2)}\n`;
        }

        prompt += `\n## Required Output Keys: ${JSON.stringify(outputKeys)}\n`;
        prompt += `Return ONLY a valid JSON object matching these keys.\n`;

        const response = await ai.models.generateContent({
            model: AI_CONFIG.geminiModel,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: Object.fromEntries(
                        outputKeys.map(key => [key, { type: Type.STRING }])
                    ),
                    required: outputKeys
                }
            }
        });

        const text = cleanJsonResponse(response.text || '');
        return JSON.parse(text);
    } catch (error) {
        console.error('Error executing node action:', error);
        return Object.fromEntries(
            outputKeys.map(key => [key, `Error: ${error instanceof Error ? error.message : String(error)}`])
        );
    }
};
