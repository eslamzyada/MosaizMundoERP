import { Prisma } from '@prisma/client';

/**
 * Recursively convert Prisma Decimal values to plain JS numbers.
 *
 * Prisma serializes Decimal as a string by default; the API contract is
 * standard JSON numbers. Dates are left intact (res.json renders them as ISO
 * strings).
 *
 * Lives here rather than in app.ts because the exports need it too: they read a
 * report through the same handler the HTTP API uses, and without this a money
 * column would reach a spreadsheet as a Decimal object rather than a number.
 */
export function convertDecimals(value: unknown): unknown {
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
