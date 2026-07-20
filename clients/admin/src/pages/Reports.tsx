import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Button from '../components/Button';
import { HttpReportRepository } from '../api/HttpReportRepository';
import type { ReportRepository } from '../api/ReportRepository';
import { useSession } from '../session/SessionProvider';
import type { ProfitBucket, ProfitabilityReport } from '../types';

const repository: ReportRepository = new HttpReportRepository();

const WINDOWS = [
  { days: 7, label: '٧ أيام' },
  { days: 30, label: '٣٠ يومًا' },
  { days: 90, label: '٩٠ يومًا' },
];

// One hue, two steps, validated as an ordinal ramp against the white card:
// profit is the dark end, the cost it came out of the light end. Revenue we
// cannot cost is not a third colour — it is a texture, because it is not data
// of the same kind.
const PROFIT_FILL = '#6930bd'; // twilight-700
const COGS_FILL = '#a687f0'; // twilight-400

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Reports() {
  const { can } = useSession();
  const mayView = can('view_finance');

  const [days, setDays] = useState(30);
  const [report, setReport] = useState<ProfitabilityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback((window: number) => {
    setLoading(true);
    setError(false);
    repository
      .getProfitability(window)
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (mayView) load(days);
  }, [days, load, mayView]);

  // The API refuses this to anyone outside FINANCE_ROLES; this is the courtesy
  // version of the same answer, so a cashier is not shown a broken page.
  if (!mayView) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold tracking-tight text-surface-dark">الأرباح</h1>
        <p className="mt-4 rounded-xl border border-surface-sand-border bg-surface-sand-alt/60 px-4 py-3 text-sm text-slate-500">
          تقارير الأرباح متاحة للمالك والمديرين والمحاسب.
        </p>
      </div>
    );
  }

  const summary = report?.summary;

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">الأرباح</h1>
          <p className="mt-1 text-sm text-slate-500">
            الإيرادات مقابل تكلفة المبيعات المسجّلة وقت البيع — لا تتغيّر بتغيّر أسعار الشراء لاحقًا.
          </p>
        </div>
        {/* Filters in one row above the figures. */}
        <div className="flex gap-2" role="group" aria-label="المدة الزمنية">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              aria-pressed={days === w.days}
              className={[
                'rounded-lg px-3 py-1.5 text-xs font-bold transition-colors',
                days === w.days
                  ? 'bg-twilight-600 text-white'
                  : 'border border-surface-sand-border bg-white text-slate-600 hover:bg-surface-sand-alt',
              ].join(' ')}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center">
          <p className="mb-3 text-sm text-destructive-strong">
            تعذّر تحميل التقرير. تأكّد من تسجيل الدخول ومن تشغيل الخادم.
          </p>
          <Button variant="secondary" onClick={() => load(days)}>
            إعادة المحاولة
          </Button>
        </div>
      ) : loading || !summary || !report ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-slate-400">
          جارٍ التحميل…
        </div>
      ) : summary.revenue === 0 ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-slate-400">
          لا توجد مبيعات في هذه المدة.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="الإيرادات" value={`${money(summary.revenue)} ج.م`} />
            <Stat label="تكلفة المبيعات" value={`${money(summary.cogs)} ج.م`} />
            <Stat label="مجمل الربح" value={`${money(summary.gross_profit)} ج.م`} accent />
            <Stat
              label="هامش الربح"
              value={summary.margin_pct === null ? '—' : `${summary.margin_pct.toFixed(1)}%`}
              accent
            />
          </div>

          <CoverageNote summary={summary} />

          <DailyChart report={report} />

          <ItemTable report={report} />
        </>
      )}
    </div>
  );
}

/**
 * How much of the takings the margin above actually speaks for. Shown whenever
 * anything is uncosted: a margin over 40% of revenue is a very different claim
 * from a margin over all of it, and the difference must not be silent.
 */
