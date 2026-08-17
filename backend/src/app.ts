import { prisma } from './prisma';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { convertDecimals } from './lib/json';
import { logger } from './lib/logger';
import { requestContext } from './middleware/requestLog';
import posRoutes from './routes/pos.routes';
import inventoryRoutes from './routes/inventory.routes';
import recipeRoutes from './routes/recipe.routes';
import userRoutes from './routes/user.routes';
import memberRoutes from './routes/member.routes';
import catalogRoutes from './routes/catalog.routes';
import menuChangeRoutes from './routes/menuChange.routes';
import notificationRoutes from './routes/notification.routes';
import moduleRoutes from './routes/module.routes';
import labourRoutes from './routes/labour.routes';
import reservationRoutes from './routes/reservation.routes';
import floorRoutes from './routes/floor.routes';
import tillRoutes from './routes/till.routes';
import publicRoutes from './routes/public.routes';
import publicOrderRoutes from './routes/publicOrder.routes';
import reportRoutes from './routes/report.routes';
import ratingRoutes from './routes/rating.routes';
import ratingCriteriaRoutes from './routes/ratingCriteria.routes';
import supplierRoutes from './routes/supplier.routes';
import printerRoutes from './routes/printer.routes';
import { brandingRouter, preferencesRouter } from './routes/preferences.routes';
import searchRoutes from './routes/search.routes';
import exportRoutes from './routes/export.routes';
import purchaseOrderRoutes from './routes/purchaseOrder.routes';
import webhookRoutes from './routes/webhook.routes';

// Moved to lib/json.ts so the export layer can apply the identical conversion
// when it reads a report through its own handler.


// The configured Express app, separated from the listener in server.ts so that
// tests (supertest) can drive it without binding a port.
export const app = express();

// Behind a reverse proxy, set TRUST_PROXY=1 so req.ip (and the rate limiter)
// reflect the real client. Off by default so a direct deployment cannot be
// tricked into trusting a spoofed X-Forwarded-For (analysis F-06).
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

// Security headers (F-06): CSP off by default (this is a JSON API, not an HTML
// origin) but nosniff, frameguard, no x-powered-by, HSTS, etc. are all on.
app.use(helmet());

// CORS allow-list (F-07). Browser origins must be explicitly listed via
// CORS_ORIGINS (comma-separated). A request with NO Origin — the Android POS,
// curl, and the server-to-server Supabase webhook — is allowed, because CORS is
// a browser-enforced control and those callers are not browsers; their real
// gate is the JWT / HMAC signature. A disallowed browser origin simply receives
// no Access-Control-Allow-Origin header, so the browser blocks the read.
const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
// Before everything else, so that every line any of it writes — including a
// CORS rejection or a rate-limit refusal — can be tied back to one request.
app.use(requestContext);

app.use(
  cors({
    origin(origin, cb) {
      cb(null, !origin || allowedOrigins.includes(origin));
    },
    /**
     * Without this line the admin app cannot read the correlation id AT ALL.
     *
     * A browser only lets script see a handful of safelisted response headers;
     * everything else is invisible cross-origin unless the server names it
     * here. `res.setHeader('x-request-id', …)` in requestLog.ts is therefore
     * necessary and not sufficient — the header is on the wire, visible in
     * devtools, and `undefined` to the code that wants to show it to somebody.
     *
     * That failure is silent, which is the reason for the comment: the app
     * would simply render an error with no reference and nobody would know a
     * header had been dropped.
     */
    exposedHeaders: ['x-request-id'],
  }),
);

// LIVENESS — no auth, no database. "This process is running." An orchestrator
// uses it to decide whether to RESTART, so it must not fail for anything a
// restart cannot fix: a database outage would otherwise take every instance
// into a restart loop while the database was the thing that needed attention.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'mosaiz-mundo-api' });
});

// READINESS — the different question: "can this instance serve a request?"
// A load balancer uses it to decide whether to SEND TRAFFIC. It touches the
// database, because an instance that cannot reach Postgres can serve nothing,
// and until now nothing distinguished that from healthy.
app.get('/ready', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', database: 'reachable' });
  } catch {
    // 503, not 500: this instance is not ready, which is a temporary state a
    // load balancer should route around rather than an error to report.
    res.status(503).json({ status: 'not_ready', database: 'unreachable' });
  }
});

// ...and both are mounted ABOVE the rate limiter ON PURPOSE.
//
// A throttled probe is a self-inflicted outage. Behind the limiter, a flood of
// user traffic — or, more likely, TRUST_PROXY left unset so that EVERY request
// shares one per-IP bucket — starts answering 429 to the load balancer too. It
// marks the instance unhealthy, takes it out of rotation, and does the same to
// the next one. A traffic spike becomes a fleet-wide outage, caused entirely by
// the defence against it.
//
// They stay below helmet and cors, which cost nothing and which the hardening
// tests assert on /health. What /ready adds beyond that is one `SELECT 1` —
// cheaper than the TLS handshake in front of it, and bounded by the pool
// timeout. An unlimited probe is the smaller risk by a wide margin.

// Rate limit (F-06): a generous per-IP backstop against request floods, not a
// tight throttle on normal use. Skipped under test so the suite is deterministic.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.RATE_LIMIT_MAX) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
  }),
);

// Capture the raw request bytes so the webhook middleware can verify the HMAC
// signature over exactly what Supabase signed (a re-serialized object would not
// byte-match).
// An EXPLICIT body ceiling. Express defaults to 100kb, which is fine — but a
// default is a thing nobody chose, and the one request in this API that can
// legitimately be large (a logo) does not come through here at all: multer
// handles it with its own 2 MB limit. Naming the number means a future endpoint
// that needs more has to say so.
app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT ?? '256kb',
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }),
);

