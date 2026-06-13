/**
 * Chart — продвинутый SVG-график с интерактивными режимами.
 *
 * Возможности:
 *  - Тип графика: линия / область / колонки
 *  - Тоггл серий: выручка / прибыль / расходы (любое сочетание)
 *  - Группировка: по дням / по неделям / по месяцам
 *  - Кумулятивный режим (накопительный итог)
 *  - Средняя линия (avg)
 *  - Hover-тултип с разницей "день к среднему"
 *  - Анимации: stagger для bars, draw-on для линий, плавные переходы
 *
 * Управление — через window._an2CB(action, value) → состояние в window._an2CC.
 * Состояние сохраняется в localStorage чтобы пользователь не терял настройки.
 */

import { TimeseriesPoint } from '../types';

type ChartType = 'line' | 'area' | 'bar';
type Granularity = 'day' | 'week' | 'month';
type SeriesKey = 'revenue' | 'profit' | 'expenses';

interface ChartState {
  type: ChartType;
  granularity: Granularity;
  series: Record<SeriesKey, boolean>;
  cumulative: boolean;
  showAvg: boolean;
  /** 7-дневная скользящая средняя — сглаживает шум, точнее видно тренд. */
  showMA: boolean;
  /** Авто-агрегация: при >90 точек в режиме day автоматически переключаем на week. */
  autoGran: boolean;
}

interface ChartCfg extends ChartState {
  data: TimeseriesPoint[];
  raw: TimeseriesPoint[];           // исходные дневные данные (до агрегации)
  pl: number; pr: number; pt: number; pb: number;
  W: number; H: number;
  minV: number; maxV: number;
}

const STORE_KEY = 'an2_chart_state_v1';

const DEFAULT_STATE: ChartState = {
  type: 'area',
  granularity: 'day',
  series: { revenue: true, profit: true, expenses: true },
  cumulative: false,
  showAvg: false,
  showMA: true,
  autoGran: true,
};

const SERIES_META: Record<SeriesKey, { label: string; color: string; varColor: string }> = {
  revenue:  { label: 'Выручка',  color: 'var(--accent)', varColor: '#d4f000' },
  profit:   { label: 'Прибыль',  color: '#22c55e',       varColor: '#22c55e' },
  expenses: { label: 'Расходы',  color: '#f87171',       varColor: '#f87171' },
};

// ── State persistence ───────────────────────────────────────────────────────
function loadState(): ChartState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        ...DEFAULT_STATE,
        ...s,
        series: { ...DEFAULT_STATE.series, ...(s.series ?? {}) },
      };
    }
  } catch {}
  return { ...DEFAULT_STATE, series: { ...DEFAULT_STATE.series } };
}

function saveState(s: ChartState): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
}

