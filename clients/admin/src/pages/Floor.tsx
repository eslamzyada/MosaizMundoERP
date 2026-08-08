import { useCallback, useEffect, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import { floorRepository } from '../api/FloorRepository';
import type { Floor as FloorData, FloorTab, FloorTable } from '../api/FloorRepository';

/**
 * الصالة — the room, and what needs somebody in it.
 *
 * This used to be a list of open ORDERS, each named by whatever a server had
 * typed into its note. That answers "what is running" and nothing else, and
 * almost everything a manager walks in wanting to know is NOT in such a list:
 *
 *   a table sitting twenty minutes having ordered nothing has no items, so it
 *   never appeared at all — and it is the most urgent thing in the building;
 *   a FREE table is not an order, and how much of the room is empty is half of
 *   running a floor;
 *   a booking due in forty minutes on a table still eating is the only thing
 *   here that is about to become a problem rather than already being one.
 *
 * So the page is now the room. Sorted by what is WRONG rather than by time,
 * because a floor screen is read in three seconds while walking past it.
 */

/** Minutes past which an empty tab stops being "just sat down". */
const IGNORED_MINUTES = 15;
/** A booking this close to a table still eating needs somebody now. */
const IMMINENT_MINUTES = 60;

type Trouble = { label: string; tone: 'urgent' | 'warn' } | null;

/**
 * What is wrong with this table, in the order a person would care.
 *
 * Nothing-ordered outranks nothing-fired: a party with no order has not been
 * spoken to, while a party with unfired lines has at least been served by
 * somebody who has not pressed send.
 */
function troubleWith(table: FloorTable): Trouble {
  const tab = table.tab;
  if (!tab) return null;

  if (tab.item_count === 0 && tab.minutes_open >= IGNORED_MINUTES) {
    return { label: `جالسون منذ ${tab.minutes_open} دقيقة بلا طلب`, tone: 'urgent' };
  }
  if (tab.unfired_count > 0) {
    return { label: `${tab.unfired_count} صنف لم يُرسل للمطبخ`, tone: 'warn' };
  }
  if (table.next_reservation && table.next_reservation.minutes_until <= IMMINENT_MINUTES) {
    return {
      label: `حجز بعد ${Math.max(0, table.next_reservation.minutes_until)} دقيقة`,
      tone: 'warn',
    };
  }
  return null;
}

/** Sorted by urgency, then by how long they have been sitting. */
function ranked(tables: FloorTable[]): FloorTable[] {
  const weight = (t: FloorTable) => {
    const trouble = troubleWith(t);
    if (trouble?.tone === 'urgent') return 0;
    if (trouble?.tone === 'warn') return 1;
    if (t.tab) return 2;
    return 3; // free tables last: they are the only rows nobody must act on
  };
  return [...tables].sort(
    (a, b) => weight(a) - weight(b) || (b.tab?.minutes_open ?? 0) - (a.tab?.minutes_open ?? 0),
  );
}

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Floor() {
  const [floor, setFloor] = useState<FloorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);

  const load = useCallback(() => {
    setError(null);
    floorRepository
      .get()
      .then((data) => {
        setFloor(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(classifyLoadFailure(e));
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  // A floor screen that goes stale is a floor screen nobody trusts. Refetching
  // on focus costs one request and buys the assumption that what is shown is
  // what is true.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  if (error) {
    return (
      <div className="p-8">
        <LoadError failure={error} onRetry={load} />
      </div>
    );
  }

  if (loading || !floor) {
    return <p className="p-8 text-sm text-app-ink-muted">جارٍ التحميل…</p>;
  }

  const { tables, unseated_tabs: unseated, summary } = floor;

  return (
    <div className="p-8" data-testid="floor-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">الصالة</h1>
        <p className="mt-1 text-sm text-app-ink-muted">
          ما يحتاجك الآن أولًا — الطاولات المتأخرة، ثم ما لم يُرسل، ثم البقية.
        </p>
      </header>

      {/* The counts. Absent — not zero — when there is no floor plan at all. */}
      {tables !== null && (
        <section className="mb-6 grid gap-3 sm:grid-cols-3" data-testid="floor-summary">
          <Count label="مشغولة" value={summary.occupied ?? 0} testId="count-occupied" />
          <Count label="فارغة" value={summary.free ?? 0} testId="count-free" />
          <Count
            label="حجز قادم على طاولة مشغولة"
            value={summary.double_booked_soon ?? 0}
            testId="count-double"
            accent={(summary.double_booked_soon ?? 0) > 0}
          />
        </section>
      )}

      {tables === null ? (
        /* No floor plan, which is a fact about the restaurant rather than an
           empty room. Saying "0 tables" here would be false. */
        <p
          data-testid="no-floor-plan"
          className="mb-6 rounded-xl border border-dashed border-app-border p-6 text-center text-sm text-app-ink-muted"
        >
          هذا المطعم لا يعمل بنظام الطاولات. الحسابات المفتوحة معروضة بالأسفل.
        </p>
      ) : tables.length === 0 ? (
        <p className="mb-6 rounded-xl border border-dashed border-app-border p-6 text-center text-sm text-app-ink-muted">
          لا توجد طاولات بعد — تُضاف من شاشة الحجوزات.
        </p>
      ) : (
        <ul className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ranked(tables).map((table) => (
            <TableCard key={table.id} table={table} />
          ))}
        </ul>
      )}

      {unseated.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-bold text-app-ink">
            حسابات بلا طاولة{' '}
            <span className="font-numerals text-app-ink-muted">({unseated.length})</span>
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {unseated.map((tab) => (
              <li
                key={tab.id}
                data-testid={`unseated-${tab.id}`}
                className="rounded-xl border border-app-border bg-app-surface p-4 shadow-sm"
              >
                <p className="truncate font-semibold text-app-ink">
                  {tab.note ?? 'حساب بلا وصف'}
                </p>
                <TabFacts tab={tab} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  testId,
  accent,
}: {
  label: string;
  value: number;
  testId: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface px-4 py-3" data-testid={testId}>
      <p className="text-xs text-app-ink-muted">{label}</p>
      <p
        className={[
          'font-numerals mt-0.5 text-2xl font-bold',
          accent ? 'text-sunset-600' : 'text-app-ink',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}

function TableCard({ table }: { table: FloorTable }) {
  const trouble = troubleWith(table);
  const free = table.tab === null;

  return (
    <li
      data-testid={`table-${table.id}`}
      className={[
        'rounded-xl border bg-app-surface p-4 shadow-sm',
        trouble?.tone === 'urgent' ? 'border-sunset-400' : 'border-app-border',
        // A free table is deliberately quieter: it is the one row on this
        // screen nobody has to do anything about.
        free ? 'opacity-70' : '',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-app-ink">{table.label}</p>
          {table.area && <p className="text-xs text-app-ink-muted">{table.area}</p>}
        </div>
        <span
          data-testid={`state-${table.id}`}
          className={[
            'flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
            free ? 'bg-app-bg text-app-ink-muted' : 'bg-twilight-50 text-twilight-700',
          ].join(' ')}
        >
          {free ? 'فارغة' : 'مشغولة'}
        </span>
      </div>

      {trouble && (
        <p
          data-testid={`trouble-${table.id}`}
          className={[
            'mt-2 rounded-lg px-2 py-1 text-xs font-medium',
            trouble.tone === 'urgent'
              ? 'bg-sunset-50 text-sunset-700'
              : 'bg-app-bg text-app-ink-muted',
          ].join(' ')}
        >
          {trouble.label}
        </p>
      )}

      {table.tab ? (
        <TabFacts tab={table.tab} />
      ) : (
        table.next_reservation && (
          <p className="mt-2 text-xs text-app-ink-muted">
            محجوزة لـ{table.next_reservation.guest_name} بعد{' '}
            <span className="font-numerals">
              {Math.max(0, table.next_reservation.minutes_until)}
            </span>{' '}
            دقيقة
          </p>
        )
      )}
    </li>
  );
}

function TabFacts({ tab }: { tab: FloorTab }) {
  return (
    <dl className="mt-3 flex items-end justify-between gap-3 text-xs text-app-ink-muted">
      <div>
        <dt className="sr-only">مدة الجلوس</dt>
        <dd className="font-numerals">{tab.minutes_open} دقيقة</dd>
        <dt className="sr-only">الأصناف</dt>
        <dd className="font-numerals">{tab.item_count} صنف</dd>
      </div>
      <div className="text-left">
        <dt className="sr-only">الحساب</dt>
        <dd className="font-numerals text-base font-bold text-app-ink">
          {money(tab.total_amount)}
        </dd>
      </div>
    </dl>
  );
}
