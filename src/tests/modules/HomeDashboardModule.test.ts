import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HomeDashboardModule } from '@/modules/HomeDashboardModule';
import { DEFAULT_LAYOUT } from '@/modules/HomeWidgets';
import type { App } from '@/App';

const KEY = 'home_widgets_layout_v3';

function makeApp(overrides: Partial<App> = {}): App {
  return {
    closeModal: vi.fn(),
    ...overrides,
  } as unknown as App;
}

describe('HomeDashboardModule — widget layout management', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('addWidget appends a valid, not-yet-present widget to the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.addWidget('k-avg'); // not in DEFAULT_LAYOUT

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toEqual([...DEFAULT_LAYOUT, 'k-avg']);
    expect(app.closeModal).toHaveBeenCalledOnce();
  });

  it('addWidget is a no-op for an unknown widget id', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.addWidget('does-not-exist');

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(app.closeModal).not.toHaveBeenCalled();
  });

  it('addWidget is a no-op when the widget is already in the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.addWidget('k-rev-today'); // already in DEFAULT_LAYOUT

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(app.closeModal).not.toHaveBeenCalled();
  });

  it('removeWidget removes the widget from the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.removeWidget('k-new');

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toEqual(DEFAULT_LAYOUT.filter(id => id !== 'k-new'));
  });

  it('moveWidget(-1) swaps a widget with its predecessor', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.moveWidget('k-orders-today', -1); // index 1 → swaps with k-rev-today at 0

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored[0]).toBe('k-orders-today');
    expect(stored[1]).toBe('k-rev-today');
  });

  it('moveWidget is a no-op at the boundary of the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.moveWidget(DEFAULT_LAYOUT[0], -1); // already first

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('moveWidget is a no-op for an id not in the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.moveWidget('does-not-exist', 1);

    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
