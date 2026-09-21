import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, LayoutDashboard, LogOut, Package, User } from 'lucide-react';
import { fetchSession, logout, SIGNED_OUT, type SessionState } from './authClient';

/**
 * A small always-visible account menu (top-right) with the account email and
 * quick links to Billing, Plans, the Admin console (admins only), and Logout.
 *
 * It renders regardless of the canvas splash/workflow state so a brand-new user
 * — who has no workflow on the canvas yet — can still reach billing and sign
 * out. It reads its own session; the server remains the real authz boundary.
 */
export function AccountMenu() {
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState>(SIGNED_OUT);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        if (!cancelled) setSession(SIGNED_OUT);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Nothing to show for an unauthenticated caller (AuthGate handles that).
  if (!session.authenticated && !session.authDisabled) return null;

  const isAdmin = session.role === 'admin' || session.authDisabled;
  const label = session.email ?? (session.authDisabled ? 'Developer' : 'Account');

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const doLogout = async () => {
    setBusy(true);
    try {
      await logout();
    } finally {
      // Reload so AuthGate re-checks the (now cleared) session and shows sign-in.
      window.location.assign('/');
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={label}
        className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-2xs font-bold uppercase text-white/60 transition duration-fast ease-smooth hover:bg-white/5 hover:text-white"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-muted text-accent">
          <User className="h-3.5 w-3.5" />
        </span>
        <span className="max-w-[9rem] truncate normal-case tracking-normal text-white/70">
          {label}
        </span>
      </button>

      {open && (
        <div className="glass-panel absolute right-0 top-full z-40 mt-2 w-56 rounded-2xl p-1.5 shadow-float animate-fade-in">
          <div className="px-3 py-2">
            <p className="truncate text-xs font-semibold text-white/85">{label}</p>
            <p className="text-2xs uppercase tracking-[0.12em] text-white/35">
              {isAdmin ? 'Administrator' : 'Member'}
            </p>
          </div>
          <div className="my-1 h-px bg-hairline" />
          <MenuItem icon={CreditCard} onClick={() => go('/billing')}>
            Billing &amp; Usage
          </MenuItem>
          <MenuItem icon={Package} onClick={() => go('/billing/plans')}>
            Plans
          </MenuItem>
          {isAdmin && (
            <MenuItem icon={LayoutDashboard} onClick={() => go('/admin')}>
              Admin Console
            </MenuItem>
          )}
          <div className="my-1 h-px bg-hairline" />
          <MenuItem icon={LogOut} onClick={doLogout} disabled={busy} danger>
            {busy ? 'Signing out…' : 'Log out'}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition duration-fast ease-smooth disabled:opacity-50 ${
        danger
          ? 'text-rose-300 hover:bg-rose-500/10'
          : 'text-white/70 hover:bg-white/5 hover:text-white'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {children}
    </button>
  );
}
