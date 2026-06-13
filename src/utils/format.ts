/**
 * Pure utility functions — no DOM, no side effects.
 * Extracted from App.ts so they can be unit-tested independently.
 */

/**
 * Escape HTML special characters to prevent XSS when inserting into innerHTML.
 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Russian plural suffix for "товар".
 * 1 → '' (товар), 2-4 → 'а' (товара), 5+ → 'ов' (товаров)
 */
export function productSuffix(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'а';
  return 'ов';
}

/**
 * Escape a string for safe use inside a RegExp constructor.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the first emoji grapheme from a string.
 * Falls back to the first two code points if Intl.Segmenter is unavailable.
 */
export function extractFirstEmoji(s: string): string {
  if (!s) return '';
  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    const seg = new (Intl as any).Segmenter('en', { granularity: 'grapheme' }).segment(s);
    for (const g of seg) {
      try {
        if (/\p{Extended_Pictographic}/u.test(g.segment)) return g.segment;
      } catch {
        return g.segment;
      }
    }
    return '';
  }
  return [...s].slice(0, 2).join('');
}

/**
 * Format a number as a Russian locale price string.
 * e.g. 12500 → "12 500 ₽"
 */
export function formatPrice(n: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return '—';
  return num.toLocaleString('ru') + ' ₽';
}

/**
 * Parse a semicolon- or newline-separated list of URLs.
 * Filters out non-http entries.
 */
export function parsePhotoUrls(raw: string): string[] {
  return raw
    .split(/[;,\n]/)
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));
}
