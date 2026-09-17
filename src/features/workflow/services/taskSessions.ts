import type { Edge, Node } from 'reactflow';

/**
 * Chat task-session model + persistence, extracted from WorkflowCanvas.
 *
 * These were module-scope helpers inside a ~2350-line component. They are pure
 * (or localStorage-only) and used from several call sites, so lifting them out
 * shrinks the component and — more usefully — makes them unit-testable without
 * mounting React. Nothing here touches the graph engine; it is title
 * derivation, validation, and load/save of the sidebar's task list.
 */

export type ChatMessage = { role: 'user' | 'assistant'; text: string };

export interface ChatTaskSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  workflow?: {
    nodes: Node[];
    edges: Edge[];
  };
}

export const TASK_SESSIONS_STORAGE_KEY = 'autoagent_task_sessions_v1';
export const TASK_DRAFTS_STORAGE_KEY = 'autoagent_task_drafts_v1';

/** A short Title Case name derived from the first few words of a prompt. */
export function deriveTaskNameFromPrompt(prompt: string): string {
  const cleaned = (prompt || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Task';

  const words = cleaned
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (words.length === 0) return 'Task';

  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return title.length > 28 ? `${title.slice(0, 25).trim()}...` : title;
}

/** Trim and clamp a task title, with a fallback. */
export function normalizeTaskTitle(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'Task';
  return trimmed.length > 28 ? `${trimmed.slice(0, 25).trim()}...` : trimmed;
}

/** A collision-resistant node id from a human label. */
export function createNodeId(prefix: string): string {
  const safePrefix =
    (prefix || 'node')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'node';
  const uniqueSuffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${safePrefix}_${Date.now()}_${uniqueSuffix}`;
}

export function createChatTaskSession(name: string, index: number): ChatTaskSession {
  return {
    id: `task-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    name: normalizeTaskTitle(name),
    messages: [
      {
        role: 'assistant',
        text:
          `Welcome to ${normalizeTaskTitle(name)}. Ask me to add, remove, rename, or route a step in this ` +
          'workflow. Examples: "Add approval before sending email", "Use Gmail instead of Slack", ' +
          '"Rename this step to Lead follow-up".',
      },
    ],
    workflow: { nodes: [], edges: [] },
  };
}

/**
 * Load and repair the persisted task list.
 *
 * Every field is defended because the source is localStorage, which a previous
 * app version or a hand-edit could have left in any shape. A parse failure or a
 * non-array yields an empty list rather than throwing into a render.
 */
export function loadStoredTaskSessions(): ChatTaskSession[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(TASK_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatTaskSession[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((task, idx) => {
        const name = normalizeTaskTitle(task.name || `Task ${idx + 1}`);
        return {
          id: task.id || `task-${Date.now()}-${idx + 1}`,
          name,
          messages: Array.isArray(task.messages)
            ? task.messages
            : [{ role: 'assistant', text: `Welcome to ${name}.` }],
          workflow:
            task.workflow && Array.isArray(task.workflow.nodes)
              ? {
                  nodes: task.workflow.nodes as Node[],
                  edges: Array.isArray(task.workflow.edges) ? (task.workflow.edges as Edge[]) : [],
                }
              : { nodes: [], edges: [] },
        };
      });
    }
  } catch (error) {
    console.warn('[TaskSessions] Unable to load stored tasks:', error);
  }

  return [];
}

export function loadStoredTaskDrafts(): Record<string, string> {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(TASK_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn('[TaskDrafts] Unable to load stored drafts:', error);
    return {};
  }
}

/** Result of validating a magic-generate prompt. */
export type PromptCheck = { valid: true; normalized: string } | { valid: false; reason: string };

/**
 * Reject prompts too vague or random to plan safely.
 *
 * This is a UX gate, not a security control: it keeps "asdf" or "hi" from
 * spending a model call on an empty plan. A prompt that passes still goes
 * through the validated planner, which is where correctness is enforced.
 */
export function isMeaningfulWorkflowPrompt(prompt: string): PromptCheck {
  const trimmed = (prompt || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'Describe the workflow you want to build.' };
  }

  const normalized = trimmed.toLowerCase();
  const shortHint = /^(?:hi|hello|hey|test|random|asdf|qwerty|lorem|ipsum|demo|sample|nothing|n)$/i;
  if (shortHint.test(normalized) || normalized.length < 10) {
    return {
      valid: false,
      reason:
        'This looks too vague or random to generate a safe workflow plan. Describe the actual automation goal.',
    };
  }

  if (/^(?:asdf|qwerty|hello|hi|hey|test|random|demo|lorem|ipsum|sample)\s*$/i.test(trimmed)) {
    return {
      valid: false,
      reason: 'This is not a valid workflow request. Please describe a real automation task.',
    };
  }

  const workflowSignals = [
    'email',
    'gmail',
    'slack',
    'sheet',
    'google sheets',
    'drive',
    'whatsapp',
    'notify',
    'save',
    'send',
    'summarize',
    'update',
    'create',
    'sync',
    'automate',
    'workflow',
    'trigger',
    'approval',
    'capture',
    'log',
    'archive',
    'manage',
    'monitor',
    'follow up',
    'lead',
  ];
  const hasSignal = workflowSignals.some((signal) => normalized.includes(signal));
  const hasActionVerb =
    /(create|send|save|sync|summarize|notify|update|collect|automate|monitor|trigger|archive|reply|follow|route|log|extract|analyze)/i.test(
      trimmed,
    );

  if (!hasSignal && !hasActionVerb) {
    return {
      valid: false,
      reason:
        'I can only turn real workflow goals into plans. Please describe a concrete automation task.',
    };
  }

  return { valid: true, normalized: trimmed };
}
