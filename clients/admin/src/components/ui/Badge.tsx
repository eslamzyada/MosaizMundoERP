import type { ReactNode } from 'react';

export type BadgeVariant =
  | 'success'
  | 'destructive'
  | 'warning'
  | 'neutral'
  | 'twilight'
  | 'amber';

const VARIANTS: Record<BadgeVariant, string> = {
  success: 'bg-success-soft text-success-strong',
  destructive: 'bg-destructive-soft text-destructive-strong',
  warning: 'bg-warning-soft text-warning-strong',
  neutral: 'bg-slate-100 text-app-ink-muted',
  // Brand accents (non-semantic) — e.g. ingredient categories.
  twilight: 'bg-twilight-100 text-twilight-700',
  amber: 'bg-amber-100 text-amber-800',
};

export default function Badge({
  variant = 'neutral',
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${VARIANTS[variant]}`}
    >
      {children}
    </span>
  );
}
