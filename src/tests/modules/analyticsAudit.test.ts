/**
 * Регрессии по аудиту аналитики 14.10.2026: каждый тест ловит ошибку,
 * из-за которой цифры расходились с реальностью.
 */
import { describe, it, expect } from 'vitest';
import { aggregateOrders } from '@/modules/analytics/services/orderAggregator';
import { computeKPI, computeTimeseries, computeSkuPerformance } from '@/modules/analytics/services/kpiAggregator';
import { calcOrderTax } from '@/modules/analytics/services/taxCalculator';
import { wbRowToTransaction, ymOrderToTransactions } from '@/services/financeSync';
import { StoreInfo } from '@/modules/analytics/types';

const cogs = { get: () => 500, has: () => true };
const oz: StoreInfo = { id: 'S1', name: 'oz', mp: 'ozon', tax_model: 'none', tax_rate: 0, fulfillment: null };
const ym: StoreInfo = { id: 'Y1', name: 'ym', mp: 'yandex', tax_model: 'none', tax_rate: 0, fulfillment: null };
const wb: StoreInfo = { id: 'W1', name: 'wb', mp: 'wb', tax_model: 'none', tax_rate: 0, fulfillment: null };

const SEP = { periodStart: new Date('2026-09-01T00:00:00+03:00'), periodEnd: new Date('2026-09-30T23:59:59+03:00') };
const OCT = { periodStart: new Date('2026-10-01T00:00:00+03:00'), periodEnd: new Date('2026-10-31T23:59:59+03:00') };

function ozSale(over: any = {}) {
  return {
    store_id: 'S1', marketplace: 'ozon', mp_transaction_id: 't1',
    operation_type: 'OperationAgentDeliveredToCustomer', operation_type_name: 'Доставка покупателю',
    operation_date: '2026-10-03T10:00:00Z', posting_number: 'P-1',
    items_json: [{ name: 'x', sku: 1, vendor_code: 'A', quantity: 1 }],
    accruals_for_sale: 1000, sale_commission: -200, delivery_charge: 0, return_delivery_charge: 0,
    services_total: 100, amount: 700, tx_kind: 'sale',
    raw_json: {
      amount: 700, posting: { order_date: '2026-09-28T10:00:00Z' },
      services: [{ name: 'MarketplaceServiceItemDirectFlowLogistic', price: -90 }, { name: 'MarketplaceServiceItemDelivToCustomer', price: -10 }],
    },
    ...over,
  } as any;
}
const posting = (over: any = {}) => ({
  posting_number: 'P-1', store_id: 'S1', status: 'delivered', created_at: '2026-09-28T10:00:00Z',
  products: [{ offer_id: 'A', name: 'x', quantity: 1, price: '1000' }], ...over,
}) as any;
const base = { yandexOrders: [], wbOrders: [], products: new Map(), cogs } as const;

describe('продажа на стыке месяцев', () => {
  it('засчитывается один раз — в месяце заказа', () => {
    const sep = aggregateOrders({ ...base, ozonPostings: [posting()], transactions: [ozSale()], stores: [oz], ...SEP });
    const oct = aggregateOrders({ ...base, ozonPostings: [], transactions: [ozSale()], stores: [oz], ...OCT });
    expect(computeKPI(sep.orders).revenue).toBe(1000);
    expect(computeKPI(oct.orders, oct.periodCosts).revenue).toBe(0);
    expect(computeKPI(oct.orders, oct.periodCosts).total_expenses).toBe(0);
  });

  it('заказ, который не вернул живой API, восстанавливается из финотчёта', () => {
    const r = aggregateOrders({ ...base, ozonPostings: [], transactions: [ozSale()], stores: [oz], ...SEP });
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0].finance_only).toBe(true);
    expect(computeKPI(r.orders).orders_delivered).toBe(1);
  });

  it('график сходится с карточками, включая заказы из финотчёта', () => {
    const r = aggregateOrders({ ...base, ozonPostings: [], transactions: [ozSale()], stores: [oz], ...SEP });
    const k = computeKPI(r.orders, r.periodCosts);
    const ts = computeTimeseries(r.orders, SEP.periodStart, SEP.periodEnd, r.periodCosts);
    expect(ts.reduce((s, p) => s + p.revenue, 0)).toBeCloseTo(k.revenue, 2);
    expect(ts.reduce((s, p) => s + p.profit, 0)).toBeCloseTo(k.net_profit, 2);
  });
});

