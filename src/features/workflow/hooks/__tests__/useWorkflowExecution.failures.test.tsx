import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Node } from 'reactflow';
import { NodeType } from '@/shared/types';
import type { ExecutionLog, FlowEdge } from '@features/workflow/types';
import { registerTool } from '@features/tools/toolRegistry';
import { useWorkflowExecution } from '../useWorkflowExecution';

/**
 * Task 12 tests: what the engine does when a step fails.
 *
 * Three defects, each with assertions here.
 *
 * 1. A failed step could be recorded as a SUCCESS. Tool failures were detected
 *    by checking `email_status` or `status` for the substrings 'error', 'failed'
 *    or 'validation failed'. Gmail reports an expired token as "Authentication
 *    expired. Please reconnect Gmail and retry.", a throttle as "Gmail rate limit
 *    exceeded after 3 retries." and a bad address as "Recipient ... was rejected
 *    by Gmail." — none of which contain any of those substrings. All three
 *    surfaced as successful sends. `web.fetch_page`'s `{ error }` and
 *    `files.download_file`'s `{ downloaded: false }` were never checked at all.
 *
 * 2. Every failure was retried twice, immediately, whatever it was.
 *
 * 3. A failed AI node returned the error text under each output key, so the run
 *    continued with "Error: provider unavailable" as its data.
 */

/** Calls made by the fake connectors, so retries are countable. */
let calls: string[] = [];
/** Result each action returns, set per test. */
let scripted: Record<string, () => Promise<Record<string, unknown>>> = {};

function registerFailureTools() {
  registerTool({
    id: 'test_flaky',
    name: 'Test Flaky',
    description: 'A connector whose results the test controls.',
    icon: 'Zap',
    color: '#000000',
    category: 'testing',
    scopes: [],
    costProfile: { latencyMs: 1, cost: 0, reliability: 5 },
    actions: [
      {
        name: 'read_thing',
        description: 'A retryable read.',
        capabilities: ['web.fetch'],
        sideEffect: 'read',
        requiresAuth: false,
        inputSchema: {},
        outputSchema: { thing: { type: 'string', description: 'What it read.' } },
        execute: async () => {
          calls.push('read_thing');
          return scripted.read_thing ? scripted.read_thing() : { thing: 'ok' };
        },
      },
      {
        name: 'send_thing',
        description: 'An irreversible send.',
        capabilities: ['chat.send'],
        sideEffect: 'irreversible',
        requiresAuth: false,
        inputSchema: {},
        outputSchema: { sent: { type: 'boolean', description: 'Whether it went.' } },
        execute: async () => {
          calls.push('send_thing');
          return scripted.send_thing ? scripted.send_thing() : { sent: true };
        },
      },
      {
        name: 'write_thing',
        description: 'A correctable write.',
        capabilities: ['spreadsheet.write'],
        sideEffect: 'write',
        requiresAuth: false,
        inputSchema: {
          sheet_id: {
            type: 'string',
            description: 'Which sheet.',
            required: true,
            external: true,
          },
        },
        outputSchema: { written: { type: 'boolean', description: 'Whether it wrote.' } },
        execute: async () => {
          calls.push('write_thing');
          return scripted.write_thing ? scripted.write_thing() : { written: true };
        },
      },
    ],
    isAuthenticated: () => true,
    authenticate: async () => {},
    disconnect: () => {},
  });

  registerTool({
    id: 'test_locked',
    name: 'Test Locked',
    description: 'A connector that is never connected.',
    icon: 'Lock',
    color: '#000000',
    category: 'testing',
    scopes: [],
    actions: [
      {
        name: 'peek',
        description: 'Read something.',
        capabilities: ['chat.read'],
        sideEffect: 'read',
        requiresAuth: true,
        inputSchema: {},
        outputSchema: { seen: { type: 'boolean', description: 'Whether it read.' } },
        execute: async () => {
          calls.push('peek');
          return { seen: true };
        },
      },
    ],
    isAuthenticated: () => false,
    authenticate: async () => {},
    disconnect: () => {},
  });
}

function toolNode(
  id: string,
  toolId: string,
  toolAction: string,
  data: Record<string, unknown> = {},
): Node {
  return {
    id,
    type: 'tool',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: NodeType.TOOL,
      toolId,
      toolAction,
      stateContract: { inputKeys: [], outputKeys: ['thing'] },
      ...data,
    },
  };
}

interface RunResult {
  status: string;
  logs: ExecutionLog[];
  state: Record<string, unknown> | null;
}

