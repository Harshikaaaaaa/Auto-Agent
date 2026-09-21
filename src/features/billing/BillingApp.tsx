import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wallet, CreditCard, Receipt, History, BarChart3, Package } from 'lucide-react';
import {
  BillingError,
  cancelSubscription,
  createSubscribeOrder,
  createTopupOrder,
  fetchBalance,
  fetchPackages,
  fetchPayments,
  fetchPlans,
  fetchTransactions,
  fetchUsage,
  fetchUsageSummary,
  formatCredits,
  formatRupees,
  reconcilePayments,
  resumeSubscription,
  verifyPayment,
  type ActiveSubscription,
  type CreditPackage,
  type CreditTransaction,
  type PaymentRow,
  type Plan,
  type UsageRow,
  type UsageSummary,
} from './billingClient';
import {
  BarChart,
  Card,
  EmptyState,
  ErrorState,
  GhostButton,
  Loading,
  PrimaryButton,
  SectionLabel,
} from './components/ui';
import { CheckoutUnavailableError, openRazorpayCheckout } from './razorpayCheckout';

/**
 * The billing area. A self-contained routed sub-app mounted at /billing/*, so
 * the workflow canvas (the default route) is untouched. Every page handles
 * loading / empty / error states.
 */

const NAV = [
  { to: '/billing', label: 'Overview', icon: Wallet, end: true },
  { to: '/billing/plans', label: 'Plans', icon: Package },
  { to: '/billing/credits', label: 'Add Credits', icon: CreditCard },
  { to: '/billing/usage', label: 'Usage', icon: BarChart3 },
  { to: '/billing/transactions', label: 'Credit History', icon: History },
  { to: '/billing/payments', label: 'Payments', icon: Receipt },
];

