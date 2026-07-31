import path from 'path';
import PDFDocument from 'pdfkit';

/**
 * A report, on paper.
 *
 * WHY THE API TAKES PIECES AND NOT STRINGS.
 *
 * The fonts here are SUBSETS, and they are disjoint. Measured, not assumed:
 * cairo-arabic has no digits, no Latin letters and no ASCII punctuation at all;
 * cairo-latin has no Arabic. So "الإيراد: 1,250" cannot be drawn by either one.
 *
 * Worse than a missing glyph: fontkit shapes and reorders a PURE Arabic run
 * correctly, but given a mixed run it shapes the Arabic and then leaves it in
 * LOGICAL order — "عربي" comes out as ع ر ب ي instead of ي ب ر ع. It is not an
 * error, it is not blank, it is simply backwards, and it looks like text.
 *
 * The only reliable rule is one direction per run, so this module never accepts
 * a caller-assembled line. Labels are Arabic, values are Latin, and they are
 * drawn as separate runs at computed positions. There is no API here that could
 * express the broken case.
 *
 * Currency follows the same logic in words rather than symbols: a column headed
 * "المبلغ بالجنيه" needs no "ج.م", which would need both fonts for one string
 * because of the full stop in the middle of it.
 */

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const FONTS = {
  ar: path.join(FONT_DIR, 'cairo-arabic-400-normal.woff'),
  arBold: path.join(FONT_DIR, 'cairo-arabic-700-normal.woff'),
  la: path.join(FONT_DIR, 'cairo-latin-400-normal.woff'),
  laBold: path.join(FONT_DIR, 'cairo-latin-700-normal.woff'),
};

/** A4 portrait, in points, with room for a binder margin. */
const PAGE = { size: 'A4' as const, margin: 42 };
const CONTENT_WIDTH = 595.28 - PAGE.margin * 2;

export interface KeyFigure {
  /** Arabic only. */
  label: string;
  /** Latin only — a formatted number, a date, a percentage. */
  value: string;
}

export interface Column {
  /** Arabic only. */
  header: string;
  /** Which direction this column's CELLS are written in. */
  script: 'ar' | 'la';
  /** Share of the table width, as a weight against the other columns. */
  weight: number;
  /** Defaults to right for Arabic columns and left for Latin ones. */
  align?: 'left' | 'right';
}

export interface Table {
  title: string;
  columns: Column[];
  /** One string per column, already formatted. Never mixed-script. */
  rows: string[][];
  emptyMessage?: string;
}

export interface ReportDocument {
  /** Arabic only. */
  title: string;
  /** The restaurant's own name, if it has set one. Arabic or Latin, alone. */
  organizationName?: string | null;
  organizationScript?: 'ar' | 'la';
  /** Latin only — "2026-07-01 → 2026-07-31". */
  period: string;
  figures: KeyFigure[];
  tables: Table[];
  /** Arabic only. Printed small at the foot of every page. */
  footNote?: string;
}

/**
 * Any text this document cannot actually draw, and what it would be drawn with.
 *
 * The two subsets are disjoint, so putting a digit in an Arabic column does not
 * throw and does not warn — it produces a blank where a number should be, on a
 * page that otherwise looks finished. This walks a document and says so before
 * it is rendered, which turns an invisible failure into a test that fails.
 */
export function findUndrawable(
  doc: ReportDocument,
): Array<{ text: string; script: string; missing: string[] }> {
  // Required lazily: fontkit is a large dependency and only this check needs it
  // outside of PDFKit's own use.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fontkit = require('fontkit') as {
    openSync(path: string): { hasGlyphForCodePoint(cp: number): boolean };
  };
  const fonts = {
    ar: fontkit.openSync(FONTS.ar),
    la: fontkit.openSync(FONTS.la),
  };

  const bad: Array<{ text: string; script: string; missing: string[] }> = [];
  const check = (text: string, script: 'ar' | 'la') => {
    if (!text) return;
    const font = fonts[script];
    // The specific characters, not just "this string is bad": the offender is
    // usually one punctuation mark in a sentence that looks entirely ordinary.
    const missing = [
      ...new Set([...text].filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0)!))),
    ];
    if (missing.length > 0) bad.push({ text, script, missing });
  };

  check(doc.title, 'ar');
  if (doc.organizationName) check(doc.organizationName, doc.organizationScript ?? 'ar');
  check(doc.period, 'la');
  if (doc.footNote) check(doc.footNote, 'ar');
  for (const figure of doc.figures) {
    check(figure.label, 'ar');
    check(figure.value, 'la');
  }
  for (const table of doc.tables) {
    check(table.title, 'ar');
    if (table.emptyMessage) check(table.emptyMessage, 'ar');
    for (const column of table.columns) check(column.header, 'ar');
    for (const row of table.rows) {
      table.columns.forEach((column, i) => check(row[i] ?? '', column.script));
    }
  }
  return bad;
}

/**
 * Renders [doc] and resolves with the finished PDF.
 *
 * Buffered rather than streamed to the response: a report is at most a few
 * hundred kilobytes, and buffering means a failure halfway through becomes a
 * clean 500 instead of a truncated file that a spreadsheet will still try to
 * open.
 */
