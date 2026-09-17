import { Tool, ToolAction } from './types';
import { registerTool } from './toolRegistry';

const getOpenRouterKey = () => {
    if (typeof process !== 'undefined' && process.env) {
        return process.env['OPENROUTER_API_KEY'];
    }
    return '';
};


export interface GeneratedConnectorConfig {
    id: string;
    name: string;
    description: string;
    apiEndpoint?: string;
    authType: 'oauth2' | 'apikey' | 'none';
    actions: Array<{
        name: string;
        description: string;
        method: string;
        endpoint: string;
        inputKeys: string[];
        outputKeys: string[];
    }>;
}

/**
 * Dynamically create a connector based on a specification
 */
export const createDynamicConnector = (config: GeneratedConnectorConfig): Tool => {
    const toolId = config.id;
    const actions: ToolAction[] = config.actions.map(action => ({
        name: action.name,
        description: action.description,
        inputKeys: action.inputKeys,
        outputKeys: action.outputKeys,
        execute: async (input: Record<string, any>) => {
            try {
                const url = `${config.apiEndpoint}${action.endpoint}`;
                const opts: RequestInit = {
                    method: action.method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(input)
                };

                const res = await fetch(url, opts);
                const data = await res.json();

                if (!res.ok) return { error: data.message || 'API call failed' };

                // Map response to outputKeys
                const output: Record<string, any> = {};
                for (const key of action.outputKeys) {
                    output[key] = data[key] || data;
                }
                return output;
            } catch (err) {
                return { error: String(err) };
            }
        }
    }));

    const tool: Tool = {
        id: toolId,
        name: config.name,
        description: config.description,
        icon: 'Zap',
        color: '#A78BFA',
        scopes: [],
        actions,
        isAuthenticated: () => {
            // For now, assume dynamic connectors are always available
            // Auth can be added per-action if needed
            return true;
        },
        authenticate: async () => {
            // Dynamic connectors don't need auth setup
            return Promise.resolve();
        },
        disconnect: () => {
            // Nothing to disconnect
        }
    };

    registerTool(tool);
    return tool;
};

/**
 * Generate a connector definition from AI based on requirements
 */
export const generateConnectorDefinition = async (
    toolName: string,
    toolDescription: string,
    requiredActions: string[],
    model: string
): Promise<GeneratedConnectorConfig> => {
    const prompt = `You are an API connector designer. Create a connector definition for this tool:

TOOL NAME: ${toolName}
DESCRIPTION: ${toolDescription}
REQUIRED ACTIONS: ${requiredActions.join(', ')}

Return ONLY valid JSON:
{
  "id": "tool_slug_id",
  "name": "Tool Display Name",
  "description": "What this tool does",
  "apiEndpoint": "https://api.example.com/v1",
  "authType": "apikey",
  "actions": [
    {
      "name": "action_name",
      "description": "What this action does",
      "method": "POST",
      "endpoint": "/endpoint",
      "inputKeys": ["param1"],
      "outputKeys": ["result"]
    }
  ]
}`;

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                                'Authorization': `Bearer ${getOpenRouterKey()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) throw new Error('Connector generation failed');

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty connector response');

        const config = JSON.parse(content) as GeneratedConnectorConfig;
        return config;
    } catch (err) {
        console.error('Connector generation error:', err);
        throw err;
    }
};

/**
 * Save a generated connector to localStorage for persistence
 */
export const saveGeneratedConnector = (config: GeneratedConnectorConfig) => {
    const saved = JSON.parse(localStorage.getItem('autoagent_generated_connectors') || '[]');
    saved.push({
        ...config,
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('autoagent_generated_connectors', JSON.stringify(saved));
};

/**
 * Load all previously generated connectors and register them
 */
export const loadGeneratedConnectors = () => {
    try {
        const saved = JSON.parse(localStorage.getItem('autoagent_generated_connectors') || '[]');
        saved.forEach((config: GeneratedConnectorConfig) => {
            createDynamicConnector(config);
        });
    } catch {
        console.warn('Failed to load generated connectors');
    }
};
