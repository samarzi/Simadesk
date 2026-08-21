import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, barList, adviceBlock, Advice,
  awaitingNote, sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';
import { computeSkuPerformance } from '../../services/kpiAggregator';

const ACCENT = '#f87171';

interface Part { label: string; value: number; color: string; what: string }

export function renderExpensesDetail(c: DetailCtx): string {
  const k = c.kpi;
  const rev = Math.max(1, k.revenue);
  const mpFees = k.commission + k.logistics + k.services + k.period_costs;

  const parts: Part[] = [
    { label: 'Комиссия маркетплейса', value: k.commission, color: '#fb923c', what: 'процент площадки с каждой продажи' },
    { label: 'Логистика',             value: k.logistics,  color: '#60a5fa', what: 'доставка до покупателя и обратная логистика возвратов' },
    { label: 'Услуги по заказам',     value: k.services,   color: '#a78bfa', what: 'удержания, привязанные к конкретным заказам' },
    { label: 'Реклама, хранение, штрафы', value: k.period_costs, color: '#f59e0b', what: 'списания площадки без привязки к заказу' },
    { label: 'Свои расходы',          value: k.manual_costs, color: '#94a3b8', what: 'записи, добавленные вручную в настройках' },
    { label: 'Себестоимость товара',  value: k.cogs,       color: '#22d3ee', what: 'закупка проданных единиц' },
    { label: 'Налог',                 value: k.tax,        color: '#f472b6', what: 'по налоговому режиму магазина' },
  ];
  const shown = parts.filter(p => p.value > 0).sort((a, b) => b.value - a.value);

  const perOrder = k.orders_settled > 0 ? k.total_expenses / k.orders_settled : 0;
  const expDaily = c.ts.map(p => p.expenses);

  const skus = computeSkuPerformance(c.orders)
    .map(s => ({ ...s, spend: s.commission + s.logistics + s.cogs }))
    .filter(s => s.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const commissionPct = (k.commission / rev) * 100;
  const logisticsPct  = (k.logistics / rev) * 100;
  const servicesPct   = ((k.services + k.period_costs) / rev) * 100;
  const adPct         = ((k.period_costs_breakdown.find(b => b.kind === 'advertising')?.amount ?? 0) / rev) * 100;
  const cogsPct       = (k.cogs / rev) * 100;
  const totalPct      = (k.total_expenses / rev) * 100;

  const advice: Advice[] = [];

  if (totalPct >= 100) {
    advice.push({
      level: 'bad',
      title: `Расходы превышают выручку: ${totalPct.toFixed(0)}%`,
      text: `На каждые 100 ₽ выручки уходит ${totalPct.toFixed(0)} ₽ затрат. Так торговать нельзя — нужно либо поднимать цену, либо убирать из ассортимента позиции, которые тянут вниз. Начни с раздела «Маржа»: там видно, какие именно артикулы убыточны.`,
    });
  }
  if (logisticsPct >= 20) {
    advice.push({
      level: 'warn',
      title: `Логистика съедает ${logisticsPct.toFixed(0)}% выручки`,
      text: `${fmtMoney(k.logistics)} за период. Обычно это признак дешёвых или крупногабаритных товаров: доставка стоит одинаково, а с низкой цены отбить её нечем. Помогает поднятие минимальной цены, комплекты из нескольких единиц и сокращение возвратов.`,
    });
  }
  if (commissionPct >= 25) {
    advice.push({
      level: 'warn',
      title: `Комиссия площадки — ${commissionPct.toFixed(0)}% выручки`,
      text: `${fmtMoney(k.commission)}. Проверь категории товаров: ставка комиссии зависит от категории, и часть товаров могла оказаться не в той. Также сюда попадает участие в акциях с повышенной ставкой.`,
    });
  }
  if (adPct >= 10) {
    advice.push({
      level: 'warn',
      title: `Доля расходов на рекламу — ${adPct.toFixed(0)}% выручки`,
      text: 'Для маркетплейса комфортный уровень — до 10%. Выше имеет смысл держать только на выводе нового товара в топ. Сверь, растёт ли выручка быстрее рекламного бюджета: если нет — ставки задраны.',
    });
  } else if (servicesPct >= 10) {
    advice.push({
      level: 'warn',
      title: `Услуги, реклама и штрафы — ${servicesPct.toFixed(0)}% выручки`,
      text: `${fmtMoney(k.services + k.period_costs)} суммарно. Разбери разбивку ниже: если это хранение — стоит вывезти неликвид, если штрафы — исправить причину, они повторятся.`,
    });
  }
  if (k.period_costs === 0 && k.services === 0) {
    advice.push({
      level: 'info',
      title: 'Реклама и хранение в отчёте не найдены',
      text: 'Либо магазин их действительно не платил, либо финотчёт за период ещё не подтянут. Нажми «Обновить» — эти списания приходят вместе с отчётом маркетплейса.',
    });
  }
  if (k.cogs === 0) {
    advice.push({
      level: 'bad',
      title: 'Себестоимость не заполнена',
      text: 'Без закупочных цен расходы занижены, а прибыль — завышена. Заполни себестоимость в «Репрайсер → Себестоимости» или прямо в блоке на вкладке «Сводка».',
    });
  } else if (cogsPct > 0 && cogsPct < 100 && k.missing_cogs_orders > 0) {
    advice.push({
      level: 'warn',
      title: `Себестоимость известна не по всем заказам`,
      text: `В ${fmtNum(k.missing_cogs_orders)} ${plural(k.missing_cogs_orders, 'заказе', 'заказах', 'заказах')} нет закупочной цены — эта строка расходов занижена, а прибыль по ним завышена.`,
    });
  }
  if (!advice.length) {
    advice.push({
      level: 'good',
      title: 'Структура расходов в норме',
      text: `Суммарно ${totalPct.toFixed(0)}% от выручки, критичных перекосов по статьям нет. Следи, чтобы логистика держалась ниже 20%, а комиссия — в рамках ставки своей категории.`,
    });
  }

  const body = `
    ${awaitingNote(k)}

    ${statGrid([
      { label: 'Доля от выручки', value: `${totalPct.toFixed(1)}%`, hint: 'сколько уходит с каждого рубля', color: totalPct >= 100 ? 'var(--red)' : undefined },
      { label: 'Удержания МП', value: fmtMoney(mpFees), hint: `${((mpFees / rev) * 100).toFixed(1)}% выручки, включая рекламу` },
      { label: 'Себестоимость', value: fmtMoney(k.cogs), hint: `${cogsPct.toFixed(1)}% выручки` },
      { label: 'Расход на заказ', value: fmtMoney(perOrder), hint: `по ${fmtNum(k.orders_settled)} рассчитанным заказам` },
      { label: 'Налог', value: fmtMoney(k.tax), hint: `${((k.tax / rev) * 100).toFixed(1)}% выручки` },
      { label: 'Осталось прибыли', value: fmtMoney(k.net_profit), hint: `маржа ${k.margin_pct.toFixed(1)}%`, color: k.net_profit >= 0 ? 'var(--green)' : 'var(--red)' },
    ])}

    ${card('Структура расходов', shown.length ? barList(shown.map(p => ({
      label: p.label,
      value: p.value,
      color: p.color,
      share: `${((p.value / rev) * 100).toFixed(1)}% выручки`,
      hint: p.what,
    }))) : emptyBlock('расходов за период нет'), 'доля указана от выручки')}

    ${k.period_costs_breakdown.length ? card('Расходы без привязки к заказам', barList(k.period_costs_breakdown.map(b => ({
      label: b.label,
      value: b.amount,
      color: b.kind === 'advertising' ? '#f59e0b' : b.kind === 'storage' ? '#38bdf8' : b.kind === 'penalty' ? '#f87171' : '#94a3b8',
      share: `${((b.amount / rev) * 100).toFixed(1)}% выручки`,
    }))), 'реклама, хранение, штрафы, подписки') : ''}

    ${card('Расходы по дням', sparkline(expDaily, ACCENT, 120), `${c.ts.length} дн.`)}

    ${card('Товары, на которые уходит больше всего', skus.length ? barList(skus.map(s => ({
      label: s.name || s.vendor_code,
      value: s.spend,
      color: ACCENT,
      share: s.revenue > 0 ? `${((s.spend / s.revenue) * 100).toFixed(0)}% от своей выручки` : '',
      hint: `${escapeHtml(s.vendor_code)} · комиссия ${fmtMoney(s.commission)} · логистика ${fmtMoney(s.logistics)}`,
    }))) : emptyBlock('нет данных'))}

    ${adviceBlock(advice)}
  `;

  return detailFrame({
    title: 'Расходы',
    value: fmtMoney(k.total_expenses),
    subtitle: `${c.periodLabel} · ${c.storeName} · база: выкупленные заказы`,
    accent: ACCENT,
    delta: deltaOf(k.total_expenses, c.prevKpi?.total_expenses, true),
    body,
  });
}