function CoverageNote({ summary }: { summary: ProfitBucket }) {
  if (summary.uncosted_line_count === 0) return null;

  return (
    <p className="mt-4 rounded-xl border border-warning-soft bg-warning-soft/40 px-4 py-3 text-xs font-semibold text-warning-strong">
      الهامش أعلاه محسوب على{' '}
      <span className="font-numerals">{summary.coverage_pct?.toFixed(1) ?? '0'}%</span> من الإيرادات
      فقط. مبلغ <span className="font-numerals">{money(summary.uncosted_revenue)}</span> ج.م من
      المبيعات ({summary.uncosted_line_count} سطر) بيع دون تكلفة معروفة — مكوّن نفد من المخزون أو صنف
      بلا وصفة. التكلفة الحقيقية أعلى، والربح الفعلي أقل.
    </p>
  );
}

/**
 * Where each day's takings went: profit, the cost it came out of, and revenue
 * that could not be costed. The three segments sum to that day's revenue.
 *
 * One measure, one axis — margin percentage deliberately does NOT share this
 * chart, because a second scale on the same plot invites reading a percentage
 * off a money axis.
 */
function DailyChart({ report }: { report: ProfitabilityReport }) {
  const days = report.by_day;
  const peak = Math.max(...days.map((d) => d.revenue), 0);
  if (peak <= 0) return null;

  const H = 168;
  const GAP = 2; // surface gap between stacked fills
  const slot = 100 / days.length;
  const barW = Math.min(slot * 0.62, 7);

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-sand-border px-6 py-4">
        <h2 className="text-sm font-bold text-surface-dark">الإيراد اليومي وتوزيعه</h2>
        {/* Two or more series always carry a legend: identity is never colour alone. */}
        <ul className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
          <LegendKey label="مجمل الربح" swatch={<span style={{ background: PROFIT_FILL }} className="block h-2.5 w-2.5 rounded-sm" />} />
          <LegendKey label="تكلفة المبيعات" swatch={<span style={{ background: COGS_FILL }} className="block h-2.5 w-2.5 rounded-sm" />} />
          <LegendKey
            label="إيراد بلا تكلفة معروفة"
            swatch={
              <span className="block h-2.5 w-2.5 rounded-sm border border-slate-300 bg-[repeating-linear-gradient(45deg,#cbd5e1_0_2px,transparent_2px_4px)]" />
            }
          />
        </ul>
      </div>

      {/* dir=ltr so the time axis reads oldest -> newest regardless of page direction. */}
      <div dir="ltr" className="px-6 py-5">
        <svg
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          className="h-44 w-full"
          role="img"
          aria-label={`إيراد يومي على مدى ${report.days} يومًا، أعلى قيمة ${money(peak)} جنيه`}
        >
          <defs>
            <pattern id="uncostedHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="4" fill="#f1f5f9" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="#cbd5e1" strokeWidth="2" />
            </pattern>
          </defs>

          {/* Recessive baseline. */}
          <line x1="0" y1={H - 12} x2="100" y2={H - 12} stroke="#e6dcc8" strokeWidth="1" />

          {days.map((d, i) => {
            const scale = (v: number) => (v / peak) * (H - 24);
            const x = i * slot + (slot - barW) / 2;
            const profitH = Math.max(scale(Math.max(d.gross_profit, 0)), 0);
            const cogsH = Math.max(scale(d.cogs), 0);
            const uncostedH = Math.max(scale(d.uncosted_revenue), 0);

            let y = H - 12;
            const segs: Array<{ h: number; fill: string; label: string }> = [];
            if (uncostedH > 0) segs.push({ h: uncostedH, fill: 'url(#uncostedHatch)', label: 'بلا تكلفة معروفة' });
            if (cogsH > 0) segs.push({ h: cogsH, fill: COGS_FILL, label: 'تكلفة المبيعات' });
            if (profitH > 0) segs.push({ h: profitH, fill: PROFIT_FILL, label: 'مجمل الربح' });

            return (
              <g key={d.day}>
                {segs.map((s, idx) => {
                  y -= s.h;
                  const rect = (
                    <rect
                      key={s.label}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(s.h - (idx < segs.length - 1 ? GAP : 0), 0.5)}
                      rx={idx === segs.length - 1 ? 1.5 : 0}
                      fill={s.fill}
                    >
                      {/* Native tooltip: hover detail without a JS layer. */}
                      <title>
                        {`${d.day} — ${s.label}: ${money(
                          s.label === 'مجمل الربح'
                            ? d.gross_profit
                            : s.label === 'تكلفة المبيعات'
                              ? d.cogs
                              : d.uncosted_revenue,
                        )} ج.م (إيراد اليوم ${money(d.revenue)} ج.م)`}
                      </title>
                    </rect>
                  );
                  y -= idx < segs.length - 1 ? GAP : 0;
                  return rect;
                })}
              </g>
            );
          })}
        </svg>

        <div className="mt-1 flex justify-between font-numerals text-[10px] text-slate-400">
          <span>{days[0]?.day}</span>
          <span>{days[days.length - 1]?.day}</span>
        </div>
      </div>
    </section>
  );
}

