import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import posRoutes from './routes/pos.routes';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// Liveness check — no auth, no database.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'mosaiz-mundo-api' });
});

// Proves the RLS-honoring middleware end to end: the query runs on req.tx,
// inside the transaction that bound app.current_user_id, so RLS returns only
// the caller's own users row (or nothing, if the header maps to no visible user).
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

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`mosaiz-mundo-api listening on port ${port}`);
});

// Graceful shutdown so the DB pool closes cleanly.
async function shutdown(): Promise<void> {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
