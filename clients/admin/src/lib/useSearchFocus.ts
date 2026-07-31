import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Landing ON the record, not merely on the page it is somewhere inside.
 *
 * A search result that navigates to /inventory and stops has done the easy
 * half of the job: the ingredient is on that screen, in a table of two hundred
 * rows, and the person now has to find it a second time. This reads the
 * `?focus=<id>` the palette appends, scrolls that row into view once its data
 * has arrived, and holds a highlight on it long enough to be seen.
 *
 * The highlight fades on purpose. A permanent one is still there ten minutes
 * later, reading as "this row is selected" or "this row is a problem" to
 * somebody who has long forgotten how they got here.
 */

const HIGHLIGHT_MS = 2600;

/** Applied to the row while the highlight is up. Background rather than a ring:
 *  box-shadow does not paint on a <tr> in every browser, a background does. */
const LIT_CLASSES = 'bg-sunset-500/20 outline outline-2 -outline-offset-2 outline-sunset-500';

export interface SearchFocus {
  /** The id being looked for, or null when the page was opened normally. */
  focusId: string | null;
  /**
   * Props for the row rendering [id]. Takes the row's own classes and returns
   * them merged, so the call site cannot accidentally drop its hover styles by
   * spreading this after `className`.
   */
  focusProps: (
    id: string,
    baseClassName?: string,
  ) => {
    ref?: (el: HTMLElement | null) => void;
    className: string;
    'data-search-focus'?: boolean;
  };
}

export function useSearchFocus(): SearchFocus {
  const { search } = useLocation();
  const focusId = new URLSearchParams(search).get('focus');

  const [lit, setLit] = useState(() => focusId !== null);

  // Scrolling has to wait for the ROW to exist, which is after the page's own
  // fetch resolves — not when this hook first runs. The ref callback is the
  // only moment that is known. It fires again whenever the highlight changes
  // (the callback's identity changes with it), so the id it last scrolled to
  // is remembered and the scroll happens exactly once per focus.
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId) {
      setLit(false);
      return;
    }
    setLit(true);
    const timer = setTimeout(() => setLit(false), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusId]);

  const focusProps = useCallback(
    (id: string, baseClassName = '') => {
      if (!focusId || id !== focusId) return { className: baseClassName };
      return {
        ref: (el: HTMLElement | null) => {
          if (!el || scrolledTo.current === focusId) return;
          scrolledTo.current = focusId;
          // Optional call: jsdom has no scrollIntoView, and a test asserting
          // the highlight should not have to care.
          el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        },
        // The marker outlives the highlight, so anything that needs to find
        // the row afterwards — a test, a screenshot — still can.
        'data-search-focus': true,
        className: lit ? `${baseClassName} ${LIT_CLASSES}`.trim() : baseClassName,
      };
    },
    [focusId, lit],
  );

  return { focusId, focusProps };
}
