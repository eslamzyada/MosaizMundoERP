import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import posRoutes from './routes/pos.routes';

// The configured Express app, separated from the listener in server.ts so that
// tests (supertest) can drive it without binding a port.
export const app = express();

app.use(cors());
app.use(express.json());

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

// Centralized error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
