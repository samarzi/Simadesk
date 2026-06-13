import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoxMpLinkModule } from '@/modules/BoxMpLinkModule';
import { apiService } from '@/services/api';
import type { App } from '@/App';
import type { Product } from '@/types';


function makeProduct(id: string, data: Record<string, any> = {}): Product {
  return {
    id,
    box_id: 'box1',
    sheet_id: 'sheet1',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    data,
  } as Product;
}

function makeApp(overrides: Partial<App> = {}): App {
  return {
    allProducts: [],
    applyFilters: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  } as unknown as App;
}

describe('BoxMpLinkModule.getBoxMetaFallback()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty object when nothing is stored', () => {
    const mod = new BoxMpLinkModule(makeApp());
    expect(mod.getBoxMetaFallback('box1')).toEqual({});
  });

  it('returns an empty object on malformed JSON', () => {
    localStorage.setItem('box_meta_fallback', '{not json');
    const mod = new BoxMpLinkModule(makeApp());
    expect(mod.getBoxMetaFallback('box1')).toEqual({});
  });

  it('returns the stored metadata for a given box id', () => {
    localStorage.setItem('box_meta_fallback', JSON.stringify({
      box1: { ym_linked: true, ym_sku_field: 'Артикул*' },
      box2: { wb_linked: true },
    }));
    const mod = new BoxMpLinkModule(makeApp());
    expect(mod.getBoxMetaFallback('box1')).toEqual({ ym_linked: true, ym_sku_field: 'Артикул*' });
    expect(mod.getBoxMetaFallback('box2')).toEqual({ wb_linked: true });
    expect(mod.getBoxMetaFallback('missing')).toEqual({});
  });
});

describe('BoxMpLinkModule.toggleSyncDisabled()', () => {
  beforeEach(() => {
    vi.spyOn(apiService, 'updateProduct').mockResolvedValue({} as Product);
  });

  it('does nothing when the product is not found', async () => {
    const app = makeApp({ allProducts: [] });
    const mod = new BoxMpLinkModule(app);

    await mod.toggleSyncDisabled('missing', 'ym');

    expect(apiService.updateProduct).not.toHaveBeenCalled();
    expect(app.toast).not.toHaveBeenCalled();
  });

  it('flips the YM sync-disabled flag and persists it', async () => {
    const product = makeProduct('p1', {});
    const app = makeApp({ allProducts: [product] });
    const mod = new BoxMpLinkModule(app);

    await mod.toggleSyncDisabled('p1', 'ym');

    expect(product.data._ym_sync_disabled).toBe(true);
    expect(apiService.updateProduct).toHaveBeenCalledWith('p1', { data: { _ym_sync_disabled: true } });
    expect(app.applyFilters).toHaveBeenCalledOnce();
    expect(app.toast).toHaveBeenCalledWith('Синхронизация ЯМ для товара отключена', 'info', 1500);
  });

  it('toggles the flag back off on a second call', async () => {
    const product = makeProduct('p1', { _wb_sync_disabled: true });
    const app = makeApp({ allProducts: [product] });
    const mod = new BoxMpLinkModule(app);

    await mod.toggleSyncDisabled('p1', 'wb');

    expect(product.data._wb_sync_disabled).toBe(false);
    expect(app.toast).toHaveBeenCalledWith('Синхронизация WB для товара включена', 'info', 1500);
  });
});
