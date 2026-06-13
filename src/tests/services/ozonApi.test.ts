import { describe, it, expect } from 'vitest';

// ── Status determination logic (extracted from ozonApi.ts) ─────────────────
// Tests the business logic for determining product status from Ozon API response.

function determineStatus(item: {
  is_archived?: boolean;
  is_autoarchived?: boolean;
  status?: string | { state?: string };
  state?: string;
  is_fbo_visible?: boolean;
  is_fbs_visible?: boolean;
}): string {
  if (item.is_archived || item.is_autoarchived) return 'archived';

  let rawStatus = '';
  if (typeof item.status === 'string' && item.status) rawStatus = item.status.toLowerCase();
  else if ((item.status as any)?.state) rawStatus = String((item.status as any).state).toLowerCase();
  else if (typeof item.state === 'string' && item.state) rawStatus = item.state.toLowerCase();

  const knownBadStatuses = new Set([
    'failed_moderation', 'moderating', 'not_moderated',
    'banned', 'blocked', 'price_error', 'sold_out', 'expired',
  ]);

  if (knownBadStatuses.has(rawStatus)) return rawStatus;

  // Passed moderation — check visibility
  if (item.is_fbo_visible === false && item.is_fbs_visible === false) return 'disabled';
  return 'processed';
}

describe('determineStatus()', () => {
  it('returns "archived" when is_archived is true', () => {
    expect(determineStatus({ is_archived: true })).toBe('archived');
  });

  it('returns "archived" when is_autoarchived is true', () => {
    expect(determineStatus({ is_autoarchived: true })).toBe('archived');
  });

  it('returns "failed_moderation" for failed_moderation status', () => {
    expect(determineStatus({ status: 'failed_moderation' })).toBe('failed_moderation');
  });

  it('returns "moderating" for moderating status', () => {
    expect(determineStatus({ status: 'moderating' })).toBe('moderating');
  });

  it('returns "banned" for banned status', () => {
    expect(determineStatus({ status: 'banned' })).toBe('banned');
  });

  it('returns "price_error" for price_error status', () => {
    expect(determineStatus({ status: 'price_error' })).toBe('price_error');
  });

  it('returns "disabled" when both FBO and FBS are not visible', () => {
    expect(determineStatus({ is_fbo_visible: false, is_fbs_visible: false })).toBe('disabled');
  });

  it('returns "processed" when at least one channel is visible', () => {
    expect(determineStatus({ is_fbo_visible: true, is_fbs_visible: false })).toBe('processed');
    expect(determineStatus({ is_fbo_visible: false, is_fbs_visible: true })).toBe('processed');
    expect(determineStatus({ is_fbo_visible: true, is_fbs_visible: true })).toBe('processed');
  });

  it('returns "processed" when no visibility flags are set (default)', () => {
    expect(determineStatus({})).toBe('processed');
  });

  it('reads status from nested status.state object', () => {
    expect(determineStatus({ status: { state: 'BANNED' } })).toBe('banned');
  });

  it('reads status from top-level state field', () => {
    expect(determineStatus({ state: 'moderating' })).toBe('moderating');
  });
});
