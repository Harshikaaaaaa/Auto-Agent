import { apiUrl } from '@config/api';
import type { CatalogTool } from '@features/tools/toolRegistry';
import type { Workflow } from '@features/workflow/types';
import type { WorkflowContextBuffer } from '../types';

/**
 * Client for the AI backend-for-frontend.
 *
 * SECURITY: the browser holds no provider API keys. Every model call goes
 * through the server, which owns the credential and the prompt. Anything that
 * needs an LLM must call through here — never `fetch` a provider directly.
 */

export type AiProviderHint = 'auto' | 'openrouter' | 'gemini' | 'ollama';

/**
 * The catalog shape is owned by the tool registry, which builds it in
 * `describeCatalog()`. It is re-exported here so callers of this client have one
 * type to work with — duplicating the interface let the two drift apart.
 */
export type { CatalogAction, CatalogField, CatalogTool } from '@features/tools/toolRegistry';

export interface AiCallMeta {
  provider: string;
  model: string;
  attempts: number;
}

/** An error raised by the AI backend, carrying enough context to act on. */
export class AiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly issues?: Array<{ path: string; message: string }>;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      retryable?: boolean;
      provider?: string;
      issues?: Array<{ path: string; message: string }>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'AiRequestError';
    this.status = options.status;
    this.code = options.code ?? 'unknown_error';
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.issues = options.issues;
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
  retryable?: boolean;
  provider?: string;
  issues?: Array<{ path: string; message: string }>;
}

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Session cookie is required once Task 3 lands; send it always.
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new AiRequestError(
      'Could not reach the AutoAgent server. Is it running?',
      { status: 0, code: 'network_error', retryable: true, cause },
    );
  }

  if (!response.ok) {
    let parsed: ErrorBody = {};
    try {
      parsed = (await response.json()) as ErrorBody;
    } catch {
      // Non-JSON error body: fall through to a generic message.
    }
    throw new AiRequestError(parsed.message ?? `The AI request failed (${response.status}).`, {
      status: response.status,
      code: parsed.error ?? 'request_failed',
      retryable: parsed.retryable ?? response.status >= 500,
      provider: parsed.provider,
      issues: parsed.issues,
    });
  }

  return (await response.json()) as TResponse;
}

// ------------------------------------------------------------------ requests

export interface PlanHint {
  toolId: string;
  actionName: string;
  score: number;
}

/** Ask the server to turn a request into a tool-bound plan. */
export async function requestPlan(input: {
  prompt: string;
  catalog: CatalogTool[];
  hints?: PlanHint[];
  provider?: AiProviderHint;
  model?: string;
  /**
   * Why the previous plan was rejected. Sent on a retry so the model is told
   * what to fix; re-issuing the identical prompt tends to reproduce the same
   * invalid answer.
   */
  repairFeedback?: string;
}): Promise<{ plan: unknown; meta: AiCallMeta }> {
  return postJson('/api/ai/plan', input);
}

/** Ask the server to turn a chat instruction into graph patch operations. */
export async function requestPatch(input: {
  message: string;
  graph: {
    nodes: Array<{
      id: string;
      label?: string;
      type?: string;
      toolId?: string | null;
      toolAction?: string | null;
    }>;
    edges?: Array<{ source: string; target: string; condition?: string | null }>;
  };
  catalog: CatalogTool[];
  provider?: AiProviderHint;
  model?: string;
}): Promise<{ patch: unknown; meta: AiCallMeta }> {
  return postJson('/api/ai/patch', input);
}

/** Run one AI-backed workflow node. */
export async function requestNodeExecution(input: {
  nodeLabel: string;
  nodeDescription?: string;
  inputState?: Record<string, unknown>;
  outputKeys: string[];
  context?: WorkflowContextBuffer;
  provider?: AiProviderHint;
  model?: string;
}): Promise<{ output: Record<string, unknown>; meta: AiCallMeta }> {
  return postJson('/api/ai/node', input);
}

/** LEGACY whole-graph generation. Superseded by `requestPlan` (Task 8). */
export async function requestWorkflow(input: {
  prompt: string;
  catalog: CatalogTool[];
  provider?: AiProviderHint;
  model?: string;
}): Promise<{ workflow: Workflow; meta: AiCallMeta }> {
  return postJson('/api/ai/workflow', input);
}

/** Generate a dynamic connector definition. */
export async function requestConnectorDefinition(input: {
  toolName: string;
  toolDescription?: string;
  requiredActions?: string[];
  provider?: AiProviderHint;
  model?: string;
}): Promise<{ connector: unknown; meta: AiCallMeta }> {
  return postJson('/api/ai/connector', input);
}

// -------------------------------------------------------------------- config

export interface PublicAiConfig {
  defaultProvider: string;
  allowProviderOverride: boolean;
  providers: Record<string, { configured: boolean; model: string }>;
}

/** Which providers the server can actually use. Safe to call from the browser. */
export async function fetchAiConfig(): Promise<PublicAiConfig> {
  const response = await fetch(apiUrl('/api/ai/config'), { credentials: 'same-origin' });
  if (!response.ok) {
    throw new AiRequestError(`Could not load AI configuration (${response.status}).`, {
      status: response.status,
      code: 'config_unavailable',
    });
  }
  return (await response.json()) as PublicAiConfig;
}
