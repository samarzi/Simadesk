import { describe, it, expect } from 'vitest';
import { aggregateOrders } from '@/modules/analytics/services/orderAggregator';
import { computeTimeseries } from '@/modules/analytics/services/kpiAggregator';
import { StoreInfo } from '@/modules/analytics/types';

const store: StoreInfo = {
  id: 'S1', name: 'BOCOSA', mp: 'yandex',
  tax_model: 'none', tax_rate: 0, fulfillment: null,
};

const cogs = { get: () => null, has: () => false };

/** Живой заказ ЯМ: дата приходит как «DD-MM-YYYY HH:mm:ss» по Москве. */
function ymOrder(id: number, date: string) {
  return {
    id,
    status: 'DELIVERED',
    creation_date: date,
    items: [{ offer_id: 'ART-1', name: 'Товар', count: 1, price: 1000 }],
    store_id: 'S1',
  } as any;
}

describe('даты Яндекс Маркета в аналитике', () => {
  it('заказ ЯМ получает дату в ISO, а не сырую DD-MM-YYYY', () => {
    const { orders } = aggregateOrders({
      ozonPostings: [], wbOrders: [], transactions: [],
      yandexOrders: [ymOrder(1, '15-08-2026 12:30:00')],
      stores: [store], products: new Map(), cogs,
    });
    expect(orders).toHaveLength(1);
    expect(orders[0].date).toBe('2026-08-15T09:30:00.000Z');
  });

  it('заказ ЯМ попадает в нужный день графика', () => {
    // Раньше `date.slice(0, 10)` давал «15-08-2026», что не совпадало ни с одним
    // ключом сетки дней — заказы Яндекса просто исчезали из графика.
    const { orders } = aggregateOrders({
      ozonPostings: [], wbOrders: [], transactions: [],
      yandexOrders: [ymOrder(1, '15-08-2026 12:30:00')],
      stores: [store], products: new Map(), cogs,
    });
    // Заказ без финотчёта в деньги не идёт — проверяем на возврате,
    // у которого расходы учитываются независимо от отчёта.
    orders[0].status = 'returned';
    orders[0].revenue_lost = 1000;
    orders[0].revenue = 0;
    orders[0].logistics = 90;

    const ts = computeTimeseries(
      orders,
      new Date('2026-08-14T00:00:00.000Z'),
      new Date('2026-08-16T23:59:59.999Z'),
    );
    const day15 = ts.find(p => p.date === '2026-08-15');
    expect(day15).toBeDefined();
    expect(day15!.expenses).toBe(90);
  });

  it('заказы ЯМ сортируются хронологически, а не по числу месяца', () => {
    const { orders } = aggregateOrders({
      ozonPostings: [], wbOrders: [], transactions: [],
      yandexOrders: [
        ymOrder(1, '15-08-2026 10:00:00'),
        ymOrder(2, '02-09-2026 10:00:00'),
      ],
      stores: [store], products: new Map(), cogs,
    });
    // aggregateOrders сортирует по убыванию даты — сентябрьский заказ первым
    expect(orders[0].order_id).toBe('2');
  });
});
