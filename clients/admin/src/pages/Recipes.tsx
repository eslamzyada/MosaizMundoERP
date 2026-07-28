import { useEffect, useMemo, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import type { ReactNode } from 'react';
import axios from 'axios';
import Button from '../components/Button';
import Badge from '../components/ui/Badge';
import AddIngredientModal from '../components/AddIngredientModal';
import { HttpRecipeRepository } from '../api/HttpRecipeRepository';
import type { RecipeRepository } from '../api/RecipeRepository';
import { useSession } from '../session/SessionProvider';
import type { IngredientCategory, RawInventoryItem, Recipe, RecipeLine } from '../types';

const repository: RecipeRepository = new HttpRecipeRepository();

export default function Recipes() {
  const { can } = useSession();
  const mayEdit = can('administer');
  // The API strips costs for anyone outside FINANCE_ROLES, so those fields
  // arrive undefined. Mirroring the check here keeps the layout honest rather
  // than rendering "0.00" where the server sent nothing.
  const maySeeCost = can('view_finance');

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ingredients, setIngredients] = useState<RawInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // Removal is two-step rather than a browser confirm(): the row itself asks.
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([repository.getRecipes(), repository.getIngredients()])
      .then(([recipeData, ingredientData]) => {
        if (!active) return;
        setRecipes(recipeData);
        setIngredients(ingredientData);
        setSelectedId(recipeData[0]?.sellable_item.id ?? null);
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(classifyLoadFailure(e));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selected = useMemo(
    () => recipes.find((r) => r.sellable_item.id === selectedId) ?? null,
    [recipes, selectedId],
  );

  // Every edit persists immediately and is followed by a re-fetch, so the table
  // shows the committed, RLS-scoped state rather than an optimistic guess.
  async function reload() {
    setRecipes(await repository.getRecipes());
  }

  async function handleAddLine(payload: { raw_item_id: string; quantity_required: number }) {
    if (!selectedId) return;
    setLineError(null);
    try {
      await repository.addIngredient(selectedId, payload);
      await reload();
    } catch (err) {
      setLineError(errorMessage(err, 'تعذّرت إضافة المكوّن.'));
    }
  }

  async function handleQuantityCommit(lineId: string, quantity: number) {
    setLineError(null);
    setBusyLineId(lineId);
    try {
      await repository.updateLine(lineId, quantity);
    } catch (err) {
      setLineError(errorMessage(err, 'تعذّر حفظ الكمية.'));
    } finally {
      // Reload either way: on success to confirm, on failure to snap the cell
      // back to the stored quantity instead of leaving a value that never saved.
      await reload();
      setBusyLineId(null);
    }
  }

  async function handleRemoveLine(lineId: string) {
    setLineError(null);
    setBusyLineId(lineId);
    try {
      await repository.removeLine(lineId);
      setPendingRemoveId(null);
      await reload();
    } catch (err) {
      setLineError(errorMessage(err, 'تعذّر حذف المكوّن.'));
    } finally {
      setBusyLineId(null);
    }
  }

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-surface-dark">الوصفات</h1>
        <p className="mt-1 text-sm text-slate-500">
          قائمة الأصناف ومكوّناتها الخام — اختر صنفًا لعرض وصفته.
        </p>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Master: menu (sellable items) */}
        <aside className="w-full flex-shrink-0 lg:w-72">
          <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
            <div className="border-b border-surface-sand-border px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500">
              القائمة
            </div>
            {error ? (
              <div className="px-4 py-6">
                <LoadError failure={error} />
              </div>
            ) : loading ? (
              <div className="px-4 py-10 text-center text-sm text-slate-400">جارٍ التحميل…</div>
            ) : (
              <ul className="p-2">
                {recipes.map((r) => {
                  const isActive = r.sellable_item.id === selectedId;
                  return (
                    <li key={r.sellable_item.id}>
                      <button
                        onClick={() => setSelectedId(r.sellable_item.id)}
                        className={[
                          'flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-start text-sm transition-colors',
                          isActive
                            ? 'bg-twilight-600 text-white'
                            : 'text-surface-dark hover:bg-surface-sand-alt',
                        ].join(' ')}
                      >
                        <span className="font-semibold">{r.sellable_item.name}</span>
                        <span
                          className={[
                            'font-numerals text-xs',
                            isActive ? 'text-twilight-100' : 'text-slate-400',
                          ].join(' ')}
                        >
                          {r.recipe_lines.length}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Detail: the selected recipe's Bill of Materials */}
        <section className="min-w-0 flex-1">
          {error ? (
            <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-destructive-strong">
              <LoadError failure={error} />
            </div>
          ) : loading || !selected ? (
            <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-slate-400">
              {loading ? 'جارٍ تحميل الوصفة…' : 'اختر صنفًا من القائمة.'}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-surface-sand-border px-6 py-4">
                <div>
                  <h2 className="text-lg font-bold text-surface-dark">
                    {selected.sellable_item.name}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    رمز الصنف:{' '}
                    <span className="font-numerals">{selected.sellable_item.sku ?? '—'}</span>
                  </p>
                </div>
                {maySeeCost && (
                <div className="text-start">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {selected.uncosted_line_count > 0 ? 'تكلفة جزئية' : 'تكلفة المكوّنات'}
                  </div>
                  <div className="font-numerals text-xl font-bold text-twilight-700">
                    {money(selected.total_cost)}
                    <span className="ms-1 font-sans text-sm font-medium text-slate-500">ج.م</span>
                  </div>
                  {/* An incomplete cost is worse than no cost: it looks like a
                      finished number and would underprice the dish. Say so. */}
                  {selected.uncosted_line_count > 0 ? (
                    <p className="mt-1 max-w-[16rem] text-[11px] font-semibold text-warning-strong">
                      {selected.uncosted_line_count} مكوّن بلا رصيد في المخزون، فلا يمكن تسعيره —
                      التكلفة الحقيقية أعلى.
                    </p>
                  ) : selected.price > 0 ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      <span className="font-numerals font-semibold text-surface-dark">
                        {((selected.total_cost / selected.price) * 100).toFixed(1)}%
                      </span>{' '}
                      من سعر البيع ({money(selected.price)} ج.م)
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-500">لم يُحدَّد سعر بيع لهذا الصنف.</p>
                  )}
                </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-surface-sand-border text-sm">
                  <thead className="bg-surface-sand-alt/60">
                    <tr>
                      <Th>المكوّن</Th>
                      <Th>الكمية</Th>
                      <Th>وحدة القياس</Th>
                      {maySeeCost && <Th>التكلفة</Th>}
                      <Th>النوع</Th>
                      {mayEdit && <Th>إجراءات</Th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-sand-border/70">
                    {selected.recipe_lines.length === 0 && (
                      <tr>
                        <td
                          colSpan={(mayEdit ? 5 : 4) + (maySeeCost ? 1 : 0)}
                          className="px-6 py-10 text-center text-sm text-slate-400"
                        >
                          لا توجد مكوّنات في هذه الوصفة بعد.
                          {mayEdit && ' أضف مكوّنًا لتبدأ في خصم المخزون عند البيع.'}
                        </td>
                      </tr>
                    )}
                    {selected.recipe_lines.map((line) => (
                      <tr key={line.id} className="transition-colors hover:bg-surface-sand/60">
                        <td className="px-6 py-4 font-semibold text-surface-dark">
                          {line.raw_item.name}
                        </td>
                        <td className="px-6 py-4">
                          <QuantityCell
                            line={line}
                            editable={mayEdit}
                            busy={busyLineId === line.id}
                            onCommit={(qty) => handleQuantityCommit(line.id, qty)}
                          />
                        </td>
                        <td className="px-6 py-4 text-slate-500">{line.raw_item.unit_of_measure}</td>
                        {maySeeCost && (
                        <td className="px-6 py-4">
                          {line.line_cost === null ? (
                            <Badge variant="warning">بلا رصيد</Badge>
                          ) : (
                            <span
                              className="font-numerals text-surface-dark"
                              title={`${money(line.unit_cost ?? 0)} ج.م لكل ${line.raw_item.unit_of_measure}`}
                            >
                              {money(line.line_cost)}
                              <span className="ms-1 font-sans text-xs text-slate-400">ج.م</span>
                            </span>
                          )}
                        </td>
                        )}
                        <td className="px-6 py-4">
                          <CategoryChip category={line.raw_item.category} />
                        </td>
                        {mayEdit && (
                          <td className="px-6 py-4">
                            {pendingRemoveId === line.id ? (
                              <div className="flex items-center justify-end gap-2">
                                <span className="text-xs text-slate-500">حذف المكوّن؟</span>
                                <button
                                  type="button"
                                  disabled={busyLineId === line.id}
                                  onClick={() => handleRemoveLine(line.id)}
                                  className="rounded-lg bg-destructive-strong px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
                                >
                                  {busyLineId === line.id ? '…' : 'تأكيد'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPendingRemoveId(null)}
                                  className="rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-500 transition-colors hover:bg-surface-sand-alt"
                                >
                                  إلغاء
                                </button>
                              </div>
                            ) : (
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  aria-label={`حذف ${line.raw_item.name} من الوصفة`}
                                  onClick={() => setPendingRemoveId(line.id)}
                                  className="rounded-lg px-2.5 py-1 text-xs font-semibold text-destructive-strong transition-colors hover:bg-destructive-soft"
                                >
                                  حذف
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Editing a recipe drives food cost, so it is administrative
                  (0010/0014). A read-only role sees the recipe but no edit
                  actions. There is no "save recipe" button: each change is
                  written on its own, so nothing sits unsaved on screen. */}
              {mayEdit ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-sand-border px-6 py-4">
                  <p
                    role={lineError ? 'alert' : undefined}
                    className={
                      lineError
                        ? 'text-xs font-semibold text-destructive-strong'
                        : 'text-xs text-slate-500'
                    }
                  >
                    {lineError ?? 'كل تعديل يُحفظ فور إدخاله.'}
                  </p>
                  <Button variant="primary" type="button" onClick={() => setModalOpen(true)}>
                    إضافة مكوّن
                  </Button>
                </div>
              ) : (
                <p className="border-t border-surface-sand-border px-6 py-4 text-xs text-slate-500">
                  عرض فقط — تعديل الوصفات متاح للمالك والمديرين.
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <AddIngredientModal
        open={modalOpen}
        ingredients={ingredients}
        onClose={() => setModalOpen(false)}
        onAdd={handleAddLine}
      />
    </div>
  );
}

/**
 * The quantity of one ingredient, editable in place for an admin.
 *
 * Blur and Enter commit, but neither is the only path: while the draft differs
 * from the stored quantity an explicit save button appears next to the field.
 * Blur alone would be invisible — the user could retype a quantity, click
 * straight onto "add ingredient" or another dish, and never learn whether the
 * change was written. The button makes "not saved yet" a thing you can see.
 * Escape abandons the edit.
 */
function QuantityCell({
  line,
  editable,
  busy,
  onCommit,
}: {
  line: RecipeLine;
  editable: boolean;
  busy: boolean;
  onCommit: (quantity: number) => void;
}) {
  const [draft, setDraft] = useState(String(line.quantity_required));

  // Re-seed whenever the stored quantity changes — after a successful save, and
  // after a failed one, where the reload snaps the cell back to the real value.
  useEffect(() => {
    setDraft(String(line.quantity_required));
  }, [line.quantity_required]);

  if (!editable) {
    return (
      <span className="font-numerals font-semibold text-surface-dark">
        {line.quantity_required.toLocaleString('en-US')}
      </span>
    );
  }

  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  const dirty = valid && parsed !== line.quantity_required;

  function commit() {
    if (!valid) {
      // The DB CHECK rejects this anyway; snapping back is kinder than a round
      // trip that can only fail.
      setDraft(String(line.quantity_required));
      return;
    }
    if (dirty) {
      onCommit(parsed);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        dir="ltr"
        aria-label={`الكمية المطلوبة من ${line.raw_item.name}`}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setDraft(String(line.quantity_required));
          }
        }}
        className={[
          'w-24 rounded-lg border bg-white px-2 py-1 font-numerals text-start text-sm font-semibold',
          'text-surface-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30',
          'disabled:opacity-50',
          dirty ? 'border-twilight-500' : 'border-surface-sand-border focus:border-twilight-500',
        ].join(' ')}
      />
      {dirty && (
        <button
          type="button"
          disabled={busy}
          // onMouseDown, not onClick: the input's blur fires first on click and
          // would re-render the button away before the click landed.
          onMouseDown={(e) => {
            e.preventDefault();
            commit();
          }}
          aria-label={`حفظ كمية ${line.raw_item.name}`}
          className="rounded-lg bg-twilight-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-twilight-700 disabled:opacity-50"
        >
          {busy ? '…' : 'حفظ'}
        </button>
      )}
    </div>
  );
}

/** Money, in the Latin numerals the rest of the admin uses for figures. */
function money(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The server's message when there is one, so 409/400 explain themselves. */
function errorMessage(err: unknown, fallback: string): string {
  const msg = axios.isAxiosError(err)
    ? (err.response?.data as { error?: string } | undefined)?.error
    : undefined;
  return msg ?? fallback;
}

function CategoryChip({ category }: { category?: IngredientCategory }) {
  if (category === 'intermediate') {
    return <Badge variant="twilight">وسيط</Badge>;
  }
  return <Badge variant="amber">مشتريات</Badge>;
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-slate-500">
      {children}
    </th>
  );
}
