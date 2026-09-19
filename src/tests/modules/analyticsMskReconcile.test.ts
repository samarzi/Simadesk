import { describe, it, expect } from 'vitest';
import { computeKPI, computeTimeseries } from '@/modules/analytics/services/kpiAggregator';
import { Order, OrderItem, OrderStatus, PeriodCost } from '@/modules/analytics/types';
import { mskRange } from '@/utils/mpDate';

function item(over: Partial<OrderItem> = {}): OrderItem {
  const quantity = over.quantity ?? 1;
  const price = over.price ?? 1000;
  return {
    vendor_code: 'ART-1', mp_sku: '', name: 'Товар',
    quantity, price, revenue: price * quantity,
    cost_price: 400, cogs: 400 * quantity, net_profit: 0, ...over,
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
    source: 'real', missing_cogs_count: 0, tx_ids: [], ...over,
  };
}

describe('график сходится с KPI на московских сутках', () => {
  const now = new Date('2026-09-18T09:00:00.000Z');

  it('ночной заказ попадает в столбец своего московского дня', () => {
    const { start, end } = mskRange(1, now);
    // 01:00 МСК 18 сентября — по UTC это ещё 17-е
    const orders = [order({ order_id: 'N1', date: '2026-09-17T22:00:00.000Z' })];
    const ts = computeTimeseries(orders, start, end);

    expect(ts).toHaveLength(1);
    expect(ts[0].date).toBe('2026-09-18');
    expect(ts[0].revenue).toBe(1000);
  });

  it('сумма ряда точно равна выручке и расходам из KPI', () => {
    const { start, end } = mskRange(7, now);
    const orders = [
      order({ order_id: 'A', date: '2026-09-17T22:00:00.000Z' }), // ночь по МСК
      order({ order_id: 'B', date: '2026-09-15T12:00:00.000Z' }),
      order({ order_id: 'C', date: '2026-09-14T05:00:00.000Z' }),
      order({ order_id: 'D', date: '2026-09-16T20:30:00.000Z' }), // 23:30 МСК
    ];
    const costs: PeriodCost[] = [
      { date: '2026-09-16T09:00:00.000Z', kind: 'advertising', label: 'Реклама', amount: 700, store_id: 'S1', mp: 'ozon' },
    ];

    const kpi = computeKPI(orders, costs);
    const ts  = computeTimeseries(orders, start, end, costs);

    const sumRev = ts.reduce((s, p) => s + p.revenue, 0);
    const sumExp = ts.reduce((s, p) => s + p.expenses, 0);

    expect(sumRev).toBeCloseTo(kpi.revenue, 6);
    expect(sumExp).toBeCloseTo(kpi.total_expenses, 6);
  });

  it('сетка «Сегодня» — ровно один день', () => {
    const { start, end } = mskRange(1, now);
    const ts = computeTimeseries([], start, end);
    expect(ts.map(p => p.date)).toEqual(['2026-09-18']);
  });

  it('сетка 7 дней — семь последовательных московских дат', () => {
    const { start, end } = mskRange(7, now);
    const ts = computeTimeseries([], start, end);
    expect(ts.map(p => p.date)).toEqual([
      '2026-09-12', '2026-09-13', '2026-09-14',
      '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
    ]);
  });

  it('расход периода ложится в свой московский день', () => {
    const { start, end } = mskRange(2, now);
    const costs: PeriodCost[] = [
      // 22:00 UTC 17-го = 01:00 МСК 18-го
      { date: '2026-09-17T22:00:00.000Z', kind: 'storage', label: 'Хранение', amount: 300, store_id: 'S1', mp: 'ozon' },
    ];
    const ts = computeTimeseries([], start, end, costs);
    const day18 = ts.find(p => p.date === '2026-09-18');
    expect(day18?.expenses).toBe(300);
    expect(ts.find(p => p.date === '2026-09-17')?.expenses).toBe(0);
  });
});
