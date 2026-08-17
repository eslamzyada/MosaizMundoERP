#!/usr/bin/env node
/**
 * Does the plan matrix in the docs still describe the database?
 *
 * WHY THIS EXISTS.
 *
 * docs/tenant_modules_and_plans.md carries a Good/Better/Best table saying
 * which plan each module is included from. It is the closest thing this
 * project has to a price list, and it is what somebody reads before answering
 * "does that customer's tier include reservations?".
 *
 * It went stale without anybody noticing. `labour`, `reservations` and
 * `public_ordering` shipped, were given real `min_plan` values by 0044, and
 * never appeared in the table — while a section further up still described all
 * three as **Absent**. A document that reads as authoritative and is wrong is
 * worse than no document: nobody double-checks a table.
 *
 * The same argument as the environment-variable manifest in backend/config.ts,
 * and the same fix: make the drift fail a build rather than wait to be noticed.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT.
 *
 * Compared: the set of module keys, and the tier each is included FROM. That is
 * the entitlement question the ceiling in app.plan_includes actually answers.
 *
 * Not compared: `default_enabled`. Whether a module starts switched on is a
 * provisioning choice, not a packaging one — a tenant may switch a module off
 * at any tier — and the table does not claim to describe it.
 *
 * Usage:  node scripts/plan-matrix-check.mjs
 *
 * Reads the database through `psql`, which every other step in Database CI
 * already uses, rather than a driver. `pg` is not a dependency of this
 * repository — Prisma bundles its own engine — and adding one so that a
 * documentation check can run would be a poor trade.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DOC = 'docs/tenant_modules_and_plans.md';
const TIERS = ['basic', 'standard', 'premium', 'enterprise'];

/**
 * Pulls the matrix out of the markdown.
 *
 * A row is `| \`key\` | ● | ● | — | ● |`, and the tier a module is included
 * FROM is the first column carrying a filled dot. The "POS, orders, menu
 * (core)" row is skipped on purpose: core is never switchable and has no row in
 * `modules` to compare against.
 */
function parseDoc(markdown) {
  const start = markdown.indexOf('| Module | basic | standard | premium | enterprise |');
  if (start === -1) {
    throw new Error(`could not find the plan matrix header in ${DOC}`);
  }

  const matrix = new Map();
  for (const line of markdown.slice(start).split('\n')) {
    if (!line.startsWith('|')) break;                    // end of the table
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length !== 5) continue;                    // header or separator
    const key = cells[0].replace(/`/g, '');
    if (!/^[a-z_]+$/.test(key)) continue;                // "Module", "POS, orders, menu (core)"

    const included = cells.slice(1).map((c) => c === '●');
    const from = included.indexOf(true);
    if (from === -1) {
      throw new Error(`${DOC}: module \`${key}\` is included in no tier at all`);
    }
    // A row must be a CEILING: once included, included at every higher tier.
    // `● — ●` is not a packaging model, it is a typo.
    for (let i = from; i < included.length; i += 1) {
      if (!included[i]) {
        throw new Error(
          `${DOC}: \`${key}\` is included at ${TIERS[from]} but not at ${TIERS[i]}; ` +
            'entitlement is a ceiling, so a module included at one tier is included at every higher one',
        );
      }
    }
    matrix.set(key, TIERS[from]);
  }
  return matrix;
}

function readDatabase() {
  // -t no header, -A unaligned, -F the separator. PGUSER/PGPASSWORD/PGHOST are
  // read from the environment exactly as they are by the psql steps around it.
  const psql = process.env.PSQL ?? 'psql';
  const args = ['-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1',
                '-c', 'SELECT key, min_plan FROM public.modules ORDER BY key'];
  if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);

  // No try/catch: if psql cannot run or the query fails, this must NOT report
  // a clean matrix. A check that passes when it could not run is worse than
  // no check.
  const out = execFileSync(psql, args, { encoding: 'utf8' });

  return new Map(
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [key, tier] = l.split('|');
        return [key, tier];
      }),
  );
}

const doc = parseDoc(readFileSync(DOC, 'utf8'));
const db = readDatabase();

// A parse that finds nothing would make every comparison below vacuous, and
// this script would pass loudly against an empty table.
if (doc.size === 0) throw new Error(`${DOC}: parsed zero modules out of the matrix`);
if (db.size === 0) throw new Error('the modules table is empty; nothing to compare against');

const problems = [];

for (const [key, tier] of db) {
  if (!doc.has(key)) {
    problems.push(
      `\`${key}\` exists in the database (min_plan=${tier}) and is missing from the matrix. ` +
        'Somebody adding a module has not said what it costs.',
    );
  } else if (doc.get(key) !== tier) {
    problems.push(
      `\`${key}\`: the matrix says it is included from ${doc.get(key)}, the database gates it at ${tier}.`,
    );
  }
}

for (const key of doc.keys()) {
  if (!db.has(key)) {
    problems.push(
      `\`${key}\` is in the matrix and does not exist in the database. ` +
        'Either the module was removed, or the table describes something that was never built.',
    );
  }
}

if (problems.length > 0) {
  console.error(`\n${DOC} disagrees with the modules table:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nThis table is what somebody reads to answer "does that tier include it?".\n' +
      'Fix whichever is wrong — the matrix, or the migration that set min_plan.\n',
  );
  process.exit(1);
}

console.log(`plan matrix matches the database (${db.size} modules).`);
