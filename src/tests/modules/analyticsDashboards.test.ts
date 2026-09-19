import { describe, it, expect } from 'vitest';
import { computeKPI, computeTimeseries } from '@/modules/analytics/services/kpiAggregator';
import { renderSummaryTab, clearSummaryCache } from '@/modules/analytics/tabs/SummaryTab';
import { renderActivityTab } from '@/modules/analytics/tabs/ActivityTab';
import { renderDetail, DETAIL_KEYS } from '@/modules/analytics/tabs/details';
import { Order, OrderItem, OrderStatus, PeriodCost } from '@/modules/analytics/types';
import { mskRange } from '@/utils/mpDate';

function item(over: Partial<OrderItem> = {}): OrderItem {
  const quantity = over.quantity ?? 1;
  const price = over.price ?? 1000;
  return {
    vendor_code: 'ART-1', mp_sku: '77', name: 'Товар',
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
    order_id: 'O1', date: '2026-09-15T10:00:00.000Z', mp: 'ozon',
    store_id: 'S1', store_name: 'Магазин', status, status_raw: 'delivered',
    items,
    revenue: voided ? 0 : gross,
    revenue_lost: voided ? gross : 0,
    commission: 150, logistics: 50, logistics_return: 0, services: 20,
    fee_breakdown: [], cogs: voided ? 0 : 400,
    tax: 60, net_profit: 0, payout_actual: 0,
    source: 'real', missing_cogs_count: 0, tx_ids: [], ...over,
  };
}

const now = new Date('2026-09-18T09:00:00.000Z');

const orders: Order[] = [
  order({ order_id: 'A', date: '2026-09-17T22:00:00.000Z' }),
  order({ order_id: 'B', date: '2026-09-16T08:00:00.000Z' }),
  order({ order_id: 'C', date: '2026-09-15T14:00:00.000Z', status: 'returned' }),
  order({ order_id: 'D', date: '2026-09-14T11:00:00.000Z', status: 'cancelled' }),
  order({ order_id: 'E', date: '2026-09-13T09:00:00.000Z', status: 'in_delivery' }),
  order({ order_id: 'F', date: '2026-09-18T06:00:00.000Z', mp: 'wb' }),
];
const costs: PeriodCost[] = [
  { date: '2026-09-16T09:00:00.000Z', kind: 'advertising', label: 'Реклама', amount: 700, store_id: 'S1', mp: 'ozon' },
  { date: '2026-09-17T09:00:00.000Z', kind: 'storage', label: 'Хранение', amount: 120, store_id: 'S1', mp: 'ozon' },
];

describe('дашборды рендерятся на всех периодах', () => {
  const periods: Array<[string, number]> = [
    ['Сегодня', 1], ['7 дней', 7], ['30 дней', 30],
    ['90 дней', 90], ['6 месяцев', 180], ['12 месяцев', 365],
  ];

  for (const [label, days] of periods) {
    it(`«${label}» — сводка строится и график сходится с KPI`, () => {
      const { start, end } = mskRange(days, now);
      const kpi = computeKPI(orders, costs);
      const ts  = computeTimeseries(orders, start, end, costs);

      clearSummaryCache();
      const html = renderSummaryTab(kpi, orders, ts, null);

      expect(html).toContain('Выручка');
      expect(html).toContain('Возвраты и отмены');
      expect(html.length).toBeGreaterThan(500);
      // Сетка дней соответствует периоду
      expect(ts).toHaveLength(days);
    });
  }

  it('«Сегодня» показывает ровно один день и ловит ночной заказ', () => {
    const { start, end } = mskRange(1, now);
    const ts = computeTimeseries(orders, start, end, costs);
    expect(ts).toHaveLength(1);
    expect(ts[0].date).toBe('2026-09-18');
    // Заказ A (01:00 МСК 18-го) и F (09:00 МСК 18-го) — оба сегодня
    expect(ts[0].revenue).toBe(2000);
  });
});

describe('все детальные страницы открываются', () => {
  const { start, end } = mskRange(30, now);
  const kpi = computeKPI(orders, costs);
  const ts  = computeTimeseries(orders, start, end, costs);
  const ctx = {
    kpi, prevKpi: null, orders, ts,
    periodLabel: '30 дней', mp: 'ozon' as const, storeName: 'Все магазины',
  };

  for (const key of DETAIL_KEYS) {
    it(`страница «${key}» рендерится без ошибок`, () => {
      const html = renderDetail(key, ctx);
      expect(html).toContain('an2-detail');
      expect(html).toContain('closeDetail');   // кнопка «Назад» на месте
      expect(html.length).toBeGreaterThan(300);
    });
  }

  it('пустые данные не роняют ни одну страницу', () => {
    const emptyKpi = computeKPI([], []);
    const emptyCtx = { ...ctx, kpi: emptyKpi, orders: [], ts: computeTimeseries([], start, end) };
    for (const key of DETAIL_KEYS) {
      expect(() => renderDetail(key, emptyCtx)).not.toThrow();
    }
  });
});

describe('вкладка Активность', () => {
  it('рендерится на всех подвкладках', () => {
    for (const sub of ['heatmap', 'days', 'hours', 'tips'] as const) {
      expect(() => renderActivityTab(orders, sub)).not.toThrow();
    }
  });

  it('не падает на пустых данных', () => {
    for (const sub of ['heatmap', 'days', 'hours', 'tips'] as const) {
      expect(() => renderActivityTab([], sub)).not.toThrow();
    }
  });
});
