#!/usr/bin/env node
/**
 * Give the demo restaurant something to show.
 *
 * WHY THIS EXISTS.
 *
 * Signed in as each of the five roles, every panel read as an unfinished
 * product. Measured, the reason was not the panels:
 *
 *     sellable_items      6
 *     orders (all time)   5
 *     orders TODAY        0
 *     restaurant_tables   0
 *     suppliers           0
 *     shifts              0
 *     reservations        0
 *
 * A dashboard reading 0.00, an empty room, an empty pass, and a reports page
 * that hides every panel are all CORRECT renderings of a restaurant that has
 * never traded. A control panel cannot be judged against no data.
 *
 * So this seeds a fortnight of plausible trading: a room with tables, orders
 * spread across days and mealtimes, open tabs with food already fired, staff on
 * a rota, bookings. Every panel then has something TRUE to display.
 *
 * ----------------------------------------------------------------------------
 * IT IS TAGGED, AND IT COMES OUT AGAIN.
 *
 * Every row carries a marker and `--undo` removes exactly those. Demo data that
 * cannot be swept out is indistinguishable from real data six months later,
 * which is how a test order ends up in somebody's year-end figures.
 *
 * USAGE
 *   node scripts/seed-demo-restaurant.mjs
 *   node scripts/seed-demo-restaurant.mjs --undo
 *   node scripts/seed-demo-restaurant.mjs --days 30
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};
const UNDO = argv.includes('--undo');
const ORG = arg('org', '123e4567-e89b-12d3-a456-426614174000');
const DAYS = Number(arg('days', '14'));

/** Written into every row this script creates; the handle `--undo` uses. */
const TAG = '[demo]';

function findPsql() {
  if (process.env.PSQL) return process.env.PSQL;
  const candidates = ['psql'];
  for (const root of ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL']) {
    try {
      for (const d of readdirSync(root).sort((a, b) => Number(b) - Number(a))) {
        candidates.push(root + '/' + d + '/bin/psql.exe');
      }
    } catch {
      /* no PostgreSQL under this root */
    }
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try the next */
    }
  }
  return 'psql';
}

