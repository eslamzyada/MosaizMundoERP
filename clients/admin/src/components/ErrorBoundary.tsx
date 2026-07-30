import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Keeps one broken page from taking the whole admin with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so the result is a completely black screen — no message, no navigation, no
 * clue. That happened here for real: an order status the status map did not
 * know about made a lookup return undefined, and reading a property off it
 * blanked every page in the application, including the ones that were fine.
 *
 * A blank screen is the worst failure this app can produce, because it is
 * indistinguishable from the server being down, the session being expired, or
 * the build being broken — the three things somebody would go and check first,
 * none of which would be the problem.
 *
 * This does not fix bugs. It contains them: the sidebar keeps working, the
 * error is named, and reloading is one button away.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console with the component stack: the on-screen message is
    // for whoever is standing there, this is for whoever has to fix it.
    // eslint-disable-next-line no-console
    console.error('[admin] a page crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="p-8">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6">
          <h1 className="text-lg font-bold text-red-900">تعذّر عرض هذه الصفحة</h1>
          <p className="mt-2 text-sm text-red-800">
            حدث خطأ أثناء عرض هذه الصفحة. بقية اللوحة تعمل — يمكنك الانتقال إلى قسم آخر من
            القائمة، أو إعادة المحاولة.
          </p>

          {/* The message, not a stack: enough for a bug report, not a wall of
              minified frames. The full detail is in the console. */}
          <pre
            dir="ltr"
            className="mt-4 overflow-x-auto rounded bg-app-surface/70 p-3 text-xs text-red-900"
          >
            {error.message}
          </pre>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
            >
              إعادة المحاولة
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-red-300 bg-app-surface px-4 py-2 text-sm font-semibold text-red-900 hover:bg-red-100"
            >
              إعادة تحميل الصفحة
            </button>
          </div>
        </div>
      </div>
    );
  }
}
