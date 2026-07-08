import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MrcScanner } from '@/modules/repricer/services/mrcScanner';
import type { MrcScannerContext } from '@/modules/repricer/services/mrcScanner';
import { MRC_VERIFY_DELAY_MS, MRC_MAX_ADJUST_ITERATIONS } from '@/modules/repricer/types';
import type { RepricerRule, MrcItem } from '@/modules/repricer/types';
import type { WbStore, WbProduct } from '@/types/wb';
import type { YandexStore, YandexProduct } from '@/types/yandex';

vi.mock('@/services/wbApi', () => ({ updateWbPrices: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/services/ozonApi', () => ({ ozonApi: { updatePrices: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/services/yandexApi', () => ({
  yandexApi: {
    updateOfferPrices: vi.fn().mockResolvedValue(undefined),
    removeOffersFromAllPromos: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/modules/repricer/services/priceApi', () => ({
  fetchWbBuyerPrices: vi.fn().mockResolvedValue(new Map()),
  fetchOzonPricesForStore: vi.fn().mockResolvedValue(new Map()),
  fetchOzonBuyerPrices: vi.fn().mockResolvedValue(new Map()),
  fetchYmSellerPrices: vi.fn().mockResolvedValue(new Map()),
  fetchYmBuyerPrices: vi.fn().mockResolvedValue(new Map()),
}));

import { updateWbPrices } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { fetchWbBuyerPrices, fetchYmBuyerPrices } from '@/modules/repricer/services/priceApi';

function makeCtx(overrides: Partial<MrcScannerContext> = {}): MrcScannerContext {
  return {
    getRules: () => [],
    getWbStores: () => [],
    getWbProducts: () => [],
    getOzonStores: () => [],
    getOzonProducts: () => [],
    getYmStores: () => [],
    getYmProducts: () => [],
    onChange: () => {},
    ...overrides,
  };
}

function wbItem(overrides: Partial<MrcItem> = {}): MrcItem {
  return {
    key: 'item-1', mp: 'wb', storeId: 'store-1', storeName: 'WB магазин',
    productId: '111', vendorCode: 'ABC-1', productTitle: 'Товар 1',
    mrcPrice: 1000, enabled: true,
    ...overrides,
  };
}

function wbRule(items: MrcItem[]): RepricerRule {
  return {
    id: 'rule-1', marketplace: 'wb', storeId: 'store-1', storeName: 'WB магазин',
    productId: '111', vendorCode: 'ABC-1', productTitle: 'Товар 1',
    type: 'mrc', status: 'active', mrcItems: items, createdAt: new Date().toISOString(),
  };
}

/** Свежая (fresh: true) витринная цена WB от расширения — единственный источник showcase. */
function wbBuyerPriceMap(price: number): Map<number, { price: number; checkedAt: string; marketSku: null; fresh: boolean }> {
  return new Map([[111, { price, checkedAt: new Date().toISOString(), marketSku: null, fresh: true }]]);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); // scan log / pending-verify persistence carries over between tests otherwise
  // jsdom has no window.chrome — detectSimaDeskExtension() resolves false without mocking.
});

describe('MrcScanner.runScan()', () => {
  it('flags needs_update when the WB showcase (from the extension) deviates from MRC and suggests a corrected seller price', async () => {
    const item = wbItem();
    const rule = wbRule([item]);
    const wbStore: WbStore = { id: 'store-1', name: 'WB магазин', api_key: 'key', created_at: '' } as WbStore;
    const wbProduct: WbProduct = { store_id: 'store-1', nm_id: 111, vendor_code: 'ABC-1', title: 'Товар 1', pictures: [], price: 1300 } as WbProduct;
    vi.mocked(fetchWbBuyerPrices).mockResolvedValue(wbBuyerPriceMap(1040));

    const scanner = new MrcScanner(makeCtx({
      getRules: () => [rule],
      getWbStores: () => [wbStore],
      getWbProducts: () => [wbProduct],
    }));

    await scanner.runScan();

    expect(scanner.scanLog).toHaveLength(1);
    const entry = scanner.scanLog[0];
    expect(entry.action).toBe('needs_update');
    expect(entry.sellerPrice).toBe(1300);
    expect(entry.buyerPrice).toBe(1040);
    // exactSellerPriceForMrc(1000, 1300, 1040) = ceil(1300 * 1000/1040) = 1250
    expect(entry.newPrice).toBe(1250);
  });

  it('flags ok when the WB showcase (from the extension) already matches MRC', async () => {
    const item = wbItem();
    const rule = wbRule([item]);
    const wbStore: WbStore = { id: 'store-1', name: 'WB магазин', api_key: 'key', created_at: '' } as WbStore;
    const wbProduct: WbProduct = { store_id: 'store-1', nm_id: 111, vendor_code: 'ABC-1', title: 'Товар 1', pictures: [], price: 1250 } as WbProduct;
    vi.mocked(fetchWbBuyerPrices).mockResolvedValue(wbBuyerPriceMap(1000));

    const scanner = new MrcScanner(makeCtx({
      getRules: () => [rule],
      getWbStores: () => [wbStore],
      getWbProducts: () => [wbProduct],
    }));

    await scanner.runScan();

    expect(scanner.scanLog[0].action).toBe('ok');
  });
});

describe('MrcScanner.applyEntry() + verify convergence', () => {
  it('applies the corrected price and converges to ok on the first verify pass', async () => {
    vi.useFakeTimers();
    try {
      const item = wbItem();
      const rule = wbRule([item]);
      const wbStore: WbStore = { id: 'store-1', name: 'WB магазин', api_key: 'key', created_at: '' } as WbStore;
      const wbProduct: WbProduct = { store_id: 'store-1', nm_id: 111, vendor_code: 'ABC-1', title: 'Товар 1', pictures: [], price: 1300 } as WbProduct;
      // Расширение видит витрину как фиксированную долю от текущей цены продавца
      // (имитирует реальную СПП-скидку WB) — после применения новой цены витрина
      // на следующем чтении уже отражает её, и verify должен сойтись.
      vi.mocked(fetchWbBuyerPrices).mockImplementation(async () => wbBuyerPriceMap(Math.round(wbProduct.price * 0.8)));

      const scanner = new MrcScanner(makeCtx({
        getRules: () => [rule],
        getWbStores: () => [wbStore],
        getWbProducts: () => [wbProduct],
      }));

      await scanner.runScan();
      const entryId = scanner.scanLog[0].id;

      await scanner.applyEntry(entryId);
      expect(updateWbPrices).toHaveBeenCalledTimes(1);
      expect(scanner.scanLog[0].action).toBe('adjusted');
      // applyPrice mutates the cached wbProduct in place — verify() will see the new price.
      expect(wbProduct.price).toBe(1250);

      await vi.advanceTimersByTimeAsync(MRC_VERIFY_DELAY_MS);

      expect(scanner.scanLog[0].action).toBe('ok');
      // No further price changes were needed.
      expect(updateWbPrices).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after MRC_MAX_ADJUST_ITERATIONS and marks the entry needsConfirm', async () => {
    vi.useFakeTimers();
    try {
      const item = wbItem();
      const rule = wbRule([item]);
      const wbStore: WbStore = { id: 'store-1', name: 'WB магазин', api_key: 'key', created_at: '' } as WbStore;
      // getWbProducts() returns a brand-new object every call — applyPrice's in-place cache
      // mutation only touches that one transient object, so the next fetch always re-reads
      // price=4000 again (simulates the catalog cache never reflecting our change).
      const freshWbProduct = (): WbProduct => ({ store_id: 'store-1', nm_id: 111, vendor_code: 'ABC-1', title: 'Товар 1', pictures: [], price: 4000 } as WbProduct);
      // Расширение тоже всегда сообщает одну и ту же (далёкую от МРЦ) витрину — never converges.
      vi.mocked(fetchWbBuyerPrices).mockResolvedValue(wbBuyerPriceMap(4000));

      const scanner = new MrcScanner(makeCtx({
        getRules: () => [rule],
        getWbStores: () => [wbStore],
        getWbProducts: () => [freshWbProduct()],
      }));

      await scanner.runScan();
      const entryId = scanner.scanLog[0].id;
      await scanner.applyEntry(entryId);

      for (let i = 0; i < MRC_MAX_ADJUST_ITERATIONS + 1; i++) {
        await vi.advanceTimersByTimeAsync(MRC_VERIFY_DELAY_MS);
      }

      const entry = scanner.scanLog[0];
      expect(entry.needsConfirm).toBe(true);
      expect(entry.adjustIteration).toBe(MRC_MAX_ADJUST_ITERATIONS);
      // 1 initial apply + MRC_MAX_ADJUST_ITERATIONS verify-driven re-applies.
      expect(updateWbPrices).toHaveBeenCalledTimes(MRC_MAX_ADJUST_ITERATIONS + 1);

      scanner.confirmEntry(entryId, false);
      expect(entry.needsConfirm).toBe(false);
      expect(entry.action).toBe('needs_update');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MrcScanner.applyAllDeviations()', () => {
  it('applies entries sequentially, never running two updateWbPrices calls concurrently', async () => {
    const items = [wbItem({ key: 'item-1', productId: '111' }), wbItem({ key: 'item-2', productId: '222' })];
    const rule = wbRule(items);
    const wbStore: WbStore = { id: 'store-1', name: 'WB магазин', api_key: 'key', created_at: '' } as WbStore;
    const products: WbProduct[] = [
      { store_id: 'store-1', nm_id: 111, vendor_code: 'ABC-1', title: 'Товар 1', pictures: [], price: 1300 } as WbProduct,
      { store_id: 'store-1', nm_id: 222, vendor_code: 'ABC-2', title: 'Товар 2', pictures: [], price: 1300 } as WbProduct,
    ];
    vi.mocked(fetchWbBuyerPrices).mockResolvedValue(new Map([
      [111, { price: 1040, checkedAt: new Date().toISOString(), marketSku: null, fresh: true }],
      [222, { price: 1040, checkedAt: new Date().toISOString(), marketSku: null, fresh: true }],
    ]));

    let concurrent = 0;
    let maxConcurrent = 0;
    vi.mocked(updateWbPrices).mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      await Promise.resolve();
      concurrent--;
    });

    const scanner = new MrcScanner(makeCtx({
      getRules: () => [rule],
      getWbStores: () => [wbStore],
      getWbProducts: () => products,
    }));

    await scanner.runScan();
    expect(scanner.scanLog.filter(e => e.action === 'needs_update')).toHaveLength(2);

    await scanner.applyAllDeviations();

    expect(maxConcurrent).toBe(1);
    expect(updateWbPrices).toHaveBeenCalledTimes(2);
  });
});

describe('MrcScanner — Яндекс.Маркет: снятие с акций только один раз за цепочку корректировок', () => {
  it('calls removeOffersFromAllPromos once even when verify retries the adjustment multiple times', async () => {
    vi.useFakeTimers();
    try {
      const item: MrcItem = {
        key: 'item-1', mp: 'yandex', storeId: 'store-1', storeName: 'ЯМ магазин',
        productId: 'offer-1', vendorCode: 'ABC-1', productTitle: 'Товар 1',
        mrcPrice: 500, enabled: true,
      };
      const rule: RepricerRule = {
        id: 'rule-1', marketplace: 'yandex', storeId: 'store-1', storeName: 'ЯМ магазин',
        productId: 'offer-1', vendorCode: 'ABC-1', productTitle: 'Товар 1',
        type: 'mrc', status: 'active', mrcItems: [item], createdAt: new Date().toISOString(),
      };
      const ymStore: YandexStore = {
        id: 'store-1', name: 'ЯМ магазин', api_key: 'key', business_id: 42, campaign_id: 99,
      } as YandexStore;
      // basic_price 1000 stays static across every fetch — the showcase (4000, far from
      // target 500) never reflects the "applied" price, so verify keeps retrying until
      // MRC_MAX_ADJUST_ITERATIONS is exhausted.
      const ymProduct: YandexProduct = {
        store_id: 'store-1', offer_id: 'offer-1', name: 'Товар 1', pictures: [], basic_price: 1000,
      };
      vi.mocked(fetchYmBuyerPrices).mockResolvedValue(new Map([
        ['offer-1', { price: 4000, checkedAt: new Date().toISOString(), marketSku: null, fresh: true }],
      ]));

      const scanner = new MrcScanner(makeCtx({
        getRules: () => [rule],
        getYmStores: () => [ymStore],
        getYmProducts: () => [ymProduct],
      }));

      await scanner.runScan();
      const entryId = scanner.scanLog[0].id;
      await scanner.applyEntry(entryId);
      expect(yandexApi.removeOffersFromAllPromos).toHaveBeenCalledTimes(1);

      for (let i = 0; i < MRC_MAX_ADJUST_ITERATIONS; i++) {
        await vi.advanceTimersByTimeAsync(MRC_VERIFY_DELAY_MS);
      }

      expect(yandexApi.updateOfferPrices).toHaveBeenCalledTimes(MRC_MAX_ADJUST_ITERATIONS + 1);
      // Promo removal must not repeat on every verify iteration — only the first apply in the chain.
      expect(yandexApi.removeOffersFromAllPromos).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MrcScanner — Яндекс.Маркет: устаревшие данные витрины (TTL)', () => {
  const item: MrcItem = {
    key: 'item-1', mp: 'yandex', storeId: 'store-1', storeName: 'ЯМ магазин',
    productId: 'offer-1', vendorCode: 'ABC-1', productTitle: 'Товар 1',
    mrcPrice: 2000, enabled: true,
  };
  const rule: RepricerRule = {
    id: 'rule-1', marketplace: 'yandex', storeId: 'store-1', storeName: 'ЯМ магазин',
    productId: 'offer-1', vendorCode: 'ABC-1', productTitle: 'Товар 1',
    type: 'mrc', status: 'active', mrcItems: [item], createdAt: new Date().toISOString(),
  };
  const ymStore: YandexStore = {
    id: 'store-1', name: 'ЯМ магазин', api_key: 'key', business_id: 42, campaign_id: 99,
  } as YandexStore;
  const ymProduct: YandexProduct = {
    store_id: 'store-1', offer_id: 'offer-1', name: 'Товар 1', pictures: [], basic_price: 2300,
  };

  it('ignores a stale buyer-price reading (fresh: false) instead of treating it as live', async () => {
    // checkedAt — a week ago. fresh:false is what fetchYmBuyerPrices would actually compute
    // for a row this old (BUYER_PRICE_STALE_MS = 6h), regardless of the literal timestamp here.
    vi.mocked(fetchYmBuyerPrices).mockResolvedValue(new Map([
      ['offer-1', { price: 2000, checkedAt: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(), marketSku: null, fresh: false }],
    ]));

    const scanner = new MrcScanner(makeCtx({
      getRules: () => [rule],
      getYmStores: () => [ymStore],
      getYmProducts: () => [ymProduct],
    }));

    await scanner.runScan();

    const entry = scanner.scanLog[0];
    // Must not silently compare MRC against the stale 2000 — must surface that real
    // showcase data is unavailable, not invent a decision from a week-old reading.
    expect(entry.action).toBe('error');
    expect(entry.errorMsg).toContain('Нет данных о витринной цене ЯМ');
    expect(entry.sellerPrice).toBe(2300);
  });

  it('uses the real buyer price when the reading is fresh', async () => {
    vi.mocked(fetchYmBuyerPrices).mockResolvedValue(new Map([
      ['offer-1', { price: 2000, checkedAt: new Date().toISOString(), marketSku: null, fresh: true }],
    ]));

    const scanner = new MrcScanner(makeCtx({
      getRules: () => [rule],
      getYmStores: () => [ymStore],
      getYmProducts: () => [ymProduct],
    }));

    await scanner.runScan();

    const entry = scanner.scanLog[0];
    expect(entry.action).toBe('ok'); // showcase 2000 === target mrcPrice 2000
    expect(entry.buyerPrice).toBe(2000);
  });
});

describe('MrcScanner — WB: нет свежих данных витрины от расширения', () => {
  it('flags an error and never calls updateWbPrices when the extension has no fresh wb_buyer_prices reading', async () => {
    const item = wbItem({ mrcPrice: 1000 });
    const rule = wbRule([item]);
    const wbStore: WbStore = { id: 'store-1', name: 'WB магазин', api_key: 'key', created_at: '' } as WbStore;
    const wbProduct: WbProduct = { store_id: 'store-1', nm_id: 111, vendor_code: 'ABC-1', title: 'Товар 1', pictures: [], price: 2000 } as WbProduct;
    // Расширение не присылало данных вообще — fetchWbBuyerPrices возвращает пустую карту.
    vi.mocked(fetchWbBuyerPrices).mockResolvedValue(new Map());

    const scanner = new MrcScanner(makeCtx({
      getRules: () => [rule],
      getWbStores: () => [wbStore],
      getWbProducts: () => [wbProduct],
    }));

    await scanner.runScan();

    const entry = scanner.scanLog[0];
    expect(entry.action).toBe('error');
    expect(entry.errorMsg).toContain('Нет данных о витринной цене WB');
    expect(entry.newPrice).toBeUndefined();

    // Применить нельзя — applyEntry no-op для всего, что не 'needs_update'.
    await scanner.applyEntry(entry.id);
    expect(updateWbPrices).not.toHaveBeenCalled();
  });
});
