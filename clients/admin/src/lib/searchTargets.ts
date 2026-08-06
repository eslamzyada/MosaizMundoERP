import type { Capability } from '../session/SessionProvider';

/**
 * Everywhere the search box can send you.
 *
 * There are two kinds of destination and they are found in completely
 * different ways, which is why they live in one file: a PAGE is known at build
 * time and filtered instantly as you type, a RECORD has to be asked for. The
 * palette shows both in one list because the person typing does not care which
 * is which — they typed "طماطم" and want the ingredient, or "الشعار" and want
 * the settings page.
 *
 * The sidebar imports DESTINATIONS from here too. It used to hold its own copy
 * of the list; two copies is one copy that gets forgotten, and a page missing
 * from the search box is invisible in a way nobody reports.
 */

export interface Destination {
  to: string;
  label: string;
  /** react-router `end` — only the dashboard needs an exact match. */
  end: boolean;
  /** Hides a page a role cannot use at all. Presentation, not enforcement. */
  capability?: Capability;
  /**
   * Other words that should find this page. Half of these are what the page
   * is FOR rather than what it is called — somebody looking for the logo does
   * not know it lives under settings.
   */
  keywords?: string[];
}

export const DESTINATIONS: Destination[] = [
  { to: '/dashboard', label: 'لوحة التحكم', end: true, keywords: ['الرئيسية', 'ملخص', 'dashboard'] },
  { to: '/floor', label: 'الصالة', end: false, keywords: ['الطاولات', 'النادل', 'floor', 'tables'] },
  { to: '/kitchen', label: 'المطبخ', end: false, keywords: ['التحضير', 'الطلبات', 'kitchen', 'pass'] },
  { to: '/till', label: 'نقطة البيع', end: false, keywords: ['الكاشير', 'till', 'pos'] },
  { to: '/menu', label: 'القائمة', end: false, keywords: ['الأصناف', 'الأسعار', 'menu'] },
  { to: '/orders', label: 'الطلبات', end: false, keywords: ['الفواتير', 'المبيعات', 'orders'] },
  { to: '/schedule', label: 'الورديات', end: false, keywords: ['الجدول', 'الحضور', 'الانصراف', 'الدوام', 'shifts', 'rota', 'schedule'] },
  { to: '/reservations', label: 'الحجوزات', end: false, keywords: ['الطاولات', 'حجز', 'الضيوف', 'booking', 'reservations', 'tables'] },
  { to: '/online-orders', label: 'الطلبات أونلاين', end: false, keywords: ['أونلاين', 'الزبائن', 'دليفري', 'online', 'delivery', 'storefront'] },
  {
    to: '/inventory',
    label: 'المخزون',
    end: false,
    keywords: ['المكوّنات', 'الهالك', 'التوالف', 'inventory'],
  },
  { to: '/stocktake', label: 'الجرد', end: false, keywords: ['العدّ', 'stocktake'] },
  { to: '/suppliers', label: 'المورّدون', end: false, keywords: ['الأسعار', 'suppliers'] },
  {
    to: '/purchase-orders',
    label: 'أوامر الشراء',
    end: false,
    keywords: ['التوريد', 'الاستلام', 'purchase'],
  },
  { to: '/printers', label: 'الطابعات', end: false, keywords: ['المطبخ', 'الكاشير', 'printers'] },
  {
    to: '/settings',
    label: 'الإعدادات',
    end: false,
    keywords: ['المظهر', 'الوضع الداكن', 'حجم الخط', 'الشعار', 'settings', 'theme'],
  },
  { to: '/recipes', label: 'الوصفات', end: false, keywords: ['المكوّنات', 'التكلفة', 'recipes'] },
  // Financial reporting is the one page a cashier cannot read at all, so it is
  // hidden rather than offered and then refused.
  {
    to: '/reports',
    label: 'الأرباح',
    end: false,
    capability: 'view_finance',
    keywords: ['التقارير', 'الهدر', 'الربحية', 'reports'],
  },
  {
    to: '/insights',
    label: 'المؤشرات',
    end: false,
    capability: 'view_finance',
    keywords: ['الرسوم', 'البيانات', 'التحليلات', 'المشتريات', 'الفواتير', 'charts', 'insights'],
  },
  { to: '/members', label: 'الفريق', end: false, keywords: ['الموظفون', 'التقييم', 'members'] },
];

/** The kinds the API can return. Mirrors SEARCH_KINDS in search.controller.ts. */
export type SearchKind =
  | 'menu_item'
  | 'ingredient'
  | 'supplier'
  | 'member'
  | 'purchase_order'
  | 'order'
  | 'printer';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  label: string;
  detail: string | null;
}

/** Which page a record lives on, and what to call its kind on the chip. */
const KIND_TARGETS: Record<SearchKind, { route: string; label: string }> = {
  menu_item: { route: '/menu', label: 'صنف' },
  ingredient: { route: '/inventory', label: 'مكوّن' },
  supplier: { route: '/suppliers', label: 'مورّد' },
  member: { route: '/members', label: 'موظف' },
  purchase_order: { route: '/purchase-orders', label: 'أمر شراء' },
  order: { route: '/orders', label: 'طلب' },
  printer: { route: '/printers', label: 'طابعة' },
};

/**
 * The route for a hit, or null for a kind this build has never heard of.
 *
 * Null rather than a crash on purpose. The API is deployed separately from the
 * admin, so a newer server WILL one day return a kind added after this bundle
 * was built. An unguarded lookup here would read `undefined.route` and take
 * the whole palette down — the same shape of failure as the order status that
 * blanked the dashboard. One unknown row is worth skipping; the screen is not.
 */
export function hitPath(hit: { kind: string; id: string }): string | null {
  const target = KIND_TARGETS[hit.kind as SearchKind];
  if (!target) return null;
  return `${target.route}?focus=${encodeURIComponent(hit.id)}`;
}

/** The chip text for a hit, or null for an unknown kind. */
export function kindLabel(kind: string): string | null {
  return KIND_TARGETS[kind as SearchKind]?.label ?? null;
}

/** Drops anything this build cannot route, so the rest of the list still works. */
export function routableHits(hits: SearchHit[]): SearchHit[] {
  return hits.filter((hit) => hitPath(hit) !== null);
}

/**
 * The pages matching what has been typed, in the order they appear in the
 * sidebar. Matching is deliberately generous — a label OR any keyword, case
 * insensitive — because the cost of an extra page in the list is one line, and
 * the cost of a missing one is somebody concluding the search does not work.
 */
export function matchDestinations(
  term: string,
  can: (capability: Capability) => boolean,
): Destination[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return [];
  return DESTINATIONS.filter((d) => !d.capability || can(d.capability)).filter(
    (d) =>
      d.label.toLowerCase().includes(needle) ||
      (d.keywords ?? []).some((k) => k.toLowerCase().includes(needle)),
  );
}
