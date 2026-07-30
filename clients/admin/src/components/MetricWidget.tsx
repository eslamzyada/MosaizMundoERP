import type { ReactNode } from 'react';

type Accent = 'sunset' | 'twilight' | 'amber';

const ACCENT: Record<Accent, { bar: string; icon: string }> = {
  sunset: { bar: 'bg-sunset-500', icon: 'bg-sunset-50 text-sunset-600' },
  twilight: { bar: 'bg-twilight-500', icon: 'bg-twilight-50 text-twilight-600' },
  amber: { bar: 'bg-amber-500', icon: 'bg-amber-50 text-amber-600' },
};

interface MetricWidgetProps {
  label: string;
  value: string;
  /** Optional unit shown after the value (e.g. a currency), in Cairo. */
  suffix?: string;
  accent: Accent;
  icon: ReactNode;
  loading?: boolean;
}

export default function MetricWidget({
  label,
  value,
  suffix,
  accent,
  icon,
  loading = false,
}: MetricWidgetProps) {
  const a = ACCENT[accent];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
      <span className={`absolute inset-y-0 end-0 w-1 ${a.bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-app-ink-muted">
            {label}
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="font-numerals text-3xl font-bold text-app-ink">
              {loading ? '—' : value}
            </span>
            {suffix && !loading ? (
              <span className="text-sm font-medium text-app-ink-muted">{suffix}</span>
            ) : null}
          </div>
        </div>
        <span className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl ${a.icon}`}>
          {icon}
        </span>
      </div>
    </div>
  );
}
