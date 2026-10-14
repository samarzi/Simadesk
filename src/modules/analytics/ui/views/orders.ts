/** «Заказы» — список заказов периода с деньгами по каждому, и карточка заказа. */

import { Order, OrderStatus, STATUS_LABEL, MP_SHORT, MP_LABEL } from '../../types';
import { rub, num, dateTime, escapeHtml, jsArg } from '../format';

export type OrdersStatus = OrderStatus | 'all';

export interface OrdersState {
  status: OrdersStatus;
  search: string;
  limit: number;
}

export const ORDERS_PAGE = 100;
const M = 'window.analyticsModule';

const STATUS_ORDER: OrdersStatus[] = ['all', 'delivered', 'in_delivery', 'processing', 'returned', 'cancelled'];
const STATUS_TAB: Record<OrdersStatus, string> = {
  all: 'Все', delivered: 'Доставлены', in_delivery: 'В доставке', processing: 'В обработке',
  returned: 'Возвраты', cancelled: 'Отмены', unknown: 'Прочие',
};

export function filterOrders(orders: Order[], st: OrdersState): Order[] {
  const q = st.search.trim().toLowerCase();
  return orders.filter(o => {
    if (o.is_orphan) return false;
    if (st.status !== 'all' && o.status !== st.status) return false;
    if (!q) return true;
    return o.order_id.toLowerCase().includes(q)
      || o.items.some(it => `${it.vendor_code} ${it.name}`.toLowerCase().includes(q));
  });
}

function statusPill(o: Order): string {
  const partial = o.status === 'delivered' && o.revenue_lost > 0;
  return `<span class="an-status s-${o.status}">${STATUS_LABEL[o.status]}${partial ? ' · част. возврат' : ''}</span>`;
}

