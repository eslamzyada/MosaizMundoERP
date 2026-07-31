import ExcelJS from 'exceljs';

/**
 * A report, as a spreadsheet.
 *
 * THE ONE THING THAT MATTERS: MONEY GOES IN AS A NUMBER.
 *
 * The entire reason somebody asks for xlsx rather than a PDF is that they are
 * going to do arithmetic on it — sum a column, pivot it, paste it beside last
 * quarter's. A cell containing the string "1,234.56" looks identical to a cell
 * containing 1234.56 formatted with a thousands separator, and one of them
 * silently sums to zero. Formatting is a display concern and belongs in
 * `numFmt`; the VALUE is always a number.
 *
 * Dates go in as dates for the same reason — sorting a column of "31-07-2026"
 * strings puts the 1st of every month together.
 *
 * Excel handles Arabic itself, so unlike the PDF there is nothing to arrange
 * here: a sheet is right-to-left and the text just works.
 */

export type CellKind = 'text' | 'money' | 'number' | 'percent' | 'date';

export interface SheetColumn {
  header: string;
  kind: CellKind;
  width?: number;
}

export interface Sheet {
  /** Excel refuses several characters and truncates at 31; see safeSheetName. */
  name: string;
  columns: SheetColumn[];
  /** Raw values — numbers as numbers, dates as Dates. Never pre-formatted. */
  rows: Array<Array<string | number | Date | null>>;
}

export interface Workbook {
  title: string;
  period: string;
  organizationName?: string | null;
  /** Label/value pairs written above the first table. */
  figures: Array<{ label: string; value: string | number | null; kind: CellKind }>;
  sheets: Sheet[];
}

const FORMATS: Record<CellKind, string | undefined> = {
  text: undefined,
  money: '#,##0.00',
  number: '#,##0',
  // Stored as a fraction of one, which is what Excel's % format expects — a
  // value of 60 with a % format displays as 6000%.
  percent: '0.0%',
  date: 'yyyy-mm-dd',
};

/**
 * A sheet name Excel will actually accept.
 *
 * `: \ / ? * [ ]` are refused outright and the limit is 31 characters. A
 * workbook that throws on save because a report title had a slash in it is a
 * failure nobody can act on, so the name is made safe rather than validated.
 */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim();
  return (cleaned.length > 31 ? cleaned.slice(0, 31) : cleaned) || 'Sheet';
}

export async function renderReportWorkbook(input: Workbook): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Mosaiz Mundo';
  workbook.created = new Date();

  const used = new Set<string>();

  input.sheets.forEach((sheet, index) => {
    // Two reports can legitimately produce the same 31-character prefix; Excel
    // refuses duplicate names, so they are numbered rather than dropped.
    let name = safeSheetName(sheet.name);
    if (used.has(name)) name = safeSheetName(`${name.slice(0, 28)} ${index + 1}`);
    used.add(name);

    const ws = workbook.addWorksheet(name, {
      views: [{ rightToLeft: true, state: 'frozen', ySplit: index === 0 ? 5 : 1 }],
    });

    if (index === 0) {
      ws.addRow([input.title]);
      ws.getCell('A1').font = { bold: true, size: 14 };
      ws.addRow([input.organizationName ?? '']);
      ws.addRow([input.period]);

      // The figures go across one row of labels and one of values, so the
      // values stay numeric and remain summable.
      ws.addRow(input.figures.map((f) => f.label));
      const valueRow = ws.addRow(input.figures.map((f) => f.value));
      input.figures.forEach((figure, i) => {
        const cell = valueRow.getCell(i + 1);
        const format = FORMATS[figure.kind];
        if (format) cell.numFmt = format;
        cell.font = { bold: true };
      });
      ws.addRow([]);
    }

    const header = ws.addRow(sheet.columns.map((c) => c.header));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE7D6' } };
    });

    for (const row of sheet.rows) {
      const added = ws.addRow(row);
      sheet.columns.forEach((column, i) => {
        const format = FORMATS[column.kind];
        if (format) added.getCell(i + 1).numFmt = format;
      });
    }

    sheet.columns.forEach((column, i) => {
      ws.getColumn(i + 1).width = column.width ?? (column.kind === 'text' ? 26 : 14);
    });

    // A filter row is what makes a sheet usable rather than merely present.
    if (sheet.rows.length > 0) {
      ws.autoFilter = {
        from: { row: header.number, column: 1 },
        to: { row: header.number + sheet.rows.length, column: sheet.columns.length },
      };
    }
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
