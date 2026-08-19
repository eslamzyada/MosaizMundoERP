#!/usr/bin/env node
/**
 * Create one signed-in-able account per role, in an existing organization.
 *
 * WHY THIS IS A SCRIPT AND NOT SOMETHING I RAN FOR YOU.
 *
 * The application-side half — the `users` row and the membership that carries
 * the role — is ordinary data in your own database. The other half is an
 * identity in Supabase with a PASSWORD, and creating accounts or handling
 * passwords is the one thing I do not do on your behalf, whoever asks. So this
 * is the tool; you run it, and the passwords are yours and never mine.
 *
 * It is idempotent: run it twice and it repairs rather than duplicates. An
 * existing auth identity is reused, the membership is updated to the role named
 * here, and nothing is deleted.
 *
 * USAGE (from the repository root):
 *
 *   node scripts/create-test-users.mjs --password 'ChooseSomething!23'
 *
 * or, to give each account its own password:
 *
 *   node scripts/create-test-users.mjs --prompt
 *
 * Options:
 *   --org <uuid>     which organization (default: the one below)
 *   --prefix <text>  email prefix, so a second run makes a second set
 *   --dry-run        say what it would do and change nothing
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const ORG = arg('org', '123e4567-e89b-12d3-a456-426614174000');
const PREFIX = arg('prefix', 'test');
const DRY = flag('dry-run');
const PROMPT = flag('prompt');
const PASSWORD = arg('password');

/**
 * The four panels worth looking at, and the role each one is driven by.
 *
 * `manager` is branch_manager rather than regional_manager: it is the role a
 * single restaurant actually uses, and the one whose sidebar differs most from
 * an owner's. Change it here if you want the regional view instead.
 */
const ACCOUNTS = [
  { key: 'cashier', role: 'cashier', note: 'the till, and the floor' },
  { key: 'manager', role: 'branch_manager', note: 'rota, approvals, reports' },
  { key: 'kitchen', role: 'kitchen', note: 'the kitchen queue' },
  { key: 'accounts', role: 'accountant', note: 'ledger, purchasing, exports' },
];

// ------------------------------------------------------------------ config
function env() {
  const raw = readFileSync(new URL('../backend/.env', import.meta.url), 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const cfg = env();
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!cfg[key]) {
    console.error(`backend/.env is missing ${key}; cannot continue.`);
    process.exit(78);
  }
}

// The DB writes go through psql as the OWNER, because `users` is
// identity-adjacent and deliberately has no INSERT policy — the application
// role cannot write it, by design. Point PSQL at your psql if it is not on PATH.
/**
 * Find psql, rather than demanding the caller export a path to it.
 *
 * On Windows the PostgreSQL installer does not put psql on PATH, so the honest
 * default fails on the machine this is most likely to be run on — and the
 * remedy I first gave was `PSQL=... node ...`, which is bash syntax that
 * PowerShell rejects outright. Two different papercuts for one missing lookup.
 */
function findPsql() {
  if (process.env.PSQL) return process.env.PSQL;

  const candidates = ['psql'];
  for (const root of ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL']) {
    try {
      // Newest major version first: a machine with 15 and 18 installed should
      // use 18, which is what this project runs.
      for (const dir of readdirSync(root).sort((a, b) => Number(b) - Number(a))) {
        candidates.push(`${root}/${dir}/bin/psql.exe`);
      }
    } catch {
      // no PostgreSQL under this root
    }
  }

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return 'psql'; // let the caller see the ENOENT message below
}

const PSQL = findPsql();

/**
 * The OWNER connection, not DATABASE_URL.
 *
 * DATABASE_URL is mosaiz_app_user, which is RLS-constrained: with no identity
 * bound it can see no organizations at all, so the first thing this script does
 * would report that your organization does not exist. That is tenant isolation
 * working, and it is why this needs the owner.
 *
 * Taken from ADMIN_DATABASE_URL if you set it, otherwise from .mcp.json, which
 * is gitignored and already holds it.
 */
