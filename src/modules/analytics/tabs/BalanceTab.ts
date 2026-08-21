/**
 * BalanceTab — дашборд балансов магазинов по Ozon и WB.
 * Яндекс Маркет не предоставляет API для текущего баланса кошелька.
 */

import { MP_COLOR } from '../types';
import { fmtMoney } from '../components/format';

export interface StoreBalance {
  storeId: string;
  storeName: string;
  mp: 'ozon' | 'wb' | 'yandex';
  loading: boolean;
  error: string | null;
  // Ozon fields
  balance?: number;
  lock?: number;
  reward?: number;
  // WB fields
  forPay?: number;
  dateFrom?: string;
  dateTo?: string;
}

const MP_LABEL: Record<string, string> = { ozon: 'Ozon', wb: 'WB', yandex: 'ЯМ' };

function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function card(b: StoreBalance): string {
  const color = MP_COLOR[b.mp] ?? '#888';
  const label = MP_LABEL[b.mp] ?? b.mp;

  if (b.loading) {
    return `
      <div class="bl-card">
        <div class="bl-card-head">
          <span class="bl-badge" style="background:${color}20;color:${color}">${label}</span>
          <span class="bl-store-name">${esc(b.storeName)}</span>
        </div>
        <div class="bl-loading">
          <div class="bl-spinner"></div>
          <span>Загружаем…</span>
        </div>
      </div>`;
  }

  if (b.error) {
    const isApiUnavailable = b.error.includes('не предоставляет API') || b.error.includes('404');
    const friendlyMsg = isApiUnavailable
      ? 'Баланс недоступен через API — откройте кабинет продавца'
      : b.error;
    const ozonCabinetUrl = b.mp === 'ozon' ? 'https://seller.ozon.ru/app/finance/wallet' : null;
    return `
      <div class="bl-card bl-card--warn">
        <div class="bl-card-head">
          <span class="bl-badge" style="background:${color}20;color:${color}">${label}</span>
          <span class="bl-store-name">${esc(b.storeName)}</span>
        </div>
        <div class="bl-error-msg">${esc(friendlyMsg)}</div>
        ${ozonCabinetUrl && isApiUnavailable ? `<a class="bl-cabinet-link" href="${ozonCabinetUrl}" target="_blank" rel="noopener">Открыть кошелёк Ozon →</a>` : ''}
      </div>`;
  }

  if (b.mp === 'ozon') {
    const total = (b.balance ?? 0) + (b.reward ?? 0);
    return `
      <div class="bl-card">
        <div class="bl-card-head">
          <span class="bl-badge" style="background:${color}20;color:${color}">${label}</span>
          <span class="bl-store-name">${esc(b.storeName)}</span>
          <span class="bl-live-dot" title="Актуальные данные"></span>
        </div>
        <div class="bl-main-value">${fmtMoney(total)}</div>
        <div class="bl-main-label">Итого в кошельке</div>
        <div class="bl-rows">
          <div class="bl-row">
            <span class="bl-row-label">Баланс</span>
            <span class="bl-row-value">${fmtMoney(b.balance ?? 0)}</span>
          </div>
          <div class="bl-row">
            <span class="bl-row-label">Начислено (не выплачено)</span>
            <span class="bl-row-value">${fmtMoney(b.reward ?? 0)}</span>
          </div>
          ${(b.lock ?? 0) > 0 ? `
          <div class="bl-row bl-row--muted">
            <span class="bl-row-label">Заблокировано</span>
            <span class="bl-row-value">${fmtMoney(b.lock ?? 0)}</span>
          </div>` : ''}
        </div>
      </div>`;
  }

  if (b.mp === 'wb') {
    return `
      <div class="bl-card">
        <div class="bl-card-head">
          <span class="bl-badge" style="background:${color}20;color:${color}">${label}</span>
          <span class="bl-store-name">${esc(b.storeName)}</span>
        </div>
        <div class="bl-main-value">${fmtMoney(b.forPay ?? 0)}</div>
        <div class="bl-main-label">К выплате за текущую неделю</div>
        <div class="bl-period-note">
          ${b.dateFrom && b.dateTo ? `${fmtDate(b.dateFrom)} — ${fmtDate(b.dateTo)}` : ''}
        </div>
        <div class="bl-wb-note">
          WB выплачивает еженедельно по четвергам. Показана сумма начислений
          (ppvz_for_pay) с начала текущей отчётной недели — не баланс кошелька.
        </div>
      </div>`;
  }

  return '';
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderBalanceTab(balances: StoreBalance[]): string {
  const ozBalances = balances.filter(b => b.mp === 'ozon');
  const wbBalances = balances.filter(b => b.mp === 'wb');
  const anyLoading = balances.some(b => b.loading);

  const section = (title: string, items: StoreBalance[]) => items.length === 0 ? '' : `
    <div class="bl-section">
      <div class="bl-section-title">${title}</div>
      <div class="bl-grid">
        ${items.map(card).join('')}
      </div>
    </div>`;

  return `
    <div class="bl-wrap">
      <div class="bl-toolbar">
        <span style="font-size:13px;font-weight:700;color:var(--text)">Баланс магазинов</span>
        <span style="font-size:10.5px;color:var(--text3);margin-left:10px">
          Текущее состояние счёта из API площадки — не зависит от выбранного периода,
          маркетплейса и магазина в шапке. Яндекс.Маркет баланс кошелька не отдаёт.
        </span>
        <button onclick="window.analyticsModule?.refreshBalances()" ${anyLoading ? 'disabled' : ''}
          style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;opacity:${anyLoading ? '.5' : '1'}">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:12px;height:12px${anyLoading ? ';animation:an2-spin .8s linear infinite' : ''}"><path d="M14 8A6 6 0 1 1 8.5 2.1M14 2v4h-4"/></svg>
          ${anyLoading ? 'Загружаем…' : 'Обновить'}
        </button>
      </div>
      ${section('Ozon', ozBalances)}
      ${section('Wildberries', wbBalances)}

      <div class="bl-ym-notice">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:14px;height:14px;flex-shrink:0;margin-top:1px">
          <circle cx="8" cy="8" r="6"/><path d="M8 5v4M8 11v.5"/>
        </svg>
        <div>
          <b>Яндекс Маркет</b> — API не предоставляет доступ к текущему балансу кошелька.
          Посмотреть баланс можно только в личном кабинете partner.market.yandex.ru.
        </div>
      </div>
    </div>`;
}
