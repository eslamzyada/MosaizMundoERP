import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Prisma } from '@prisma/client';
import posRoutes from './routes/pos.routes';
import inventoryRoutes from './routes/inventory.routes';
import recipeRoutes from './routes/recipe.routes';
import userRoutes from './routes/user.routes';
import memberRoutes from './routes/member.routes';
import catalogRoutes from './routes/catalog.routes';
import reportRoutes from './routes/report.routes';
import supplierRoutes from './routes/supplier.routes';
import purchaseOrderRoutes from './routes/purchaseOrder.routes';
import webhookRoutes from './routes/webhook.routes';

// Recursively convert Prisma Decimal values to plain JS numbers. Prisma
// serializes Decimal as a string by default; the API contract is standard JSON
// numbers. Dates are left intact (res.json renders them as ISO strings).
function convertDecimals(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(convertDecimals);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = convertDecimals(v);
    }
    return out;
  }
  return value;
}

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
app.use(
  cors({
    origin(origin, cb) {
      cb(null, !origin || allowedOrigins.includes(origin));
    },
  }),
);

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
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }),
);

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

// Liveness check — no auth, no database.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'mosaiz-mundo-api' });
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

// Profitability reporting, from the cost captured at each sale. Restricted to
// FINANCE_ROLES inside the router — SELECT is ungated in the database.
app.use('/api/reports', reportRoutes);

// Suppliers, and what they charge for each ingredient over time.
app.use('/api/suppliers', supplierRoutes);

// Purchase orders: what is on order, and what has actually been delivered.
app.use('/api/purchase-orders', purchaseOrderRoutes);

// Supabase identity webhooks. Guarded by HMAC signature (webhookAuth), NOT the
// JWT middleware — Supabase calls these, not a logged-in user.
app.use('/api/webhooks', webhookRoutes);

// Centralized error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
