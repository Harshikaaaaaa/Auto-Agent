import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

/**
 * Smoke test: the whole app must mount and render its entry screen.
 * This is the canary that catches import cycles, provider wiring mistakes,
 * and crashes-on-mount before any deeper test runs.
 */
describe('App smoke', () => {
  beforeEach(() => {
    // The canvas loads the saved-workflow list on mount. Stub the network so the
    // test asserts rendering, not backend availability.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
  });

  it('mounts and renders the splash prompt', async () => {
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /what do you wanna automate today/i }),
    ).toBeInTheDocument();
  });

  it('does not render the error boundary fallback on a clean mount', () => {
    render(<App />);

    expect(screen.queryByText('Something broke in the editor')).not.toBeInTheDocument();
  });
});