async function run(nodes: Node[], edges: FlowEdge[] = []): Promise<RunResult> {
  const { result } = renderHook(() =>
    // Approval is auto-granted: this suite is about failure, not gating.
    useWorkflowExecution(nodes, edges, vi.fn(), async () => true),
  );

  await act(async () => {
    await result.current.executeFlow();
  });
  await waitFor(() => {
    expect(['completed', 'failed', 'paused', 'cancelled']).toContain(result.current.runtimeStatus);
  });

  return {
    status: result.current.runtimeStatus,
    logs: result.current.executionLogs,
    state: result.current.graphState as Record<string, unknown> | null,
  };
}

/** The single failed log entry. */
function failure(logs: ExecutionLog[]): ExecutionLog {
  const failed = logs.filter((log) => log.status === 'failed');
  expect(failed).toHaveLength(1);
  return failed[0];
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  scripted = {};
  registerFailureTools();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a failed step is not recorded as a success', () => {
  it('fails the run when an action returns an error', async () => {
    scripted.read_thing = async () => ({ error: 'The page could not be reached.' });

    const { status, logs } = await run([toolNode('fetch', 'test_flaky', 'read_thing')]);

    expect(status).toBe('failed');
    expect(failure(logs).output).toContain('The page could not be reached.');
  });

  it.each([
    ['Authentication expired. Please reconnect Gmail and retry.', 'auth'],
    ['Gmail rate limit exceeded after 3 retries. Try again later.', 'rate_limit'],
    ['Recipient "nobody@" was rejected by Gmail. Verify the address.', 'invalid_input'],
    ['Email exceeds Gmail 25 MB limit. Consider using a Google Drive link.', 'invalid_input'],
  ])('catches the Gmail message %j that the old sniff reported as sent', async (message, kind) => {
    scripted.send_thing = async () => ({ sent: false, error: message });

    const { status, logs } = await run([toolNode('send', 'test_flaky', 'send_thing')]);

    // Every one of these used to reach the user as a successful send.
    expect(status).toBe('failed');
    expect(failure(logs).failureKind).toBe(kind);
  });

  it('catches an explicit false success flag', async () => {
    scripted.read_thing = async () => ({ downloaded: false });

    const { status } = await run([toolNode('save', 'test_flaky', 'read_thing')]);

    expect(status).toBe('failed');
  });

  it('does not merge a failed action output into graph state', async () => {
    scripted.read_thing = async () => ({ thing: 'half-written', error: 'It broke.' });

    const { state } = await run([toolNode('fetch', 'test_flaky', 'read_thing')]);

    // A later step must not consume data from a step that failed.
    expect(state?.thing).toBeUndefined();
  });

  it('stops the run so downstream steps do not execute', async () => {
    scripted.read_thing = async () => ({ error: 'It broke.' });

    await run(
      [toolNode('fetch', 'test_flaky', 'read_thing'), toolNode('send', 'test_flaky', 'send_thing')],
      [{ id: 'e', source: 'fetch', target: 'send' } as FlowEdge],
    );

    expect(calls).not.toContain('send_thing');
  });

  it('still succeeds when the action reports no error', async () => {
    const { status, state } = await run([toolNode('fetch', 'test_flaky', 'read_thing')]);

    expect(status).toBe('completed');
    expect(state?.thing).toBe('ok');
  });

  it('treats an empty error string as success, not failure', async () => {
    scripted.read_thing = async () => ({ thing: 'fine', error: '' });

    const { status } = await run([toolNode('fetch', 'test_flaky', 'read_thing')]);

    expect(status).toBe('completed');
  });
});