function adminUrl() {
  if (process.env.ADMIN_DATABASE_URL) return process.env.ADMIN_DATABASE_URL;
  try {
    const mcp = readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8');
    const found = JSON.stringify(JSON.parse(mcp)).match(/postgresql:\/\/postgres:[^"]*/);
    if (found) return found[0];
  } catch {
    // fall through to the message below
  }
  console.error(
    'No owner database connection. Set ADMIN_DATABASE_URL, or keep .mcp.json in place. ' +
      'DATABASE_URL cannot be used: it is the RLS-constrained application role.',
  );
  process.exit(78);
}

const ADMIN_URL = adminUrl();

/**
 * The connection, as environment rather than as an argument.
 *
 * Passing the URL on the command line puts the database PASSWORD into argv,
 * where it is visible in the process list to anyone else on the machine — and,
 * worse, node prints spawnargs when a spawn fails, so a missing psql dumps
 *
 *     postgresql://postgres:<the real password>@localhost:5433/mosaiz_mundo
 *
 * straight to the terminal. That happened while testing this script. PG*
 * variables are what psql reads anyway, and they stay out of both.
 */
const pgEnv = (() => {
  const u = new URL(ADMIN_URL);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
  };
})();

const sql = (text) => {
  try {
    return execFileSync(PSQL, ['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', text], {
      encoding: 'utf8',
      env: { ...process.env, ...pgEnv },
    }).trim();
  } catch (err) {
    // The likeliest reason a run dies before creating anything: psql is not on
    // PATH on this machine, and the failure otherwise arrives as a bare ENOENT
    // stack trace that says nothing about what to do next.
    if (err.code === 'ENOENT') {
      console.error(
        `\n  Cannot run '${PSQL}' — psql is not on PATH here. Re-run with, for example:\n\n` +
          '    PSQL="C:/Program Files/PostgreSQL/18/bin/psql.exe" \\\n' +
          '      node scripts/create-test-users.mjs --password \'…\'\n',
      );
      process.exit(78);
    }
    throw err;
  }
};

// ------------------------------------------------------------------- main
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const orgName = sql(`SELECT name FROM public.organizations WHERE id = '${ORG}'`);
if (!orgName) {
  console.error(`No organization with id ${ORG}.`);
  process.exit(1);
}
console.log(`\nOrganization: ${orgName}  (${ORG})\n`);

let password = PASSWORD;
if (!DRY && !password && !PROMPT) {
  console.error('Give --password, or --prompt to be asked for each. Never committed, never logged.');
  process.exit(2);
}

const rl = PROMPT ? createInterface({ input: stdin, output: stdout }) : null;

for (const account of ACCOUNTS) {
  const email = `${PREFIX}.${account.key}@mosaizmundo.com`;

  if (DRY) {
    console.log(`  would create ${email.padEnd(38)} role=${account.role}`);
    continue;
  }

  const pw = PROMPT ? await rl.question(`password for ${email}: `) : password;

  // 1. The identity. Reused if it already exists, so a re-run repairs.
  let userId;
  const created = await supabase.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
  });

  if (created.error) {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const existing = data.users.find((u) => u.email === email);
    if (!existing) throw created.error;
    userId = existing.id;
    console.log(`  ${email.padEnd(38)} identity already existed`);
  } else {
    userId = created.data.user.id;
    console.log(`  ${email.padEnd(38)} identity created`);
  }

  // 2. The application row and the membership that carries the role.
  sql(`
    INSERT INTO public.users (id, email) VALUES ('${userId}', '${email}')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
    INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
    VALUES ('${ORG}', '${userId}', '${account.role}', true)
      ON CONFLICT (organization_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, is_active = true;
  `);
  console.log(`  ${''.padEnd(38)} role=${account.role}  (${account.note})`);
}

if (rl) rl.close();

if (DRY) {
  // The first version printed the member list and "Sign in with any of these"
  // after a dry run too. A rehearsal therefore read exactly like a success, and
  // the accounts appeared to exist when nothing at all had been created.
  console.log('\n  DRY RUN — nothing was created. Re-run with --password to do it for real.\n');
  process.exit(0);
}

/**
 * Proof, not assertion.
 *
 * Counts what is actually in the database rather than trusting that the loop
 * above did what it printed. A run that reports success while creating nothing
 * is the exact failure this script has already had once.
 */
const expected = ACCOUNTS.length;
const landed = Number(
  sql(`
    SELECT count(*) FROM public.organization_memberships m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.organization_id = '${ORG}' AND u.email LIKE '${PREFIX}.%'`),
);

console.log('\nMembers of this organization now:\n');
console.log(
  sql(`
    SELECT '  ' || rpad(u.email, 38) || m.role || CASE WHEN m.is_active THEN '' ELSE '  (inactive)' END
      FROM public.organization_memberships m JOIN public.users u ON u.id = m.user_id
     WHERE m.organization_id = '${ORG}' ORDER BY m.role, u.email`),
);

if (landed < expected) {
  console.error(
    `\n  FAILED: expected ${expected} accounts with the '${PREFIX}.' prefix, found ${landed}.\n` +
      '  Nothing above is a guarantee — read the errors higher up.\n',
  );
  process.exit(1);
}

console.log(`\n  ${landed}/${expected} accounts ready. Sign in at the admin app with any of them.\n`);
