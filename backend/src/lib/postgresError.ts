import { Prisma } from '@prisma/client';

/**
 * The SQLSTATE behind a Prisma error, however Prisma chose to wrap it.
 *
 * Three shapes, and only checking the first is how a policy refusal becomes a
 * 500: a typed call that violates a constraint raises a KNOWN error carrying
 * `meta.code`; some raise the Prisma code itself; and a RESTRICTIVE policy
 * refusing an INSERT comes back as an UNKNOWN error whose SQLSTATE exists only
 * inside the message text. Measured, not guessed — the waiter refusal in the
 * menu-change suite arrived as the third.
 *
 * Lifted out of menuChange.controller.ts when 0037 needed the same mapping: two
 * copies of a function this subtle would eventually disagree about what a
 * refusal means.
 */
export function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  if (err instanceof Error) {
    const match = err.message.match(/code:\s*"(\w+)"/);
    if (match) return match[1];
  }
  return undefined;
}
