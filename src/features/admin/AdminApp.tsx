import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Users as UsersIcon,
  Package,
  Layers,
  SlidersHorizontal,
  Ticket,
  LayoutDashboard,
  KeyRound,
} from 'lucide-react';
import { formatCredits, formatRupees } from '@features/billing/billingClient';
import {
  Card,
  EmptyState,
  ErrorState,
  GhostButton,
  Loading,
  PrimaryButton,
  SectionLabel,
} from '@features/billing/components/ui';
import {
  AdminError,
  adjustCredits,
  assignUserPlan,
  createCoupon,
  createPackage,
  createPlan,
  createRate,
  fetchAdminPackages,
  fetchAdminPlans,
  fetchCoupons,
  fetchDashboard,
  fetchRates,
  fetchSettings,
  fetchUserDetail,
  fetchUsers,
  setUserRole,
  setUserStatus,
  testAiConnection,
  updateCoupon,
  updatePackage,
  updatePlan,
  updateRate,
  updateSettings,
  type AdminPackage,
  type AdminPlan,
  type AdminUserDetail,
  type Coupon,
  type RateRow,
  type SettingStatus,
} from './adminClient';

/**
 * The admin billing console. A self-contained routed sub-app mounted at
 * /admin/*, rendered only for an admin session (App.tsx gates the route). Every
 * page handles loading / empty / error, mirroring the billing area.
 */

const NAV = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: UsersIcon },
  { to: '/admin/plans', label: 'Plans', icon: Layers },
  { to: '/admin/packages', label: 'Packages', icon: Package },
  { to: '/admin/rates', label: 'Rate Card', icon: SlidersHorizontal },
  { to: '/admin/coupons', label: 'Coupons', icon: Ticket },
  { to: '/admin/settings', label: 'Settings', icon: KeyRound },
];

export function AdminApp() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-surface-0 text-white">
      <header className="border-b border-hairline px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/[0.06] hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to app
          </button>
          <h1 className="text-sm font-semibold tracking-tight">Admin Console</h1>
          <span className="rounded-full bg-accent-muted px-2 py-0.5 text-2xs font-medium uppercase text-accent">
            Admin
          </span>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-6 py-6">
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
            <Route index element={<DashboardPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="packages" element={<PackagesPage />} />
            <Route path="rates" element={<RatesPage />} />
            <Route path="coupons" element={<CouponsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** Run an async loader, exposing data/loading/error + reload (see BillingApp). */
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof AdminError ? e.message : 'Something went wrong.');
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

// ----------------------------------------------------------------- Dashboard

function DashboardPage() {
  const { data, loading, error, reload } = useLoader(fetchDashboard);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const m = data.metrics;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Users" value={String(m.users)} sub={`${m.suspendedUsers} suspended`} />
        <Metric label="Active subscriptions" value={String(m.activeSubscriptions)} />
        <Metric label="MRR" value={formatRupees(m.mrrPaise)} sub="monthly plans" />
        <Metric label="Revenue (total)" value={formatRupees(m.revenueTotalPaise)} />
        <Metric label="Revenue (this month)" value={formatRupees(m.revenueThisMonthPaise)} />
        <Metric label="Credits outstanding" value={formatCredits(m.creditsOutstanding)} />
        <Metric label="Credits used (month)" value={formatCredits(m.creditsUsedThisMonth)} />
      </div>

      <Card>
        <SectionLabel>Recent payments</SectionLabel>
        {data.recentPayments.length === 0 ? (
          <EmptyState>No payments yet.</EmptyState>
        ) : (
          <Table
            head={['User', 'Type', 'Amount', 'Status', 'When']}
            rows={data.recentPayments.map((p) => [
              p.email ?? p.ownerId,
              p.type,
              formatRupees(p.amountPaise),
              p.status,
              p.createdAt ? new Date(p.createdAt).toLocaleString() : '—',
            ])}
          />
        )}
      </Card>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <SectionLabel>{label}</SectionLabel>
      <p className="text-2xl font-semibold tabular-nums text-white">{value}</p>
      {sub && <p className="mt-0.5 text-2xs text-white/35">{sub}</p>}
    </Card>
  );
}

// --------------------------------------------------------------------- Users

