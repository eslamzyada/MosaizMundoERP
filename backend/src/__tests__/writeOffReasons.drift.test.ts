import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  REASON_REQUIRING_NOTE,
  WASTE_REASONS,
  WRITE_OFF_NOTE_MAX_LENGTH,
  WRITE_OFF_REASONS,
} from '../lib/writeOffReasons';

/**
 * The API's write-off vocabulary must match the database's, exactly — the same
 * guard voidReasons.drift.test.ts provides, for the same failure: a reason the
 * form offers, this API accepts, and Postgres then refuses, surfacing in front
 * of someone standing over a bin.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('ADMIN_DATABASE_URL must be set to run the write-off drift test');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

async function constraintDef(name: string): Promise<string> {
  const rows = await admin.$queryRaw<Array<{ def: string }>>`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.stock_write_offs'::regclass AND conname = ${name}`;
  expect(rows).toHaveLength(1);
  return rows[0].def;
}

afterAll(async () => {
  await admin.$disconnect();
});

describe('write-off reasons stay in step with the database', () => {
  test('the vocabulary is exactly the one the CHECK allows', async () => {
    const def = await constraintDef('stock_write_offs_reason_check');
    const inDatabase = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    // Sorted lists, not "every API value is allowed": a reason added in SQL and
    // never offered by the UI fails too, because a cause nobody can pick
    // collects no data and quietly makes the waste report a lie.
    expect(inDatabase).toEqual([...WRITE_OFF_REASONS].sort());
  });

  test("the note requirement points at the reason both sides call 'other'", async () => {
    const def = await constraintDef('stock_write_offs_note_required_for_other');
    expect(def).toContain(`'${REASON_REQUIRING_NOTE}'`);
  });

  test('the note length limit is the same number in both places', async () => {
    const def = await constraintDef('stock_write_offs_note_wellformed');
    const match = def.match(/char_length\(note\) <= (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(WRITE_OFF_NOTE_MAX_LENGTH);
  });

  test('the quantities are forced to balance by the database, not by us', async () => {
    // The report adds written-off and short across rows; that only means
    // anything if no row can hold a set of figures that disagree.
    const def = await constraintDef('stock_write_offs_quantities_balance');
    expect(def).toContain('quantity_requested');
    expect(def).toContain('quantity_written_off');
    expect(def).toContain('quantity_short');
  });

  test('every waste reason is a real reason, and staff_meal is not one of them', () => {
    for (const r of WASTE_REASONS) {
      expect(WRITE_OFF_REASONS).toContain(r);
    }
    // A staff meal costs the same as a spoiled one but is not a problem to fix.
    // Folding it into a waste headline would make a kitchen look worse the
    // better it feeds its people.
    expect(WASTE_REASONS).not.toContain('staff_meal');
    expect(WASTE_REASONS).not.toContain('other');
  });
});
