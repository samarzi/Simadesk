import { describe, it, expect, vi } from 'vitest';
import { Store } from '@/stores/appStore';

// ── Store<T> ───────────────────────────────────────────────────────────────

describe('Store<T>', () => {
  it('get() returns initial value', () => {
    const s = new Store(42);
    expect(s.get()).toBe(42);
  });

  it('set() updates value and notifies listeners', () => {
    const s = new Store(0);
    const cb = vi.fn();
    s.subscribe(cb);
    cb.mockClear(); // ignore initial call
    s.set(99);
    expect(s.get()).toBe(99);
    expect(cb).toHaveBeenCalledWith(99);
  });

  it('update() applies updater function', () => {
    const s = new Store<number[]>([1, 2]);
    s.update(arr => [...arr, 3]);
    expect(s.get()).toEqual([1, 2, 3]);
  });

  it('subscribe() calls listener immediately with current value', () => {
    const s = new Store('hello');
    const cb = vi.fn();
    s.subscribe(cb);
    expect(cb).toHaveBeenCalledWith('hello');
  });

  it('unsubscribe() stops notifications', () => {
    const s = new Store(0);
    const cb = vi.fn();
    const unsub = s.subscribe(cb);
    cb.mockClear();
    unsub();
    s.set(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('multiple listeners all receive updates', () => {
    const s = new Store(0);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    s.subscribe(cb1);
    s.subscribe(cb2);
    cb1.mockClear();
    cb2.mockClear();
    s.set(5);
    expect(cb1).toHaveBeenCalledWith(5);
    expect(cb2).toHaveBeenCalledWith(5);
  });

  it('update() notifies listeners with new value', () => {
    const s = new Store({ count: 0 });
    const cb = vi.fn();
    s.subscribe(cb);
    cb.mockClear();
    s.update(v => ({ count: v.count + 1 }));
    expect(cb).toHaveBeenCalledWith({ count: 1 });
  });
});