// A body over the ceiling is the caller's to fix, and Express's default is an
// HTML error page from the generic handler. This says what happened.
app.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }
  next(err);
});

// Serialize Prisma Decimal fields as JSON numbers across every endpoint. This
// interceptor (rather than a prisma.$extends result extension) keeps the
// RLS-critical req.tx transaction client's type untouched — a $extends client
// entangles the interactive-transaction type used throughout the auth
// middleware.
app.use((_req: Request, res: Response, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(convertDecimals(body))) as typeof res.json;
  next();
});

// (Removed the /test-auth debug endpoint — analysis F-08. The authenticated
// routes below exercise the same RLS-bound path in production use.)

// POS & Checkout API. The router applies the auth middleware itself, so every
// handler runs inside an authenticated, RLS-bound transaction.
app.use('/api/pos', posRoutes);

// Inventory & Warehouse API. Same auth pattern — the router applies the JWT
// middleware, so every handler runs RLS-bound.
app.use('/api/inventory', inventoryRoutes);

// Recipes (Bill of Materials) API. Same auth pattern.
app.use('/api/recipes', recipeRoutes);

// Session/identity — the authenticated user's organization.
app.use('/api/me', userRoutes);

// Team roster and member management (invite / re-role / deactivate).
app.use('/api/members', memberRoutes);

// Catalog — menu item (sellable_items) management: create / rename / re-price.
app.use('/api/catalog', catalogRoutes);

// The menu approval cycle (0035). Its own noun because the queue is a different
// resource from the menu — readable by everyone, writable through a decision.
app.use('/api/menu-changes', menuChangeRoutes);

// Your own inbox (0036). Every role has one; nobody can write to anybody's.
app.use('/api/notifications', notificationRoutes);

// Which parts of the system this restaurant runs (0037). Readable by every
// member, writable only by an owner — and the write goes through a procedure,
// not through this router.
app.use('/api/modules', moduleRoutes);

// The rota and the time clock (0038). Gated by the labour module, which ships
// switched off — it is a new capability, not one anybody was already using.
app.use('/api/labour', labourRoutes);

// Tables and bookings (0039).
app.use('/api/reservations', reservationRoutes);

// The room (0045): every table with its running tab and its next booking, plus
// the tabs sitting at no table at all. One request, joined in the database —
// three lists fetched at three instants would show a table free because its
// tab arrived a moment later.
app.use('/api/floor', floorRoutes);

// The drawer (0047): open it, close it, and find out whether it balances.
app.use('/api/till', tillRoutes);

// The staff side of the shopfront (0040).
app.use('/api/public-orders', publicOrderRoutes);

// THE ONE UNAUTHENTICATED SURFACE. Mounted at /public rather than under /api,
// because it is a different kind of thing: no JWT, no RLS identity, and
// therefore nothing reachable but three SECURITY DEFINER functions. A router
// under /api would be one refactor away from inheriting auth that cannot apply
// to a customer who has no account.
app.use('/public', publicRoutes);

// Profitability reporting, from the cost captured at each sale. Restricted to
// FINANCE_ROLES inside the router — SELECT is ungated in the database.
app.use('/api/reports', reportRoutes);
app.use('/api/ratings', ratingRoutes);

// What the rating is a judgement OF (0033): the organization's own criteria,
// and a score against each. Its own noun rather than a branch of /api/ratings,
// because the rubric is readable by everyone and the ratings are not.
app.use('/api/rating-criteria', ratingCriteriaRoutes);

// Suppliers, and what they charge for each ingredient over time.
app.use('/api/suppliers', supplierRoutes);

// Purchase orders: what is on order, and what has actually been delivered.
app.use('/api/purchase-orders', purchaseOrderRoutes);

// Where a ticket physically prints. The gateway only holds the address — the
// printer is on the restaurant's LAN and the till is what opens the socket.
app.use('/api/printers', printerRoutes);

// Appearance (0032). Mounted at their own nouns, NOT at '/api': a router
// mounted there receives every /api/* request and its authMiddleware runs for
// all of them, which breaks the webhook route that authenticates by HMAC.
app.use('/api/preferences', preferencesRouter);
app.use('/api/branding', brandingRouter);

// One search box over everything the caller can already see. Read-only, and
// scoped entirely by RLS rather than by a WHERE clause of its own.
app.use('/api/search', searchRoutes);

// The same reports as files. Mounted separately from /api/reports so the JSON
// routes keep answering JSON — an Accept-header switch on the existing routes
// would make every one of them able to return a binary by accident.
app.use('/api/exports', exportRoutes);

// Supabase identity webhooks. Guarded by HMAC signature (webhookAuth), NOT the
// JWT middleware — Supabase calls these, not a logged-in user.
app.use('/api/webhooks', webhookRoutes);

/**
 * Centralized error handler.
 *
 * It used to be `console.error(err)` and a generic 500 — a stack trace with no
 * path, no user and nothing connecting it to the person who hit it. A cashier
 * reporting "it failed around 8:40" could not be matched to a line, and there
 * was no way to tell whether their failure was even in the file.
 *
 * Now the line carries the request context, and the RESPONSE carries the same
 * id. That is the part that changes a support conversation: the person who saw
 * the error can read the reference off their screen, and it leads to exactly
 * one line in the log.
 *
 * The message itself stays generic on purpose — an internal error can quote a
 * constraint name, a column, or part of a query, and none of that belongs in a
 * response to a till.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error('unhandled error', err, {
    request_id: req.requestId,
    method: req.method,
    path: req.requestPath,
    user_id: req.userId,
  });

  res.status(500).json({
    error: 'Internal server error',
    request_id: req.requestId,
  });
}

app.use(errorHandler);
