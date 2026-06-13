import { describe, it, expect } from 'vitest';
import { esc, productSuffix, escapeRegex, formatPrice, parsePhotoUrls } from '@/utils/format';

// ── esc ────────────────────────────────────────────────────────────────────

describe('esc()', () => {
  it('escapes & < > " \'', () => {
    expect(esc('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles null / undefined gracefully', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('passes through plain text unchanged', () => {
    expect(esc('Hello World')).toBe('Hello World');
  });

  it('converts numbers to string', () => {
    expect(esc(42)).toBe('42');
  });
});

// ── productSuffix ──────────────────────────────────────────────────────────

describe('productSuffix()', () => {
  it('returns "" for 1, 21, 31', () => {
    expect(productSuffix(1)).toBe('');
    expect(productSuffix(21)).toBe('');
    expect(productSuffix(31)).toBe('');
  });

  it('returns "а" for 2, 3, 4, 22, 23, 24', () => {
    expect(productSuffix(2)).toBe('а');
    expect(productSuffix(3)).toBe('а');
    expect(productSuffix(4)).toBe('а');
    expect(productSuffix(22)).toBe('а');
    expect(productSuffix(24)).toBe('а');
  });

  it('returns "ов" for 5-20, 11, 12, 13, 14', () => {
    expect(productSuffix(5)).toBe('ов');
    expect(productSuffix(11)).toBe('ов');
    expect(productSuffix(12)).toBe('ов');
    expect(productSuffix(14)).toBe('ов');
    expect(productSuffix(20)).toBe('ов');
    expect(productSuffix(100)).toBe('ов');
  });
});

// ── escapeRegex ────────────────────────────────────────────────────────────

describe('escapeRegex()', () => {
  it('escapes all regex special characters', () => {
    const special = '.*+?^${}()|[]\\';
    const escaped = escapeRegex(special);
    // Should not throw when used in RegExp
    expect(() => new RegExp(escaped)).not.toThrow();
  });

  it('does not alter plain text', () => {
    expect(escapeRegex('hello world')).toBe('hello world');
  });

  it('correctly escapes a dot so it matches only a literal dot', () => {
    const pattern = new RegExp(escapeRegex('1.5'));
    expect(pattern.test('1.5')).toBe(true);
    expect(pattern.test('1X5')).toBe(false);
  });

  it('correctly escapes parentheses', () => {
    const pattern = new RegExp(escapeRegex('(test)'));
    expect(pattern.test('(test)')).toBe(true);
    expect(pattern.test('test')).toBe(false);
  });
});

// ── formatPrice ────────────────────────────────────────────────────────────

describe('formatPrice()', () => {
  it('formats a number with ₽ suffix', () => {
    expect(formatPrice(1000)).toContain('₽');
    expect(formatPrice(1000)).toContain('1');
  });

  it('returns "—" for NaN / empty string', () => {
    expect(formatPrice(NaN)).toBe('—');
    expect(formatPrice('')).toBe('—');
  });

  it('accepts string numbers', () => {
    expect(formatPrice('5000')).toContain('₽');
  });
});

// ── parsePhotoUrls ─────────────────────────────────────────────────────────

describe('parsePhotoUrls()', () => {
  it('splits by semicolon', () => {
    const result = parsePhotoUrls('https://a.com/1.jpg;https://b.com/2.jpg');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('https://a.com/1.jpg');
  });

  it('splits by newline', () => {
    const result = parsePhotoUrls('https://a.com/1.jpg\nhttps://b.com/2.jpg');
    expect(result).toHaveLength(2);
  });

  it('filters out non-http entries', () => {
    const result = parsePhotoUrls('https://ok.com/img.jpg;not-a-url;ftp://bad.com');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('https://ok.com/img.jpg');
  });

  it('returns empty array for empty string', () => {
    expect(parsePhotoUrls('')).toHaveLength(0);
  });
});
