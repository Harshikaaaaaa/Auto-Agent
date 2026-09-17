import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../ErrorBoundary';

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('kaboom from child');
  return <div>child rendered</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors; silence it so test output stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('child rendered')).toBeInTheDocument();
  });

  it('shows a recovery screen instead of a blank page when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something broke in the editor')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('kaboom from child');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  });

  it('reports the error through the onError hook', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe('kaboom from child');
  });

  it('recovers when the child stops throwing and Try again is pressed', async () => {
    function Toggling() {
      return <Boom shouldThrow={false} />;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary>
        <Toggling />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('child rendered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears only volatile UI keys on Reset local UI state', async () => {
    localStorage.setItem('autoagent_task_sessions_v1', '[]');
    localStorage.setItem('autoagent_runtime_checkpoint', '{}');
    localStorage.setItem('autoagent_saved_workflows_v1', '[{"name":"keep me"}]');
    // A key outside the volatile allowlist must survive. (Connector tokens used
    // to live in localStorage as `tool_auth_*`; Task 13 moved them to the server,
    // so this now stands in for any non-volatile key.)
    localStorage.setItem('autoagent_offline_cache_v1', '{"kept":true}');

    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset local UI state' }));

    expect(localStorage.getItem('autoagent_task_sessions_v1')).toBeNull();
    expect(localStorage.getItem('autoagent_runtime_checkpoint')).toBeNull();
    // Saved work and other non-volatile keys must survive a UI reset.
    expect(localStorage.getItem('autoagent_saved_workflows_v1')).toBe('[{"name":"keep me"}]');
    expect(localStorage.getItem('autoagent_offline_cache_v1')).toBe('{"kept":true}');
    expect(reload).toHaveBeenCalled();
  });
});
