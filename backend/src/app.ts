import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { Prisma } from '@prisma/client';
import { authMiddleware } from './middleware/auth';
import posRoutes from './routes/pos.routes';
import inventoryRoutes from './routes/inventory.routes';
import recipeRoutes from './routes/recipe.routes';
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

app.use(cors());
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

// Proves the RLS-honoring middleware end to end: the query runs on req.tx,
// inside the transaction that bound app.current_user_id, so RLS returns only
// the caller's own users row (or nothing, if the token maps to no visible user).
app.get(
  '/test-auth',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await req.tx!.users.findUnique({
        where: { id: req.userId! },
      });

      if (!user) {
        res.status(404).json({ error: 'No user visible for this identity' });
        return;
      }

      res.json({ authenticatedUser: user });
    } catch (err) {
      next(err);
    }
  },
);

// POS & Checkout API. The router applies the auth middleware itself, so every
// handler runs inside an authenticated, RLS-bound transaction.
app.use('/api/pos', posRoutes);

// Inventory & Warehouse API. Same auth pattern — the router applies the JWT
// middleware, so every handler runs RLS-bound.
app.use('/api/inventory', inventoryRoutes);

// Recipes (Bill of Materials) API. Same auth pattern.
app.use('/api/recipes', recipeRoutes);

// Supabase identity webhooks. Guarded by HMAC signature (webhookAuth), NOT the
// JWT middleware — Supabase calls these, not a logged-in user.
app.use('/api/webhooks', webhookRoutes);

// Centralized error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
