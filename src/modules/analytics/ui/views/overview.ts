/**
 * «Обзор» — главная страница аналитики: сколько заработали, откуда и куда
 * ушли деньги, как идут продажи по дням, что с заказами и товарами.
 */

import { KPI, Order, TimeseriesPoint, SkuPerformance, Mp, MP_LABEL, MP_SHORT } from '../../types';
import { rub, rubShort, pct, num, dayShort, dayLong, escapeHtml, jsArg, plural } from '../format';
import { hbars, stackBar, TimeSpec, TimePoint } from '../charts';
import { mskDayKey } from '@/utils/mpDate';

export type ChartMetric = 'revenue' | 'profit' | 'orders';

export interface OverviewInput {
  kpi: KPI;
  prevKpi: KPI | null;
  ts: TimeseriesPoint[];
  prevTs: TimeseriesPoint[] | null;
  orders: Order[];
  prevOrders: Order[] | null;
  skus: SkuPerformance[];
  metric: ChartMetric;
  /** Сводный режим «Все площадки». */
  allMp: boolean;
  byMp: Array<{ mp: Mp; kpi: KPI }>;
}

/** Цвета рядов — палитра проверена валидатором на фонах приложения. */
export const SERIES = {
  revenue: 'var(--an-s1)',
  profit: 'var(--an-s3)',
  orders: 'var(--an-s7)',
} as const;

const M = 'window.analyticsModule';

// ── Плитки показателей ──────────────────────────────────────────────────

interface Tile {
  label: string;
  value: string;
  cur: number;
  prev: number | null | undefined;
  /** Рост — хорошо? (для расходов — нет) */
  upIsGood?: boolean;
  hint: string;
  help: string;
}

function delta(t: Tile): string {
  if (t.prev == null || !Number.isFinite(t.prev) || Math.abs(t.prev) < 0.0001) return '';
  const d = (t.cur - t.prev) / Math.abs(t.prev) * 100;
  if (!Number.isFinite(d) || Math.abs(d) < 0.05) return '<span class="an-delta flat">без изменений</span>';
  const good = (d > 0) === (t.upIsGood !== false);
  return `<span class="an-delta ${good ? 'good' : 'bad'}" title="К прошлому периоду такой же длины">${d > 0 ? '▲' : '▼'} ${pct(Math.abs(d))}</span>`;
}

function tile(t: Tile): string {
  return `
    <div class="an-tile" title="${escapeHtml(t.help)}">
      <div class="an-tile-label">${escapeHtml(t.label)}</div>
      <div class="an-tile-value">${t.value}</div>
      <div class="an-tile-foot">${delta(t)}<span class="an-tile-hint">${t.hint}</span></div>
    </div>`;
}

export function kpiTiles(k: KPI, p: KPI | null): string {
  const orders = k.orders_total;
  const tiles: Tile[] = [
    { label: 'Выручка', value: rub(k.revenue), cur: k.revenue, prev: p?.revenue,
      hint: `заказано на ${rubShort(k.ordered_revenue)} ₽`,
      help: 'Выкупленные заказы, по которым маркетплейс прислал финотчёт. Заказы в пути сюда не входят.' },
    { label: 'Чистая прибыль', value: rub(k.net_profit), cur: k.net_profit, prev: p?.net_profit,
      hint: k.cogs > 0 ? `после себестоимости и налогов` : 'себестоимость не задана',
      help: 'Выручка минус все расходы: комиссия, логистика, реклама, хранение, штрафы, себестоимость, налоги и ваши расходы.' },
    { label: 'Маржа', value: pct(k.margin_pct), cur: k.margin_pct, prev: p?.margin_pct,
      hint: k.orders_settled ? `${rub(k.net_profit / k.orders_settled)} с заказа` : '—',
      help: 'Чистая прибыль ÷ выручка.' },
    { label: 'Заказы', value: num(orders), cur: orders, prev: p?.orders_total,
      hint: `${num(k.orders_processing)} в пути · ${num(k.orders_delivered)} доставлено`,
      help: 'Все заказы периода по дате заказа.' },
    { label: 'Выкуп', value: pct(k.buyout_pct, 0), cur: k.buyout_pct, prev: p?.buyout_pct,
      hint: `${num(k.orders_returned)} ${plural(k.orders_returned, ['возврат', 'возврата', 'возвратов'])} · ${num(k.orders_cancelled)} ${plural(k.orders_cancelled, ['отмена', 'отмены', 'отмен'])}`,
      help: 'Доставлено ÷ (доставлено + возвраты + отмены) среди закрытых заказов.' },
    { label: 'Расходы', value: rub(k.total_expenses), cur: k.total_expenses, prev: p?.total_expenses, upIsGood: false,
      hint: k.revenue > 0 ? `${pct(k.total_expenses / k.revenue * 100, 0)} от выручки` : '—',
      help: 'Все расходы периода, включая себестоимость и налоги.' },
  ];
  return `<div class="an-tiles">${tiles.map(tile).join('')}</div>`;
}

