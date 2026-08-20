import { Order, MP_LABEL, STATUS_LABEL, STATUS_COLOR } from '../types';
import { fmtMoney, fmtDateTime, fmtNum, escapeHtml } from './format';
import { copyButton } from '@/utils/copyButton';

export function renderOrderDrawer(o: Order, onClose = 'window.analyticsModule?.closeOrderDrawer()'): string {
  const sourceLabel = o.source === 'real'
    ? 'Финотчёт МП'
    : o.fees_estimated
    ? 'Оценка по средним ставкам периода — финотчёт ещё не пришёл'
    : o.source === 'estimated'
    ? 'Расчёт по формуле (финотчёт ожидается)'
    : 'Нет данных';
  // У возврата/отмены выручка заказа обнулена, но позиции сохраняют исходную цену —
  // помечаем её зачёркиванием, чтобы сумма позиций не спорила с итогом.
  const revenueVoid = o.status === 'returned' || o.status === 'cancelled';

  const mpUrl = o.mp === 'ozon'
    ? `https://seller.ozon.ru/app/postings/${o.order_id}`
    : o.mp === 'wb'
    ? `https://seller.wildberries.ru/`
    : `https://partner.market.yandex.ru/`;

  return `
    <div class="an2-drawer-backdrop" onclick="${onClose}"></div>
    <div class="an2-drawer" onclick="event.stopPropagation()">
      <div class="an2-drawer-head">
        <div class="an2-drawer-title">
          <div class="id" style="display:flex;align-items:center;gap:4px">№ ${escapeHtml(o.order_id)}${copyButton(o.order_id, 'Копировать номер заказа')}</div>
          <div class="sub">
            <span class="an2-status-pill" style="background:${STATUS_COLOR[o.status]}22;color:${STATUS_COLOR[o.status]}">
              <span class="dot" style="background:${STATUS_COLOR[o.status]}"></span>${STATUS_LABEL[o.status]}
            </span>
            <span style="margin-left:8px;display:inline-flex;align-items:center;gap:4px">${MP_LABEL[o.mp]} · ${escapeHtml(o.store_name)}${copyButton(o.store_name, 'Копировать название магазина')}</span>
            <span style="margin-left:8px;color:var(--text3)">${fmtDateTime(o.date)}</span>
          </div>
        </div>
        <button class="an2-drawer-close" onclick="${onClose}" aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </div>

      <div class="an2-drawer-body">

        <!-- Источник данных -->
        <div class="an2-drawer-section">
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;font-size:11px">
            <span class="an2-src ${o.source}"></span>
            <strong style="color:var(--text)">${sourceLabel}</strong>
            <span style="color:var(--text3);margin-left:auto">${o.tx_ids.length} транзакц.</span>
          </div>
        </div>

        ${o.status === 'returned' ? `
          <!-- Объяснение возврата -->
          <div class="an2-drawer-section">
            <div style="padding:10px 12px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:10px;font-size:11px;line-height:1.55;color:var(--text2)">
              <div style="display:flex;gap:8px;align-items:flex-start">
                <span style="font-size:14px;color:#ef4444;flex-shrink:0;line-height:1">↩</span>
                <div>
                  <strong style="color:var(--text)">Из чего складывается убыток по возврату</strong>
                  <div style="margin-top:5px">
                    При возврате выручка обнуляется. Часть удержаний МП <strong style="color:var(--text)">возвращается</strong> продавцу (корректировка комиссии, +возврат), часть — <strong style="color:var(--text)">остаётся</strong> у МП:
                  </div>
                  <ul style="margin:5px 0 0;padding-left:18px;color:var(--text3)">
                    <li><strong style="color:var(--text2)">Комиссия:</strong> МП обычно возвращает её частично, оставляя себе ~5–15% (зависит от категории).</li>
                    <li><strong style="color:var(--text2)">Логистика «туда»</strong> + <strong style="color:var(--text2)">обратная доставка</strong> — оплачивает продавец.</li>
                    <li>Доп.услуги (последняя миля, обработка возврата, эквайринг) — обычно тоже на продавце.</li>
                  </ul>
                  <div style="margin-top:6px;color:var(--text3)">
                    Аналитика суммирует все транзакции по этому posting'у со знаком: удержания (−) и компенсации (+) складываются → итог = чистый расход. Себестоимость зачтена в 0 — товар вернулся на склад.
                  </div>
                </div>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Позиции -->
        <div class="an2-drawer-section">
          <h4>Что в заказе (${o.items.length} поз.)</h4>
          ${o.items.map(it => `
            <div class="an2-drawer-item">
              ${it.image
                ? `<img class="an2-drawer-item-img" src="${escapeHtml(it.image)}" loading="lazy" onerror="this.style.display='none'"/>`
                : `<div class="an2-drawer-item-img"></div>`}
              <div class="an2-drawer-item-info">
                <div class="name" style="display:flex;align-items:flex-start;gap:4px">${escapeHtml(it.name)}${copyButton(it.name, 'Копировать название')}</div>
                <div class="meta">арт. <span style="display:inline-flex;align-items:center;gap:2px">${escapeHtml(it.vendor_code)}${copyButton(it.vendor_code, 'Копировать артикул')}</span> · ${fmtNum(it.quantity)} × ${fmtMoney(it.price)}</div>
                <div class="meta">
                  ${it.cost_price != null
                    ? `<span style="color:var(--text2)">себес. ${fmtMoney(it.cost_price)}${o.status === 'returned' ? ' <span style="color:var(--text3)">· товар вернулся, COGS зачтён в 0</span>' : ` = COGS ${fmtMoney(it.cogs)}`}</span>`
                    : `<span style="color:var(--red)">⚠ себестоимость не задана</span>`}
                </div>
              </div>
              <div class="an2-drawer-item-num">
                <div class="price"${revenueVoid ? ' style="text-decoration:line-through;color:var(--text3)" title="выручка не засчитана: заказ вернулся или отменён"' : ''}>${fmtMoney(it.revenue)}</div>
                <div class="profit ${it.net_profit >= 0 ? 'pos' : 'neg'}">${fmtMoney(it.net_profit)}</div>
              </div>
            </div>
          `).join('')}
        </div>

        <!-- Удержания МП с разбивкой -->
        <div class="an2-drawer-section">
          <h4>Удержания маркетплейса${o.status === 'returned' ? ' <span style="font-weight:400;color:var(--text3);font-size:10px;text-transform:none;letter-spacing:0">(не возвращаются продавцу)</span>' : ''}</h4>
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:4px 12px">
            ${o.fee_breakdown.length > 0
              ? o.fee_breakdown.map(f => {
                  // Положительный amount = удержание у продавца, отрицательный = компенсация
                  const isComp = f.amount < 0;
                  const abs = Math.abs(f.amount);
                  return `
                  <div class="an2-fee-row">
                    <span class="label">${escapeHtml(f.label)}${isComp ? ' <span style="color:var(--text3);font-size:9px">(возврат)</span>' : ''}</span>
                    <span class="amount" style="${isComp ? 'color:var(--green)' : ''}">${isComp ? '+' : '−'}${fmtMoney(abs, false)} ₽</span>
                  </div>`;
                }).join('')
              : `<div style="padding:12px 0;font-size:11px;color:var(--text3);text-align:center">
                  ${o.source === 'real' ? 'удержаний нет' : 'данные финотчёта ещё не пришли'}
                </div>`}
          </div>
        </div>

        <!-- Итог по заказу -->
        <div class="an2-drawer-section">
          <h4>Итог</h4>
          <div class="an2-fee-row income">
            <span class="label">Выручка</span>
            <span class="amount">+${fmtMoney(o.revenue, false)} ₽</span>
          </div>
          <div class="an2-fee-row">
            <span class="label">Расходы МП</span>
            <span class="amount">−${fmtMoney(o.commission + o.logistics + o.logistics_return + o.services, false)} ₽</span>
          </div>
          <div class="an2-fee-row">
            <span class="label">Себестоимость</span>
            <span class="amount">−${fmtMoney(o.cogs, false)} ₽</span>
          </div>
          <div class="an2-fee-row">
            <span class="label">Налог</span>
            <span class="amount">−${fmtMoney(o.tax, false)} ₽</span>
          </div>
          <div class="an2-fee-row total" style="color:${o.net_profit >= 0 ? 'var(--green)' : 'var(--red)'}">
            <span class="label">Чистая прибыль</span>
            <span class="amount" style="color:${o.net_profit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(o.net_profit)}</span>
          </div>
          ${o.payout_actual > 0 ? `
            <div class="an2-fee-row" style="margin-top:8px">
              <span class="label" style="color:var(--text3)">Фактически выплачено</span>
              <span class="amount" style="color:var(--text2)">${fmtMoney(o.payout_actual)}</span>
            </div>
          ` : ''}
        </div>

        <!-- Ссылки + диагностика -->
        <div class="an2-drawer-section" style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="${mpUrl}" target="_blank" rel="noopener" class="an2-btn ghost" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">
            Открыть в кабинете ${MP_LABEL[o.mp]}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M7 7h10v10"/></svg>
          </a>
          ${o.tx_ids.length > 0 ? `
            <button class="an2-btn ghost" onclick="window.analyticsModule?.showOrderTxJson('${escapeHtml(o.order_id)}')"
              style="display:inline-flex;align-items:center;gap:6px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              JSON транзакций (${o.tx_ids.length})
            </button>
          ` : ''}
        </div>

      </div>
    </div>
  `;
}
