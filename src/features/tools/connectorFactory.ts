import {
    FieldSchemaMap,
    SideEffect,
    Tool,
    ToolActionDefinition,
    ToolDefinition
} from './types';
import { getTool, registerTool } from './toolRegistry';
import { requestConnectorDefinition } from '@features/ai/services/aiClient';


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
/**
 * Classify a generated action by its HTTP method.
 *
 * A generated connector has no declared safety class, so it is inferred
 * conservatively: anything that is not a plain read is treated as at least a
 * write, and DELETE is treated as irreversible so it gates on approval.
 */
function inferSideEffect(method: string): SideEffect {
    const verb = (method || 'GET').toUpperCase();
    if (verb === 'GET' || verb === 'HEAD') return 'read';
    if (verb === 'DELETE') return 'irreversible';
    return 'write';
}

/** Build a minimal schema from a bare key list. */
function schemaFromKeys(keys: string[], role: 'input' | 'output'): FieldSchemaMap {
    return Object.fromEntries(
        (keys ?? []).map(key => [
            key,
            {
                type: 'string' as const,
                description: `Generated connector ${role} field "${key}".`
            }
        ])
    );
}

export const createDynamicConnector = (config: GeneratedConnectorConfig): Tool => {
    const toolId = config.id;
    const actions: ToolActionDefinition[] = config.actions.map(action => ({
        name: action.name,
        description: action.description,
        // A generated connector's purpose is not known to the taxonomy, so it
        // advertises no capability and the planner will not auto-select it.
        capabilities: [],
        sideEffect: inferSideEffect(action.method),
        requiresAuth: config.authType !== 'none',
        inputSchema: schemaFromKeys(action.inputKeys, 'input'),
        outputSchema: schemaFromKeys(action.outputKeys, 'output'),
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

    const tool: ToolDefinition = {
        id: toolId,
        name: config.name,
        description: config.description,
        icon: 'Zap',
        color: '#A78BFA',
        category: 'generated',
        // Unproven code paths, so ranked below the hand-written connectors.
        costProfile: { latencyMs: 1500, cost: 1, reliability: 4 },
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
    // registerTool derives inputKeys/outputKeys, so read the registered copy back
    // rather than returning the pre-normalised definition.
    return getTool(toolId) as Tool;
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
    try {
        // The prompt template lives server-side (server/ai/prompts.js) so the
        // provider key never reaches the browser.
        const { connector } = await requestConnectorDefinition({
            toolName,
            toolDescription,
            requiredActions,
            model
        });
        return connector as GeneratedConnectorConfig;
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
