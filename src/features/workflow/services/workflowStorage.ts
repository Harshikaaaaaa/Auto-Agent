import { Node, Edge } from 'reactflow';

const API_URL = 'http://localhost:3234/workflows';
const LOCAL_STORAGE_KEY = 'autoagent_saved_workflows_v1';

function readLocalWorkflows(): SavedWorkflow[] {
    if (typeof window === 'undefined') return [];
    try {
        const value = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function writeLocalWorkflows(workflows: SavedWorkflow[]): void {
    if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(workflows));
    }
}

export interface SavedWorkflow {
    name: string;
    nodes: Node[];
    edges: Edge[];
    initialState?: Record<string, any>;
    savedAt: string;
    version?: number;
    lastRunAt?: string;
    runCount?: number;
    tags?: string[];
    provider?: string;
    metadata?: Record<string, any>;
}

export async function recordWorkflowRun(
    name: string,
    provider?: string,
    status: 'completed' | 'failed' | 'running' = 'completed'
): Promise<void> {
    const workflows = await listWorkflows();
    const workflow = workflows.find(w => w.name === name);
    if (!workflow) return;

    const nextRunCount = (workflow.runCount || 0) + 1;
    const metadata = {
        ...(workflow.metadata || {}),
        lastExecutionStatus: status,
        provider: provider || workflow.provider || 'unknown',
        runHistory: [
            ...((workflow.metadata && Array.isArray(workflow.metadata.runHistory)) ? workflow.metadata.runHistory : []),
            {
                status,
                timestamp: new Date().toISOString(),
                provider: provider || workflow.provider || 'unknown'
            }
        ].slice(-20)
    };

    await saveWorkflow(workflow.name, workflow.nodes, workflow.edges, workflow.initialState, {
        ...workflow,
        provider: provider || workflow.provider || 'unknown',
        lastRunAt: new Date().toISOString(),
        runCount: nextRunCount,
        tags: workflow.tags || ['workflow'],
        version: workflow.version || 1,
        metadata
    });
}

/**
 * Saves a workflow to the backend.
 */
export async function saveWorkflow(
    name: string,
    nodes: Node[],
    edges: Edge[],
    initialState?: Record<string, any>,
    extraMetadata?: Record<string, any>
): Promise<void> {
    const payload = {
        name,
        nodes,
        edges,
        initialState,
        version: 1,
        savedAt: new Date().toISOString(),
        lastRunAt: extraMetadata?.lastRunAt || undefined,
        runCount: extraMetadata?.runCount || 0,
        tags: extraMetadata?.tags || [],
        provider: extraMetadata?.provider || 'unknown',
        metadata: extraMetadata || {}
    };
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Failed to save workflow');
    } catch (error) {
        const localWorkflows = readLocalWorkflows().filter(workflow => workflow.name !== name);
        writeLocalWorkflows([...localWorkflows, payload as SavedWorkflow]);
        console.warn('[WorkflowStorage] Backend unavailable; saved workflow locally.', error);
    }
}

/**
 * Loads a workflow by name from the backend.
 */
export async function loadWorkflow(name: string): Promise<SavedWorkflow | null> {
    const all = await listWorkflows();
    return all.find(w => w.name === name) || null;
}

/**
 * Lists all saved workflows from the backend.
 */
export async function listWorkflows(): Promise<SavedWorkflow[]> {
    try {
        const res = await fetch(API_URL);
        if (!res.ok) return readLocalWorkflows();
        return await res.json();
    } catch (e) {
        console.error('Failed to list workflows:', e);
        return readLocalWorkflows();
    }
}

/**
 * Deletes a saved workflow by name.
 */
export async function deleteWorkflow(name: string): Promise<void> {
    try {
        const res = await fetch(`${API_URL}/${name}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete workflow');
    } catch (error) {
        writeLocalWorkflows(readLocalWorkflows().filter(workflow => workflow.name !== name));
        console.warn('[WorkflowStorage] Backend unavailable; deleted local workflow.', error);
    }
}
