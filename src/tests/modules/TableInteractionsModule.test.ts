import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TableInteractionsModule } from '@/modules/TableInteractionsModule';
import type { App } from '@/App';
import type { Product } from '@/types';

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
    dragFromIdx: null,
    dragColIdx: null,
    filtered: [],
    allProducts: [],
    activeBoxId: null,
    cache: new Map<string, Product[]>(),
    columns: [],
    columnOrder: new Map<string, string[]>(),
    applyFilters: vi.fn(),
    buildColumns: vi.fn(),
    openBoxSettings: vi.fn(),
    ...overrides,
  } as unknown as App;
}

describe('TableInteractionsModule — row drag-and-drop reorder', () => {
  it('moves the dragged row to the drop position in filtered and allProducts', () => {
    const p1 = makeProduct('p1');
    const p2 = makeProduct('p2');
    const p3 = makeProduct('p3');
    const app = makeApp({
      filtered: [p1, p2, p3],
      allProducts: [p1, p2, p3],
    });
    const mod = new TableInteractionsModule(app);

    mod.onRowDragStart(0); // start dragging p1
    expect(app.dragFromIdx).toBe(0);

    mod.onRowDrop(2); // drop after p3

    expect(app.filtered.map(p => p.id)).toEqual(['p2', 'p3', 'p1']);
    expect(app.allProducts.map(p => p.id)).toEqual(['p2', 'p3', 'p1']);
    expect(app.dragFromIdx).toBeNull();
    expect(app.applyFilters).toHaveBeenCalledOnce();
  });

  it('does nothing when dropping on the same row', () => {
    const p1 = makeProduct('p1');
    const p2 = makeProduct('p2');
    const app = makeApp({ filtered: [p1, p2], allProducts: [p1, p2] });
    const mod = new TableInteractionsModule(app);

    mod.onRowDragStart(0);
    mod.onRowDrop(0);

    expect(app.filtered.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(app.applyFilters).not.toHaveBeenCalled();
    expect(app.dragFromIdx).toBeNull();
  });

  it('does nothing when no drag was started', () => {
    const p1 = makeProduct('p1');
    const p2 = makeProduct('p2');
    const app = makeApp({ filtered: [p1, p2], allProducts: [p1, p2] });
    const mod = new TableInteractionsModule(app);

    mod.onRowDrop(1);

    expect(app.filtered.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(app.applyFilters).not.toHaveBeenCalled();
  });

  it('persists the new order to cache when a box is active', () => {
    const p1 = makeProduct('p1');
    const p2 = makeProduct('p2');
    const app = makeApp({
      filtered: [p1, p2],
      allProducts: [p1, p2],
      activeBoxId: 'box1',
    });
    const mod = new TableInteractionsModule(app);

    mod.onRowDragStart(0);
    mod.onRowDrop(1);

    expect(app.cache.get('box1')?.map(p => p.id)).toEqual(['p2', 'p1']);
  });
});

describe('TableInteractionsModule — column drag-and-drop reorder', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('moves the dragged column to the drop position and rebuilds columns', () => {
    const app = makeApp({
      columns: ['ColA', 'ColB', 'ColC'],
      activeBoxId: 'box1',
    });
    const mod = new TableInteractionsModule(app);

    mod.onColDragStart({ dataTransfer: null, target: document.createElement('div') } as unknown as DragEvent, 0);
    expect(app.dragColIdx).toBe(0);

    mod.onColDrop({ preventDefault: vi.fn() } as unknown as DragEvent, 2);

    expect(app.columnOrder.get('box1')).toEqual(['ColB', 'ColC', 'ColA']);
    expect(app.dragColIdx).toBeNull();
    expect(app.buildColumns).toHaveBeenCalledOnce();
    expect(app.openBoxSettings).toHaveBeenCalledWith('box1');
  });

  it('does nothing when dropping on the same column', () => {
    const app = makeApp({ columns: ['ColA', 'ColB'], activeBoxId: 'box1' });
    const mod = new TableInteractionsModule(app);

    mod.onColDragStart({ dataTransfer: null, target: document.createElement('div') } as unknown as DragEvent, 1);
    mod.onColDrop({ preventDefault: vi.fn() } as unknown as DragEvent, 1);

    expect(app.buildColumns).not.toHaveBeenCalled();
    expect(app.dragColIdx).toBeNull();
  });
});
