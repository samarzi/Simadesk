/** SVG-графики админ-панели. Цвета берутся из CSS-переменных → работают в обеих темах. */

type Series = Array<{ date: string; count: number }>;

const esc = (s: string): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const empty = (text = 'Нет данных за период') => `<div class="ap-chart-empty">${text}</div>`;

const shortDate = (iso: string): string =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';

/** Накопительный график с заливкой: сетка, подписи осей, точки с тултипами. */
export function areaChart(data: Series, finalTotal: number, color: string, gradId = 'apGrad'): string {
  if (!data?.length) return empty();
  const W = 640, H = 190, padR = 14, padT = 14, padB = 24;

  const sum = data.reduce((s, d) => s + d.count, 0);
  const minV = Math.max(0, finalTotal - sum);
  let running = minV;
  const pts = data.map(d => { running += d.count; return { date: d.date, val: running }; });
  const maxV = Math.max(...pts.map(p => p.val), 1);
  const range = Math.max(1, maxV - minV);

  // Тысячи сокращаем только когда шаг сетки сам крупнее 1000 — иначе все
  // подписи схлопнутся в одинаковое «2k» на узком диапазоне значений.
  const stepV = range / 4;
  const axisLabel = (v: number) => stepV >= 1000
    ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k'
    : v.toLocaleString('ru-RU');
  // Ширина оси Y подстраивается под самую длинную подпись.
  const padL = Math.max(42, axisLabel(maxV).length * 6 + 14);
  const iw = W - padL - padR, ih = H - padT - padB;

  const x = (i: number) => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => padT + ih - ((v - minV) / range) * ih;

  const grid: string[] = [];
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ih / 4) * g;
    const gv = Math.round(maxV - stepV * g);
    grid.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="currentColor" stroke-width="1" opacity=".13"/>`);
    grid.push(`<text x="${padL - 8}" y="${gy + 3.5}" text-anchor="end" font-size="9.5" fill="currentColor" opacity=".5">${axisLabel(gv)}</text>`);
  }

  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.val).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${x(0).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  const step = Math.max(1, Math.floor(pts.length / 6));
  const labels = pts.map((p, i) => (i % step !== 0 && i !== pts.length - 1) ? '' :
    `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="currentColor" opacity=".5">${shortDate(p.date)}</text>`).join('');

  const dots = pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.val).toFixed(1)}" r="2.6" fill="${color}"><title>${shortDate(p.date)}: ${p.val}</title></circle>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;color:var(--text3)" role="img">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".34"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid.join('')}
    <path d="${area}" fill="url(#${gradId})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}
  </svg>`;
}

/** Двухсерийная столбчатая диаграмма (пользователи против компаний). */
export function groupedBars(a: Series, b: Series, colorA: string, colorB: string): string {
  const n = Math.max(a.length, b.length);
  if (!n) return empty();
  const W = 640, H = 170, padL = 34, padR = 10, padT = 12, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const slot = iw / n;
  const bw = Math.max(2, Math.min(10, slot / 2 - 1));
  const max = Math.max(1, ...a.map(d => d.count), ...b.map(d => d.count));

  const grid: string[] = [];
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (ih / 3) * g;
    const gv = Math.round(max - (max / 3) * g);
    grid.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="currentColor" stroke-width="1" opacity=".13"/>`);
    grid.push(`<text x="${padL - 7}" y="${gy + 3.5}" text-anchor="end" font-size="9.5" fill="currentColor" opacity=".5">${gv}</text>`);
  }

  const bars: string[] = [];
  for (let i = 0; i < n; i++) {
    const ax = padL + slot * i + slot / 2 - bw - 1;
    const bx = padL + slot * i + slot / 2 + 1;
    const av = a[i]?.count ?? 0, bv = b[i]?.count ?? 0;
    const ah = (av / max) * ih, bh = (bv / max) * ih;
    const ds = shortDate(a[i]?.date ?? b[i]?.date ?? '');
    if (av > 0) bars.push(`<rect x="${ax.toFixed(1)}" y="${(padT + ih - ah).toFixed(1)}" width="${bw.toFixed(1)}" height="${ah.toFixed(1)}" rx="2" fill="${colorA}"><title>${ds}: ${av}</title></rect>`);
    if (bv > 0) bars.push(`<rect x="${bx.toFixed(1)}" y="${(padT + ih - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${colorB}"><title>${ds}: ${bv}</title></rect>`);
  }

  const step = Math.max(1, Math.floor(n / 6));
  const labels: string[] = [];
  for (let i = 0; i < n; i += step) {
    labels.push(`<text x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="currentColor" opacity=".5">${shortDate(a[i]?.date ?? '')}</text>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;color:var(--text3)">${grid.join('')}${bars.join('')}${labels.join('')}</svg>`;
}

