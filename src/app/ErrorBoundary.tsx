import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional hook for reporting to an observability backend (wired in Task 16). */
  onError?: (error: Error, componentStack: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time crashes anywhere below it and shows a recoverable screen
 * instead of an unmounted blank page.
 *
 * Recovery order offered to the user, least destructive first:
 *   1. Try again      — re-render with the same state (transient errors)
 *   2. Reload         — full page reload, keeps saved workflows
 *   3. Reset local UI — clears cached UI state only, never saved workflows
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Render crash:', error, errorInfo.componentStack);
    this.props.onError?.(error, errorInfo.componentStack ?? '');
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  /**
   * Clears only volatile UI state (task sessions, drafts, runtime checkpoint).
   * Saved workflows and connector auth are deliberately left untouched.
   */
  private handleResetLocalUi = (): void => {
    const volatileKeys = [
      'autoagent_task_sessions_v1',
      'autoagent_task_drafts_v1',
      'autoagent_runtime_checkpoint',
      'autoagent_selected_model',
    ];
    for (const key of volatileKeys) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage may be unavailable (private mode); reload still helps.
      }
    }
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#050505',
          color: '#e5e7eb',
          padding: 24,
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <div style={{ maxWidth: 560, width: '100%' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
            Something broke in the editor
          </h1>
          <p style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
            The workflow editor hit an unexpected error and stopped rendering. Your saved workflows
            are not affected.
          </p>

          <pre
            data-testid="error-boundary-message"
            style={{
              background: '#111',
              border: '1px solid #1a1a1a',
              borderRadius: 12,
              padding: 12,
              fontSize: 12,
              color: '#fca5a5',
              overflowX: 'auto',
              marginBottom: 20,
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {error.message || String(error)}
          </pre>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: 'none',
                background: '#2dd4bf',
                color: '#000',
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid #1a1a1a',
                background: '#111',
                color: '#e5e7eb',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.handleResetLocalUi}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid #1a1a1a',
                background: 'transparent',
                color: '#9ca3af',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Reset local UI state
            </button>
          </div>
        </div>
      </div>
    );
  }
}
