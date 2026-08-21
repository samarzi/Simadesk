import { computeSkuPerformance } from '../../services/kpiAggregator';
import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, barList, adviceBlock, Advice,
  awaitingNote, sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';

const ACCENT = '#d4f000';

export function renderRevenueDetail(c: DetailCtx): string {
  const k = c.kpi;
  const lost = k.returns_revenue + k.cancelled_revenue;
  // Доля потерь считается от всего заказанного объёма, а не от выкупленной части:
  // иначе процент раздувается тем сильнее, чем хуже выкуп.
  const lostPct = k.ordered_revenue > 0 ? (lost / k.ordered_revenue) * 100 : 0;

  // Выручка в разрезе статусов — считаем прямо по заказам, а не восстанавливаем из KPI.
  let revDelivered = 0, revInWork = 0;
  for (const o of c.orders) {
    if (o.status === 'delivered') revDelivered += o.revenue;
    else if (o.status === 'processing' || o.status === 'in_delivery') revInWork += o.revenue;
  }

  const skus = computeSkuPerformance(c.orders).filter(s => s.revenue > 0).slice(0, 10);
  const daily = c.ts.map(p => p.revenue);
  const activeDays = c.ts.filter(p => p.revenue > 0).length;
  const perDay = activeDays > 0 ? k.revenue / activeDays : 0;

  const advice: Advice[] = [];
  if (lostPct >= 15) {
    advice.push({
      level: 'bad',
      title: `Возвраты и отмены съедают ${lostPct.toFixed(0)}% потенциальной выручки`,
      text: `Это ${fmtMoney(lost)} несостоявшихся продаж. Проверь карточки товаров с самым высоким процентом возвратов: чаще всего причина — расхождение фото/описания с реальностью, ошибки в размерной сетке или брак у конкретной партии.`,
    });
  } else if (lostPct >= 7) {
    advice.push({
      level: 'warn',
      title: `Потери на возвратах и отменах — ${lostPct.toFixed(0)}%`,
      text: `${fmtMoney(lost)} за период. Это ещё в пределах нормы для маркетплейса, но стоит посмотреть, не концентрируются ли возвраты на паре артикулов.`,
    });
  } else if (lost > 0) {
    advice.push({
      level: 'good',
      title: `Возвраты под контролем — ${lostPct.toFixed(1)}%`,
      text: `Потеряно ${fmtMoney(lost)}. Хороший показатель, менять в процессах ничего не нужно.`,
    });
  }

  const prevRev = c.prevKpi?.revenue;
  if (prevRev != null && prevRev > 0) {
    const diff = ((k.revenue - prevRev) / prevRev) * 100;
    if (diff <= -15) {
      advice.push({
        level: 'warn',
        title: `Выручка просела на ${Math.abs(diff).toFixed(0)}% к прошлому периоду`,
        text: `Было ${fmtMoney(prevRev)}, стало ${fmtMoney(k.revenue)}. Сначала проверь остатки: чаще всего падение — это не спрос, а товар, ушедший в ноль на складе. Затем позиции в поиске и цены конкурентов.`,
      });
    } else if (diff >= 15) {
      advice.push({
        level: 'good',
        title: `Выручка выросла на ${diff.toFixed(0)}%`,
        text: `Рост с ${fmtMoney(prevRev)} до ${fmtMoney(k.revenue)}. Посмотри в «Товарах», какие артикулы дали прирост, и убедись, что по ним хватает остатков — на растущем товаре закончиться на складе обиднее всего.`,
      });
    }
  }

  if (k.avg_check > 0 && c.prevKpi && c.prevKpi.avg_check > 0) {
    const d = ((k.avg_check - c.prevKpi.avg_check) / c.prevKpi.avg_check) * 100;
    if (d <= -10) {
      advice.push({
        level: 'info',
        title: `Средний чек упал на ${Math.abs(d).toFixed(0)}%`,
        text: `Сейчас ${fmtMoney(k.avg_check)} против ${fmtMoney(c.prevKpi.avg_check)}. Обычно это следствие скидок или сдвига продаж в сторону дешёвых позиций. Проверь, окупается ли прирост заказов падением чека.`,
      });
    }
  }

  const body = `
    ${awaitingNote(k)}

    ${statGrid([
      { label: 'Заказано за период', value: fmtMoney(k.ordered_revenue), hint: 'весь объём заказов по дате оформления' },
      { label: 'Ещё в пути', value: fmtMoney(k.in_transit_revenue), hint: `${fmtNum(k.orders_processing)} ${plural(k.orders_processing, 'заказ', 'заказа', 'заказов')} — в прибыль не входят` },
      { label: 'Средний чек', value: fmtMoney(k.avg_check), hint: `по ${fmtNum(k.orders_settled)} рассчитанным заказам` },
      { label: 'Единиц продано', value: fmtNum(k.units_sold), hint: 'в выкупленных заказах' },
      { label: 'Выручка в день', value: fmtMoney(perDay), hint: `${activeDays} ${plural(activeDays, 'день с продажами', 'дня с продажами', 'дней с продажами')}` },
      { label: 'Потеряно на возвратах', value: fmtMoney(k.returns_revenue), hint: `${fmtNum(k.orders_returned)} ${plural(k.orders_returned, 'возврат', 'возврата', 'возвратов')}`, color: k.returns_revenue > 0 ? 'var(--red)' : undefined },
      { label: 'Потеряно на отменах', value: fmtMoney(k.cancelled_revenue), hint: `${fmtNum(k.orders_cancelled)} ${plural(k.orders_cancelled, 'отмена', 'отмены', 'отмен')}`, color: k.cancelled_revenue > 0 ? 'var(--red)' : undefined },
    ])}

    ${card('Выручка по дням', sparkline(daily, ACCENT, 120), `${c.ts.length} дн. · только выкупленные заказы`)}

    ${card('Топ-10 товаров по выручке', skus.length ? barList(skus.map(s => ({
      label: s.name || s.vendor_code,
      value: s.revenue,
      color: ACCENT,
      share: k.revenue > 0 ? `${((s.revenue / k.revenue) * 100).toFixed(1)}%` : '',
      hint: `${escapeHtml(s.vendor_code)} · ${fmtNum(s.units_sold)} шт`,
    }))) : emptyBlock('нет продаж за период'))}

    ${card('Что стало с заказанным объёмом', barList([
      { label: 'Выкуплено — это и есть выручка', value: revDelivered, color: '#22c55e', share: `${fmtNum(k.orders_delivered)} зак.` },
      { label: 'В пути (прогноз)', value: revInWork, color: '#fbbf24', share: `${fmtNum(k.orders_processing)} зак.` },
      { label: 'Возвращено покупателем', value: k.returns_revenue, color: '#f87171', share: `${fmtNum(k.orders_returned)} зак.` },
      { label: 'Отменено до доставки', value: k.cancelled_revenue, color: '#94a3b8', share: `${fmtNum(k.orders_cancelled)} зак.` },
    ].filter(r => r.value > 0)), `заказано ${fmtMoney(k.ordered_revenue)}`)}

    ${adviceBlock(advice)}
  `;

  return detailFrame({
    title: 'Выручка',
    value: fmtMoney(k.revenue),
    subtitle: `${c.periodLabel} · ${c.storeName} · база: выкупленные заказы`,
    accent: ACCENT,
    delta: deltaOf(k.revenue, c.prevKpi?.revenue),
    body,
  });
}
