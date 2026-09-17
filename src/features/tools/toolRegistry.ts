import { Tool, ToolStatus, ToolAuth } from './types';

// ==================== TOOL REGISTRY ====================

const tools = new Map<string, Tool>();

/** Register a tool in the central registry */
export function registerTool(tool: Tool): void {
    tools.set(tool.id, tool);
}

/** Get a tool by ID */
export function getTool(id: string): Tool | undefined {
    return tools.get(id);
}

/** Get all registered tools */
export function getAllTools(): Tool[] {
    return Array.from(tools.values());
}

/** Get only authenticated tools */
export function getAuthenticatedTools(): Tool[] {
    return getAllTools().filter(t => t.isAuthenticated());
}

export interface ReusableToolTemplate {
    id: string;
    toolId: string;
    toolName: string;
    toolAction: string;
    label: string;
    description: string;
    inputKeys: string[];
    outputKeys: string[];
    score: number;
}

export interface CapabilityMatch {
    toolId: string;
    toolName: string;
    actionName: string;
    score: number;
    rationale: string[];
}

/**
 * Compact, serialisable description of every registered tool.
 *
 * This is what the planner sends to the model, and it is the ONLY source of
 * truth the model may bind a step to. If a capability is absent here, the
 * planner must mark the step unsupported rather than substitute a different
 * tool. Task 6 enriches each action with schemas and side-effect class.
 */
export function describeCatalog(): Array<{
    id: string;
    name: string;
    description: string;
    capabilities: string[];
    authenticated: boolean;
    actions: Array<{
        name: string;
        description: string;
        inputKeys: string[];
        outputKeys: string[];
    }>;
}> {
    return getAllTools().map(tool => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        capabilities: tool.capabilities ?? [],
        authenticated: tool.isAuthenticated(),
        actions: tool.actions.map(action => ({
            name: action.name,
            description: action.description,
            inputKeys: action.inputKeys,
            outputKeys: action.outputKeys
        }))
    }));
}

export function getToolCapabilityMatches(searchText: string): CapabilityMatch[] {
    return rankToolMatches(searchText);
}

/** Normalize text to compare prompts against tool/action names reliably. */
function normalizeToolText(value: string): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Finds the best matching built-in tool action based on the user prompt or node text. */
export function findReusableToolTemplate(searchText: string): ReusableToolTemplate | null {
    const matches = rankToolMatches(searchText);
    if (matches.length === 0) return null;

    const best = matches[0];
    const tool = getTool(best.toolId);
    const action = tool?.actions.find(a => a.name === best.actionName);
    if (!tool || !action) return null;

    return {
        id: `${tool.id}_${action.name}`,
        toolId: tool.id,
        toolName: tool.name,
        toolAction: action.name,
        label: `${tool.name}: ${action.name.replace(/_/g, ' ')}`,
        description: action.description,
        inputKeys: action.inputKeys,
        outputKeys: action.outputKeys,
        score: best.score
    };
}

/** Rank built-in tools and actions for a given prompt using semantic capability matching. */
export function rankToolMatches(searchText: string): CapabilityMatch[] {
    const normalized = normalizeToolText(searchText);
    if (!normalized) return [];

    const candidates: CapabilityMatch[] = [];

    for (const tool of getAllTools()) {
        const toolVariants = [
            tool.name,
            tool.id,
            tool.description,
            ...(tool.capabilities || [])
        ].map(normalizeToolText).filter(Boolean);

        for (const action of tool.actions) {
            const actionVariants = [
                action.name,
                action.name.replace(/_/g, ' '),
                action.description,
                ...(action.capabilities || []),
                `${tool.name} ${action.name}`,
                `${tool.name} ${action.name.replace(/_/g, ' ')}`
            ].map(normalizeToolText).filter(Boolean);

            let score = 0;
            const rationale: string[] = [];

            for (const variant of [...toolVariants, ...actionVariants]) {
                if (!variant) continue;

                if (normalized.includes(variant)) {
                    score += 12;
                    rationale.push(`matches ${variant}`);
                }

                if (variant.split(' ').every(word => normalized.includes(word))) {
                    score += 6;
                    rationale.push(`contains key words from ${variant}`);
                }

                if (normalized.includes(tool.name.toLowerCase()) || normalized.includes(action.name.replace(/_/g, ' ').toLowerCase())) {
                    score += 5;
                }
            }

            if (tool.capabilities?.some(cap => normalized.includes(normalizeToolText(cap)))) {
                score += 8;
            }

            if (action.capabilities?.some(cap => normalized.includes(normalizeToolText(cap)))) {
                score += 10;
            }

            if (score > 0) {
                candidates.push({
                    toolId: tool.id,
                    toolName: tool.name,
                    actionName: action.name,
                    score,
                    rationale: [...new Set(rationale)]
                });
            }
        }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, 10);
}