export function BillingApp() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-surface-0 text-white">
      <header className="border-b border-hairline px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/[0.06] hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to app
          </button>
          <h1 className="text-sm font-semibold tracking-tight">Billing &amp; Usage</h1>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl gap-6 px-6 py-6">
        <nav className="w-44 shrink-0 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition duration-fast ease-smooth ${
                  isActive
                    ? 'bg-accent-muted text-accent ring-1 ring-inset ring-accent/25'
                    : 'text-white/60 hover:bg-white/[0.05] hover:text-white'
                }`
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="min-w-0 flex-1">
          <Routes>
            <Route index element={<OverviewPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="credits" element={<AddCreditsPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="subscription" element={<ManageSubscriptionPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/**
 * Small hook: run an async loader, exposing data/loading/error + reload.
 *
 * `key` is a re-run trigger — pass a value (e.g. the selected range) and the
 * loader re-runs when it changes. The loader itself is read through a ref so a
 * fresh inline closure each render does not restart the effect on every render.
 */
function useLoader<T>(loader: () => Promise<T>, key: string | number = '') {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loaderRef = React.useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let cancelled = false;
    // Reset to the loading state before each (re)fetch; intentional and the
    // whole point of the hook, so the cascading-render heuristic is silenced.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof BillingError ? e.message : 'Something went wrong.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

// ------------------------------------------------------------------ Overview

/** Reconcile any pending payments against the gateway, then load the balance.
 * On localhost the checkout callback/webhook may not fire, so this is what makes
 * a completed payment show up when the user returns to the billing area. */
async function reconcileThen<T>(loader: () => Promise<T>): Promise<T> {
  try {
    await reconcilePayments();
  } catch {
    // Reconcile is best-effort (gateway may be unconfigured); load anyway.
  }
  return loader();
}

function OverviewPage() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useLoader(() => reconcileThen(fetchBalance));

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const { balance, subscription } = data;
  const low = balance.totalCredits < 1000;

  return (
    <div className="space-y-5">
      <Card>
        <SectionLabel>Available Credits</SectionLabel>
        <p className="text-4xl font-semibold tracking-tight text-white">
          {formatCredits(balance.totalCredits)}
        </p>
        {low && (
          <p className="mt-2 inline-flex rounded-lg bg-amber-400/10 px-2.5 py-1 text-2xs font-medium text-amber-200">
            Low balance — add credits to keep running workflows.
          </p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Monthly" value={formatCredits(balance.subscriptionCredits)} />
          <Stat label="Purchased" value={formatCredits(balance.purchasedCredits)} />
          <Stat label="Bonus" value={formatCredits(balance.bonusCredits)} />
          <Stat label="Used this month" value={formatCredits(balance.usedThisMonth)} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <PrimaryButton onClick={() => navigate('/billing/credits')}>Add Credits</PrimaryButton>
          <GhostButton onClick={() => navigate('/billing/plans')}>Upgrade Plan</GhostButton>
          <GhostButton onClick={() => navigate('/billing/subscription')}>
            Manage Subscription
          </GhostButton>
        </div>
      </Card>

      {subscription && (
        <Card>
          <SectionLabel>Current Plan</SectionLabel>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-semibold text-white">{subscription.planName}</p>
              <p className="text-xs text-white/45">
                {subscription.pricePaise > 0
                  ? `${formatRupees(subscription.pricePaise)} / ${subscription.billingCycle}`
                  : 'Free'}
                {subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
              </p>
            </div>
            <span className="rounded-full bg-accent-muted px-2.5 py-1 text-2xs font-medium uppercase text-accent">
              {subscription.status}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-[0.14em] text-white/35">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

// --------------------------------------------------------------------- Plans

function PlansPage() {
  const { data, loading, error, reload } = useLoader(fetchPlans);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const subscribe = async (plan: Plan) => {
    setBusy(plan.id);
    setNotice(null);
    try {
      const order = await createSubscribeOrder(plan.id);
      await openRazorpayCheckout(order, {
        description: `${plan.displayName} subscription`,
        onSuccess: async (response) => {
          try {
            await verifyPayment(response);
            setNotice(`Payment confirmed. ${plan.displayName} is now active.`);
          } catch {
            setNotice(`Payment received for ${plan.displayName}. It will activate once confirmed.`);
          }
        },
        onDismiss: () => setNotice('Checkout closed. Your plan was not changed.'),
      });
    } catch (e) {
      if (e instanceof CheckoutUnavailableError) setNotice(e.message);
      else setNotice(e instanceof BillingError ? e.message : 'Could not start checkout.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No plans are configured.</EmptyState>;

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-xl border border-subtle bg-surface-1 p-3 text-xs text-white/70">
          {notice}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {data.map((plan) => (
          <Card key={plan.id}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-lg font-semibold text-white">{plan.displayName}</h3>
              <span className="text-sm font-medium text-white/70">
                {plan.pricePaise > 0 ? `${formatRupees(plan.pricePaise)}/mo` : 'Free'}
              </span>
            </div>
            <p className="mt-1 text-xs text-accent">
              {formatCredits(plan.includedCredits)} credits / month
            </p>
            {Array.isArray(plan.features) && (
              <ul className="mt-3 space-y-1 text-xs text-white/55">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                    {f}
                  </li>
                ))}
              </ul>
            )}
            {plan.pricePaise > 0 && (
              <div className="mt-4">
                <PrimaryButton onClick={() => subscribe(plan)} disabled={busy === plan.id}>
                  {busy === plan.id ? 'Starting…' : 'Choose plan'}
                </PrimaryButton>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Add Credits

function AddCreditsPage() {
  const { data, loading, error, reload } = useLoader(fetchPackages);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const buy = async (pkg: CreditPackage) => {
    setBusy(pkg.id);
    setNotice(null);
    try {
      const order = await createTopupOrder(pkg.id);
      await openRazorpayCheckout(order, {
        description: `${formatCredits(pkg.credits + pkg.bonusCredits)} credits`,
        onSuccess: async (response) => {
          try {
            await verifyPayment(response);
            setNotice(
              `Payment confirmed. ${formatCredits(pkg.credits + pkg.bonusCredits)} credits added.`,
            );
          } catch {
            setNotice(
              `Payment received. ${formatCredits(pkg.credits + pkg.bonusCredits)} credits will be added once confirmed.`,
            );
          }
        },
        onDismiss: () => setNotice('Checkout closed. No credits were purchased.'),
      });
    } catch (e) {
      if (e instanceof CheckoutUnavailableError) setNotice(e.message);
      else setNotice(e instanceof BillingError ? e.message : 'Could not start checkout.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No credit packages available.</EmptyState>;

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-xl border border-subtle bg-surface-1 p-3 text-xs text-white/70">
          {notice}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((pkg) => (
          <Card key={pkg.id}>
            <p className="text-2xl font-semibold text-white">{formatCredits(pkg.credits)}</p>
            <p className="text-2xs uppercase tracking-[0.14em] text-white/35">credits</p>
            {pkg.bonusCredits > 0 && (
              <p className="mt-1 text-xs text-accent">+{formatCredits(pkg.bonusCredits)} bonus</p>
            )}
            <p className="mt-3 text-sm font-medium text-white/70">{formatRupees(pkg.pricePaise)}</p>
            <div className="mt-4">
              <PrimaryButton onClick={() => buy(pkg)} disabled={busy === pkg.id}>
                {busy === pkg.id ? 'Starting…' : 'Buy'}
              </PrimaryButton>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- Usage

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
];

function UsagePage() {
  const [range, setRange] = useState('30d');
  const summary = useLoader<UsageSummary>(() => fetchUsageSummary(range), range);
  const rows = useLoader<UsageRow[]>(() => fetchUsage(50));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <GhostButton key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>
            {r.label}
          </GhostButton>
        ))}
      </div>

      {summary.loading ? (
        <Loading />
      ) : summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : summary.data ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Card>
              <SectionLabel>Requests</SectionLabel>
              <p className="text-2xl font-semibold tabular-nums">{summary.data.requests}</p>
            </Card>
            <Card>
              <SectionLabel>Credits used</SectionLabel>
              <p className="text-2xl font-semibold tabular-nums">
                {formatCredits(summary.data.credits)}
              </p>
            </Card>
            <Card>
              <SectionLabel>Input tokens</SectionLabel>
              <p className="text-2xl font-semibold tabular-nums">
                {formatCredits(summary.data.inputTokens)}
              </p>
            </Card>
            <Card>
              <SectionLabel>Output tokens</SectionLabel>
              <p className="text-2xl font-semibold tabular-nums">
                {formatCredits(summary.data.outputTokens)}
              </p>
            </Card>
          </div>

          {summary.data.byModel.length > 0 && (
            <Card>
              <SectionLabel>Credits by model</SectionLabel>
              <BarChart
                data={summary.data.byModel.map((m) => ({ label: m.model, value: m.credits }))}
                formatValue={formatCredits}
              />
            </Card>
          )}
          {summary.data.byProvider.length > 0 && (
            <Card>
              <SectionLabel>Credits by provider</SectionLabel>
              <BarChart
                data={summary.data.byProvider.map((p) => ({ label: p.provider, value: p.credits }))}
                formatValue={formatCredits}
              />
            </Card>
          )}
        </>
      ) : null}

      <Card>
        <SectionLabel>Recent AI usage</SectionLabel>
        {rows.loading ? (
          <Loading />
        ) : rows.data && rows.data.length > 0 ? (
          <Table
            head={['Date', 'Model', 'Tokens', 'Credits', 'Status']}
            rows={rows.data.map((u) => [
              u.createdAt ? new Date(u.createdAt).toLocaleString() : '—',
              `${u.provider}/${u.model}`,
              `${u.inputTokens}+${u.outputTokens}`,
              formatCredits(u.creditsCharged),
              u.status,
            ])}
          />
        ) : (
          <EmptyState>No AI usage yet.</EmptyState>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------- Credit history

function TransactionsPage() {
  const { data, loading, error, reload } = useLoader<CreditTransaction[]>(() =>
    fetchTransactions(100),
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No credit transactions yet.</EmptyState>;

  return (
    <Card>
      <SectionLabel>Credit History</SectionLabel>
      <Table
        head={['Date', 'Type', 'Description', 'Change', 'Balance']}
        rows={data.map((t) => [
          t.createdAt ? new Date(t.createdAt).toLocaleString() : '—',
          t.type,
          t.description ?? (t.model ? `${t.provider}/${t.model}` : '—'),
          `${t.credits > 0 ? '+' : ''}${formatCredits(t.credits)}`,
          formatCredits(t.balanceAfter),
        ])}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ Payments

function PaymentsPage() {
  const { data, loading, error, reload } = useLoader<PaymentRow[]>(() =>
    reconcileThen(() => fetchPayments(100)),
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No payments yet.</EmptyState>;

  return (
    <Card>
      <SectionLabel>Payment History</SectionLabel>
      <Table
        head={['Date', 'Type', 'Amount', 'Credits', 'Status']}
        rows={data.map((p) => [
          p.createdAt ? new Date(p.createdAt).toLocaleString() : '—',
          p.type,
          formatRupees(p.amountPaise),
          p.creditsPurchased ? formatCredits(p.creditsPurchased) : '—',
          p.status,
        ])}
      />
    </Card>
  );
}

// -------------------------------------------------------- Manage subscription

function ManageSubscriptionPage() {
  const { data, loading, error, reload } = useLoader(fetchBalance);
  const [busy, setBusy] = useState(false);

  const doCancel = async (sub: ActiveSubscription) => {
    setBusy(true);
    try {
      if (sub.cancelAtPeriodEnd) await resumeSubscription();
      else await cancelSubscription();
      reload();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const sub = data?.subscription;
  if (!sub) return <EmptyState>You are not on a paid subscription.</EmptyState>;

  return (
    <Card>
      <SectionLabel>Manage Subscription</SectionLabel>
      <p className="text-lg font-semibold text-white">{sub.planName}</p>
      <p className="mt-1 text-xs text-white/45">
        Status: {sub.status}
        {sub.currentPeriodEnd
          ? ` · renews ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`
          : ''}
        {sub.cancelAtPeriodEnd ? ' · scheduled to cancel' : ''}
      </p>
      {sub.pricePaise > 0 && (
        <div className="mt-4">
          <GhostButton onClick={() => doCancel(sub)} disabled={busy}>
            {sub.cancelAtPeriodEnd ? 'Resume subscription' : 'Cancel at period end'}
          </GhostButton>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- shared table

function Table({ head, rows }: { head: string[]; rows: Array<Array<string>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-hairline text-2xs uppercase tracking-[0.12em] text-white/35">
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-hairline/50 text-white/70">
              {r.map((cell, j) => (
                <td key={j} className="py-2 pr-4 tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
