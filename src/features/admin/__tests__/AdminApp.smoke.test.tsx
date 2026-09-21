import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminApp } from '../AdminApp';

/** Mount AdminApp as App.tsx does — under an /admin/* parent route, so its
 * nested relative Routes resolve against /admin. */
function renderAdmin(path = '/admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const USERS = [
  {
    id: 'u1',
    ownerId: 'owner-1',
    email: 'user@example.com',
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AdminApp', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/admin/dashboard'))
          return jsonResponse({
            metrics: {
              users: 1,
              suspendedUsers: 0,
              activeSubscriptions: 0,
              mrrPaise: 0,
              creditsOutstanding: 0,
              creditsUsedThisMonth: 0,
              revenueThisMonthPaise: 0,
              revenueTotalPaise: 0,
            },
            recentPayments: [],
          });
        if (url.includes('/api/admin/users')) return jsonResponse({ users: USERS });
        if (url.includes('/api/admin/plans')) return jsonResponse({ plans: [] });
        if (url.includes('/api/admin/rates')) return jsonResponse({ rates: [] });
        return jsonResponse({});
      }),
    );
  });

  it('renders the dashboard with metrics from the API', async () => {
    renderAdmin();
    expect(await screen.findByText('Admin Console')).toBeInTheDocument();
    // The dashboard renders its metric cards + recent payments once loaded.
    expect(await screen.findByText('Recent payments')).toBeInTheDocument();
    expect(await screen.findByText('MRR')).toBeInTheDocument();
  });

  it('renders an error state when an admin API returns 403, without crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403)),
    );
    renderAdmin('/admin/users');
    expect(await screen.findByText(/admin access required/i)).toBeInTheDocument();
  });
});
