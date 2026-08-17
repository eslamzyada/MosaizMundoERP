import type { LoadFailure } from '../lib/loadFailure';

/**
 * One place a failed page load is shown.
 *
 * Eleven pages each hand-rolled their own variant of the same sentence, so the
 * wording drifted and none of them could say which of four things had actually
 * happened. Rendering from a classified [LoadFailure] means the message and the
 * action offered always agree with each other, and fixing the wording once
 * fixes it everywhere.
 *
 * [onRetry] is only honoured when the failure says retrying could work — the
 * component will not offer a button that is guaranteed to fail.
 */
export default function LoadError({
  failure,
  onRetry,
}: {
  failure: LoadFailure;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"
    >
      <p className="font-semibold">{failure.message}</p>

      {failure.kind === 'unauthenticated' && (
        <p className="mt-1 text-amber-800">
          سيعود التطبيق إلى شاشة الدخول تلقائيًا.
        </p>
      )}

      {failure.canRetry && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
        >
          إعادة المحاولة
        </button>
      )}

      {/*
        The reference, and only where it is worth anything.

        Shown for a server fault, because "(500)" identifies nothing — every
        500 in the system says 500 — while this string leads to the one line in
        the log that is theirs. Withheld for an expired session or a permission
        the account does not have: those are not faults, the reader already
        knows what to do, and an id would suggest there is something to report.

        `select-all` so a tap or click takes the whole thing. Somebody is going
        to retype this into a WhatsApp message, and a half-copied id is worse
        than none.
      */}
      {failure.reference && (failure.kind === 'server' || failure.kind === 'unknown') && (
        <p className="mt-3 text-xs text-amber-800">
          رقم المرجع:{' '}
          <code dir="ltr" className="select-all rounded bg-amber-100 px-1.5 py-0.5 font-mono">
            {failure.reference}
          </code>
        </p>
      )}
    </div>
  );
}
