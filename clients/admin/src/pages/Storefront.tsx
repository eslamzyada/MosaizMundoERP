import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

/**
 * The page a customer sees (0040).
 *
 * Deliberately NOT built on the admin's api client. That client attaches a
 * Supabase bearer token and signs the user out on a 401 — behaviour that makes
 * sense inside a back office and none at all for a stranger who is trying to
 * order lunch. This page talks to /public with plain fetch and no credentials,
 * which is also the honest expression of what it is: an anonymous request.
 *
 * It sends item ids and quantities. It knows the prices, because they were
 * read from the menu, but it does not send them — the server prices every line
 * again from the same menu. A page that could name a price would be a page
 * worth tampering with.
 */

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface MenuItem {
  id: string;
  name: string;
  price: number;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Storefront() {
  const { slug = '' } = useParams();

  const [menu, setMenu] = useState<{ restaurant: string; greeting: string | null; items: MenuItem[] } | null>(null);
  const [closed, setClosed] = useState(false);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/public/${encodeURIComponent(slug)}/menu`);
      if (!res.ok) {
        // 404 covers "no such shop", "closed", and "does not do this" — one
        // answer, and the page says the only useful thing it can.
        setClosed(true);
        return;
      }
      setMenu(await res.json());
    } catch {
      setClosed(true);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const lines = useMemo(
    () =>
      Object.entries(basket)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({ item: menu?.items.find((i) => i.id === id), qty }))
        .filter((l): l is { item: MenuItem; qty: number } => !!l.item),
    [basket, menu],
  );

  // Shown so the customer knows what they are agreeing to. The server computes
  // its own total from the menu, and that one is authoritative.
  const total = lines.reduce((sum, l) => sum + l.item.price * l.qty, 0);

  /**
   * A DELTA, computed from the previous state — not `basket[id] + 1` read from
   * the render closure.
   *
   * That closure form loses clicks: three taps on + inside one React batch all
   * read the same stale basket, all set the quantity to 1, and the customer who
   * wanted three burgers gets one. Which is precisely the person who taps fast.
   */
  function bump(id: string, delta: number) {
    setBasket((b) => ({ ...b, [id]: Math.max(0, Math.min(99, (b[id] ?? 0) + delta)) }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);

    if (name.trim().length < 2) return setProblem('من فضلك اكتب اسمك.');
    if (phone.trim().length < 5) return setProblem('من فضلك اكتب رقم هاتفك.');
    if (lines.length === 0) return setProblem('اختر صنفًا واحدًا على الأقل.');

    setBusy(true);
    try {
      const res = await fetch(`${API}/public/${encodeURIComponent(slug)}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          note: note.trim() || undefined,
          // Ids and quantities. No prices — see the note at the top.
          items: lines.map((l) => ({ item_id: l.item.id, quantity: l.qty })),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setProblem(
          body.code === 'unknown_item'
            ? 'أحد الأصناف لم يعد متاحًا. حدِّث الصفحة وحاول مجددًا.'
            : 'تعذّر إرسال الطلب. حاول مرة أخرى.',
        );
        return;
      }

      const body = await res.json();
      setToken(body.tracking_token);
    } catch {
      setProblem('تعذّر الاتصال بالمطعم.');
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <main className="grid min-h-screen place-items-center bg-app-bg p-8 text-center">
        <div>
          <h1 className="text-xl font-bold text-app-ink">الطلب غير متاح حاليًا</h1>
          <p className="mt-2 text-sm text-app-ink-muted">
            قد يكون المطعم مغلقًا الآن، أو الرابط غير صحيح.
          </p>
        </div>
      </main>
    );
  }

  if (!menu) {
    return (
      <main className="grid min-h-screen place-items-center bg-app-bg text-sm text-app-ink-muted">
        جارٍ التحميل…
      </main>
    );
  }

  if (token) {
    return (
      <main className="mx-auto max-w-lg p-8 text-center" data-testid="order-placed">
        <h1 className="text-2xl font-bold text-app-ink">تم إرسال طلبك</h1>
        <p className="mt-2 text-sm text-app-ink-muted">
          سيؤكّده المطعم بعد قليل. احتفظ بهذا الرابط لمتابعة الحالة.
        </p>
        <p className="font-numerals mt-4 break-all rounded-lg bg-app-surface p-3 text-xs text-app-ink">
          {window.location.origin}/order/track/{token}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-6" data-testid="storefront">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">{menu.restaurant}</h1>
        {menu.greeting && <p className="mt-1 text-sm text-app-ink-muted">{menu.greeting}</p>}
      </header>

      <ul className="space-y-2">
        {menu.items.map((item) => (
          <li
            key={item.id}
            data-testid={`menu-item-${item.id}`}
            className="flex items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface px-4 py-3"
          >
            <span>
              <span className="block text-sm font-medium text-app-ink">{item.name}</span>
              <span className="font-numerals block text-xs text-app-ink-muted">
                {money(item.price)} ج.م
              </span>
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                aria-label={`إنقاص ${item.name}`}
                onClick={() => bump(item.id, -1)}
                className="grid h-8 w-8 place-items-center rounded-lg border border-app-border text-app-ink"
              >
                −
              </button>
              <span className="font-numerals w-6 text-center text-sm text-app-ink">
                {basket[item.id] ?? 0}
              </span>
              <button
                type="button"
                aria-label={`إضافة ${item.name}`}
                onClick={() => bump(item.id, 1)}
                className="grid h-8 w-8 place-items-center rounded-lg bg-twilight-600 text-white"
              >
                +
              </button>
            </span>
          </li>
        ))}
      </ul>

      {lines.length > 0 && (
        <form onSubmit={submit} className="mt-6 rounded-xl border border-app-border bg-app-surface p-4">
          <p className="text-sm font-semibold text-app-ink">
            الإجمالي التقريبي:{' '}
            <span className="font-numerals" data-testid="basket-total">
              {money(total)}
            </span>{' '}
            ج.م
          </p>
          {/* Said plainly, because it is true and because it is the reason the
              page does not send prices. */}
          <p className="mt-1 text-xs text-app-ink-muted">
            يُحسب المبلغ النهائي من قائمة المطعم عند تأكيد الطلب.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="الاسم"
              aria-label="الاسم"
              className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="رقم الهاتف"
              aria-label="رقم الهاتف"
              className="font-numerals rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
            />
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="ملاحظات (اختياري)"
            aria-label="ملاحظات"
            className="mt-3 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          />

          {problem && <p className="mt-3 text-sm text-sunset-600">{problem}</p>}

          <button
            type="submit"
            disabled={busy}
            data-testid="place-order"
            className="mt-4 w-full rounded-lg bg-twilight-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'جارٍ الإرسال…' : 'أرسل الطلب'}
          </button>
        </form>
      )}
    </main>
  );
}

