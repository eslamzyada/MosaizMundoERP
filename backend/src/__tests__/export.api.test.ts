import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';
import { pdfText, pdfTextRuns } from './helpers/pdfText';
import { EXPORT_NAMES, EXPORTS } from '../lib/reportExports';
import { findUndrawable } from '../lib/pdfReport';
import type { ReportDocument } from '../lib/pdfReport';
import { exportFilename } from '../controllers/export.controller';

/**
 * Reports as files.
 *
 * Three things here are invisible until somebody has already relied on them:
 *
 *   1. A money column arriving in a spreadsheet as TEXT. "1,234.56" as a string
 *      is pixel-identical to the number and sums to zero. Doing arithmetic on
 *      the export is the entire reason anyone asked for xlsx.
 *   2. Arabic drawn with the Latin font. The two subsets in use are disjoint,
 *      so the result is not an error — it is a blank space where a word was.
 *   3. An export quietly disagreeing with the screen. The figures come from the
 *      report's own handler for exactly this reason, and that is asserted here
 *      by fetching both and comparing them.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the export tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
const itemId = randomUUID();
const ingredientId = randomUUID();
const supplierId = randomUUID();

let managerToken = '';
let cashierToken = '';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });

const FOREIGN_SUPPLIER = 'مورّد المنشأة الأخرى';
const at = (n: number) => `date_trunc('day', now()) - interval '${n} days' + interval '12 hours'`;

async function get(path: string, headers = asManager()) {
  return request(app).get(path).set(headers).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  for (const [id, label] of [
    [orgId, 'Export Org'],
    [otherOrgId, 'Other Export Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${label}, ${`exp-${id.slice(0, 8)}`}, 'enterprise')`;
  }

  for (const [id, prefix, role] of [
    [managerId, 'exp-mgr', 'branch_manager'],
    [cashierId, 'exp-csh', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  managerToken = sign(managerId);
  cashierToken = sign(cashierId);

  // A trading name, so the masthead has something to draw.
  await admin.$executeRaw`INSERT INTO public.organization_branding (organization_id, display_name) VALUES (${orgId}::uuid, ${'مطعم موزاييك موندو'})`;

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'كشري'}, 'KOSHARI', 45.00)`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${ingredientId}::uuid, ${orgId}::uuid, ${'طماطم'}, 'kg')`;
  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${supplierId}::uuid, ${orgId}::uuid, ${'مورّد الشام'})`;

  const orderId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'completed', 135.00, ${at(1)})`,
    orderId,
    orgId,
    randomUUID(),
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO public.order_items (order_id, organization_id, sellable_item_id, quantity, unit_price, cost_at_sale, cost_is_complete, fired_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 3, 45.00, 54.00, true, ${at(1)})`,
    orderId,
    orgId,
    itemId,
  );

  await admin.$executeRawUnsafe(
    `INSERT INTO public.stock_write_offs (organization_id, raw_item_id, quantity_requested, quantity_written_off, total_cost, reason, created_at)
     VALUES ($1::uuid, $2::uuid, 2, 2, 18.50, 'expired', ${at(1)})`,
    orgId,
    ingredientId,
  );

  const poId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO public.purchase_orders (id, organization_id, supplier_id, status, created_at, placed_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'placed', ${at(2)}, ${at(2)})`,
    poId,
    orgId,
    supplierId,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO public.purchase_order_lines (purchase_order_id, organization_id, raw_item_id, quantity_ordered, quantity_received, unit_price)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 10, 4, 7.25)`,
    poId,
    orgId,
    ingredientId,
  );

  // Another restaurant, with a name that would be unmistakable in our file.
  await admin.$executeRaw`INSERT INTO public.suppliers (organization_id, name) VALUES (${otherOrgId}::uuid, ${FOREIGN_SUPPLIER})`;
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.stock_write_offs WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_order_lines WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_branding WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

async function workbookFrom(body: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  return wb;
}

/** Arabic letters only, as a set — order-independent, ligature-proof. */
const letters = (s: string) => new Set([...s].filter((c) => /\p{Script=Arabic}/u.test(c)));


