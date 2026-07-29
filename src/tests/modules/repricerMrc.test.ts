import { describe, it, expect } from 'vitest';
import {
  computeNewSellerPrice,
  exactSellerPriceForMrc,
  mrcShowcaseDeviated,
  buildMrcItems,
} from '@/modules/repricer/utils';
import type { UnifiedProduct, RuleProduct, MrcItem } from '@/modules/repricer/types';

describe('computeNewSellerPrice()', () => {
  it('scales seller price proportionally to how far the showcase is from target', () => {
    // showcase 1100, target 1000 -> ratio 0.909..., seller 1000 -> Math.round(909.09) = 909
    expect(computeNewSellerPrice(1000, 1000, 1100)).toBe(909);
  });

  it('clamps the change to ±20% per cycle', () => {
    // target is far below showcase -> would want a huge cut, clamp to -20%
    expect(computeNewSellerPrice(100, 1000, 2000)).toBe(800);
    // target is far above showcase -> clamp to +20%
    expect(computeNewSellerPrice(10000, 1000, 1000)).toBe(1200);
  });

  it('returns currentSellerPrice unchanged for invalid inputs', () => {
    expect(computeNewSellerPrice(1000, 1000, 0)).toBe(1000);
    expect(computeNewSellerPrice(1000, 0, 1000)).toBe(0);
  });
});

describe('exactSellerPriceForMrc()', () => {
  it('scales seller price proportionally without the ±20% clamp', () => {
    // seller 2448, showcase 1287, target 1700 -> 2448 * 1700/1287 = 3234
    expect(exactSellerPriceForMrc(1700, 2448, 1287)).toBe(3234);
  });

  it('returns currentSellerPrice unchanged for invalid inputs', () => {
    expect(exactSellerPriceForMrc(1000, 1000, 0)).toBe(1000);
    expect(exactSellerPriceForMrc(1000, 0, 1000)).toBe(0);
  });
});

describe('mrcShowcaseDeviated()', () => {
  it('returns false when showcase price matches MRC within 1%', () => {
    expect(mrcShowcaseDeviated(1000, 1005)).toBe(false);
    expect(mrcShowcaseDeviated(1005, 1000)).toBe(false);
  });

  it('returns true when showcase price deviates by more than 1%', () => {
    expect(mrcShowcaseDeviated(1020, 1000)).toBe(true);
    expect(mrcShowcaseDeviated(980, 1000)).toBe(true);
  });

  it('returns false for non-positive inputs', () => {
    expect(mrcShowcaseDeviated(0, 1000)).toBe(false);
    expect(mrcShowcaseDeviated(1000, 0)).toBe(false);
  });
});

describe('buildMrcItems()', () => {
  const unified: UnifiedProduct[] = [
    {
      vendorCode: 'ABC-1',
      title: 'Товар 1',
      variants: [
        { mp: 'wb', storeId: 'wb-store-1', storeName: 'WB Магазин', productId: '111', title: 'Товар 1 (WB)', price: 1000, stock: 5 },
        { mp: 'ozon', storeId: 'ozon-store-1', storeName: 'Ozon Магазин', productId: 'ABC-1', title: 'Товар 1 (Ozon)', price: 1050, stock: 3 },
      ],
    },
    {
      vendorCode: 'XYZ-2',
      title: 'Товар 2',
      variants: [
        { mp: 'yandex', storeId: 'ym-store-1', storeName: 'ЯМ Магазин', productId: 'XYZ-2', title: 'Товар 2 (ЯМ)', price: 2000, stock: 1 },
      ],
    },
  ];

  it('товар, продающийся на 2 маркетплейсах, получает 2 ячейки с одинаковым mrcPrice', () => {
    const products: RuleProduct[] = [{ productId: '111', vendorCode: 'ABC-1', productTitle: 'Товар 1' }];
    const items = buildMrcItems(unified, products, () => 999);
    expect(items).toHaveLength(2);
    expect(items.every(it => it.mrcPrice === 999)).toBe(true);
    expect(items.map(it => it.mp).sort()).toEqual(['ozon', 'wb']);
    expect(items.every(it => it.vendorCode === 'ABC-1')).toBe(true);
  });

  it('несколько товаров × несколько маркетплейсов дают корректное количество и поля ячеек', () => {
    const products: RuleProduct[] = [
      { productId: '111', vendorCode: 'ABC-1', productTitle: 'Товар 1' },
      { productId: 'XYZ-2', vendorCode: 'XYZ-2', productTitle: 'Товар 2' },
    ];
    const items = buildMrcItems(unified, products, vc => (vc === 'ABC-1' ? 100 : 200));
    expect(items).toHaveLength(3);
    const wbItem = items.find(it => it.mp === 'wb')!;
    expect(wbItem.storeId).toBe('wb-store-1');
    expect(wbItem.storeName).toBe('WB Магазин');
    expect(wbItem.productId).toBe('111');
    expect(wbItem.mrcPrice).toBe(100);
    const ymItem = items.find(it => it.mp === 'yandex')!;
    expect(ymItem.mrcPrice).toBe(200);
    expect(ymItem.storeId).toBe('ym-store-1');
  });

  it('merge с existingItems не дублирует и не перетирает уже существующие ячейки', () => {
    const products: RuleProduct[] = [{ productId: '111', vendorCode: 'ABC-1', productTitle: 'Товар 1' }];
    const existing: MrcItem[] = [
      { key: 'existing-key', mp: 'wb', storeId: 'wb-store-1', storeName: 'WB Магазин', productId: '111', vendorCode: 'ABC-1', productTitle: 'Товар 1', mrcPrice: 555, enabled: false },
    ];
    const items = buildMrcItems(unified, products, () => 999, existing);
    expect(items).toHaveLength(2);
    const wbItem = items.find(it => it.mp === 'wb')!;
    expect(wbItem.key).toBe('existing-key');
    expect(wbItem.mrcPrice).toBe(555);
    expect(wbItem.enabled).toBe(false);
    const ozonItem = items.find(it => it.mp === 'ozon')!;
    expect(ozonItem.mrcPrice).toBe(999);
    expect(ozonItem.key).not.toBe('existing-key');
  });
});
