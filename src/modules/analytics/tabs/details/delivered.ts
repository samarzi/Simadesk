import { STATUS_LABEL, STATUS_COLOR, Order } from '../../types';
import {
  DetailCtx, detailFrame, deltaOf, card, statGrid, barList, adviceBlock, Advice,
  estimateNote, sparkline, fmtMoney, fmtNum, plural, emptyBlock, escapeHtml,
} from './shared';

const ACCENT = '#a78bfa';
const MAX_ROWS = 60;

export function renderDeliveredDetail(c: DetailCtx): string {
  const k = c.kpi;
  const closed = k.orders_delivered + k.orders_returned + k.orders_cancelled;
  const returnPct = closed > 0 ? (k.orders_returned / closed) * 100 : 0;
  const cancelPct = closed > 0 ? (k.orders_cancelled / closed) * 100 : 0;

  const delivered = c.orders
    .filter(o => o.status === 'delivered' && !o.is_orphan)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Доставки по дням
  const byDay = new Map<string, number>();
  for (const o of delivered) {
    if (!o.date) continue;
    const d = o.date.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const series = c.ts.map(p => byDay.get(p.date) ?? 0);
  const activeDays = series.filter(v => v > 0).length;
  const perDay = activeDays > 0 ? k.orders_delivered / activeDays : 0;

  const units = delivered.reduce((s, o) => s + o.items.reduce((q, it) => q + it.quantity, 0), 0);
  const itemsPerOrder = k.orders_delivered > 0 ? units / k.orders_delivered : 0;

  const advice: Advice[] = [];
  if (returnPct >= 15) {
    advice.push({
      level: 'bad',
      title: `Каждый ${Math.round(100 / Math.max(1, returnPct))}-й заказ возвращают — ${returnPct.toFixed(0)}%`,
      text: `${fmtNum(k.orders_returned)} ${plural(k.orders_returned, 'возврат', 'возврата', 'возвратов')} на ${fmtNum(closed)} закрытых заказов. Возврат стоит дважды: обратная логистика плюс упущенная продажа. Найди артикулы-лидеры по возвратам и проверь у них фото, описание и размерную сетку.`,
    });
  } else if (returnPct >= 8) {
    advice.push({
      level: 'warn',
      title: `Возвраты — ${returnPct.toFixed(1)}%`,
      text: `Пока терпимо, но каждый процент возвратов напрямую бьёт по марже через обратную логистику. Стоит посмотреть, не сконцентрированы ли они на одном-двух товарах.`,
    });
  }
  if (cancelPct >= 10) {
    advice.push({
      level: 'warn',
      title: `Отмен до доставки — ${cancelPct.toFixed(0)}%`,
      text: `${fmtNum(k.orders_cancelled)} ${plural(k.orders_cancelled, 'заказ отменён', 'заказа отменено', 'заказов отменено')}. Частые причины: товар кончился на складе, долгая сборка, срыв срока отгрузки. Отмены по вине продавца площадка учитывает в рейтинге.`,
    });
  }
  if (k.buyout_pct >= 90 && closed >= 10) {
    advice.push({
      level: 'good',
      title: `Выкуп ${k.buyout_pct.toFixed(0)}% — отличный показатель`,
      text: 'Почти все заказы доходят до покупателя и остаются у него. Держи этот уровень при масштабировании: рост рекламы часто приводит нецелевой трафик и роняет выкуп.',
    });
  }
  if (k.orders_processing > k.orders_delivered && k.orders_processing > 5) {
    advice.push({
      level: 'info',
      title: `В работе больше заказов, чем доставлено: ${fmtNum(k.orders_processing)}`,
      text: 'Для короткого периода это нормально — заказы ещё едут. Их финансовые цифры пока оценочные и уточнятся, когда маркетплейс пришлёт финотчёт.',
    });
  }
  if (!advice.length) {
    advice.push({
      level: 'good',
      title: 'С доставками всё ровно',
      text: `Выкуп ${k.buyout_pct.toFixed(0)}%, возвратов ${returnPct.toFixed(1)}%, отмен ${cancelPct.toFixed(1)}%. Показатели в пределах нормы для маркетплейса.`,
    });
  }

  const funnel = [
    { label: STATUS_LABEL.delivered,   value: k.orders_delivered,  color: STATUS_COLOR.delivered },
    { label: 'В работе / в доставке',  value: k.orders_processing, color: STATUS_COLOR.processing },
    { label: STATUS_LABEL.returned,    value: k.orders_returned,   color: STATUS_COLOR.returned },
    { label: STATUS_LABEL.cancelled,   value: k.orders_cancelled,  color: STATUS_COLOR.cancelled },
  ].filter(r => r.value > 0);

  const body = `
    ${estimateNote(k)}

    ${statGrid([
      { label: '% выкупа', value: `${k.buyout_pct.toFixed(1)}%`, hint: 'доставлено из закрытых заказов', color: k.buyout_pct >= 85 ? 'var(--green)' : k.buyout_pct >= 70 ? '#fbbf24' : 'var(--red)' },
      { label: 'Средний чек', value: fmtMoney(k.avg_check), hint: 'по доставленным заказам' },
      { label: 'Доставок в день', value: perDay.toFixed(1), hint: `${activeDays} ${plural(activeDays, 'активный день', 'активных дня', 'активных дней')}` },
      { label: 'Единиц в заказе', value: itemsPerOrder.toFixed(2), hint: `${fmtNum(units)} шт всего` },
      { label: 'Возвраты', value: `${fmtNum(k.orders_returned)}`, hint: `${returnPct.toFixed(1)}% от закрытых`, color: returnPct >= 10 ? 'var(--red)' : undefined },
      { label: 'Отмены', value: `${fmtNum(k.orders_cancelled)}`, hint: `${cancelPct.toFixed(1)}% от закрытых`, color: cancelPct >= 10 ? 'var(--red)' : undefined },
    ])}

    ${card('Что стало с заказами', barList(funnel.map(r => ({
      label: r.label,
      value: r.value,
      color: r.color,
      valueText: fmtNum(r.value),
      share: k.orders_total > 0 ? `${((r.value / k.orders_total) * 100).toFixed(1)}%` : '',
    }))), `всего ${fmtNum(k.orders_total)} зак.`)}

    ${card('Доставки по дням', sparkline(series, ACCENT, 120), `${c.ts.length} дн.`)}

    ${card(
      `Доставленные заказы`,
      delivered.length ? ordersTable(delivered.slice(0, MAX_ROWS)) : emptyBlock('за период нет доставленных заказов'),
      delivered.length > MAX_ROWS ? `показаны ${MAX_ROWS} из ${fmtNum(delivered.length)} — все во вкладке «Заказы»` : `${fmtNum(delivered.length)} шт.`,
    )}

    ${adviceBlock(advice)}
  `;

  return detailFrame({
    title: 'Заказов доставлено',
    value: fmtNum(k.orders_delivered),
    subtitle: `${c.periodLabel} · ${c.storeName}`,
    accent: ACCENT,
    delta: deltaOf(k.orders_delivered, c.prevKpi?.orders_delivered),
    body,
  });
}

function ordersTable(orders: Order[]): string {
  return `
    <table class="an2-table">
      <thead><tr>
        <th>Дата</th><th>Заказ</th><th>Товары</th>
        <th class="num">Выручка</th><th class="num">Прибыль</th><th class="num">Маржа</th>
      </tr></thead>
      <tbody>
        ${orders.map(o => {
          const margin = o.revenue > 0 ? (o.net_profit / o.revenue) * 100 : 0;
          const names = o.items.map(it => it.name || it.vendor_code).join(', ');
          return `
            <tr onclick="window.analyticsModule?.openOrder('${escapeHtml(o.order_id).replace(/'/g, "\\'")}')">
              <td style="color:var(--text3);white-space:nowrap">${fmtDay(o.date)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:10.5px">${escapeHtml(o.order_id)}</td>
              <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(names)}">${escapeHtml(names)}</td>
              <td class="num">${fmtMoney(o.revenue)}</td>
              <td class="num ${o.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(o.net_profit)}${o.fees_estimated ? ' <span class="an2-est-dot" title="удержания оценены — финотчёт ещё не пришёл">~</span>' : ''}</td>
              <td class="num">${margin.toFixed(1)}%</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function fmtDay(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}
