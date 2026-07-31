import { Request, Response } from 'express';
import {
  getEmployeePerformance,
  getInventoryAssets,
  getProfitability,
  getVoids,
  getWaste,
} from '../controllers/report.controller';
import { getTrends } from '../controllers/trends.controller';
import { getPurchasing } from '../controllers/purchasing.controller';
import type { VoidReason } from './voidReasons';
import type { WriteOffReason } from './writeOffReasons';
import type { ReportDocument, Table } from './pdfReport';
import type { Sheet, Workbook } from './xlsxReport';

/**
 * What each report looks like once it leaves the screen.
 *
 * One definition per report, feeding both formats, because the alternative is a
 * PDF and a spreadsheet that quietly disagree about which columns matter.
 *
 * The two formats want genuinely different things from the same data, and the
 * split is deliberate:
 *
 *   PDF   — already formatted strings. It is paper; nothing will be calculated
 *           from it, and the layout has to survive a fixed column width.
 *   XLSX  — raw numbers, never formatted strings. Somebody exported to a
 *           spreadsheet in order to do arithmetic, and "1,234.56" as text sums
 *           to zero while looking exactly like a number.
 *
 * PDF strings are also SINGLE-SCRIPT, always: see pdfReport.ts for why a mixed
 * Arabic/Latin run comes out silently backwards.
 */

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Arabic for the reason codes.
 *
 * Typed as a total Record over the canonical union rather than a loose lookup:
 * adding a reason to voidReasons.ts then fails to COMPILE until it has a
 * label here. The alternative — a `?? code` fallback — puts "prep_error" in an
 * Arabic PDF and nobody finds out until somebody prints one.
 *
 * The admin holds its own copy for the screen. Duplicated on purpose: the
 * server must be able to produce a finished document without asking a browser
 * what things are called.
 */
const VOID_LABELS: Record<VoidReason, string> = {
  wrong_item: 'صنف خاطئ',
  duplicate: 'طلب مكرر',
  customer_cancelled: 'إلغاء من العميل',
  kitchen_error: 'خطأ في المطبخ',
  customer_complaint: 'شكوى عميل',
  test_order: 'طلب تجريبي',
  other: 'أخرى',
};

const WRITE_OFF_LABELS: Record<WriteOffReason, string> = {
  expired: 'منتهي الصلاحية',
  spoiled: 'تالف',
  damaged: 'متضرر',
  prep_error: 'خطأ في التحضير',
  staff_meal: 'وجبة موظفين',
  other: 'أخرى',
};

const voidReasonLabel = (code: string) => VOID_LABELS[code as VoidReason] ?? code;
const writeOffReasonLabel = (code: string) => WRITE_OFF_LABELS[code as WriteOffReason] ?? code;

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
/** An absent percentage is a dash, not a zero — they mean different things. */
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
/** Excel stores a percentage as a fraction of one. */
const pctCell = (n: number | null) => (n === null ? null : n / 100);

export interface ExportContext {
  organizationName: string | null;
}

export interface ExportDefinition {
  /** The handler whose answer is exported, so the figures cannot drift. */
  handler: Handler;
  /** Goes into the download's filename, before the period. */
  slug: string;
  title: string;
  toDocument(data: never, ctx: ExportContext): ReportDocument;
  toWorkbook(data: never, ctx: ExportContext): Workbook;
}

interface Period {
  from: string;
  to: string;
}

const periodText = (p: Period) => `${p.from} – ${p.to}`;

const FOOT = 'صادر عن نظام موزاييك موندو، والأرقام تخص المنشأة الحالية وحدها';

/** Shared masthead for both formats, so they cannot disagree about the period. */
function head(data: Period, ctx: ExportContext, title: string) {
  return {
    title,
    organizationName: ctx.organizationName,
    organizationScript: 'ar' as const,
    period: periodText(data),
  };
}

// ---------------------------------------------------------------------------

interface ProfitBucket {
  revenue: number;
  costed_revenue: number;
  cogs: number;
  gross_profit: number;
  margin_pct: number | null;
  uncosted_revenue: number;
  uncosted_line_count: number;
  coverage_pct: number | null;
}

interface ProfitabilityData extends Period {
  summary: ProfitBucket;
  by_day: Array<ProfitBucket & { day: string }>;
  by_item: Array<ProfitBucket & { id: string; name: string; sku: string | null; units_sold: number }>;
}

