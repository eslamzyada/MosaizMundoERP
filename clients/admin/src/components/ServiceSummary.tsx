import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';

/**
 * What the service cost, and what it earned.
 *
 * The headline is labour as a share of revenue, because that is the number a
 * restaurant is actually run by — and everything else on this page is a
 * quantity, not a ratio.
 *
 * The rendering rule matters as much as the arithmetic: a section the tenant
 * does not run is ABSENT, a figure this reader may not see is UNKNOWN, and a
 * real none is 0. Collapsing any pair of those puts a plausible wrong number
 * in front of somebody who will act on it.
 */

interface ServiceReport {
  revenue: number;
  orders: number;
  labour: {
    hours: number;
    cost: number | null;
    uncosted_entries: number;
    share_of_revenue: number | null;
  } | null;
  covers: {
    booked: number;
    seated: number;
    no_show: number;
    cancelled: number;
    turned_into_money: number;
    no_show_rate: number | null;
  } | null;
  online: {
    received: number;
    accepted: number;
    rejected: number;
    pending: number;
    acceptance_rate: number | null;
  } | null;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ServiceSummary({ from, to }: { from: Date; to: Date }) {
  const [report, setReport] = useState<ServiceReport | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get<ServiceReport>('/api/reports/service', {
        params: { from: from.toISOString(), to: to.toISOString() },
      });

      // The one field every restaurant has. Checked because this card sits at
      // the top of the page: a payload missing it would otherwise throw inside
      // render and take the whole dashboard down with it, which is a steep
      // price for one summary. One bad response costs one card.
      if (typeof data?.revenue !== 'number') {
        setFailed(true);
        return;
      }

      setReport(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <p className="text-sm text-app-ink-muted">تعذّر تحميل ملخّص الخدمة.</p>
      </section>
    );
  }

  if (!report) return null;

  return (
    <section
      className="rounded-xl border border-app-border bg-app-surface p-4"
      data-testid="service-summary"
    >
      <h2 className="text-sm font-bold text-app-ink">ملخّص الخدمة</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="الإيراد" value={`${money(report.revenue)} ج.م`} />

        {/* Absent when the restaurant does not run labour — not a zero. */}
        {report.labour && (
          <>
            <Figure
              label="ساعات العمل"
              value={String(report.labour.hours)}
              testId="labour-hours"
            />
            <Figure
              label="نسبة الأجور من الإيراد"
              testId="labour-share"
              value={
                report.labour.share_of_revenue === null
                  ? 'غير معروفة'
                  : `${report.labour.share_of_revenue}%`
              }
              // The one figure worth colouring: past a third of takings, a
              // restaurant is working for its own payroll.
              accent={
                report.labour.share_of_revenue !== null && report.labour.share_of_revenue > 33
              }
              hint={
                report.labour.uncosted_entries > 0
                  ? `${report.labour.uncosted_entries} تسجيل بلا أجر معروف — غير محسوب`
                  : undefined
              }
            />
          </>
        )}

        {report.covers && (
          <Figure
            label="الحجوزات"
            testId="covers"
            value={`${report.covers.seated} / ${report.covers.booked}`}
            hint={
              report.covers.no_show_rate === null
                ? undefined
                : `${report.covers.no_show_rate}% لم يحضروا · ${report.covers.turned_into_money} فتحت حسابًا`
            }
          />
        )}

        {report.online && (
          <Figure
            label="طلبات الإنترنت"
            testId="online"
            value={`${report.online.accepted} / ${report.online.received}`}
            // Pending is the one that needs somebody NOW: a request nobody
            // answered is a customer waiting.
            accent={report.online.pending > 0}
            hint={
              report.online.pending > 0
                ? `${report.online.pending} بانتظار الردّ`
                : undefined
            }
          />
        )}
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  hint,
  accent,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  testId?: string;
}) {
  return (
    <div className="rounded-lg bg-app-bg px-3 py-2" data-testid={testId}>
      <p className="text-xs text-app-ink-muted">{label}</p>
      <p
        className={[
          'font-numerals mt-0.5 text-lg font-bold',
          accent ? 'text-sunset-600' : 'text-app-ink',
        ].join(' ')}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-app-ink-muted">{hint}</p>}
    </div>
  );
}
