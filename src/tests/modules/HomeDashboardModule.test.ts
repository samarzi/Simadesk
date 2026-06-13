import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HomeDashboardModule } from '@/modules/HomeDashboardModule';
import { DEFAULT_LAYOUT } from '@/modules/HomeWidgets';
import type { App } from '@/App';

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

    mod.addWidget('kpi-revenue-30');

    const stored = JSON.parse(localStorage.getItem('home_widgets_layout_v1')!);
    expect(stored).toEqual([...DEFAULT_LAYOUT, 'kpi-revenue-30']);
    expect(app.closeModal).toHaveBeenCalledOnce();
  });

  it('addWidget is a no-op for an unknown widget id', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.addWidget('does-not-exist');

    expect(localStorage.getItem('home_widgets_layout_v1')).toBeNull();
    expect(app.closeModal).not.toHaveBeenCalled();
  });

  it('addWidget is a no-op when the widget is already in the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.addWidget('kpi-today'); // already in DEFAULT_LAYOUT

    expect(localStorage.getItem('home_widgets_layout_v1')).toBeNull();
    expect(app.closeModal).not.toHaveBeenCalled();
  });

  it('removeWidget removes the widget from the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.removeWidget('kpi-new');

    const stored = JSON.parse(localStorage.getItem('home_widgets_layout_v1')!);
    expect(stored).toEqual(DEFAULT_LAYOUT.filter(id => id !== 'kpi-new'));
  });

  it('moveWidget(-1) swaps a widget with its predecessor', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.moveWidget('kpi-new', -1); // kpi-new is at index 1, kpi-today at 0

    const stored = JSON.parse(localStorage.getItem('home_widgets_layout_v1')!);
    expect(stored[0]).toBe('kpi-new');
    expect(stored[1]).toBe('kpi-today');
  });

  it('moveWidget is a no-op at the boundary of the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.moveWidget(DEFAULT_LAYOUT[0], -1); // already first

    expect(localStorage.getItem('home_widgets_layout_v1')).toBeNull();
  });

  it('moveWidget is a no-op for an id not in the layout', () => {
    const app = makeApp();
    const mod = new HomeDashboardModule(app);

    mod.moveWidget('does-not-exist', 1);

    expect(localStorage.getItem('home_widgets_layout_v1')).toBeNull();
  });
});
