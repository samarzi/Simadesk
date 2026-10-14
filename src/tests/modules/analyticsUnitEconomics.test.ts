import { describe, it, expect } from 'vitest';
import { computeUnitEconomics, DEFAULT_UNIT_SETTINGS, UnitEconInput } from '@/modules/analytics/services/unitEconomics';
import { aggregatePerfSpend, parsePerfNumber, campaignGroup } from '@/services/ozonPerformanceApi';
import { Order, OrderStatus } from '@/modules/analytics/types';

function order(id: string, status: OrderStatus, over: Partial<Order> = {}): Order {
  const voided = status === 'returned' || status === 'cancelled';
  return {
    order_id: id, order_key: id, date: '2026-10-14T10:00:00.000Z', mp: 'ozon',
    store_id: 'S1', store_name: 'S', status, status_raw: '',
    items: [{ vendor_code: 'A', mp_sku: '111', name: 'Футболка', quantity: 1, price: 1000,
      revenue: voided ? 1000 : 1000, cost_price: 400, cogs: voided ? 0 : 400, net_profit: 0 }],
    revenue: voided ? 0 : 1000, revenue_lost: voided ? 1000 : 0,
    commission: 0, logistics: 0, logistics_return: 0, services: 0,
    fee_breakdown: [], cogs: voided ? 0 : 400, tax: 0, net_profit: 0, payout_actual: 0,
    source: 'real', missing_cogs_count: 0, tx_ids: [],
    ...over,
  };
}

// История: 20 выкупов с полным финотчётом и 5 возвратов по 50 ₽ удержаний
const history: Order[] = [
  ...Array.from({ length: 20 }, (_, i) => order(`H${i}`, 'delivered', {
    commission: 200, logistics: 110, services: 10,
    fee_breakdown: [
      { type: 'commission', label: '', amount: 200 },
      { type: 'logistics', label: '', amount: 100 },
      { type: 'last_mile', label: '', amount: 10 },
      { type: 'acquiring', label: '', amount: 10 },
    ],
  })),
  ...Array.from({ length: 5 }, (_, i) => order(`R${i}`, 'returned', { logistics_return: 50 })),
];
const period = Array.from({ length: 10 }, (_, i) => order(`P${i}`, 'processing', { source: 'estimated' }));

const input = (over: Partial<UnitEconInput> = {}): UnitEconInput => ({
  orders: period, history, periodCosts: [],
  ads: { source: 'manual', campaigns: [], unassigned: 600 },
  taxByStore: { S1: { model: 'usn6', rate: 0.06, vat: 0 } },
  settings: { ...DEFAULT_UNIT_SETTINGS, buyoutMode: 'manual', buyoutPct: 60 },
  ...over,
});

describe('юнит-экономика', () => {
  it('считает прибыль, ROI и ДРР как на ручном расчёте', () => {
    const r = computeUnitEconomics(input());
    expect(r.orders).toBe(10);
    expect(r.orderedUnits).toBe(10);
    expect(r.orderedRevenue).toBe(10000);
    expect(r.boughtUnits).toBeCloseTo(6, 6);
    expect(r.boughtRevenue).toBeCloseTo(6000, 6);
    expect(r.ads.perOrderedUnit).toBeCloseTo(60, 6);
    expect(r.ads.perBoughtUnit).toBeCloseTo(100, 6);
    expect(r.ads.drrOrdered).toBeCloseTo(6, 6);
    expect(r.ads.drrBought).toBeCloseTo(10, 6);
    const per = Object.fromEntries(r.costs.map(c => [c.key, c.perUnit]));
    expect(per.cogs).toBeCloseTo(400, 6);
    expect(per.commission).toBeCloseTo(200, 6);
    expect(per.tax).toBeCloseTo(60, 6);
    expect(per.acquiring).toBeCloseTo(10, 6);
    expect(per.logistics).toBeCloseTo(100, 6);
    expect(per.last_mile).toBeCloseTo(10, 6);
    // 50 ₽ на невыкуп × 4 невыкупа / 6 выкупов
    expect(per.return_logistics).toBeCloseTo(50 * 4 / 6, 6);
    expect(r.profit).toBeCloseTo(520, 4);
    expect(r.profitPerUnit).toBeCloseTo(520 / 6, 4);
    expect(r.roi).toBeCloseTo(520 / 2400 * 100, 4);
  });

  it('сценарий себестоимости меняет прибыль и ROI', () => {
    const r = computeUnitEconomics(input({ settings: { ...DEFAULT_UNIT_SETTINGS, buyoutMode: 'manual', buyoutPct: 60, scenarioCost: 250 } }));
    expect(r.scenario!.profit).toBeCloseTo(520 + 150 * 6, 4);
    expect(r.scenario!.roi).toBeCloseTo((520 + 900) / 1500 * 100, 4);
  });

  it('автовыкуп берётся из истории товара', () => {
    const r = computeUnitEconomics(input({ settings: { ...DEFAULT_UNIT_SETTINGS, minSample: 20 } }));
    expect(r.buyoutPct).toBeCloseTo(20 / 25 * 100, 6);
    expect(r.skus[0].buyoutBasis).toBe('sku');
  });

  it('сумма прибыли товаров равна итогу без фактических удержаний', () => {
    const r = computeUnitEconomics(input());
    expect(r.skus.reduce((s, x) => s + x.profit, 0)).toBeCloseTo(r.profit, 6);
  });

  it('фактические штрафы вычитаются, когда пришли', () => {
    const r = computeUnitEconomics(input({ periodCosts: [{ date: '2026-10-14', kind: 'penalty', label: 'Штраф', amount: 100, store_id: 'S1', mp: 'ozon' }] }));
    expect(r.facts.penalties).toBe(100);
    expect(r.profit).toBeCloseTo(420, 4);
    expect(r.nuances.some(n => n.text.includes('Штрафы'))).toBe(false);
  });

  it('без себестоимости ROI не считается и есть предупреждение', () => {
    const noCost = period.map(o => ({ ...o, items: o.items.map(it => ({ ...it, cost_price: null })) }));
    const r = computeUnitEconomics(input({ orders: noCost }));
    expect(r.roi).toBeNull();
    expect(r.nuances.some(n => n.level === 'warn' && n.text.includes('себестоимость'))).toBe(true);
  });

  it('реклама кампании ложится на её товары', () => {
    const two = [...period, order('Q1', 'processing', { items: [{ ...period[0].items[0], vendor_code: 'B', mp_sku: '222' }] })];
    const r = computeUnitEconomics(input({
      orders: two,
      ads: { source: 'performance', unassigned: 0, campaigns: [{ title: 'K', group: 'Поиск', strategy: 'Целевые ставки', money: 500, bonus: 0, skus: ['222'] }] },
    }));
    expect(r.skus.find(s => s.vendor_code === 'B')!.ads).toBeCloseTo(500, 6);
    expect(r.skus.find(s => s.vendor_code === 'A')!.ads).toBe(0);
  });
});