const profitability: ExportDefinition = {
  handler: getProfitability,
  slug: 'profitability',
  title: 'تقرير الأرباح',
  toDocument(raw, ctx) {
    const data = raw as unknown as ProfitabilityData;
    return {
      ...head(data, ctx, 'تقرير الأرباح'),
      figures: [
        { label: 'الإيراد', value: money(data.summary.revenue) },
        { label: 'تكلفة المبيعات', value: money(data.summary.cogs) },
        { label: 'مجمل الربح', value: money(data.summary.gross_profit) },
        { label: 'الهامش', value: pct(data.summary.margin_pct) },
        { label: 'تغطية التكلفة', value: pct(data.summary.coverage_pct) },
        { label: 'إيراد غير مُكلَّف', value: money(data.summary.uncosted_revenue) },
      ],
      tables: [
        {
          title: 'حسب الصنف',
          columns: [
            { header: 'الصنف', script: 'ar', weight: 3 },
            { header: 'الكود', script: 'la', weight: 1.4 },
            { header: 'المُباع', script: 'la', weight: 1 },
            { header: 'الإيراد بالجنيه', script: 'la', weight: 1.5 },
            { header: 'مجمل الربح بالجنيه', script: 'la', weight: 1.5 },
            { header: 'الهامش', script: 'la', weight: 1 },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.sku ?? '—',
            whole(i.units_sold),
            money(i.revenue),
            money(i.gross_profit),
            pct(i.margin_pct),
          ]),
          emptyMessage: 'لم تُسجَّل مبيعات في هذه الفترة',
        },
        {
          title: 'حسب اليوم',
          columns: [
            { header: 'اليوم', script: 'la', weight: 1.4 },
            { header: 'الإيراد بالجنيه', script: 'la', weight: 1.5 },
            { header: 'تكلفة المبيعات بالجنيه', script: 'la', weight: 1.5 },
            { header: 'مجمل الربح بالجنيه', script: 'la', weight: 1.5 },
            { header: 'الهامش', script: 'la', weight: 1 },
          ],
          rows: data.by_day.map((d) => [
            d.day,
            money(d.revenue),
            money(d.cogs),
            money(d.gross_profit),
            pct(d.margin_pct),
          ]),
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as ProfitabilityData;
    return {
      title: 'تقرير الأرباح',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'الإيراد', value: data.summary.revenue, kind: 'money' },
        { label: 'تكلفة المبيعات', value: data.summary.cogs, kind: 'money' },
        { label: 'مجمل الربح', value: data.summary.gross_profit, kind: 'money' },
        { label: 'الهامش', value: pctCell(data.summary.margin_pct), kind: 'percent' },
        { label: 'تغطية التكلفة', value: pctCell(data.summary.coverage_pct), kind: 'percent' },
      ],
      sheets: [
        {
          name: 'حسب الصنف',
          columns: [
            { header: 'الصنف', kind: 'text' },
            { header: 'الكود', kind: 'text' },
            { header: 'الكمية المباعة', kind: 'number' },
            { header: 'الإيراد', kind: 'money' },
            { header: 'تكلفة المبيعات', kind: 'money' },
            { header: 'مجمل الربح', kind: 'money' },
            { header: 'الهامش', kind: 'percent' },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.sku,
            i.units_sold,
            i.revenue,
            i.cogs,
            i.gross_profit,
            pctCell(i.margin_pct),
          ]),
        },
        {
          name: 'حسب اليوم',
          columns: [
            { header: 'اليوم', kind: 'date' },
            { header: 'الإيراد', kind: 'money' },
            { header: 'تكلفة المبيعات', kind: 'money' },
            { header: 'مجمل الربح', kind: 'money' },
            { header: 'الهامش', kind: 'percent' },
          ],
          rows: data.by_day.map((d) => [
            new Date(`${d.day}T00:00:00`),
            d.revenue,
            d.cogs,
            d.gross_profit,
            pctCell(d.margin_pct),
          ]),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------

interface WasteData extends Period {
  summary: {
    write_off_cost: number;
    waste_cost: number;
    staff_meal_cost: number;
    cogs: number;
    waste_share_pct: number | null;
    write_off_count: number;
  };
  by_reason: Array<{ reason: string; write_off_count: number; quantity: number; cost: number }>;
  by_item: Array<{ name: string; unit_of_measure: string; write_off_count: number; quantity: number; cost: number }>;
  by_supplier: Array<{ name: string | null; quantity: number; cost: number }>;
}

const waste: ExportDefinition = {
  handler: getWaste,
  slug: 'waste',
  title: 'تقرير الهدر',
  toDocument(raw, ctx) {
    const data = raw as unknown as WasteData;
    return {
      ...head(data, ctx, 'تقرير الهدر'),
      figures: [
        { label: 'إجمالي الإهلاك', value: money(data.summary.write_off_cost) },
        { label: 'الهدر', value: money(data.summary.waste_cost) },
        { label: 'وجبات الموظفين', value: money(data.summary.staff_meal_cost) },
        { label: 'نسبة الهدر من تكلفة الطعام', value: pct(data.summary.waste_share_pct) },
        { label: 'عدد عمليات الإهلاك', value: whole(data.summary.write_off_count) },
      ],
      tables: [
        {
          title: 'حسب السبب',
          columns: [
            { header: 'السبب', script: 'ar', weight: 2.5 },
            { header: 'عدد المرات', script: 'la', weight: 1 },
            { header: 'الكمية', script: 'la', weight: 1.2 },
            { header: 'التكلفة بالجنيه', script: 'la', weight: 1.5 },
          ],
          rows: data.by_reason.map((r) => [
            writeOffReasonLabel(r.reason),
            whole(r.write_off_count),
            qty(r.quantity),
            money(r.cost),
          ]),
          emptyMessage: 'لم يُسجَّل أي إهلاك في هذه الفترة',
        },
        {
          title: 'حسب المكوّن',
          columns: [
            { header: 'المكوّن', script: 'ar', weight: 3 },
            { header: 'الوحدة', script: 'la', weight: 1 },
            { header: 'الكمية', script: 'la', weight: 1.2 },
            { header: 'التكلفة بالجنيه', script: 'la', weight: 1.5 },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.unit_of_measure,
            qty(i.quantity),
            money(i.cost),
          ]),
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as WasteData;
    return {
      title: 'تقرير الهدر',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'إجمالي الإهلاك', value: data.summary.write_off_cost, kind: 'money' },
        { label: 'الهدر', value: data.summary.waste_cost, kind: 'money' },
        { label: 'وجبات الموظفين', value: data.summary.staff_meal_cost, kind: 'money' },
        { label: 'نسبة الهدر', value: pctCell(data.summary.waste_share_pct), kind: 'percent' },
      ],
      sheets: [
        {
          name: 'حسب السبب',
          columns: [
            { header: 'السبب', kind: 'text' },
            { header: 'عدد المرات', kind: 'number' },
            { header: 'الكمية', kind: 'number' },
            { header: 'التكلفة', kind: 'money' },
          ],
          rows: data.by_reason.map((r) => [
            writeOffReasonLabel(r.reason),
            r.write_off_count,
            r.quantity,
            r.cost,
          ]),
        },
        {
          name: 'حسب المكوّن',
          columns: [
            { header: 'المكوّن', kind: 'text' },
            { header: 'الوحدة', kind: 'text' },
            { header: 'عدد المرات', kind: 'number' },
            { header: 'الكمية', kind: 'number' },
            { header: 'التكلفة', kind: 'money' },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.unit_of_measure,
            i.write_off_count,
            i.quantity,
            i.cost,
          ]),
        },
        {
          name: 'حسب المورّد',
          columns: [
            { header: 'المورّد', kind: 'text' },
            { header: 'الكمية', kind: 'number' },
            { header: 'التكلفة', kind: 'money' },
          ],
          rows: data.by_supplier.map((s) => [s.name ?? 'غير منسوب', s.quantity, s.cost]),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------

interface PurchasingData extends Period {
  summary: {
    committed: number;
    received: number;
    outstanding: number;
    fulfilment_pct: number | null;
    order_count: number;
    supplier_count: number;
    open_orders: { order_count: number; outstanding: number; oldest_placed_at: string | null };
  };
  by_supplier: Array<{ name: string; order_count: number; committed: number; received: number; outstanding: number }>;
  by_status: Array<{ status: string; order_count: number; committed: number }>;
  by_item: Array<{ name: string; unit_of_measure: string; quantity_ordered: number; committed: number; last_unit_price: number }>;
}

const PO_STATUS: Record<string, string> = {
  draft: 'مسودة',
  placed: 'مُرسَل',
  received: 'مُستلَم',
  cancelled: 'ملغى',
};

const purchasing: ExportDefinition = {
  handler: getPurchasing,
  slug: 'purchasing',
  title: 'تقرير المشتريات',
  toDocument(raw, ctx) {
    const data = raw as unknown as PurchasingData;
    return {
      ...head(data, ctx, 'تقرير المشتريات'),
      figures: [
        { label: 'قيمة ما طُلب', value: money(data.summary.committed) },
        { label: 'قيمة ما وصل', value: money(data.summary.received) },
        { label: 'لم يصل بعد', value: money(data.summary.outstanding) },
        { label: 'نسبة التوريد', value: pct(data.summary.fulfilment_pct) },
        { label: 'عدد أوامر الشراء', value: whole(data.summary.order_count) },
        { label: 'أوامر معلَّقة بكل التواريخ', value: whole(data.summary.open_orders.order_count) },
      ],
      tables: [
        {
          title: 'حسب المورّد',
          columns: [
            { header: 'المورّد', script: 'ar', weight: 3 },
            { header: 'عدد الأوامر', script: 'la', weight: 1 },
            { header: 'طُلب بالجنيه', script: 'la', weight: 1.5 },
            { header: 'وصل بالجنيه', script: 'la', weight: 1.5 },
            { header: 'لم يصل بالجنيه', script: 'la', weight: 1.5 },
          ],
          rows: data.by_supplier.map((s) => [
            s.name,
            whole(s.order_count),
            money(s.committed),
            money(s.received),
            money(s.outstanding),
          ]),
          emptyMessage: 'لم تُرسَل أوامر شراء في هذه الفترة',
        },
        {
          title: 'حسب المكوّن',
          columns: [
            { header: 'المكوّن', script: 'ar', weight: 3 },
            { header: 'الوحدة', script: 'la', weight: 1 },
            { header: 'الكمية', script: 'la', weight: 1.2 },
            { header: 'القيمة بالجنيه', script: 'la', weight: 1.5 },
            { header: 'آخر سعر', script: 'la', weight: 1.2 },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.unit_of_measure,
            qty(i.quantity_ordered),
            money(i.committed),
            money(i.last_unit_price),
          ]),
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as PurchasingData;
    return {
      title: 'تقرير المشتريات',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'قيمة ما طُلب', value: data.summary.committed, kind: 'money' },
        { label: 'قيمة ما وصل', value: data.summary.received, kind: 'money' },
        { label: 'لم يصل بعد', value: data.summary.outstanding, kind: 'money' },
        { label: 'نسبة التوريد', value: pctCell(data.summary.fulfilment_pct), kind: 'percent' },
      ],
      sheets: [
        {
          name: 'حسب المورّد',
          columns: [
            { header: 'المورّد', kind: 'text' },
            { header: 'عدد الأوامر', kind: 'number' },
            { header: 'طُلب', kind: 'money' },
            { header: 'وصل', kind: 'money' },
            { header: 'لم يصل', kind: 'money' },
          ],
          rows: data.by_supplier.map((s) => [
            s.name,
            s.order_count,
            s.committed,
            s.received,
            s.outstanding,
          ]),
        },
        {
          name: 'حسب الحالة',
          columns: [
            { header: 'الحالة', kind: 'text' },
            { header: 'عدد الأوامر', kind: 'number' },
            { header: 'القيمة', kind: 'money' },
          ],
          rows: data.by_status.map((s) => [
            PO_STATUS[s.status] ?? s.status,
            s.order_count,
            s.committed,
          ]),
        },
        {
          name: 'حسب المكوّن',
          columns: [
            { header: 'المكوّن', kind: 'text' },
            { header: 'الوحدة', kind: 'text' },
            { header: 'الكمية', kind: 'number' },
            { header: 'القيمة', kind: 'money' },
            { header: 'آخر سعر', kind: 'money' },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.unit_of_measure,
            i.quantity_ordered,
            i.committed,
            i.last_unit_price,
          ]),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------

interface TrendsData extends Period {
  summary: {
    revenue: number;
    cogs: number;
    gross_profit: number;
    margin_pct: number | null;
    order_count: number;
    average_ticket: number | null;
    waste_cost: number;
    purchasing_cost: number;
  };
  points: Array<{
    bucket_start: string;
    revenue: number;
    cogs: number;
    gross_profit: number;
    order_count: number;
    waste_cost: number;
    write_off_cost: number;
    purchasing_cost: number;
  }>;
}

const trends: ExportDefinition = {
  handler: getTrends,
  slug: 'trends',
  title: 'المؤشرات',
  toDocument(raw, ctx) {
    const data = raw as unknown as TrendsData;
    return {
      ...head(data, ctx, 'المؤشرات'),
      figures: [
        { label: 'الإيراد', value: money(data.summary.revenue) },
        { label: 'مجمل الربح', value: money(data.summary.gross_profit) },
        { label: 'الهامش', value: pct(data.summary.margin_pct) },
        { label: 'الهدر', value: money(data.summary.waste_cost) },
        { label: 'المشتريات', value: money(data.summary.purchasing_cost) },
        {
          label: 'متوسط الفاتورة',
          value: data.summary.average_ticket === null ? '—' : money(data.summary.average_ticket),
        },
      ],
      tables: [
        {
          title: 'التفصيل الزمني',
          columns: [
            { header: 'الفترة', script: 'la', weight: 1.4 },
            { header: 'الإيراد بالجنيه', script: 'la', weight: 1.4 },
            { header: 'مجمل الربح بالجنيه', script: 'la', weight: 1.4 },
            { header: 'الطلبات', script: 'la', weight: 1 },
            { header: 'الهدر بالجنيه', script: 'la', weight: 1.2 },
            { header: 'المشتريات بالجنيه', script: 'la', weight: 1.4 },
          ],
          rows: data.points.map((p) => [
            p.bucket_start,
            money(p.revenue),
            money(p.gross_profit),
            whole(p.order_count),
            money(p.waste_cost),
            money(p.purchasing_cost),
          ]),
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as TrendsData;
    return {
      title: 'المؤشرات',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'الإيراد', value: data.summary.revenue, kind: 'money' },
        { label: 'مجمل الربح', value: data.summary.gross_profit, kind: 'money' },
        { label: 'الهدر', value: data.summary.waste_cost, kind: 'money' },
        { label: 'المشتريات', value: data.summary.purchasing_cost, kind: 'money' },
        { label: 'عدد الطلبات', value: data.summary.order_count, kind: 'number' },
      ],
      sheets: [
        {
          name: 'التفصيل الزمني',
          columns: [
            { header: 'الفترة', kind: 'date' },
            { header: 'الإيراد', kind: 'money' },
            { header: 'تكلفة المبيعات', kind: 'money' },
            { header: 'مجمل الربح', kind: 'money' },
            { header: 'الطلبات', kind: 'number' },
            { header: 'الهدر', kind: 'money' },
            { header: 'إجمالي الإهلاك', kind: 'money' },
            { header: 'المشتريات', kind: 'money' },
          ],
          rows: data.points.map((p) => [
            new Date(`${p.bucket_start}T00:00:00`),
            p.revenue,
            p.cogs,
            p.gross_profit,
            p.order_count,
            p.waste_cost,
            p.write_off_cost,
            p.purchasing_cost,
          ]),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------

interface AssetsData extends Period {
  summary: {
    capital_tied_up: number;
    stock_consumed_cost: number;
    turnover: number | null;
    dead_capital: number;
    dead_capital_pct: number | null;
  };
  by_item: Array<{
    name: string;
    unit_of_measure: string;
    on_hand: number;
    capital: number;
    days_held: number | null;
    days_of_cover: number | null;
    is_dead_stock: boolean;
  }>;
}

const inventoryAssets: ExportDefinition = {
  handler: getInventoryAssets,
  slug: 'inventory-assets',
  title: 'المخزون كأصل',
  toDocument(raw, ctx) {
    const data = raw as unknown as AssetsData;
    return {
      ...head(data, ctx, 'المخزون كأصل'),
      figures: [
        { label: 'رأس المال في المخزون', value: money(data.summary.capital_tied_up) },
        { label: 'المستهلك في الفترة', value: money(data.summary.stock_consumed_cost) },
        {
          label: 'دورة المخزون',
          value: data.summary.turnover === null ? '—' : String(data.summary.turnover),
        },
        { label: 'رأس مال راكد', value: money(data.summary.dead_capital) },
        { label: 'نسبة الراكد', value: pct(data.summary.dead_capital_pct) },
      ],
      tables: [
        {
          title: 'حسب المكوّن',
          columns: [
            { header: 'المكوّن', script: 'ar', weight: 3 },
            { header: 'الوحدة', script: 'la', weight: 1 },
            { header: 'الرصيد', script: 'la', weight: 1.2 },
            { header: 'القيمة بالجنيه', script: 'la', weight: 1.5 },
            { header: 'أقدم دفعة بالأيام', script: 'la', weight: 1.2 },
            { header: 'تغطية بالأيام', script: 'la', weight: 1.2 },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.unit_of_measure,
            qty(i.on_hand),
            money(i.capital),
            i.days_held === null ? '—' : whole(i.days_held),
            i.days_of_cover === null ? '—' : whole(i.days_of_cover),
          ]),
          emptyMessage: 'لا يوجد مخزون مُقيَّم',
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as AssetsData;
    return {
      title: 'المخزون كأصل',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'رأس المال في المخزون', value: data.summary.capital_tied_up, kind: 'money' },
        { label: 'المستهلك في الفترة', value: data.summary.stock_consumed_cost, kind: 'money' },
        { label: 'رأس مال راكد', value: data.summary.dead_capital, kind: 'money' },
        { label: 'نسبة الراكد', value: pctCell(data.summary.dead_capital_pct), kind: 'percent' },
      ],
      sheets: [
        {
          name: 'حسب المكوّن',
          columns: [
            { header: 'المكوّن', kind: 'text' },
            { header: 'الوحدة', kind: 'text' },
            { header: 'الرصيد', kind: 'number' },
            { header: 'القيمة', kind: 'money' },
            { header: 'أقدم دفعة بالأيام', kind: 'number' },
            { header: 'تغطية بالأيام', kind: 'number' },
            { header: 'راكد', kind: 'text' },
          ],
          rows: data.by_item.map((i) => [
            i.name,
            i.unit_of_measure,
            i.on_hand,
            i.capital,
            i.days_held,
            i.days_of_cover,
            i.is_dead_stock ? 'نعم' : 'لا',
          ]),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------

interface EmployeesData extends Period {
  team: { headcount: number; orders_served: number; revenue: number; void_rate_pct: number | null };
  employees: Array<{
    email: string | null;
    role: string | null;
    orders_served: number;
    revenue: number;
    average_order_value: number | null;
    voided_orders: number;
    void_rate_pct: number | null;
  }>;
}

const employees: ExportDefinition = {
  handler: getEmployeePerformance,
  slug: 'employees',
  title: 'أداء الفريق',
  toDocument(raw, ctx) {
    const data = raw as unknown as EmployeesData;
    return {
      ...head(data, ctx, 'أداء الفريق'),
      figures: [
        { label: 'عدد الموظفين', value: whole(data.team.headcount) },
        { label: 'الطلبات', value: whole(data.team.orders_served) },
        { label: 'الإيراد', value: money(data.team.revenue) },
        { label: 'نسبة الإلغاء', value: pct(data.team.void_rate_pct) },
      ],
      tables: [
        {
          title: 'حسب الموظف',
          columns: [
            { header: 'البريد', script: 'la', weight: 3 },
            { header: 'الطلبات', script: 'la', weight: 1 },
            { header: 'الإيراد بالجنيه', script: 'la', weight: 1.5 },
            { header: 'متوسط الفاتورة', script: 'la', weight: 1.4 },
            { header: 'نسبة الإلغاء', script: 'la', weight: 1.2 },
          ],
          rows: data.employees.map((e) => [
            e.email ?? '—',
            whole(e.orders_served),
            money(e.revenue),
            e.average_order_value === null ? '—' : money(e.average_order_value),
            pct(e.void_rate_pct),
          ]),
          emptyMessage: 'لا توجد مبيعات منسوبة لموظف',
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as EmployeesData;
    return {
      title: 'أداء الفريق',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'عدد الموظفين', value: data.team.headcount, kind: 'number' },
        { label: 'الطلبات', value: data.team.orders_served, kind: 'number' },
        { label: 'الإيراد', value: data.team.revenue, kind: 'money' },
      ],
      sheets: [
        {
          name: 'حسب الموظف',
          columns: [
            { header: 'البريد', kind: 'text' },
            { header: 'الدور', kind: 'text' },
            { header: 'الطلبات', kind: 'number' },
            { header: 'الإيراد', kind: 'money' },
            { header: 'متوسط الفاتورة', kind: 'money' },
            { header: 'طلبات ملغاة', kind: 'number' },
            { header: 'نسبة الإلغاء', kind: 'percent' },
          ],
          rows: data.employees.map((e) => [
            e.email,
            e.role,
            e.orders_served,
            e.revenue,
            e.average_order_value,
            e.voided_orders,
            pctCell(e.void_rate_pct),
          ]),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------

interface VoidsData extends Period {
  summary: { void_count: number; lost_revenue: number; ingredient_cost_lost: number; stock_returned_count: number };
  by_reason: Array<{ reason: string; void_count: number; lost_revenue: number; ingredient_cost_lost: number }>;
  by_actor: Array<{ email: string | null; void_count: number }>;
}

const voids: ExportDefinition = {
  handler: getVoids,
  slug: 'voids',
  title: 'تقرير الإلغاءات',
  toDocument(raw, ctx) {
    const data = raw as unknown as VoidsData;
    return {
      ...head(data, ctx, 'تقرير الإلغاءات'),
      figures: [
        { label: 'عدد الإلغاءات', value: whole(data.summary.void_count) },
        { label: 'إيراد لم يُحصَّل', value: money(data.summary.lost_revenue) },
        { label: 'تكلفة طعام ضائعة', value: money(data.summary.ingredient_cost_lost) },
        { label: 'أُعيد للمخزون', value: whole(data.summary.stock_returned_count) },
      ],
      tables: [
        {
          title: 'حسب السبب',
          columns: [
            { header: 'السبب', script: 'ar', weight: 3 },
            { header: 'العدد', script: 'la', weight: 1 },
            { header: 'إيراد لم يُحصَّل بالجنيه', script: 'la', weight: 1.8 },
            { header: 'تكلفة ضائعة بالجنيه', script: 'la', weight: 1.8 },
          ],
          rows: data.by_reason.map((r) => [
            voidReasonLabel(r.reason),
            whole(r.void_count),
            money(r.lost_revenue),
            money(r.ingredient_cost_lost),
          ]),
          emptyMessage: 'لم تُسجَّل إلغاءات في هذه الفترة',
        },
      ],
      footNote: FOOT,
    };
  },
  toWorkbook(raw, ctx) {
    const data = raw as unknown as VoidsData;
    return {
      title: 'تقرير الإلغاءات',
      period: periodText(data),
      organizationName: ctx.organizationName,
      figures: [
        { label: 'عدد الإلغاءات', value: data.summary.void_count, kind: 'number' },
        { label: 'إيراد لم يُحصَّل', value: data.summary.lost_revenue, kind: 'money' },
        { label: 'تكلفة طعام ضائعة', value: data.summary.ingredient_cost_lost, kind: 'money' },
      ],
      sheets: [
        {
          name: 'حسب السبب',
          columns: [
            { header: 'السبب', kind: 'text' },
            { header: 'العدد', kind: 'number' },
            { header: 'إيراد لم يُحصَّل', kind: 'money' },
            { header: 'تكلفة ضائعة', kind: 'money' },
          ],
          rows: data.by_reason.map((r) => [
            voidReasonLabel(r.reason),
            r.void_count,
            r.lost_revenue,
            r.ingredient_cost_lost,
          ]),
        },
        {
          name: 'من ألغى',
          columns: [
            { header: 'البريد', kind: 'text' },
            { header: 'عدد الإلغاءات', kind: 'number' },
          ],
          rows: data.by_actor.map((a) => [a.email ?? 'غير معروف', a.void_count]),
        },
      ],
    };
  },
};

/** Every report that can leave the building, by the name used in the URL. */
export const EXPORTS: Record<string, ExportDefinition> = {
  profitability,
  waste,
  purchasing,
  trends,
  'inventory-assets': inventoryAssets,
  employees,
  voids,
};

export const EXPORT_NAMES = Object.keys(EXPORTS);

export type { Table, Sheet };
