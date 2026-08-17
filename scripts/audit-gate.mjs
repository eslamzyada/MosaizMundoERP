#!/usr/bin/env node
/**
 * Fail the build on a NEW high or critical advisory in a shipping dependency.
 *
 * WHY NOT JUST `npm audit`.
 *
 * `npm audit` exits non-zero on anything, which in practice means it exits
 * non-zero always, which means somebody adds `|| true` and the check is
 * decoration. The useful question is narrower: has something appeared that we
 * have NOT already looked at and decided about?
 *
 * So every advisory that survives is either fixed or written down in
 * security/accepted-advisories.json with a reason. A new one fails the build
 * because nobody has written that reason yet — which is the only signal worth
 * interrupting somebody for.
 *
 * ----------------------------------------------------------------------------
 * PRODUCTION DEPENDENCIES ONLY (--omit=dev), and that is deliberate.
 *
 * A dev-tool advisory does not ship. Blocking a deploy on one means a third
 * party's publication schedule decides whether this restaurant can release a
 * fix to its till — and the reflex under that pressure is to disable the whole
 * check, not to upgrade a bundler at 9pm. Dev advisories are REPORTED here,
 * loudly, and do not fail.
 *
 * ----------------------------------------------------------------------------
 * SEVERITY FLOOR: high. Moderate advisories are reported and do not fail. The
 * intent is a gate somebody trusts, and a gate that cries wolf is a gate that
 * gets an `|| true`.
 *
 * Usage:  node scripts/audit-gate.mjs <project-dir> [...more dirs]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTED_FILE = join(REPO_ROOT, 'security', 'accepted-advisories.json');
const BLOCKING = new Set(['high', 'critical']);

function loadAccepted() {
  if (!existsSync(ACCEPTED_FILE)) return { accepted: [] };
  return JSON.parse(readFileSync(ACCEPTED_FILE, 'utf8'));
}

/**
 * `npm audit` exits non-zero when it finds anything, so a throw here is the
 * normal case and the output still has to be read. Only an unparseable body
 * is a real failure — and it is treated as one rather than as "no problems",
 * because a check that silently passes when it cannot run is worse than none.
 */
function audit(dir, omitDev) {
  const args = ['audit', '--json'];
  if (omitDev) args.push('--omit=dev');

  let raw;
  try {
    raw = execFileSync('npm', args, { cwd: dir, encoding: 'utf8', shell: true });
  } catch (err) {
    raw = err.stdout;
  }

  if (!raw || !raw.trim().startsWith('{')) {
    throw new Error(`npm audit produced no JSON in ${dir}. Refusing to report "clean".`);
  }
  return JSON.parse(raw);
}

function advisoriesOf(report) {
  return Object.entries(report.vulnerabilities ?? {}).map(([name, info]) => ({
    name,
    severity: info.severity,
    via: (info.via ?? [])
      .filter((v) => typeof v === 'object')
      .map((v) => v.title)
      .join('; '),
  }));
}

const projects = process.argv.slice(2);
if (projects.length === 0) {
  console.error('usage: node scripts/audit-gate.mjs <project-dir> [...]');
  process.exit(2);
}

const { accepted } = loadAccepted();
const acceptedFor = (project, name) =>
  accepted.find((a) => a.project === project && a.package === name);

let failures = 0;
const today = new Date().toISOString().slice(0, 10);

for (const project of projects) {
  const dir = join(REPO_ROOT, project);
  console.log(`\n=== ${project} ===`);

  const shipping = advisoriesOf(audit(dir, true));
  const everything = advisoriesOf(audit(dir, false));
  const devOnly = everything.filter((a) => !shipping.some((s) => s.name === a.name));

  for (const adv of shipping) {
    const note = acceptedFor(project, adv.name);
    const blocking = BLOCKING.has(adv.severity);

    if (!blocking) {
      console.log(`  note     ${adv.name} (${adv.severity}) — below the gate.`);
      continue;
    }

    if (!note) {
      console.error(
        `  BLOCKED  ${adv.name} (${adv.severity}) — ships, and nobody has reviewed it.\n` +
          `           ${adv.via}\n` +
          `           Fix it, or add an entry to security/accepted-advisories.json\n` +
          `           saying why it cannot be reached from this application.`,
      );
      failures += 1;
      continue;
    }

    // An expired review WARNS rather than fails. A build that breaks because a
    // date passed breaks at the worst possible moment, for a reason unrelated
    // to the change being made.
    const stale = note.review_by && note.review_by < today;
    console.log(
      `  accepted ${adv.name} (${adv.severity}) — ${note.reason}` +
        (stale ? `\n           ** review_by ${note.review_by} has passed. Look again. **` : ''),
    );
  }

  if (shipping.length === 0) console.log('  no advisories in shipping dependencies.');

  for (const adv of devOnly) {
    console.log(`  dev-only ${adv.name} (${adv.severity}) — does not ship; not blocking.`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} unreviewed advisory/advisories in shipping dependencies.`);
  process.exit(1);
}
console.log('\nEvery shipping advisory is either absent or reviewed.');
