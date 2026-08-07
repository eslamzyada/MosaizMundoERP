import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ChartCard from '../components/charts/ChartCard';
import ExportMenu from '../components/ExportMenu';
import ServiceSummary from '../components/ServiceSummary';
import LineChart from '../components/charts/LineChart';
import BarChart from '../components/charts/BarChart';
import DonutChart from '../components/charts/DonutChart';
import type { Tone } from '../components/charts/ChartCard';
import { classifyLoadFailure } from '../lib/loadFailure';
import { HttpReportRepository } from '../api/HttpReportRepository';
import { writeOffReasonLabel } from '../lib/writeOffReasons';
import type {
  EmployeeReport,
  InventoryAssetsReport,
  PurchasingReport,
  ReportWindow,
  TrendBucket,
  TrendsReport,
  WasteReport,
} from '../types';

/**
 * The business, drawn.
 *
 * The reports page answers precise questions and answers them in tables; this
 * one answers the question nobody types, which is "how are we doing". Those
 * want opposite things from the same data — a table is exact and slow to read,
 * a chart is approximate and immediate — so this is a second page rather than a
 * tab on the first.
 *
 * EVERY CARD FAILS ON ITS OWN.
 *
 * Five reports are fetched, and a dashboard that blanks entirely because one of
 * them timed out is a dashboard that is down more often than the system is. So
 * each source keeps its own error, and a card that cannot draw says so while
 * the rest of the page carries on.
 */

const repository = new HttpReportRepository();

const RANGES = [
  { days: 7, label: '٧ أيام' },
  { days: 30, label: '٣٠ يومًا' },
  { days: 90, label: '٩٠ يومًا' },
];

const BUCKETS: { value: TrendBucket; label: string }[] = [
  { value: 'day', label: 'يومي' },
  { value: 'week', label: 'أسبوعي' },
  { value: 'month', label: 'شهري' },
];

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Axis labels, shortened.
 *
 * "12,450.00" repeated down a y-axis is four times wider than the plot it
 * labels. Thousands become k and millions M — the axis is for orientation, and
 * the exact figure is in the summary above it.
 */
const compact = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return n.toFixed(0);
};

const whole = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** A bucket start as a short axis label: "07-14" rather than "2026-07-14". */
const shortDay = (iso: string) => iso.slice(5);

const PO_STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  placed: 'مُرسَل',
  received: 'مُستلَم',
  cancelled: 'ملغى',
};

interface Slot<T> {
  data: T | null;
  error: string | null;
}

const empty = <T,>(): Slot<T> => ({ data: null, error: null });

