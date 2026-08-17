import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MIN_QUERY_LENGTH, searchRepository } from '../api/SearchRepository';
import { hitPath, kindLabel, matchDestinations } from '../lib/searchTargets';
import type { SearchHit } from '../lib/searchTargets';
import { useSession } from '../session/SessionProvider';
import { classifyLoadFailure } from '../lib/loadFailure';
import { safeInternalPath } from '../lib/safeInternalPath';

/**
 * One box that finds anything and goes there.
 *
 * Two sources, one list. Pages are known to the bundle and filter as fast as
 * the keystrokes arrive; records have to be fetched. Showing them in separate
 * lists would mean deciding which one the arrow keys are "in" — so they are a
 * single flat list with a chip saying what each row is, and Enter always
 * opens whatever is highlighted.
 *
 * The pages appear FIRST and appear immediately. That is what makes the box
 * feel instant even on a slow connection: something useful is already on
 * screen while the request is still out.
 */

const DEBOUNCE_MS = 180;

interface Item {
  key: string;
  to: string;
  label: string;
  detail: string | null;
  /** Null for a page — the chip is what distinguishes a record from a page. */
  chip: string | null;
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { can } = useSession();

  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  // Every open starts from nothing. Reopening onto the previous answer looks
  // like a cached result for a question you did not ask.
  useEffect(() => {
    if (!open) return;
    setTerm('');
    setHits([]);
    setError(null);
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  // Debounced fetch, with the previous request aborted. Without the abort, a
  // slow answer to "طم" can land after a fast answer to "طماطم" and replace
  // it — results for a question that is no longer on the screen.
  useEffect(() => {
    if (!open) return;
    const trimmed = term.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    // Aborting is what SHOULD stop a superseded request, but it is the
    // transport's promise to keep, not this component's. `superseded` makes the
    // guarantee local: a result belonging to a term that is no longer in the
    // box is dropped whether or not the abort landed in time.
    let superseded = false;

    setLoading(true);
    const timer = setTimeout(() => {
      searchRepository
        .search(trimmed, controller.signal)
        .then((results) => {
          if (superseded) return;
          setHits(results);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          // An aborted request is not a failure — it is the newer keystroke
          // doing its job, and its own result is already on the way.
          if (superseded || controller.signal.aborted) return;
          setHits([]);
          setError(classifyLoadFailure(err).message);
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      superseded = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, open]);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = matchDestinations(term, can).map((d) => ({
      key: `page:${d.to}`,
      to: d.to,
      label: d.label,
      detail: null,
      chip: null,
    }));
    const records: Item[] = hits.flatMap((hit) => {
      const to = hitPath(hit);
      // routableHits already dropped unknown kinds; this keeps the component
      // honest on its own, so it cannot be broken by a different caller.
      if (!to) return [];
      return [{ key: `${hit.kind}:${hit.id}`, to, label: hit.label, detail: hit.detail, chip: kindLabel(hit.kind) }];
    });
    return [...pages, ...records];
  }, [term, hits, can]);

  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const go = useCallback(
    (to: string) => {
      onClose();
      // Every target here is built from a fixed route table plus an
      // encodeURIComponent'd id, so this cannot currently refuse anything. It
      // is here because that is a property of today's callers, not of this
      // function — and a navigate() that trusts its argument is one new caller
      // away from being an open redirect.
      const target = safeInternalPath(to);
      if (target) navigate(target);
    },
    [navigate, onClose],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, items.length - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = items[active];
      if (chosen) go(chosen.to);
    }
  }

  if (!open) return null;

  const tooShort = term.trim().length > 0 && term.trim().length < MIN_QUERY_LENGTH;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 p-4 pt-[12vh] backdrop-blur-sm"
      // Closing on the backdrop, not on any click inside it: a click that
      // starts on a result and drifts onto the backdrop must still open the
      // result.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="البحث في النظام"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-app-border px-4 py-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="flex-shrink-0 text-app-ink-muted"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={items[active] ? `palette-item-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="ابحث عن صنف أو مكوّن أو مورّد أو صفحة…"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              // Back to the top on every keystroke. This is also what keeps a
              // SHRINKING list safe: narrowing the search can leave fewer rows
              // than the highlight's index, and a highlight past the end means
              // Enter does nothing at all — which reads as a frozen box.
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="w-full bg-transparent text-base text-app-ink outline-none placeholder:text-app-ink-muted"
          />
          {loading && (
            <span className="flex-shrink-0 text-xs text-app-ink-muted" role="status">
              جارٍ البحث…
            </span>
          )}
        </div>

        <ul
          id="palette-results"
          role="listbox"
          aria-label="نتائج البحث"
          className="max-h-80 overflow-y-auto py-2"
        >
          {items.map((item, index) => (
            <li
              key={item.key}
              id={`palette-item-${index}`}
              role="option"
              aria-selected={index === active}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
            >
              <button
                type="button"
                // mousedown, not click: the input keeps focus and the row
                // opens on press, the way the keyboard path does.
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(item.to);
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors ${
                  index === active ? 'bg-twilight-600 text-white' : 'text-app-ink hover:bg-app-surface-alt'
                }`}
              >
                <span className="flex-1 truncate text-sm font-medium">{item.label}</span>
                {item.detail && (
                  <span
                    className={`truncate font-numerals text-xs ${
                      index === active ? 'text-white/70' : 'text-app-ink-muted'
                    }`}
                  >
                    {item.detail}
                  </span>
                )}
                <span
                  className={`flex-shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                    index === active
                      ? 'bg-white/20 text-white'
                      : 'bg-app-surface-alt text-app-ink-muted'
                  }`}
                >
                  {item.chip ?? 'صفحة'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* One message at a time, and never a blank panel: an empty box with
            no explanation is indistinguishable from a broken one. */}
        {items.length === 0 && (
          <p className="px-4 pb-4 text-sm text-app-ink-muted" role="status">
            {error
              ? error
              : tooShort
                ? `اكتب حرفين على الأقل.`
                : term.trim().length === 0
                  ? 'اكتب للبحث في الأصناف والمكوّنات والمورّدين والطلبات والصفحات.'
                  : loading
                    ? 'جارٍ البحث…'
                    : 'لا توجد نتائج مطابقة.'}
          </p>
        )}

        <div className="flex items-center justify-between border-t border-app-border bg-app-surface-alt/40 px-4 py-2 text-[11px] text-app-ink-muted">
          <span>
            <kbd className="font-numerals">↑</kbd> <kbd className="font-numerals">↓</kbd> للتنقّل ·{' '}
            <kbd>Enter</kbd> للفتح · <kbd>Esc</kbd> للإغلاق
          </span>
          <span className="font-numerals">Ctrl + K</span>
        </div>
      </div>
    </div>
  );
}
