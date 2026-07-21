import type { OrderRepository } from './OrderRepository';
import type { Order, OrderItem, OrderStatus } from '../types';

const ORG = 'org-00000000-0000-4000-8000-000000000001';

// Builds a shape-accurate order_item from just the fields the view needs.
function item(orderId: string, seq: number, sellableId: string, quantity: number, unitPrice: number): OrderItem {
  return {
    id: `${orderId}-item-${seq}`,
    order_id: orderId,
    organization_id: ORG,
    sellable_item_id: sellableId,
    quantity,
    unit_price: unitPrice,
    created_at: '2026-07-12T10:00:00.000Z',
    updated_at: '2026-07-12T10:00:00.000Z',
  };
}

function order(
  id: string,
  coid: string,
  status: OrderStatus,
  total: number,
  createdAt: string,
  items: OrderItem[],
): Order {
  return {
    id,
    organization_id: ORG,
    client_offline_id: coid,
    status,
    total_amount: total,
    created_at: createdAt,
    updated_at: createdAt,
    order_items: items,
  };
}

const MOCK_ORDERS: Order[] = [
  order(
    'o1a2b3c4-0000-4000-8000-000000000001',
    'c0000001-0000-4000-8000-000000000001',
    'completed',
    45.0,
    '2026-07-12T12:41:00.000Z',
    [
      item('o1a2b3c4-0000-4000-8000-000000000001', 1, 's-burger', 2, 18.0),
      item('o1a2b3c4-0000-4000-8000-000000000001', 2, 's-cola', 1, 9.0),
    ],
  ),
  order(
    'o2b3c4d5-0000-4000-8000-000000000002',
    'c0000002-0000-4000-8000-000000000002',
    'completed',
    78.5,
    '2026-07-12T13:07:00.000Z',
    [
      item('o2b3c4d5-0000-4000-8000-000000000002', 1, 's-shawarma', 1, 12.5),
      item('o2b3c4d5-0000-4000-8000-000000000002', 2, 's-burger', 1, 18.0),
      item('o2b3c4d5-0000-4000-8000-000000000002', 3, 's-juice', 2, 24.0),
    ],
  ),
  order(
    'o3c4d5e6-0000-4000-8000-000000000003',
    'c0000003-0000-4000-8000-000000000003',
    'voided',
    22.0,
    '2026-07-12T13:52:00.000Z',
    [item('o3c4d5e6-0000-4000-8000-000000000003', 1, 's-shawarma', 1, 22.0)],
  ),
  order(
    'o4d5e6f7-0000-4000-8000-000000000004',
    'c0000004-0000-4000-8000-000000000004',
    'completed',
    130.75,
    '2026-07-12T14:20:00.000Z',
    [
      item('o4d5e6f7-0000-4000-8000-000000000004', 1, 's-burger', 3, 54.0),
      item('o4d5e6f7-0000-4000-8000-000000000004', 2, 's-falafel', 2, 14.0),
      item('o4d5e6f7-0000-4000-8000-000000000004', 3, 's-juice', 1, 12.0),
    ],
  ),
  order(
    'o5e6f7a8-0000-4000-8000-000000000005',
    'c0000005-0000-4000-8000-000000000005',
    'voided',
    15.5,
    '2026-07-12T15:03:00.000Z',
    [
      item('o5e6f7a8-0000-4000-8000-000000000005', 1, 's-cola', 1, 9.0),
      item('o5e6f7a8-0000-4000-8000-000000000005', 2, 's-falafel', 1, 6.5),
    ],
  ),
  order(
    'o6f7a8b9-0000-4000-8000-000000000006',
    'c0000006-0000-4000-8000-000000000006',
    'completed',
    60.0,
    '2026-07-12T15:48:00.000Z',
    [
      item('o6f7a8b9-0000-4000-8000-000000000006', 1, 's-burger', 2, 36.0),
      item('o6f7a8b9-0000-4000-8000-000000000006', 2, 's-juice', 2, 24.0),
    ],
  ),
];

export class MockOrderRepository implements OrderRepository {
  getOrders(): Promise<Order[]> {
    // A short delay simulates network latency so loading states are exercised.
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_ORDERS), 400);
    });
  }

  voidOrder(orderId: string): Promise<void> {
    const order = MOCK_ORDERS.find((o) => o.id === orderId);
    if (order) {
      order.status = 'voided';
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }
}