describe('Ozon Performance', () => {
  it('разбирает числа с запятой и пробелами', () => {
    expect(parsePerfNumber('1 234,56')).toBeCloseTo(1234.56, 6);
    expect(parsePerfNumber(12)).toBe(12);
    expect(parsePerfNumber(null)).toBe(0);
  });

  it('группирует кампании и отделяет бонусы', () => {
    const campaigns = [
      { id: '1', title: 'Поиск', state: '', advObjectType: 'SKU', paymentType: 'CPC', placement: ['PLACEMENT_SEARCH_AND_CATEGORY'], strategy: 'TARGET_BIDS' },
      { id: '2', title: 'Везде', state: '', advObjectType: 'SKU', paymentType: 'CPC', placement: ['PLACEMENT_TOP_PROMOTION'], strategy: 'MAX_CLICKS' },
    ];
    const r = aggregatePerfSpend(campaigns, [
      { id: '1', date: '2026-10-14', moneySpent: '1000,00', bonusSpent: '0' },
      { id: '2', date: '2026-10-14', moneySpent: '500', bonusSpent: '200' },
    ], []);
    const c1 = r.campaigns.find(c => c.campaignId === '1')!;
    const c2 = r.campaigns.find(c => c.campaignId === '2')!;
    expect(c1.group).toBe('Поиск');
    expect(c1.strategy).toBe('Целевые ставки');
    expect(c2.money).toBe(300);
    expect(c2.bonus).toBe(200);
    expect(r.byDay['2026-10-14']).toBe(1300);
    expect(campaignGroup({ advObjectType: 'SEARCH_PROMO', placement: [], paymentType: '' })).toBe('Оплата за заказ');
  });
});

import { renderUnit } from '@/modules/analytics/ui/views/unit';
import { unitReportText, unitSheets } from '@/modules/analytics/services/unitReport';

describe('вкладка «Юнит-экономика»', () => {
  const state = (result: ReturnType<typeof computeUnitEconomics> | null) => ({
    result, loading: false, error: '', settings: DEFAULT_UNIT_SETTINGS,
    sort: { key: 'orderedRevenue' as const, dir: -1 as const }, isOzon: true, historyLabel: 'за 60 дней',
  });

  it('рендерится с данными и без', () => {
    const r = computeUnitEconomics(input({ fbs: { postings: 3, units: 4, revenue: 4000 } }));
    const html = renderUnit(state(r));
    expect(html).toContain('Выкуп 60%');
    expect(html).toContain('Расходы на выкупленную штуку');
    expect(html).toContain('Из чего состоит цена');
    expect(html).toContain('Передано в доставку FBS');
    expect(html).toContain('Футболка');
    expect(renderUnit(state(null))).toContain('Считаем');
    expect(renderUnit(state(computeUnitEconomics(input({ orders: [] }))))).toContain('нет заказов');
  });

  it('текстовый отчёт содержит ключевые строки', () => {
    const r = computeUnitEconomics(input({ settings: { ...DEFAULT_UNIT_SETTINGS, buyoutMode: 'manual', buyoutPct: 60, scenarioCost: 250 } }));
    const t = unitReportText(r, 'Ozon · сегодня');
    expect(t).toContain('Итого: 10 шт., 10 заказов');
    expect(t).toContain('Ожидаемый выкуп 60%');
    expect(t).toContain('ДРР общий: 6,00% / 10,00%');
    expect(t).toContain('Итоговая прибыль: 520,00 ₽');
    expect(t).toContain('Сценарий себестоимость 250,00 ₽');
  });

  it('выгрузка в Excel содержит все листы', () => {
    const sheets = unitSheets(computeUnitEconomics(input()), 'x');
    expect(sheets.map(s => s.name)).toEqual(['Итоги', 'Расходы на шт', 'Реклама', 'Товары', 'Нюансы']);
    expect(sheets[3].rows).toHaveLength(2);
  });
});
