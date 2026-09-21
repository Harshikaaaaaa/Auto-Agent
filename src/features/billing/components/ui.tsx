import React from 'react';

/**
 * Small presentational primitives shared by the billing pages, styled with the
 * app's design tokens (surface/accent/hairline, glass-panel, 2xs labels) so the
 * billing area is indistinguishable from the rest of the product.
 */

export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-hairline bg-surface-1 p-5 shadow-panel ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-white/35">
      {children}
    </p>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-xs font-semibold text-black shadow-glow transition duration-fast ease-smooth hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30 disabled:shadow-none"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl px-3 py-1.5 text-xs font-medium transition duration-fast ease-smooth disabled:opacity-30 ${
        active
          ? 'bg-accent-muted text-accent ring-1 ring-inset ring-accent/25'
          : 'text-white/60 hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

/** Loading / empty / error states, so every page handles all three. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="py-10 text-center text-sm text-white/40">{label}</p>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-subtle bg-surface-1/50 py-10 text-center text-sm text-white/40">
      {children}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-2xl border border-rose-400/25 bg-rose-400/[0.06] p-5 text-sm text-rose-200">
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-white/70 transition hover:bg-white/[0.06] hover:text-white"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** A simple, dependency-free horizontal bar chart in SVG. */
export function BarChart({
  data,
  formatValue = (n) => String(n),
}: {
  data: Array<{ label: string; value: number }>;
  formatValue?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-2.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-white/60" title={d.label}>
            {d.label}
          </span>
          <div className="relative h-4 flex-1 overflow-hidden rounded-md bg-surface-2">
            <div
              className="h-full rounded-md bg-accent/70"
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }}
            />
          </div>
          <span className="w-24 shrink-0 text-right text-xs tabular-nums text-white/70">
            {formatValue(d.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
