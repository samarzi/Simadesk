import { describe, it, expect } from 'vitest';
import { computeKPI, computeTimeseries, computeSkuPerformance } from '@/modules/analytics/services/kpiAggregator';
import { Order, OrderItem, OrderStatus, PeriodCost, ManualEntry } from '@/modules/analytics/types';

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
  const gross = items.reduce((s, i) => s + i.revenue, 0);
  const voided = status === 'returned' || status === 'cancelled';
  return {
    order_id: 'O1', date: '2026-08-01T10:00:00.000Z', mp: 'ozon',
    store_id: 'S1', store_name: 'Магазин', status, status_raw: '',
    items,
    revenue: voided ? 0 : gross,
    revenue_lost: voided ? gross : 0,
    commission: 150, logistics: 50, logistics_return: 0, services: 0,
    fee_breakdown: [], cogs: voided ? 0 : 400,
    tax: 0, net_profit: 0, payout_actual: 0,
    source: 'real', missing_cogs_count: 0, tx_ids: [],
    ...over,
  };
}

function periodCost(over: Partial<PeriodCost> = {}): PeriodCost {
  return {
    date: '2026-08-01T00:00:00.000Z', kind: 'advertising', label: 'Реклама',
    amount: 500, store_id: 'S1', mp: 'ozon', ...over,
  };
}

function manual(over: Partial<ManualEntry> = {}): ManualEntry {
  return {
    id: 'm1', type: 'advertising', amount: 300, currency: 'RUB',
    amount_native: 300, fx_rate: 1, date: '2026-08-01T00:00:00.000Z',
    description: '', created_at: '', ...over,
  };
}

describe('база расчёта', () => {
  it('выкупленный заказ без финотчёта не попадает в выручку', () => {
    // Раньше такие заказы либо выбрасывались вместе со счётчиками, либо им
    // дорисовывали «среднюю» комиссию. И то и другое врёт продавцу.
    const k = computeKPI([
      order({ order_id: 'A', source: 'real' }),
      order({ order_id: 'B', source: 'estimated', pending_settlement: true }),
    ]);
    expect(k.revenue).toBe(1000);
    expect(k.awaiting_orders).toBe(1);
    expect(k.awaiting_revenue).toBe(1000);
    expect(k.orders_delivered).toBe(2);       // в объёме заказ виден
    expect(k.commission).toBe(150);           // но его удержания не выдуманы
  });

  it('в выручку попадают только выкупленные заказы', () => {
    const k = computeKPI([
      order({ order_id: 'A' }),
      order({ order_id: 'B', status: 'in_delivery' }),
    ]);
    expect(k.revenue).toBe(1000);
    expect(k.ordered_revenue).toBe(2000);
    expect(k.in_transit_revenue).toBe(1000);
  });

  it('заказ в пути не приносит ни выручки, ни расходов', () => {
    const k = computeKPI([order({ order_id: 'B', status: 'processing' })]);
    expect(k.revenue).toBe(0);
    expect(k.commission).toBe(0);
    expect(k.total_expenses).toBe(0);
    expect(k.net_profit).toBe(0);
  });

  it('возврат не вычитается из выручки повторно, но его удержания остаются', () => {
    const k = computeKPI([
      order({ order_id: 'A' }),
      order({ order_id: 'B', status: 'returned', logistics_return: 90 }),
    ]);
    expect(k.revenue).toBe(1000);
    expect(k.returns_revenue).toBe(1000);
    expect(k.commission).toBe(300);           // удержания по обоим заказам
    expect(k.logistics).toBe(190);            // 50 + 50 + 90 обратной
  });

  it('единицы считаются только по выкупленному', () => {
    const k = computeKPI([
      order({ order_id: 'A', items: [item({ quantity: 3 })] }),
      order({ order_id: 'B', status: 'processing', items: [item({ quantity: 5 })] }),
      order({ order_id: 'C', status: 'returned', items: [item({ quantity: 7 })] }),
    ]);
    expect(k.units_sold).toBe(3);
  });
});

