import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BillingApp } from '../BillingApp';

/** Mount BillingApp exactly as App.tsx does — under a /billing/* parent route,
 * so its nested relative Routes resolve against /billing. */
function renderBilling(path = '/billing') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/billing/*" element={<BillingApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Smoke tests for the billing area: it must render the overview from the API,
 * and degrade to an error state when the API fails — never crash.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BALANCE = {
  balance: {
    subscriptionCredits: 62450,
    bonusCredits: 0,
    purchasedCredits: 20000,
    totalCredits: 82450,
    usedThisMonth: 27550,
    lifetimeUsed: 100000,
  },
  subscription: {
    id: 's1',
    planCode: 'pro',
    planName: 'Pro',
    status: 'active',
    billingCycle: 'monthly',
    pricePaise: 79900,
    includedCredits: 90000,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BillingApp overview', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/billing/balance')) return jsonResponse(BALANCE);
        return jsonResponse({});
      }),
    );
  });

  it('renders the available-credits total and the buckets', async () => {
    renderBilling();

    expect(await screen.findByText('82,450')).toBeInTheDocument();
    expect(screen.getByText('Available Credits')).toBeInTheDocument();
    // Bucket labels present.
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Purchased')).toBeInTheDocument();
  });

  it('shows an error state when the balance API fails, without crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'boom' }, 500)),
    );
    renderBilling();
    expect(await screen.findByText(/request failed/i)).toBeInTheDocument();
  });
});
