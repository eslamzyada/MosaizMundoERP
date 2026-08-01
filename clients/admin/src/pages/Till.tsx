import { Link } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { ROLE_LABELS } from '../session/SessionProvider';

/**
 * The cashier's page, which is deliberately almost nothing.
 *
 * A cashier's tool is the till. Everything their job needs — the menu, the tab,
 * the payment, the receipt — is on the POS, and a back office that offers them
 * a dashboard is offering a second place to look for answers that are not
 * there. The honest version of this screen is one that says so and gets out of
 * the way.
 *
 * It is not an error page and does not apologise. Nothing has gone wrong: this
 * is simply not where their work happens.
 */
export default function Till() {
  const { me } = useSession();

  return (
    <div className="grid min-h-[70vh] place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-twilight-600/10 text-twilight-700 dark:text-twilight-300">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M7 20h10" />
            <path d="M12 16v4" />
          </svg>
        </div>

        <h1 className="text-xl font-bold text-app-ink">عملك على نقطة البيع</h1>
        <p className="mt-2 text-sm text-app-ink-muted">
          القائمة والطاولات والدفع والإيصالات كلها هناك. لا يوجد في هذه الشاشة ما تحتاجه أثناء
          الوردية.
        </p>

        {me && (
          <p className="mt-4 text-xs text-app-ink-muted">
            أنت مسجّل باسم{' '}
            <span className="font-semibold text-app-ink">{ROLE_LABELS[me.role] ?? me.role}</span>.
          </p>
        )}

        <p className="mt-6 text-xs text-app-ink-muted">
          لتغيير المظهر أو حجم الخط:{' '}
          <Link
            to="/settings"
            className="font-semibold text-twilight-700 underline dark:text-twilight-300"
          >
            الإعدادات
          </Link>
        </p>
      </div>
    </div>
  );
}