function adminUrl() {
  if (process.env.ADMIN_DATABASE_URL) return process.env.ADMIN_DATABASE_URL;
  const mcp = readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8');
  const found = JSON.stringify(JSON.parse(mcp)).match(/postgresql:\/\/postgres:[^"]*/);
  if (!found) {
    console.error('No owner connection. Set ADMIN_DATABASE_URL, or keep .mcp.json in place.');
    process.exit(78);
  }
  return found[0];
}

const PSQL = findPsql();

// The connection lives in the ENVIRONMENT, never in argv: an argument puts the
// password in the process list, and node prints argv in any spawn error.
const u = new URL(adminUrl());
const pgEnv = {
  PGHOST: u.hostname,
  PGPORT: u.port || '5432',
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: u.pathname.replace(/^\//, ''),
  PGCLIENTENCODING: 'UTF8',
};

/**
 * Statements go through a FILE, not through -c.
 *
 * Windows caps a command line at about 32 KB, and a batch insert of two hundred
 * orders is far past it — psql never runs and node reports ENAMETOOLONG, which
 * says nothing about SQL. -f has no such limit and is what psql is built for.
 */
function sql(text) {
  const file = join(tmpdir(), 'mosaiz-seed-' + randomUUID() + '.sql');
  writeFileSync(file, text, 'utf8');
  try {
    return execFileSync(PSQL, ['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', file], {
      encoding: 'utf8',
      env: { ...process.env, ...pgEnv },
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}

const q = (s) => "'" + String(s).split("'").join("''") + "'";
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

if (UNDO) {
  const removed = sql(
    'WITH gone_items AS (' +
      '  DELETE FROM public.order_items WHERE order_id IN (' +
      '    SELECT id FROM public.orders WHERE organization_id = ' + q(ORG) +
      "      AND note LIKE " + q(TAG + '%') + ') RETURNING 1),' +
      ' gone_orders AS (DELETE FROM public.orders WHERE organization_id = ' + q(ORG) +
      "   AND note LIKE " + q(TAG + '%') + ' RETURNING 1),' +
      ' gone_res AS (DELETE FROM public.reservations WHERE organization_id = ' + q(ORG) +
      "   AND note LIKE " + q(TAG + '%') + ' RETURNING 1),' +
      ' gone_shifts AS (DELETE FROM public.shifts WHERE organization_id = ' + q(ORG) +
      "   AND note LIKE " + q(TAG + '%') + ' RETURNING 1),' +
      ' gone_tables AS (DELETE FROM public.restaurant_tables WHERE organization_id = ' + q(ORG) +
      "   AND area LIKE " + q(TAG + '%') + ' RETURNING 1)' +
      " SELECT (SELECT count(*) FROM gone_orders) || ' orders, ' ||" +
      "        (SELECT count(*) FROM gone_res) || ' reservations, ' ||" +
      "        (SELECT count(*) FROM gone_shifts) || ' shifts, ' ||" +
      "        (SELECT count(*) FROM gone_tables) || ' tables'",
  );
  console.log('\n  removed: ' + removed + '\n');
  process.exit(0);
}

const orgName = sql('SELECT name FROM public.organizations WHERE id = ' + q(ORG));
if (!orgName) {
  console.error('No organization with id ' + ORG + '.');
  process.exit(1);
}
console.log('\n  ' + orgName + '  —  seeding ' + DAYS + ' days of trading\n');

const items = sql(
  'SELECT id || \'|\' || price FROM public.sellable_items WHERE organization_id = ' +
    q(ORG) + ' AND is_active ORDER BY price',
)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const parts = l.split('|');
    return { id: parts[0], price: Number(parts[1]) };
  });

if (items.length === 0) {
  console.error('This restaurant has no active menu items; seed those first.');
  process.exit(1);
}

const staff = sql(
  'SELECT user_id FROM public.organization_memberships WHERE organization_id = ' +
    q(ORG) + ' AND is_active ORDER BY user_id',
)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

// --- the room -------------------------------------------------------------
// `area` carries the tag, so --undo finds these without touching a real table.
const AREAS = [
  { name: 'الصالة الداخلية', count: 8, seats: 4 },
  { name: 'التراس', count: 4, seats: 2 },
];
const tableValues = [];
for (const a of AREAS) {
  for (let i = 1; i <= a.count; i += 1) {
    tableValues.push(
      '(' + q(ORG) + ', ' + q(a.name + ' ' + i) + ', ' + q(TAG + ' ' + a.name) +
        ', ' + a.seats + ', true)',
    );
  }
}
sql(
  'INSERT INTO public.restaurant_tables (organization_id, label, area, seats, is_active) VALUES ' +
    tableValues.join(',') + ' ON CONFLICT DO NOTHING',
);
const tables = sql(
  'SELECT id FROM public.restaurant_tables WHERE organization_id = ' + q(ORG) +
    ' AND area LIKE ' + q(TAG + '%') + ' ORDER BY label',
)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
console.log('  ' + tables.length + ' tables');

/**
 * A service, rather than a uniform sprinkle.
 *
 * Orders cluster at lunch and dinner because restaurants do. A flat
 * distribution makes every trend line straight, and a straight line is exactly
 * what makes a dashboard look invented.
 */
function hoursForDay() {
  const out = [];
  const lunch = 6 + Math.floor(Math.random() * 6);
  const dinner = 10 + Math.floor(Math.random() * 10);
  for (let i = 0; i < lunch; i += 1) out.push(12 + Math.random() * 3);
  for (let i = 0; i < dinner; i += 1) out.push(18 + Math.random() * 4.5);
  return out.sort((a, b) => a - b);
}

const orderRows = [];
const itemRows = [];
let orderCount = 0;

for (let d = DAYS - 1; d >= 0; d -= 1) {
  for (const hour of hoursForDay()) {
    const id = randomUUID();
    const when =
      'now() - make_interval(days => ' + d + ') - make_interval(mins => ' +
      Math.round((24 - hour) * 60) + ')';
    const lines = 1 + Math.floor(Math.random() * 3);
    let total = 0;
    const chosen = [];
    for (let l = 0; l < lines; l += 1) {
      const item = pick(items);
      const qty = 1 + Math.floor(Math.random() * 2);
      total += item.price * qty;
      chosen.push({ item, qty });
    }
    // A void now and then, so the voids panel and the "a void is not revenue"
    // rule both have something real to be right about.
    const voided = Math.random() < 0.04;
    orderRows.push(
      '(' + q(id) + ', ' + q(ORG) + ', ' + q(randomUUID()) + ', ' +
        (voided ? q('voided') : q('completed')) + ', ' + total.toFixed(2) + ', ' + when + ', ' +
        (voided ? when : 'NULL') + ', ' + (voided ? q('wrong_item') : 'NULL') + ', ' +
        (voided ? 'true' : 'NULL') + ', ' + (staff.length ? q(pick(staff)) : 'NULL') + ', ' +
        q(TAG + ' خدمة') + ', ' + (tables.length ? q(pick(tables)) : 'NULL') + ')',
    );
    for (const c of chosen) {
      itemRows.push(
        '(' + q(id) + ', ' + q(ORG) + ', ' + q(c.item.id) + ', ' + c.qty + ', ' +
          c.item.price.toFixed(2) + ', ' + (c.item.price * 0.38).toFixed(2) + ', true, ' +
          when + ')',
      );
    }
    orderCount += 1;
  }
}

// Chunked: one statement with thousands of tuples is a good way to meet a limit
// that has nothing to do with the data.
for (let i = 0; i < orderRows.length; i += 200) {
  sql(
    'INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount,' +
      ' created_at, voided_at, void_reason, stock_restored, served_by, note, table_id) VALUES ' +
      orderRows.slice(i, i + 200).join(','),
  );
}
for (let i = 0; i < itemRows.length; i += 200) {
  sql(
    'INSERT INTO public.order_items (order_id, organization_id, sellable_item_id, quantity,' +
      ' unit_price, cost_at_sale, cost_is_complete, fired_at) VALUES ' +
      itemRows.slice(i, i + 200).join(','),
  );
}
console.log('  ' + orderCount + ' orders across ' + DAYS + ' days, including today');

// --- the room right now ---------------------------------------------------
// Open tabs with food already fired, so the floor shows occupied tables and the
// pass shows tickets with a clock already running on them.
if (tables.length > 0) {
  const openRows = [];
  const openItems = [];
  for (let i = 0; i < Math.min(4, tables.length); i += 1) {
    const id = randomUUID();
    const item = pick(items);
    const firedAgo = 3 + i * 7;
    openRows.push(
      '(' + q(id) + ', ' + q(ORG) + ', ' + q(randomUUID()) + ", 'open', " +
        item.price.toFixed(2) + ', now() - make_interval(mins => ' + (firedAgo + 5) + '), ' +
        (staff.length ? q(pick(staff)) : 'NULL') + ', ' + q(TAG + ' طاولة مفتوحة') + ', ' +
        q(tables[i]) + ')',
    );
    openItems.push(
      '(' + q(id) + ', ' + q(ORG) + ', ' + q(item.id) + ', 1, ' + item.price.toFixed(2) +
        ', now() - make_interval(mins => ' + firedAgo + '))',
    );
  }
  sql(
    'INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount,' +
      ' created_at, served_by, note, table_id) VALUES ' + openRows.join(','),
  );
  sql(
    'INSERT INTO public.order_items (order_id, organization_id, sellable_item_id, quantity,' +
      ' unit_price, fired_at) VALUES ' + openItems.join(','),
  );
  console.log('  ' + openRows.length + ' open tabs, with food already fired');
}

// --- the rota -------------------------------------------------------------
if (staff.length > 0) {
  const shiftRows = [];
  for (let d = -1; d <= 5; d += 1) {
    for (const user of staff.slice(0, 4)) {
      shiftRows.push(
        '(' + q(ORG) + ', ' + q(user) +
          ", date_trunc('day', now()) + make_interval(days => " + d + ', hours => 11)' +
          ", date_trunc('day', now()) + make_interval(days => " + d + ', hours => 23), ' +
          q(TAG + ' وردية') + ')',
      );
    }
  }
  sql(
    'INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at, note) VALUES ' +
      shiftRows.join(','),
  );
  console.log('  ' + shiftRows.length + ' shifts on the rota');
}

// --- the book -------------------------------------------------------------
if (tables.length > 0) {
  const names = ['أ. محمود', 'م. سارة', 'أ. كريم', 'د. هالة', 'أ. ياسر'];
  const resRows = names.map((n, i) =>
    '(' + q(ORG) + ', ' + q(tables[(i + 4) % tables.length]) + ', ' + q(n) + ", '0100000000', " +
      (2 + (i % 4)) +
      ", date_trunc('day', now()) + make_interval(days => " + (i % 2) + ', hours => ' + (19 + (i % 3)) + ')' +
      ", date_trunc('day', now()) + make_interval(days => " + (i % 2) + ', hours => ' + (21 + (i % 3)) + ')' +
      ", 'booked', " + q(TAG + ' حجز') + ')',
  );
  sql(
    'INSERT INTO public.reservations (organization_id, table_id, guest_name, guest_phone,' +
      ' party_size, starts_at, ends_at, status, note) VALUES ' + resRows.join(','),
  );
  console.log('  ' + resRows.length + ' bookings');
}

console.log(
  '\n  Done. Every row carries ' + TAG + ' and comes out again with:\n\n' +
    '      node scripts/seed-demo-restaurant.mjs --undo\n',
);