describe('Ozon: услуги разложены по видам', () => {
  it('логистика и последняя миля — это логистика, а не «прочие услуги»', () => {
    const r = aggregateOrders({ ...base, ozonPostings: [posting()], transactions: [ozSale()], stores: [oz], ...SEP });
    const o = r.orders[0];
    expect(o.logistics).toBe(100);
    expect(o.services).toBe(0);
    expect(o.fee_breakdown.find(f => f.type === 'last_mile')?.amount).toBe(10);
  });

  it('эквайринг отдельной операцией не теряется', () => {
    const acq = ozSale({
      mp_transaction_id: 't2', operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
      operation_type_name: 'Оплата эквайринга', accruals_for_sale: 0, sale_commission: 0, services_total: 0,
      amount: -25, tx_kind: 'service', items_json: [], raw_json: { amount: -25, posting: { order_date: '2026-09-28T10:00:00Z' }, services: [] },
    });
    const r = aggregateOrders({ ...base, ozonPostings: [posting()], transactions: [ozSale(), acq], stores: [oz], ...SEP });
    const o = r.orders[0];
    expect(o.fee_breakdown.find(f => f.type === 'acquiring')?.amount).toBe(25);
    // выручка − удержания = фактическая выплата
    expect(o.revenue - o.commission - o.logistics - o.logistics_return - o.services).toBeCloseTo(o.payout_actual, 2);
  });
});

describe('Яндекс.Маркет', () => {
  const ymOrder = (status: string) => ({
    id: 5, status, creation_date: '10-10-2026 12:00:00', store_id: 'Y1',
    items: [{ offer_id: 'A', name: 'x', count: 1, price: 1000 }],
  }) as any;
  const ymStats = (status: string) => ({
    id: 5, status, creationDate: '2026-10-10T12:00:00+03:00',
    items: [{ offerName: 'x', shopSku: 'A', count: 1, prices: [{ type: 'BUYER', total: 1000 }] }],
    commissions: [{ type: 'FEE', actual: 150 }],
  }) as any;

  for (const status of ['DELIVERY', 'PICKUP', 'PROCESSING']) {
    it(`заказ в статусе ${status} не считается проданным`, () => {
      const r = aggregateOrders({
        ...base, ozonPostings: [], yandexOrders: [ymOrder(status)],
        transactions: ymOrderToTransactions(ymStats(status), 'Y1'), stores: [ym],
      });
      const k = computeKPI(r.orders);
      expect(k.revenue).toBe(0);
      expect(k.in_transit_revenue).toBe(1000);
    });
  }

  it('доставленный заказ попадает в выручку', () => {
    const r = aggregateOrders({
      ...base, ozonPostings: [], yandexOrders: [ymOrder('DELIVERED')],
      transactions: ymOrderToTransactions(ymStats('DELIVERED'), 'Y1'), stores: [ym],
    });
    expect(computeKPI(r.orders).revenue).toBe(1000);
  });
});

describe('Wildberries', () => {
  const row = (over: any = {}) => ({
    rrd_id: 1, srid: 'SR1', nm_id: 77, sa_name: 'A', quantity: 1, doc_type_name: 'Продажа', supplier_oper_name: 'Продажа',
    retail_amount: 1000, ppvz_for_pay: 780, acquiring_fee: 20, ppvz_sales_commission: 150, delivery_rub: 0,
    rr_dt: '2026-10-05', order_dt: '2026-10-01T10:00:00', ...over,
  }) as any;
  const wbOrder = { id: 1, srid: 'SR1', store_id: 'W1', status: 'complete', created_at: '2026-10-01T10:00:00+03:00',
    items: [{ vendor_code: 'A', nm_id: 77, name: 'x', count: 1, price: 1000 }] } as any;

  it('полное удержание WB = реализовано − к перечислению', () => {
    const tx = wbRowToTransaction(row(), 'W1');
    const r = aggregateOrders({ ...base, ozonPostings: [], wbOrders: [wbOrder], transactions: [tx], stores: [wb] });
    const o = r.orders[0];
    expect(o.commission).toBe(200);
    expect(o.services).toBe(20);
    expect(o.revenue - o.commission - o.services).toBe(780);
  });

  it('возврат возвращает комиссию, а не списывает её второй раз', () => {
    const sale = wbRowToTransaction(row(), 'W1');
    const ret = wbRowToTransaction(row({ rrd_id: 2, doc_type_name: 'Возврат', supplier_oper_name: 'Возврат' }), 'W1');
    const logistics = wbRowToTransaction(row({ rrd_id: 3, doc_type_name: '', supplier_oper_name: 'Логистика', retail_amount: 0, ppvz_for_pay: 0, acquiring_fee: 0, delivery_rub: 120 }), 'W1');
    const r = aggregateOrders({ ...base, ozonPostings: [], wbOrders: [wbOrder], transactions: [sale, ret, logistics], stores: [wb] });
    const o = r.orders[0];
    expect(o.status).toBe('returned');
    expect(o.commission).toBe(0);
    expect(o.services).toBe(0);
    expect(o.logistics).toBe(120);
    expect(o.payout_actual).toBe(0);
  });
});