describe('retries are decided by why it failed', () => {
  it('retries a transient failure and reports the classification', async () => {
    scripted.read_thing = async () => ({ error: 'The request timed out.' });

    const { logs } = await run([toolNode('fetch', 'test_flaky', 'read_thing')]);

    // One initial attempt plus MAX_RETRY_ATTEMPTS.
    expect(calls.filter((c) => c === 'read_thing')).toHaveLength(3);
    const retries = logs.filter((log) => log.status === 'retrying');
    expect(retries).toHaveLength(2);
    expect(retries[0].failureKind).toBe('transient');
    expect(retries[0].output).toMatch(/Retrying in \d+ms \(attempt 1 of 2\)/);
    expect(failure(logs).output).toContain('Gave up after 3 attempts');
  });

  it('retries a rate limit', async () => {
    scripted.read_thing = async () => ({ error: 'Too many requests, slow down.' });

    const { logs } = await run([toolNode('fetch', 'test_flaky', 'read_thing')]);

    expect(calls.filter((c) => c === 'read_thing')).toHaveLength(3);
    expect(failure(logs).failureKind).toBe('rate_limit');
  });

  it('does NOT retry an auth failure', async () => {
    const { status, logs } = await run([toolNode('locked', 'test_locked', 'peek')]);

    expect(status).toBe('failed');
    // The tool is never even called, and no retry is attempted.
    expect(calls).not.toContain('peek');
    expect(logs.filter((log) => log.status === 'retrying')).toHaveLength(0);
    const failed = failure(logs);
    expect(failed.failureKind).toBe('auth');
    expect(failed.output).toContain('Reconnect the tool');
    expect(failed.output).toContain('Not retried');
  });

  it('does NOT retry bad input', async () => {
    scripted.read_thing = async () => ({ error: 'Missing spreadsheetId' });

    const { logs } = await run([toolNode('write', 'test_flaky', 'read_thing')]);

    expect(calls.filter((c) => c === 'read_thing')).toHaveLength(1);
    expect(failure(logs).failureKind).toBe('invalid_input');
  });

  it('never retries an irreversible action, even on a transient failure', async () => {
    scripted.send_thing = async () => ({ error: 'The request timed out.' });

    const { logs } = await run([toolNode('send', 'test_flaky', 'send_thing')]);

    // A send that times out may already have gone through; a retry would
    // deliver twice.
    expect(calls.filter((c) => c === 'send_thing')).toHaveLength(1);
    const failed = failure(logs);
    expect(failed.failureKind).toBe('transient');
    expect(failed.output).toContain('cannot be undone');
  });

  it('does not retry an unsupported step', async () => {
    const { status, logs } = await run([
      {
        id: 'sms',
        type: 'ai_agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'Text the customer',
          type: NodeType.AI_AGENT,
          unsupported: true,
          unsupportedReason: 'No connected tool can send SMS.',
          stateContract: { inputKeys: [], outputKeys: [] },
        },
      },
    ]);

    expect(status).toBe('failed');
    expect(logs.filter((log) => log.status === 'retrying')).toHaveLength(0);
    const failed = failure(logs);
    expect(failed.failureKind).toBe('unsupported');
    expect(failed.output).toContain('No connected tool can send SMS.');
  });
});

describe('alternatives are suggested, never substituted', () => {
  it('names other providers of the same capability without calling them', async () => {
    scripted.send_thing = async () => ({ error: 'Slack is down.' });

    const { logs } = await run([toolNode('send', 'test_flaky', 'send_thing')]);

    const failed = failure(logs);
    // chat.send is also provided by slack and whatsapp.
    expect(failed.alternatives?.some((name) => name.startsWith('slack.'))).toBe(true);
    expect(failed.output).toContain('Other tools that can do this');

    // And absolutely nothing else was invoked. Rerouting a failed send to a
    // different destination is the wrong-tool substitution Tasks 8 and 10
    // removed; the user asked for this one.
    expect(calls).toEqual(['send_thing']);
  });
});

describe('pre-flight validation', () => {
  it('refuses to start when a user-supplied value is missing', async () => {
    const { status, logs } = await run([
      toolNode('write', 'test_flaky', 'write_thing', {
        label: 'Append the row',
        stateContract: {
          inputKeys: ['sheet_id'],
          outputKeys: ['written'],
          externalInputKeys: ['sheet_id'],
        },
      }),
    ]);

    expect(status).toBe('failed');
    // Nothing ran: the point is to fail before doing half the work.
    expect(calls).toEqual([]);
    expect(logs[0].output).toContain('Cannot start');
    expect(logs[0].output).toContain('Append the row needs "sheet_id"');
    expect(logs[0].failureKind).toBe('invalid_input');
  });

  it('starts when the value is supplied on the node', async () => {
    const { status } = await run([
      toolNode('write', 'test_flaky', 'write_thing', {
        sheet_id: 'abc123',
        stateContract: {
          inputKeys: ['sheet_id'],
          outputKeys: ['written'],
          externalInputKeys: ['sheet_id'],
        },
      }),
    ]);

    expect(status).toBe('completed');
    expect(calls).toContain('write_thing');
  });

  it('starts when the value arrives through initialState', async () => {
    const { status } = await run([
      toolNode('write', 'test_flaky', 'write_thing', {
        initialState: { sheet_id: 'abc123' },
        stateContract: {
          inputKeys: ['sheet_id'],
          outputKeys: ['written'],
          externalInputKeys: ['sheet_id'],
        },
      }),
    ]);

    expect(status).toBe('completed');
  });
});
