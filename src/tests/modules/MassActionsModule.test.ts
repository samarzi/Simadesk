import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MassActionsModule } from '@/modules/MassActionsModule';
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

function makeProduct(id: string, boxId = 'box1'): Product {
  return {
    id,
    box_id: boxId,
    sheet_id: 'sheet1',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    data: {},
  } as Product;
}

function makeApp(overrides: Partial<App> = {}): App {
  return {
    selectedProducts: new Set<string>(),
    allProducts: [],
    hiddenRows: new Map<string, Set<string>>(),
    activeBoxId: 'box1',
    openModal: vi.fn(),
    toast: vi.fn(),
    applyFilters: vi.fn(),
    renderProducts: vi.fn(),
    renderActionBar: vi.fn(),
    ...overrides,
  } as unknown as App;
}

describe('MassActionsModule.massDeleteProducts()', () => {
  it('does nothing when no products are selected', () => {
    const app = makeApp({ selectedProducts: new Set() });
    const mod = new MassActionsModule(app);
    mod.massDeleteProducts();
    expect(app.openModal).not.toHaveBeenCalled();
  });

  it('opens a confirmation modal when products are selected', () => {
    const app = makeApp({ selectedProducts: new Set(['p1', 'p2']) });
    const mod = new MassActionsModule(app);
    mod.massDeleteProducts();
    expect(app.openModal).toHaveBeenCalledOnce();
    expect((app.openModal as any).mock.calls[0][1]).toContain('2');
  });
});

describe('MassActionsModule.massMoveProducts()', () => {
  beforeEach(() => {
    boxes.set([]);
  });

  it('does nothing when no products are selected', () => {
    boxes.set([makeBox({ id: 'box1' }), makeBox({ id: 'box2', name: 'Group 2' })]);
    const app = makeApp({ selectedProducts: new Set() });
    const mod = new MassActionsModule(app);
    mod.massMoveProducts();
    expect(app.openModal).not.toHaveBeenCalled();
    expect(app.toast).not.toHaveBeenCalled();
  });

  it('shows an error toast when there is no other box to move to', () => {
    boxes.set([makeBox({ id: 'box1' })]); // only the active box exists
    const app = makeApp({ selectedProducts: new Set(['p1']), activeBoxId: 'box1' });
    const mod = new MassActionsModule(app);
    mod.massMoveProducts();
    expect(app.toast).toHaveBeenCalledWith('Нет других групп для перемещения', 'error');
    expect(app.openModal).not.toHaveBeenCalled();
  });

  it('opens a modal listing the other boxes when products are selected', () => {
    boxes.set([makeBox({ id: 'box1' }), makeBox({ id: 'box2', name: 'Group 2' })]);
    const app = makeApp({ selectedProducts: new Set(['p1', 'p2']), activeBoxId: 'box1' });
    const mod = new MassActionsModule(app);
    mod.massMoveProducts();
    expect(app.openModal).toHaveBeenCalledOnce();
    const body = (app.openModal as any).mock.calls[0][2];
    expect(body).toContain('box2');
    expect(body).not.toContain('value="box1"');
  });
});

describe('MassActionsModule.massHideProducts()', () => {
  it('does nothing when no products are selected', () => {
    const app = makeApp({ selectedProducts: new Set() });
    const mod = new MassActionsModule(app);
    mod.massHideProducts(true);
    expect(app.applyFilters).not.toHaveBeenCalled();
  });

  it('hides selected products and persists to localStorage', () => {
    localStorage.clear();
    const p1 = makeProduct('p1', 'box1');
    const p2 = makeProduct('p2', 'box1');
    const app = makeApp({
      selectedProducts: new Set(['p1']),
      allProducts: [p1, p2],
    });
    const mod = new MassActionsModule(app);
    mod.massHideProducts(true);

    expect(app.hiddenRows.get('box1')?.has('p1')).toBe(true);
    expect(app.hiddenRows.get('box1')?.has('p2')).toBe(false);
    const stored = JSON.parse(localStorage.getItem('app_hidden_rows')!);
    expect(stored.box1).toEqual(['p1']);
    expect(app.applyFilters).toHaveBeenCalledOnce();
    expect(app.renderProducts).toHaveBeenCalledOnce();
    expect(app.renderActionBar).toHaveBeenCalledOnce();
    expect(app.toast).toHaveBeenCalledWith('Товары скрыты', 'success');
  });

  it('un-hides previously hidden products', () => {
    localStorage.clear();
    const p1 = makeProduct('p1', 'box1');
    const hiddenRows = new Map<string, Set<string>>([['box1', new Set(['p1'])]]);
    const app = makeApp({
      selectedProducts: new Set(['p1']),
      allProducts: [p1],
      hiddenRows,
    });
    const mod = new MassActionsModule(app);
    mod.massHideProducts(false);

    expect(app.hiddenRows.get('box1')?.has('p1')).toBe(false);
    expect(app.toast).toHaveBeenCalledWith('Товары показаны', 'success');
  });
});
