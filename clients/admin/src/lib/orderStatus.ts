import type { BadgeVariant } from '../components/ui/Badge';
import type { OrderStatus } from '../types';

// Single source of truth mapping an order status to its Arabic label and the
// Badge variant used to render it (shared by Orders and Dashboard).
//
// 'open' was added by migration 0029 and NOT added here, which blanked the
// entire admin the first time a real open tab existed: the lookup returned
// undefined, reading .label off it threw during render, and with no error
// boundary React unmounted the whole tree. TypeScript did not catch it because
// the API response is cast to Order rather than validated, so the compiler was
// checking against a union that had quietly become a lie.
export const ORDER_STATUS_META: Record<OrderStatus, { label: string; variant: BadgeVariant }> = {
  // A table still eating. Deliberately not a warning colour: an open tab is the
  // normal middle of service, not something wrong.
  open: { label: 'مفتوح', variant: 'twilight' },
  completed: { label: 'مكتمل', variant: 'success' },
  voided: { label: 'ملغى', variant: 'destructive' },
};

/**
 * The label and colour for a status — for ANY string the server sends.
 *
 * Use this rather than indexing ORDER_STATUS_META directly. That map is only as
 * current as the last person who remembered to update it, and a status added in
 * a migration but forgotten here used to take the whole page down. An
 * unrecognised status now shows its own name in a neutral badge: mildly ugly,
 * honest, and the rest of the screen keeps working.
 */
export function orderStatusMeta(status: string): { label: string; variant: BadgeVariant } {
  return ORDER_STATUS_META[status as OrderStatus] ?? { label: status, variant: 'neutral' };
}
