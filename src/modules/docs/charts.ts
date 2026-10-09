/**
 * Диаграммы листа — отрисовка в SVG.
 *
 * Данные берутся по ссылкам ряда (как в Excel), поэтому диаграмма живая:
 * поменяли число в ячейке — столбик перерисовался. В файл .xlsx диаграмма
 * уходит настоящей диаграммой Excel (см. xlsxIO.writeCharts).
 */

import type { ChartSpec } from './model';

export const CHART_COLORS = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300'];

export interface ChartData {
  categories: string[];
  series: Array<{ name: string; values: Array<number | null>; color: string; xs?: Array<number | null> }>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Число для подписи оси: 12 500 → «12,5 тыс.», без длинных хвостов. */
export function shortNum(n: number): string {
  const a = Math.abs(n);
  const f = (v: number, suf: string) => (Math.round(v * 10) / 10).toString().replace('.', ',') + suf;
  if (a >= 1e9) return f(n / 1e9, ' млрд');
  if (a >= 1e6) return f(n / 1e6, ' млн');
  if (a >= 1e4) return f(n / 1e3, ' тыс.');
  return (Math.round(n * 100) / 100).toString().replace('.', ',');
}

/** «Красивые» деления оси: 0, 20, 40… */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) { if (max === 0) max = 1; else if (max > 0) min = 0; else max = 0; }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export function renderChartSvg(ch: ChartSpec, d: ChartData): string {
  const W = Math.max(120, ch.w), H = Math.max(90, ch.h);
  const font = 'font-family="Calibri,Segoe UI,Arial,sans-serif"';
  const titleH = ch.title ? 28 : 8;
  const isPie = ch.kind === 'pie' || ch.kind === 'doughnut';
  const showLegend = ch.legend !== false && (isPie || d.series.length > 1);
  const legendItems = isPie ? d.categories.map((c, i) => ({ name: c, color: CHART_COLORS[i % CHART_COLORS.length] })) : d.series.map(s => ({ name: s.name, color: s.color }));
  const legendH = showLegend && !isPie ? 22 : 0;
  const legendW = showLegend && isPie ? Math.min(160, W * 0.35) : 0;

  let body = '';
  const title = ch.title ? `<text x="${W / 2}" y="20" text-anchor="middle" font-size="14" fill="#404040" ${font}>${esc(ch.title)}</text>` : '';

  if (!d.series.length || d.series.every(s => s.values.every(v => v === null))) {
    body = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="#999" ${font}>Нет данных для диаграммы</text>`;
  } else if (isPie) {
    const vals = d.series[0].values.map(v => Math.max(0, v ?? 0));
    const total = vals.reduce((s, v) => s + v, 0) || 1;
    const cx = (W - legendW) / 2, cy = titleH + (H - titleH) / 2;
    const R = Math.max(10, Math.min((W - legendW) / 2, (H - titleH) / 2) - 10);
    const r0 = ch.kind === 'doughnut' ? R * 0.55 : 0;
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const da = (v / total) * Math.PI * 2;
      if (da <= 0) return;
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const a2 = a + da;
      const large = da > Math.PI ? 1 : 0;
      const p = (rad: number, ang: number) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
      if (da >= Math.PI * 2 - 1e-6) {
        body += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}"/>` + (r0 ? `<circle cx="${cx}" cy="${cy}" r="${r0}" fill="#fff"/>` : '');
      } else if (r0) {
        body += `<path d="M${p(R, a)} A${R},${R} 0 ${large} 1 ${p(R, a2)} L${p(r0, a2)} A${r0},${r0} 0 ${large} 0 ${p(r0, a)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`;
      } else {
        body += `<path d="M${cx},${cy} L${p(R, a)} A${R},${R} 0 ${large} 1 ${p(R, a2)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`;
      }
      const mid = a + da / 2, lr = r0 ? (R + r0) / 2 : R * 0.65;
      const pct = Math.round((v / total) * 100);
      if (pct >= 4) body += `<text x="${cx + lr * Math.cos(mid)}" y="${cy + lr * Math.sin(mid) + 4}" text-anchor="middle" font-size="11" fill="#fff" ${font}>${pct}%</text>`;
      a = a2;
    });
  } else {
    const padL = 52, padR = 14, padB = 34, padT = titleH + 6;
    const pw = W - padL - padR, ph = H - padT - padB - legendH;
    const n = Math.max(d.categories.length, ...d.series.map(s => s.values.length));
    const isBar = ch.kind === 'bar';
    let lo = 0, hi = 0;
    if (ch.stacked) {
      for (let i = 0; i < n; i++) {
        let pos = 0, neg = 0;
        for (const s of d.series) { const v = s.values[i] ?? 0; if (v >= 0) pos += v; else neg += v; }
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      }
    } else {
      for (const s of d.series) for (const v of s.values) if (v !== null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
    let xsMin = 0, xsMax = 1;
    if (ch.kind === 'scatter') {
      const xs = d.series.flatMap(s => (s.xs ?? s.values.map((_, i) => i + 1)).filter((v): v is number => v !== null));
      xsMin = Math.min(...xs); xsMax = Math.max(...xs); if (xsMin === xsMax) xsMax = xsMin + 1;
    }
    const ticks = niceTicks(lo, hi);
    const tMin = ticks[0], tMax = ticks[ticks.length - 1];
    const scale = (v: number) => (v - tMin) / (tMax - tMin || 1);

    // Сетка и подписи значений
    for (const t of ticks) {
      if (isBar) {
        const x = padL + scale(t) * pw;
        body += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + ph}" stroke="#e6e6e6"/>`;
        body += `<text x="${x}" y="${padT + ph + 14}" text-anchor="middle" font-size="10" fill="#595959" ${font}>${esc(shortNum(t))}</text>`;
      } else {
        const y = padT + ph - scale(t) * ph;
        body += `<line x1="${padL}" y1="${y}" x2="${padL + pw}" y2="${y}" stroke="#e6e6e6"/>`;
        body += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="#595959" ${font}>${esc(shortNum(t))}</text>`;
      }
    }
    const band = (isBar ? ph : pw) / Math.max(1, n);
    const zero = scale(Math.max(tMin, Math.min(0, tMax)));

    if (ch.kind === 'col' || ch.kind === 'bar') {
      const groups = ch.stacked ? 1 : d.series.length;
      const bw = band * 0.7 / groups;
      for (let i = 0; i < n; i++) {
        let accPos = 0, accNeg = 0;
        d.series.forEach((s, si) => {
          const v = s.values[i]; if (v === null || v === undefined) return;
          let from: number, to: number;
          if (ch.stacked) { if (v >= 0) { from = accPos; to = accPos + v; accPos = to; } else { from = accNeg; to = accNeg + v; accNeg = to; } }
          else { from = 0; to = v; }
          const a1 = scale(Math.min(from, to)), a2 = scale(Math.max(from, to));
          const off = band * 0.15 + (ch.stacked ? 0 : si * bw);
          if (isBar) {
            const y = padT + i * band + off;
            body += `<rect x="${padL + a1 * pw}" y="${y}" width="${Math.max(1, (a2 - a1) * pw)}" height="${bw}" fill="${s.color}"><title>${esc(s.name)}: ${esc(shortNum(v))}</title></rect>`;
          } else {
            const x = padL + i * band + off;
            body += `<rect x="${x}" y="${padT + ph - a2 * ph}" width="${bw}" height="${Math.max(1, (a2 - a1) * ph)}" fill="${s.color}"><title>${esc(s.name)}: ${esc(shortNum(v))}</title></rect>`;
          }
        });
      }
    } else if (ch.kind === 'scatter') {
      d.series.forEach(s => {
        const xs = s.xs ?? s.values.map((_, i) => i + 1);
        s.values.forEach((v, i) => {
          const xv = xs[i]; if (v === null || xv === null || xv === undefined) return;
          const x = padL + ((xv - xsMin) / (xsMax - xsMin)) * pw, y = padT + ph - scale(v) * ph;
          body += `<circle cx="${x}" cy="${y}" r="3.5" fill="${s.color}"><title>${esc(shortNum(xv))}; ${esc(shortNum(v))}</title></circle>`;
        });
      });
    } else {
      const acc = new Array(n).fill(0);
      d.series.forEach(s => {
        const pts: string[] = [];
        for (let i = 0; i < n; i++) {
          const raw = s.values[i];
          if (raw === null || raw === undefined) { if (!ch.stacked) continue; }
          const v = (ch.stacked ? acc[i] : 0) + (raw ?? 0);
          if (ch.stacked) acc[i] = v;
          pts.push(`${padL + (i + 0.5) * band},${padT + ph - scale(v) * ph}`);
        }
        if (!pts.length) return;
        if (ch.kind === 'area') {
          const first = pts[0].split(',')[0], last = pts[pts.length - 1].split(',')[0];
          body += `<polygon points="${first},${padT + ph - zero * ph} ${pts.join(' ')} ${last},${padT + ph - zero * ph}" fill="${s.color}" fill-opacity=".55" stroke="${s.color}" stroke-width="1.5"/>`;
        } else {
          body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round"/>`;
          for (const p of pts) { const [x, y] = p.split(','); body += `<circle cx="${x}" cy="${y}" r="2.75" fill="${s.color}"/>`; }
        }
      });
    }

    // Ось и подписи категорий
    if (isBar) {
      body += `<line x1="${padL + zero * pw}" y1="${padT}" x2="${padL + zero * pw}" y2="${padT + ph}" stroke="#bfbfbf"/>`;
      d.categories.slice(0, n).forEach((c, i) => {
        body += `<text x="${padL - 6}" y="${padT + (i + 0.5) * band + 3}" text-anchor="end" font-size="10" fill="#595959" ${font}>${esc(c.length > 12 ? c.slice(0, 11) + '…' : c)}</text>`;
      });
    } else if (ch.kind !== 'scatter') {
      body += `<line x1="${padL}" y1="${padT + ph - zero * ph}" x2="${padL + pw}" y2="${padT + ph - zero * ph}" stroke="#bfbfbf"/>`;
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
      d.categories.slice(0, n).forEach((c, i) => {
        if (i % every) return;
        const label = c.length > 10 ? c.slice(0, 9) + '…' : c;
        body += `<text x="${padL + (i + 0.5) * band}" y="${padT + ph + 14}" text-anchor="middle" font-size="10" fill="#595959" ${font}>${esc(label)}</text>`;
      });
    }
  }

  let legend = '';
  if (showLegend) {
    if (isPie) {
      legendItems.slice(0, 12).forEach((it, i) => {
        const y = titleH + 14 + i * 18;
        legend += `<rect x="${W - legendW + 6}" y="${y - 9}" width="10" height="10" fill="${it.color}"/><text x="${W - legendW + 22}" y="${y}" font-size="11" fill="#404040" ${font}>${esc(it.name.length > 18 ? it.name.slice(0, 17) + '…' : it.name)}</text>`;
      });
    } else {
      const itemW = Math.min(140, W / Math.max(1, legendItems.length));
      const startX = (W - itemW * legendItems.length) / 2;
      legendItems.forEach((it, i) => {
        const x = startX + i * itemW, y = H - 8;
        legend += `<rect x="${x}" y="${y - 9}" width="10" height="10" fill="${it.color}"/><text x="${x + 14}" y="${y}" font-size="11" fill="#404040" ${font}>${esc(it.name.length > 16 ? it.name.slice(0, 15) + '…' : it.name)}</text>`;
      });
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#fff" stroke="#d9d9d9"/>${title}${body}${legend}</svg>`;
}
