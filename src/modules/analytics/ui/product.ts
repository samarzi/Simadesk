/**
 * Единый вид товара во всех таблицах и списках аналитики:
 * название (клик — открыть товар в разделе «Товары»), артикул и кнопки
 * «скопировать название» / «скопировать артикул».
 */

import { Mp, MP_SHORT } from '../types';
import { escapeHtml, jsArg } from './format';

export interface ProductRef {
  name: string;
  vendor_code: string;
  mp?: Mp;
}

const M = 'window.analyticsModule';

const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"/></svg>';

export function copyButton(text: string, what: 'артикул' | 'название'): string {
  if (!text) return '';
  return `<button type="button" class="an-copy" title="Скопировать ${what}" aria-label="Скопировать ${what}"
    onclick="event.stopPropagation();event.preventDefault();${M}?.copyText(this,'${jsArg(text)}')">${COPY_ICON}</button>`;
}

/** Строка товара: [МП] Название ⧉ / артикул ⧉ · подпись. */
export function productCell(p: ProductRef, opts: { sub?: string; mpBadge?: boolean; compact?: boolean } = {}): string {
  const name = p.name || p.vendor_code || '—';
  const vc = p.vendor_code || '';
  const link = vc && vc !== '—'
    ? `<a href="#" class="an-prod-name" title="Открыть в разделе «Товары»: ${escapeHtml(name)}"
        onclick="event.preventDefault();event.stopPropagation();${M}?.goToProduct('${jsArg(vc)}')">${escapeHtml(name)}</a>`
    : `<span class="an-prod-name plain">${escapeHtml(name)}</span>`;
  return `
    <div class="an-prod${opts.compact ? ' compact' : ''}">
      ${opts.mpBadge !== false && p.mp ? `<span class="an-mp an-mp-${p.mp}">${MP_SHORT[p.mp]}</span>` : ''}
      <div class="an-prod-text">
        <div class="an-prod-line">${link}${copyButton(p.name, 'название')}</div>
        ${vc ? `<div class="an-prod-meta"><span class="an-mono">${escapeHtml(vc)}</span>${copyButton(vc, 'артикул')}${opts.sub ? `<span class="an-prod-sub">${opts.sub}</span>` : ''}</div>` : ''}
      </div>
    </div>`;
}
