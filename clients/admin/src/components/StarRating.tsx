import { useState } from 'react';

interface Props {
  value: number | null;
  /** Omitted for a closed month: the server owns that rule, we only reflect it. */
  onChange?: (score: number) => void;
  disabled?: boolean;
}

/**
 * A five-point score.
 *
 * Read-only when the month has closed, because a past judgement is history —
 * the same principle as a recorded cost or a void. The control does not decide
 * that; it renders what the server said in `is_editable`.
 */
export default function StarRating({ value, onChange, disabled }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const readOnly = !onChange || disabled;
  const shown = hover ?? value ?? 0;

  return (
    <span className="inline-flex items-center gap-0.5" role="group" aria-label="التقييم">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          aria-label={`${n} من ٥`}
          aria-pressed={value === n}
          onMouseEnter={() => !readOnly && setHover(n)}
          onMouseLeave={() => !readOnly && setHover(null)}
          onClick={() => onChange && onChange(n)}
          className={[
            'text-lg leading-none transition-colors',
            readOnly ? 'cursor-default' : 'cursor-pointer',
            n <= shown ? 'text-amber-500' : 'text-slate-300',
          ].join(' ')}
        >
          ★
        </button>
      ))}
      {value === null && <span className="ms-1 text-xs text-app-ink-muted">بلا تقييم</span>}
    </span>
  );
}