/** Every string the document will draw, split by the script it is drawn in. */
function stringsOf(doc: ReportDocument): { arabic: string[]; latin: string[] } {
  const arabic: string[] = [];
  const latin: string[] = [];
  const add = (text: string, script: 'ar' | 'la') => {
    if (!text) return;
    (script === 'ar' ? arabic : latin).push(text);
  };

  add(doc.title, 'ar');
  if (doc.organizationName) add(doc.organizationName, doc.organizationScript ?? 'ar');
  add(doc.period, 'la');
  if (doc.footNote) add(doc.footNote, 'ar');
  for (const figure of doc.figures) {
    add(figure.label, 'ar');
    add(figure.value, 'la');
  }
  for (const table of doc.tables) {
    add(table.title, 'ar');
    if (table.rows.length === 0 && table.emptyMessage) add(table.emptyMessage, 'ar');
    for (const column of table.columns) add(column.header, 'ar');
    for (const row of table.rows) {
      table.columns.forEach((column, i) => add(row[i] ?? '', column.script));
    }
  }
  return { arabic, latin };
}

const arabicStringsOf = (doc: ReportDocument) => stringsOf(doc).arabic;
const latinStringsOf = (doc: ReportDocument) => stringsOf(doc).latin;



describe('the spreadsheet', () => {
  it('THE ONE THAT MATTERS: money is a NUMBER, not a formatted string', async () => {
    // A cell of "135.00" text looks identical to the number and sums to zero.
    // Doing arithmetic on this file is the whole reason for asking for xlsx.
    const res = await get(`/api/exports/profitability?days=7&format=xlsx`);
    expect(res.status).toBe(200);

    const wb = await workbookFrom(res.body as Buffer);
    const sheet = wb.worksheets[0];
    const header = sheet.getRow(7);
    const revenueCol = (header.values as string[]).indexOf('الإيراد');
    expect(revenueCol).toBeGreaterThan(0);

    const cell = sheet.getRow(8).getCell(revenueCol);
    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBe(135);
    // Formatting is a display concern and lives in numFmt, where it cannot
    // turn the value into text.
    expect(cell.numFmt).toBe('#,##0.00');
  });

  it('a date is a DATE, so the column sorts', async () => {
    // A column of "31-07-2026" strings sorts every month's 1st together.
    const res = await get(`/api/exports/trends?days=7&format=xlsx`);
    const wb = await workbookFrom(res.body as Buffer);
    const sheet = wb.worksheets[0];

    const firstDataRow = sheet.getRow(8);
    expect(firstDataRow.getCell(1).value).toBeInstanceOf(Date);
  });

  it('EVERY declared money and date cell, in every report, holds the right type', async () => {
    // Spot-checking one sheet of one report leaves the other twelve free to
    // ship strings. This walks what each definition SAYS a column is and
    // checks what actually landed in it.
    const problems: string[] = [];

    for (const name of EXPORT_NAMES) {
      const json = await request(app).get(`/api/reports/${name}?days=7`).set(asManager());
      const book = EXPORTS[name].toWorkbook(json.body as never, { organizationName: null });

      const res = await get(`/api/exports/${name}?days=7&format=xlsx`);
      const wb = await workbookFrom(res.body as Buffer);

      // The summary figures, which live on their own row above the first table.
      const figureRow = wb.worksheets[0].getRow(5);
      book.figures.forEach((figure, i) => {
        const value = figureRow.getCell(i + 1).value;
        if (value === null || value === undefined) return;
        if (figure.kind !== 'text' && typeof value !== 'number') {
          problems.push(`${name}: figure "${figure.label}" is ${typeof value}`);
        }
      });

      book.sheets.forEach((sheet, index) => {
        const ws = wb.worksheets[index];
        const headerRow = index === 0 ? 7 : 1;
        sheet.rows.forEach((_, rowIndex) => {
          const row = ws.getRow(headerRow + 1 + rowIndex);
          sheet.columns.forEach((column, colIndex) => {
            const value = row.getCell(colIndex + 1).value;
            if (value === null || value === undefined) return;
            const ok =
              column.kind === 'text'
                ? true
                : column.kind === 'date'
                  ? value instanceof Date
                  : typeof value === 'number';
            if (!ok) {
              problems.push(
                `${name}/${sheet.name}: "${column.header}" declared ${column.kind}, got ${
                  value instanceof Date ? 'Date' : typeof value
                }`,
              );
            }
          });
        });
      });
    }

    expect(problems).toEqual([]);
  });

  it('a percentage is stored as a fraction, which is what the format expects', async () => {
    // 60 with a "%" format displays as 6000%.
    const res = await get(`/api/exports/profitability?days=7&format=xlsx`);
    const wb = await workbookFrom(res.body as Buffer);
    const values = wb.worksheets[0].getRow(5).values as unknown[];
    const percentages = values.filter((v) => typeof v === 'number' && v > 0 && v <= 1);
    expect(percentages.length).toBeGreaterThan(0);
  });

  it('carries the Arabic through untouched — Excel does its own bidi', async () => {
    const res = await get(`/api/exports/profitability?days=7&format=xlsx`);
    const wb = await workbookFrom(res.body as Buffer);
    const sheet = wb.worksheets[0];

    expect(sheet.getCell('A1').value).toBe('تقرير الأرباح');
    expect(sheet.getCell('A2').value).toBe('مطعم موزاييك موندو');
    expect(sheet.views[0].rightToLeft).toBe(true);
  });

  it('gives every report a sheet Excel will accept', async () => {
    // ":" and "/" are refused outright and the limit is 31 characters; a
    // workbook that throws on save is a failure nobody can act on.
    for (const name of EXPORT_NAMES) {
      const res = await get(`/api/exports/${name}?days=7&format=xlsx`);
      expect(res.status).toBe(200);
      const wb = await workbookFrom(res.body as Buffer);
      for (const ws of wb.worksheets) {
        expect(ws.name.length).toBeLessThanOrEqual(31);
        expect(ws.name).not.toMatch(/[:\\/?*[\]]/);
      }
    }
  });

  it('never contains another restaurant', async () => {
    const res = await get(`/api/exports/purchasing?days=7&format=xlsx`);
    const wb = await workbookFrom(res.body as Buffer);

    let found = false;
    wb.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          if (String(cell.value ?? '').includes(FOREIGN_SUPPLIER)) found = true;
          if (String(cell.value ?? '').includes('مورّد الشام')) expect(true).toBe(true);
        }),
      ),
    );
    expect(found).toBe(false);
  });
});