// ── Ряд для графика ─────────────────────────────────────────────────────

/** Заказы по дням (по дате заказа, московские сутки). */
function ordersByDay(orders: Order[], days: string[]): number[] {
  const m = new Map<string, number>();
  for (const o of orders) {
    if (o.is_orphan) continue;
    const d = mskDayKey(o.date);
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return days.map(d => m.get(d) ?? 0);
}

/** Длинные периоды — по неделям или месяцам, чтобы столбцы читались. */
function bucketOf(len: number): 'day' | 'week' | 'month' {
  if (len > 400) return 'month';
  if (len > 92) return 'week';
  return 'day';
}

export function chartSpec(inp: OverviewInput): TimeSpec {
  const days = inp.ts.map(p => p.date);
  const cur = inp.metric === 'orders' ? ordersByDay(inp.orders, days)
    : inp.ts.map(p => inp.metric === 'revenue' ? p.revenue : p.profit);
  let prev: number[] | null = null;
  if (inp.prevTs && inp.prevTs.length) {
    const pdays = inp.prevTs.map(p => p.date);
    prev = inp.metric === 'orders' ? (inp.prevOrders ? ordersByDay(inp.prevOrders, pdays) : null)
      : inp.prevTs.map(p => inp.metric === 'revenue' ? p.revenue : p.profit);
  }

  const bucket = bucketOf(days.length);
  const points: TimePoint[] = [];
  if (bucket === 'day') {
    days.forEach((d, i) => points.push({ x: dayShort(d), label: dayLong(d), y: cur[i], prev: prev?.[i] ?? null }));
  } else {
    const keyOf = (d: string, i: number) => bucket === 'month' ? d.slice(0, 7) : String(Math.floor(i / 7));
    const groups = new Map<string, { first: string; last: string; y: number; prev: number; hasPrev: boolean }>();
    days.forEach((d, i) => {
      const k = keyOf(d, i);
      const g = groups.get(k) ?? { first: d, last: d, y: 0, prev: 0, hasPrev: false };
      g.last = d; g.y += cur[i];
      if (prev && prev[i] != null) { g.prev += prev[i]; g.hasPrev = true; }
      groups.set(k, g);
    });
    for (const g of groups.values()) {
      const x = bucket === 'month'
        ? new Date(`${g.first}T12:00:00Z`).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' })
        : dayShort(g.first);
      points.push({ x, label: bucket === 'month' ? x : `${dayShort(g.first)} — ${dayShort(g.last)}`, y: g.y, prev: g.hasPrev ? g.prev : null });
    }
  }

  const name = inp.metric === 'revenue' ? 'Выручка' : inp.metric === 'profit' ? 'Прибыль' : 'Заказы';
  const isMoney = inp.metric !== 'orders';
  return {
    kind: 'time',
    points,
    fmt: isMoney ? rub : (n: number) => `${num(n)} шт`,
    axisFmt: isMoney ? rubShort : num,
    name,
    prevName: 'Прошлый период',
    color: SERIES[inp.metric],
  };
}

// ── Страница ─────────────────────────────────────────────────────────────

export function renderOverview(inp: OverviewInput): string {
  const k = inp.kpi;
  const metricBtn = (m: ChartMetric, label: string) =>
    `<button class="an-seg ${inp.metric === m ? 'on' : ''}" onclick="${M}?.setMetric('${m}')">${label}</button>`;
  const bucket = bucketOf(inp.ts.length);

  return `
    ${kpiTiles(k, inp.prevKpi)}

    <section class="an-card">
      <header class="an-card-head">
        <div>
          <h3>Динамика</h3>
          <p class="an-muted">${bucket === 'day' ? 'по дням' : bucket === 'week' ? 'по неделям' : 'по месяцам'} · выручка и прибыль — по выкупленным заказам, заказы — по дате заказа</p>
        </div>
        <div class="an-segs">${metricBtn('revenue', 'Выручка')}${metricBtn('profit', 'Прибыль')}${metricBtn('orders', 'Заказы')}</div>
      </header>
      <div class="an-legend an-legend-inline">
        <div class="an-legend-item"><span class="an-legend-key" style="background:${SERIES[inp.metric]}"></span><span class="an-legend-name">Текущий период</span></div>
        ${inp.prevTs ? `<div class="an-legend-item"><span class="an-legend-key line"></span><span class="an-legend-name">Прошлый период</span></div>` : ''}
      </div>
      <div class="an-chart" data-chart="main"></div>
    </section>

    <div class="an-grid2">
      <section class="an-card">
        <header class="an-card-head"><div><h3>Куда уходят деньги</h3><p class="an-muted">из каждого рубля выручки</p></div></header>
        ${moneyFlow(k)}
      </section>
      <section class="an-card">
        <header class="an-card-head"><div><h3>Заказы</h3><p class="an-muted">${num(k.orders_total)} ${plural(k.orders_total, ['заказ', 'заказа', 'заказов'])} за период</p></div></header>
        ${stackBar([
          { label: 'Доставлены', value: k.orders_delivered, color: 'var(--an-s1)', valueText: num(k.orders_delivered) },
          { label: 'В пути', value: k.orders_processing, color: 'var(--an-s3)', valueText: num(k.orders_processing) },
          { label: 'Возвраты', value: k.orders_returned, color: 'var(--an-s2)', valueText: num(k.orders_returned) },
          { label: 'Отмены', value: k.orders_cancelled, color: 'var(--an-s4)', valueText: num(k.orders_cancelled) },
        ])}
        <div class="an-facts">
          <div><span>Заказано на</span><strong>${rub(k.ordered_revenue)}</strong></div>
          <div><span>Ещё в пути</span><strong>${rub(k.in_transit_revenue)}</strong></div>
          <div><span>Ждут расчёта</span><strong>${rub(k.awaiting_revenue)}</strong></div>
          <div><span>Средний чек</span><strong>${rub(k.avg_check)}</strong></div>
          <div><span>Упущено на возвратах</span><strong>${rub(k.returns_revenue)}</strong></div>
          <div><span>Упущено на отменах</span><strong>${rub(k.cancelled_revenue)}</strong></div>
        </div>
      </section>
    </div>

    ${inp.allMp && inp.byMp.length > 1 ? byMarketplace(inp.byMp) : ''}

    <div class="an-grid2">
      <section class="an-card">
        <header class="an-card-head"><div><h3>Самые прибыльные товары</h3></div>
          <button class="an-link" onclick="${M}?.setTab('products')">Все товары →</button></header>
        ${topProducts(inp.skus.filter(s => s.net_profit > 0).sort((a, b) => b.net_profit - a.net_profit).slice(0, 6), 'var(--an-s3)')}
      </section>
      <section class="an-card">
        <header class="an-card-head"><div><h3>Убыточные товары</h3><p class="an-muted">приносят минус после всех расходов</p></div></header>
        ${(() => {
          const loss = inp.skus.filter(s => s.net_profit < 0).sort((a, b) => a.net_profit - b.net_profit).slice(0, 6);
          return loss.length ? topProducts(loss, 'var(--an-s8)') : '<div class="an-chart-empty good">Убыточных товаров нет 👍</div>';
        })()}
      </section>
    </div>
  `;
}

function moneyFlow(k: KPI): string {
  if (k.revenue <= 0) return '<div class="an-chart-empty">Нет выкупленной выручки с финотчётом за период</div>';
  const share = (v: number) => `${pct(v / k.revenue * 100)} выручки`;
  const rows = [
    { label: 'Себестоимость', value: k.cogs },
    { label: 'Комиссия маркетплейса', value: k.commission },
    { label: 'Логистика', value: k.logistics },
    { label: 'Реклама, хранение, штрафы', value: k.period_costs },
    { label: 'Услуги по заказам', value: k.services },
    { label: 'Налоги', value: k.tax },
    { label: 'Ваши расходы', value: k.manual_costs },
  ].filter(r => Math.abs(r.value) > 0.5).sort((a, b) => b.value - a.value);
  return hbars([
    ...rows.map(r => ({ label: r.label, value: r.value, valueText: rub(r.value), sub: share(r.value), color: 'var(--an-s2)',
      tip: `${r.label}: ${rub(r.value)} · ${share(r.value)}` })),
    { label: 'Чистая прибыль', value: k.net_profit, valueText: rub(k.net_profit), sub: share(k.net_profit),
      color: k.net_profit >= 0 ? 'var(--an-s3)' : 'var(--an-s8)', tip: `Чистая прибыль: ${rub(k.net_profit)}` },
  ]);
}

function topProducts(list: SkuPerformance[], color: string): string {
  if (!list.length) return '<div class="an-chart-empty">Нет данных</div>';
  const mps = new Set(list.map(s => s.mp));
  return hbars(list.map(s => ({
    // Один товар может продаваться на нескольких площадках — подписываем площадку.
    label: `${mps.size > 1 ? `${MP_SHORT[s.mp]} · ` : ''}${s.name || s.vendor_code}`,
    value: s.net_profit,
    valueText: rub(s.net_profit),
    sub: `${num(s.units_sold)} шт · маржа ${pct(s.margin_pct, 0)}`,
    color,
    tip: `${s.vendor_code} · ${s.name}: прибыль ${rub(s.net_profit)}, продано ${num(s.units_sold)} шт`,
  })));
}

function byMarketplace(list: Array<{ mp: Mp; kpi: KPI }>): string {
  const total = list.reduce((s, x) => s + x.kpi.revenue, 0);
  return `
    <section class="an-card">
      <header class="an-card-head"><div><h3>По площадкам</h3></div></header>
      <table class="an-table">
        <thead><tr><th>Площадка</th><th class="num">Выручка</th><th class="num">Доля</th><th class="num">Прибыль</th><th class="num">Маржа</th><th class="num">Заказы</th><th class="num">Выкуп</th></tr></thead>
        <tbody>${list.map(x => `
          <tr onclick="${M}?.selectMp('${jsArg(x.mp)}')" title="Открыть ${escapeHtml(MP_LABEL[x.mp])}">
            <td><span class="an-mp an-mp-${x.mp}">${MP_SHORT[x.mp]}</span> ${escapeHtml(MP_LABEL[x.mp])}</td>
            <td class="num">${rub(x.kpi.revenue)}</td>
            <td class="num">${total > 0 ? pct(x.kpi.revenue / total * 100, 0) : '—'}</td>
            <td class="num ${x.kpi.net_profit >= 0 ? 'pos' : 'neg'}">${rub(x.kpi.net_profit)}</td>
            <td class="num">${pct(x.kpi.margin_pct)}</td>
            <td class="num">${num(x.kpi.orders_total)}</td>
            <td class="num">${pct(x.kpi.buyout_pct, 0)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
}
