import { Node, Edge } from 'reactflow';
import { apiUrl } from '@config/api';

/**
 * Saved-workflow storage.
 *
 * Talks to the MySQL-backed API at `/api/workflows`. Two fixes here beyond the
 * backend swap:
 *
 * 1. The old module hardcoded `http://localhost:3234` and sent no credentials, so
 *    once the API required a session every request 401'd and the app silently
 *    fell back to localStorage — appearing to work while saving nowhere real.
 * 2. localStorage is now an explicit OFFLINE CACHE, not a shadow database. Reads
 *    fall back to it and say so through `getStorageMode()`, and a failed write is
 *    reported to the caller instead of being swallowed.
 */

const LOCAL_STORAGE_KEY = 'autoagent_saved_workflows_v1';

export interface SavedWorkflow {
  /** Server-assigned id. Absent for entries that only exist in the offline cache. */
  id?: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  initialState?: Record<string, any>;
  /** Optimistic-locking version. Pass it back on update to detect conflicts. */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  savedAt: string;
  metadata?: Record<string, any>;
  /** True when this entry came from the offline cache rather than the server. */
  offline?: boolean;
}

export type StorageMode = 'server' | 'offline';

let storageMode: StorageMode = 'server';

/** Whether the last read came from the server or the offline cache. */
export function getStorageMode(): StorageMode {
  return storageMode;
}

/** Raised when a save cannot be persisted server-side. */
export class WorkflowSaveError extends Error {
  readonly code: string;
  readonly status: number;
  /** Set for a version conflict, so the UI can offer to reload. */
  readonly currentVersion?: number;

  constructor(
    message: string,
    options: { code: string; status: number; currentVersion?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'WorkflowSaveError';
    this.code = options.code;
    this.status = options.status;
    this.currentVersion = options.currentVersion;
  }
}

// ---------------------------------------------------------------- offline cache

function readLocalWorkflows(): SavedWorkflow[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.map((w) => ({ ...w, offline: true })) : [];
  } catch {
    return [];
  }
}

function writeLocalWorkflows(workflows: SavedWorkflow[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(workflows));
  } catch {
    // Quota or private mode. The server copy is authoritative anyway.
  }
}

/** Mirror the server list locally so a later outage can still show something. */
function cacheServerList(workflows: SavedWorkflow[]): void {
  writeLocalWorkflows(workflows.map((w) => ({ ...w, offline: false })));
}

// ---------------------------------------------------------------- requests

interface ErrorBody {
  error?: string;
  message?: string;
  currentVersion?: number;
}

