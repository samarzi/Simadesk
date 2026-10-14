/**
 * Графики аналитики — без библиотек.
 *
 * Правила (одинаковы для всех графиков):
 *   • одна ось Y; второй ряд — прошлый период на той же шкале;
 *   • столбцы ≤ 24px, скругление 4px на конце данных, прямой угол у базы;
 *   • линии 2px, сетка — сплошные волоски в цвет поверхности;
 *   • подсказка при наведении на любую отметку, текст — через textContent;
 *   • цвет закреплён за показателем, а не за порядком.
 *
 * График времени рисуется под реальную ширину контейнера (mountCharts),
 * поэтому текст не растягивается и на широком экране, и на телефоне.
 */

import { escapeHtml } from './format';

export interface TimePoint {
  /** Подпись по оси X (дата «YYYY-MM-DD» или «нед. 12.10»). */
  x: string;
  /** Подпись в подсказке. */
  label: string;
  y: number;
  /** Значение прошлого периода в той же позиции. */
  prev?: number | null;
}

export interface TimeSpec {
  kind: 'time';
  points: TimePoint[];
  fmt: (n: number) => string;
  /** Формат подписей оси — короткий. */
  axisFmt: (n: number) => string;
  name: string;
  prevName?: string;
  /** CSS-цвет ряда. */
  color: string;
}

const NS = 'http://www.w3.org/2000/svg';

/** «Круглые» деления оси: 0, 25 000, 50 000… */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min), hi = Math.max(0, max);
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Столбец с закруглённым концом данных и прямым углом у базы. */
function columnPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return '';
  if (y1 < y0) { // вверх
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
}

export function drawTimeChart(host: HTMLElement, spec: TimeSpec, tip: Tooltip): void {
  host.textContent = '';
  const W = Math.max(280, host.clientWidth || 600);
  const H = Math.max(180, host.clientHeight || 240);
  const pad = { l: 64, r: 12, t: 12, b: 28 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const pts = spec.points;
  if (!pts.length) { host.innerHTML = '<div class="an-chart-empty">Нет данных за период</div>'; return; }

  const vals = pts.flatMap(p => [p.y, p.prev ?? 0]);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const yOf = (v: number) => pad.t + ph - ((v - lo) / (hi - lo || 1)) * ph;
  const band = pw / pts.length;
  const colW = Math.max(2, Math.min(24, band * 0.62));
  const xOf = (i: number) => pad.l + band * i + band / 2;

  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'an-svg', role: 'img', 'aria-label': spec.name });

  // Сетка и ось Y
  for (const t of ticks) {
    const y = yOf(t);
    svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: t === 0 ? 'an-axis' : 'an-grid' }));
    const label = el('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', class: 'an-tick' });
    label.textContent = spec.axisFmt(t);
    svg.appendChild(label);
  }

  // Подписи X — не больше ~8, чтобы не наползали
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(pw / 72))));
  pts.forEach((p, i) => {
    if (i % every !== 0 && i !== pts.length - 1) return;
    if (i === pts.length - 1 && i % every !== 0 && (pts.length - 1) % every < every / 2) return;
    const t = el('text', { x: xOf(i), y: H - 8, 'text-anchor': 'middle', class: 'an-tick' });
    t.textContent = p.x;
    svg.appendChild(t);
  });

  // Столбцы текущего периода
  const y0 = yOf(0);
  const cols: SVGPathElement[] = [];
  pts.forEach((p, i) => {
    const d = columnPath(xOf(i) - colW / 2, colW, y0, yOf(p.y));
    const path = el('path', { d: d || `M0,0`, fill: spec.color, class: 'an-col' + (p.y < 0 ? ' neg' : '') });
    cols.push(path);
    svg.appendChild(path);
  });

  // Линия прошлого периода
  const hasPrev = pts.some(p => p.prev != null);
  if (hasPrev) {
    const line = pts.map((p, i) => p.prev == null ? null : `${xOf(i)},${yOf(p.prev)}`).filter(Boolean).join(' ');
    svg.appendChild(el('polyline', { points: line, class: 'an-prev-line' }));
  }

  // Слой наведения: вся высота полосы — цель, а не только столбец
  const cross = el('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ph, class: 'an-cross', visibility: 'hidden' });
  svg.appendChild(cross);
  pts.forEach((p, i) => {
    const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: ph, class: 'an-hit', tabindex: 0 });
    const show = (ev: { clientX: number; clientY: number }) => {
      cross.setAttribute('x1', String(xOf(i))); cross.setAttribute('x2', String(xOf(i)));
      cross.setAttribute('visibility', 'visible');
      cols.forEach((c, j) => c.classList.toggle('dim', j !== i));
      const rows: TipRow[] = [{ value: spec.fmt(p.y), name: spec.name, color: spec.color, kind: 'rect' }];
      if (p.prev != null) {
        rows.push({ value: spec.fmt(p.prev), name: spec.prevName ?? 'Прошлый период', color: 'var(--an-prev)', kind: 'line' });
      }
      const delta = p.prev != null && Math.abs(p.prev) > 0.0001 ? (p.y - p.prev) / Math.abs(p.prev) * 100 : null;
      tip.show(ev.clientX, ev.clientY, p.label, rows, delta);
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', () => {
      const r = hit.getBoundingClientRect();
      show({ clientX: r.left + r.width / 2, clientY: r.top + 20 });
    });
    const hide = () => { cross.setAttribute('visibility', 'hidden'); cols.forEach(c => c.classList.remove('dim')); tip.hide(); };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    svg.appendChild(hit);
  });

  host.appendChild(svg);
}

