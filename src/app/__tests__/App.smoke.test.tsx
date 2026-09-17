import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

/**
 * Smoke test: the whole app must mount and render its entry screen.
 * This is the canary that catches import cycles, provider wiring mistakes,
 * and crashes-on-mount before any deeper test runs.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Stub the API. The app is behind an auth gate, so the session endpoint has to
 * answer before the canvas renders at all.
 */
function stubApi({ authenticated }: { authenticated: boolean }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/auth/me')) {
      return authenticated
        ? jsonResponse({ authenticated: true, user: { id: 'operator' } })
        : jsonResponse({ authenticated: false, authRequired: true }, 401);
    }
    // The canvas loads the saved-workflow list on mount.
    if (url.includes('/workflows')) return jsonResponse([]);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App smoke', () => {
  beforeEach(() => {
    stubApi({ authenticated: true });
  });

  it('mounts and renders the splash prompt for a signed-in operator', async () => {
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /what do you wanna automate today/i }),
    ).toBeInTheDocument();
  });

  it('does not render the error boundary fallback on a clean mount', async () => {
    render(<App />);

    await screen.findByRole('heading', { name: /what do you wanna automate today/i });
    expect(screen.queryByText('Something broke in the editor')).not.toBeInTheDocument();
  });

  it('shows the sign-in screen instead of the canvas when unauthenticated', async () => {
    stubApi({ authenticated: false });
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    // The workflow editor must not render behind the gate.
    expect(
      screen.queryByRole('heading', { name: /what do you wanna automate today/i }),
    ).not.toBeInTheDocument();
  });
});
