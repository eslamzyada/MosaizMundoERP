import { Navigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { homeFor } from '../lib/roleHome';

/**
 * Sends each role to its own home.
 *
 * `/` is a junction rather than a page. Which screen counts as "home" is a
 * property of the job, and the old answer — a management dashboard for
 * everybody — is what made a waiter's first impression of this system a wall of
 * figures they cannot use and mostly cannot open.
 *
 * `replace` so the redirect does not sit in history: pressing back from the
 * floor screen should leave the app, not bounce through a junction.
 */
export default function RoleLanding() {
  const { me, loading, error } = useSession();

  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center text-sm text-app-ink-muted">
        جارٍ التحميل…
      </div>
    );
  }

  // No membership resolved. The dashboard is the safest landing: it degrades to
  // its own error state, which explains itself, rather than redirecting into a
  // page that will look empty for reasons nobody can see.
  if (error || !me) return <Navigate to="/dashboard" replace />;

  return <Navigate to={homeFor(me.role)} replace />;
}
