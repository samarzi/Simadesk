/**
 * Общий каркас страниц детализации KPI.
 *
 * Каждая карточка сводки открывает свою страницу: у неё своя шапка с кнопкой
 * «Назад» (возврат в «Аналитика → Сводка»), свой набор блоков и свои советы.
 */

import { KPI, Order, Mp, MP_SHORT, MP_COLOR, TimeseriesPoint } from '../../types';
import { fmtMoney, fmtNum, fmtFull, escapeHtml } from '../../components/format';

export type DetailKey =
  | 'revenue'    // Выручка
  | 'gross'      // Выплата МП
  | 'profit'     // Чистая прибыль
  | 'margin'     // Маржа
  | 'delivered'  // Заказов доставлено
  | 'expenses'   // Расходы
  | 'returns';   // Возвраты и отмены

export const DETAIL_KEYS: DetailKey[] = ['revenue', 'gross', 'profit', 'margin', 'delivered', 'expenses', 'returns'];

export function isDetailKey(v: string): v is DetailKey {
  return (DETAIL_KEYS as string[]).includes(v);
}

export interface DetailCtx {
  kpi: KPI;
  prevKpi: KPI | null;
  orders: Order[];
  ts: TimeseriesPoint[];
  periodLabel: string;
  mp: Mp;
  storeName: string;
}

// ── Каркас ────────────────────────────────────────────────────────────────

export interface FrameOpts {
  title: string;
  /** Главное число крупно. */
  value: string;
  /** Подпись под числом. */
  subtitle: string;
  accent: string;
  delta?: { pct: number; good: boolean } | null;
  body: string;
}

export function detailFrame(o: FrameOpts): string {
  const delta = o.delta
    ? `<span class="an2-dt-delta ${o.delta.good ? 'up' : 'down'}">
         ${o.delta.pct >= 0 ? '↑' : '↓'} ${Math.abs(o.delta.pct).toFixed(1)}% к прошлому периоду
       </span>`
    : '';
  return `
    <div class="an2-detail" style="--an-dt: ${o.accent}">
      <div class="an2-dt-head">
        <button class="an2-dt-back" onclick="window.analyticsModule?.closeDetail()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
               stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          Аналитика
        </button>
        <div class="an2-dt-hero">
          <div class="an2-dt-title">${o.title}</div>
          <div class="an2-dt-value">${o.value}</div>
          <div class="an2-dt-sub">${o.subtitle} ${delta}</div>
        </div>
      </div>
      <div class="an2-dt-body">${o.body}</div>
    </div>
  `;
}

export function deltaOf(cur: number, prev: number | null | undefined, invert = false): { pct: number; good: boolean } | null {
  if (prev == null || !isFinite(prev) || Math.abs(prev) < 0.001) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.1) return null;
  return { pct, good: invert ? pct < 0 : pct > 0 };
}

// ── Строительные блоки ────────────────────────────────────────────────────

export function card(title: string, body: string, note = ''): string {
  return `
    <div class="an2-card">
      <div class="an2-card-head">
        <div class="an2-card-title">${title}</div>
        ${note ? `<div style="font-size:10px;color:var(--text3)">${note}</div>` : ''}
      </div>
      ${body}
    </div>
  `;
}

export interface StatTile {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}

