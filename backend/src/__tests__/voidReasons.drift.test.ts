import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  REASON_REQUIRING_NOTE,
  VOID_NOTE_MAX_LENGTH,
  VOID_REASONS,
} from '../lib/voidReasons';

/**
 * The API's void vocabulary must match the database's, exactly.
 *
 * This is a drift guard in the spirit of the Prisma schema check: the list in
 * lib/voidReasons.ts is a copy of a CHECK constraint, and copies rot. The
 * failure it prevents is specific and ugly — a reason the form offers, this
 * API accepts, and Postgres then refuses, surfacing at the till as an
 * unexplained error on a correction someone is standing there waiting to make.
 *
 * Reading the constraint back is the only way to know, because nothing else
 * connects the two: a migration can add a reason without touching TypeScript,
 * and TypeScript can add one without a migration. Either direction fails here.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('ADMIN_DATABASE_URL must be set to run the void reason drift test');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

async function constraintDef(name: string): Promise<string> {
  const rows = await admin.$queryRaw<Array<{ def: string }>>`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass AND conname = ${name}`;
  expect(rows).toHaveLength(1);
  return rows[0].def;
}

afterAll(async () => {
  await admin.$disconnect();
});

describe('void reasons stay in step with the database', () => {
  test('the vocabulary is exactly the one the CHECK allows', async () => {
    const def = await constraintDef('orders_void_reason_check');

    // e.g. CHECK (((void_reason IS NULL) OR (void_reason = ANY (ARRAY['wrong_item'::text, ...]))))
    const inDatabase = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    const inApi = [...VOID_REASONS].sort();

    // Compared as sorted lists rather than "every API value is allowed", so a
    // reason added in SQL and never offered by the UI fails too — a category
    // nobody can choose collects no data and quietly makes the report a lie.
    expect(inDatabase).toEqual(inApi);
  });

  test("the note requirement points at the same reason both sides call 'other'", async () => {
    const def = await constraintDef('orders_void_note_required_for_other');
    expect(def).toContain(`'${REASON_REQUIRING_NOTE}'`);
  });

  test('the note length limit is the same number in both places', async () => {
    const def = await constraintDef('orders_void_note_wellformed');
    const match = def.match(/char_length\(void_note\) <= (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(VOID_NOTE_MAX_LENGTH);
  });

  test('a voided order cannot exist without a reason', async () => {
    // The guarantee the report depends on: "voids by reason" can only add up to
    // the void total if every voided order has one.
    const def = await constraintDef('orders_void_reason_matches_status');
    expect(def).toContain('void_reason IS NOT NULL');
    expect(def).toContain(`'voided'`);
  });
});
