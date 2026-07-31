import type { ReactNode } from 'react';

/**
 * The frame every chart sits in.
 *
 * It exists mostly for one behaviour: an empty chart says WHY it is empty. A
 * card with an axis and no line is indistinguishable from a card that failed to
 * load, and the reader's next move is different in each case — wait and retry,
 * or widen the date range.
 */
export default function ChartCard({
  title,
  subtitle,
  isEmpty,
  emptyMessage = 'لا توجد بيانات في هذه الفترة.',
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  isEmpty?: boolean;
  emptyMessage?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-app-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-app-ink-muted">{subtitle}</p>}
        </div>
        {action}
      </header>

      {isEmpty ? (
        <p className="py-10 text-center text-sm text-app-ink-muted">{emptyMessage}</p>
      ) : (
        children
      )}
    </section>
  );
}

/** The colour of a series, as one of the five tokens that follow the theme. */
export type Tone = 1 | 2 | 3 | 4 | 5;

export const toneColor = (tone: Tone) => `rgb(var(--chart-${tone}))`;
