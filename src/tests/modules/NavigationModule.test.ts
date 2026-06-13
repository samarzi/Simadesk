import { describe, it, expect, beforeEach } from 'vitest';
import { NavigationModule } from '@/modules/NavigationModule';
import { boxes } from '@/stores/appStore';
import type { App } from '@/App';
import type { Box, Product } from '@/types';

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: 'box1',
    name: 'Group 1',
    sticker: '📦',
    created_at: '2026-01-01',
    ...overrides,
  } as Box;
}

function makeProduct(boxId: string, overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    box_id: boxId,
    sheet_id: 'sheet1',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    data: {},
    ...overrides,
  } as Product;
}

function makeApp(overrides: Partial<App> = {}): App {
  return {
    activeBoxId: null,
    cache: new Map<string, Product[]>(),
    ...overrides,
  } as unknown as App;
}

describe('NavigationModule.getActiveGroupOffers()', () => {
  beforeEach(() => {
    boxes.set([]);
  });

  it('returns offers from all boxes when no active box is selected', () => {
    const box1 = makeBox({ id: 'b1', name: 'Group 1' });
    const box2 = makeBox({ id: 'b2', name: 'Group 2' });
    boxes.set([box1, box2]);

    const app = makeApp({ activeBoxId: null });
    (app as any).cache.set('b1', [
      makeProduct('b1', { data: { 'Артикул*': 'SKU1', 'Название товара': 'Товар 1' } }),
    ]);
    (app as any).cache.set('b2', [
      makeProduct('b2', { data: { 'Артикул*': 'SKU2', 'Название': 'Товар 2' } }),
    ]);

    const nav = new NavigationModule(app);
    const offers = nav.getActiveGroupOffers();

    expect(offers).toEqual([
      { offer_id: 'SKU1', name: 'Товар 1', box_name: 'Group 1' },
      { offer_id: 'SKU2', name: 'Товар 2', box_name: 'Group 2' },
    ]);
  });

  it('returns offers only from the active box when one is selected', () => {
    const box1 = makeBox({ id: 'b1', name: 'Group 1' });
    const box2 = makeBox({ id: 'b2', name: 'Group 2' });
    boxes.set([box1, box2]);

    const app = makeApp({ activeBoxId: 'b2' });
    (app as any).cache.set('b1', [
      makeProduct('b1', { data: { 'Артикул*': 'SKU1', 'Название товара': 'Товар 1' } }),
    ]);
    (app as any).cache.set('b2', [
      makeProduct('b2', { data: { 'Артикул*': 'SKU2', 'Название товара': 'Товар 2' } }),
    ]);

    const nav = new NavigationModule(app);
    const offers = nav.getActiveGroupOffers();

    expect(offers).toEqual([{ offer_id: 'SKU2', name: 'Товар 2', box_name: 'Group 2' }]);
  });

  it('skips products without an offer_id (Артикул*)', () => {
    const box1 = makeBox({ id: 'b1', name: 'Group 1' });
    boxes.set([box1]);

    const app = makeApp({ activeBoxId: null });
    (app as any).cache.set('b1', [
      makeProduct('b1', { data: { 'Артикул*': '  ', 'Название товара': 'No SKU' } }),
      makeProduct('b1', { data: { 'Артикул*': 'SKU1', 'Название товара': 'Has SKU' } }),
    ]);

    const nav = new NavigationModule(app);
    const offers = nav.getActiveGroupOffers();

    expect(offers).toEqual([{ offer_id: 'SKU1', name: 'Has SKU', box_name: 'Group 1' }]);
  });

  it('returns an empty array when there are no boxes', () => {
    boxes.set([]);
    const app = makeApp();
    const nav = new NavigationModule(app);
    expect(nav.getActiveGroupOffers()).toEqual([]);
  });
});

describe('NavigationModule.getActiveGroupName()', () => {
  beforeEach(() => {
    boxes.set([]);
  });

  it('returns null when no active box is set', () => {
    const app = makeApp({ activeBoxId: null });
    const nav = new NavigationModule(app);
    expect(nav.getActiveGroupName()).toBeNull();
  });

  it('returns the name of the active box', () => {
    boxes.set([makeBox({ id: 'b1', name: 'My Group' })]);
    const app = makeApp({ activeBoxId: 'b1' });
    const nav = new NavigationModule(app);
    expect(nav.getActiveGroupName()).toBe('My Group');
  });

  it('returns null when the active box id no longer exists', () => {
    boxes.set([makeBox({ id: 'b1', name: 'My Group' })]);
    const app = makeApp({ activeBoxId: 'missing' });
    const nav = new NavigationModule(app);
    expect(nav.getActiveGroupName()).toBeNull();
  });
});
