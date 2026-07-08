import { Order, OrderStatus, STATUS_LABEL, STATUS_COLOR, MP_SHORT, MP_COLOR } from '../types';
import { I } from '@/utils/icons';
import { fmtMoney, fmtDate, fmtNum, escapeHtml } from '../components/format';
import { copyButton } from '@/utils/copyButton';

export interface OrdersFilters {
  status: OrderStatus | 'all';
  mp:     'all' | 'ozon' | 'wb' | 'yandex';
  search: string;
  page:   number; // kept for compat, unused
}

// Progressive load: первые строки рендерятся сразу, остальные в фоне
const INITIAL_ROWS = 150;
let _queueId = 0;

function isoToDay(iso: string): string {
  if (!iso) return '';
  return iso.slice(0, 10); // YYYY-MM-DD
}

function fmtDayHeader(day: string): string {
  if (!day) return '—';
  const d = new Date(day + 'T12:00:00');
  if (isNaN(d.getTime())) return day;
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const todayDay = today.toISOString().slice(0, 10);
  const yDay     = yesterday.toISOString().slice(0, 10);
  if (day === todayDay) return 'Сегодня';
  if (day === yDay)     return 'Вчера';
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Кеш HTML: при body-only repaints (например, переключение табов туда-обратно)
// orders и filters остаются те же — возвращаем готовый HTML за <1мс
// вместо построения тысяч строк (~100-300мс).
let _ordersCacheOrders: Order[] | null = null;
let _ordersCacheKey = '';
let _ordersCacheHtml = '';

export function clearOrdersCache(): void {
  _ordersCacheOrders = null; _ordersCacheKey = ''; _ordersCacheHtml = '';
}

export function renderOrdersTab(orders: Order[], f: OrdersFilters): string {
  // Композитный ключ. orders проверяем по reference (refresh создаёт новый массив).
  const key = `${f.status}|${f.mp}|${f.search}`;
  if (orders === _ordersCacheOrders && key === _ordersCacheKey && _ordersCacheHtml) {
    return _ordersCacheHtml;
  }
  const html = _renderOrdersTabUncached(orders, f);
  _ordersCacheOrders = orders;
  _ordersCacheKey = key;
  _ordersCacheHtml = html;
  return html;
}

function _renderOrdersTabUncached(orders: Order[], f: OrdersFilters): string {
  const filtered = orders.filter(o => {
    // Осиротевшие транзакции (упаковка/сервис без реального заказа от МП) —
    // не полноценный заказ, показывать строкой не за что. Их сумма всё равно
    // учтена в сводных расходах (kpiAggregator не фильтрует is_orphan).
    if (o.is_orphan) return false;
    if (f.status !== 'all' && o.status !== f.status) return false;
    if (f.mp !== 'all' && o.mp !== f.mp) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!o.order_id.toLowerCase().includes(q)
        && !o.items.some(it => (it.vendor_code + ' ' + it.name).toLowerCase().includes(q)))
        return false;
    }
    return true;
  });

  // Newest first (aggregator already sorts, but keep it here as safety)
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const total = filtered.length;

  const statusOpts: Array<[OrderStatus | 'all', string]> = [
    ['all', 'Все статусы'],
    ['processing', STATUS_LABEL.processing],
    ['in_delivery', STATUS_LABEL.in_delivery],
    ['delivered', STATUS_LABEL.delivered],
    ['returned', STATUS_LABEL.returned],
    ['cancelled', STATUS_LABEL.cancelled],
  ];

  // Build all row HTML strings (with date separators) as an array for progressive load
  let lastDay = '';
  const rowsArr: string[] = [];
  for (const o of filtered) {
    const day = isoToDay(o.date);
    if (day !== lastDay) {
      lastDay = day;
      rowsArr.push(`
        <tr class="an2-date-sep-row">
          <td colspan="9"><span class="an2-date-sep-label">${fmtDayHeader(day)}</span></td>
        </tr>`);
    }
    const expensesMp = o.commission + o.logistics + o.logistics_return + o.services;
    const goods = o.items.map(it => `<span style="display:inline-flex;align-items:center;gap:2px">${escapeHtml(it.vendor_code)}×${it.quantity}${copyButton(it.vendor_code, 'Копировать артикул')}</span>`).join(', ');
    const safeId = escapeHtml(o.order_id);
    const pending = o.pending_settlement;
    const pendingCls = pending ? ' an2-pending' : '';
    const pendingTitle = pending ? ' title="Финотчёт МП ещё не пришёл — комиссия/логистика неизвестны, цифры предварительные"' : '';
    rowsArr.push(`
      <tr onclick="window.analyticsModule?.openOrder('${safeId}')">
        <td class="an2-col-date">${fmtDate(o.date)}</td>
        <td>
          <div class="an2-order-id-cell">
            <span class="an2-order-id-text">${safeId}</span>
            <button class="an2-copy-btn" title="Скопировать № заказа"
              onclick="event.stopPropagation();navigator.clipboard.writeText('${safeId}').then(()=>{this.innerHTML='<svg width=10 height=10 viewBox=&quot;0 0 10 10&quot;><polyline points=&quot;1.5,5.5 3.5,7.5 8.5,2.5&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.5&quot; fill=&quot;none&quot; stroke-linecap=&quot;round&quot;/></svg>';this.style.color='var(--green)';setTimeout(()=>{this.innerHTML='<svg width=10 height=10 viewBox=&quot;0 0 10 10&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.2&quot;><rect x=&quot;3&quot; y=&quot;1&quot; width=&quot;6&quot; height=&quot;7&quot; rx=&quot;1&quot;/><path d=&quot;M1 3h2v6h5v1&quot;/></svg>';this.style.color='';},1400)})">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="3" y="1" width="6" height="7" rx="1"/><path d="M1 3h2v6h5v1"/>
              </svg>
            </button>
          </div>
        </td>
        <td><span class="mp-badge"><span class="mp-dot" style="background:${MP_COLOR[o.mp]}"></span>${MP_SHORT[o.mp]}</span></td>
        <td>
          <span class="an2-status-pill" style="background:${STATUS_COLOR[o.status]}1a;color:${STATUS_COLOR[o.status]}">
            <span class="dot" style="background:${STATUS_COLOR[o.status]}"></span>${STATUS_LABEL[o.status]}
          </span>
        </td>
        <td class="an2-col-goods">
          <span class="an2-src ${o.source}" title="${o.source === 'real' ? 'финотчёт' : o.source === 'estimated' ? 'расчёт' : 'нет данных'}"></span>${goods}
        </td>
        <td class="num${pendingCls}"${pendingTitle}>${o.revenue > 0 ? fmtMoney(o.revenue) : '—'}${pending ? ' <span class="an2-pending-badge">пока не финал</span>' : ''}</td>
        <td class="num neg${pendingCls}">${expensesMp > 0 ? fmtMoney(expensesMp) : '—'}</td>
        <td class="num${pendingCls}">${o.cogs > 0 ? fmtMoney(o.cogs) : '—'}</td>
        <td class="num${pendingCls} ${!pending && o.net_profit >= 0 ? 'pos' : !pending ? 'neg' : ''}">${o.net_profit !== 0 ? fmtMoney(o.net_profit) : '—'}</td>
      </tr>`);
  }

  // Progressive render: first INITIAL_ROWS immediately, rest in background
  const qid = ++_queueId;
  const immediate = rowsArr.slice(0, INITIAL_ROWS).join('');
  const deferred  = rowsArr.slice(INITIAL_ROWS).join('');

  if (deferred) {
    setTimeout(() => {
      if (_queueId !== qid) return; // stale — newer render happened
      const tbody = document.getElementById('an2-orders-tbody');
      if (tbody) tbody.insertAdjacentHTML('beforeend', deferred);
    }, 0);
  }

  return `
    <div class="an2-card" style="padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input class="an2-search" type="search" placeholder="Поиск по № заказа или артикулу…"
          value="${escapeHtml(f.search)}"
          oninput="window.analyticsModule?.setOrdersFilter('search', this.value)"
          style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:7px 12px;color:var(--text);font-size:12px;outline:none;font-family:inherit"/>

        <select onchange="window.analyticsModule?.setOrdersFilter('status', this.value)"
          style="background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:7px 10px;color:var(--text);font-size:12px;font-family:inherit;outline:none">
          ${statusOpts.map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>

        <select onchange="window.analyticsModule?.setOrdersFilter('mp', this.value)"
          style="background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:7px 10px;color:var(--text);font-size:12px;font-family:inherit;outline:none">
          <option value="all"    ${f.mp === 'all'    ? 'selected' : ''}>Все МП</option>
          <option value="ozon"   ${f.mp === 'ozon'   ? 'selected' : ''}>Ozon</option>
          <option value="wb"     ${f.mp === 'wb'     ? 'selected' : ''}>Wildberries</option>
          <option value="yandex" ${f.mp === 'yandex' ? 'selected' : ''}>Яндекс.Маркет</option>
        </select>

        <div style="font-size:11px;color:var(--text3);margin-left:auto">${fmtNum(total)} заказов</div>
      </div>
    </div>

    <div class="an2-card" style="padding:0;overflow:hidden">
      ${filtered.length === 0 ? `
        <div class="an2-empty">
          <div class="emoji">${I.search('',24)}</div>
          <h3>Ничего не найдено</h3>
          <p>Попробуй изменить фильтр или период.</p>
        </div>
      ` : `
        <div style="overflow-x:auto">
          <table class="an2-table">
            <thead><tr>
              <th style="width:70px">Дата</th>
              <th>№ заказа</th>
              <th>МП</th>
              <th>Статус</th>
              <th>Товары</th>
              <th class="num">Выручка</th>
              <th class="num">Расходы МП</th>
              <th class="num">COGS</th>
              <th class="num">Прибыль</th>
            </tr></thead>
            <tbody id="an2-orders-tbody">${immediate}</tbody>
          </table>
        </div>
      `}
    </div>`;
}
