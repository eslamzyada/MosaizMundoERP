import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import Button from '../components/Button';
import Badge from '../components/ui/Badge';
import { HttpStocktakeRepository } from '../api/HttpStocktakeRepository';
import type { StocktakeRepository } from '../api/StocktakeRepository';
import { useSession } from '../session/SessionProvider';
import type { Stocktake, StocktakeStatus, StocktakeSummary } from '../types';

const repository: StocktakeRepository = new HttpStocktakeRepository();

const STATUS_META: Record<StocktakeStatus, { label: string; variant: 'success' | 'twilight' | 'neutral' }> = {
  draft: { label: 'جارٍ الجرد', variant: 'twilight' },
  posted: { label: 'مُرحَّل', variant: 'success' },
  cancelled: { label: 'ملغى', variant: 'neutral' },
};

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

function errorMessage(err: unknown, fallback: string): string {
  const msg = axios.isAxiosError(err)
    ? (err.response?.data as { error?: string } | undefined)?.error
    : undefined;
  return msg ?? fallback;
}

export default function StocktakePage() {
  const { can } = useSession();
  const mayCount = can('administer');

  const [history, setHistory] = useState<StocktakeSummary[]>([]);
  const [sheet, setSheet] = useState<Stocktake | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);

  const openSheet = useCallback(async (id: string) => {
    const data = await repository.get(id);
    setSheet(data);
    // Seed the inputs from the stored counts so an interrupted count resumes
    // exactly where it was left.
    setDrafts(Object.fromEntries(data.items.map((i) => [i.raw_item_id, String(i.counted_quantity)])));
    setConfirmPost(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const list = await repository.list();
      setHistory(list);
      const draft = list.find((s) => s.status === 'draft');
      if (draft) {
        await openSheet(draft.id);
      } else {
        setSheet(null);
        setDrafts({});
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [openSheet]);

  useEffect(() => {
    load();
  }, [load]);

  // Variance is recomputed from what is typed, not from the server's stored
  // value, so the manager sees the consequence of a number before saving it.
  const rows = useMemo(() => {
    if (!sheet) return [];
    return sheet.items.map((item) => {
      const raw = drafts[item.raw_item_id];
      const parsed = Number(raw);
      const valid = raw !== undefined && raw.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;
      return { item, raw: raw ?? '', valid, counted: valid ? parsed : item.counted_quantity,
               variance: (valid ? parsed : item.counted_quantity) - item.expected_quantity };
    });
  }, [sheet, drafts]);

  const invalidCount = rows.filter((r) => !r.valid).length;
  const varianceRows = rows.filter((r) => Math.abs(r.variance) > 1e-9);
  const isDraft = sheet?.status === 'draft';

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await load();
    } catch (err) {
      setNotice(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const saveCounts = () =>
    run(async () => {
      if (!sheet) return;
      await repository.saveCounts(
        sheet.id,
        rows.filter((r) => r.valid).map((r) => ({
          raw_item_id: r.item.raw_item_id,
          counted_quantity: r.counted,
        })),
      );
    }, 'تعذّر حفظ الجرد.');

  if (!mayCount && !loading) {
    // Reading a past count is open to everyone; running one is not.
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold tracking-tight text-surface-dark">جرد المخزون</h1>
        <p className="mt-4 rounded-xl border border-surface-sand-border bg-surface-sand-alt/60 px-4 py-3 text-sm text-slate-500">
          عرض فقط — إجراء الجرد متاح للمالك والمديرين.
        </p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">جرد المخزون</h1>
          <p className="mt-1 text-sm text-slate-500">
            عُدّ ما على الرفّ فعلًا، ثم رحّل الجرد ليتطابق المخزون المسجّل مع الواقع.
          </p>
        </div>
        {!sheet && !loading && !error && (
          <Button variant="primary" disabled={busy} onClick={() => run(() => repository.start().then(() => undefined), 'تعذّر بدء الجرد.')}>
            بدء جرد جديد
          </Button>
        )}
      </header>

      {notice && (
        <p role="alert" className="mb-4 rounded-xl border border-destructive-soft bg-destructive-soft/40 px-4 py-3 text-xs font-semibold text-destructive-strong">
          {notice}
        </p>
      )}

      {error ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center">
          <p className="mb-3 text-sm text-destructive-strong">تعذّر تحميل البيانات.</p>
          <Button variant="secondary" onClick={load}>إعادة المحاولة</Button>
        </div>
      ) : loading ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-slate-400">
          جارٍ التحميل…
        </div>
      ) : (
        <>
          {sheet ? (
            <section className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-sand-border px-6 py-4">
                <div>
                  <h2 className="text-sm font-bold text-surface-dark">
                    ورقة الجرد <Badge variant={STATUS_META[sheet.status].variant}>{STATUS_META[sheet.status].label}</Badge>
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {isDraft
                      ? 'أدخل الكمية الموجودة فعلًا لكل مكوّن. الفرق يُحتسب مقابل رصيد النظام وقت بدء الجرد.'
                      : 'جرد مكتمل — للعرض فقط.'}
                  </p>
                </div>
                {isDraft && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={busy} onClick={saveCounts}>
                      حفظ الجرد
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => run(() => repository.cancel(sheet.id), 'تعذّر إلغاء الجرد.')}
                    >
                      إلغاء الجرد
                    </Button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-surface-sand-border text-sm">
                  <caption className="sr-only">ورقة جرد المخزون</caption>
                  <thead className="bg-surface-sand-alt/60">
                    <tr>
                      <Th>المكوّن</Th>
                      <Th>رصيد النظام</Th>
                      <Th>الموجود فعلًا</Th>
                      <Th>الفرق</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-sand-border/70">
                    {rows.map(({ item, raw, valid, variance }) => (
                      <tr key={item.id} className="transition-colors hover:bg-surface-sand/60">
                        <td className="px-6 py-3 font-semibold text-surface-dark">
                          {item.name}
                          <span className="ms-2 text-xs font-normal text-slate-400">
                            {item.unit_of_measure}
                          </span>
                        </td>
                        <td className="px-6 py-3 font-numerals text-slate-500">
                          {qty(item.expected_quantity)}
                        </td>
                        <td className="px-6 py-3">
                          {isDraft ? (
                            <input
                              type="number"
                              min="0"
                              step="any"
                              inputMode="decimal"
                              dir="ltr"
                              aria-label={`الكمية الموجودة من ${item.name}`}
                              value={raw}
                              disabled={busy}
                              onChange={(e) =>
                                setDrafts((d) => ({ ...d, [item.raw_item_id]: e.target.value }))
                              }
                              className={[
                                'w-28 rounded-lg border bg-white px-2 py-1 font-numerals text-start text-sm font-semibold',
                                'text-surface-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30',
                                'disabled:opacity-50',
                                valid ? 'border-surface-sand-border focus:border-twilight-500' : 'border-destructive-strong',
                              ].join(' ')}
                            />
                          ) : (
                            <span className="font-numerals font-semibold text-surface-dark">
                              {qty(item.counted_quantity)}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3">
                          <VarianceCell variance={isDraft ? variance : item.variance} valid={valid} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {isDraft && (
                <div className="border-t border-surface-sand-border px-6 py-4">
                  <PostPanel
                    invalidCount={invalidCount}
                    varianceCount={varianceRows.length}
                    confirming={confirmPost}
                    busy={busy}
                    onAskConfirm={() => setConfirmPost(true)}
                    onCancelConfirm={() => setConfirmPost(false)}
                    onPost={() =>
                      run(async () => {
                        // Save first: posting applies what is STORED, and an
                        // unsaved number on screen would be silently ignored.
                        await repository.saveCounts(
                          sheet.id,
                          rows.filter((r) => r.valid).map((r) => ({
                            raw_item_id: r.item.raw_item_id,
                            counted_quantity: r.counted,
                          })),
                        );
                        await repository.post(sheet.id);
                      }, 'تعذّر ترحيل الجرد.')
                    }
                  />
                </div>
              )}
            </section>
          ) : (
            <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-slate-400">
              لا يوجد جرد مفتوح. ابدأ جردًا جديدًا لعدّ المخزون.
            </div>
          )}

          <HistoryTable history={history} onOpen={openSheet} />
        </>
      )}
    </div>
  );
}

/**
 * Posting moves real stock, so it asks first — and says exactly how many lines
 * will change, because "post" on a sheet where nothing differs is a no-op and
 * on a sheet with 40 variances is a significant correction.
 */
function PostPanel({
  invalidCount,
  varianceCount,
  confirming,
  busy,
  onAskConfirm,
  onCancelConfirm,
  onPost,
}: {
  invalidCount: number;
  varianceCount: number;
  confirming: boolean;
  busy: boolean;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  onPost: () => void;
}) {
  if (invalidCount > 0) {
    return (
      <p className="text-xs font-semibold text-destructive-strong">
        {invalidCount} سطر بكمية غير صالحة — أدخل رقمًا صفرًا أو أكثر قبل الترحيل.
      </p>
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {varianceCount === 0
            ? 'لا توجد فروق — الترحيل سيؤكّد أن الأرصدة مطابقة.'
            : `${varianceCount} مكوّن يختلف عن رصيد النظام. الترحيل سيعدّل المخزون ليطابق العدّ.`}
        </p>
        <Button variant="primary" disabled={busy} onClick={onAskConfirm}>
          ترحيل الجرد
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs font-semibold text-warning-strong">
        سيتم تعديل المخزون ليطابق العدّ، وتسوية أي نواقص مسجّلة للمكوّنات المعدودة. لا يمكن التراجع.
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancelConfirm}>
          تراجع
        </Button>
        <Button variant="primary" disabled={busy} onClick={onPost}>
          {busy ? 'جارٍ الترحيل…' : 'تأكيد الترحيل'}
        </Button>
      </div>
    </div>
  );
}

function VarianceCell({ variance, valid }: { variance: number; valid: boolean }) {
  if (!valid) return <span className="text-xs text-destructive-strong">—</span>;
  if (Math.abs(variance) < 1e-9) {
    return <span className="text-xs text-slate-400">مطابق</span>;
  }
  const short = variance < 0;
  return (
    <span
      className={[
        'font-numerals text-sm font-bold',
        short ? 'text-destructive-strong' : 'text-success-strong',
      ].join(' ')}
      title={short ? 'الموجود أقل من رصيد النظام' : 'الموجود أكثر من رصيد النظام'}
    >
      {short ? '−' : '+'}
      {qty(Math.abs(variance))}
    </span>
  );
}

function HistoryTable({
  history,
  onOpen,
}: {
  history: StocktakeSummary[];
  onOpen: (id: string) => void;
}) {
  const past = history.filter((s) => s.status !== 'draft');
  if (past.length === 0) return null;

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="border-b border-surface-sand-border px-6 py-4">
        <h2 className="text-sm font-bold text-surface-dark">عمليات الجرد السابقة</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-sand-border text-sm">
          <caption className="sr-only">سجل عمليات الجرد</caption>
          <thead className="bg-surface-sand-alt/60">
            <tr>
              <Th>التاريخ</Th>
              <Th>المكوّنات</Th>
              <Th>الفروق</Th>
              <Th>الحالة</Th>
              <Th><span className="sr-only">عرض</span></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-sand-border/70">
            {past.map((s) => (
              <tr key={s.id} className="transition-colors hover:bg-surface-sand/60">
                <td className="px-6 py-3 font-numerals text-slate-600">
                  {new Date(s.created_at).toLocaleDateString('en-GB', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                </td>
                <td className="px-6 py-3 font-numerals text-slate-500">{s.item_count}</td>
                <td className="px-6 py-3 font-numerals text-slate-500">{s.variance_count}</td>
                <td className="px-6 py-3">
                  <Badge variant={STATUS_META[s.status].variant}>{STATUS_META[s.status].label}</Badge>
                </td>
                <td className="px-6 py-3 text-end">
                  <button
                    type="button"
                    onClick={() => onOpen(s.id)}
                    className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100"
                  >
                    عرض
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