export function renderReportPdf(doc: ReportDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: PAGE.size, margin: PAGE.margin, autoFirstPage: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    for (const [name, file] of Object.entries(FONTS)) pdf.registerFont(name, file);

    try {
      draw(pdf, doc);
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

function draw(pdf: PDFKit.PDFDocument, doc: ReportDocument): void {
  const right = PAGE.margin + CONTENT_WIDTH;

  // ---- masthead ----------------------------------------------------------
  // Right-aligned: this is an Arabic document, and the eye starts on the right.
  pdf.font('arBold').fontSize(20).fillColor('#191627');
  pdf.text(doc.title, PAGE.margin, PAGE.margin, { width: CONTENT_WIDTH, align: 'right' });

  if (doc.organizationName) {
    pdf
      .font(doc.organizationScript === 'la' ? 'la' : 'ar')
      .fontSize(11)
      .fillColor('#475569')
      .text(doc.organizationName, PAGE.margin, pdf.y + 2, {
        width: CONTENT_WIDTH,
        align: 'right',
      });
  }

  // The period is Latin, so it gets its own run on the left.
  pdf
    .font('la')
    .fontSize(10)
    .fillColor('#475569')
    .text(doc.period, PAGE.margin, pdf.y + 2, { width: CONTENT_WIDTH, align: 'left' });

  pdf.moveDown(0.8);
  rule(pdf);

  // ---- key figures -------------------------------------------------------
  if (doc.figures.length > 0) {
    pdf.moveDown(0.6);
    const perRow = 3;
    const cellWidth = CONTENT_WIDTH / perRow;
    let top = pdf.y;

    doc.figures.forEach((figure, index) => {
      const column = index % perRow;
      if (column === 0 && index > 0) top += 42;
      // Laid out right to left, so the first figure is the top-right one.
      const x = right - (column + 1) * cellWidth;

      pdf
        .font('ar')
        .fontSize(9)
        .fillColor('#475569')
        .text(figure.label, x, top, { width: cellWidth - 8, align: 'right' });
      pdf
        .font('laBold')
        .fontSize(14)
        .fillColor('#191627')
        .text(figure.value, x, top + 13, { width: cellWidth - 8, align: 'right' });
    });

    pdf.y = top + 44;
    rule(pdf);
  }

  // ---- tables ------------------------------------------------------------
  for (const table of doc.tables) {
    if (pdf.y > 700) pdf.addPage();
    pdf.moveDown(0.7);

    pdf
      .font('arBold')
      .fontSize(12)
      .fillColor('#191627')
      .text(table.title, PAGE.margin, pdf.y, { width: CONTENT_WIDTH, align: 'right' });
    pdf.moveDown(0.4);

    if (table.rows.length === 0) {
      pdf
        .font('ar')
        .fontSize(9)
        .fillColor('#475569')
        .text(table.emptyMessage ?? 'لا توجد بيانات', PAGE.margin, pdf.y, {
          width: CONTENT_WIDTH,
          align: 'right',
        });
      pdf.moveDown(0.5);
      continue;
    }

    const totalWeight = table.columns.reduce((s, c) => s + c.weight, 0);
    // Columns run RIGHT to left: the first column is the rightmost one.
    const geometry: Array<{ x: number; width: number }> = [];
    let cursor = right;
    for (const column of table.columns) {
      const width = (column.weight / totalWeight) * CONTENT_WIDTH;
      cursor -= width;
      geometry.push({ x: cursor, width });
    }

    const headerY = pdf.y;
    pdf.rect(PAGE.margin, headerY - 3, CONTENT_WIDTH, 17).fill('#EFE7D6');
    table.columns.forEach((column, i) => {
      pdf
        .font('arBold')
        .fontSize(8.5)
        .fillColor('#191627')
        .text(column.header, geometry[i].x + 4, headerY + 1, {
          width: geometry[i].width - 8,
          align: 'right',
          lineBreak: false,
        });
    });
    pdf.y = headerY + 18;

    for (const row of table.rows) {
      if (pdf.y > 780) {
        pdf.addPage();
        pdf.y = PAGE.margin;
      }
      const rowY = pdf.y;
      table.columns.forEach((column, i) => {
        const cell = row[i] ?? '';
        // The font is chosen by the COLUMN, not by sniffing the text: a
        // heuristic gets it wrong for an ingredient somebody named in English,
        // and the wrong font is a row of blank boxes.
        pdf
          .font(column.script === 'la' ? 'la' : 'ar')
          .fontSize(8.5)
          .fillColor('#191627')
          .text(cell, geometry[i].x + 4, rowY, {
            width: geometry[i].width - 8,
            align: column.align ?? (column.script === 'la' ? 'left' : 'right'),
            lineBreak: false,
            ellipsis: true,
          });
      });
      pdf.y = rowY + 14;
    }

    pdf.moveDown(0.3);
  }

  // ---- foot --------------------------------------------------------------
  if (doc.footNote) {
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      pdf.switchToPage(i);
      pdf
        .font('ar')
        .fontSize(7.5)
        .fillColor('#94A3B8')
        .text(doc.footNote, PAGE.margin, 800, { width: CONTENT_WIDTH, align: 'right' });
    }
  }
}

function rule(pdf: PDFKit.PDFDocument): void {
  pdf
    .moveTo(PAGE.margin, pdf.y)
    .lineTo(PAGE.margin + CONTENT_WIDTH, pdf.y)
    .lineWidth(0.7)
    .strokeColor('#E6DCC8')
    .stroke();
}
