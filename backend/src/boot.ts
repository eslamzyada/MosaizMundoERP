/**
 * The configuration gate, as a side effect, so that it runs FIRST.
 *
 * This is a separate module for one reason, and it is a compilation detail
 * worth writing down. TypeScript compiles `import` to `require` at the TOP of
 * the file — every import is evaluated before any statement in the file body.
 * So a check written as a statement in server.ts, however early in the source,
 * still runs AFTER app.ts and prisma.ts have been fully evaluated:
 *
 *     require("dotenv/config");     <- import
 *     const app_1 = require("./app");   <- import, runs the whole app module
 *     const config_1 = require("./config");
 *     ...the check finally runs here
 *
 * Today that happens to be harmless: importing app.ts survives every value
 * this gate rejects, and PrismaClient defers its failure to query time. But
 * "happens to be harmless" is not a property anybody maintains. The moment
 * some module-scope initialiser throws on a bad value, the operator gets that
 * stack trace instead of the sentence naming what is missing — which is
 * exactly the failure this gate exists to replace.
 *
 * Imported for its side effect, before ./app, this is a require and therefore
 * ordered with the other requires. The check cannot stop being first.
 */
import { formatReport, inspectConfig } from './config';

const report = inspectConfig();

// eslint-disable-next-line no-console
console.log(`mosaiz-mundo-api configuration:\n${formatReport(report)}`);

if (report.fatal.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `\nRefusing to start: ${report.fatal.length} fatal configuration problem(s) above.\n` +
      'A deploy that fails is rolled back and reported; a deploy that starts and ' +
      'answers 500 on every request is an outage somebody has to diagnose.',
  );
  process.exit(78); // EX_CONFIG, sysexits.h
}
