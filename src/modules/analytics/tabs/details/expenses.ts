import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, barList, adviceBlock, Advice,
  estimateNote, sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';
import { computeSkuPerformance } from '../../services/kpiAggregator';

const ACCENT = '#f87171';

interface Part { label: string; value: number; color: string; what: string }

export function renderExpensesDetail(c: DetailCtx): string {
  const k = c.kpi;
  const rev = Math.max(1, k.revenue);
  const mpFees = k.commission + k.logistics + k.services;

  const parts: Part[] = [
    { label: 'Комиссия маркетплейса', value: k.commission, color: '#fb923c', what: 'процент площадки с каждой продажи' },
    { label: 'Логистика',             value: k.logistics,  color: '#60a5fa', what: 'доставка до покупателя и обратная логистика возвратов' },
    { label: 'Услуги, штрафы, реклама', value: k.services, color: '#a78bfa', what: 'хранение, продвижение, эквайринг, удержания' },
    { label: 'Себестоимость товара',  value: k.cogs,       color: '#22d3ee', what: 'закупка проданных единиц' },
    { label: 'Налог',                 value: k.tax,        color: '#f472b6', what: 'по налоговому режиму магазина' },
  ];
  const shown = parts.filter(p => p.value > 0).sort((a, b) => b.value - a.value);

  const perOrder = k.orders_delivered > 0 ? k.total_expenses / k.orders_delivered : 0;
  const expDaily = c.ts.map(p => p.expenses);

  const skus = computeSkuPerformance(c.orders)
    .map(s => ({ ...s, spend: s.commission + s.logistics + s.cogs }))
    .filter(s => s.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const commissionPct = (k.commission / rev) * 100;
  const logisticsPct  = (k.logistics / rev) * 100;
  const servicesPct   = (k.services / rev) * 100;
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
  if (servicesPct >= 10) {
    advice.push({
      level: 'warn',
      title: `Услуги и штрафы — ${servicesPct.toFixed(0)}% выручки`,
      text: `${fmtMoney(k.services)} на хранение, продвижение и удержания. Разбери карточки крупных заказов: если это хранение — стоит вывезти неликвид, если штрафы — исправить причину, они повторятся.`,
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
    ${estimateNote(k)}

    ${statGrid([
      { label: 'Доля от выручки', value: `${totalPct.toFixed(1)}%`, hint: 'сколько уходит с каждого рубля', color: totalPct >= 100 ? 'var(--red)' : undefined },
      { label: 'Удержания МП', value: fmtMoney(mpFees), hint: `${((mpFees / rev) * 100).toFixed(1)}% выручки` },
      { label: 'Себестоимость', value: fmtMoney(k.cogs), hint: `${cogsPct.toFixed(1)}% выручки` },
      { label: 'Расход на заказ', value: fmtMoney(perOrder), hint: `по ${fmtNum(k.orders_delivered)} доставленным` },
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
    subtitle: `${c.periodLabel} · ${c.storeName}`,
    accent: ACCENT,
    delta: deltaOf(k.total_expenses, c.prevKpi?.total_expenses, true),
    body,
  });
}