export function statGrid(tiles: StatTile[]): string {
  return `
    <div class="an2-dt-stats">
      ${tiles.map(t => `
        <div class="an2-dt-stat">
          <div class="an2-dt-stat-label">${t.label}</div>
          <div class="an2-dt-stat-value" ${t.color ? `style="color:${t.color}"` : ''}>${t.value}</div>
          ${t.hint ? `<div class="an2-dt-stat-hint">${t.hint}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

export interface BarRow {
  label: string;
  value: number;
  /** Подпись справа — если не задана, форматируется как деньги. */
  valueText?: string;
  share?: string;
  color: string;
  hint?: string;
}

export function barList(rows: BarRow[]): string {
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1);
  if (!rows.length) return emptyBlock('нет данных за период');
  return `
    <div class="an2-dt-bars">
      ${rows.map(r => `
        <div class="an2-dt-bar-row">
          <div class="an2-dt-bar-label">
            ${escapeHtml(r.label)}
            ${r.hint ? `<span class="an2-dt-bar-hint">${r.hint}</span>` : ''}
          </div>
          <div class="an2-dt-bar-track">
            <div class="an2-dt-bar-fill" style="width:${Math.min(100, (Math.abs(r.value) / max) * 100)}%;background:${r.color}"></div>
          </div>
          <div class="an2-dt-bar-value">${r.valueText ?? fmtMoney(r.value)}</div>
          <div class="an2-dt-bar-share">${r.share ?? ''}</div>
        </div>
      `).join('')}
    </div>
  `;
}

export type AdviceLevel = 'good' | 'warn' | 'bad' | 'info';

export interface Advice {
  level: AdviceLevel;
  title: string;
  text: string;
}

const ADVICE_ICON: Record<AdviceLevel, string> = { good: '✓', warn: '!', bad: '×', info: 'i' };

export function adviceBlock(items: Advice[]): string {
  if (!items.length) return '';
  return `
    <div class="an2-card">
      <div class="an2-card-head"><div class="an2-card-title">Что с этим делать</div></div>
      <div class="an2-dt-advice">
        ${items.map(a => `
          <div class="an2-dt-advice-row ${a.level}">
            <div class="an2-dt-advice-icon">${ADVICE_ICON[a.level]}</div>
            <div>
              <div class="an2-dt-advice-title">${a.title}</div>
              <div class="an2-dt-advice-text">${a.text}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

export function emptyBlock(text: string): string {
  return `<div style="padding:24px;text-align:center;color:var(--text3);font-size:11px">${text}</div>`;
}

/** Плашка «часть денег ещё в расчёте» — выкуплено, но финотчёт МП не пришёл. */
export function awaitingNote(k: KPI): string {
  if (k.awaiting_orders <= 0) return '';
  return `
    <div class="an2-dt-note">
      Ещё <strong>${fmtMoney(k.awaiting_revenue)}</strong> по
      <strong>${fmtNum(k.awaiting_orders)}</strong> ${plural(k.awaiting_orders, 'выкупленному заказу', 'выкупленным заказам', 'выкупленным заказам')}
      ждут расчёта маркетплейса. Пока отчёт не пришёл, комиссия и логистика по ним неизвестны,
      поэтому в выручку и прибыль они не включены — цифры ниже занижены на эту сумму, но не выдуманы.
    </div>
  `;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5)   return few;
  if (b === 1)          return one;
  return many;
}

export function mpBadge(mp: Mp): string {
  return `<span class="mp-badge"><span class="mp-dot" style="background:${MP_COLOR[mp]}"></span>${MP_SHORT[mp]}</span>`;
}

/** Итог по дням: суммируем поле по заказам и отдаём готовый ряд для мини-графика. */
export function dailySeries(orders: Order[], pick: (o: Order) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of orders) {
    if (!o.date) continue;
    const d = o.date.slice(0, 10);
    m.set(d, (m.get(d) ?? 0) + pick(o));
  }
  return m;
}

/** Компактный SVG-спарклайн по массиву значений. */
export function sparkline(points: number[], color: string, height = 54): string {
  if (points.length < 2) return emptyBlock('мало точек для графика');
  const W = 600, H = height;
  const min = Math.min(0, ...points);
  const max = Math.max(...points, 1);
  const range = max - min || 1;
  const step = W / (points.length - 1);
  const y = (v: number) => (H - 4 - ((v - min) / range) * (H - 8)).toFixed(1);
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const zeroY = y(0);
  return `
    <svg class="an2-dt-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${area}" fill="${color}" opacity=".13"/>
      ${min < 0 ? `<line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>` : ''}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
  `;
}

export { fmtMoney, fmtNum, fmtFull, escapeHtml };