describe('the PDF', () => {
  it('is a PDF', async () => {
    const res = await get(`/api/exports/waste?days=7&format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('contains the Arabic it was asked to draw', async () => {
    // Not a given: the Arabic subset in use has no digits and no Latin at all,
    // so one wrong font() call renders a heading as nothing whatsoever — and
    // nothing is exactly what this would then find.
    //
    // Compared as LETTER SETS rather than strings, deliberately. A shaped RTL
    // run is stored visually, a lam-alef ligature maps back through ToUnicode
    // as two characters, and PDFKit splits a line into several show-text
    // operators wherever it adjusts spacing. All three make an exact match fail
    // for reasons that have nothing to do with whether the text is right.
    const res = await get(`/api/exports/profitability?days=7&format=pdf`);
    const drawn = letters(pdfText(res.body as Buffer));

    for (const phrase of ['تقرير الأرباح', 'مطعم موزاييك موندو', 'كشري']) {
      const wanted = [...letters(phrase)];
      const absent = wanted.filter((c) => !drawn.has(c));
      expect({ phrase, absent }).toEqual({ phrase, absent: [] });
    }
  });

  it('reproduces Latin exactly — the numbers are the point', async () => {
    const res = await get(`/api/exports/profitability?days=7&format=pdf`);
    const text = pdfText(res.body as Buffer);

    expect(text).toContain('135.00');
    expect(text).toContain('KOSHARI');
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('THE ONE THAT GOES BLANK: no text is drawn with a font that lacks its glyphs', async () => {
    // Measured, not assumed. Drawing "طماطم" with the Latin subset does not
    // throw and does not warn — PDFKit writes .notdef glyphs, which read back
    // as NUL. On the page they are white space where an ingredient name should
    // be, in a document that otherwise looks complete.
    //
    // This is the exact signature of that failure, so it needs no threshold:
    // a healthy export contains no NUL at all.
    for (const name of EXPORT_NAMES) {
      const res = await get(`/api/exports/${name}?days=7&format=pdf`);
      const blank = pdfTextRuns(res.body as Buffer)
        .filter((r) => r.text.includes(' '))
        .map((r) => r.font);

      expect({ report: name, drawnWithTheWrongFont: blank }).toEqual({
        report: name,
        drawnWithTheWrongFont: [],
      });
    }
  });

  it('DROPS NOTHING: every Arabic string the document holds reaches the page', async () => {
    // The sharp version of "nothing vanished". Counting CHARACTERS turned out
    // to be a poor detector — shaping merges enough of them that a healthy
    // export reads back at 0.99 and one with its Arabic columns drawn in the
    // Latin font still reads 0.83, which is not much of a gap to hang a test
    // on. Counting RUNS is decisive instead: PDFKit may split one string across
    // several show-text operators, so the count can only ever be too high —
    // while a string drawn with a font that has no glyphs for it produces no
    // run at all, and the count falls by exactly the number of cells lost.
    for (const name of EXPORT_NAMES) {
      const json = await request(app).get(`/api/reports/${name}?days=7`).set(asManager());
      expect(json.status).toBe(200);

      const doc = EXPORTS[name].toDocument(json.body as never, {
        organizationName: 'مطعم موزاييك موندو',
      });

      const wanted = arabicStringsOf(doc).length;
      const file = await get(`/api/exports/${name}?days=7&format=pdf`);
      const drawn = pdfTextRuns(file.body as Buffer).filter((r) =>
        /\p{Script=Arabic}/u.test(r.text),
      ).length;

      expect({ report: name, enough: drawn >= wanted }).toEqual({ report: name, enough: true });
    }
  });

  it('and every Latin string too — the numbers are the point', async () => {
    for (const name of EXPORT_NAMES) {
      const json = await request(app).get(`/api/reports/${name}?days=7`).set(asManager());
      const doc = EXPORTS[name].toDocument(json.body as never, { organizationName: null });

      const wanted = latinStringsOf(doc).filter((s) => /[0-9A-Za-z]/.test(s)).length;
      const file = await get(`/api/exports/${name}?days=7&format=pdf`);
      const drawn = pdfTextRuns(file.body as Buffer).filter((r) =>
        /[0-9A-Za-z]/.test(r.text),
      ).length;

      expect({ report: name, enough: drawn >= wanted }).toEqual({ report: name, enough: true });
    }
  });


  it('NEVER mixes scripts in one run', async () => {
    // The invariant the whole document format exists to keep. fontkit shapes a
    // mixed run and then leaves the Arabic in logical order — not an error, not
    // blank, simply backwards, and it still looks like text.
    for (const name of EXPORT_NAMES) {
      const res = await get(`/api/exports/${name}?days=7&format=pdf`);
      for (const run of pdfTextRuns(res.body as Buffer)) {
        const hasArabic = /\p{Script=Arabic}/u.test(run.text);
        const hasLatin = /[A-Za-z]/.test(run.text);
        expect({ report: name, run: run.text, mixed: hasArabic && hasLatin }).toEqual({
          report: name,
          run: run.text,
          mixed: false,
        });
      }
    }
  });

  it('has no text it cannot draw, in any report', async () => {
    // Checked against the font tables directly, so a label added later with a
    // digit in it fails here rather than printing a gap.
    for (const name of EXPORT_NAMES) {
      const json = await request(app)
        .get(`/api/reports/${name === 'trends' ? 'trends' : name}?days=7`)
        .set(asManager());
      expect(json.status).toBe(200);

      const doc = EXPORTS[name].toDocument(json.body as never, {
        organizationName: 'مطعم موزاييك موندو',
      });
      expect({ report: name, undrawable: findUndrawable(doc) }).toEqual({
        report: name,
        undrawable: [],
      });
    }
  });
});

describe('the export and the screen agree', () => {
  it('reads the SAME figures the API answers with', async () => {
    // The export runs the report's own handler. If it ever re-queried instead,
    // the two would drift apart silently and the first anyone would know is a
    // printed report quoting a number the system stopped calculating.
    const json = await request(app).get('/api/reports/purchasing?days=7').set(asManager());
    const file = await get('/api/exports/purchasing?days=7&format=xlsx');
    const wb = await workbookFrom(file.body as Buffer);

    const committed = wb.worksheets[0].getRow(5).getCell(1).value;
    expect(committed).toBe(json.body.summary.committed);
    expect(committed).toBe(72.5); // 10 × 7.25
  });

  it('covers the same period the report does', async () => {
    const json = await request(app).get('/api/reports/waste?days=7').set(asManager());
    const file = await get('/api/exports/waste?days=7&format=xlsx');
    const wb = await workbookFrom(file.body as Buffer);

    // An en dash, not an arrow: the Latin subset has no U+2192, and the font
    // coverage guard is what caught it before it printed as a gap.
    expect(wb.worksheets[0].getCell('A3').value).toBe(`${json.body.from} – ${json.body.to}`);
  });
});

describe('the download itself', () => {
  it('names the file after the report AND the period', async () => {
    // "report.pdf" is indistinguishable from last month's the moment it is
    // saved, and three of them in one folder are worse than none.
    const res = await get('/api/exports/waste?from=2026-07-01&to=2026-07-31&format=pdf');
    expect(res.headers['content-disposition']).toContain(
      'mosaiz-waste-2026-07-01_2026-07-31.pdf',
    );
  });

  it('keeps the filename ASCII', () => {
    // A non-ASCII filename needs RFC 5987 encoding that older clients mangle,
    // and a corrupted name is worse than an English one.
    const name = exportFilename('waste', '2026-07-01', '2026-07-31', 'xlsx');
    expect(name).toMatch(/^[\x20-\x7E]+$/);
  });

  it('lets the browser read the header it needs to name the file', async () => {
    const res = await get('/api/exports/waste?days=7&format=pdf');
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });

  it('sends the right content type for a spreadsheet', async () => {
    const res = await get('/api/exports/waste?days=7&format=xlsx');
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
  });
});

describe('what it refuses', () => {
  it('a report it does not have, naming the ones it does', async () => {
    const res = await request(app).get('/api/exports/unicorns?format=pdf').set(asManager());
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('profitability');
  });

  it('a format it cannot produce', async () => {
    const res = await request(app).get('/api/exports/waste?format=docx').set(asManager());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pdf, xlsx/);
  });

  it('a broken date range stays a 400, not a 500', async () => {
    // The caller can fix a bad range; a 500 tells them to wait for somebody
    // else to fix something they cannot see.
    const res = await request(app)
      .get('/api/exports/waste?from=2026-08-01&to=2026-07-01&format=pdf')
      .set(asManager());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from must not be after to/);
  });

  it('a cashier — a PDF of the margins is still the margins', async () => {
    const res = await request(app).get('/api/exports/profitability?format=pdf').set(asCashier());
    expect(res.status).toBe(403);
  });

  it('an unauthenticated caller', async () => {
    expect((await request(app).get('/api/exports/waste?format=pdf')).status).toBe(401);
  });
});
