import { I } from './icons';

function escAttr(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline "copy to clipboard" button (uses the global window.app.copyToClipboard).
 * Takes the raw (unescaped) value — escaping for the HTML attribute happens here.
 */
export function copyButton(value: unknown, title = 'Скопировать'): string {
  const v = String(value ?? '');
  if (!v) return '';
  return `<button class="copy-btn" title="${escAttr(title)}" onclick="event.stopPropagation();window.app.copyToClipboard('${escAttr(v)}')">${I.copy('', 10)}</button>`;
}
