import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunHistoryPanel } from '../RunHistoryPanel';
import type { WorkflowRun } from '@features/workflow/services/workflowStorage';

/**
 * Task 16 tests.
 *
 * The server has always recorded runs; before this the client sent them and
 * never showed them back. These assert the panel closes that loop: it fetches
 * the run-history API, renders each run's outcome/duration, surfaces a failure
 * reason, refetches when reloadKey changes, and degrades to empty on error.
 */

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: crypto.randomUUID(),
    workflowId: 'wf-1',
    workflowName: 'Scrape to markdown',
    status: 'completed',
    provider: 'openrouter',
    model: 'gpt-oss-120b',
    durationMs: 4200,
    nodeCount: 5,
    failureCount: 0,
    failureKind: null,
    error: null,
    startedAt: '2026-09-17T10:00:00.000Z',
    finishedAt: '2026-09-17T10:00:04.200Z',
    createdAt: '2026-09-17T10:00:04.200Z',
    ...overrides,
  };
}

function stubFetch(responder: () => { ok: boolean; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const { ok, body } = responder();
      return {
        ok,
        json: async () => body,
      } as unknown as Response;
    }),
  );
}

describe('RunHistoryPanel', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders nothing when not visible', () => {
    stubFetch(() => ({ ok: true, body: { runs: [] } }));
    const { container } = render(<RunHistoryPanel isVisible={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists recorded runs with their outcome and duration', async () => {
    stubFetch(() => ({
      ok: true,
      body: { runs: [run({ status: 'completed', durationMs: 4200 })] },
    }));

    render(<RunHistoryPanel isVisible onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('run-history-item')).toBeInTheDocument());
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
    expect(screen.getByText(/Duration: 4\.2s/)).toBeInTheDocument();
    expect(screen.getByText(/Nodes: 5/)).toBeInTheDocument();
  });

  it('surfaces the failure reason on a failed run', async () => {
    stubFetch(() => ({
      ok: true,
      body: {
        runs: [
          run({
            status: 'failed',
            failureKind: 'auth',
            failureCount: 1,
            error: 'Gmail is not authenticated. Connect it first.',
          }),
        ],
      },
    }));

    render(<RunHistoryPanel isVisible onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/not authenticated/i)).toBeInTheDocument());
    // The failureKind badge renders the exact kind.
    expect(screen.getByText('auth')).toBeInTheDocument();
    expect(screen.getByText(/Failures: 1/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no runs', async () => {
    stubFetch(() => ({ ok: true, body: { runs: [] } }));
    render(<RunHistoryPanel isVisible onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No runs recorded yet/i)).toBeInTheDocument());
  });

  it('degrades to empty when the request fails', async () => {
    stubFetch(() => ({ ok: false, body: {} }));
    render(<RunHistoryPanel isVisible onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No runs recorded yet/i)).toBeInTheDocument());
  });

  it('refetches when reloadKey changes', async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      return { ok: true, body: { runs: call === 1 ? [] : [run()] } };
    });

    const { rerender } = render(<RunHistoryPanel isVisible reloadKey={0} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No runs recorded yet/i)).toBeInTheDocument());

    rerender(<RunHistoryPanel isVisible reloadKey={1} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('run-history-item')).toBeInTheDocument());
  });
});
