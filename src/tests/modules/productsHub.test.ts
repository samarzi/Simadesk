/**
 * Раздел «Товары»: сводка продаж с сервера, единая формула прибыли,
 * сортировка таблицы.
 */
import { describe, it, expect } from 'vitest';
import { ProductsHubModule } from '@/modules/ProductsHubModule';

function entry(mp: 'ozon' | 'wb', store: string) {
  return { mp, store_id: store, store_name: store, price: 1000, old_price: null, stock_fbs: 0, stock_fbo: 5, stock_total: 5, stock_available: 5,
    status: 'В продаже', images: [], url: null, sales_qty: 0, sales_revenue: 0, returns_qty: 0, commission: 0, delivery: 0, services: 0, net_profit: 0,
    description: '', vat: '', barcode: '', characteristics: [] };
}
function product(article: string, cost: number | null, entries: any[]) {
  return { article, name: 'Товар ' + article, image_url: null, brand: null, category: null, barcode: null, cost_price: cost,
    weight_kg: null, length_cm: null, width_cm: null, height_cm: null, mp_entries: entries, box_links: [], repricer_rules: [],
    supplier: null, custom_fields: [], has_cost: cost != null, has_mp: true, has_repricer: false, has_box: false };
}

function setup() {
  const m: any = new ProductsHubModule(document.createElement('div'));
  m.items = [
    product('A-1', 300, [entry('ozon', 'S1'), entry('wb', 'W1')]),
    product('B-2', null, [entry('ozon', 'S1')]),
    product('C-3', 500, [entry('ozon', 'S1')]),
  ];
  m.skuMaps.ozon = new Map([['111', 'A-1'], ['222', 'B-2'], ['333', 'C-3']]);
  m.skuMaps.wb = new Map([['9001', 'A-1']]);
  m.salesRows = [
    // Ozon: выручка 10 000, комиссия 4 000, перечислено 5 000 → прочие удержания 1 000
    { store_id: 'S1', marketplace: 'ozon', sku: '111', sold: 10, returned: 2, revenue: 10000, commission: 4000, payout: 5000 },
    { store_id: 'W1', marketplace: 'wb', sku: '9001', sold: 5, returned: 0, revenue: 5000, commission: 1000, payout: 3500 },
    { store_id: 'S1', marketplace: 'ozon', sku: '222', sold: 3, returned: 0, revenue: 3000, commission: 900, payout: 1800 },
    { store_id: 'S1', marketplace: 'ozon', sku: '999', sold: 1, returned: 0, revenue: 1, commission: 0, payout: 1 }, // неизвестный SKU
  ];
  m.aggregateSales();
  return m;
}

describe('«Товары»: продажи и прибыль', () => {
  it('сводка с сервера разносится по магазинам товара', () => {
    const m = setup();
    const a = m.items[0];
    expect(a.mp_entries[0]).toMatchObject({ sales_qty: 10, returns_qty: 2, sales_revenue: 10000, commission: -4000, net_profit: 5000 });
    expect(a.mp_entries[0].services).toBe(-1000);
    expect(a.mp_entries[1]).toMatchObject({ sales_qty: 5, sales_revenue: 5000, net_profit: 3500 });
  });

  it('прибыль = перечислено − себестоимость проданных штук, одна формула', () => {
    const m = setup();
    const t = m.totals(m.items[0], m.items[0].mp_entries);
    expect(t.revenue).toBe(15000);
    expect(t.commission).toBe(5000);
    expect(t.otherFees).toBe(1500);
    expect(t.payout).toBe(8500);
    expect(t.netUnits).toBe(13);
    expect(t.cogs).toBe(3900);
    expect(t.profit).toBe(4600);
    expect(t.margin).toBeCloseTo(4600 / 15000 * 100, 6);
    // выручка − удержания = перечислено
    expect(t.revenue - t.commission - t.otherFees).toBe(t.payout);
  });

  it('без себестоимости прибыль не выдумывается', () => {
    const m = setup();
    const t = m.totals(m.items[1], m.items[1].mp_entries);
    expect(t.payout).toBe(1800);
    expect(t.profit).toBeNull();
  });

  it('фильтр по площадке пересчитывает итоги только по ней', () => {
    const m = setup();
    m.filters.mp = 'wb';
    const t = m.totals(m.items[0]);
    expect(t.revenue).toBe(5000);
    expect(t.profit).toBe(3500 - 5 * 300);
  });

  it('сортировка по прибыли: товары без себестоимости — в конце', () => {
    const m = setup();
    m.renderShell();
    m.sortKey = 'profit'; m.sortDir = -1;
    m.applyFilters();
    expect(m.filtered.map((p: any) => p.article)).toEqual(['A-1', 'C-3', 'B-2']);
  });

  it('строка таблицы: название, артикул, копирование, себестоимость в ячейке', () => {
    const m = setup();
    const html = m.tplListItem(m.items[1]);
    expect(html).toContain('Товар B-2');
    expect(html).toContain('B-2');
    expect(html).toContain('Копировать артикул');
    expect(html).toContain('Копировать название');
    expect(html).toContain('+ указать');
  });
});
