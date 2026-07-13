import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Button from '../components/Button';
import Badge from '../components/ui/Badge';
import AddIngredientModal from '../components/AddIngredientModal';
import { HttpRecipeRepository } from '../api/HttpRecipeRepository';
import type { RecipeRepository } from '../api/RecipeRepository';
import type { IngredientCategory, RawInventoryItem, Recipe, RecipeLine } from '../types';

const repository: RecipeRepository = new HttpRecipeRepository();

export default function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ingredients, setIngredients] = useState<RawInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

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
      .catch(() => {
        if (!active) return;
        setError(true);
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

  // Persist the new line to the backend, then re-fetch so the table reflects
  // the committed state (RLS-scoped).
  async function handleAddLine(line: RecipeLine) {
    if (!selectedId) return;
    await repository.addIngredient(selectedId, {
      raw_item_id: line.raw_item.id,
      quantity_required: line.quantity_required,
    });
    const data = await repository.getRecipes();
    setRecipes(data);
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
              <div className="px-4 py-10 text-center text-sm text-destructive-strong">
                تعذّر تحميل البيانات.
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
              تعذّر تحميل البيانات. تأكّد من تسجيل الدخول ومن تشغيل الخادم.
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
                <div className="text-start">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    التكلفة الإجمالية
                  </div>
                  <div className="font-numerals text-xl font-bold text-twilight-700">
                    {selected.total_cost.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                    <span className="ms-1 font-sans text-sm font-medium text-slate-500">ج.م</span>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-surface-sand-border text-sm">
                  <thead className="bg-surface-sand-alt/60">
                    <tr>
                      <Th>المكوّن</Th>
                      <Th>الكمية</Th>
                      <Th>وحدة القياس</Th>
                      <Th>النوع</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-sand-border/70">
                    {selected.recipe_lines.map((line, idx) => (
                      <tr
                        key={`${line.raw_item.id}-${idx}`}
                        className="transition-colors hover:bg-surface-sand/60"
                      >
                        <td className="px-6 py-4 font-semibold text-surface-dark">
                          {line.raw_item.name}
                        </td>
                        <td className="px-6 py-4">
                          <span className="font-numerals font-semibold text-surface-dark">
                            {line.quantity_required.toLocaleString('en-US')}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-slate-500">{line.raw_item.unit_of_measure}</td>
                        <td className="px-6 py-4">
                          <CategoryChip category={line.raw_item.category} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-surface-sand-border px-6 py-4">
                <Button variant="secondary" type="button" onClick={() => setModalOpen(true)}>
                  إضافة مكوّن
                </Button>
                <Button variant="primary" type="button">
                  حفظ الوصفة
                </Button>
              </div>
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
