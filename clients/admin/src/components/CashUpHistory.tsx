import { useCallback, useEffect, useState } from 'react';
import { tillRepository } from '../api/TillRepository';
import type { TillHistory, TillPerson } from '../api/TillRepository';

/**
 * Cash-ups, and the pattern in them.
 *
 * The alert on a short drawer already exists and fires the same night. What
 * this adds is the question no sequence of alerts ever answers: is it the same
 * person, and how often?
 *
 * ----------------------------------------------------------------------------
 * THIS SCREEN PUTS NAMES NEXT TO MISSING MONEY, so it is built to inform and
 * not to accuse:
 *
 *   - Every count is shown WITH its denominator. "Short four times" means
 *     nothing until you know whether it was four of five or four of ninety,
 *     and an absolute count always crowns whoever closes the most drawers —
 *     pointing a manager at their most reliable person.
 *   - Net is shown BESIDE the money that actually went missing. Ten over on
 *     Monday and ten short on Tuesday nets to zero and is two mistakes.
 *   - Nothing is ranked by variance, scored, or flagged red. The rows are
 *     ordered by how many drawers each person closed, and a human decides.
 *     A number that sorts people by suspicion gets read as evidence.
 */

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A name a person would recognise, from whatever the API could give us. */
function who(p: { email: string | null; closed_by: string | null }): string {
  if (p.email) return p.email.split('@')[0];
  // The account is gone. The session still happened, so say that rather than
  // inventing somebody or dropping the row.
  return p.closed_by ? 'حساب محذوف' : 'غير منسوب';
}

export default function CashUpHistory({ from, to }: { from: Date; to: Date }) {
  const [data, setData] = useState<TillHistory | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const h = await tillRepository.history(from, to);
      // One bad payload costs this card, not the page it sits on.
      if (typeof h?.summary?.closed !== 'number') {
        setFailed(true);
        return;
      }
      setData(h);
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
        <p className="text-sm text-app-ink-muted">تعذّر تحميل سجلّ الجرد.</p>
      </section>
    );
  }

  if (!data) return null;

  if (data.summary.closed === 0) {
    return (
      <section
        data-testid="cash-up"
        className="rounded-xl border border-app-border bg-app-surface p-4"
      >
        <h2 className="text-sm font-bold text-app-ink">جرد الدرج</h2>
        {/* Not "0 عجز". No drawer was counted, which is a different fact from
            every drawer balancing — and the second one is reassuring. */}
        <p className="mt-2 text-sm text-app-ink-muted">
          لم يُغلق أي درج في هذه الفترة.
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="cash-up"
      className="rounded-xl border border-app-border bg-app-surface p-4"
    >
      <h2 className="text-sm font-bold text-app-ink">جرد الدرج</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Figure label="أدراج أُغلقت" value={String(data.summary.closed)} testId="closed" />
        <Figure
          label="مضبوطة"
          value={`${data.summary.balanced} / ${data.summary.closed}`}
          testId="balanced"
        />
        <Figure
          label="إجمالي العجز"
          testId="short"
          value={`${money(Math.abs(data.summary.total_short))} ج.م`}
          // The only accent on the screen, and it is on a total rather than on
          // a person.
          accent={data.summary.total_short < 0}
          // Shown together, always: net alone reads as "almost nothing is
          // wrong" in a month where money left on Tuesday and came back on
          // Wednesday.
          hint={`الصافي ${money(data.summary.net)} ج.م`}
        />
      </div>

      {data.people.length > 0 && (
        <table className="mt-4 w-full text-right text-xs" data-testid="people">
          <thead>
            <tr className="text-app-ink-muted">
              <th className="py-1 font-normal">من أغلق</th>
              <th className="py-1 font-normal">أدراج</th>
              <th className="py-1 font-normal">ليالٍ بعجز</th>
              <th className="py-1 font-normal">الصافي</th>
            </tr>
          </thead>
          <tbody>
            {data.people.map((p) => (
              <PersonRow key={p.closed_by ?? 'unattributed'} person={p} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PersonRow({ person }: { person: TillPerson }) {
  return (
    <tr data-testid={`person-${person.closed_by ?? 'unattributed'}`} className="border-t border-app-border">
      <td className="py-1.5 text-app-ink">{who(person)}</td>
      <td className="font-numerals py-1.5 text-app-ink-muted">{person.sessions}</td>
      <td className="font-numerals py-1.5 text-app-ink">
        {/* The count and its denominator, in one cell so they cannot be read
            apart. Four of ninety and four of five are different facts. */}
        {person.short_nights} / {person.sessions}
        {person.short_rate !== null && (
          <span className="mr-1 text-app-ink-muted">({person.short_rate}%)</span>
        )}
      </td>
      <td className="font-numerals py-1.5 text-app-ink">{money(person.net)}</td>
    </tr>
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
  testId: string;
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
