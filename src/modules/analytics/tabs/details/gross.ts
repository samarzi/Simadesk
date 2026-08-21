import { computeSkuPerformance } from '../../services/kpiAggregator';
import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, barList, adviceBlock, Advice,
  awaitingNote, sparkline, dailySeries, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';

const ACCENT = '#10b981';

/**
 * «Прибыль без себестоимости» = выручка − комиссия − логистика − услуги − налог.
 * Это то, что остаётся от продажи после всех удержаний площадки, но до закупки товара.
 * Показатель отвечает на вопрос «сколько маркетплейс оставляет мне с рубля».
 */
export function renderGrossDetail(c: DetailCtx): string {
  const k = c.kpi;
  const rev = Math.max(1, k.revenue);
  const gross = k.net_profit + k.cogs;
  const prevGross = c.prevKpi ? c.prevKpi.net_profit + c.prevKpi.cogs : null;
  const grossPct = (gross / rev) * 100;
  const mpFees = k.commission + k.logistics + k.services + k.period_costs;
  const mpFeesPct = (mpFees / rev) * 100;

  // Ряд по дням строим сам: в ts.profit лежит ЧИСТАЯ прибыль (с себестоимостью),
  // а этот показатель — до неё. Иначе график спорил бы с числом в шапке.
  const grossByDay = dailySeries(c.orders, o =>
    (o.status === 'delivered' ? o.revenue - o.tax : 0)
    - o.commission - o.logistics - o.logistics_return - o.services);
  const grossSeries = c.ts.map(p => grossByDay.get(p.date) ?? 0);
  const perOrder = k.orders_settled > 0 ? gross / k.orders_settled : 0;

  const skus = computeSkuPerformance(c.orders)
    .filter(s => s.units_sold > 0)
    .map(s => ({ ...s, gross: s.revenue - s.commission - s.logistics }))
    .sort((a, b) => b.gross - a.gross)
    .slice(0, 10);

  const advice: Advice[] = [];

  if (k.cogs === 0) {
    advice.push({
      level: 'info',
      title: 'Сейчас это единственная честная цифра прибыли',
      text: 'Себестоимость не заполнена, поэтому «чистая прибыль» совпадает с этим показателем. Как только внесёшь закупочные цены, появится реальная прибыль — а этот блок останется отвечать за эффективность работы с площадкой.',
    });
  } else {
    advice.push({
      level: 'info',
      title: `На закупку товара уходит ${fmtMoney(k.cogs)} из этой суммы`,
      text: `После вычета себестоимости остаётся ${fmtMoney(k.net_profit)} чистой прибыли. Разница между этими двумя цифрами и есть цена вашего товара в закупке.`,
    });
  }

  if (mpFeesPct >= 40) {
    advice.push({
      level: 'bad',
      title: `Площадка забирает ${mpFeesPct.toFixed(0)}% выручки`,
      text: `${fmtMoney(mpFees)} за период. При таких удержаниях положительная прибыль возможна только с очень высокой наценкой. Проверь категорию товара (от неё зависит ставка комиссии) и долю логистики — на дешёвых товарах она часто и создаёт перекос.`,
    });
  } else if (mpFeesPct >= 30) {
    advice.push({
      level: 'warn',
      title: `Удержания маркетплейса — ${mpFeesPct.toFixed(0)}% выручки`,
      text: 'Это выше комфортного уровня. Основные рычаги: правильная категория товара, отказ от акций с повышенной комиссией и рост среднего чека, чтобы логистика размазывалась на большую сумму.',
    });
  } else {
    advice.push({
      level: 'good',
      title: `Удержания площадки ${mpFeesPct.toFixed(0)}% — в норме`,
      text: `С каждого рубля выручки после расчётов с маркетплейсом остаётся ${(grossPct / 100).toFixed(2)} ₽. Это рабочий уровень, дальше всё решает закупочная цена.`,
    });
  }

  if (k.services + k.period_costs > k.commission && k.services + k.period_costs > 0) {
    advice.push({
      level: 'warn',
      title: 'Услуги и штрафы стоят дороже самой комиссии',
      text: `${fmtMoney(k.services + k.period_costs)} против ${fmtMoney(k.commission)} комиссии. Это ненормальная пропорция: обычно так выглядит счёт за хранение неликвида или серия штрафов. Загляни в карточки крупных заказов — там видна расшифровка удержаний.`,
    });
  }

  const body = `
    ${awaitingNote(k)}

    ${statGrid([
      { label: 'Доля от выручки', value: `${grossPct.toFixed(1)}%`, hint: 'остаётся после расчётов с МП', color: grossPct >= 60 ? 'var(--green)' : grossPct >= 40 ? '#fbbf24' : 'var(--red)' },
      { label: 'Забрал маркетплейс', value: fmtMoney(mpFees), hint: `${mpFeesPct.toFixed(1)}% выручки`, color: 'var(--red)' },
      { label: 'С одного заказа', value: fmtMoney(perOrder), hint: `по ${fmtNum(k.orders_settled)} рассчитанным заказам` },
      { label: 'Минус себестоимость', value: fmtMoney(k.cogs), hint: k.cogs > 0 ? `${((k.cogs / rev) * 100).toFixed(1)}% выручки` : 'не заполнена' },
      { label: 'Чистая прибыль', value: fmtMoney(k.net_profit), hint: `маржа ${k.margin_pct.toFixed(1)}%`, color: k.net_profit >= 0 ? 'var(--green)' : 'var(--red)' },
      { label: 'Налог', value: fmtMoney(k.tax), hint: `${((k.tax / rev) * 100).toFixed(1)}% выручки` },
    ])}

    ${card('Из чего складывается', barList([
      { label: 'Выручка', value: k.revenue, color: '#d4f000', share: '100%' },
      { label: 'минус комиссия МП', value: k.commission, color: '#fb923c', share: `${((k.commission / rev) * 100).toFixed(1)}%` },
      { label: 'минус логистика', value: k.logistics, color: '#60a5fa', share: `${((k.logistics / rev) * 100).toFixed(1)}%` },
      { label: 'минус услуги по заказам', value: k.services, color: '#a78bfa', share: `${((k.services / rev) * 100).toFixed(1)}%` },
      { label: 'минус реклама и хранение', value: k.period_costs, color: '#f59e0b', share: `${((k.period_costs / rev) * 100).toFixed(1)}%` },
      { label: 'минус свои расходы', value: k.manual_costs, color: '#94a3b8', share: `${((k.manual_costs / rev) * 100).toFixed(1)}%` },
      { label: 'минус налог', value: k.tax, color: '#f472b6', share: `${((k.tax / rev) * 100).toFixed(1)}%` },
      { label: '= прибыль без себестоимости', value: Math.max(0, gross), color: ACCENT, share: `${grossPct.toFixed(1)}%` },
    ].filter(r => r.value > 0)))}

    ${card('Динамика по дням', sparkline(grossSeries, ACCENT, 120), 'выручка минус удержания МП и налог, до себестоимости')}

    ${card('Товары с лучшим остатком после удержаний', skus.length ? barList(skus.map(s => ({
      label: s.name || s.vendor_code,
      value: s.gross,
      color: ACCENT,
      share: s.revenue > 0 ? `${((s.gross / s.revenue) * 100).toFixed(0)}% от выручки` : '',
      hint: `${escapeHtml(s.vendor_code)} · ${fmtNum(s.units_sold)} шт · выручка ${fmtMoney(s.revenue)}`,
    }))) : emptyBlock('нет продаж за период'))}

    ${adviceBlock(advice)}
  `;

  return detailFrame({
    title: 'Прибыль без себестоимости',
    value: fmtMoney(gross),
    subtitle: `${c.periodLabel} · ${c.storeName} · ${fmtNum(k.orders_delivered)} ${plural(k.orders_delivered, 'выкупленный заказ', 'выкупленных заказа', 'выкупленных заказов')}`,
    accent: ACCENT,
    delta: deltaOf(gross, prevGross),
    body,
  });
}
