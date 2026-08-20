import { computeSkuPerformance } from '../../services/kpiAggregator';
import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, barList, adviceBlock, Advice,
  estimateNote, sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';

const ACCENT = '#60a5fa';

/** Ориентиры по марже для торговли на маркетплейсах. */
const BUCKETS: Array<{ label: string; min: number; max: number; color: string }> = [
  { label: 'Убыточные (< 0%)',   min: -Infinity, max: 0,        color: '#f87171' },
  { label: 'На грани (0–5%)',    min: 0,         max: 5,        color: '#fb923c' },
  { label: 'Слабые (5–15%)',     min: 5,         max: 15,       color: '#fbbf24' },
  { label: 'Рабочие (15–25%)',   min: 15,        max: 25,       color: '#a3e635' },
  { label: 'Отличные (25%+)',    min: 25,        max: Infinity, color: '#22c55e' },
];

export function renderMarginDetail(c: DetailCtx): string {
  const k = c.kpi;
  const rev = Math.max(1, k.revenue);
  const grossMargin = ((k.net_profit + k.cogs) / rev) * 100;

  // Маржа по дням: считаем только по дням с выручкой, иначе ряд рвётся нулями.
  const marginSeries = c.ts.map(p => (p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0));

  const skus = computeSkuPerformance(c.orders).filter(s => s.revenue > 0 && s.units_sold > 0);
  const buckets = BUCKETS.map(b => ({
    ...b,
    count: skus.filter(s => s.margin_pct >= b.min && s.margin_pct < b.max).length,
    revenue: skus.filter(s => s.margin_pct >= b.min && s.margin_pct < b.max).reduce((sum, s) => sum + s.revenue, 0),
  })).filter(b => b.count > 0);

  const byMargin = [...skus].sort((a, b) => b.margin_pct - a.margin_pct);
  const best  = byMargin.slice(0, 5);
  const worst = byMargin.slice(-5).reverse().filter(s => !best.includes(s));
  const losing = skus.filter(s => s.net_profit < 0);
  const losingRevenue = losing.reduce((s, x) => s + x.revenue, 0);

  const advice: Advice[] = [];

  if (k.margin_pct < 0) {
    advice.push({
      level: 'bad',
      title: 'Маржа отрицательная — каждая продажа приносит убыток',
      text: `С выручки ${fmtMoney(k.revenue)} остаётся ${fmtMoney(k.net_profit)}. Самое частое объяснение: цена не покрывает связку «комиссия + логистика + себестоимость». Открой список убыточных товаров ниже — обычно 2–3 артикула утягивают весь магазин.`,
    });
  } else if (k.margin_pct < 5) {
    advice.push({
      level: 'warn',
      title: `Маржа ${k.margin_pct.toFixed(1)}% — работа почти в ноль`,
      text: 'Любое подорожание логистики, штраф или всплеск возвратов уводит магазин в минус. Ориентир для устойчивой торговли — от 15%. Поднимай цену там, где позволяет спрос, и убирай товары с самой тонкой маржой.',
    });
  } else if (k.margin_pct < 15) {
    advice.push({
      level: 'warn',
      title: `Маржа ${k.margin_pct.toFixed(1)}% — ниже комфортного уровня`,
      text: 'Запаса на скидки и акции почти нет. Смотри на структуру расходов: если логистика выше 15% выручки — проблема в цене товара, если комиссия выше 25% — в категории или участии в акциях.',
    });
  } else if (k.margin_pct >= 25) {
    advice.push({
      level: 'good',
      title: `Маржа ${k.margin_pct.toFixed(1)}% — сильный показатель`,
      text: 'Есть запас на рекламу и акции. Логичный следующий шаг — вкладываться в объём: продвигать именно те артикулы, что дают маржу выше средней по магазину.',
    });
  } else {
    advice.push({
      level: 'good',
      title: `Маржа ${k.margin_pct.toFixed(1)}% — рабочий уровень`,
      text: 'Показатель здоровый. Держи логистику ниже 15% выручки, а долю убыточных товаров — около нуля, и уровень сохранится при росте объёмов.',
    });
  }

  if (losing.length) {
    advice.push({
      level: 'bad',
      title: `${losing.length} ${plural(losing.length, 'товар работает', 'товара работают', 'товаров работают')} в минус`,
      text: `На них приходится ${fmtMoney(losingRevenue)} выручки (${((losingRevenue / rev) * 100).toFixed(0)}% оборота), а прибыли — ${fmtMoney(losing.reduce((s, x) => s + x.net_profit, 0))}. По каждому решение простое: поднять цену, снизить закупку или вывести из ассортимента.`,
    });
  }

  if (k.cogs === 0) {
    advice.push({
      level: 'bad',
      title: 'Маржа посчитана без себестоимости',
      text: 'Закупочные цены не заполнены, поэтому показатель завышен и реальную картину не отражает. Заполни их в «Репрайсер → Себестоимости».',
    });
  }

  const logisticsPct = (k.logistics / rev) * 100;
  if (logisticsPct >= 15) {
    advice.push({
      level: 'warn',
      title: `Логистика забирает ${logisticsPct.toFixed(0)}% выручки`,
      text: 'Это одна из главных причин низкой маржи на дешёвых товарах. Поднятие средней цены заказа (комплекты, наборы) обычно даёт больший эффект, чем торг по закупке.',
    });
  }

  const body = `
    ${estimateNote(k)}

    ${statGrid([
      { label: 'Маржа чистая', value: `${k.margin_pct.toFixed(1)}%`, hint: 'после всех расходов и налога', color: k.margin_pct >= 15 ? 'var(--green)' : k.margin_pct >= 5 ? '#fbbf24' : 'var(--red)' },
      { label: 'Маржа без себестоимости', value: `${grossMargin.toFixed(1)}%`, hint: 'что остаётся после удержаний МП' },
      { label: 'Комиссия', value: `${((k.commission / rev) * 100).toFixed(1)}%`, hint: 'от выручки' },
      { label: 'Логистика', value: `${logisticsPct.toFixed(1)}%`, hint: 'от выручки', color: logisticsPct >= 15 ? 'var(--red)' : undefined },
      { label: 'Себестоимость', value: `${((k.cogs / rev) * 100).toFixed(1)}%`, hint: 'от выручки' },
      { label: 'Прибыль с заказа', value: fmtMoney(k.orders_delivered > 0 ? k.net_profit / k.orders_delivered : 0), hint: 'в среднем', color: k.net_profit >= 0 ? 'var(--green)' : 'var(--red)' },
    ])}

    ${card('Куда уходит каждый рубль выручки', barList([
      { label: 'Комиссия МП',   value: k.commission, color: '#fb923c', share: `${((k.commission / rev) * 100).toFixed(1)}%` },
      { label: 'Логистика',     value: k.logistics,  color: '#60a5fa', share: `${((k.logistics / rev) * 100).toFixed(1)}%` },
      { label: 'Услуги и штрафы', value: k.services, color: '#a78bfa', share: `${((k.services / rev) * 100).toFixed(1)}%` },
      { label: 'Себестоимость', value: k.cogs,       color: '#22d3ee', share: `${((k.cogs / rev) * 100).toFixed(1)}%` },
      { label: 'Налог',         value: k.tax,        color: '#f472b6', share: `${((k.tax / rev) * 100).toFixed(1)}%` },
      { label: 'Осталось прибыли', value: Math.max(0, k.net_profit), color: '#22c55e', share: `${k.margin_pct.toFixed(1)}%` },
    ].filter(r => r.value > 0)))}

    ${card('Маржа по дням, %', sparkline(marginSeries, ACCENT, 120), 'дни без продаж показаны нулём')}

    ${card('Сколько товаров в какой марже', buckets.length ? barList(buckets.map(b => ({
      label: b.label,
      value: b.count,
      color: b.color,
      valueText: `${fmtNum(b.count)} шт`,
      share: fmtMoney(b.revenue),
      hint: 'выручка группы',
    }))) : emptyBlock('нет товаров с продажами'), `${fmtNum(skus.length)} артикулов`)}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px">
      ${card('Самые маржинальные', best.length ? skuTable(best) : emptyBlock('нет данных'))}
      ${card('Самые слабые по марже', worst.length ? skuTable(worst) : emptyBlock('нет данных'))}
    </div>

    ${adviceBlock(advice)}
  `;

  return detailFrame({
    title: 'Маржа',
    value: `${k.margin_pct.toFixed(1)}%`,
    subtitle: `${c.periodLabel} · ${c.storeName}`,
    accent: ACCENT,
    delta: deltaOf(k.margin_pct, c.prevKpi?.margin_pct),
    body,
  });
}

function skuTable(rows: Array<{ vendor_code: string; name: string; revenue: number; net_profit: number; margin_pct: number; units_sold: number }>): string {
  return `
    <table class="an2-table">
      <thead><tr><th>Товар</th><th class="num">Выручка</th><th class="num">Прибыль</th><th class="num">Маржа</th></tr></thead>
      <tbody>
        ${rows.map(s => `
          <tr>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <span style="color:var(--text3);font-size:10px">${escapeHtml(s.vendor_code)}</span><br>
              <span style="font-weight:600">${escapeHtml(s.name)}</span>
            </td>
            <td class="num">${fmtMoney(s.revenue)}</td>
            <td class="num ${s.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.net_profit)}</td>
            <td class="num ${s.margin_pct >= 0 ? 'pos' : 'neg'}">${s.margin_pct.toFixed(1)}%</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
