// ==================== TOOL SYSTEM TYPES ====================

/** A registered tool/connector (e.g. Gmail, Slack, Sheets) */
export interface Tool {
    id: string;
    name: string;
    description: string;
    icon: string;                   // lucide-react icon name
    color: string;                  // hex color for UI
    category?: string;              // e.g. communication, storage, spreadsheet, messaging
    capabilities?: string[];        // semantic capability tags
    scopes: string[];               // OAuth scopes required
    actions: ToolAction[];          // what this tool can do in a workflow
    isAuthenticated: () => boolean; // checks if a valid token exists
    authenticate: () => Promise<void>;
    disconnect: () => void;
}

/** A single action a tool can perform inside a workflow node */
export interface ToolAction {
    name: string;                   // e.g. 'send_email'
    description: string;
    capabilities?: string[];        // semantic tags for this action
    inputKeys: string[];            // state keys this action reads
    outputKeys: string[];           // state keys this action writes
    execute: (input: Record<string, any>) => Promise<Record<string, any>>;
}

/** Persisted OAuth token for a tool */
export interface ToolAuth {
    toolId: string;
    accessToken: string;
    expiresAt: number;              // epoch ms
    scopes: string[];
}

/** Tool status for UI display */
export interface ToolStatus {
    id: string;
    name: string;
    icon: string;
    color: string;
    authenticated: boolean;
    actions: { name: string; description: string }[];
}