async function readError(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- API

/** List the caller's workflows, falling back to the offline cache. */
export async function listWorkflows(): Promise<SavedWorkflow[]> {
  try {
    const response = await fetch(apiUrl('/api/workflows'), { credentials: 'same-origin' });
    if (!response.ok) {
      storageMode = 'offline';
      console.warn(`[WorkflowStorage] Server returned ${response.status}; showing cached list.`);
      return readLocalWorkflows();
    }

    const workflows = (await response.json()) as SavedWorkflow[];
    storageMode = 'server';
    cacheServerList(workflows);
    return workflows;
  } catch (error) {
    storageMode = 'offline';
    console.warn('[WorkflowStorage] Server unreachable; showing cached list.', error);
    return readLocalWorkflows();
  }
}

/** Load one workflow by id. */
export async function loadWorkflowById(id: string): Promise<SavedWorkflow | null> {
  try {
    const response = await fetch(apiUrl(`/api/workflows/${encodeURIComponent(id)}`), {
      credentials: 'same-origin',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    storageMode = 'server';
    return (await response.json()) as SavedWorkflow;
  } catch (error) {
    console.warn('[WorkflowStorage] Falling back to cached workflow.', error);
    storageMode = 'offline';
    return readLocalWorkflows().find((w) => w.id === id) ?? null;
  }
}

/**
 * Load one workflow by name.
 * Retained because the canvas addresses saved workflows by name in its UI.
 */
export async function loadWorkflow(name: string): Promise<SavedWorkflow | null> {
  const all = await listWorkflows();
  return all.find((w) => w.name === name) ?? null;
}

/**
 * Save a workflow, replacing any existing one with the same name.
 *
 * @throws {WorkflowSaveError} when the server rejects the save. The caller must
 * surface this: silently writing to localStorage would tell the user their work
 * is safe when it is not.
 */
export async function saveWorkflow(
  name: string,
  nodes: Node[],
  edges: Edge[],
  initialState?: Record<string, any>,
  extraMetadata?: Record<string, any>,
): Promise<SavedWorkflow> {
  const payload = {
    name,
    nodes,
    edges,
    initialState,
    metadata: extraMetadata ?? {},
  };

  let response: Response;
  try {
    response = await fetch(apiUrl('/api/workflows'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    // Keep a local copy so the work is recoverable, but still tell the caller
    // the save did not reach the server.
    const cached = readLocalWorkflows().filter((w) => w.name !== name);
    writeLocalWorkflows([
      ...cached,
      { ...payload, savedAt: new Date().toISOString(), offline: true } as SavedWorkflow,
    ]);
    storageMode = 'offline';
    throw new WorkflowSaveError(
      'Could not reach the server. A local copy was kept, but this workflow is not saved yet.',
      { code: 'network_error', status: 0, cause },
    );
  }

  if (!response.ok) {
    const body = await readError(response);
    if (response.status === 401) {
      throw new WorkflowSaveError('Your session expired. Sign in again to save.', {
        code: 'unauthenticated',
        status: 401,
      });
    }
    if (response.status === 409) {
      throw new WorkflowSaveError(
        body.message ?? 'This workflow was changed elsewhere. Reload before saving again.',
        { code: body.error ?? 'conflict', status: 409, currentVersion: body.currentVersion },
      );
    }
    throw new WorkflowSaveError(body.message ?? `Save failed (${response.status}).`, {
      code: body.error ?? 'save_failed',
      status: response.status,
    });
  }

  const saved = (await response.json()) as SavedWorkflow;
  storageMode = 'server';
  return saved;
}

/**
 * Update a workflow by id using optimistic locking.
 * Pass the `version` that was read so a concurrent edit is reported.
 */
export async function updateWorkflow(
  id: string,
  changes: Partial<Pick<SavedWorkflow, 'name' | 'nodes' | 'edges' | 'initialState' | 'metadata'>>,
  version?: number,
): Promise<SavedWorkflow> {
  const response = await fetch(apiUrl(`/api/workflows/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ...changes, version }),
  });

  if (!response.ok) {
    const body = await readError(response);
    throw new WorkflowSaveError(body.message ?? `Update failed (${response.status}).`, {
      code: body.error ?? 'update_failed',
      status: response.status,
      currentVersion: body.currentVersion,
    });
  }

  storageMode = 'server';
  return (await response.json()) as SavedWorkflow;
}

/** Delete a workflow by id. */
export async function deleteWorkflowById(id: string): Promise<void> {
  const response = await fetch(apiUrl(`/api/workflows/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    credentials: 'same-origin',
  });

  if (!response.ok && response.status !== 404) {
    const body = await readError(response);
    throw new WorkflowSaveError(body.message ?? `Delete failed (${response.status}).`, {
      code: body.error ?? 'delete_failed',
      status: response.status,
    });
  }

  writeLocalWorkflows(readLocalWorkflows().filter((w) => w.id !== id));
}

/**
 * Delete a workflow by name.
 * Resolves the name to an id first, since the API is id-addressed.
 */
export async function deleteWorkflow(name: string): Promise<void> {
  const existing = (await listWorkflows()).find((w) => w.name === name);
  if (!existing?.id) {
    // Only ever existed offline; drop the cached copy.
    writeLocalWorkflows(readLocalWorkflows().filter((w) => w.name !== name));
    return;
  }
  await deleteWorkflowById(existing.id);
}

/** The status of a recorded run. Mirrors the server enum. */
export type RunStatus = 'completed' | 'failed' | 'running' | 'cancelled';

/** One persisted run, as returned by the run-history API. */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
  nodeCount: number | null;
  failureCount: number | null;
  failureKind: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

/** The observability detail a caller may attach to a recorded run. */
export interface RunOutcome {
  status: RunStatus;
  provider?: string;
  model?: string;
  durationMs?: number;
  nodeCount?: number;
  failureCount?: number;
  failureKind?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Record the outcome of a run against a saved workflow.
 *
 * Best effort: a run already happened, so failing to annotate it must not surface
 * as an error to the user. Sends whatever observability detail the caller has —
 * duration, node/failure counts, the failure reason — all optional so the server
 * accepts a bare {name, status} too.
 */
export async function recordWorkflowRun(name: string, outcome: RunOutcome): Promise<void> {
  try {
    // Trim an over-long error before it hits the wire; the server also caps it.
    const body = { name, ...outcome, error: outcome.error?.slice(0, 500) };
    await fetch(apiUrl('/api/workflows/runs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.warn('[WorkflowStorage] Could not record the run outcome.', error);
  }
}

/**
 * Fetch run history. With no id, the caller's most recent runs across all
 * workflows; with an id, that workflow's runs. Best effort: returns [] on any
 * failure so a history panel degrades to empty rather than throwing.
 */
export async function listWorkflowRuns(workflowId?: string, limit = 25): Promise<WorkflowRun[]> {
  const path = workflowId
    ? `/api/workflows/${encodeURIComponent(workflowId)}/runs?limit=${limit}`
    : `/api/workflows/runs?limit=${limit}`;
  try {
    const res = await fetch(apiUrl(path), { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.runs) ? (data.runs as WorkflowRun[]) : [];
  } catch (error) {
    console.warn('[WorkflowStorage] Could not load run history.', error);
    return [];
  }
}
