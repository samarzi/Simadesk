/** Форматирование цифр. */

export function fmtMoney(v: number, withRuble = true): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  let s: string;
  if (abs >= 1_000_000) s = (abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2) + ' млн';
  else if (abs >= 10_000) s = (abs / 1000).toFixed(0) + ' тыс';
  else s = abs.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  return sign + s + (withRuble ? ' ₽' : '');
}

export function fmtFull(v: number): string {
  return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}

export function fmtNum(v: number): string {
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

export function fmtPct(v: number, digits = 1): string {
  return (v >= 0 ? '' : '−') + Math.abs(v).toFixed(digits) + '%';
}

export function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fmtDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