describe('частичный возврат', () => {
  it('теряется только возвращённая часть', () => {
    const p = posting({ products: [{ offer_id: 'A', name: 'x', quantity: 2, price: '1000' }] });
    const sale = ozSale({ accruals_for_sale: 2000, sale_commission: -400, amount: 1500, items_json: [{ name: 'x', sku: 1, vendor_code: 'A', quantity: 2 }],
      raw_json: { amount: 1500, posting: { order_date: '2026-09-28T10:00:00Z' }, services: [{ name: 'MarketplaceServiceItemDirectFlowLogistic', price: -100 }] } });
    const ret = ozSale({ mp_transaction_id: 't3', operation_type: 'ClientReturnAgentOperation', operation_type_name: 'Получение возврата',
      accruals_for_sale: -1000, sale_commission: 200, amount: -800, tx_kind: 'return',
      raw_json: { amount: -800, posting: { order_date: '2026-09-28T10:00:00Z' }, services: [] } });
    const r = aggregateOrders({ ...base, ozonPostings: [p], transactions: [sale, ret], stores: [oz], ...SEP });
    const o = r.orders[0];
    expect(o.status).toBe('delivered');
    expect(o.revenue).toBe(1000);
    expect(o.revenue_lost).toBe(1000);
    expect(o.cogs).toBe(500);
    const k = computeKPI(r.orders);
    expect(k.units_sold).toBe(1);
    expect(k.returns_revenue).toBe(1000);
  });
});

describe('разбивка по товарам сходится со сводкой', () => {
  it('удержания по отменам входят в прибыль товаров', () => {
    const cancelled = posting({ posting_number: 'P-2', status: 'cancelled', created_at: '2026-09-05T10:00:00Z' });
    const ctx = ozSale({ mp_transaction_id: 't2', posting_number: 'P-2', operation_type: 'OperationReturnCancel', operation_type_name: 'Отмена',
      accruals_for_sale: 0, sale_commission: 0, services_total: 150, amount: -150, tx_kind: 'cancel',
      raw_json: { amount: -150, posting: { order_date: '2026-09-05T10:00:00Z' }, services: [{ name: 'MarketplaceServiceItemReturnFlowLogistic', price: -150 }] } });
    const r = aggregateOrders({ ...base, ozonPostings: [posting(), cancelled], transactions: [ozSale(), ctx], stores: [oz], ...SEP });
    const k = computeKPI(r.orders, r.periodCosts);
    const sum = computeSkuPerformance(r.orders, r.periodCosts).reduce((s, x) => s + x.net_profit, 0);
    expect(sum).toBeCloseTo(k.net_profit, 2);
  });
});

describe('налоги', () => {
  it('УСН 15% считается с прибыли периода: убыточный заказ уменьшает базу', () => {
    const usn15: StoreInfo = { ...oz, tax_model: 'usn15', tax_rate: 0.15 };
    const profitable = ozSale();
    const loss = ozSale({ mp_transaction_id: 't9', posting_number: 'P-9', accruals_for_sale: 1000, sale_commission: -900, amount: 0,
      raw_json: { amount: 0, posting: { order_date: '2026-09-20T10:00:00Z' }, services: [{ name: 'MarketplaceServiceItemDirectFlowLogistic', price: -100 }] } });
    const r = aggregateOrders({ ...base, ozonPostings: [posting(), posting({ posting_number: 'P-9', created_at: '2026-09-20T10:00:00Z' })],
      transactions: [profitable, loss], stores: [usn15], ...SEP });
    const k = computeKPI(r.orders);
    // выручка 2000, удержания 300 + 1000, себестоимость 1000 → убыток → минимальный налог 1%
    expect(k.profit_tax).toBeCloseTo(20, 2);
    expect(k.tax).toBeCloseTo(20, 2);
  });

  it('УСН 6% с НДС 5%: НДС выделяется из цены, налог — с выручки без НДС', () => {
    const t = calcOrderTax(1050, 0, 'usn6', 0.06, 0.05);
    expect(t.vat).toBeCloseTo(50, 2);
    expect(t.tax).toBeCloseTo(50 + 60, 2);
  });

  it('ОСНО: НДС 22% к уплате за вычетом входящего НДС с услуг МП', () => {
    const t = calcOrderTax(1220, 244, 'osn', 0.25, 0.22);
    expect(t.vat).toBeCloseTo((1220 - 244) * 0.22 / 1.22, 2);
  });
});