/** Get status summary for all tools (used by UI) */
export function getToolStatuses(): ToolStatus[] {
    return getAllTools().map(t => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        color: t.color,
        authenticated: t.isAuthenticated(),
        actions: t.actions.map(a => ({ name: a.name, description: a.description }))
    }));
}

// ==================== TOKEN PERSISTENCE ====================

const STORAGE_PREFIX = 'tool_auth_';

/** Save a tool's auth token to localStorage */
export function saveToolAuth(auth: ToolAuth): void {
    if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(STORAGE_PREFIX + auth.toolId, JSON.stringify(auth));
    }
}

/**
 * Load a tool's auth token from localStorage.
 * Returns the stored auth even if it is expired — callers decide what to do.
 * The `expired` field is set to true when the token has passed its expiresAt.
 */
export function loadToolAuth(toolId: string): (ToolAuth & { expired?: boolean }) | null {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = localStorage.getItem(STORAGE_PREFIX + toolId);
    if (!raw) return null;

    try {
        const auth = JSON.parse(raw) as ToolAuth;
        // Don't delete expired tokens — just flag them so connectors can try to refresh
        if (auth.expiresAt < Date.now()) {
            return { ...auth, expired: true };
        }
        return auth;
    } catch {
        return null;
    }
}

/** Remove a tool's auth token from localStorage */
export function clearToolAuth(toolId: string): void {
    if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(STORAGE_PREFIX + toolId);
    }
}

// ==================== SILENT TOKEN REFRESH ====================

/**
 * Attempt a silent token refresh for a Google OAuth-based tool.
 * Uses GIS `requestAccessToken({ prompt: '' })` for a non-interactive refresh.
 * Returns true if successful.
 */
export function silentRefreshGoogleToken(toolId: string, scopes: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const google = (window as any).google;
            if (!google?.accounts?.oauth2) {
                resolve(false);
                return;
            }

            const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID ||
                (typeof process !== 'undefined' && (process as any).env?.GOOGLE_CLIENT_ID);
            if (!clientId) { resolve(false); return; }

            const client = google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: scopes.join(' '),
                prompt: '',
                callback: (response: any) => {
                    if (response.error) {
                        console.warn(`⚠️ [${toolId}] Silent refresh failed:`, response.error);
                        resolve(false);
                        return;
                    }
                    const auth: ToolAuth = {
                        toolId,
                        accessToken: response.access_token,
                        expiresAt: Date.now() + (response.expires_in * 1000),
                        scopes
                    };
                    saveToolAuth(auth);
                    console.log(`🔄 [${toolId}] Token silently refreshed — expires in ${response.expires_in}s`);
                    resolve(true);
                }
            });
            client.requestAccessToken();
        } catch {
            resolve(false);
        }
    });
}

// ==================== PROACTIVE REFRESH TIMER ====================

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const REFRESH_BUFFER_MS = 5 * 60 * 1000;   // refresh if <5 min left

let refreshTimerStarted = false;

/**
 * Start a background timer that proactively refreshes Google tokens
 * before they expire. Called once at app init.
 */
export function startTokenRefreshTimer(): void {
    if (refreshTimerStarted) return;
    refreshTimerStarted = true;

    setInterval(() => {
        for (const tool of getAllTools()) {
            const auth = loadToolAuth(tool.id);
            if (!auth) continue;

            const timeLeft = auth.expiresAt - Date.now();
            // If token is expired or about to expire in < 5 min, try silent refresh
            if (timeLeft < REFRESH_BUFFER_MS && tool.scopes.length > 0) {
                console.log(`⏰ [${tool.id}] Token expiring in ${Math.round(timeLeft / 1000)}s — attempting refresh`);
                silentRefreshGoogleToken(tool.id, tool.scopes);
            }
        }
    }, REFRESH_INTERVAL_MS);

    console.log('🔁 Token refresh timer started (checking every 5 min)');
}
