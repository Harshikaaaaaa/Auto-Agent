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
  fetchAdminPackages,
  fetchAdminPlans,
  fetchCoupons,
  fetchRates,
  fetchSettings,
  fetchUserDetail,
  fetchUsers,
  updateRate,
  updateSettings,
  type AdminUserDetail,
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
  const users = useLoader(() => fetchUsers());
  const plans = useLoader(fetchAdminPlans);
  const rates = useLoader(fetchRates);

  if (users.loading || plans.loading || rates.loading) return <Loading />;
  if (users.error) return <ErrorState message={users.error} onRetry={users.reload} />;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <SectionLabel>Users</SectionLabel>
          <p className="text-3xl font-semibold tabular-nums">{users.data?.length ?? 0}</p>
        </Card>
        <Card>
          <SectionLabel>Plans</SectionLabel>
          <p className="text-3xl font-semibold tabular-nums">{plans.data?.length ?? 0}</p>
        </Card>
        <Card>
          <SectionLabel>Rate rows</SectionLabel>
          <p className="text-3xl font-semibold tabular-nums">{rates.data?.length ?? 0}</p>
        </Card>
      </div>
      <Card>
        <SectionLabel>Quick links</SectionLabel>
        <p className="text-sm text-white/50">
          Manage accounts, adjust credits, edit the AI rate card, and review plans, packages, and
          coupons from the navigation on the left.
        </p>
      </Card>
    </div>
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
          <div>
            <p className="text-lg font-semibold">{data.user.email}</p>
            <p className="text-xs text-white/45">
              {data.user.ownerId} · {data.user.role} · {data.user.status}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total" value={formatCredits(data.wallet?.totalCredits ?? 0)} />
            <Stat label="Monthly" value={formatCredits(data.wallet?.subscriptionCredits ?? 0)} />
            <Stat label="Purchased" value={formatCredits(data.wallet?.purchasedCredits ?? 0)} />
            <Stat label="Bonus" value={formatCredits(data.wallet?.bonusCredits ?? 0)} />
          </div>

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
  if (!data || data.length === 0) return <EmptyState>No plans configured.</EmptyState>;

  return (
    <Card>
      <SectionLabel>Subscription plans</SectionLabel>
      <Table
        head={['Code', 'Name', 'Price', 'Cycle', 'Included credits']}
        rows={data.map((p) => [
          p.code,
          p.displayName,
          p.pricePaise > 0 ? formatRupees(p.pricePaise) : 'Free',
          p.billingCycle,
          formatCredits(p.includedCredits),
        ])}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ Packages

function PackagesPage() {
  const { data, loading, error, reload } = useLoader(fetchAdminPackages);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No packages configured.</EmptyState>;

  return (
    <Card>
      <SectionLabel>Credit packages</SectionLabel>
      <Table
        head={['Code', 'Name', 'Price', 'Credits', 'Bonus']}
        rows={data.map((p) => [
          p.code,
          p.displayName,
          formatRupees(p.pricePaise),
          formatCredits(p.credits),
          formatCredits(p.bonusCredits),
        ])}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ Rate card

function RatesPage() {
  const { data, loading, error, reload } = useLoader(fetchRates);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No rates configured.</EmptyState>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/45">
        Editing a rate affects new AI requests only — historical usage keeps the rate it was billed
        at.
      </p>
      {data.map((rate) => (
        <RateEditor key={rate.id} rate={rate} onSaved={reload} />
      ))}
    </div>
  );
}

function RateEditor({ rate, onSaved }: { rate: RateRow; onSaved: () => void }) {
  const [markup, setMarkup] = useState(String(rate.markup_multiplier_x10));
  const [feeBps, setFeeBps] = useState(String(rate.provider_fee_bps));
  const [enabled, setEnabled] = useState(rate.enabled);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await updateRate(rate.id, {
        markup_multiplier_x10: Math.max(0, Math.round(Number(markup))),
        provider_fee_bps: Math.max(0, Math.round(Number(feeBps))),
        enabled,
      });
      setNotice('Saved.');
      onSaved();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{rate.displayName}</p>
          <p className="text-2xs text-white/40">
            {rate.provider} · {rate.modelId}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Markup ×10">
            <input
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              inputMode="numeric"
              className="w-20 rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-xs text-white focus:border-accent/40 focus:outline-none"
            />
          </Field>
          <Field label="Fee bps">
            <input
              value={feeBps}
              onChange={(e) => setFeeBps(e.target.value)}
              inputMode="numeric"
              className="w-20 rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-xs text-white focus:border-accent/40 focus:outline-none"
            />
          </Field>
          <label className="flex items-center gap-1.5 text-xs text-white/60">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-accent"
            />
            Enabled
          </label>
          <PrimaryButton onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
      {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
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

// ------------------------------------------------------------------- Coupons

function CouponsPage() {
  const { data, loading, error, reload } = useLoader(fetchCoupons);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState>No coupons created.</EmptyState>;

  return (
    <Card>
      <SectionLabel>Coupons</SectionLabel>
      <Table
        head={['Code', 'Type', 'Value', 'Redeemed', 'Enabled']}
        rows={data.map((c) => [
          c.code,
          c.couponType,
          c.couponType === 'percentage'
            ? `${(c.percentBps ?? 0) / 100}%`
            : formatRupees(c.fixedDiscountPaise ?? 0),
          `${c.timesRedeemed}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}`,
          c.enabled ? 'Yes' : 'No',
        ])}
      />
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

      <div className="flex items-center gap-3">
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </PrimaryButton>
        {notice && <span className="text-xs text-emerald-300">{notice}</span>}
        {err && <span className="text-xs text-rose-300">{err}</span>}
      </div>
    </div>
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
