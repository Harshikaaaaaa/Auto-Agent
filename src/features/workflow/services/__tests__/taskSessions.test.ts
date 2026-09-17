import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_SESSIONS_STORAGE_KEY,
  createChatTaskSession,
  createNodeId,
  deriveTaskNameFromPrompt,
  isMeaningfulWorkflowPrompt,
  loadStoredTaskDrafts,
  loadStoredTaskSessions,
  normalizeTaskTitle,
} from '../taskSessions';

/**
 * These pure helpers were module-scope functions buried in the ~2350-line
 * WorkflowCanvas. Extracting them (Task 14) is what makes this test possible.
 */

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('deriveTaskNameFromPrompt', () => {
  it('title-cases the first few words', () => {
    expect(deriveTaskNameFromPrompt('send a summary email to the team')).toBe(
      'Send A Summary Email To The',
    );
  });

  it('falls back to "Task" for empty or symbol-only input', () => {
    expect(deriveTaskNameFromPrompt('')).toBe('Task');
    expect(deriveTaskNameFromPrompt('   ')).toBe('Task');
    expect(deriveTaskNameFromPrompt('!!! ???')).toBe('Task');
  });

  it('clamps a long name with an ellipsis', () => {
    const name = deriveTaskNameFromPrompt(
      'extraordinarily verbose descriptive workflow naming situation here',
    );
    expect(name.length).toBeLessThanOrEqual(28);
    expect(name.endsWith('...')).toBe(true);
  });
});

describe('normalizeTaskTitle', () => {
  it('trims, falls back, and clamps', () => {
    expect(normalizeTaskTitle('  Lead follow-up  ')).toBe('Lead follow-up');
    expect(normalizeTaskTitle('')).toBe('Task');
    expect(normalizeTaskTitle('a'.repeat(40)).endsWith('...')).toBe(true);
  });
});

describe('createNodeId', () => {
  it('slugs the prefix and is unique per call', () => {
    const a = createNodeId('Send Email!');
    const b = createNodeId('Send Email!');
    expect(a.startsWith('send_email_')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('falls back to "node" for an empty prefix', () => {
    expect(createNodeId('').startsWith('node_')).toBe(true);
  });
});

describe('createChatTaskSession', () => {
  it('produces a normalised name and a welcome message', () => {
    const session = createChatTaskSession('  My Task  ', 1);
    expect(session.name).toBe('My Task');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(session.workflow).toEqual({ nodes: [], edges: [] });
  });
});

describe('loadStoredTaskSessions', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(loadStoredTaskSessions()).toEqual([]);
  });

  it('repairs partial entries rather than throwing', () => {
    localStorage.setItem(
      TASK_SESSIONS_STORAGE_KEY,
      JSON.stringify([{ name: 'Kept' }, { id: 't2', name: 'Two', messages: 'not-an-array' }]),
    );

    const sessions = loadStoredTaskSessions();
    expect(sessions).toHaveLength(2);
    // A missing id is synthesised, a bad messages array is replaced with a welcome.
    expect(sessions[0].id).toBeTruthy();
    expect(Array.isArray(sessions[0].messages)).toBe(true);
    expect(Array.isArray(sessions[1].messages)).toBe(true);
    expect(sessions[1].workflow).toEqual({ nodes: [], edges: [] });
  });

  it('returns an empty list on corrupt JSON without throwing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(TASK_SESSIONS_STORAGE_KEY, '{not json');
    expect(loadStoredTaskSessions()).toEqual([]);
  });
});

describe('loadStoredTaskDrafts', () => {
  it('returns an object or empty, never throws', () => {
    expect(loadStoredTaskDrafts()).toEqual({});
    localStorage.setItem('autoagent_task_drafts_v1', JSON.stringify({ t1: 'draft' }));
    expect(loadStoredTaskDrafts()).toEqual({ t1: 'draft' });
  });
});

describe('isMeaningfulWorkflowPrompt', () => {
  it('accepts a real automation goal', () => {
    const result = isMeaningfulWorkflowPrompt('scrape a page and email me the summary');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.normalized).toContain('scrape');
  });

  it.each(['', '   ', 'hi', 'asdf', 'test', 'nothing here really'])(
    'rejects the vague/random prompt %j',
    (prompt) => {
      expect(isMeaningfulWorkflowPrompt(prompt).valid).toBe(false);
    },
  );

  it('gives a reason when it rejects', () => {
    const result = isMeaningfulWorkflowPrompt('asdf');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason.length).toBeGreaterThan(0);
  });
});
