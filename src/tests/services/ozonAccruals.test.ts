import { describe, it, expect, beforeEach } from 'vitest';
import { accrualToTransaction, accrualMoney, daysToSync, markDaySynced } from '@/services/ozonAccruals';
import { aggregateOrders } from '@/modules/analytics/services/orderAggregator';
import { computeKPI } from '@/modules/analytics/services/kpiAggregator';

const types = new Map([['10', 'Логистика'], ['11', 'Последняя миля'], ['20', 'Приём платежа (эквайринг)'], ['30', 'Хранение на складе'], ['40', 'Доставка покупателю']]);
const typeName = (id: unknown) => types.get(String(id)) ?? '';

const sale = {
  accrual_id: 9001, date: '2026-10-03', unit_number: 'P-1', accrued_category: 'POSTING', type_id: 40,
  total_amount: { amount: '1700', currency: 'RUB' },
  posting: { products: [{ sku: 111, offer_id: 'A', name: 'Футболка', quantity: 1,
    commission: { accrued: { amount: '-200' } },
    delivery: { services: [{ type_id: 10, accrued: { amount: '-90' } }, { type_id: 11, accrued: '-10' }] } }] },
};

describe('начисления Ozon (/v1/finance/accrual/by-day)', () => {
  it('суммы в любом формате', () => {
    expect(accrualMoney({ amount: '-21.75', currency: 'RUB' })).toBe(-21.75);
    expect(accrualMoney('value:"0.42"')).toBe(0.42);
    expect(accrualMoney(12)).toBe(12);
    expect(accrualMoney(null)).toBe(0);
  });

  it('продажа: выручка = итог − комиссия − услуги, удержания разложены', () => {
    const tx = accrualToTransaction(sale, typeName, 'S1')!;
    expect(tx.mp_transaction_id).toBe('9001');
    expect(tx.posting_number).toBe('P-1');
    expect(tx.amount).toBe(1700);
    expect(tx.sale_commission).toBe(-200);
    expect(tx.accruals_for_sale).toBe(2000);
    expect(tx.tx_kind).toBe('sale');
    expect(tx.items_json?.[0]).toMatchObject({ sku: 111, vendor_code: 'A', quantity: 1 });
  });

  it('эквайринг по товару и хранение без товара — расходы, не выручка', () => {
    const acq = accrualToTransaction({ accrual_id: 2, date: '2026-10-03', unit_number: 'P-1', accrued_category: 'ITEM',
      item_fees: { fees: [{ fees: [{ type_id: 20, accrued: { amount: '-17' } }] }] }, total_amount: '-17' }, typeName, 'S1')!;
    expect(acq.accruals_for_sale).toBe(0);
    const st = accrualToTransaction({ accrual_id: 3, date: '2026-10-03', accrued_category: 'NON_ITEM', type_id: 30, total_amount: '-500' }, typeName, 'S1')!;
    expect(st.posting_number).toBeNull();
    expect(st.tx_kind).toBe('storage');
    expect(st.accruals_for_sale).toBe(0);
  });

  it('сквозной расчёт: заказ получает выручку, комиссию, логистику, последнюю милю и эквайринг', () => {
    const txs = [
      accrualToTransaction(sale, typeName, 'S1')!,
      accrualToTransaction({ accrual_id: 2, date: '2026-10-03', unit_number: 'P-1', accrued_category: 'ITEM',
        item_fees: { fees: [{ type_id: 20, accrued: '-17' }] }, total_amount: '-17' }, typeName, 'S1')!,
      accrualToTransaction({ accrual_id: 3, date: '2026-10-03', accrued_category: 'NON_ITEM', type_id: 30, total_amount: '-500' }, typeName, 'S1')!,
    ];
    const store = { id: 'S1', name: 'oz', mp: 'ozon' as const, tax_model: 'none' as const, tax_rate: 0, fulfillment: null };
    const posting = { posting_number: 'P-1', store_id: 'S1', status: 'delivered', created_at: '2026-10-01T10:00:00Z',
      products: [{ offer_id: 'A', name: 'Футболка', quantity: 1, price: '2000' }] } as any;
    const r = aggregateOrders({ ozonPostings: [posting], yandexOrders: [], wbOrders: [], transactions: txs, stores: [store],
      products: new Map(), cogs: { get: () => null, has: () => false },
      periodStart: new Date('2026-10-01T00:00:00+03:00'), periodEnd: new Date('2026-10-31T23:59:59+03:00') });
    const o = r.orders[0];
    expect(o.status).toBe('delivered');
    expect(o.source).toBe('real');
    expect(o.commission).toBe(200);
    expect(o.logistics).toBe(100);
    expect(o.fee_breakdown.find(f => f.type === 'last_mile')?.amount).toBe(10);
    expect(o.fee_breakdown.find(f => f.type === 'acquiring')?.amount).toBe(17);
    expect(o.payout_actual).toBe(1683);
    expect(r.periodCosts).toEqual([expect.objectContaining({ kind: 'storage', amount: 500 })]);
    expect(computeKPI(r.orders, r.periodCosts).revenue).toBe(2000);
  });

  it('возврат: выручка уходит в минус, комиссия возвращается', () => {
    const tx = accrualToTransaction({ accrual_id: 5, date: '2026-10-09', unit_number: 'P-1', accrued_category: 'POSTING',
      name: 'Возврат от покупателя', total_amount: '-1800',
      posting: { products: [{ sku: 111, quantity: 1, commission: '200' }] } }, typeName, 'S1')!;
    expect(tx.accruals_for_sale).toBe(-2000);
    expect(tx.tx_kind).toBe('return');
  });
});

describe('какие дни перезагружать', () => {
  beforeEach(() => localStorage.clear());
  it('окончательные дни не грузятся повторно, свежие — грузятся', () => {
    markDaySynced('S1', '2026-10-01', '2026-10-05');
    markDaySynced('S1', '2026-10-04', '2026-10-05'); // на следующий день — Ozon мог дописать начисления позже
    markDaySynced('S1', '2026-10-03', '2026-10-07');
    markDaySynced('S1', '2026-10-13', '2026-10-13');
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-13', '2026-10-14'];
    expect(daysToSync('S1', days, '2026-10-14')).toEqual(['2026-10-02', '2026-10-04', '2026-10-13', '2026-10-14']);
  });
});
