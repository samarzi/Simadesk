import { computeSkuPerformance } from '../../services/kpiAggregator';
import { renderPnL } from '../../components/PnLWaterfall';
import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, adviceBlock, Advice,
  estimateNote, sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';

const ACCENT = '#22c55e';

export function renderProfitDetail(c: DetailCtx): string {
  const k = c.kpi;
  const rev = Math.max(1, k.revenue);
  const perOrder = k.orders_delivered > 0 ? k.net_profit / k.orders_delivered : 0;
  const perUnit  = k.units_sold > 0 ? k.net_profit / k.units_sold : 0;
  const roi = k.cogs > 0 ? (k.net_profit / k.cogs) * 100 : 0;

  const profitSeries = c.ts.map(p => p.profit);
  const profitableDays = c.ts.filter(p => p.profit > 0).length;
  const losingDays = c.ts.filter(p => p.profit < 0).length;

  const skus = computeSkuPerformance(c.orders).filter(s => s.units_sold > 0);
  const winners = [...skus].sort((a, b) => b.net_profit - a.net_profit).slice(0, 8);
  const losers  = [...skus].filter(s => s.net_profit < 0).sort((a, b) => a.net_profit - b.net_profit).slice(0, 8);
  const lossTotal = losers.reduce((s, x) => s + x.net_profit, 0);

  const advice: Advice[] = [];

  if (k.net_profit < 0) {
    advice.push({
      level: 'bad',
      title: 'Период закрыт с убытком',
      text: `Выручка ${fmtMoney(k.revenue)}, расходы ${fmtMoney(k.total_expenses)}. Разбирай по порядку: сначала убыточные товары ниже, затем структуру расходов — обычно перекос сидит в логистике или в себестоимости, которая выше цены после комиссии.`,
    });
  } else if (k.net_profit > 0 && k.margin_pct < 10) {
    advice.push({
      level: 'warn',
      title: `Прибыль есть, но тонкая — маржа ${k.margin_pct.toFixed(1)}%`,
      text: `${fmtMoney(k.net_profit)} с оборота ${fmtMoney(k.revenue)}. Такой запас съедается одним неудачным месяцем по возвратам. Смотри «Маржу»: там видно, какие артикулы держат средний уровень внизу.`,
    });
  } else if (k.net_profit > 0) {
    advice.push({
      level: 'good',
      title: `Прибыль ${fmtMoney(k.net_profit)} при марже ${k.margin_pct.toFixed(1)}%`,
      text: 'Здоровый результат. Чтобы его масштабировать, увеличивай продажи по товарам из списка лидеров ниже — у них лучший вклад в прибыль на единицу.',
    });
  }

  if (losers.length) {
    advice.push({
      level: 'warn',
      title: `Убыточные товары забрали ${fmtMoney(Math.abs(lossTotal))} прибыли`,
      text: `${losers.length} ${plural(losers.length, 'артикул', 'артикула', 'артикулов')} в минусе. Если убрать или починить их, прибыль периода была бы ${fmtMoney(k.net_profit + Math.abs(lossTotal))}.`,
    });
  }

  if (k.cogs === 0) {
    advice.push({
      level: 'bad',
      title: 'Себестоимость не заполнена — прибыль завышена',
      text: 'Сейчас в расчёте нет закупочных цен, поэтому «чистая прибыль» на деле равна прибыли до себестоимости. Заполни цены в «Репрайсер → Себестоимости», и цифра станет настоящей.',
    });
  } else if (k.missing_cogs_orders > 0) {
    advice.push({
      level: 'warn',
      title: `В ${fmtNum(k.missing_cogs_orders)} ${plural(k.missing_cogs_orders, 'заказе', 'заказах', 'заказах')} нет себестоимости`,
      text: 'По этим заказам прибыль показана выше реальной. Список артикулов и быстрый ввод цены — на вкладке «Сводка».',
    });
  }

  if (losingDays > profitableDays && c.ts.length > 3) {
    advice.push({
      level: 'warn',
      title: `Убыточных дней больше, чем прибыльных: ${losingDays} против ${profitableDays}`,
      text: 'Прибыль держится на отдельных всплесках. Посмотри график ниже: если минус приходит регулярно — дело в постоянных расходах (хранение, реклама), а не в разовых возвратах.',
    });
  }

  const body = `
    ${estimateNote(k)}

    ${statGrid([
      { label: 'Маржа', value: `${k.margin_pct.toFixed(1)}%`, hint: 'доля прибыли в выручке', color: k.margin_pct >= 15 ? 'var(--green)' : k.margin_pct >= 0 ? '#fbbf24' : 'var(--red)' },
      { label: 'Прибыль с заказа', value: fmtMoney(perOrder), hint: `по ${fmtNum(k.orders_delivered)} доставленным`, color: perOrder >= 0 ? 'var(--green)' : 'var(--red)' },
      { label: 'Прибыль с единицы', value: fmtMoney(perUnit), hint: `${fmtNum(k.units_sold)} шт продано` },
      { label: 'Возврат на закупку', value: k.cogs > 0 ? `${roi.toFixed(0)}%` : '—', hint: k.cogs > 0 ? `на ${fmtMoney(k.cogs)} себестоимости` : 'себестоимость не задана' },
      { label: 'Прибыльных дней', value: `${profitableDays} / ${c.ts.length}`, hint: `${losingDays} в минусе` },
      { label: 'Всего расходов', value: fmtMoney(k.total_expenses), hint: `${((k.total_expenses / rev) * 100).toFixed(0)}% выручки` },
    ])}

    ${card('Путь денег: от выручки к прибыли', renderPnL(k), 'кликни строку — откроются связанные заказы')}

    ${card('Прибыль по дням', sparkline(profitSeries, ACCENT, 120), `${c.ts.length} дн.`)}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px">
      ${card('Кто приносит прибыль', winners.length ? skuTable(winners) : emptyBlock('нет данных'))}
      ${card('Кто её забирает', losers.length ? skuTable(losers) : emptyBlock('убыточных товаров нет — это хорошо'))}
    </div>

    ${adviceBlock(advice)}
  `;

  return detailFrame({
    title: 'Чистая прибыль',
    value: fmtMoney(k.net_profit),
    subtitle: `${c.periodLabel} · ${c.storeName}`,
    accent: k.net_profit >= 0 ? ACCENT : '#f87171',
    delta: deltaOf(k.net_profit, c.prevKpi?.net_profit),
    body,
  });
}

function skuTable(rows: Array<{ vendor_code: string; name: string; units_sold: number; net_profit: number; margin_pct: number }>): string {
  return `
    <table class="an2-table">
      <thead><tr><th>Товар</th><th class="num">Продано</th><th class="num">Прибыль</th><th class="num">Маржа</th></tr></thead>
      <tbody>
        ${rows.map(s => `
          <tr>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <span style="color:var(--text3);font-size:10px">${escapeHtml(s.vendor_code)}</span><br>
              <span style="font-weight:600">${escapeHtml(s.name)}</span>
            </td>
            <td class="num">${fmtNum(s.units_sold)}</td>
            <td class="num ${s.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.net_profit)}</td>
            <td class="num ${s.margin_pct >= 0 ? 'pos' : 'neg'}">${s.margin_pct.toFixed(1)}%</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
