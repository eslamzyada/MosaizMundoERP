import { useCallback, useEffect, useState } from 'react';
import LoadError from '../components/LoadError';
import ExportMenu from '../components/ExportMenu';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { HttpReportRepository } from '../api/HttpReportRepository';
import { HttpRatingRepository } from '../api/HttpRatingRepository';
import StarRating from '../components/StarRating';
import { RatingSparkline, TeamRatingTrend } from '../components/RatingHistory';
import type { ReportRepository } from '../api/ReportRepository';
import { useSession } from '../session/SessionProvider';
import { voidReasonLabel } from '../lib/voidReasons';
import { writeOffReasonLabel } from '../lib/writeOffReasons';
import type {
  CoverageGap,
  EmployeeRating,
  EmployeeReport,
  InventoryAssetsReport,
  ReportWindow,
  ProfitBucket,
  ProfitabilityReport,
  VoidsReport,
  WasteReport,
} from '../types';

const repository: ReportRepository = new HttpReportRepository();
const ratingRepository = new HttpRatingRepository();

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

  const [window, setWindow] = useState<ReportWindow>({ kind: 'rolling', days: 30 });
  // Draft dates, applied only when both are set — a half-typed range would
  // otherwise fire a request the server correctly refuses.
  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [report, setReport] = useState<ProfitabilityReport | null>(null);
  const [voids, setVoids] = useState<VoidsReport | null>(null);
  const [wasteReport, setWasteReport] = useState<WasteReport | null>(null);
  const [assets, setAssets] = useState<InventoryAssetsReport | null>(null);
  const [employees, setEmployees] = useState<EmployeeReport | null>(null);
  const [ratings, setRatings] = useState<EmployeeRating[]>([]);
  const [currentMonth, setCurrentMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);

  const load = useCallback((w: ReportWindow) => {
    setLoading(true);
    setError(null);
    repository
      .getProfitability(w)
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(classifyLoadFailure(e));
        setLoading(false);
      });

    // Fetched separately and failing quietly: voids are a secondary panel, and
    // losing them should not take down the profit figures this page exists for.
    repository
      .getVoids(w)
      .then(setVoids)
      .catch(() => setVoids(null));

    // Same treatment: a secondary panel must not take the profit figures down.
    repository
      .getWaste(w)
      .then(setWasteReport)
      .catch(() => setWasteReport(null));

    // Same treatment again: a secondary panel must not take the page down.
    repository
      .getInventoryAssets(w)
      .then(setAssets)
      .catch(() => setAssets(null));

    repository
      .getEmployees(w)
      .then(setEmployees)
      .catch(() => setEmployees(null));

    // Ratings are not part of the report: they are a separate record, fetched
    // separately and shown beside it. A cashier gets 403 here, which is the
    // point — the catch leaves the column simply absent for them.
    ratingRepository
      .list()
      .then((r) => {
        setRatings(r.ratings);
        setCurrentMonth(r.current_month);
      })
      .catch(() => setRatings([]));
  }, []);

  useEffect(() => {
    if (mayView) load(window);
  }, [window, load, mayView]);

  // The API refuses this to anyone outside FINANCE_ROLES; this is the courtesy
  // version of the same answer, so a cashier is not shown a broken page.
  if (!mayView) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">الأرباح</h1>
        <p className="mt-4 rounded-xl border border-app-border bg-app-surface-alt/60 px-4 py-3 text-sm text-app-ink-muted">
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
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">الأرباح</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            الإيرادات مقابل تكلفة المبيعات المسجّلة وقت البيع — لا تتغيّر بتغيّر أسعار الشراء لاحقًا.
          </p>
          {/* On screen this is context; on paper it is the whole provenance of
              the sheet. A printed report that does not say which period it
              covers cannot be filed, compared, or trusted a month later. */}
          {report && (
            <p className="mt-1 text-xs text-app-ink-muted">
              الفترة{' '}
              <span className="font-numerals font-semibold text-app-ink">
                {report.from}
              </span>{' '}
              إلى{' '}
              <span className="font-numerals font-semibold text-app-ink">{report.to}</span>
              {report.days !== null && (
                <span className="text-app-ink-muted"> (آخر {report.days} يومًا)</span>
              )}
              <span className="hidden print:inline">
                {' '}· طُبع{' '}
                <span className="font-numerals">
                  {new Date().toLocaleDateString('en-GB')}
                </span>
              </span>
            </p>
          )}
        </div>
        {/* Presets answer "how are we doing now"; the dates answer "how did
            last month go" — and only the second can be quoted in a meeting,
            because it does not slide forward every time the page reloads. */}
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <div className="flex gap-2" role="group" aria-label="المدة الزمنية">
            {WINDOWS.map((w) => {
              const active = window.kind === 'rolling' && window.days === w.days;
              return (
                <button
                  key={w.days}
                  type="button"
                  onClick={() => {
                    setFromDraft('');
                    setToDraft('');
                    setWindow({ kind: 'rolling', days: w.days });
                  }}
                  aria-pressed={active}
                  className={[
                    'rounded-lg px-3 py-1.5 text-xs font-bold transition-colors',
                    active
                      ? 'bg-twilight-600 text-white'
                      : 'border border-app-border bg-app-surface text-app-ink-muted hover:bg-app-surface-alt',
                  ].join(' ')}
                >
                  {w.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              aria-label="من تاريخ"
              value={fromDraft}
              max={toDraft || undefined}
              onChange={(e) => {
                setFromDraft(e.target.value);
                if (e.target.value && toDraft) {
                  setWindow({ kind: 'range', from: e.target.value, to: toDraft });
                }
              }}
              className="rounded-lg border border-app-border bg-app-surface px-2 py-1.5 font-numerals text-xs text-app-ink-muted"
            />
            <span className="text-xs text-app-ink-muted">—</span>
            <input
              type="date"
              aria-label="إلى تاريخ"
              value={toDraft}
              min={fromDraft || undefined}
              onChange={(e) => {
                setToDraft(e.target.value);
                if (fromDraft && e.target.value) {
                  setWindow({ kind: 'range', from: fromDraft, to: e.target.value });
                }
              }}
              className="rounded-lg border border-app-border bg-app-surface px-2 py-1.5 font-numerals text-xs text-app-ink-muted"
            />
          </div>

          <button
            type="button"
            onClick={() => globalThis.print()}
            className="rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-xs font-bold text-app-ink-muted transition-colors hover:bg-app-surface-alt"
          >
            طباعة
          </button>
        </div>
      </header>

      {error ? (
        <div className="rounded-2xl border border-dashed border-app-border bg-app-surface p-12">
          <LoadError failure={error} onRetry={() => load(window)} />
        </div>
      ) : loading || !summary || !report ? (
        <div className="rounded-2xl border border-dashed border-app-border bg-app-surface p-12 text-center text-sm text-app-ink-muted">
          جارٍ التحميل…
        </div>
      ) : summary.revenue === 0 ? (
        <div className="rounded-2xl border border-dashed border-app-border bg-app-surface p-12 text-center text-sm text-app-ink-muted">
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

          <CoverageGaps gaps={report.coverage_gaps} />

          <DailyChart report={report} />

          <ItemTable report={report} period={window} />
        </>
      )}

      {/* Outside the revenue guard on purpose: a window can hold voids and no
          completed sales, and that is precisely a period worth looking at. */}
      {voids && voids.summary.void_count > 0 && <VoidsPanel report={voids} period={window} />}

      {wasteReport && wasteReport.summary.write_off_count > 0 && (
        <WastePanel report={wasteReport} period={window} />
      )}

      {/* Shown whenever there is stock at all: "what am I holding" is a question
          worth answering even in a period with no sales — arguably especially
          then, since that is when capital sits still. */}
      {assets && assets.summary.capital_tied_up > 0 && <AssetsPanel report={assets} period={window} />}

      {/* Shown whenever there is a team, NOT only when somebody sold something.
          This used to be gated on sales in the window, which meant a quiet week
          hid the whole panel — and took the manager's ratings with it, though
          ratings have nothing to do with the week's takings. A quiet week is
          exactly when somebody sits down to do them. */}
      {employees && employees.employees.length > 0 && (
        <EmployeePanel
          report={employees}
          period={window}
          ratings={ratings}
          currentMonth={currentMonth}
          onRate={async (employeeId, score) => {
            await ratingRepository.save({
              employee_id: employeeId,
              period_month: currentMonth,
              score,
            });
            const fresh = await ratingRepository.list();
            setRatings(fresh.ratings);
          }}
        />
      )}
    </div>
  );
}

/**
 * What voiding cost, by cause (0022).
 *
 * The two money columns are deliberately not added together, because they are
 * not the same loss. Lost revenue is often recovered — a mis-tap gets re-rung a
 * moment later and the customer still pays. Ingredient cost is food that was
 * made and cannot be sold, and it is gone for good. A month of wrong_item voids
 * that all restored their stock costs almost nothing and means "fix the button
 * layout"; the same count of kitchen_error voids that did not means the kitchen
 * is throwing away food. One total would hide exactly that difference.
 */
function VoidsPanel({ report, period }: { report: VoidsReport; period: ReportWindow }) {
  const worst = [...report.by_reason].sort(
    (a, b) => b.ingredient_cost_lost - a.ingredient_cost_lost,
  )[0];

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-app-ink">الإلغاءات وأسبابها</h2>
          <ExportMenu report="voids" window={period} />
        </div>
        <p className="mt-1 text-xs text-app-ink-muted">
          <span className="font-numerals font-semibold">{report.summary.void_count}</span> طلب
          مُلغى في هذه المدة. الإيراد الضائع غالبًا يُستردّ بإعادة التسجيل؛ تكلفة المكوّنات هي ما
          فُقد فعلًا.
        </p>
      </div>

      {worst && worst.ingredient_cost_lost > 0 && (
        <p className="border-b border-app-border bg-warning-soft/30 px-6 py-3 text-xs text-app-ink">
          أكبر خسارة فعلية من <strong>{voidReasonLabel(worst.reason)}</strong> — طعام حُضِّر ولم
          يُبَع بقيمة{' '}
          <span className="font-numerals font-bold">{money(worst.ingredient_cost_lost)}</span> ج.م.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-app-border text-sm">
          <thead className="bg-app-surface-alt/60">
            <tr>
              <Th>السبب</Th>
              <Th>عدد الإلغاءات</Th>
              <Th>أُعيدت المكوّنات</Th>
              <Th>الإيراد الضائع</Th>
              <Th>تكلفة مكوّنات مفقودة</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/70">
            {report.by_reason.map((r) => (
              <tr key={r.reason} className="transition-colors hover:bg-app-bg/60">
                <td className="px-6 py-3.5 font-semibold text-app-ink">
                  {voidReasonLabel(r.reason)}
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals text-app-ink">{r.void_count}</span>
                </td>
                <td className="px-6 py-3.5 text-app-ink-muted">
                  <span className="font-numerals">{r.stock_returned_count}</span>
                  <span className="mx-1 text-slate-300">/</span>
                  <span className="font-numerals">{r.void_count}</span>
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals text-app-ink-muted">{money(r.lost_revenue)}</span>
                </td>
                <td className="px-6 py-3.5">
                  <span
                    className={`font-numerals font-semibold ${
                      r.ingredient_cost_lost > 0 ? 'text-destructive-strong' : 'text-app-ink-muted'
                    }`}
                  >
                    {money(r.ingredient_cost_lost)}
                  </span>
                  {/* Say when the figure is a floor, not a total. */}
                  {r.uncosted_void_count > 0 && (
                    <span className="ms-1.5 text-xs text-app-ink-muted">
                      (+<span className="font-numerals">{r.uncosted_void_count}</span> بلا تكلفة
                      معروفة)
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.by_actor.length > 0 && (
        <div className="border-t border-app-border px-6 py-4">
          <p className="text-xs font-bold text-app-ink">من اعتمد الإلغاء</p>
          {/* Not a leaderboard: whoever covers the busiest shift authorises the
              most corrections, and that is the job. It is here so a genuine
              outlier can be noticed at all. */}
          <p className="mt-0.5 text-xs text-app-ink-muted">
            الأكثر عددًا ليس بالضرورة الأكثر خطأً — من يغطّي أزحم الورديات يعتمد أكثر التصحيحات.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {report.by_actor.map((a) => (
              <li key={a.user_id ?? 'unknown'} className="text-xs text-app-ink-muted">
                {a.email ?? '—'}{' '}
                <span className="font-numerals font-semibold text-app-ink">
                  {a.void_count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
 * The coverage note says how much revenue could not be costed. This says WHY,
 * per dish, and what would fix it — turning a warning into a list of actions.
 *
 * Dishes whose blocker has already been cleared are shown last and greyed: the
 * revenue stays uncosted (the sale is history), but nothing needs doing, and
 * demanding action for them would train the reader to ignore the list.
 */
function CoverageGaps({ gaps }: { gaps: CoverageGap[] }) {
  if (gaps.length === 0) return null;

  const rank = { no_recipe: 0, unstocked_ingredients: 1, already_resolved: 2 } as const;
  const ordered = [...gaps].sort(
    (a, b) => rank[a.reason] - rank[b.reason] || b.uncosted_revenue - a.uncosted_revenue,
  );
  const actionable = ordered.filter((g) => g.reason !== 'already_resolved').length;

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <h2 className="text-sm font-bold text-app-ink">لماذا لا يمكن تسعير هذه المبيعات؟</h2>
        <p className="mt-0.5 text-xs text-app-ink-muted">
          {actionable > 0
            ? `${actionable} صنف يحتاج إجراءً لرفع نسبة التغطية.`
            : 'كل الأسباب عولجت — المبيعات القادمة ستُسعَّر بالكامل.'}
        </p>
      </div>

      <ul className="divide-y divide-app-border/70">
        {ordered.map((gap) => {
          const resolved = gap.reason === 'already_resolved';
          return (
            <li
              key={gap.id}
              className={[
                'flex flex-wrap items-start justify-between gap-3 px-6 py-4',
                resolved ? 'opacity-60' : '',
              ].join(' ')}
            >
              <div className="min-w-0">
                <p className="font-semibold text-app-ink">{gap.name}</p>
                <p className="mt-0.5 text-xs text-app-ink-muted">
                  <span className="font-numerals">{money(gap.uncosted_revenue)}</span> ج.م عبر{' '}
                  <span className="font-numerals">{gap.uncosted_line_count}</span> عملية بيع
                </p>

                {gap.reason === 'no_recipe' && (
                  <p className="mt-1.5 text-xs font-semibold text-warning-strong">
                    لا توجد وصفة لهذا الصنف — أضف مكوّناته لتُحتسب تكلفته.
                  </p>
                )}
                {gap.reason === 'unstocked_ingredients' && (
                  <p className="mt-1.5 text-xs font-semibold text-warning-strong">
                    مكوّنات بلا رصيد:{' '}
                    {gap.blocking_ingredients.map((b) => b.name).join('، ')} — استلم مخزونًا منها.
                  </p>
                )}
                {resolved && (
                  <p className="mt-1.5 text-xs text-app-ink-muted">
                    عولج بالفعل — المبيعات السابقة تبقى بلا تكلفة، والقادمة ستُسعَّر.
                  </p>
                )}
              </div>

              {!resolved && (
                <Link
                  to={gap.reason === 'no_recipe' ? '/recipes' : '/inventory'}
                  className="rounded-lg border border-app-border px-3 py-1.5 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100"
                >
                  {gap.reason === 'no_recipe' ? 'إلى الوصفات' : 'إلى المخزون'}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-6 py-4">
        <h2 className="text-sm font-bold text-app-ink">الإيراد اليومي وتوزيعه</h2>
        {/* Two or more series always carry a legend: identity is never colour alone. */}
        <ul className="flex flex-wrap items-center gap-4 text-[11px] text-app-ink-muted">
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

        <div className="mt-1 flex justify-between font-numerals text-[10px] text-app-ink-muted">
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
function ItemTable({ report, period }: { report: ProfitabilityReport; period: ReportWindow }) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-app-ink">الربح حسب الصنف</h2>
          <ExportMenu report="profitability" window={period} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-app-border text-sm">
          <caption className="sr-only">ربح كل صنف خلال المدة المحددة</caption>
          <thead className="bg-app-surface-alt/60">
            <tr>
              <Th>الصنف</Th>
              <Th>الوحدات</Th>
              <Th>الإيرادات</Th>
              <Th>التكلفة</Th>
              <Th>مجمل الربح</Th>
              <Th>الهامش</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/70">
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
                <tr key={item.id} className="transition-colors hover:bg-app-bg/60">
                  <td className="px-6 py-4 font-semibold text-app-ink">
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
                  <td className="px-6 py-4 font-numerals text-app-ink-muted">{item.units_sold}</td>
                  <td className="px-6 py-4">
                    <span className="font-numerals text-app-ink-muted">{money(item.revenue)}</span>
                    {partial && known && (
                      <span className="mt-0.5 block text-[11px] text-app-ink-muted">
                        مُسعّر منها{' '}
                        <span className="font-numerals">{money(item.costed_revenue)}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-numerals text-app-ink-muted">
                    {known ? money(item.cogs) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-4 font-numerals font-semibold text-app-ink">
                    {known ? money(item.gross_profit) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-4 font-numerals font-semibold text-app-ink">
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
    <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-app-ink-muted">{label}</div>
      <div
        className={[
          'mt-1.5 font-numerals text-xl font-bold',
          accent ? 'text-twilight-700' : 'text-app-ink',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  );
}


/**
 * What the bin cost, by cause, by ingredient and by supplier (0023).
 *
 * Waste and total write-offs are shown as SEPARATE figures. A staff meal costs
 * exactly as much as a spoiled crate and is not a problem to fix; adding them
 * together would make a kitchen look worse the better it feeds its people.
 *
 * The headline is a PERCENTAGE, not the absolute figure, because the absolute
 * figure invites both panic and complacency: 4,000 wasted means something very
 * different against 20,000 of food sold than against 400,000. The denominator
 * is waste plus the cost of what actually sold — total food cost.
 */
function WastePanel({ report, period }: { report: WasteReport; period: ReportWindow }) {
  const { summary } = report;
  const share = summary.waste_share_pct;
  // Trade rule of thumb: low single digits is healthy, ~10% is a problem worth
  // stopping for. Shown as a colour rather than a verdict — the number is the
  // claim, the tint is only emphasis.
  const tone =
    share === null
      ? 'text-app-ink-muted'
      : share >= 10
        ? 'text-destructive-strong'
        : share >= 5
          ? 'text-warning-strong'
          : 'text-app-ink';

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-app-ink">الهدر وتكلفته</h2>
          <ExportMenu report="waste" window={period} />
        </div>
        <p className="mt-1 text-xs text-app-ink-muted">
          طعام أُتلف ولم يُبَع. وجبات الموظفين تُحتسب على حدة — لها تكلفة، لكنها ليست مشكلة
          تُعالَج.
        </p>
      </div>

      <div className="grid gap-px border-b border-app-border bg-app-bg-border sm:grid-cols-4">
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">الهدر</p>
          <p className="mt-1 font-numerals text-lg font-bold text-app-ink">
            {money(summary.waste_cost)}
            <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
          </p>
        </div>
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">نسبته من تكلفة الطعام</p>
          <p className={`mt-1 font-numerals text-lg font-bold ${tone}`}>
            {share === null ? '—' : `${share.toFixed(1)}%`}
          </p>
          {/* With no sales in the window the ratio is arithmetically 100% — all
              food cost was waste — which is true but reads as an alarm rather
              than as "there is nothing to compare against yet". Say which it is. */}
          {summary.cogs === 0 && summary.waste_cost > 0 && (
            <p className="mt-1 text-xs text-app-ink-muted">لا مبيعات في هذه المدة للمقارنة.</p>
          )}
        </div>
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">وجبات موظفين</p>
          <p className="mt-1 font-numerals text-lg font-bold text-app-ink-muted">
            {money(summary.staff_meal_cost)}
            <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
          </p>
        </div>
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">إجمالي ما أُخرج من المخزون</p>
          <p className="mt-1 font-numerals text-lg font-bold text-app-ink-muted">
            {money(summary.write_off_cost)}
            <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
          </p>
        </div>
      </div>

      {summary.exceeded_recorded_stock_count > 0 && (
        <p className="border-b border-app-border bg-warning-soft/30 px-6 py-3 text-xs text-app-ink">
          <span className="font-numerals font-bold">
            {summary.exceeded_recorded_stock_count}
          </span>{' '}
          عملية إتلاف تجاوزت الرصيد المسجّل — أي أن الدفاتر كانت ناقصة قبل الإتلاف. الفارق
          مُسجَّل كعجز يُسوّى في الجرد.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-app-border text-sm">
          <thead className="bg-app-surface-alt/60">
            <tr>
              <Th>السبب</Th>
              <Th>عدد المرات</Th>
              <Th>التكلفة</Th>
              <Th>يُحتسب هدرًا</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/70">
            {report.by_reason.map((r) => (
              <tr key={r.reason} className="transition-colors hover:bg-app-bg/60">
                <td className="px-6 py-3.5 font-semibold text-app-ink">
                  {writeOffReasonLabel(r.reason)}
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals text-app-ink-muted">{r.write_off_count}</span>
                </td>
                <td className="px-6 py-3.5">
                  <span
                    className={`font-numerals font-semibold ${
                      r.is_waste ? 'text-destructive-strong' : 'text-app-ink-muted'
                    }`}
                  >
                    {money(r.cost)}
                  </span>
                </td>
                <td className="px-6 py-3.5 text-xs text-app-ink-muted">
                  {r.is_waste ? 'نعم' : 'لا'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.by_item.length > 0 && (
        <div className="border-t border-app-border px-6 py-4">
          <p className="text-xs font-bold text-app-ink">أكثر المكوّنات هدرًا</p>
          <p className="mt-0.5 text-xs text-app-ink-muted">
            مرتّبة بالتكلفة، فالأعلى هو أول ما يستحق المعالجة.
          </p>
          <ul className="mt-2 space-y-1">
            {report.by_item.slice(0, 8).map((i) => (
              <li key={i.id} className="flex justify-between gap-4 text-xs text-app-ink-muted">
                <span>
                  {i.name}{' '}
                  <span className="text-app-ink-muted">
                    (<span className="font-numerals">{i.quantity}</span> {i.unit_of_measure})
                  </span>
                </span>
                <span className="font-numerals font-semibold text-app-ink">
                  {money(i.cost)} ج.م
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.by_supplier.length > 0 && (
        <div className="border-t border-app-border px-6 py-4">
          <p className="text-xs font-bold text-app-ink">حسب المورّد</p>
          {/* Only lots whose supplier was recorded can appear, so this is a
              lead to follow up, not a full accounting of the waste above. */}
          <p className="mt-0.5 text-xs text-app-ink-muted">
            الدفعات التي سُجِّل مورّدها فقط — مؤشّر للمتابعة، لا حصر كامل.
          </p>
          <ul className="mt-2 space-y-1">
            {report.by_supplier.map((sup) => (
              <li
                key={sup.id ?? 'none'}
                className="flex justify-between gap-4 text-xs text-app-ink-muted"
              >
                <span>{sup.name ?? '—'}</span>
                <span className="font-numerals font-semibold text-app-ink">
                  {money(sup.cost)} ج.م
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Inventory read as an asset: where the money is sitting and whether it moves.
 *
 * Stock is usually the largest number on a restaurant's balance sheet and the
 * easiest to stop noticing. A single total invites nodding at it; the share
 * column and the dead-stock flag are what turn it into a decision about a
 * particular ingredient.
 *
 * When nothing has been consumed in the window the panel says so plainly rather
 * than showing every item as dead with infinite cover. That state means "no
 * sales recorded yet", and dressing it up as an alarm would teach people to
 * ignore the alarm.
 */
function AssetsPanel({ report, period }: { report: InventoryAssetsReport; period: ReportWindow }) {
  const { summary } = report;
  const worst = report.by_item.find((i) => i.is_dead_stock);

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-app-ink">المخزون كأصل</h2>
          <ExportMenu report="inventory-assets" window={period} />
        </div>
        <p className="mt-1 text-xs text-app-ink-muted">
          أين يقف رأس المال، ومنذ متى، وهل يتحرّك.
        </p>
      </div>

      <div className="grid gap-px border-b border-app-border bg-app-bg-border sm:grid-cols-3">
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">رأس مال محتجز</p>
          <p className="mt-1 font-numerals text-lg font-bold text-app-ink">
            {money(summary.capital_tied_up)}
            <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
          </p>
        </div>
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">معدل الدوران</p>
          <p className="mt-1 font-numerals text-lg font-bold text-app-ink">
            {summary.turnover === null ? '—' : `${summary.turnover.toFixed(2)}x`}
          </p>
          {!summary.has_usage_data && (
            <p className="mt-1 text-xs text-app-ink-muted">لا يوجد استهلاك مسجّل في هذه المدة.</p>
          )}
        </div>
        <div className="bg-app-surface px-6 py-4">
          <p className="text-xs font-semibold text-app-ink-muted">مخزون راكد</p>
          <p
            className={`mt-1 font-numerals text-lg font-bold ${
              summary.dead_capital > 0 ? 'text-warning-strong' : 'text-app-ink-muted'
            }`}
          >
            {summary.has_usage_data ? money(summary.dead_capital) : '—'}
            {summary.has_usage_data && (
              <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
            )}
          </p>
          {summary.has_usage_data && summary.dead_capital_pct !== null && (
            <p className="mt-1 text-xs text-app-ink-muted">
              <span className="font-numerals">{summary.dead_capital_pct.toFixed(1)}%</span> من
              رأس المال
            </p>
          )}
        </div>
      </div>

      {worst && (
        <p className="border-b border-app-border bg-warning-soft/30 px-6 py-3 text-xs text-app-ink">
          <strong>{worst.name}</strong> لم يتحرّك إطلاقًا في هذه المدة ويحجز{' '}
          <span className="font-numerals font-bold">{money(worst.capital)}</span> ج.م.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-app-border text-sm">
          <thead className="bg-app-surface-alt/60">
            <tr>
              <Th>المكوّن</Th>
              <Th>المتوفر</Th>
              <Th>رأس المال</Th>
              <Th>الحصة</Th>
              <Th>أقدم دفعة</Th>
              <Th>يكفي لـ</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/70">
            {report.by_item.map((i) => (
              <tr key={i.id} className="transition-colors hover:bg-app-bg/60">
                <td className="px-6 py-3.5 font-semibold text-app-ink">
                  {i.name}
                  {i.is_dead_stock && (
                    <span className="ms-2 rounded-md bg-warning-soft px-1.5 py-0.5 text-xs font-bold text-warning-strong">
                      راكد
                    </span>
                  )}
                  {!i.is_active && (
                    <span className="ms-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-bold text-app-ink-muted">
                      مؤرشف
                    </span>
                  )}
                </td>
                <td className="px-6 py-3.5 text-app-ink-muted">
                  <span className="font-numerals">{i.on_hand}</span>{' '}
                  <span className="text-xs text-app-ink-muted">{i.unit_of_measure}</span>
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals font-semibold text-app-ink">
                    {money(i.capital)}
                  </span>
                </td>
                <td className="px-6 py-3.5 text-app-ink-muted">
                  <span className="font-numerals">
                    {i.capital_share_pct === null ? '—' : `${i.capital_share_pct.toFixed(1)}%`}
                  </span>
                </td>
                <td className="px-6 py-3.5 text-app-ink-muted">
                  {i.days_held === null ? (
                    '—'
                  ) : (
                    <>
                      <span className="font-numerals">{i.days_held}</span> يومًا
                    </>
                  )}
                </td>
                <td className="px-6 py-3.5 text-app-ink-muted">
                  {/* A gap, not an infinity: nothing moved, so there is no rate
                      to divide by and no honest answer to give. */}
                  {i.days_of_cover === null ? (
                    <span className="text-app-ink-muted">—</span>
                  ) : (
                    <>
                      <span className="font-numerals">{i.days_of_cover}</span> يومًا
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * How each person performed, from what the till recorded (0026).
 *
 * Every column is an observed fact — orders served, money taken, how often
 * their sales were voided. Nobody types an opinion here, so nothing can be
 * shaded by who gets on with whom. That is the strength and the limit: it
 * measures what a till can see, which is not the whole of anyone's job.
 *
 * Each figure is shown AGAINST THE TEAM AVERAGE, because "3 orders" means
 * nothing alone and "3 against an average of 2" is a judgement someone can act
 * on. The comparison is deliberately quiet — a number, not a verdict.
 */
function EmployeePanel({
  report,
  ratings,
  currentMonth,
  onRate,
  period,
}: {
  report: EmployeeReport;
  ratings: EmployeeRating[];
  currentMonth: string;
  onRate: (employeeId: string, score: number) => Promise<void>;
  period: ReportWindow;
}) {
  const { team } = report;
  // This month's rating for each person, if one exists yet.
  const ratingFor = (id: string) =>
    ratings.find((r) => r.employee_id === id && r.period_month.startsWith(currentMonth));

  /** Everything on record for one person, for the sparkline. */
  const ratingsFor = (id: string) => ratings.filter((r) => r.employee_id === id);

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-app-ink">أداء الموظفين</h2>
          <ExportMenu report="employees" window={period} />
        </div>
        <p className="mt-1 text-xs text-app-ink-muted">
          أرقام مسجّلة من نقطة البيع، وتقييم المدير بجانبها — لا يُدمجان في رقم واحد.
          نسبة الإلغاء تُحسب على مبيعات الموظف نفسه، لا على الإلغاءات التي اعتمدها.
        </p>
      </div>

      {/* Orders nobody can be credited with. Shown rather than dropped: without
          it the per-person totals silently fail to add up to the takings. */}
      {report.unattributed.present && report.unattributed.orders_served > 0 && (
        <p className="border-b border-app-border bg-app-surface-alt/60 px-6 py-3 text-xs text-app-ink-muted">
          <span className="font-numerals font-semibold">
            {report.unattributed.orders_served}
          </span>{' '}
          طلب بقيمة{' '}
          <span className="font-numerals font-semibold">
            {money(report.unattributed.revenue)}
          </span>{' '}
          ج.م بلا موظف مسجّل — طلبات سابقة لتفعيل التسجيل، وليست محسوبة على أحد.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-app-border text-sm">
          <thead className="bg-app-surface-alt/60">
            <tr>
              <Th>الموظف</Th>
              <Th>الطلبات</Th>
              <Th>الإيراد</Th>
              <Th>متوسط الطلب</Th>
              <Th>نسبة الإلغاء</Th>
              <Th>الحصة</Th>
              <Th>تقييم المدير</Th>
              <Th>آخر ١٢ شهرًا</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border/70">
            {report.employees.map((e) => (
              <tr key={e.user_id} className="transition-colors hover:bg-app-bg/60">
                <td className="px-6 py-3.5">
                  <span className="font-semibold text-app-ink">{e.email ?? '—'}</span>
                  {e.role && <span className="ms-2 text-xs text-app-ink-muted">{e.role}</span>}
                  {e.is_active === false && (
                    <span className="ms-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-bold text-app-ink-muted">
                      غير نشط
                    </span>
                  )}
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals text-app-ink">{e.orders_served}</span>
                  {team.average_orders_per_person !== null && (
                    <span className="ms-1 text-xs text-app-ink-muted">
                      (م {team.average_orders_per_person})
                    </span>
                  )}
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals font-semibold text-app-ink">
                    {money(e.revenue)}
                  </span>
                </td>
                <td className="px-6 py-3.5">
                  <span className="font-numerals text-app-ink-muted">
                    {e.average_order_value === null ? '—' : money(e.average_order_value)}
                  </span>
                  {team.average_order_value !== null && (
                    <span className="ms-1 text-xs text-app-ink-muted">
                      (م {money(team.average_order_value)})
                    </span>
                  )}
                </td>
                <td className="px-6 py-3.5">
                  <span
                    className={`font-numerals font-semibold ${
                      e.void_rate_pct !== null &&
                      team.void_rate_pct !== null &&
                      e.void_rate_pct > team.void_rate_pct * 2
                        ? 'text-warning-strong'
                        : 'text-app-ink-muted'
                    }`}
                  >
                    {e.void_rate_pct === null ? '—' : `${e.void_rate_pct.toFixed(1)}%`}
                  </span>
                  {team.void_rate_pct !== null && (
                    <span className="ms-1 text-xs text-app-ink-muted">
                      (م {team.void_rate_pct.toFixed(1)}%)
                    </span>
                  )}
                </td>
                <td className="px-6 py-3.5 text-app-ink-muted">
                  <span className="font-numerals">
                    {e.revenue_share_pct === null ? '—' : `${e.revenue_share_pct.toFixed(1)}%`}
                  </span>
                </td>
                {/* Deliberately the LAST column and visually separate: a
                    judgement sits beside the measurements, never averaged into
                    them. Combining a fact and an opinion into one score hides
                    which of the two produced it. */}
                <td className="border-s border-app-border px-6 py-3.5">
                  <StarRating
                    value={ratingFor(e.user_id)?.score ?? null}
                    onChange={
                      currentMonth ? (score) => void onRate(e.user_id, score) : undefined
                    }
                  />
                  {ratingFor(e.user_id)?.note && (
                    <span
                      title={ratingFor(e.user_id)!.note ?? undefined}
                      className="mt-0.5 block max-w-[12rem] truncate text-xs text-app-ink-muted"
                    >
                      {ratingFor(e.user_id)!.note}
                    </span>
                  )}
                </td>
                {/* The history the API was already returning and the table
                    used to discard. Without it a rating could be recorded
                    every month for a year and never once be looked at, which
                    is the only thing a rating is for. */}
                <td className="px-6 py-3.5">
                  <RatingSparkline ratings={ratingsFor(e.user_id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-app-border px-6 py-5">
        <h3 className="text-sm font-bold text-app-ink">متوسط تقييم الفريق شهريًا</h3>
        <p className="mb-3 mt-1 text-xs text-app-ink-muted">
          متوسط تقييمات الموظفين في كل شهر. الأشهر التي لم يُقيَّم فيها أحد تظهر كفجوة، لا
          كخط متصل — حتى لا يبدو الشهر المنسيّ وكأنه شهر مُقيَّم.
        </p>
        <TeamRatingTrend ratings={ratings} />
      </div>

      <p className="border-t border-app-border px-6 py-3 text-xs text-app-ink-muted">
        «م» = متوسط الفريق. الأرقام تقيس ما تراه نقطة البيع فقط؛ التقييم رأي المدير عن الشهر
        الحالي ولا يمكن تعديله بعد انتهائه.
      </p>
    </section>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-app-ink-muted"
    >
      {children}
    </th>
  );
}
