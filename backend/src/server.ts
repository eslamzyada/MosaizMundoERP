import 'dotenv/config';
import { app } from './app';
import { prisma } from './prisma';

const port = Number(process.env.PORT) || 3000;

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