export default function Insights() {
  const navigate = useNavigate();
  const [window, setWindow] = useState<ReportWindow>({ kind: 'rolling', days: 30 });

  // The same period the charts below use, expressed as real dates. The service
  // report takes from/to rather than a rolling day count, and deriving both
  // from one piece of state is what stops the summary and the charts drifting
  // into describing different weeks.
  const serviceTo = useMemo(() => new Date(), []);
  const serviceFrom = useMemo(
    () =>
      new Date(
        serviceTo.getTime() -
          (window.kind === 'rolling' ? window.days : 30) * 24 * 60 * 60 * 1000,
      ),
    [serviceTo, window],
  );
  const [bucket, setBucket] = useState<TrendBucket>('day');
  const [loading, setLoading] = useState(true);

  const [trends, setTrends] = useState<Slot<TrendsReport>>(empty);
  const [waste, setWaste] = useState<Slot<WasteReport>>(empty);
  const [purchasing, setPurchasing] = useState<Slot<PurchasingReport>>(empty);
  const [assets, setAssets] = useState<Slot<InventoryAssetsReport>>(empty);
  const [team, setTeam] = useState<Slot<EmployeeReport>>(empty);

  const load = useCallback(async (w: ReportWindow, b: TrendBucket) => {
    setLoading(true);
    const settle = <T,>(
      result: PromiseSettledResult<T>,
      set: (slot: Slot<T>) => void,
    ) => {
      if (result.status === 'fulfilled') set({ data: result.value, error: null });
      else set({ data: null, error: classifyLoadFailure(result.reason).message });
    };

    // allSettled, not all: one slow report must not take the other four with it.
    const [t, ws, p, a, e] = await Promise.allSettled([
      repository.getTrends(w, b),
      repository.getWaste(w),
      repository.getPurchasing(w),
      repository.getInventoryAssets(w),
      repository.getEmployees(w),
    ]);

    settle(t, setTrends);
    settle(ws, setWaste);
    settle(p, setPurchasing);
    settle(a, setAssets);
    settle(e, setTeam);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(window, bucket);
  }, [load, window, bucket]);

  const points = trends.data?.points ?? [];
  const linePoints = useMemo(
    () =>
      points.map((p) => ({
        label: shortDay(p.bucket_start),
        values: {
          revenue: p.revenue,
          gross_profit: p.gross_profit,
          orders: p.order_count,
          waste: p.waste_cost,
          write_offs: p.write_off_cost,
          purchasing: p.purchasing_cost,
        },
      })),
    [points],
  );

  /** True when the window produced buckets but nothing at all happened in them. */
  const noMovement = points.length > 0 && points.every((p) => p.revenue === 0 && p.order_count === 0);

  const summary = trends.data?.summary;

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">المؤشرات</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            المبيعات والهدر والمشتريات على خط زمني واحد.
            {trends.data && (
              <>
                {' '}
                <span className="font-numerals">{trends.data.from}</span> —{' '}
                <span className="font-numerals">{trends.data.to}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Segmented
            options={RANGES.map((r) => ({ value: String(r.days), label: r.label }))}
            value={window.kind === 'rolling' ? String(window.days) : ''}
            onChange={(v) => setWindow({ kind: 'rolling', days: Number(v) })}
            ariaLabel="الفترة"
          />
          <Segmented
            options={BUCKETS.map((b) => ({ value: b.value, label: b.label }))}
            value={bucket}
            onChange={(v) => setBucket(v as TrendBucket)}
            ariaLabel="تجميع"
          />
          <ExportMenu report="trends" window={window} />
          <button
            type="button"
            onClick={() => globalThis.print()}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm font-semibold text-app-ink transition-colors hover:bg-app-surface-alt"
          >
            طباعة
          </button>
        </div>
      </header>

      <div aria-live="polite" className="sr-only">
        {loading ? 'جارٍ تحميل المؤشرات' : 'اكتملت المؤشرات'}
      </div>

      {loading && !trends.data ? (
        <p className="py-16 text-center text-sm text-app-ink-muted">جارٍ التحميل…</p>
      ) : (
        <div className="space-y-6">
          {/* What the service cost and what it earned (0038–0043, read at
              last). Above the KPI row because the labour share is the number
              an owner opens this page for; everything below is detail. */}
          <ServiceSummary from={serviceFrom} to={serviceTo} />

          {/* ---- the headline figures -------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="الإيراد" value={summary ? money(summary.revenue) : '—'} unit="ج.م" />
            <Kpi
              label="مجمل الربح"
              value={summary ? money(summary.gross_profit) : '—'}
              unit="ج.م"
              hint={
                summary?.margin_pct !== null && summary !== undefined
                  ? `هامش ${summary.margin_pct}%`
                  : 'لا يوجد بيع مُكلَّف بعد'
              }
              // A loss is not a smaller profit. It gets its own colour or it
              // reads as an ordinary figure that happens to have a dash.
              tone={summary && summary.gross_profit < 0 ? 'bad' : 'good'}
            />
            <Kpi
              label="الهدر"
              value={summary ? money(summary.waste_cost) : '—'}
              unit="ج.م"
              hint={
                summary?.waste_share_pct !== null && summary !== undefined
                  ? `${summary.waste_share_pct}% من تكلفة الطعام`
                  : undefined
              }
              tone="bad"
            />
            <Kpi
              label="المشتريات"
              value={summary ? money(summary.purchasing_cost) : '—'}
              unit="ج.م"
              hint={
                purchasing.data
                  ? `${whole(purchasing.data.summary.order_count)} أمر شراء`
                  : undefined
              }
            />
          </div>

          {/* ---- sales ------------------------------------------------------ */}
          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="الإيراد ومجمل الربح"
              subtitle="الربح محسوب على المبيعات المُكلَّفة فقط."
              isEmpty={trends.error !== null || points.length === 0 || noMovement}
              emptyMessage={trends.error ?? 'لا توجد مبيعات في هذه الفترة.'}
            >
              <LineChart
                points={linePoints}
                series={[
                  { key: 'revenue', name: 'الإيراد', tone: 1, fill: true },
                  { key: 'gross_profit', name: 'مجمل الربح', tone: 3 },
                ]}
                formatValue={compact}
                ariaLabel="الإيراد ومجمل الربح عبر الفترة"
              />
            </ChartCard>

            <ChartCard
              title="عدد الطلبات"
              subtitle={
                summary?.average_ticket !== null && summary !== undefined
                  ? `متوسط الفاتورة ${money(summary.average_ticket)} ج.م`
                  : 'لم تُسجَّل طلبات في هذه الفترة.'
              }
              isEmpty={trends.error !== null || points.length === 0}
              emptyMessage={trends.error ?? 'لا توجد طلبات.'}
            >
              <LineChart
                points={linePoints}
                series={[{ key: 'orders', name: 'الطلبات', tone: 2, fill: true }]}
                formatValue={whole}
                ariaLabel="عدد الطلبات عبر الفترة"
              />
            </ChartCard>
          </div>

          {/* ---- waste ------------------------------------------------------ */}
          <div className="grid gap-6 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <ChartCard
                title="الهدر عبر الفترة"
                subtitle="الخط الفاتح يشمل وجبات الموظفين — تكلفة حقيقية، لكنها ليست هدرًا."
                isEmpty={trends.error !== null || points.length === 0}
                emptyMessage={trends.error ?? 'لا توجد بيانات.'}
              >
                <LineChart
                  points={linePoints}
                  series={[
                    { key: 'waste', name: 'هدر', tone: 4, fill: true },
                    { key: 'write_offs', name: 'كل الإهلاكات', tone: 5 },
                  ]}
                  formatValue={compact}
                  ariaLabel="تكلفة الهدر عبر الفترة"
                />
              </ChartCard>
            </div>

            <ChartCard
              title="أسباب الهدر"
              isEmpty={waste.error !== null || (waste.data?.by_reason.length ?? 0) === 0}
              emptyMessage={waste.error ?? 'لم يُسجَّل أي إهلاك.'}
            >
              <DonutChart
                slices={(waste.data?.by_reason ?? []).map((r, i) => ({
                  id: r.reason,
                  label: writeOffReasonLabel(r.reason),
                  value: r.cost,
                  display: money(r.cost),
                  tone: ((i % 5) + 1) as Tone,
                }))}
                centerLabel="إجمالي الإهلاك"
                centerValue={compact(waste.data?.summary.write_off_cost ?? 0)}
                ariaLabel="الإهلاك حسب السبب"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="أكثر المكوّنات هدرًا"
            subtitle="اضغط على أي مكوّن للانتقال إليه في المخزون."
            isEmpty={waste.error !== null || (waste.data?.by_item.length ?? 0) === 0}
            emptyMessage={waste.error ?? 'لم يُهدر أي مكوّن في هذه الفترة.'}
          >
            <BarChart
              tone={4}
              ariaLabel="المكوّنات حسب تكلفة الهدر"
              onSelect={(bar) => navigate(`/inventory?focus=${bar.id}`)}
              bars={(waste.data?.by_item ?? []).slice(0, 8).map((i) => ({
                id: i.id,
                label: i.name,
                value: i.cost,
                display: money(i.cost),
                hint: `${whole(i.quantity)} ${i.unit_of_measure} · ${i.write_off_count} مرة`,
              }))}
            />
          </ChartCard>

          {/* ---- buying ----------------------------------------------------- */}
          <div className="grid gap-6 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <ChartCard
                title="المشتريات عبر الفترة"
                subtitle="بتاريخ إرسال أمر الشراء — المسودّات والأوامر الملغاة غير محسوبة."
                isEmpty={trends.error !== null || points.length === 0}
                emptyMessage={trends.error ?? 'لا توجد بيانات.'}
              >
                <LineChart
                  points={linePoints}
                  series={[{ key: 'purchasing', name: 'مشتريات', tone: 2, fill: true }]}
                  formatValue={compact}
                  ariaLabel="قيمة المشتريات عبر الفترة"
                />
              </ChartCard>
            </div>

            <ChartCard
              title="حالة أوامر الشراء"
              isEmpty={purchasing.error !== null || (purchasing.data?.by_status.length ?? 0) === 0}
              emptyMessage={purchasing.error ?? 'لا توجد أوامر شراء.'}
            >
              <DonutChart
                slices={(purchasing.data?.by_status ?? []).map((s, i) => ({
                  id: s.status,
                  label: PO_STATUS_LABELS[s.status] ?? s.status,
                  value: s.order_count,
                  display: whole(s.order_count),
                  tone: ((i % 5) + 1) as Tone,
                }))}
                centerLabel="أمر شراء"
                centerValue={whole(
                  (purchasing.data?.by_status ?? []).reduce((s, r) => s + r.order_count, 0),
                )}
                ariaLabel="أوامر الشراء حسب الحالة"
              />
            </ChartCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="أكبر المورّدين"
              subtitle="بقيمة ما طُلب منهم. اضغط للانتقال إلى المورّد."
              isEmpty={purchasing.error !== null || (purchasing.data?.by_supplier.length ?? 0) === 0}
              emptyMessage={purchasing.error ?? 'لم يُطلب من أي مورّد في هذه الفترة.'}
            >
              <BarChart
                tone={2}
                ariaLabel="المورّدون حسب قيمة الطلبات"
                onSelect={(bar) => navigate(`/suppliers?focus=${bar.id}`)}
                bars={(purchasing.data?.by_supplier ?? []).slice(0, 8).map((s) => ({
                  id: s.id,
                  label: s.name,
                  value: s.committed,
                  display: money(s.committed),
                  hint:
                    s.outstanding > 0
                      ? `لم يصل بعد: ${money(s.outstanding)} ج.م`
                      : 'وصل بالكامل',
                }))}
              />
            </ChartCard>

            <ChartCard
              title="طلبات لم تصل بعد"
              subtitle="كل أمر شراء مُرسَل ولم يُستلَم — مهما كان تاريخه."
              isEmpty={purchasing.error !== null}
              emptyMessage={purchasing.error ?? ''}
            >
              {purchasing.data && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-6">
                    <Figure
                      label="القيمة المعلَّقة"
                      value={money(purchasing.data.summary.open_orders.outstanding)}
                      unit="ج.م"
                    />
                    <Figure
                      label="عدد الأوامر"
                      value={whole(purchasing.data.summary.open_orders.order_count)}
                    />
                    <Figure
                      label="نسبة التوريد في الفترة"
                      value={
                        purchasing.data.summary.fulfilment_pct === null
                          ? '—'
                          : `${purchasing.data.summary.fulfilment_pct}%`
                      }
                    />
                  </div>
                  {purchasing.data.summary.open_orders.oldest_placed_at && (
                    <p className="text-xs text-app-ink-muted">
                      أقدم أمر معلَّق مُرسَل منذ{' '}
                      <span className="font-numerals">
                        {purchasing.data.summary.open_orders.oldest_placed_at.slice(0, 10)}
                      </span>
                      .
                    </p>
                  )}
                </div>
              )}
            </ChartCard>
          </div>

          {/* ---- stock and people ------------------------------------------- */}
          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="رأس المال في المخزون"
              subtitle={
                assets.data
                  ? `${money(assets.data.summary.capital_tied_up)} ج.م إجمالًا · راكد ${money(
                      assets.data.summary.dead_capital,
                    )} ج.م`
                  : undefined
              }
              isEmpty={assets.error !== null || (assets.data?.by_item.length ?? 0) === 0}
              emptyMessage={assets.error ?? 'لا يوجد مخزون مُقيَّم.'}
            >
              <BarChart
                tone={3}
                ariaLabel="المكوّنات حسب قيمة المخزون"
                onSelect={(bar) => navigate(`/inventory?focus=${bar.id}`)}
                bars={[...(assets.data?.by_item ?? [])]
                  .sort((a, b) => b.capital - a.capital)
                  .slice(0, 8)
                  .map((i) => ({
                    id: i.id,
                    label: i.name,
                    value: i.capital,
                    display: money(i.capital),
                    hint: `${whole(i.on_hand)} ${i.unit_of_measure}`,
                  }))}
              />
            </ChartCard>

            <ChartCard
              title="الإيراد حسب الموظف"
              subtitle="من ما سجّلته نقطة البيع."
              isEmpty={team.error !== null || (team.data?.employees.length ?? 0) === 0}
              emptyMessage={team.error ?? 'لا توجد مبيعات منسوبة لموظف.'}
            >
              <BarChart
                tone={1}
                ariaLabel="الموظفون حسب الإيراد"
                onSelect={(bar) => navigate(`/members?focus=${bar.id}`)}
                bars={(team.data?.employees ?? []).slice(0, 8).map((e) => ({
                  id: e.user_id,
                  label: e.email ?? e.user_id.slice(0, 8),
                  value: e.revenue,
                  display: money(e.revenue),
                  hint: `${whole(e.orders_served)} طلب${
                    e.void_rate_pct !== null ? ` · إلغاء ${e.void_rate_pct}%` : ''
                  }`,
                }))}
              />
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}

/** A headline number. Losses are coloured, because a minus sign is easy to miss. */
function Kpi({
  label,
  value,
  unit,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
}) {
  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
      <p className="text-xs font-medium text-app-ink-muted">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-1">
        <span
          className={`font-numerals text-2xl font-bold ${
            tone === 'bad'
              ? 'text-rose-600 dark:text-rose-400'
              : tone === 'good'
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-app-ink'
          }`}
        >
          {value}
        </span>
        {unit && <span className="text-xs font-medium text-app-ink-muted">{unit}</span>}
      </p>
      {hint && <p className="mt-1 text-xs text-app-ink-muted">{hint}</p>}
    </div>
  );
}

function Figure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div>
      <p className="text-xs text-app-ink-muted">{label}</p>
      <p className="mt-0.5">
        <span className="font-numerals text-xl font-bold text-app-ink">{value}</span>
        {unit && <span className="ms-1 text-xs text-app-ink-muted">{unit}</span>}
      </p>
    </div>
  );
}

/** A small group of mutually exclusive choices, as buttons rather than a select:
 *  three options are faster to hit than a dropdown is to open. */
function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-lg border border-app-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 text-sm font-semibold transition-colors ${
            value === option.value
              ? 'bg-twilight-600 text-white'
              : 'text-app-ink hover:bg-app-surface-alt'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