function UsersPage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const { data, loading, error, reload } = useLoader(() => fetchUsers(query || undefined), query);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <Card>
        <SectionLabel>Users</SectionLabel>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email or owner id…"
            className="flex-1 rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white placeholder:text-white/30 focus:border-accent/40 focus:outline-none"
          />
          <PrimaryButton type="submit">Search</PrimaryButton>
        </form>
      </Card>

      {loading && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState>No users match.</EmptyState>}
      {data && data.length > 0 && (
        <Card>
          <Table
            head={['Email', 'Role', 'Status', 'Joined', '']}
            rows={data.map((u) => [
              u.email,
              u.role,
              u.status,
              u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—',
              <GhostButton key={u.ownerId} onClick={() => setSelected(u.ownerId)}>
                View
              </GhostButton>,
            ])}
          />
        </Card>
      )}

      {selected && <UserDrawer ownerId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function UserDrawer({ ownerId, onClose }: { ownerId: string; onClose: () => void }) {
  const { data, loading, error, reload } = useLoader<AdminUserDetail>(
    () => fetchUserDetail(ownerId),
    ownerId,
  );

  return (
    <Card className="border-accent/25">
      <div className="mb-4 flex items-center justify-between">
        <SectionLabel>User detail</SectionLabel>
        <GhostButton onClick={onClose}>Close</GhostButton>
      </div>
      {loading && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold">{data.user.email}</p>
              <p className="text-xs text-white/45">
                {data.user.ownerId} · {data.user.role} ·{' '}
                <span className={data.user.status === 'suspended' ? 'text-rose-300' : ''}>
                  {data.user.status}
                </span>
                {data.subscription ? ` · ${data.subscription.planName}` : ''}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total" value={formatCredits(data.wallet?.totalCredits ?? 0)} />
            <Stat label="Monthly" value={formatCredits(data.wallet?.subscriptionCredits ?? 0)} />
            <Stat label="Purchased" value={formatCredits(data.wallet?.purchasedCredits ?? 0)} />
            <Stat label="Bonus" value={formatCredits(data.wallet?.bonusCredits ?? 0)} />
          </div>

          <UserActions user={data.user} onChanged={reload} />

          <AssignPlanForm ownerId={ownerId} onAssigned={reload} />

          <AdjustForm ownerId={ownerId} onAdjusted={reload} />

          <div>
            <SectionLabel>Recent credit history</SectionLabel>
            {data.transactions.length === 0 ? (
              <EmptyState>No transactions.</EmptyState>
            ) : (
              <Table
                head={['Type', 'Credits', 'Balance', 'When']}
                rows={data.transactions
                  .slice(0, 10)
                  .map((t) => [
                    t.type,
                    formatCredits(t.credits),
                    formatCredits(t.balanceAfter),
                    t.createdAt ? new Date(t.createdAt).toLocaleString() : '—',
                  ])}
              />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function UserActions({
  user,
  onChanged,
}: {
  user: AdminUserDetail['user'];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  const isAdmin = user.role === 'admin';
  const isSuspended = user.status === 'suspended';

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2/40 p-4">
      <SectionLabel>Account actions</SectionLabel>
      <div className="flex flex-wrap gap-2">
        <GhostButton
          onClick={() => run('role', () => setUserRole(user.ownerId, isAdmin ? 'user' : 'admin'))}
          disabled={busy !== null}
        >
          {busy === 'role' ? 'Saving…' : isAdmin ? 'Demote to user' : 'Promote to admin'}
        </GhostButton>
        <GhostButton
          onClick={() =>
            run('status', () => setUserStatus(user.ownerId, isSuspended ? 'active' : 'suspended'))
          }
          disabled={busy !== null}
        >
          {busy === 'status' ? 'Saving…' : isSuspended ? 'Reactivate' : 'Suspend'}
        </GhostButton>
      </div>
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
    </div>
  );
}

function AssignPlanForm({ ownerId, onAssigned }: { ownerId: string; onAssigned: () => void }) {
  const { data: plans } = useLoader(fetchAdminPlans);
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const assign = async () => {
    if (!planId) {
      setErr('Choose a plan.');
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await assignUserPlan(ownerId, planId);
      setNotice('Plan assigned and subscription credits reset.');
      onAssigned();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : 'Assign failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2/40 p-4">
      <SectionLabel>Assign plan (no payment)</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white focus:border-accent/40 focus:outline-none"
        >
          <option value="">Select a plan…</option>
          {(plans ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName} ({p.code})
            </option>
          ))}
        </select>
        <PrimaryButton onClick={assign} disabled={busy}>
          {busy ? 'Assigning…' : 'Assign'}
        </PrimaryButton>
      </div>
      <p className="mt-2 text-2xs text-white/35">
        Retires the current subscription, activates the chosen plan, and resets the monthly credit
        bucket to that plan&apos;s allowance.
      </p>
      {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
    </div>
  );
}

function AdjustForm({ ownerId, onAdjusted }: { ownerId: string; onAdjusted: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [bucket, setBucket] = useState<'subscription' | 'bonus' | 'purchased'>('bonus');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const n = Math.round(Number(amount));
    if (!Number.isInteger(n) || n === 0) {
      setErr('Enter a non-zero integer amount (negative to remove).');
      return;
    }
    if (!reason.trim()) {
      setErr('A reason is required — it is recorded on the audit ledger.');
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const wallet = await adjustCredits({ ownerId, amount: n, reason: reason.trim(), bucket });
      setNotice(`Done. New balance: ${formatCredits(wallet.totalCredits)} credits.`);
      setAmount('');
      setReason('');
      onAdjusted();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : 'Adjustment failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2/40 p-4">
      <SectionLabel>Manual credit adjustment</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (± credits)"
          inputMode="numeric"
          className="w-40 rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white placeholder:text-white/30 focus:border-accent/40 focus:outline-none"
        />
        <select
          value={bucket}
          onChange={(e) => setBucket(e.target.value as typeof bucket)}
          className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white focus:border-accent/40 focus:outline-none"
        >
          <option value="bonus">Bonus</option>
          <option value="purchased">Purchased</option>
          <option value="subscription">Subscription</option>
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (audited)"
          className="min-w-[12rem] flex-1 rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white placeholder:text-white/30 focus:border-accent/40 focus:outline-none"
        />
        <PrimaryButton onClick={submit} disabled={busy}>
          {busy ? 'Applying…' : 'Apply'}
        </PrimaryButton>
      </div>
      <p className="mt-2 text-2xs text-white/35">
        A negative amount removes credits (subscription → bonus → purchased) and cannot overdraw.
        Every adjustment is recorded with your identity and reason.
      </p>
      {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
    </div>
  );
}

// --------------------------------------------------------------------- Plans

function PlansPage() {
  const { data, loading, error, reload } = useLoader(fetchAdminPlans);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      {(data ?? []).map((p) => (
        <PlanEditor key={p.id} plan={p as unknown as AdminPlan} onSaved={reload} />
      ))}
      {(data ?? []).length === 0 && <EmptyState>No plans configured.</EmptyState>}
      <CreatePlanForm onCreated={reload} />
    </div>
  );
}

function PlanEditor({ plan, onSaved }: { plan: AdminPlan; onSaved: () => void }) {
  const [price, setPrice] = useState(String(plan.pricePaise));
  const [credits, setCredits] = useState(String(plan.includedCredits));
  const [enabled, setEnabled] = useState(plan.enabled);
  const { busy, err, notice, run } = useSaver();

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {plan.displayName} <span className="text-2xs text-white/40">({plan.code})</span>
          </p>
          <p className="text-2xs text-white/40">{plan.billingCycle}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Price (paise)">
            <NumInput value={price} onChange={setPrice} />
          </Field>
          <Field label="Included credits">
            <NumInput value={credits} onChange={setCredits} />
          </Field>
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          <PrimaryButton
            onClick={() =>
              run(() =>
                updatePlan(plan.id, {
                  pricePaise: Math.max(0, Math.round(Number(price))),
                  includedCredits: Math.max(0, Math.round(Number(credits))),
                  enabled,
                }).then(onSaved),
              )
            }
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

function CreatePlanForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ code: '', displayName: '', pricePaise: '', includedCredits: '' });
  const { busy, err, notice, run } = useSaver();
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  return (
    <Card>
      <SectionLabel>Create a plan</SectionLabel>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Code">
          <TextInput value={f.code} onChange={set('code')} placeholder="team" />
        </Field>
        <Field label="Name">
          <TextInput value={f.displayName} onChange={set('displayName')} placeholder="Team" />
        </Field>
        <Field label="Price (paise)">
          <NumInput value={f.pricePaise} onChange={set('pricePaise')} />
        </Field>
        <Field label="Included credits">
          <NumInput value={f.includedCredits} onChange={set('includedCredits')} />
        </Field>
        <PrimaryButton
          onClick={() =>
            run(async () => {
              await createPlan({
                code: f.code.trim(),
                displayName: f.displayName.trim() || f.code.trim(),
                pricePaise: Math.max(0, Math.round(Number(f.pricePaise) || 0)),
                includedCredits: Math.max(0, Math.round(Number(f.includedCredits) || 0)),
              });
              setF({ code: '', displayName: '', pricePaise: '', includedCredits: '' });
              onCreated();
            })
          }
          disabled={busy || !f.code.trim()}
        >
          {busy ? 'Creating…' : 'Create'}
        </PrimaryButton>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

// ------------------------------------------------------------------ Packages

function PackagesPage() {
  const { data, loading, error, reload } = useLoader(fetchAdminPackages);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      {(data ?? []).map((p) => (
        <PackageEditor key={p.id} pkg={p as unknown as AdminPackage} onSaved={reload} />
      ))}
      {(data ?? []).length === 0 && <EmptyState>No packages configured.</EmptyState>}
      <CreatePackageForm onCreated={reload} />
    </div>
  );
}

function PackageEditor({ pkg, onSaved }: { pkg: AdminPackage; onSaved: () => void }) {
  const [price, setPrice] = useState(String(pkg.pricePaise));
  const [credits, setCredits] = useState(String(pkg.credits));
  const [bonus, setBonus] = useState(String(pkg.bonusCredits));
  const [enabled, setEnabled] = useState(pkg.enabled);
  const { busy, err, notice, run } = useSaver();

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {pkg.displayName} <span className="text-2xs text-white/40">({pkg.code})</span>
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Price (paise)">
            <NumInput value={price} onChange={setPrice} />
          </Field>
          <Field label="Credits">
            <NumInput value={credits} onChange={setCredits} />
          </Field>
          <Field label="Bonus">
            <NumInput value={bonus} onChange={setBonus} />
          </Field>
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          <PrimaryButton
            onClick={() =>
              run(() =>
                updatePackage(pkg.id, {
                  pricePaise: Math.max(0, Math.round(Number(price))),
                  credits: Math.max(0, Math.round(Number(credits))),
                  bonusCredits: Math.max(0, Math.round(Number(bonus))),
                  enabled,
                }).then(onSaved),
              )
            }
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

function CreatePackageForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ code: '', displayName: '', pricePaise: '', credits: '', bonus: '' });
  const { busy, err, notice, run } = useSaver();
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  return (
    <Card>
      <SectionLabel>Create a package</SectionLabel>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Code">
          <TextInput value={f.code} onChange={set('code')} placeholder="pack_1499" />
        </Field>
        <Field label="Name">
          <TextInput
            value={f.displayName}
            onChange={set('displayName')}
            placeholder="150,000 credits"
          />
        </Field>
        <Field label="Price (paise)">
          <NumInput value={f.pricePaise} onChange={set('pricePaise')} />
        </Field>
        <Field label="Credits">
          <NumInput value={f.credits} onChange={set('credits')} />
        </Field>
        <Field label="Bonus">
          <NumInput value={f.bonus} onChange={set('bonus')} />
        </Field>
        <PrimaryButton
          onClick={() =>
            run(async () => {
              await createPackage({
                code: f.code.trim(),
                displayName: f.displayName.trim() || f.code.trim(),
                pricePaise: Math.max(0, Math.round(Number(f.pricePaise) || 0)),
                credits: Math.max(0, Math.round(Number(f.credits) || 0)),
                bonusCredits: Math.max(0, Math.round(Number(f.bonus) || 0)),
              });
              setF({ code: '', displayName: '', pricePaise: '', credits: '', bonus: '' });
              onCreated();
            })
          }
          disabled={busy || !f.code.trim()}
        >
          {busy ? 'Creating…' : 'Create'}
        </PrimaryButton>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

// ------------------------------------------------------------------ Rate card

function RatesPage() {
  const { data, loading, error, reload } = useLoader(fetchRates);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/45">
        Editing a rate affects new AI requests only — historical usage keeps the rate it was billed
        at. Prices are micro-USD per 1M tokens; markup is ×10 (25 = 2.5×); fee is basis points.
      </p>
      {(data ?? []).map((rate) => (
        <RateEditor key={rate.id} rate={rate} onSaved={reload} />
      ))}
      {(data ?? []).length === 0 && <EmptyState>No rates configured.</EmptyState>}
      <CreateRateForm onCreated={reload} />
    </div>
  );
}

function RateEditor({ rate, onSaved }: { rate: RateRow; onSaved: () => void }) {
  const [f, setF] = useState({
    input: String(rate.input_price_per_1m_micros),
    cached: String(rate.cached_input_price_per_1m_micros),
    output: String(rate.output_price_per_1m_micros),
    reasoning: String(rate.reasoning_price_per_1m_micros),
    markup: String(rate.markup_multiplier_x10),
    fee: String(rate.provider_fee_bps),
    minCharge: String(rate.minimum_credit_charge),
    maxTokens: rate.maximum_output_tokens === null ? '' : String(rate.maximum_output_tokens),
  });
  const [enabled, setEnabled] = useState(rate.enabled);
  const [free, setFree] = useState(rate.freePlanAllowed);
  const [starter, setStarter] = useState(rate.starterPlanAllowed);
  const [pro, setPro] = useState(rate.proPlanAllowed);
  const [business, setBusiness] = useState(rate.businessPlanAllowed);
  const { busy, err, notice, run } = useSaver();
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const int = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{rate.displayName}</p>
          <p className="text-2xs text-white/40">
            {rate.provider} · {rate.modelId}
          </p>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Input /1M">
          <NumInput value={f.input} onChange={set('input')} />
        </Field>
        <Field label="Cached /1M">
          <NumInput value={f.cached} onChange={set('cached')} />
        </Field>
        <Field label="Output /1M">
          <NumInput value={f.output} onChange={set('output')} />
        </Field>
        <Field label="Reasoning /1M">
          <NumInput value={f.reasoning} onChange={set('reasoning')} />
        </Field>
        <Field label="Markup ×10">
          <NumInput value={f.markup} onChange={set('markup')} width="w-20" />
        </Field>
        <Field label="Fee bps">
          <NumInput value={f.fee} onChange={set('fee')} width="w-20" />
        </Field>
        <Field label="Min charge">
          <NumInput value={f.minCharge} onChange={set('minCharge')} width="w-24" />
        </Field>
        <Field label="Max out tokens">
          <NumInput value={f.maxTokens} onChange={set('maxTokens')} width="w-24" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <span className="text-2xs uppercase tracking-[0.12em] text-white/35">Allowed on:</span>
        <Toggle checked={free} onChange={setFree} label="Free" />
        <Toggle checked={starter} onChange={setStarter} label="Starter" />
        <Toggle checked={pro} onChange={setPro} label="Pro" />
        <Toggle checked={business} onChange={setBusiness} label="Business" />
        <PrimaryButton
          onClick={() =>
            run(() =>
              updateRate(rate.id, {
                input_price_per_1m_micros: int(f.input),
                cached_input_price_per_1m_micros: int(f.cached),
                output_price_per_1m_micros: int(f.output),
                reasoning_price_per_1m_micros: int(f.reasoning),
                markup_multiplier_x10: int(f.markup),
                provider_fee_bps: int(f.fee),
                minimum_credit_charge: int(f.minCharge),
                maximum_output_tokens: f.maxTokens.trim() ? int(f.maxTokens) : null,
                enabled,
                free_plan_allowed: free,
                starter_plan_allowed: starter,
                pro_plan_allowed: pro,
                business_plan_allowed: business,
              } as Partial<RateRow>).then(onSaved),
            )
          }
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

function CreateRateForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({
    provider: 'openrouter',
    modelId: '',
    displayName: '',
    input: '',
    output: '',
    markup: '25',
    fee: '0',
  });
  const { busy, err, notice, run } = useSaver();
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const int = (v: string) => Math.max(0, Math.round(Number(v) || 0));

  return (
    <Card>
      <SectionLabel>Add a model rate</SectionLabel>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Provider">
          <select
            value={f.provider}
            onChange={(e) => set('provider')(e.target.value)}
            className={inputClass}
          >
            <option value="openrouter">openrouter</option>
            <option value="gemini">gemini</option>
            <option value="openai">openai</option>
            <option value="ollama">ollama</option>
          </select>
        </Field>
        <Field label="Model id">
          <TextInput value={f.modelId} onChange={set('modelId')} placeholder="openai/gpt-4o" />
        </Field>
        <Field label="Name">
          <TextInput value={f.displayName} onChange={set('displayName')} placeholder="GPT-4o" />
        </Field>
        <Field label="Input /1M">
          <NumInput value={f.input} onChange={set('input')} />
        </Field>
        <Field label="Output /1M">
          <NumInput value={f.output} onChange={set('output')} />
        </Field>
        <Field label="Markup ×10">
          <NumInput value={f.markup} onChange={set('markup')} width="w-20" />
        </Field>
        <Field label="Fee bps">
          <NumInput value={f.fee} onChange={set('fee')} width="w-20" />
        </Field>
        <PrimaryButton
          onClick={() =>
            run(async () => {
              await createRate({
                provider: f.provider,
                modelId: f.modelId.trim(),
                displayName: f.displayName.trim() || f.modelId.trim(),
                input_price_per_1m_micros: int(f.input),
                output_price_per_1m_micros: int(f.output),
                markup_multiplier_x10: int(f.markup),
                provider_fee_bps: int(f.fee),
              });
              setF({ ...f, modelId: '', displayName: '', input: '', output: '' });
              onCreated();
            })
          }
          disabled={busy || !f.modelId.trim()}
        >
          {busy ? 'Adding…' : 'Add rate'}
        </PrimaryButton>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-2xs uppercase tracking-[0.12em] text-white/35">{label}</p>
      {children}
    </div>
  );
}

const inputClass =
  'rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-xs text-white placeholder:text-white/30 focus:border-accent/40 focus:outline-none';

function NumInput({
  value,
  onChange,
  width = 'w-28',
}: {
  value: string;
  onChange: (v: string) => void;
  width?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode="numeric"
      className={`${width} ${inputClass}`}
    />
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  width = 'w-36',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`${width} ${inputClass}`}
    />
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

/** Shared busy/notice/error state for the small save/create forms. */
function useSaver() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await fn();
      setNotice('Saved.');
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, notice, run };
}

function SaveNote({ notice, err }: { notice: string | null; err: string | null }) {
  if (!notice && !err) return null;
  return (
    <p className={`mt-2 text-xs ${err ? 'text-rose-300' : 'text-emerald-300'}`}>{err ?? notice}</p>
  );
}

// ------------------------------------------------------------------- Coupons

function couponValue(c: Coupon): string {
  if (c.couponType === 'percentage') return `${(c.percentBps ?? 0) / 100}%`;
  if (c.couponType === 'fixed') return formatRupees(c.fixedDiscountPaise ?? 0);
  return `${formatCredits(c.bonusCredits ?? 0)} credits`;
}

function CouponsPage() {
  const { data, loading, error, reload } = useLoader(fetchCoupons);
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = async (c: Coupon) => {
    setBusyId(c.id);
    try {
      await updateCoupon(c.id, { enabled: !c.enabled });
      reload();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <Card>
        <SectionLabel>Coupons</SectionLabel>
        {(data ?? []).length === 0 ? (
          <EmptyState>No coupons created.</EmptyState>
        ) : (
          <Table
            head={['Code', 'Type', 'Value', 'Redeemed', 'Enabled', '']}
            rows={(data ?? []).map((c) => {
              const redeemed = c.redeemedCount ?? c.timesRedeemed ?? 0;
              return [
                c.code,
                c.couponType,
                couponValue(c),
                `${redeemed}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}`,
                c.enabled ? 'Yes' : 'No',
                <GhostButton key={c.id} onClick={() => toggle(c)} disabled={busyId === c.id}>
                  {busyId === c.id ? '…' : c.enabled ? 'Disable' : 'Enable'}
                </GhostButton>,
              ];
            })}
          />
        )}
      </Card>
      <CreateCouponForm onCreated={reload} />
    </div>
  );
}

function CreateCouponForm({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed' | 'bonus_credits'>('percentage');
  const [amount, setAmount] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const { busy, err, notice, run } = useSaver();

  const amountLabel =
    type === 'percentage'
      ? 'Percent (e.g. 10)'
      : type === 'fixed'
        ? 'Discount (paise)'
        : 'Bonus credits';

  return (
    <Card>
      <SectionLabel>Create a coupon</SectionLabel>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Code">
          <TextInput value={code} onChange={setCode} placeholder="WELCOME10" />
        </Field>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            className={inputClass}
          >
            <option value="percentage">Percentage</option>
            <option value="fixed">Fixed (paise)</option>
            <option value="bonus_credits">Bonus credits</option>
          </select>
        </Field>
        <Field label={amountLabel}>
          <NumInput value={amount} onChange={setAmount} />
        </Field>
        <Field label="Max redemptions (blank = ∞)">
          <NumInput value={maxRedemptions} onChange={setMaxRedemptions} />
        </Field>
        <PrimaryButton
          onClick={() =>
            run(async () => {
              const n = Math.max(0, Math.round(Number(amount) || 0));
              await createCoupon({
                code: code.trim(),
                couponType: type,
                // Percent is stored as basis points (10% -> 1000).
                percentBps: type === 'percentage' ? n * 100 : null,
                fixedDiscountPaise: type === 'fixed' ? n : null,
                bonusCredits: type === 'bonus_credits' ? n : null,
                maxRedemptions: maxRedemptions.trim()
                  ? Math.max(1, Math.round(Number(maxRedemptions)))
                  : null,
              });
              setCode('');
              setAmount('');
              setMaxRedemptions('');
              onCreated();
            })
          }
          disabled={busy || !code.trim()}
        >
          {busy ? 'Creating…' : 'Create'}
        </PrimaryButton>
      </div>
      <SaveNote notice={notice} err={err} />
    </Card>
  );
}

// ------------------------------------------------------------------ Settings

const SETTING_GROUPS: { title: string; note?: string; keys: string[] }[] = [
  {
    title: 'AI provider',
    note: 'The active provider and its default model. Keys below enable each provider.',
    keys: ['AI_PROVIDER'],
  },
  { title: 'OpenRouter', keys: ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'] },
  { title: 'Gemini', keys: ['GEMINI_API_KEY', 'GEMINI_MODEL'] },
  { title: 'OpenAI', keys: ['OPENAI_API_KEY', 'OPENAI_MODEL'] },
  {
    title: 'Google OAuth',
    note: 'Client id + secret for Gmail / Sheets / Drive tools. The redirect URI stays in the environment.',
    keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  {
    title: 'Razorpay payments',
    note: 'Key id + secret enable checkout; the webhook secret is needed to confirm payments.',
    keys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  },
  {
    title: 'Feature toggles',
    note: 'WHATSAPP_ENABLED is read at startup — changing it needs a restart to take effect.',
    keys: ['FETCH_RENDER_ENABLED', 'WHATSAPP_ENABLED'],
  },
];

const LABELS: Record<string, string> = {
  AI_PROVIDER: 'Active provider',
  OPENROUTER_API_KEY: 'API key',
  OPENROUTER_MODEL: 'Model',
  GEMINI_API_KEY: 'API key',
  GEMINI_MODEL: 'Model',
  OPENAI_API_KEY: 'API key',
  OPENAI_MODEL: 'Model',
  GOOGLE_CLIENT_ID: 'Client ID',
  GOOGLE_CLIENT_SECRET: 'Client secret',
  RAZORPAY_KEY_ID: 'Key ID',
  RAZORPAY_KEY_SECRET: 'Key secret',
  RAZORPAY_WEBHOOK_SECRET: 'Webhook secret',
  FETCH_RENDER_ENABLED: 'JavaScript rendering',
  WHATSAPP_ENABLED: 'WhatsApp bridge',
};

function SettingsPage() {
  const { data, loading, error, reload } = useLoader(fetchSettings);
  // Only fields the admin actually edited are sent, so untouched secrets are
  // never overwritten by their masked echo.
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const byKey = new Map(data.map((s) => [s.key, s]));
  const setEdit = (key: string, value: string | boolean) =>
    setEdits((e) => ({ ...e, [key]: value }));

  const save = async () => {
    if (Object.keys(edits).length === 0) {
      setNotice('Nothing changed.');
      return;
    }
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await updateSettings(edits);
      setEdits({});
      setNotice('Saved. New requests use the updated settings immediately.');
      reload();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/45">
        These override the server environment: a value set here wins, otherwise the value from{' '}
        <code className="rounded bg-white/5 px-1">.env</code> is used. Secrets are stored encrypted
        and never shown in full.
      </p>

      {SETTING_GROUPS.map((group) => (
        <Card key={group.title}>
          <SectionLabel>{group.title}</SectionLabel>
          {group.note && <p className="mb-3 -mt-1 text-2xs text-white/40">{group.note}</p>}
          <div className="space-y-3">
            {group.keys.map((key) => {
              const s = byKey.get(key);
              if (!s) return null;
              return (
                <SettingField
                  key={key}
                  status={s}
                  draft={edits[key]}
                  onChange={(v) => setEdit(key, v)}
                />
              );
            })}
          </div>
        </Card>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </PrimaryButton>
        <TestAiButton />
        {notice && <span className="text-xs text-emerald-300">{notice}</span>}
        {err && <span className="text-xs text-rose-300">{err}</span>}
      </div>
    </div>
  );
}

function TestAiButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const probe = await testAiConnection();
      setOk(probe.ok);
      setResult(`${probe.provider}/${probe.model}: ${probe.detail}`);
    } catch (e) {
      setOk(false);
      setResult(e instanceof AdminError ? e.message : 'Test failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GhostButton onClick={test} disabled={busy}>
        {busy ? 'Testing…' : 'Test AI connection'}
      </GhostButton>
      {result && (
        <span className={`text-xs ${ok ? 'text-emerald-300' : 'text-rose-300'}`}>{result}</span>
      )}
    </>
  );
}

function SettingField({
  status,
  draft,
  onChange,
}: {
  status: SettingStatus;
  draft: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const label = LABELS[status.key] ?? status.key;
  const badge =
    status.source === 'db' ? (
      <span className="rounded-full bg-accent-muted px-2 py-0.5 text-[10px] font-medium uppercase text-accent">
        Managed here
      </span>
    ) : status.source === 'env' ? (
      <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase text-white/45">
        From env
      </span>
    ) : (
      <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase text-amber-200">
        Not set
      </span>
    );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="w-40 shrink-0">
        <p className="text-xs font-medium text-white/80">{label}</p>
        <p className="font-mono text-[10px] text-white/30">{status.key}</p>
      </div>
      <div className="flex-1">
        {status.kind === 'bool' ? (
          (() => {
            const on = draft !== undefined ? Boolean(draft) : Boolean(status.value);
            return (
              <label className="flex items-center gap-2 text-xs text-white/60">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => onChange(e.target.checked)}
                  className="accent-accent"
                />
                {on ? 'Enabled' : 'Disabled'}
              </label>
            );
          })()
        ) : status.kind === 'enum' ? (
          <select
            value={draft !== undefined ? String(draft) : String(status.value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white focus:border-accent/40 focus:outline-none"
          >
            {(status.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : status.kind === 'secret' ? (
          <input
            type="password"
            value={typeof draft === 'string' ? draft : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={status.configured ? `configured (${status.masked})` : 'not set'}
            autoComplete="new-password"
            className="w-full max-w-md rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white placeholder:text-white/30 focus:border-accent/40 focus:outline-none"
          />
        ) : (
          <input
            type="text"
            value={typeof draft === 'string' ? draft : (String(status.value ?? '') as string)}
            onChange={(e) => onChange(e.target.value)}
            className="w-full max-w-md rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-white placeholder:text-white/30 focus:border-accent/40 focus:outline-none"
          />
        )}
      </div>
      <div className="shrink-0">{badge}</div>
    </div>
  );
}

// -------------------------------------------------------------- shared bits

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-[0.14em] text-white/35">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-hairline text-2xs uppercase tracking-[0.12em] text-white/35">
            {head.map((h, i) => (
              <th key={i} className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-hairline/50 last:border-0">
              {row.map((cell, c) => (
                <td key={c} className="py-2.5 pr-4 text-white/75">
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