function LegendKey({ label, swatch }: { label: string; swatch: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      {swatch}
      <span>{label}</span>
    </li>
  );
}

/**
 * Which dishes actually earn. Also the table view that gives the chart's lighter
 * fill its required relief — every figure in the plot is legible as text here.
 */
function ItemTable({ report }: { report: ProfitabilityReport }) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="border-b border-surface-sand-border px-6 py-4">
        <h2 className="text-sm font-bold text-surface-dark">الربح حسب الصنف</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-sand-border text-sm">
          <caption className="sr-only">ربح كل صنف خلال المدة المحددة</caption>
          <thead className="bg-surface-sand-alt/60">
            <tr>
              <Th>الصنف</Th>
              <Th>الوحدات</Th>
              <Th>الإيرادات</Th>
              <Th>التكلفة</Th>
              <Th>مجمل الربح</Th>
              <Th>الهامش</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-sand-border/70">
            {report.by_item.map((item) => {
              // Nothing about this dish's cost is known, so no cost, no profit
              // and no margin are stated. Printing 0.00 would read as "cost
              // nothing, earned nothing" rather than "we do not know".
              const known = item.costed_revenue > 0;
              // Cost and profit are computed over the costed portion only, so a
              // partly costed row shows that base — otherwise profit ÷ revenue
              // does not reproduce the margin and the table looks wrong.
              const partial = item.uncosted_line_count > 0;

              return (
                <tr key={item.id} className="transition-colors hover:bg-surface-sand/60">
                  <td className="px-6 py-4 font-semibold text-surface-dark">
                    {item.name}
                    {partial && (
                      <span
                        className="ms-2 text-[11px] font-semibold text-warning-strong"
                        title={`${item.uncosted_line_count} عملية بيع بلا تكلفة معروفة`}
                      >
                        جزئي
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-numerals text-slate-600">{item.units_sold}</td>
                  <td className="px-6 py-4">
                    <span className="font-numerals text-slate-600">{money(item.revenue)}</span>
                    {partial && known && (
                      <span className="mt-0.5 block text-[11px] text-slate-400">
                        مُسعّر منها{' '}
                        <span className="font-numerals">{money(item.costed_revenue)}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-numerals text-slate-600">
                    {known ? money(item.cogs) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-4 font-numerals font-semibold text-surface-dark">
                    {known ? money(item.gross_profit) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-4 font-numerals font-semibold text-surface-dark">
                    {item.margin_pct === null ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      `${item.margin_pct.toFixed(1)}%`
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-surface-sand-border bg-white p-5 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={[
          'mt-1.5 font-numerals text-xl font-bold',
          accent ? 'text-twilight-700' : 'text-surface-dark',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-slate-500"
    >
      {children}
    </th>
  );
}
