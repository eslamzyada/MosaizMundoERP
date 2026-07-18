import type { BadgeVariant } from '../components/ui/Badge';
import type { OrderStatus } from '../types';

// Single source of truth mapping an order status to its Arabic label and the
// Badge variant used to render it (shared by Orders and Dashboard).
export const ORDER_STATUS_META: Record<OrderStatus, { label: string; variant: BadgeVariant }> = {
  completed: { label: 'مكتمل', variant: 'success' },
  voided: { label: 'ملغى', variant: 'destructive' },
};