export function renderOrders(orders: Order[], st: OrdersState): string {
  const visible = orders.filter(o => !o.is_orphan);
  const counts = new Map<OrdersStatus, number>([['all', visible.length]]);
  for (const o of visible) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const list = filterOrders(orders, st);

  return `
    <div class="an-toolbar">
      <div class="an-segs">
        ${STATUS_ORDER.filter(s => s === 'all' || counts.get(s)).map(s => `
          <button class="an-seg ${st.status === s ? 'on' : ''}" onclick="${M}?.setOrdersStatus('${s}')">${STATUS_TAB[s]} <span>${num(counts.get(s) ?? 0)}</span></button>`).join('')}
      </div>
      <span class="an-grow"></span>
      <input class="an-search" type="search" placeholder="Номер заказа, артикул, товар" value="${escapeHtml(st.search)}"
        oninput="${M}?.setOrdersSearch(this.value)"/>
    </div>
    <section class="an-card flush">
      ${list.length === 0 ? '<div class="an-empty"><h3>Заказов не найдено</h3><p>Смените статус, поиск или период.</p></div>' : `
      <div class="an-scroll">
        <table class="an-table">
          <thead><tr><th>Дата</th><th>Заказ</th><th>Товары</th><th>Статус</th>
            <th class="num">Выручка</th><th class="num">Удержания МП</th><th class="num">Себестоимость</th><th class="num">Прибыль</th></tr></thead>
          <tbody>${list.slice(0, st.limit).map(o => {
            const pending = o.pending_settlement || (o.status === 'delivered' && o.source !== 'real');
            const fees = o.commission + o.logistics + o.logistics_return + o.services;
            const units = o.items.reduce((s, i) => s + i.quantity, 0);
            return `
            <tr onclick="${M}?.openOrder('${jsArg(o.order_key ?? o.order_id)}')">
              <td class="an-nowrap">${dateTime(o.date)}</td>
              <td><span class="an-mp an-mp-${o.mp}">${MP_SHORT[o.mp]}</span> <span class="an-mono">${escapeHtml(o.order_id)}</span>${o.finance_only ? ' <span class="an-tag" title="Маркетплейс не вернул заказ в списке — он восстановлен из финотчёта">из финотчёта</span>' : ''}</td>
              <td class="an-items" title="${escapeHtml(o.items.map(i => `${i.vendor_code} × ${i.quantity} — ${i.name}`).join('\n'))}">${escapeHtml(o.items[0]?.name || o.items[0]?.vendor_code || '—')}${o.items.length > 1 ? ` <span class="an-muted">+${o.items.length - 1}</span>` : ''} <span class="an-muted">· ${num(units)} шт</span></td>
              <td>${statusPill(o)}</td>
              <td class="num">${rub(o.status === 'returned' || o.status === 'cancelled' ? o.revenue_lost : o.revenue)}</td>
              <td class="num">${pending ? '<span class="an-muted" title="Финотчёт ещё не пришёл">ждём отчёт</span>' : rub(fees)}</td>
              <td class="num">${o.cogs ? rub(o.cogs) : o.missing_cogs_count ? '<span class="neg">не задана</span>' : '—'}</td>
              <td class="num ${pending ? '' : o.net_profit >= 0 ? 'pos' : 'neg'}">${pending ? '—' : rub(o.net_profit)}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
      ${list.length > st.limit ? `<div class="an-more"><button class="an-btn ghost" onclick="${M}?.showMoreOrders()">Показать ещё ${num(Math.min(ORDERS_PAGE, list.length - st.limit))} из ${num(list.length - st.limit)}</button></div>` : ''}`}
    </section>
  `;
}

/** Карточка заказа: из чего сложилась прибыль. */
export function renderOrderDrawer(o: Order): string {
  const pending = o.pending_settlement || (o.status === 'delivered' && o.source !== 'real');
  const gross = o.status === 'returned' || o.status === 'cancelled' ? o.revenue_lost : o.revenue;
  const line = (label: string, v: number, cls = '') => `<div class="an-kv ${cls}"><span>${escapeHtml(label)}</span><strong>${rub(v)}</strong><em></em></div>`;
  return `
    <div class="an-drawer-bg" onclick="${M}?.closeOrder()"></div>
    <aside class="an-drawer" role="dialog" aria-label="Заказ ${escapeHtml(o.order_id)}">
      <header>
        <div>
          <div class="an-muted">${escapeHtml(MP_LABEL[o.mp])} · ${escapeHtml(o.store_name)}</div>
          <h3 class="an-mono">${escapeHtml(o.order_id)}</h3>
          <div>${statusPill(o)} <span class="an-muted">${dateTime(o.date)}</span></div>
        </div>
        <button class="an-icon" onclick="${M}?.closeOrder()" aria-label="Закрыть">✕</button>
      </header>
      <div class="an-drawer-body">
        <h4>Товары</h4>
        ${o.items.map(i => `
          <div class="an-kv"><span>${escapeHtml(i.name || i.vendor_code)}<small>${escapeHtml(i.vendor_code)} · ${num(i.quantity)} шт × ${rub(i.price)}</small></span>
            <strong>${rub(i.price * i.quantity)}</strong><em>${i.cost_price != null ? `себест. ${rub(i.cost_price)}` : '<span class="neg">нет себестоимости</span>'}</em></div>`).join('')}

        <h4>Деньги по заказу</h4>
        ${pending ? '<div class="an-alert info">Маркетплейс ещё не прислал финотчёт: комиссия и логистика пока неизвестны, заказ не входит в выручку и прибыль.</div>' : ''}
        ${line(o.status === 'returned' ? 'Выручка до возврата' : o.status === 'cancelled' ? 'Сумма отменённого заказа' : 'Выручка', gross)}
        ${o.revenue_lost > 0 && o.status === 'delivered' ? line('Вернули покупателю', -o.revenue_lost, 'neg') : ''}
        ${o.fee_breakdown.map(f => line(f.label, -f.amount, f.amount > 0 ? '' : 'pos')).join('')}
        ${o.cogs ? line('Себестоимость', -o.cogs) : ''}
        ${o.tax ? line('Налог', -o.tax) : ''}
        ${pending ? '' : line('Прибыль', o.net_profit, `total ${o.net_profit >= 0 ? 'pos' : 'neg'}`)}
        ${o.payout_actual ? `<p class="an-muted an-note">Маркетплейс перечислил по заказу: ${rub(o.payout_actual)}</p>` : ''}
      </div>
    </aside>`;
}
