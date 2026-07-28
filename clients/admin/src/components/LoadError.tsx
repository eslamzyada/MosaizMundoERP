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
    </div>
  );
}
