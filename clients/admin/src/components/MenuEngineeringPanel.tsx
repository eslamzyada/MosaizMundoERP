import type { MenuEngineering, MenuQuadrant, MenuVerdict } from '../types';

/**
 * Which dishes to keep, reprice, promote, or drop.
 *
 * The reports page could say which dish earned the most money. That is a
 * different and much weaker question than which dish is worth its place: the
 * biggest earner is often simply the thing sold most, and the dish quietly
 * losing money on every plate looks fine in a revenue table.
 *
 * Each quadrant is labelled with the ACTION rather than the jargon. "نجم" tells
 * a manager nothing on its own; "احمِ مكانه في القائمة" does.
 */

const QUADRANTS: Record<
  Exclude<MenuQuadrant, 'unknown'>,
  { title: string; action: string; tone: string }
> = {
  star: {
    title: 'نجوم',
    action: 'يبيع كثيرًا ويربح كثيرًا. احمِ مكانه: التوافر والثبات والموضع في القائمة.',
    tone: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  },
  plowhorse: {
    title: 'أحصنة العمل',
    action: 'يبيع كثيرًا وربحه ضعيف. السعر أو التكلفة هو الخطأ، لا الصنف — لا تحذفه.',
    tone: 'border-amber-300 bg-amber-50 text-amber-900',
  },
  puzzle: {
    title: 'ألغاز',
    action: 'ربحه جيد ولا يُطلب. مشكلة موضع ووصف في القائمة، لا مشكلة مطبخ.',
    tone: 'border-twilight-300 bg-twilight-50 text-twilight-900',
  },
  dog: {
    title: 'مرشّحة للحذف',
    action: 'لا يبيع ولا يربح. حذفه يحرّر مساعدة تحضير ومساحة في القائمة.',
    tone: 'border-rose-300 bg-rose-50 text-rose-900',
  },
};

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function MenuEngineeringPanel({ data }: { data: MenuEngineering }) {
  // Nothing sold in the window. Saying so beats four empty boxes that look
  // like a broken screen.
  if (data.items.length === 0) return null;

  const order: Array<Exclude<MenuQuadrant, 'unknown'>> = ['star', 'plowhorse', 'puzzle', 'dog'];
  const unknown = data.items.filter((i) => i.quadrant === 'unknown');

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="border-b border-app-border px-6 py-4">
        <h2 className="text-sm font-bold text-app-ink">هندسة القائمة</h2>
        {/*
          The thresholds, stated. The first question anybody asks of "this is a
          dog" is "مقارنةً بماذا؟", and a verdict you cannot argue with is a
          verdict nobody acts on.
        */}
        <p className="mt-1 text-xs text-app-ink-muted">
          يُقاس كل صنف مقابل متوسط ربح{' '}
          <span className="font-numerals font-semibold">{money(data.thresholds.unit_margin)}</span>{' '}
          ج.م للطبق، وحصة مبيعات{' '}
          <span className="font-numerals font-semibold">
            {(data.thresholds.popularity * 100).toFixed(1)}%
          </span>
          .
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
        {order.map((key) => {
          const meta = QUADRANTS[key];
          const items = data.items
            .filter((i) => i.quadrant === key)
            .sort((a, b) => (b.unit_margin ?? 0) - (a.unit_margin ?? 0));

          return (
            <div key={key} className={`rounded-xl border p-4 ${meta.tone}`}>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-bold">{meta.title}</h3>
                <span className="font-numerals text-xs font-bold">{items.length}</span>
              </div>
              <p className="mt-1 text-xs opacity-90">{meta.action}</p>

              {items.length === 0 ? (
                <p className="mt-3 text-xs opacity-70">لا يوجد صنف في هذه الفئة.</p>
              ) : (
                <ul className="mt-3 space-y-1">
                  {items.slice(0, 6).map((i) => (
                    <MenuRow key={i.id} item={i} />
                  ))}
                  {items.length > 6 && (
                    <li className="pt-1 text-xs opacity-70">
                      و{items.length - 6} صنفًا آخر
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/*
        Shown, never hidden. An uncosted dish is not a fifth category of dish —
        it is a dish nobody has costed, and leaving it out would let a manager
        believe the whole menu had been analysed.
      */}
      {unknown.length > 0 && (
        <div className="border-t border-app-border bg-app-surface-alt/50 px-6 py-4">
          <h3 className="text-xs font-bold text-app-ink">
            بانتظار التكلفة ({unknown.length})
          </h3>
          <p className="mt-1 text-xs text-app-ink-muted">
            لا يمكن تصنيف هذه الأصناف قبل اكتمال تكلفتها. إدراجها بتكلفة صفر يجعلها تبدو الأعلى
            ربحًا في القائمة.
          </p>
          <p className="mt-2 text-xs text-app-ink">
            {unknown.slice(0, 8).map((i) => i.name).join('، ')}
            {unknown.length > 8 ? '…' : ''}
          </p>
        </div>
      )}
    </section>
  );
}

function MenuRow({ item }: { item: MenuVerdict }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-xs">
      <span className="truncate font-semibold">{item.name}</span>
      <span className="font-numerals whitespace-nowrap opacity-80">
        {item.unit_margin === null ? '—' : `${money(item.unit_margin)} ج.م`}
        <span className="opacity-70"> · {(item.popularity * 100).toFixed(1)}%</span>
      </span>
    </li>
  );
}