// ── Data transforms ─────────────────────────────────────────────────────────
function aggregate(data: TimeseriesPoint[], gran: Granularity): TimeseriesPoint[] {
  if (gran === 'day' || data.length === 0) return data;
  const buckets = new Map<string, TimeseriesPoint>();
  for (const p of data) {
    const d = new Date(p.date + 'T12:00:00');
    if (isNaN(d.getTime())) continue;
    let key: string;
    if (gran === 'week') {
      const day = d.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(d);
      monday.setDate(d.getDate() + mondayOffset);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    }
    const cur = buckets.get(key) ?? { date: key, revenue: 0, expenses: 0, profit: 0 };
    cur.revenue  += p.revenue;
    cur.expenses += p.expenses;
    cur.profit   += p.profit;
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function applyCumulative(data: TimeseriesPoint[]): TimeseriesPoint[] {
  let r = 0, e = 0, p = 0;
  return data.map(d => {
    r += d.revenue; e += d.expenses; p += d.profit;
    return { date: d.date, revenue: r, expenses: e, profit: p };
  });
}

/** 7-точечная центрированная скользящая средняя — сглаживает шум.
 *  Для точности дашборда: пользователь видит реальный тренд без выбросов. */
function applyMA(data: TimeseriesPoint[], window = 7): TimeseriesPoint[] {
  if (data.length < window) return data;
  const half = Math.floor(window / 2);
  return data.map((_, i) => {
    let r = 0, e = 0, p = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(data.length - 1, i + half); j++) {
      r += data[j].revenue; e += data[j].expenses; p += data[j].profit; n++;
    }
    return { date: data[i].date, revenue: r / n, expenses: e / n, profit: p / n };
  });
}

/** Авто-выбор оптимальной агрегации для точности и производительности:
 *   ≤ 60 точек → day (детально, не лагает)
 *   61-180     → week (~26 точек максимум, чисто, тренды видны)
 *   > 180      → month (плотные периоды)
 */
function autoGranularity(rawLen: number, current: Granularity): Granularity {
  if (rawLen <= 60)  return 'day';
  if (rawLen <= 180) return 'week';
  if (current === 'day') return 'week'; // не позволяем day на больших периодах
  return current;
}

// ── Render cache: ключ = (rawData reference, JSON.stringify(state))
// SVG-строка большая (~30-50 КБ), пересоздавать на каждый paint дорого. ──
const _renderCache = new WeakMap<TimeseriesPoint[], Map<string, string>>();
function memoRenderInner(rawData: TimeseriesPoint[], st: ChartState, factory: () => string): string {
  const key = JSON.stringify(st);
  let bucket = _renderCache.get(rawData);
  if (!bucket) { bucket = new Map(); _renderCache.set(rawData, bucket); }
  let html = bucket.get(key);
  if (html !== undefined) return html;
  html = factory();
  // Не раздуваем кеш — 6 разных state-конфигов на один data достаточно
  if (bucket.size > 6) bucket.delete(bucket.keys().next().value as string);
  bucket.set(key, html);
  return html;
}

// ── Formatters ──────────────────────────────────────────────────────────────
function fmtMoney(v: number): string {
  const abs = Math.abs(v), s = v < 0 ? '−' : '';
  if (abs >= 1_000_000) return s + (abs / 1_000_000).toFixed(2) + ' млн ₽';
  if (abs >= 1_000)     return s + Math.round(abs / 1_000).toLocaleString('ru-RU') + ' тыс ₽';
  return s + Math.round(abs).toLocaleString('ru-RU') + ' ₽';
}

function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'М';
  if (a >= 1_000)     return Math.round(v / 1_000) + 'К';
  return Math.round(v).toString();
}

