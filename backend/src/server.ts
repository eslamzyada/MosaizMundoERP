import 'dotenv/config';
// Imported for its side effect, and BEFORE ./app on purpose: it checks the
// configuration and refuses to start on a fatal one. See boot.ts for why this
// cannot be a statement in this file.
import './boot';
import { app } from './app';
import { prisma } from './prisma';

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`mosaiz-mundo-api listening on port ${port}`);
});

/**
 * Graceful shutdown, which is what makes a ROLLING DEPLOY safe.
 *
 * The previous version called `server.close()` without waiting for it and then
 * disconnected the pool immediately. `close()` only stops the listener from
 * ACCEPTING new connections — it does not end the requests already running. So
 * every deploy tore the database out from under whatever was in flight, and
 * some of those are checkouts. A burst of 500s per deploy, on the one path
 * where a failure costs money.
 *
 * Three things have to happen, in this order:
 *
 *   1. stop accepting new connections;
 *   2. hang up the IDLE keep-alive sockets. This is the part that surprises:
 *      `close()` waits for every open socket, and a keep-alive connection
 *      sitting idle between requests is open. Without closeIdleConnections()
 *      the callback can wait the full keep-alive timeout for a client that is
 *      doing nothing at all;
 *   3. let the requests that ARE running finish, then close the pool.
 *
 * And a deadline over the whole thing, because "wait for in-flight requests"
 * is only safe if it cannot wait forever. Kubernetes sends SIGTERM, waits
 * terminationGracePeriodSeconds (30 by default), then SIGKILLs — a hard kill
 * is exactly the abrupt teardown this is here to avoid, so the deadline sits
 * well inside that window and shuts the pool down in an orderly way instead.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // A second SIGTERM must not run this twice — the orchestrator often sends
  // one, then another when the process does not vanish instantly.
  if (shuttingDown) return;
  shuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`${signal} received; draining in-flight requests…`);

  const drained = new Promise<boolean>((resolve) => {
    server.close(() => resolve(true));
    server.closeIdleConnections();
  });

  const timedOut = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), SHUTDOWN_DEADLINE_MS).unref();
  });

  const clean = await Promise.race([drained, timedOut]);
  if (!clean) {
    // eslint-disable-next-line no-console
    console.warn(
      `requests still running after ${SHUTDOWN_DEADLINE_MS}ms; closing the pool anyway.`,
    );
  }

  await prisma.$disconnect();
  // eslint-disable-next-line no-console
  console.log('shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
