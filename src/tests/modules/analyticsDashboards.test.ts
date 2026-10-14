import { describe, it, expect } from 'vitest';
import { computeKPI, computeTimeseries } from '@/modules/analytics/services/kpiAggregator';
import { computeSkuPerformance } from '@/modules/analytics/services/kpiAggregator';
import { renderOverview, chartSpec, OverviewInput } from '@/modules/analytics/ui/views/overview';
import { renderProducts } from '@/modules/analytics/ui/views/products';
import { renderOrders, renderOrderDrawer } from '@/modules/analytics/ui/views/orders';
import { renderSettings } from '@/modules/analytics/ui/views/settings';
import { drawTimeChart, Tooltip, niceTicks } from '@/modules/analytics/ui/charts';
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


function overview(days: number, metric: OverviewInput['metric'] = 'revenue', list = orders, pc = costs): OverviewInput {
  const { start, end } = mskRange(days, now);
  const inRange = list.filter(o => o.date >= start.toISOString() && o.date <= end.toISOString());
  const pcs = pc.filter(c => c.date >= start.toISOString() && c.date <= end.toISOString());
  return {
    kpi: computeKPI(inRange, pcs), prevKpi: null,
    ts: computeTimeseries(inRange, start, end, pcs), prevTs: null,
    orders: inRange, prevOrders: null, skus: computeSkuPerformance(inRange, pcs),
    metric, allMp: true, byMp: [],
  };
}

describe('«Обзор» на всех периодах', () => {
  const periods: Array<[string, number]> = [['Сегодня', 1], ['7 дней', 7], ['30 дней', 30], ['90 дней', 90], ['6 месяцев', 180], ['12 месяцев', 365]];
  for (const [label, days] of periods) {
    it(`«${label}»: страница строится, график сходится с плитками`, () => {
      const inp = overview(days);
      const html = renderOverview(inp);
      expect(html).toContain('Динамика');
      expect(html).toContain('Куда уходят деньги');
      const rev = chartSpec(inp).points.reduce((s, p) => s + p.y, 0);
      expect(rev).toBeCloseTo(inp.kpi.revenue, 2);
      const profit = chartSpec({ ...inp, metric: 'profit' }).points.reduce((s, p) => s + p.y, 0);
      expect(profit).toBeCloseTo(inp.kpi.net_profit, 2);
    });
  }

  it('длинный период группируется по неделям, сумма не теряется', () => {
    const inp = overview(180);
    const spec = chartSpec(inp);
    expect(spec.points.length).toBeLessThanOrEqual(27);
    expect(spec.points.reduce((s, p) => s + p.y, 0)).toBeCloseTo(inp.kpi.revenue, 2);
  });

  it('график заказов считает заказы по дате заказа', () => {
    const inp = overview(7, 'orders');
    expect(chartSpec(inp).points.reduce((s, p) => s + p.y, 0)).toBe(inp.orders.length);
  });

  it('пустые данные не роняют ни одну вкладку', () => {
    const inp = overview(30, 'revenue', [], []);
    expect(renderOverview(inp)).toContain('Нет выкупленной выручки');
    expect(renderProducts([], { search: '', sort: 'profit', dir: -1, limit: 100 })).toContain('Нет товаров');
    expect(renderOrders([], { status: 'all', search: '', limit: 100 })).toContain('Заказов не найдено');
  });
});

describe('вкладки «Товары», «Заказы», настройки', () => {
  it('товары: поиск, сортировка, ABC', () => {
    const skus = computeSkuPerformance(orders, costs);
    const html = renderProducts(skus, { search: 'art', sort: 'revenue', dir: -1, limit: 100 });
    expect(html).toContain('ART-1');
    expect(html).toMatch(/an-abc A/);
    expect(renderProducts(skus, { search: 'нет-такого', sort: 'profit', dir: -1, limit: 100 })).toContain('Нет товаров');
  });

  it('заказы: фильтр по статусу и карточка заказа', () => {
    const html = renderOrders(orders, { status: 'returned', search: '', limit: 100 });
    expect(html).toContain('>C<');
    expect(html).not.toContain('>A<');
    const drawer = renderOrderDrawer(orders[0]);
    expect(drawer).toContain('Деньги по заказу');
  });

  it('настройки открываются на каждой секции', () => {
    const base = { stores: [{ id: 'S1', name: 'Магазин', mp: 'ozon' as const, tax_model: 'usn6' as const, tax_rate: 0.06, fulfillment: null }],
      manual: [], missingCogs: [], ozon: [{ id: 'S1', name: 'Магазин', perf: false }], perfStatus: new Map() };
    for (const section of ['tax', 'cogs', 'ads', 'manual'] as const) {
      expect(renderSettings({ ...base, section })).toContain('Настройки аналитики');
    }
  });
});

describe('график времени', () => {
  it('рисует столбец на каждый день и подписи оси', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const tip = new Tooltip(document.body);
    const spec = chartSpec(overview(7));
    drawTimeChart(host, spec, tip);
    expect(host.querySelectorAll('.an-col')).toHaveLength(spec.points.length);
    expect(host.querySelectorAll('.an-hit')).toHaveLength(spec.points.length);
    expect(host.querySelectorAll('.an-tick').length).toBeGreaterThan(2);
    tip.destroy();
  });

  it('деления оси круглые и покрывают диапазон', () => {
    expect(niceTicks(0, 87000)).toEqual([0, 25000, 50000, 75000, 100000]);
    const t = niceTicks(-1200, 3400);
    expect(t[0]).toBeLessThanOrEqual(-1200);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(3400);
    expect(t).toContain(0);
  });
});

import { productCell } from '@/modules/analytics/ui/product';

describe('товар в списках: название, артикул, копирование, переход', () => {
  it('показывает артикул, две кнопки копирования и ссылку в «Товары»', () => {
    const html = productCell({ name: 'Футболка «Кот»', vendor_code: "TS-'CAT", mp: 'ozon' });
    expect(html).toContain('TS-');
    expect(html.match(/title="Скопировать (артикул|название)"/g)).toHaveLength(2);
    expect(html).toContain("goToProduct('TS-\\&#39;CAT')");
    expect(html).toContain('Футболка «Кот»');
  });

  it('используется во всех вкладках', () => {
    const skus = computeSkuPerformance(orders, costs);
    expect(renderProducts(skus, { search: '', sort: 'profit', dir: -1, limit: 100 })).toContain('goToProduct(');
    expect(renderOrders(orders, { status: 'all', search: '', limit: 100 })).toContain('goToProduct(');
    expect(renderOrderDrawer(orders[0])).toContain('goToProduct(');
    expect(renderOverview(overview(30))).toContain('goToProduct(');
  });
});