/** Горизонтальные бары: топ компаний по обороту. */
export function hBars(data: Array<{ name: string; revenue: number }>, color: string, fmt: (n: number) => string): string {
  if (!data?.length) return empty('Нет данных об обороте');
  const max = Math.max(...data.map(d => d.revenue), 1);
  const rowH = 32, H = data.length * rowH, W = 480, labelW = 132, valW = 66;
  const rows = data.map((d, i) => {
    const trackW = W - labelW - valW;
    const barW = Math.round((d.revenue / max) * trackW);
    const y = i * rowH + 6;
    const nm = d.name.length > 17 ? d.name.slice(0, 16) + '…' : d.name;
    return `
      <text x="0" y="${y + 9}" font-size="11.5" fill="currentColor" opacity=".75" dominant-baseline="middle">${esc(nm)}</text>
      <rect x="${labelW}" y="${y + 1}" width="${trackW}" height="16" rx="5" fill="currentColor" opacity=".08"/>
      <rect x="${labelW}" y="${y + 1}" width="${barW}" height="16" rx="5" fill="${color}"><title>${esc(d.name)}: ${d.revenue}</title></rect>
      <text x="${W}" y="${y + 9}" text-anchor="end" font-size="11" font-weight="700" fill="currentColor" opacity=".8" dominant-baseline="middle">${fmt(d.revenue)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:280px;color:var(--text)">${rows.join('')}</svg>`;
}

/** Кольцевая диаграмма распределения по тарифам + легенда. */
export function donut(
  data: Array<{ plan: string; count: number }>,
  colors: Record<string, string>,
  labels: Record<string, string>,
): string {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!total) return empty('Нет активных подписок');
  const cx = 82, cy = 82, r = 66, ri = 45;
  let start = -Math.PI / 2;
  const slices = data.map(d => {
    const angle = (d.count / total) * 2 * Math.PI;
    const end = start + angle;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
    const i1x = cx + ri * Math.cos(start), i1y = cy + ri * Math.sin(start);
    const i2x = cx + ri * Math.cos(end),   i2y = cy + ri * Math.sin(end);
    const large = angle > Math.PI ? 1 : 0;
    const col = colors[d.plan] ?? '#64748b';
    const pct = Math.round((d.count / total) * 100);
    const path = data.length === 1
      ? `M${cx} ${cy - r} A${r} ${r} 0 1 1 ${cx - .01} ${cy - r} Z M${cx} ${cy - ri} A${ri} ${ri} 0 1 0 ${cx - .01} ${cy - ri} Z`
      : `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${i2x},${i2y} A${ri},${ri} 0 ${large} 0 ${i1x},${i1y} Z`;
    start = end;
    return {
      svg: `<path d="${path}" fill="${col}" fill-rule="evenodd"><title>${labels[d.plan] ?? d.plan}: ${d.count} (${pct}%)</title></path>`,
      col, pct, d,
    };
  });

  const legend = slices.map(s => `
    <div class="ap-donut-row">
      <span class="ap-dot" style="background:${s.col}"></span>
      <span class="nm">${esc(labels[s.d.plan] ?? s.d.plan)}</span>
      <span class="pct">${s.pct}%</span>
      <span class="cnt">${s.d.count}</span>
    </div>`).join('');

  return `<div class="ap-donut">
    <svg viewBox="0 0 164 164" style="width:150px;height:150px;flex-shrink:0">
      ${slices.map(s => s.svg).join('')}
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="23" font-weight="750" fill="var(--text)">${total}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9.5" fill="var(--text3)">подписок</text>
    </svg>
    <div class="ap-donut-legend">${legend}</div>
  </div>`;
}
