/** Форматирование чисел и дат для аналитики. Везде русская запись: «1 234,56 ₽», «12,5%». */

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

const sign = (v: number) => (v < 0 ? '−' : '');

/** Точная сумма в рублях: «1 234 567 ₽». */
export function rub(v: number): string { return `${sign(v)}${nf0.format(Math.abs(v))} ₽`; }

/** С копейками — для удельных показателей: «1 234,56 ₽». */
export function rub2(v: number): string { return `${sign(v)}${nf2.format(Math.abs(v))} ₽`; }

/** Компактно для осей и мелких подписей: «25 тыс», «1,2 млн». */
export function rubShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign(v)}${nf1.format(a / 1_000_000)} млн`;
  if (a >= 1_000) return `${sign(v)}${nf0.format(a / 1_000)} тыс`;
  return `${sign(v)}${nf0.format(a)}`;
}

export function num(v: number): string { return `${sign(v)}${nf0.format(Math.abs(v))}`; }

/** Штуки, дробные — с одним знаком: «957,6». */
export function qty(v: number): string { return Number.isInteger(v) ? num(v) : `${sign(v)}${nf1.format(Math.abs(v))}`; }

export function pct(v: number, digits = 1): string {
  return `${sign(v)}${Math.abs(v).toFixed(digits).replace('.', ',')}%`;
}

/** «12.10» */
export function dayShort(day: string): string {
  const [, m, d] = day.split('-');
  return d && m ? `${d}.${m}` : day;
}

/** «12 окт, пн» */
export function dayLong(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' });
}

/** Дата и время по Москве: «14.10.2026, 15:04». */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

/** Для вставки строки в onclick="…('…')". */
export function jsArg(s: string): string {
  return escapeHtml(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

/** Склонение: plural(5, ['заказ', 'заказа', 'заказов']). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(Math.trunc(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
