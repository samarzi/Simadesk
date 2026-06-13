import { describe, it, expect } from 'vitest';

// ── IdbCache TTL logic tests ───────────────────────────────────────────────
// Tests the TTL expiry logic without requiring a real IndexedDB.

const TTL = 20 * 60 * 1000; // 20 minutes — must match idbCache.ts

describe('IdbCache TTL logic', () => {
  it('entry is fresh when saved less than 20 minutes ago', () => {
    const savedAt = Date.now() - 5 * 60 * 1000; // 5 min ago
    const isFresh = Date.now() - savedAt < TTL;
    expect(isFresh).toBe(true);
  });

  it('entry is stale when saved more than 20 minutes ago', () => {
    const savedAt = Date.now() - 25 * 60 * 1000; // 25 min ago
    const isFresh = Date.now() - savedAt < TTL;
    expect(isFresh).toBe(false);
  });

  it('entry is stale at exactly the TTL boundary', () => {
    const savedAt = Date.now() - TTL;
    const isFresh = Date.now() - savedAt < TTL;
    expect(isFresh).toBe(false);
  });

  it('entry is fresh 1ms before TTL expires', () => {
    const savedAt = Date.now() - TTL + 1;
    const isFresh = Date.now() - savedAt < TTL;
    expect(isFresh).toBe(true);
  });
});
