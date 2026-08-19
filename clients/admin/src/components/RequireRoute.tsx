import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { ROLE_HOME, navFor } from '../lib/roleHome';

/**
 * A role may only open the pages that are its own.
 *
 * Until now the SIDEBAR was the only thing that differed between roles. Every
 * route was mounted for everybody, so /reports, /members and /insights were one
 * typed URL — or one search result — away from a waiter. The search box made
 * that trivial rather than theoretical: it returned records from those very
 * pages, so the way in was also the advertisement for it.
 *
 * The API refuses most of those calls, which is why this was never a breach of
 * the books. It was still wrong: a page that loads and then fills with refusals
 * teaches people the software is broken, and the pages whose GET is NOT
 * role-gated were readable in full.
 *
 * ----------------------------------------------------------------------------
 * ONE definition, shared with the sidebar.
 *
 * `navFor` is what builds the navigation, so a page is guarded exactly when it
 * is not offered. Two lists would drift, and the drift would be silent in the
 * direction that matters — a page dropped from the sidebar but left reachable
 * looks fixed and is not.
 *
 * A disallowed route sends the role to its OWN home rather than to an error.
 * "You are not allowed here" is true and useless; landing somewhere they can
 * work is the same information delivered as a place to stand.
 */
export default function RequireRoute() {
  const { me } = useSession();
  const location = useLocation();

  // Still resolving who this is. Rendering the child now would flash a page
  // the role may not have, and redirecting now would bounce them off a page
  // they are entitled to — so do neither.
  if (!me) return null;

  const allowed = navFor(me.role, me.modules);
  const path = location.pathname.replace(/\/+$/, '') || '/';

  // '/' is the role landing redirect and belongs to everybody.
  if (path === '/') return <Outlet />;

  // A record page under a section — /orders/<id> — belongs to whoever may open
  // the section.
  const permitted = allowed.some((p) => path === p || path.startsWith(`${p}/`));

  return permitted ? <Outlet /> : <Navigate to={ROLE_HOME[me.role] ?? '/'} replace />;
}
