import { describe, it, expect } from 'vitest';
import { computeKPI, computeTimeseries, computeSkuPerformance } from '@/modules/analytics/services/kpiAggregator';
import { Order, OrderItem, OrderStatus } from '@/modules/analytics/types';

function item(over: Partial<OrderItem> = {}): OrderItem {
  const quantity = over.quantity ?? 1;
  const price = over.price ?? 1000;
  return {
    vendor_code: 'ART-1', mp_sku: '', name: 'Товар',
    quantity, price, revenue: price * quantity,
    cost_price: 400, cogs: 400 * quantity, net_profit: 0,
    ...over,
  };
}

function order(over: Partial<Order> = {}): Order {
  const status: OrderStatus = over.status ?? 'delivered';
  const items = over.items ?? [item()];
  const revenue = status === 'returned' || status === 'cancelled' ? 0 : items.reduce((s, i) => s + i.revenue, 0);
  return {
    order_id: 'O1', date: '2026-08-01T10:00:00.000Z', mp: 'ozon',
    store_id: 'S1', store_name: 'Магазин', status, status_raw: '',
    items,
    revenue,
    revenue_lost: revenue === 0 ? items.reduce((s, i) => s + i.revenue, 0) : 0,
    commission: 150, logistics: 50, logistics_return: 0, services: 0,
    fee_breakdown: [], cogs: status === 'returned' || status === 'cancelled' ? 0 : 400,
    tax: 0, net_profit: 0, payout_actual: 0,
    source: 'real', missing_cogs_count: 0, tx_ids: [],
    ...over,
  };
}

describe('computeKPI', () => {
  it('не вычитает возврат повторно из выручки', () => {
    // Продажа и возврат за один период: возвращённый заказ вообще не попадал
    // в выручку, поэтому вычитать его ещё раз нельзя — иначе выручка уходит в минус.
    const k = computeKPI([
      order({ order_id: 'A' }),
      order({ order_id: 'B', status: 'returned' }),
    ]);
    expect(k.revenue).toBe(1000);
    expect(k.returns_revenue).toBe(1000);   // упущенная выручка видна отдельно
    expect(k.orders_returned).toBe(1);
  });

  it('показывает упущенную выручку отмен', () => {
    const k = computeKPI([order({ order_id: 'C', status: 'cancelled' })]);
    expect(k.revenue).toBe(0);
    expect(k.cancelled_revenue).toBe(1000);
    expect(k.orders_cancelled).toBe(1);
  });

  it('учитывает заказы без финотчёта в деньгах, а не только в счётчиках', () => {
    // Раньше pending-заказы выбрасывались из сумм, но считались в «доставлено» —
    // выручка не сходилась с количеством заказов.
    const k = computeKPI([
      order({ order_id: 'A' }),
      order({ order_id: 'B', pending_settlement: true, fees_estimated: true, source: 'estimated' }),
    ]);
    expect(k.orders_delivered).toBe(2);
    expect(k.revenue).toBe(2000);
    expect(k.orders_estimated).toBe(1);
    expect(k.estimated_revenue_pct).toBeCloseTo(50, 5);
  });

  it('source_real_pct отражает финотчёт, а не наличие себестоимости', () => {
    const k = computeKPI([
      order({ order_id: 'A', source: 'real', missing_cogs_count: 3 }),
      order({ order_id: 'B', source: 'real' }),
    ]);
    expect(k.source_real_pct).toBe(100);
    expect(k.missing_cogs_orders).toBe(1);
  });

  it('средний чек считается по доставленным заказам', () => {
    const k = computeKPI([
      order({ order_id: 'A' }),
      order({ order_id: 'B', status: 'processing' }),
    ]);
    expect(k.avg_check).toBe(1000);
    expect(k.revenue).toBe(2000); // в работе тоже входит в выручку
  });

  it('% выкупа считается от закрытых заказов', () => {
    const k = computeKPI([
      order({ order_id: 'A' }),
      order({ order_id: 'B' }),
      order({ order_id: 'C', status: 'returned' }),
      order({ order_id: 'D', status: 'processing' }), // ещё не закрыт — в расчёт не идёт
    ]);
    expect(k.buyout_pct).toBeCloseTo(66.666, 2);
  });

  it('P&L сходится: выручка − расходы = чистая прибыль', () => {
    const k = computeKPI([order({ order_id: 'A' }), order({ order_id: 'B' })]);
    expect(k.total_expenses).toBe(k.commission + k.logistics + k.services + k.cogs + k.tax);
    expect(k.net_profit).toBeCloseTo(k.revenue - k.total_expenses, 6);
  });
});

describe('computeTimeseries', () => {
  it('не теряет дни заказов без финотчёта', () => {
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to   = new Date('2026-08-02T23:59:59.999Z');
    const ts = computeTimeseries([
      order({ order_id: 'A', date: '2026-08-01T09:00:00.000Z' }),
      order({ order_id: 'B', date: '2026-08-02T09:00:00.000Z', pending_settlement: true, fees_estimated: true }),
    ], from, to);
    expect(ts).toHaveLength(2);
    expect(ts[0].revenue).toBe(1000);
    expect(ts[1].revenue).toBe(1000);
  });

  it('возврат уходит в расходы дня, а не в нулевую выручку', () => {
    const d = new Date('2026-08-01T00:00:00.000Z');
    const ts = computeTimeseries([order({ order_id: 'R', status: 'returned' })], d, d);
    expect(ts[0].revenue).toBe(0);
    expect(ts[0].expenses).toBeGreaterThanOrEqual(1000);
  });
});

describe('computeSkuPerformance', () => {
  it('возврат не уводит проданные единицы и выручку в минус', () => {
    const skus = computeSkuPerformance([order({ order_id: 'R', status: 'returned' })]);
    expect(skus).toHaveLength(1);
    expect(skus[0].units_sold).toBe(0);
    expect(skus[0].revenue).toBe(0);
    expect(skus[0].net_profit).toBeLessThan(0); // остались расходы на логистику возврата
  });

  it('считает товары из заказов без финотчёта', () => {
    const skus = computeSkuPerformance([
      order({ order_id: 'B', pending_settlement: true, fees_estimated: true }),
    ]);
    expect(skus).toHaveLength(1);
    expect(skus[0].units_sold).toBe(1);
    expect(skus[0].revenue).toBe(1000);
  });
});
