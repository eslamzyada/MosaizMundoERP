import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A reusable, RTL-friendly modal. Dark translucent backdrop over a light
 * surface-sand panel with a titled header and an X close control.
 *
 * Accessibility:
 *  - Focus moves into the dialog on open and is RESTORED to the trigger on close,
 *    so a keyboard user is not dumped back at the top of the document.
 *  - Focus is TRAPPED: Tab/Shift+Tab cycle within the dialog. Without this, focus
 *    walks out into the page behind the backdrop, which a screen-reader user
 *    cannot see is inert.
 *  - Escape closes; the backdrop is aria-hidden so it is not announced.
 *  - Labelled by its own heading via aria-labelledby (a real element beats a
 *    duplicated aria-label string).
 */
export default function Modal({ open, title, onClose, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = 'modal-title';

  useEffect(() => {
    if (!open) return;

    // Remember what to hand focus back to when we close.
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    // Move focus into the dialog: first field if there is one, else the panel.
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;

      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;

      // Wrap around at both ends, and pull focus back in if it escaped.
      if (e.shiftKey && (active === firstItem || !panelRef.current.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !panelRef.current.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-md overflow-hidden rounded-2xl bg-surface-sand shadow-2xl outline-none ring-1 ring-black/5"
      >
        <div className="flex items-center justify-between border-b border-surface-sand-border px-5 py-4">
          <h2 id={titleId} className="text-base font-bold text-surface-dark">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-lg p-1 text-slate-500 transition-colors hover:bg-black/5 hover:text-surface-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}