// ── Подсказка ─────────────────────────────────────────────────────────────

export interface TipRow { value: string; name: string; color: string; kind: 'rect' | 'line' }

export class Tooltip {
  private node: HTMLDivElement;
  constructor(parent: HTMLElement) {
    this.node = document.createElement('div');
    this.node.className = 'an-tip';
    this.node.setAttribute('role', 'tooltip');
    parent.appendChild(this.node);
  }
  show(x: number, y: number, title: string, rows: TipRow[], deltaPct: number | null = null): void {
    const n = this.node;
    n.textContent = '';
    const h = document.createElement('div');
    h.className = 'an-tip-title';
    h.textContent = title;
    n.appendChild(h);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'an-tip-row';
      const key = document.createElement('span');
      key.className = `an-tip-key ${r.kind}`;
      key.style.background = r.color;
      const v = document.createElement('strong');
      v.textContent = r.value;
      const name = document.createElement('span');
      name.className = 'an-tip-name';
      name.textContent = r.name;
      row.append(key, v, name);
      n.appendChild(row);
    }
    if (deltaPct != null && Number.isFinite(deltaPct)) {
      const d = document.createElement('div');
      d.className = `an-tip-delta ${deltaPct >= 0 ? 'up' : 'down'}`;
      d.textContent = `${deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(deltaPct).toFixed(1).replace('.', ',')}% к прошлому периоду`;
      n.appendChild(d);
    }
    n.classList.add('on');
    const w = n.offsetWidth, hh = n.offsetHeight;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14));
    const top = y + hh + 20 > window.innerHeight ? y - hh - 12 : y + 14;
    n.style.left = `${left}px`;
    n.style.top = `${top}px`;
  }
  hide(): void { this.node.classList.remove('on'); }
  destroy(): void { this.node.remove(); }
}

// ── HTML-графики (не требуют измерения ширины) ───────────────────────────

export interface BarRow {
  label: string;
  value: number;
  /** Подпись справа (значение). */
  valueText: string;
  /** Вторая подпись (доля, кол-во). */
  sub?: string;
  color: string;
  /** Текст подсказки. */
  tip?: string;
}

/** Горизонтальные столбцы от общей базы: отрицательные — влево. */
export function hbars(rows: BarRow[]): string {
  if (!rows.length) return '<div class="an-chart-empty">Нет данных</div>';
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1);
  const hasNeg = rows.some(r => r.value < 0);
  return `<div class="an-hbars ${hasNeg ? 'with-neg' : ''}">${rows.map(r => {
    const w = Math.abs(r.value) / max * (hasNeg ? 50 : 100);
    const style = hasNeg
      ? (r.value >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`)
      : `left:0;width:${w}%`;
    return `
      <div class="an-hbar" ${r.tip ? `data-tip="${escapeHtml(r.tip)}"` : ''}>
        <div class="an-hbar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
        <div class="an-hbar-track"><div class="an-hbar-fill ${r.value < 0 ? 'neg' : ''}" style="${style};background:${r.color}"></div></div>
        <div class="an-hbar-value">${escapeHtml(r.valueText)}${r.sub ? `<span>${escapeHtml(r.sub)}</span>` : ''}</div>
      </div>`;
  }).join('')}</div>`;
}

export interface StackPart { label: string; value: number; color: string; valueText: string }

/** Одна полоса «часть от целого» с легендой. Части ≤ 0 не рисуются. */
export function stackBar(parts: StackPart[]): string {
  const shown = parts.filter(p => p.value > 0);
  const total = shown.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return '<div class="an-chart-empty">Нет данных</div>';
  return `
    <div class="an-stack" role="img" aria-label="${escapeHtml(shown.map(p => `${p.label} ${p.valueText}`).join(', '))}">
      ${shown.map(p => `<div class="an-stack-seg" style="flex:${p.value} 1 0;background:${p.color}"
        data-tip="${escapeHtml(`${p.label}: ${p.valueText} · ${(p.value / total * 100).toFixed(1).replace('.', ',')}%`)}"></div>`).join('')}
    </div>
    <div class="an-legend">
      ${parts.map(p => `
        <div class="an-legend-item">
          <span class="an-legend-key" style="background:${p.color}"></span>
          <span class="an-legend-name">${escapeHtml(p.label)}</span>
          <strong>${escapeHtml(p.valueText)}</strong>
          ${total > 0 && p.value > 0 ? `<span class="an-legend-pct">${(p.value / total * 100).toFixed(0)}%</span>` : ''}
        </div>`).join('')}
    </div>`;
}

/** Мини-линия тренда для плитки показателя. */
export function sparkline(values: number[]): string {
  if (values.length < 2) return '';
  const W = 96, H = 28;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const step = W / (values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 2 - (v - min) / span * (H - 4)).toFixed(1)}`).join(' ');
  return `<svg class="an-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><path d="${d}"/></svg>`;
}