describe('расходы периода', () => {
  it('реклама и хранение попадают в расходы', () => {
    const k = computeKPI([order()], [periodCost({ amount: 500 }), periodCost({ kind: 'storage', amount: 200 })]);
    expect(k.period_costs).toBe(700);
    expect(k.total_expenses).toBe(150 + 50 + 400 + 700);
    expect(k.period_costs_breakdown.map(b => b.kind)).toEqual(['advertising', 'storage']);
  });

  it('ручные расходы пользователя учитываются, доход уменьшает их', () => {
    const k = computeKPI([order()], [], [manual({ amount: 300 }), manual({ id: 'm2', type: 'other_income', amount: 100 })]);
    expect(k.manual_costs).toBe(200);
  });

  it('компенсация от МП уменьшает расходы периода', () => {
    const k = computeKPI([order()], [periodCost({ kind: 'penalty', amount: -400 })]);
    expect(k.period_costs).toBe(-400);
  });
});

describe('сходимость', () => {
  it('выручка − расходы = чистая прибыль', () => {
    const k = computeKPI(
      [order({ order_id: 'A' }), order({ order_id: 'B', status: 'returned' })],
      [periodCost()], [manual()],
    );
    const sum = k.commission + k.logistics + k.services + k.cogs + k.tax + k.period_costs + k.manual_costs;
    expect(k.total_expenses).toBeCloseTo(sum, 6);
    expect(k.net_profit).toBeCloseTo(k.revenue - k.total_expenses, 6);
  });

  it('график сходится с карточками до копейки', () => {
    // Главная защита от «аналитика обманывает»: если сумма ряда по дням
    // не равна KPI, пользователь видит два разных ответа на один вопрос.
    const orders = [
      order({ order_id: 'A', date: '2026-08-01T10:00:00.000Z' }),
      order({ order_id: 'B', date: '2026-08-02T10:00:00.000Z', status: 'returned', logistics_return: 90 }),
      order({ order_id: 'C', date: '2026-08-03T10:00:00.000Z', status: 'in_delivery' }),
      order({ order_id: 'D', date: '2026-08-03T11:00:00.000Z', status: 'cancelled' }),
      order({ order_id: 'E', date: '2026-08-04T10:00:00.000Z', source: 'estimated', pending_settlement: true }),
    ];
    const costs = [periodCost({ date: '2026-08-02T00:00:00.000Z', amount: 500 })];
    const manuals = [manual({ date: '2026-08-03T00:00:00.000Z', amount: 300 })];
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to   = new Date('2026-08-05T23:59:59.999Z');

    const k = computeKPI(orders, costs, manuals);
    const ts = computeTimeseries(orders, from, to, costs, manuals);

    const sum = (f: (p: { revenue: number; expenses: number; profit: number }) => number) =>
      ts.reduce((s, p) => s + f(p), 0);

    expect(sum(p => p.revenue)).toBeCloseTo(k.revenue, 6);
    expect(sum(p => p.expenses)).toBeCloseTo(k.total_expenses, 6);
    expect(sum(p => p.profit)).toBeCloseTo(k.net_profit, 6);
  });

  it('покрытие финотчётом не может превысить 100% из-за orphan-строк', () => {
    const k = computeKPI([
      order({ order_id: 'A', source: 'real' }),
      order({ order_id: 'X', source: 'real', is_orphan: true }),
      order({ order_id: 'Y', source: 'real', is_orphan: true }),
    ]);
    expect(k.source_real_pct).toBeLessThanOrEqual(100);
  });

  it('источник данных не понижается из-за пустой себестоимости', () => {
    const k = computeKPI([order({ source: 'real', missing_cogs_count: 3 })]);
    expect(k.source_real_pct).toBe(100);
    expect(k.missing_cogs_orders).toBe(1);
  });
});

describe('computeSkuPerformance', () => {
  it('возврат не уводит проданные единицы в минус', () => {
    const skus = computeSkuPerformance([order({ order_id: 'R', status: 'returned' })]);
    expect(skus[0].units_sold).toBe(0);
    expect(skus[0].revenue).toBe(0);
    expect(skus[0].net_profit).toBeLessThan(0);
  });

  it('заказы в пути не попадают в разбивку по товарам', () => {
    const skus = computeSkuPerformance([order({ order_id: 'B', status: 'processing' })]);
    expect(skus).toHaveLength(0);
  });
});