/**
 * Statuses that will never change again.
 *
 * Polling one of these is a request every 15 seconds, forever, from a page
 * somebody left open on a counter.
 */
const SETTLED = new Set(['rejected', 'fulfilled', 'cancelled']);

/** How often to ask, while there is still something to wait for. */
const POLL_MS = 15_000;

/** The other half of the link: what happened to my order. */
export function TrackOrder() {
  const { token = '' } = useParams();
  const [state, setState] = useState<{ status: string; total: number; placed_at?: string } | null>(
    null,
  );
  const [missing, setMissing] = useState(false);

  /**
   * This used to fetch ONCE.
   *
   * A tracking page whose whole purpose is to show a status that changes, and
   * it asked the server exactly one time — so a customer watching it saw
   * "بانتظار تأكيد المطعم" through acceptance, preparation and delivery, and
   * had no way to know the page was not going to tell them anything. Nothing
   * on it even suggested reloading.
   */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the FIRST answer may decide the order does not exist. Once a real
    // status has been shown, a failed poll is a network blip — replacing the
    // customer's order with "we could not find this" over one dropped request
    // would be alarming and wrong.
    let everLoaded = false;

    const stop = () => timer !== undefined && clearTimeout(timer);

    const schedule = (status?: string) => {
      stop();
      // Settled orders stop asking. A phone in a pocket stops too, and picks
      // up again on the visibility change below — which is the moment somebody
      // actually looks at it.
      if (!alive || (status && SETTLED.has(status)) || document.hidden) return;
      timer = setTimeout(load, POLL_MS);
    };

    const load = () => {
      fetch(`${API}/public/track/${encodeURIComponent(token)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then((body) => {
          if (!alive) return;
          everLoaded = true;
          setState(body);
          schedule(body?.status);
        })
        .catch(() => {
          if (!alive) return;
          if (!everLoaded) setMissing(true);
          else schedule();
        });
    };

    const onVisible = () => {
      // Ask straight away rather than waiting out the interval: becoming
      // visible IS the customer checking.
      if (!document.hidden && alive) load();
    };

    load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);

  const LABEL: Record<string, string> = {
    pending: 'بانتظار تأكيد المطعم',
    accepted: 'تم قبول طلبك',
    rejected: 'لم يُقبل الطلب',
    fulfilled: 'تم التسليم',
    cancelled: 'أُلغي الطلب',
  };

  return (
    <main className="grid min-h-screen place-items-center p-8 text-center" data-testid="track">
      {missing ? (
        <p className="text-sm text-app-ink-muted">لم نجد هذا الطلب.</p>
      ) : !state ? (
        <p className="text-sm text-app-ink-muted">جارٍ التحميل…</p>
      ) : (
        <div>
          <h1 className="text-xl font-bold text-app-ink">{LABEL[state.status] ?? state.status}</h1>
          <p className="font-numerals mt-2 text-sm text-app-ink-muted">
            {money(state.total)} ج.م
          </p>
          {/*
            When it was ordered. The API has always returned this and the page
            threw it away — so a customer with the link open could not tell
            their order from five minutes ago from one placed yesterday.
          */}
          {state.placed_at && (
            <p className="font-numerals mt-1 text-xs text-app-ink-muted">
              {new Date(state.placed_at).toLocaleString('ar-EG', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