function fmtDate(iso: string, gran: Granularity): string {
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  if (gran === 'month') return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  if (gran === 'week') {
    const end = new Date(d); end.setDate(d.getDate() + 6);
    return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
  }
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtAxisDate(iso: string, gran: Granularity): string {
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  if (gran === 'month') return d.toLocaleDateString('ru-RU', { month: 'short' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

// ── Global event handlers (registered once) ─────────────────────────────────
let _handlersReady = false;

function ensureHandlers() {
  if (_handlersReady) return;
  _handlersReady = true;

  (window as any)._an2CB = (action: string, value?: any) => {
    const cfg: ChartCfg | undefined = (window as any)._an2CC;
    if (!cfg) return;
    const st: ChartState = {
      type: cfg.type, granularity: cfg.granularity,
      series: { ...cfg.series },
      cumulative: cfg.cumulative, showAvg: cfg.showAvg,
      showMA: cfg.showMA, autoGran: cfg.autoGran,
    };

    switch (action) {
      case 'type':       st.type = value as ChartType; break;
      case 'gran':       st.granularity = value as Granularity; st.autoGran = false; break;
      case 'series':     st.series[value as SeriesKey] = !st.series[value as SeriesKey]; break;
      case 'cumulative': st.cumulative = !st.cumulative; break;
      case 'avg':        st.showAvg = !st.showAvg; break;
      case 'ma':         st.showMA = !st.showMA; break;
      case 'autoGran':   st.autoGran = !st.autoGran; break;
    }

    // Не даём отключить все серии
    if (!st.series.revenue && !st.series.profit && !st.series.expenses) {
      st.series[value as SeriesKey] = true;
    }

    saveState(st);
    // Инвалидируем кеш renderChart — при следующем body-repaint вернётся свежий HTML
    _lastStateKey = '';
    const host = document.getElementById('_an2chart_host');
    if (host) host.innerHTML = renderChartInner(cfg.raw, st);
  };

  // rAF-throttle для mousemove: 100+ событий/сек сжимаем до 60fps (один rAF-тик)
  let _hoverRaf = 0;
  let _hoverLastEvt: { svg: SVGSVGElement; cx: number } | null = null;
  let _hoverLastIdx = -1;

  const flushHover = () => {
    _hoverRaf = 0;
    if (!_hoverLastEvt) return;
    const { svg, cx } = _hoverLastEvt;
    const cfg: ChartCfg | undefined = (window as any)._an2CC;
    if (!cfg || cfg.data.length === 0) return;
    const { data, pl, pr, pt, pb, W, H, minV, maxV } = cfg;
    const iw = W - pl - pr;
    const ih = H - pt - pb;
    const range = maxV - minV || 1;

    const rect = svg.getBoundingClientRect();
    const svgX = (cx - rect.left) * (W / rect.width);
    const frac = Math.max(0, Math.min(1, (svgX - pl) / iw));
    const idx  = Math.min(data.length - 1, Math.round(frac * (data.length - 1)));
    // Дополнительная оптимизация: если индекс не изменился — не пересчитываем tooltip
    if (idx === _hoverLastIdx) return;
    _hoverLastIdx = idx;
    const d = data[idx];

    const yFor = (v: number) => pt + (1 - (v - minV) / range) * ih;
    const xPos = data.length > 1 ? pl + (idx / (data.length - 1)) * iw : pl + iw / 2;

    const cross = svg.querySelector<SVGLineElement>('#_an2cc');
    if (cross) {
      cross.setAttribute('x1', xPos.toFixed(1));
      cross.setAttribute('x2', xPos.toFixed(1));
      (cross as any).style.opacity = '1';
    }

    const dotCfg: Array<[string, number, SeriesKey]> = [
      ['_an2dr', d.revenue, 'revenue'],
      ['_an2dp', d.profit, 'profit'],
      ['_an2de', d.expenses, 'expenses'],
    ];
    for (const [id, val, key] of dotCfg) {
      const dot = svg.querySelector<SVGCircleElement>(`#${id}`);
      if (!dot) continue;
      if (cfg.series[key]) {
        dot.setAttribute('cx', xPos.toFixed(1));
        dot.setAttribute('cy', yFor(val).toFixed(1));
        (dot as any).style.opacity = '1';
      } else {
        (dot as any).style.opacity = '0';
      }
    }

    const tip = document.getElementById('_an2ct');
    if (!tip) return;

    const sumRows: Array<[SeriesKey, number, number]> = [];
    for (const k of ['revenue', 'profit', 'expenses'] as SeriesKey[]) {
      if (!cfg.series[k]) continue;
      const arr = data.map(p => p[k]);
      const avg = arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);
      sumRows.push([k, d[k], avg]);
    }

    tip.innerHTML = `
      <div class="an2-ct-date">${fmtDate(d.date, cfg.granularity)}</div>
      ${sumRows.map(([k, val, avg]) => {
        const delta = avg !== 0 ? ((val - avg) / Math.abs(avg)) * 100 : 0;
        const deltaSign = delta > 0 ? '+' : '';
        const deltaCol  = (k === 'expenses' ? delta < 0 : delta > 0) ? '#22c55e' : delta === 0 ? 'var(--text3)' : '#f87171';
        return `
          <div class="an2-ct-row ${k === 'profit' && val < 0 ? 'neg' : ''}">
            <span class="an2-ct-dot" style="background:${SERIES_META[k].varColor}"></span>
            <span>${SERIES_META[k].label}</span>
            <strong>${fmtMoney(val)}</strong>
            <span style="color:${deltaCol};font-size:10px;margin-left:6px;font-weight:600">${deltaSign}${delta.toFixed(0)}%</span>
          </div>`;
      }).join('')}
      ${cfg.cumulative ? `<div style="font-size:9px;color:var(--text3);margin-top:4px;padding-top:4px;border-top:1px solid var(--border)">накопительный итог</div>` : ''}
    `;
    tip.style.opacity = '1';
    tip.style.pointerEvents = 'none';

    const wrap = tip.parentElement;
    if (wrap) {
      const wW = wrap.offsetWidth;
      const tipW = tip.offsetWidth || 210;
      const rawLeft = (xPos / W) * wW + 14;
      tip.style.left = Math.min(Math.max(rawLeft, 4), wW - tipW - 4) + 'px';
    }
  };

  // Лёгкий обработчик — только сохраняем координаты, реальная работа в rAF
  (window as any)._an2CM = (svgEl: SVGSVGElement, evt: MouseEvent) => {
    _hoverLastEvt = { svg: svgEl, cx: evt.clientX };
    if (!_hoverRaf) _hoverRaf = requestAnimationFrame(flushHover);
  };

  (window as any)._an2CL = (svgEl: SVGSVGElement) => {
    _hoverLastIdx = -1;
    _hoverLastEvt = null;
    if (_hoverRaf) { cancelAnimationFrame(_hoverRaf); _hoverRaf = 0; }
    ['#_an2cc', '#_an2dr', '#_an2dp', '#_an2de'].forEach(sel => {
      const el = svgEl?.querySelector(sel);
      if (el) (el as any).style.opacity = '0';
    });
    const tip = document.getElementById('_an2ct');
    if (tip) tip.style.opacity = '0';
  };
}

// ── Chart inner (controls + SVG) ───────────────────────────────────────────
function renderChartInner(rawData: TimeseriesPoint[], st: ChartState): string {
  // Полный рендер через мемокеш — повторные клики/state changes возвращают готовый HTML.
  return memoRenderInner(rawData, st, () => renderChartInnerUncached(rawData, st));
}

function renderChartInnerUncached(rawData: TimeseriesPoint[], st: ChartState): string {
  if (rawData.length < 2) {
    return `
      ${renderControls(st, rawData.length)}
      <div style="padding:48px;text-align:center;color:var(--text3);font-size:11px">
        Недостаточно данных для графика (минимум 2 точки)
      </div>`;
  }

  // Авто-агрегация: на длинных периодах принудительно week/month — точнее визуально и быстрее
  const effectiveGran: Granularity = st.autoGran
    ? autoGranularity(rawData.length, st.granularity)
    : st.granularity;

  let data = aggregate(rawData, effectiveGran);
  if (st.cumulative)  data = applyCumulative(data);
  if (st.showMA && data.length >= 7) data = applyMA(data, 7);

  const W = 1200, H = 360;
  const pl = 56, pr = 22, pt = 18, pb = 36;
  const iw = W - pl - pr;
  const ih = H - pt - pb;

  let minV = 0, maxV = 0;
  for (const d of data) {
    if (st.series.revenue) { minV = Math.min(minV, d.revenue); maxV = Math.max(maxV, d.revenue); }
    if (st.series.profit)  { minV = Math.min(minV, d.profit);  maxV = Math.max(maxV, d.profit); }
    if (st.series.expenses){ minV = Math.min(minV, d.expenses);maxV = Math.max(maxV, d.expenses); }
  }
  const rng = maxV - minV || 1;
  maxV += rng * 0.08; minV -= rng * 0.04;
  const rangeEx = maxV - minV;

  // cfg.granularity = эффективная (с учётом авто) — нужна для tooltip-форматирования
  const cfg: ChartCfg = { ...st, granularity: effectiveGran, raw: rawData, data, pl, pr, pt, pb, W, H, minV, maxV };
  (window as any)._an2CC = cfg;

  const xFor = (i: number) => data.length > 1 ? pl + (i / (data.length - 1)) * iw : pl + iw / 2;
  const yFor = (v: number) => pt + (1 - (v - minV) / rangeEx) * ih;
  const y0   = Math.min(H - pb, Math.max(pt, yFor(0)));

  const ticks: number[] = [0, 1, 2, 3, 4].map(i => minV + (rangeEx / 4) * i);
  const labelStep = Math.max(1, Math.ceil(data.length / 8));

  const seriesSvg: string[] = [];

  if (st.type === 'bar') {
    const visible: SeriesKey[] = (['revenue', 'profit', 'expenses'] as SeriesKey[]).filter(k => st.series[k]);
    const groupWidth = Math.min(iw / Math.max(1, data.length) * 0.78, 36);
    const barW = visible.length > 0 ? groupWidth / visible.length : groupWidth;

    // Чтобы анимация не растягивалась на 5+ секунд при 365 точках:
    // суммарное время ≤ 600мс. Шаг = max(2, 600/n) или 0 если точек слишком много.
    const totalStagger = 600;
    const perBar = data.length > 1 ? Math.min(12, totalStagger / data.length) : 12;
    for (let si = 0; si < visible.length; si++) {
      const key = visible[si];
      const color = SERIES_META[key].varColor;
      seriesSvg.push(`<g class="an2-bars">`);
      data.forEach((d, i) => {
        const v = d[key];
        const x = xFor(i) - groupWidth / 2 + si * barW;
        const yTop = yFor(Math.max(0, v));
        const yBot = yFor(Math.min(0, v));
        const h = Math.max(1, Math.abs(yBot - yTop));
        const delay = (i * perBar + si * 40) | 0;
        seriesSvg.push(
          `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
             rx="${Math.min(2, barW / 3).toFixed(1)}" fill="${color}" opacity="${v < 0 && key !== 'expenses' ? '.55' : '.88'}"
             class="an2-bar" style="animation-delay:${delay}ms"/>`
        );
      });
      seriesSvg.push(`</g>`);
    }
  } else {
    const linePath = (k: SeriesKey) =>
      data.map((d, i) => `${i ? 'L' : 'M'}${xFor(i).toFixed(1)},${yFor(d[k]).toFixed(1)}`).join('');

    const areaPath = (k: SeriesKey) =>
      `M${xFor(0).toFixed(1)},${y0.toFixed(1)}`
      + data.map((d, i) => `L${xFor(i).toFixed(1)},${yFor(d[k]).toFixed(1)}`).join('')
      + `L${xFor(data.length - 1).toFixed(1)},${y0.toFixed(1)}Z`;

    const seriesOrder: Array<[SeriesKey, string, number, number]> = [
      ['expenses', '#f87171', 1.5, 0.12],
      ['profit',   '#22c55e', 1.8, 0.08],
      ['revenue',  'var(--accent)', 2.2, 0.04],
    ];

    if (st.type === 'area') {
      for (const [k, col] of seriesOrder) {
        if (!st.series[k]) continue;
        const id = `an2grad_${k}`;
        seriesSvg.push(`
          <defs>
            <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stop-color="${col}" stop-opacity=".35"/>
              <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path d="${areaPath(k)}" fill="url(#${id})" clip-path="url(#an2cp)" class="an2-ca"/>
        `);
      }
    }

    for (const [k, col, sw, delay] of seriesOrder) {
      if (!st.series[k]) continue;
      seriesSvg.push(
        `<path d="${linePath(k)}" fill="none" stroke="${col}" stroke-width="${sw}"
          stroke-linejoin="round" stroke-linecap="round"
          pathLength="1" class="an2-cl" style="animation-delay:${delay}s"/>`
      );
    }
  }

  const avgLines: string[] = [];
  if (st.showAvg) {
    for (const key of ['revenue', 'profit', 'expenses'] as SeriesKey[]) {
      if (!st.series[key]) continue;
      const avg = data.reduce((s, p) => s + p[key], 0) / data.length;
      const y = yFor(avg);
      const col = SERIES_META[key].varColor;
      avgLines.push(`
        <line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}"
          stroke="${col}" stroke-opacity=".5" stroke-width="1" stroke-dasharray="4 4"
          class="an2-avg-line"/>
        <text x="${(W - pr - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="end" font-size="10.5"
          fill="${col}" fill-opacity=".8">avg ${SERIES_META[key].label.toLowerCase()}: ${fmtAxis(avg)}</text>
      `);
    }
  }

  const lastIdx = data.length - 1;
  const lastDot = (st.type !== 'bar' && st.series.revenue) ? `
    <circle cx="${xFor(lastIdx).toFixed(1)}" cy="${yFor(data[lastIdx].revenue).toFixed(1)}"
      r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" class="an2-pulse-dot"/>
  ` : '';

  return `
    ${renderControls(st, rawData.length)}
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMid meet"
        style="cursor:crosshair;overflow:visible;display:block;width:100%;height:auto;min-height:320px"
        onmousemove="window._an2CM&&window._an2CM(this,event)"
        onmouseleave="window._an2CL&&window._an2CL(this)">
        <defs>
          <clipPath id="an2cp"><rect x="${pl}" y="${pt}" width="${iw}" height="${ih + 2}"/></clipPath>
        </defs>

        ${ticks.map(t => `
          <line x1="${pl}" y1="${yFor(t).toFixed(1)}" x2="${W - pr}" y2="${yFor(t).toFixed(1)}"
            stroke="currentColor" stroke-opacity=".06" stroke-width="1"/>
          <text x="${pl - 10}" y="${(yFor(t) + 4).toFixed(1)}" text-anchor="end"
            font-size="11" fill="currentColor" fill-opacity=".5">${fmtAxis(t)}</text>
        `).join('')}

        ${minV < 0 && maxV > 0 ? `
          <line x1="${pl}" y1="${y0.toFixed(1)}" x2="${W - pr}" y2="${y0.toFixed(1)}"
            stroke="currentColor" stroke-opacity=".22" stroke-dasharray="3 3" stroke-width="1"/>
        ` : ''}

        ${seriesSvg.join('')}
        ${avgLines.join('')}
        ${lastDot}

        ${data.map((d, i) => {
          if (i % labelStep !== 0 && i !== data.length - 1) return '';
          return `<text x="${xFor(i).toFixed(1)}" y="${(H - pb + 22).toFixed(1)}"
            text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".55">${fmtAxisDate(d.date, effectiveGran)}</text>`;
        }).join('')}

        <line id="_an2cc" x1="${pl}" y1="${pt}" x2="${pl}" y2="${H - pb}"
          stroke="currentColor" stroke-opacity=".25" stroke-dasharray="3 2" stroke-width="1"
          style="opacity:0;transition:opacity .15s" pointer-events="none"/>

        <circle id="_an2dr" r="4.5" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" style="opacity:0;transition:opacity .15s" pointer-events="none"/>
        <circle id="_an2dp" r="4.5" fill="#22c55e"       stroke="var(--bg)" stroke-width="2" style="opacity:0;transition:opacity .15s" pointer-events="none"/>
        <circle id="_an2de" r="4.5" fill="#f87171"       stroke="var(--bg)" stroke-width="2" style="opacity:0;transition:opacity .15s" pointer-events="none"/>
      </svg>

      <div id="_an2ct" class="an2-chart-tip" style="opacity:0;transition:opacity .12s,left .08s"></div>
    </div>
  `;
}

// ── Control panel ───────────────────────────────────────────────────────────
function renderControls(st: ChartState, total: number): string {
  const typeBtn = (id: ChartType, icon: string, label: string) => `
    <button class="an2-ctrl-btn ${st.type === id ? 'on' : ''}" title="${label}"
      onclick="window._an2CB('type','${id}')">
      ${icon}
    </button>`;

  const granBtn = (id: Granularity, label: string) => `
    <button class="an2-ctrl-pill ${st.granularity === id ? 'on' : ''}"
      onclick="window._an2CB('gran','${id}')">${label}</button>`;

  const seriesChip = (k: SeriesKey) => {
    const on = st.series[k];
    const c = SERIES_META[k].varColor;
    return `
      <button class="an2-series-chip ${on ? 'on' : ''}" onclick="window._an2CB('series','${k}')"
        ${on ? `style="color:${c};border-color:${c}55;background:color-mix(in srgb,${c} 10%,transparent)"` : ''}>
        <span class="an2-series-dot" style="background:${on ? c : 'var(--text4,#333)'}"></span>
        ${SERIES_META[k].label}
      </button>`;
  };

  return `
    <div class="an2-chart-ctrl">
      <div class="an2-ctrl-group" title="Тип графика">
        ${typeBtn('area', '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 13L1 9L5 5L9 8L15 2V13H1Z" opacity=".4"/><path d="M1 9L5 5L9 8L15 2" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>', 'Область')}
        ${typeBtn('line', '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 11L5 5L9 8L15 3"/></svg>', 'Линия')}
        ${typeBtn('bar',  '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="6" width="2.5" height="8" rx="1"/><rect x="6.75" y="3" width="2.5" height="11" rx="1"/><rect x="11.5" y="8" width="2.5" height="6" rx="1"/></svg>', 'Колонки')}
      </div>

      <div class="an2-ctrl-group an2-series-group">
        ${(['revenue','profit','expenses'] as SeriesKey[]).map(seriesChip).join('')}
      </div>

      <div class="an2-ctrl-group" title="Группировка">
        ${granBtn('day',   'День')}
        ${granBtn('week',  'Нед')}
        ${granBtn('month', 'Мес')}
        <button class="an2-ctrl-pill ${st.autoGran ? 'on' : ''}" onclick="window._an2CB('autoGran')"
          title="Авто: оптимальная группировка для производительности и читаемости (>60 точек → неделя)">
          ⚡ Авто
        </button>
      </div>

      <div class="an2-ctrl-group">
        <button class="an2-ctrl-pill ${st.cumulative ? 'on' : ''}" onclick="window._an2CB('cumulative')" title="Накопительный итог">
          Σ Сумма
        </button>
        <button class="an2-ctrl-pill ${st.showAvg ? 'on' : ''}" onclick="window._an2CB('avg')" title="Горизонтальная линия среднего значения">
          ⎯ Среднее
        </button>
        <button class="an2-ctrl-pill ${st.showMA ? 'on' : ''}" onclick="window._an2CB('ma')"
          title="7-точечная скользящая средняя — сглаживает выбросы, точнее видно тренд">
          ∿ Сглаж.
        </button>
      </div>

      <div style="margin-left:auto;font-size:10px;color:var(--text3);white-space:nowrap">${total} точек</div>
    </div>
  `;
}

// ── Public API ──────────────────────────────────────────────────────────────
// Кеш для одинаковых (data ref + state hash) — body-only repaints не должны
// пересоздавать SVG из ~30k символов.
let _lastDataRef: TimeseriesPoint[] | null = null;
let _lastStateKey = '';
let _lastHtml = '';

function stateKey(s: ChartState): string {
  return `${s.type}|${s.granularity}|${s.cumulative ? 1 : 0}|${s.showAvg ? 1 : 0}|${s.series.revenue ? 1 : 0}${s.series.profit ? 1 : 0}${s.series.expenses ? 1 : 0}`;
}

export function renderChart(data: TimeseriesPoint[]): string {
  ensureHandlers();
  const st = loadState();
  const key = stateKey(st);
  if (data === _lastDataRef && key === _lastStateKey && _lastHtml) {
    return _lastHtml;
  }
  _lastDataRef = data;
  _lastStateKey = key;
  _lastHtml = `<div id="_an2chart_host">${renderChartInner(data, st)}</div>`;
  return _lastHtml;
}
