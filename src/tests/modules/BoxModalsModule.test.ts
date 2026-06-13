import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoxModalsModule } from '@/modules/BoxModalsModule';
import { boxes } from '@/stores/appStore';
import type { App } from '@/App';

function makeApp(overrides: Partial<App> = {}): App {
  return {
    columnOrder: new Map<string, string[]>(),
    toast: vi.fn(),
    buildColumns: vi.fn(),
    openModal: vi.fn(),
    ...overrides,
  } as unknown as App;
}

describe('BoxModalsModule.resetColumnOrder()', () => {
  beforeEach(() => {
    localStorage.clear();
    boxes.set([]); // no boxes -> openBoxSettings() returns early
  });

  it('removes the custom column order for the box and persists the rest', () => {
    const columnOrder = new Map<string, string[]>([
      ['box1', ['B', 'A', 'C']],
      ['box2', ['X', 'Y']],
    ]);
    const app = makeApp({ columnOrder });
    const mod = new BoxModalsModule(app);

    mod.resetColumnOrder('box1');

    expect(app.columnOrder.has('box1')).toBe(false);
    const stored = JSON.parse(localStorage.getItem('app_column_order')!);
    expect(stored).toEqual({ box2: ['X', 'Y'] });
    expect(app.toast).toHaveBeenCalledWith('Порядок столбцов сброшен', 'success');
    expect(app.buildColumns).toHaveBeenCalledOnce();
  });

  it('is safe to call for a box with no stored order', () => {
    const app = makeApp();
    const mod = new BoxModalsModule(app);

    expect(() => mod.resetColumnOrder('missing-box')).not.toThrow();
    expect(app.columnOrder.has('missing-box')).toBe(false);
    expect(app.toast).toHaveBeenCalledWith('Порядок столбцов сброшен', 'success');
  });
});

describe('BoxModalsModule.filterBsProducts()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="bs-products-list">
        <div>Кружка синяя</div>
        <div>Тарелка белая</div>
        <div>Кружка красная</div>
      </div>`;
  });

  it('shows rows matching the query and hides the rest', () => {
    const app = makeApp();
    const mod = new BoxModalsModule(app);

    mod.filterBsProducts('кружка');

    const rows = document.querySelectorAll<HTMLElement>('#bs-products-list > div');
    expect(rows[0].style.display).toBe('');
    expect(rows[1].style.display).toBe('none');
    expect(rows[2].style.display).toBe('');
  });

  it('shows all rows when the query is empty', () => {
    const app = makeApp();
    const mod = new BoxModalsModule(app);

    mod.filterBsProducts('кружка');
    mod.filterBsProducts('');

    document.querySelectorAll<HTMLElement>('#bs-products-list > div').forEach(row => {
      expect(row.style.display).toBe('');
    });
  });
});
