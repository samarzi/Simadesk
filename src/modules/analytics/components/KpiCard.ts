import { fmtMoney, fmtPct } from './format';

export interface KpiCardOpts {
  label: string;
  value: number;
  prev?: number | null;
  format?: 'money' | 'pct' | 'int';
  tint?: string;            // CSS color для радиального фона
  sparkline?: number[];     // 12-30 точек
  invertDelta?: boolean;    // для расходов: рост = плохо
}

function renderSpark(points: number[]): string {
  if (!points || points.length < 2) return '';
  const W = 90, H = 32;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = W / (points.length - 1);
  const path = points.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 2 - ((v - min) / range) * (H - 4)).toFixed(1)}`).join(' ');
  return `<svg class="an2-kpi-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export function renderKpiCard(opts: KpiCardOpts): string {
  const fmt = opts.format ?? 'money';
  let valueText: string;
  if (fmt === 'money')      valueText = fmtMoney(opts.value);
  else if (fmt === 'pct')   valueText = fmtPct(opts.value);
  else                      valueText = opts.value.toLocaleString('ru-RU');

  let deltaHtml = '';
  if (opts.prev != null && isFinite(opts.prev) && Math.abs(opts.prev) > 0.001) {
    const diff = opts.value - opts.prev;
    const pct = (diff / Math.abs(opts.prev)) * 100;
    if (Math.abs(pct) >= 0.1) {
      const isUp = pct > 0;
      const isGood = opts.invertDelta ? !isUp : isUp;
      const cls = isGood ? 'up' : 'down';
      deltaHtml = `<div class="an2-kpi-delta ${cls}">${isUp ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</div>`;
    }
  }

  const tint = opts.tint ?? 'var(--accent-dim)';
  const spark = opts.sparkline ? renderSpark(opts.sparkline) : '';

  return `
    <div class="an2-kpi" style="--an-tint: ${tint}; color: ${opts.tint ?? 'var(--accent)'}">
      <div class="an2-kpi-label" style="color: var(--text3)">${opts.label}</div>
      <div class="an2-kpi-value an2-anim-count" style="color: var(--text)">${valueText}</div>
      ${deltaHtml}
      ${spark}
    </div>
  `;
}
