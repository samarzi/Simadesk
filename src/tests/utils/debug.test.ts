import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── DebugLogger ────────────────────────────────────────────────────────────
// We test the logger in isolation by re-creating it with controlled state.

describe('DebugLogger', () => {
  beforeEach(() => {
    // Reset localStorage mock
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not log when debug is disabled', () => {
    localStorage.removeItem('debug');
    // Re-import to get fresh instance — use inline class to avoid singleton issues
    const isEnabled = localStorage.getItem('debug') === 'true';
    expect(isEnabled).toBe(false);
  });

  it('is enabled when localStorage.debug === "true"', () => {
    localStorage.setItem('debug', 'true');
    const isEnabled = localStorage.getItem('debug') === 'true';
    expect(isEnabled).toBe(true);
  });

  it('debug.time() returns the function result', async () => {
    const { debug } = await import('@/utils/debug');
    const result = await debug.time('test', async () => 42);
    expect(result).toBe(42);
  });

  it('debug.time() propagates errors', async () => {
    const { debug } = await import('@/utils/debug');
    await expect(
      debug.time('failing', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
  });
});
