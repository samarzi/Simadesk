import { ozonApi } from '@/services/ozonApi';
import { wbApi, fetchWbReturns, fetchWbSalesAnalytics } from '@/services/wbApi';
import {
  getYandexSupplyRequests,
  getYandexSupplyRequestItems,
  getYandexSupplyRequestDocuments,
  getYandexSkuStats,
  getYandexReturns,
} from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'ozon' | 'wb' | 'yandex';
type DetailTab = 'overview' | 'items' | 'returns';

export interface Supply {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  itemsCount: number;
  /** Ozon: грузоместа, из которых читается состав через /v1/supply-order/bundle */
  bundleIds?: string[];
  warehouseName?: string;
  canCancel?: boolean;
  timeslotFrom?: string;
  timeslotTo?: string;
}

interface RecoItem {
  name: string;
  sku: string;     // offer_id for Ozon, nmId for WB, offerId for YM
  stock: number;
  dailySales: number;
  daysLeft: number;
  mp: string;
  recoQty: number; // recommended order quantity (editable by user)
}

type StatusGroup = 'draft' | 'sending' | 'delivered' | 'cancelled';

const STATUS: Record<string, { text: string; color: string; group: StatusGroup }> = {
  // ── WB FBS ────────────────────────────────────────────────────────────────
  draft:                        { text: 'Черновик',        color: '#6b7280', group: 'draft' },
  sent:                         { text: 'В доставке',      color: '#3b82f6', group: 'sending' },
  done:                         { text: 'Принята WB',      color: '#10b981', group: 'delivered' },
  // ── Ozon FBO (v2 supply-order state) ──────────────────────────────────────
  DATA_FILLING:                 { text: 'Заполняется',     color: '#6b7280', group: 'draft' },
  READY_TO_SUPPLY:              { text: 'Готова к сдаче',  color: '#f59e0b', group: 'draft' },
  ACCEPTANCE_AT_STORAGE_WAREHOUSE: { text: 'Приёмка',      color: '#3b82f6', group: 'sending' },
  IN_TRANSIT:                   { text: 'В пути',          color: '#3b82f6', group: 'sending' },
  ARBITRATION:                  { text: 'Спор',            color: '#f97316', group: 'sending' },
  REPORTS_CONFIRMATION_AWAITING:{ text: 'Ждёт отчёта',     color: '#f59e0b', group: 'sending' },
  COMPLETED:                    { text: 'Завершена',       color: '#10b981', group: 'delivered' },
  CANCELLED:                    { text: 'Отменена',        color: '#ef4444', group: 'cancelled' },
  // ── Яндекс FBY (supply-request status) ────────────────────────────────────
  CREATED:                      { text: 'Создана',         color: '#6b7280', group: 'draft' },
  TRANSFER_TO_WAREHOUSE:        { text: 'Везём на склад',  color: '#3b82f6', group: 'sending' },
  ACCEPTED:                     { text: 'Принята',         color: '#10b981', group: 'delivered' },
  FINISHED:                     { text: 'Завершена',       color: '#10b981', group: 'delivered' },
  CANCELLED_BY_PARTNER:         { text: 'Отменена',        color: '#ef4444', group: 'cancelled' },
};

/** Ozon/ЯМ иногда присылают статусы, которых нет в справочнике — раскрашиваем по ключевым словам. */
function statusInfo(s: string): { text: string; color: string; group: StatusGroup } {
  const known = STATUS[s];
  if (known) return known;
  const u = (s ?? '').toUpperCase();
  if (u.includes('CANCEL'))                       return { text: 'Отменена',  color: '#ef4444', group: 'cancelled' };
  if (u.includes('COMPLET') || u.includes('ACCEPT') || u.includes('FINISH'))
    return { text: 'Завершена', color: '#10b981', group: 'delivered' };
  if (u.includes('TRANSIT') || u.includes('TRANSFER') || u.includes('ACCEPTANCE'))
    return { text: 'В пути',    color: '#3b82f6', group: 'sending' };
  if (u.includes('DRAFT') || u.includes('FILLING') || u.includes('CREATED'))
    return { text: 'Черновик',  color: '#6b7280', group: 'draft' };
  return { text: s || '—', color: '#6b7280', group: 'draft' };
}

function chip(s: string): string {
  const st = statusInfo(s);
  return `<span class="sp-chip" style="--c:${st.color}">${st.text}</span>`;
}

/** Коды причин/статусов возвратов — в интерфейсе они должны быть по-русски. */
const RETURN_REASON: Record<string, string> = {
  STARTED_BY_USER:    'Инициирован покупателем',
  REFUND_IN_PROGRESS: 'Возврат денег в процессе',
  REFUNDED:           'Деньги возвращены',
  FAILED:             'Возврат не удался',
  REJECTED:           'Отклонён',
  DECISION_MADE:      'Решение принято',
  WAITING_FOR_DECISION: 'Ждёт решения',
  RETURN:             'Возврат',
  UNREDEEMED:         'Невыкуп',
};
function returnReason(code: string): string {
  if (!code || code === '—') return '—';
  return RETURN_REASON[code] ?? code;
}

/**
 * Ошибки МП прилетают как «Yandex ... 403: {"errors":[...]}» — нечитаемо.
 * Переводим код в понятную причину и оставляем техничную часть отдельно.
 */
function humanApiError(raw: string): { title: string; detail: string } {
  const code = raw.match(/\b(400|401|403|404|405|409|429|5\d\d)\b/)?.[1] ?? '';
  const byCode: Record<string, string> = {
    '400': 'Маркетплейс не принял запрос — вероятно, изменился формат его API.',
    '401': 'Ключ доступа не принят. Проверьте API-ключ магазина в настройках.',
    '403': 'У API-ключа нет прав на этот раздел. Выдайте ключу доступ к поставкам в кабинете маркетплейса.',
    '404': 'Метод или объект не найден — данных по этой поставке у маркетплейса нет.',
    '405': 'Метод вызван неверно — это ошибка интеграции, а не ваших настроек.',
    '409': 'Маркетплейс отклонил операцию из-за текущего статуса поставки.',
    '429': 'Слишком много запросов к API. Подождите минуту и повторите.',
  };
  const title = byCode[code] ?? (code.startsWith('5')
    ? 'Маркетплейс временно недоступен. Попробуйте через несколько минут.'
    : 'Не удалось получить данные от маркетплейса.');
  return { title, detail: raw };
}

/** Типы документов Яндекса приходят кодами — показываем человеческие названия. */
const YM_DOC_TYPE: Record<string, string> = {
  SUPPLY:            'Акт приёма-передачи',
  ADDITIONAL_SUPPLY: 'Дополнительная поставка',
  TRANSFER:          'Транспортная накладная',
  WITHDRAW:          'Заявка на вывоз',
  ACT_OF_WITHDRAW:   'Акт вывоза',
  VALIDATION_ERRORS: 'Ошибки проверки',
  UTILIZATION:       'Акт утилизации',
};

function urgencyBadge(daysLeft: number): string {
  if (daysLeft <= 0)  return `<span class="sp-badge sp-badge-red">OOS</span>`;
  if (daysLeft <= 7)  return `<span class="sp-badge sp-badge-red">${daysLeft}д</span>`;
  if (daysLeft <= 14) return `<span class="sp-badge sp-badge-orange">${daysLeft}д</span>`;
  if (daysLeft <= 30) return `<span class="sp-badge sp-badge-yellow">${daysLeft}д</span>`;
  return `<span class="sp-badge sp-badge-green">${daysLeft}д</span>`;
}

function stockBar(daysLeft: number): string {
  const pct = Math.min(100, Math.max(0, (daysLeft / 60) * 100));
  const color = daysLeft <= 7 ? '#ef4444' : daysLeft <= 14 ? '#f97316' : daysLeft <= 30 ? '#eab308' : '#10b981';
  return `<div style="height:4px;border-radius:2px;background:var(--bg3);overflow:hidden;margin-top:4px">
    <div style="height:100%;width:${pct}%;background:${color};transition:width .4s ease"></div>
  </div>`;
}

export class SupplyManagementModule {
  private el: HTMLElement;
  private tab: Tab = 'ozon';
  private detailTab: DetailTab = 'overview';
  private storeId = '';
  private stores: Array<Record<string, any>> = [];
  private supplies: Supply[] = [];
  private loading = false;
  private error = '';                 // inline error shown in list area
  private detail: Supply | null = null;
  private detailItems: Array<{ name: string; qty: number; sku?: string }> = [];
  private detailReturns: Array<{ name: string; qty: number; reason?: string; date?: string }> = [];
  private detailItemsLoading = false;
  private detailItemsUnavailable = false;
  private detailItemsError = '';
  private detailReturnsLoading = false;
  private detailReturnsError = '';
  private recoItems: RecoItem[] = [];
  private recoLoading = false;
  private showReco = false;
  private searchQuery = '';
  private statusFilter = '';
  private busy = false;               // global action in progress
  private connectedMps: Set<Tab> = new Set<Tab>();

  supplyStats = { draft: 0, sending: 0, delivered: 0, cancelled: 0 };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden';
    this.injectStyles();
    this.buildShell();
    this.init();
  }

  // ── Shell ────────────────────────────────────────────────────────────────────

  private buildShell(): void {
    this.el.innerHTML = `
      <div class="sp-root">
        <div class="sp-header">
          <div class="sp-header-left">
            <div class="sp-logo-icon">${I.truck()}</div>
            <span class="sp-logo-text">Поставки</span>
            <div class="sp-tabs" id="sp-tabs">
              ${this.renderTabs()}
            </div>
          </div>
          <div class="sp-header-right" id="sp-actions">
            ${this.renderHeaderActions()}
          </div>
        </div>
        <div id="sp-kpi"></div>
        <div class="sp-content" id="sp-content">
          ${this.renderContent()}
        </div>
      </div>`;
    this.bindAll();
  }

  private renderHeaderActions(): string {
    const wizBtn = this.tab === 'wb'
      ? `<button class="sp-btn sp-btn-purple" id="sp-wizard">${I.truck()} Из заказов</button>`
      : '';
    // Пополнение строится на составе поставки — это умеет только Ozon FBO.
    const recoBtn = this.tab === 'ozon'
      ? `<button class="sp-btn ${this.showReco ? 'sp-btn-active' : 'sp-btn-ghost'}" id="sp-reco">
          ${I.info()} Пополнение</button>`
      : '';
    // У Яндекса API не умеет создавать заявки — кнопка объясняет это, а не притворяется рабочей.
    const createBtn = this.tab === 'yandex'
      ? `<button class="sp-btn sp-btn-ghost" id="sp-create" title="Заявку FBY можно создать только в кабинете Маркета">
          ${I.info()} Как создать</button>`
      : `<button class="sp-btn sp-btn-primary" id="sp-create" ${this.busy ? 'disabled' : ''}>${I.plus()} Создать</button>`;
    return `
      <select id="sp-store" class="sp-select">
        <option value="">Загрузка...</option>
      </select>
      ${wizBtn}
      ${createBtn}
      ${recoBtn}
      <button class="sp-btn sp-btn-ghost" id="sp-refresh" title="Обновить">${I.refresh()}</button>
      <button class="sp-btn sp-btn-ghost sp-help-btn" id="sp-help" title="Как работают поставки">?</button>`;
  }

  private renderContent(): string {
    if (this.detail) return this.renderDetail();
    return this.renderListWithReco();
  }

  private renderListWithReco(): string {
    return `<div class="sp-body-wrap">
      <div class="sp-list-pane" id="sp-list-pane">
        ${this.renderFilterBar()}
        ${this.renderList()}
      </div>
      ${this.showReco ? `<div class="sp-reco-pane" id="sp-reco-pane">${this.renderReco()}</div>` : ''}
    </div>`;
  }

  private renderFilterBar(): string {
    if ((!this.supplies.length && !this.loading && !this.error) || !this.storeId) return '';
    return `<div class="sp-filter-bar">
      <input id="sp-search" class="sp-search" placeholder="Поиск по названию или ID…" value="${esc(this.searchQuery)}">
      <select id="sp-status-filter" class="sp-select" style="min-width:130px">
        ${[['','Все статусы'],['draft','Черновик'],['sending','В пути'],['delivered','Принято'],['cancelled','Отменено']]
          .map(([v,l]) => `<option value="${v}" ${this.statusFilter===v?'selected':''}>${l}</option>`).join('')}
      </select>
      ${(this.searchQuery || this.statusFilter) ? `<button class="sp-btn sp-btn-ghost" id="sp-clear-filter" style="padding:4px 8px">✕</button>` : ''}
    </div>`;
  }

  // ── KPI ─────────────────────────────────────────────────────────────────────

  private renderKpi(): string {
    const s = this.supplyStats;
    const total = s.draft + s.sending + s.delivered + s.cancelled;
    if (!total && !this.loading) return '';
    const tiles = [
      { label: 'Всего',    val: total,       color: '#6366f1' },
      { label: 'Черновик', val: s.draft,     color: '#6b7280' },
      { label: 'В пути',   val: s.sending,   color: '#3b82f6' },
      { label: 'Принято',  val: s.delivered, color: '#10b981' },
      { label: 'Отменено', val: s.cancelled, color: '#ef4444' },
    ].filter(t => t.val > 0 || t.label === 'Всего');
    return `<div class="sp-kpi-bar">
      ${tiles.map(({ label, val, color }) => `
        <div class="sp-kpi-tile">
          <div class="sp-kpi-label">${label}</div>
          <div class="sp-kpi-val" style="color:${color}">${val}</div>
        </div>`).join('')}
    </div>`;
  }

  // ── List ────────────────────────────────────────────────────────────────────

  private renderList(): string {
    if (!this.storeId && !this.loading) {
      return `<div class="sp-empty">
        <div class="sp-empty-icon">${I.truck()}</div>
        <p>Выберите магазин для загрузки поставок</p>
        <button class="sp-btn sp-btn-ghost" id="sp-help-no-store" style="margin-top:8px">? Как это работает</button>
      </div>`;
    }
    if (this.loading) return this.renderSkeleton();
    if (this.error) {
      return `<div class="sp-error-block">
        <div class="sp-error-icon">⚠️</div>
        <div class="sp-error-text">${esc(this.error)}</div>
        <div class="sp-error-actions">
          <button class="sp-btn sp-btn-primary" id="sp-refresh">Попробовать снова</button>
          <button class="sp-btn sp-btn-ghost" id="sp-help-error">? Инструкция</button>
        </div>
      </div>`;
    }
    if (!this.supplies.length) {
      return `<div class="sp-empty">
        <div class="sp-empty-icon">${I.truck()}</div>
        <p>${this.emptyText()}</p>
        <div class="sp-empty-actions">
          ${this.tab === 'yandex'
            ? `<button class="sp-btn sp-btn-primary" id="sp-create-empty">${I.info()} Как создать заявку</button>`
            : `<button class="sp-btn sp-btn-primary" id="sp-create-empty">${I.plus()} Создать поставку</button>`}
          ${this.tab === 'wb' ? `<button class="sp-btn sp-btn-purple" id="sp-wizard-empty">${I.truck()} Из заказов</button>` : ''}
          <button class="sp-btn sp-btn-ghost" id="sp-help-empty">? Как это работает</button>
        </div>
      </div>`;
    }
    const filtered = this.filteredSupplies();
    if (!filtered.length) {
      return `<div class="sp-empty" style="height:120px">
        <p style="font-size:13px">Нет поставок под этот фильтр</p>
        <button class="sp-btn sp-btn-ghost" id="sp-clear-filter" style="margin-top:6px">Сбросить</button>
      </div>`;
    }
    return `<div class="sp-supply-list">${filtered.map(s => this.renderSupplyRow(s)).join('')}</div>`;
  }

  private emptyText(): string {
    if (this.tab === 'ozon') return 'Заявок на поставку Ozon FBO нет.';
    if (this.tab === 'wb') return 'Поставок WB нет. Соберите поставку из новых заказов.';
    return 'Заявок на поставку FBY нет. Они создаются в кабинете Маркета и появятся здесь автоматически.';
  }

  private filteredSupplies(): Supply[] {
    const q = this.searchQuery.toLowerCase().trim();
    return this.supplies.filter(s => {
      if (this.statusFilter && statusInfo(s.status).group !== this.statusFilter) return false;
      if (q && !s.name.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  private renderSupplyRow(s: Supply): string {
    const st = statusInfo(s.status);
    const date = new Date(s.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    // Склад и окно приёмки — полезнее в строке, чем голая дата создания
    const meta: string[] = [`<code class="sp-supply-id">${esc(s.id)}</code>`, `<span>${date}</span>`];
    if (s.warehouseName) meta.push(`<span>${esc(s.warehouseName)}</span>`);
    if (s.timeslotFrom) {
      meta.push(`<span>приёмка ${new Date(s.timeslotFrom).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>`);
    }
    // Список Ozon v2 не отдаёт количество позиций — не показываем ложный «0 тов.»
    const count = s.itemsCount > 0
      ? `<div class="sp-supply-items-count">
           <span style="font-weight:700;color:var(--text)">${s.itemsCount}</span>
           <span style="font-size:11px;color:var(--text2)"> тов.</span>
         </div>`
      : '';
    // «Быстро передать в доставку» есть только у WB — у Ozon/ЯМ такого метода нет
    const quickSend = this.tab === 'wb' && st.group === 'draft'
      ? `<button class="sp-btn-icon" title="Передать в доставку" data-action="quick-send" data-id="${esc(s.id)}">${I.send()}</button>`
      : '';
    return `<div class="sp-supply-row" data-action="open" data-id="${esc(s.id)}">
      <div class="sp-supply-row-left">
        <div class="sp-supply-status-dot" style="background:${st.color}"></div>
        <div class="sp-supply-info">
          <div class="sp-supply-name">${esc(s.name)}</div>
          <div class="sp-supply-meta">${meta.join('<span>·</span>')}</div>
        </div>
      </div>
      <div class="sp-supply-row-right">
        ${chip(s.status)}
        ${count}
        ${quickSend}
        <div class="sp-chevron">›</div>
      </div>
    </div>`;
  }

  private renderSkeleton(): string {
    return `<div class="sp-supply-list">
      ${Array(5).fill(`<div class="sp-skeleton-row"><div class="sp-skeleton"></div></div>`).join('')}
    </div>`;
  }

  // ── Recommendations ─────────────────────────────────────────────────────────

  private renderReco(): string {
    const hasItems = this.recoItems.length > 0;
    const isOzon = this.tab === 'ozon';
    const totalQty = this.recoItems.reduce((s, r) => s + r.recoQty, 0);

    return `<div class="sp-reco">
      <div class="sp-reco-header">
        <span style="font-weight:700;font-size:13px">Рекомендации пополнения</span>
        <div style="display:flex;gap:6px;align-items:center">
          ${isOzon && hasItems ? `
            <button class="sp-btn sp-btn-primary" id="sp-reco-create" style="padding:4px 12px;font-size:12px" ${this.busy ? 'disabled' : ''}>
              ${I.plus()} Создать поставку (${totalQty} шт.)
            </button>` : ''}
          <button class="sp-btn sp-btn-ghost" id="sp-reco-load" style="padding:3px 8px;font-size:11px">
            ${this.recoLoading ? `${I.loader()} Загрузка...` : `${I.refresh()} Обновить`}
          </button>
        </div>
      </div>
      ${this.recoLoading ? `<div class="sp-reco-loading">${Array(4).fill(`<div class="sp-skeleton" style="height:52px;margin-bottom:8px"></div>`).join('')}</div>` : ''}
      ${!this.recoLoading && !hasItems ? `
        <div class="sp-reco-empty">
          <p>Нажмите «Обновить» для загрузки аналитики остатков</p>
          <p style="font-size:11px;color:var(--text3);margin-top:4px">Анализ скорости продаж за 30 дней · цель: 30 дней запасов</p>
        </div>` : ''}
      ${hasItems ? `
        <div class="sp-reco-legend">
          <span class="sp-badge sp-badge-red">0–7д</span> срочно &nbsp;
          <span class="sp-badge sp-badge-orange">8–14д</span> скоро &nbsp;
          <span class="sp-badge sp-badge-yellow">15–30д</span> план
          ${isOzon ? `<span style="margin-left:10px;font-size:11px;color:var(--text3)">Количество к поставке — редактируемое</span>` : ''}
        </div>
        <div class="sp-reco-list">
          ${this.recoItems.map((r, idx) => `
            <div class="sp-reco-item">
              <div class="sp-reco-item-top">
                <span class="sp-reco-name">${esc(r.name)}</span>
                ${urgencyBadge(r.daysLeft)}
              </div>
              <div class="sp-reco-item-sub">
                <span>Остаток: <b>${r.stock}</b></span>
                <span>·</span>
                <span>~${r.dailySales.toFixed(1)}/д</span>
                <span>·</span>
                <span style="display:inline-flex;align-items:center;gap:5px">
                  К поставке:
                  ${isOzon
                    ? `<input type="number" min="0" value="${r.recoQty}" data-reco-idx="${idx}"
                         class="sp-reco-qty" style="width:60px;padding:1px 5px;font-size:12px;font-weight:700;
                         border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text);
                         text-align:center" />`
                    : `<b>${r.recoQty}</b>`
                  } шт.
                </span>
              </div>
              ${stockBar(r.daysLeft)}
            </div>`).join('')}
        </div>` : ''}
    </div>`;
  }

  // ── Detail ──────────────────────────────────────────────────────────────────

  private renderDetail(): string {
    const s = this.detail!;
    const group = statusInfo(s.status).group;
    // Кнопки — строго по тому, что API маркетплейса реально умеет:
    // WB FBS: передать в доставку + QR. Ozon FBO: отмена. ЯМ FBY: документы.
    const actions: string[] = [];
    if (this.tab === 'wb') {
      actions.push(`<button class="sp-btn sp-btn-primary" id="sp-send" ${group === 'draft' && !this.busy ? '' : 'disabled'}>
        ${this.busy ? I.loader() : I.send()} Передать в доставку
      </button>`);
      actions.push(`<button class="sp-btn sp-btn-ghost" id="sp-barcodes" ${this.busy ? 'disabled' : ''}>${I.download()} QR-код</button>`);
    }
    if (this.tab === 'yandex') {
      actions.push(`<button class="sp-btn sp-btn-ghost" id="sp-ym-docs" ${this.busy ? 'disabled' : ''}>${I.download()} Документы</button>`);
    }
    if (this.tab === 'ozon' && s.canCancel !== false && group !== 'cancelled' && group !== 'delivered') {
      actions.push(`<button class="sp-btn sp-btn-danger" id="sp-cancel" ${this.busy ? 'disabled' : ''}>${I.trash()} Отменить</button>`);
    }

    const slot = s.timeslotFrom
      ? `${new Date(s.timeslotFrom).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` +
        (s.timeslotTo ? ` — ${new Date(s.timeslotTo).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : '')
      : '';

    const cards: Array<[string, string]> = [
      ['Номер', `<code style="font-size:11px;user-select:all">${esc(s.id)}</code>`],
      ['Товаров', `<span style="font-size:20px;font-weight:800;color:var(--text)">${s.itemsCount || '—'}</span>`],
    ];
    if (s.warehouseName) cards.push(['Склад', esc(s.warehouseName)]);
    if (slot) cards.push(['Приёмка', slot]);
    cards.push(['Создана', new Date(s.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })]);
    cards.push(['Схема', this.tab === 'ozon' ? 'Ozon FBO' : this.tab === 'wb' ? 'WB FBS' : 'ЯМ FBY']);

    return `<div class="sp-detail">
      <div class="sp-detail-topbar">
        <button class="sp-btn sp-btn-ghost" id="sp-back">← Назад</button>
        <div class="sp-detail-title">
          <span class="sp-detail-name">${esc(s.name)}</span>
          ${chip(s.status)}
        </div>
        <div class="sp-detail-actions">${actions.join('')}</div>
      </div>

      <div class="sp-detail-meta-cards">
        ${cards.map(([l,v]) => `<div class="sp-meta-card"><div class="sp-meta-label">${l}</div><div class="sp-meta-val">${v}</div></div>`).join('')}
      </div>

      <div class="sp-detail-tabs">
        ${(['overview','items','returns'] as DetailTab[]).map((dt) => `
          <button class="sp-detail-tab ${dt === this.detailTab ? 'active' : ''}" data-detail-tab="${dt}">
            ${dt === 'overview' ? 'Обзор' : dt === 'items' ? 'Состав' : 'Возвраты'}
          </button>`).join('')}
      </div>

      <div class="sp-detail-body">${this.renderDetailTabContent()}</div>
    </div>`;
  }

  private renderDetailTabContent(): string {
    if (this.detailTab === 'overview') return this.renderDetailOverview();
    if (this.detailTab === 'items')    return this.renderDetailItems();
    return this.renderDetailReturns();
  }

  private renderDetailOverview(): string {
    const s = this.detail!;
    const st = statusInfo(s.status);

    // Шаги показываем по группам статусов — так они переживают любые
    // новые коды состояний, которые маркетплейсы добавляют без предупреждения.
    const steps: [StatusGroup, string][] =
      this.tab === 'yandex'
        ? [['draft','Создана'],['sending','Везём на склад'],['delivered','Принята']]
        : this.tab === 'ozon'
          ? [['draft','Заявка готова'],['sending','Приёмка'],['delivered','Завершена']]
          : [['draft','Черновик'],['sending','В доставке'],['delivered','Принята WB']];

    const currentIdx = st.group === 'cancelled' ? -1 : steps.findIndex(([g]) => g === st.group);
    const progressPct = steps.length > 1 && currentIdx >= 0
      ? Math.max(0, Math.min(100, (currentIdx / (steps.length - 1)) * 100))
      : 0;

    const tips = this.getStatusTips(s.status);

    return `<div class="sp-detail-overview">
      <div class="sp-progress-section">
        <div class="sp-progress-label" style="color:${st.color}">${st.text}</div>
        <div class="sp-progress-track">
          <div class="sp-progress-fill" style="width:${progressPct}%;background:${st.color}"></div>
        </div>
        <div class="sp-progress-steps">
          ${steps.map(([_k, label], idx) => `
            <div class="sp-progress-step ${idx <= currentIdx ? 'done' : ''}" style="${idx <= currentIdx ? `--c:${st.color}` : ''}">
              <div class="sp-step-dot"></div>
              <div class="sp-step-label">${label}</div>
            </div>`).join('')}
        </div>
      </div>
      ${tips ? `<div class="sp-tips">${tips.map(t => `<div class="sp-tip">${I.info()} ${t}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  private getStatusTips(status: string): string[] {
    const g = statusInfo(status).group;
    if (g === 'cancelled') return ['Поставка отменена — товары на склад не поедут.'];

    if (this.tab === 'ozon') {
      if (g === 'draft') return [
        'Состав заявки Ozon уже зафиксирован и не редактируется — изменить можно только отменив и создав заново.',
        'Привезите товар на выбранный склад в назначенное окно приёмки.',
        'Этикетки грузомест печатаются в кабинете Ozon: Поставки → ваша заявка.',
      ];
      if (g === 'sending')   return ['Заявка в работе — идёт доставка или приёмка на складе Ozon.'];
      if (g === 'delivered') return ['Заявка завершена. Товары приняты и скоро появятся в остатках FBO.'];
    }
    if (this.tab === 'wb') {
      if (g === 'draft') return [
        'Добавьте сборочные задания кнопкой «Из заказов» — она соберёт поставку из новых заказов.',
        'Когда всё собрано, нажмите «Передать в доставку».',
        'Скачайте QR-код — его сканируют при сдаче в ПВЗ или на складе WB.',
      ];
      if (g === 'sending')   return ['Поставка передана в доставку. Отвезите её в пункт приёма WB и предъявите QR-код.'];
      if (g === 'delivered') return ['Поставка принята WB.'];
    }
    if (this.tab === 'yandex') {
      if (g === 'draft') return [
        'Заявка заведена в кабинете Маркета. Состав и даты меняются там же — API работает только на чтение.',
        'Привезите товар на склад Яндекса в указанное окно приёмки.',
        'Накладные и акты — на вкладке «Документы».',
      ];
      if (g === 'sending')   return ['Товар в пути на склад Яндекса либо проходит приёмку.'];
      if (g === 'delivered') return ['Заявка закрыта — товары приняты на склад Яндекса.'];
    }
    return [];
  }

  private renderDetailItems(): string {
    if (this.detailItemsLoading) {
      return `<div class="sp-loading-inline">${I.loader()} Загружаем состав поставки...</div>`;
    }
    if (this.detailItemsError) {
      const e = humanApiError(this.detailItemsError);
      return `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-icon">⚠️</div>
        <div class="sp-error-text">${esc(e.title)}</div>
        <details class="sp-error-details"><summary>Технические детали</summary><code>${esc(e.detail)}</code></details>
        <div class="sp-error-actions">
          <button class="sp-btn sp-btn-ghost" id="sp-retry-items">Попробовать снова</button>
        </div>
      </div>`;
    }
    if (!this.detailItems.length) {
      const hint = this.tab === 'ozon'
        ? 'У заявки нет грузомест — Ozon наполняет их после подтверждения поставки.'
        : this.tab === 'wb'
          ? 'В поставке пока нет сборочных заданий. Добавьте их кнопкой «Из заказов» или в кабинете WB.'
          : 'Маркет ещё не вернул состав по этой заявке — обычно он появляется после подтверждения.';
      return `<div class="sp-empty" style="height:140px">
        <p style="font-size:13px">Состав пуст</p>
        <p style="font-size:11px;color:var(--text2);margin-top:6px;max-width:420px">${hint}</p>
      </div>`;
    }
    const total = this.detailItems.reduce((s, i) => s + i.qty, 0);
    return `<div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text2)">${this.detailItems.length} позиций · ${total} шт.</span>
        <button class="sp-btn sp-btn-ghost" id="sp-export-csv" style="padding:3px 10px;font-size:11px">${I.download()} CSV</button>
      </div>
      <table class="sp-table">
        <thead><tr>
          <th>Товар</th>
          <th>SKU / Артикул</th>
          <th style="text-align:right">Кол-во</th>
        </tr></thead>
        <tbody>
          ${this.detailItems.map(i => `<tr>
            <td>${esc(i.name)}</td>
            <td><code style="font-size:11px;color:var(--text2)">${esc(i.sku ?? '—')}</code></td>
            <td style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums">${i.qty}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  private renderDetailReturns(): string {
    if (this.detailReturnsLoading) {
      return `<div class="sp-loading-inline">${I.loader()} Загружаем возвраты...</div>`;
    }
    if (this.detailReturnsError) {
      const e = humanApiError(this.detailReturnsError);
      return `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-icon">⚠️</div>
        <div class="sp-error-text">${esc(e.title)}</div>
        <details class="sp-error-details"><summary>Технические детали</summary><code>${esc(e.detail)}</code></details>
        <div class="sp-error-actions">
          <button class="sp-btn sp-btn-ghost" id="sp-retry-returns">Попробовать снова</button>
        </div>
      </div>`;
    }
    if (!this.detailReturns.length) {
      return `<div class="sp-empty" style="height:120px">
        <p style="font-size:13px;color:#10b981">Возвратов за последние 90 дней нет</p>
        <p style="font-size:11px;color:var(--text2);margin-top:6px;max-width:420px">
          Возвраты приходят по магазину целиком, а не по конкретной поставке —
          здесь показаны те, что относятся к её товарам.
        </p>
      </div>`;
    }
    const total = this.detailReturns.reduce((s, r) => s + r.qty, 0);
    return `<div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">
        Возвратов: <strong style="color:#ef4444">${total} шт.</strong>
      </div>
      <table class="sp-table">
        <thead><tr>
          <th>Товар</th>
          <th>Причина</th>
          <th>Дата</th>
          <th style="text-align:right">Кол-во</th>
        </tr></thead>
        <tbody>
          ${this.detailReturns.map(r => `<tr>
            <td>${esc(r.name)}</td>
            <td style="color:var(--text2);font-size:12px">${esc(returnReason(r.reason ?? '—'))}</td>
            <td style="color:var(--text2);font-size:12px">${r.date ? new Date(r.date).toLocaleDateString('ru-RU') : '—'}</td>
            <td style="text-align:right;font-weight:700;color:#ef4444">${r.qty}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private bindAll(): void {
    this.el.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const btn = el.closest('button') as HTMLButtonElement | null;
      const row = el.closest('[data-action]') as HTMLElement | null;

      if (btn) {
        const tabVal = btn.dataset.tab as Tab | undefined;
        if (tabVal && !btn.disabled) {
          this.tab = tabVal; this.storeId = ''; this.supplies = []; this.detail = null;
          this.detailItems = []; this.detailReturns = []; this.recoItems = []; this.error = '';
          this.detailItemsError = ''; this.detailReturnsError = ''; this.detailItemsUnavailable = false;
          this.supplyStats = { draft:0, sending:0, delivered:0, cancelled:0 };
          this.searchQuery = ''; this.statusFilter = '';
          this.rebuildTabs(); this.rebuildHeaderActions(); this.flush(); this.loadStores();
          return;
        }
        const dtTab = btn.dataset.detailTab as DetailTab | undefined;
        if (dtTab) {
          this.detailTab = dtTab;
          if (dtTab === 'items' && !this.detailItems.length && !this.detailItemsLoading && !this.detailItemsUnavailable) this.loadDetailItems();
          if (dtTab === 'returns' && !this.detailReturns.length && !this.detailReturnsLoading) this.loadDetailReturns();
          this.flush(); return;
        }
        switch (btn.id) {
          case 'sp-create': case 'sp-create-empty': this.openCreateDialog(); break;
          case 'sp-wizard': case 'sp-wizard-empty': this.openWbWizard(); break;
          case 'sp-refresh': this.error = ''; this.loadSupplies(); break;
          case 'sp-back':
            this.detail = null; this.detailItems = []; this.detailReturns = [];
            this.detailItemsError = ''; this.detailReturnsError = ''; this.detailItemsUnavailable = false;
            this.flush(); break;
          case 'sp-send': this.sendSupply(); break;
          case 'sp-barcodes': this.downloadBarcodes(); break;
          case 'sp-ym-docs': this.openYmDocuments(); break;
          case 'sp-retry-items': this.detailItemsError = ''; this.detailItemsUnavailable = false; this.loadDetailItems(); break;
          case 'sp-retry-returns': this.detailReturnsError = ''; this.loadDetailReturns(); break;
          case 'sp-cancel': this.cancelSupply(); break;
          case 'sp-reco': this.showReco = !this.showReco; this.flush(); if (this.showReco && !this.recoItems.length) this.loadReco(); break;
          case 'sp-reco-load': this.loadReco(); break;
          case 'sp-reco-create': this.createSupplyFromReco(); break;
          case 'sp-export-csv': this.exportCsv(); break;
          case 'sp-clear-filter': this.searchQuery = ''; this.statusFilter = ''; this.flush(); break;
          case 'sp-help': case 'sp-help-no-store': case 'sp-help-error': case 'sp-help-empty': this.openHelpModal(); break;
        }
      }

      if (row) {
        const action = row.dataset.action;
        const id = row.dataset.id;
        if (action === 'quick-send' && id) {
          e.stopPropagation();
          const found = this.supplies.find(s => s.id === id);
          if (found) {
            this.detail = found;
            this.detailItems = [];
            this.detailReturns = [];
            this.detailTab = 'overview';
            this.sendSupply();
          }
          return;
        }
        if (action === 'open' && id) {
          const found = this.supplies.find(s => s.id === id);
          if (found) {
            this.detail = found; this.detailTab = 'overview';
            this.detailItems = []; this.detailReturns = [];
            this.detailItemsError = ''; this.detailReturnsError = ''; this.detailItemsUnavailable = false;
            this.flush();
          }
        }
      }
    });

    this.el.addEventListener('input', (e) => {
      const inp = e.target as HTMLInputElement;
      if (inp.id === 'sp-search') { this.searchQuery = inp.value; this.flush(); }
      if (inp.dataset.recoIdx !== undefined) {
        const idx = Number(inp.dataset.recoIdx);
        if (this.recoItems[idx] !== undefined) {
          this.recoItems[idx].recoQty = Math.max(0, parseInt(inp.value) || 0);
          // Update button label without full flush to avoid focus loss
          const btn = this.el.querySelector('#sp-reco-create');
          if (btn) {
            const total = this.recoItems.reduce((s, r) => s + r.recoQty, 0);
            btn.textContent = `+ Создать поставку (${total} шт.)`;
          }
        }
      }
    });

    this.el.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.id === 'sp-store') {
        this.storeId = sel.value; this.supplies = []; this.detail = null;
        this.recoItems = []; this.error = ''; this.searchQuery = ''; this.statusFilter = '';
        this.supplyStats = { draft:0, sending:0, delivered:0, cancelled:0 };
        if (this.storeId) this.loadSupplies(); else this.flush();
      }
      if (sel.id === 'sp-status-filter') { this.statusFilter = sel.value; this.flush(); }
    });
  }

  private renderTabs(): string {
    const labels: Record<Tab, string> = { ozon: 'Ozon FBO', wb: 'WB FBS', yandex: 'Яндекс FBY' };
    const checked = this.connectedMps.size > 0;
    return (['ozon', 'wb', 'yandex'] as Tab[]).map(t => {
      const connected = !checked || this.connectedMps.has(t);
      const active = t === this.tab;
      const cls = ['sp-tab', active ? 'active' : '', !connected ? 'disabled' : ''].filter(Boolean).join(' ');
      const title = connected ? '' : `title="Нет подключённых магазинов — перейдите в Настройки"`;
      return `<button class="${cls}" data-tab="${t}" ${!connected ? 'disabled' : ''} ${title}>${labels[t]}</button>`;
    }).join('');
  }

  private rebuildTabs(): void {
    const tabsEl = this.el.querySelector('#sp-tabs');
    if (tabsEl) tabsEl.innerHTML = this.renderTabs();
  }

  /**
   * Сначала выясняем, какие МП вообще подключены, и только потом грузим магазины:
   * иначе активной может оказаться вкладка без магазинов, и селектор покажет
   * «Нет магазинов» при живом подключении на соседней вкладке.
   */
  private async init(): Promise<void> {
    const [ozonStores, wbStores, ymStores] = await Promise.all([
      ozonDb.getStores().catch(() => [] as any[]),
      wbDb.getStores().catch(() => [] as any[]),
      yandexDb.getStores().catch(() => [] as any[]),
    ]);
    this.connectedMps.clear();
    if (ozonStores.length > 0) this.connectedMps.add('ozon');
    if (wbStores.length > 0)   this.connectedMps.add('wb');
    if (ymStores.length > 0)   this.connectedMps.add('yandex');

    if (this.connectedMps.size > 0 && !this.connectedMps.has(this.tab)) {
      const first = (['ozon', 'wb', 'yandex'] as Tab[]).find(t => this.connectedMps.has(t));
      if (first) this.tab = first;
    }
    this.rebuildTabs();
    this.rebuildHeaderActions();

    // Переиспользуем уже загруженные списки — второй раз в БД не ходим
    this.stores = this.tab === 'ozon' ? ozonStores : this.tab === 'wb' ? wbStores : ymStores;
    this.applyStores();
  }

  private rebuildHeaderActions(): void {
    const actEl = this.el.querySelector('#sp-actions');
    if (actEl) actEl.innerHTML = this.renderHeaderActions();
  }

  private flush(): void {
    const active = document.activeElement as HTMLElement | null;
    const activeId = active?.id;
    const selStart = active instanceof HTMLInputElement ? active.selectionStart : null;
    const content = this.el.querySelector('#sp-content');
    if (content) content.innerHTML = this.renderContent();
    const kpi = this.el.querySelector('#sp-kpi');
    if (kpi) kpi.innerHTML = this.renderKpi();
    if (activeId) {
      const restored = this.el.querySelector(`#${activeId}`) as HTMLInputElement | null;
      if (restored) {
        restored.focus();
        if (selStart !== null && 'setSelectionRange' in restored) restored.setSelectionRange(selStart, selStart);
      }
    }
  }

  // ── Data: stores ─────────────────────────────────────────────────────────────

  private async loadStores(): Promise<void> {
    this.stores = [];
    try {
      if (this.tab === 'ozon')    this.stores = await ozonDb.getStores();
      else if (this.tab === 'wb') this.stores = await wbDb.getStores();
      else                        this.stores = await yandexDb.getStores();
    } catch { /**/ }
    this.applyStores();
  }

  /** Заполнить селектор магазинов текущим this.stores и подтянуть поставки. */
  private applyStores(): void {
    const sel = this.el.querySelector('#sp-store') as HTMLSelectElement | null;
    if (!sel) return;

    if (!this.stores.length) {
      sel.innerHTML = '<option value="">Нет магазинов</option>';
      this.storeId = ''; this.flush(); return;
    }
    sel.innerHTML = '<option value="">— Магазин —</option>' +
      this.stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if (this.stores.length === 1) {
      this.storeId = this.stores[0].id;
      sel.value = this.storeId;
      this.loadSupplies();
    } else {
      this.flush();
    }
  }

  // ── Data: supplies ───────────────────────────────────────────────────────────

  private async loadSupplies(): Promise<void> {
    if (!this.storeId) return;
    this.loading = true; this.error = ''; this.flush();
    try {
      this.supplies = [];
      const store = this.getStore();
      if (!store) { this.error = 'Магазин не найден — выберите снова'; return; }

      if (this.tab === 'ozon') {
        let list: any[] = [];
        try {
          list = await ozonApi.getSupplies({ client_id: store.client_id, api_key: store.api_key });
        } catch (err: any) {
          const msg = String(err.message ?? '');
          if (msg.includes('403')) {
            this.error = 'Нет доступа к заявкам на поставку. У API-ключа Ozon должно быть право «Поставки/FBO».';
          } else {
            this.error = `Ошибка Ozon API: ${msg}`;
          }
        }
        this.supplies = list.map(s => {
          const slot = Array.isArray(s.timeslot) ? s.timeslot[0] : s.timeslot;
          return {
            id: String(s.supply_order_id ?? ''),
            name: s.supply_order_number ? `Заявка ${s.supply_order_number}` : `Заявка ${s.supply_order_id}`,
            status: String(s.state ?? ''),
            createdAt: s.creation_date ?? new Date().toISOString(),
            itemsCount: 0, // состав приходит отдельно через /v1/supply-order/bundle
            bundleIds: (s.supplies ?? []).map((sup: any) => String(sup.bundle_id)).filter(Boolean),
            warehouseName: s._warehouse?.name ?? '',
            canCancel: Boolean(s.can_cancel),
            timeslotFrom: slot?.from_in_timezone ?? slot?.timeslot?.from ?? '',
            timeslotTo: slot?.to_in_timezone ?? slot?.timeslot?.to ?? '',
          };
        });

      } else if (this.tab === 'wb') {
        try {
          const list = await wbApi.getWbSupplies(store.api_key);
          this.supplies = list.map(s => ({
            id: String(s.id ?? ''),
            name: s.name ?? `Поставка ${s.id}`,
            status: s.done ? 'done' : (s.scanDt ? 'sent' : 'draft'),
            createdAt: s.createdAt ?? new Date().toISOString(),
            itemsCount: s.orderCount ?? 0,
          }));
        } catch (err: any) {
          this.error = `Ошибка WB API: ${err.message}. Проверьте права токена (нужны права «Поставки»).`;
        }

      } else {
        // ── Яндекс FBY: заявки на поставку (API только на чтение) ──────────
        const placement = store.placement_type ?? store.fulfillment_model;
        if (placement && placement !== 'FBY') {
          this.error = `Магазин работает по схеме ${placement}, а не FBY. ` +
            'Заявки на поставку есть только у FBY (склад Яндекса). ' +
            (placement === 'FBS' || placement === 'DBS' || placement === 'LAAS'
              ? 'При FBS/DBS товар хранится у вас — поставки на склад Маркета не нужны.'
              : 'Проверьте схему магазина в Настройках.');
        } else if (!store.campaign_id) {
          this.error = 'У магазина не заполнен Campaign ID. Настройки → Магазины → Яндекс. ' +
            'ID кампании находится в ЯМ → Настройки → О магазине.';
        } else {
          try {
            const list = await getYandexSupplyRequests(store as any, {
              dateFrom: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
              dateTo: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
              types: ['SUPPLY'],
            });
            this.supplies = list.map(r => ({
              id: r.id,
              name: r.externalId ? `Заявка ${r.externalId}` : `Заявка ${r.id}`,
              status: r.status,
              createdAt: r.createdAt || r.planIntervalFrom || new Date().toISOString(),
              itemsCount: r.itemsCount,
              warehouseName: r.warehouseName,
              timeslotFrom: r.planIntervalFrom,
              timeslotTo: r.planIntervalTo,
            }));
          } catch (err: any) {
            const msg = String(err.message ?? '');
            if (msg.includes('404') || msg.includes('NOT_FOUND')) {
              this.error = 'Маркет не отдаёт заявки для этой кампании. Обычно это значит, что Campaign ID указан от другого магазина ' +
                'или магазин не работает по FBY. Проверьте ID в ЯМ → Настройки → О магазине.';
            } else if (msg.includes('403') || msg.includes('FORBIDDEN')) {
              this.error = 'Нет доступа к заявкам FBY. Выдайте API-ключу доступ «Поставки, вывоз и утилизация» в кабинете Маркета.';
            } else {
              this.error = `Ошибка ЯМ API: ${msg}`;
            }
          }
        }
      }

      this.calcStats();
    } catch (err: any) {
      this.error = `Ошибка: ${err.message}`;
    } finally {
      this.loading = false; this.flush();
    }
  }

  // ── Data: detail items ───────────────────────────────────────────────────────

  private async loadDetailItems(): Promise<void> {
    if (!this.detail) return;
    this.detailItemsLoading = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) { this.detailItems = []; return; }

      if (this.tab === 'ozon') {
        const bundleIds = this.detail.bundleIds ?? [];
        if (!bundleIds.length) {
          this.detailItems = [];
          this.detailItemsUnavailable = true;
        } else {
          const items = await ozonApi.getSupplyBundle(
            { client_id: store.client_id, api_key: store.api_key },
            bundleIds,
          );
          this.detailItems = items.map(i => ({
            name: i.name || `SKU ${i.sku}`,
            qty: i.quantity,
            sku: String(i.offer_id || i.sku),
          }));
          // Список v2 не отдаёт количество позиций — проставляем из состава
          if (this.detail) this.detail.itemsCount = this.detailItems.reduce((s, i) => s + i.qty, 0);
        }

      } else if (this.tab === 'wb') {
        const orders = await wbApi.getSupplyOrders(store.api_key, this.detail.id);
        this.detailItems = orders.map((o: any) => ({
          name: o.article ?? o.offerId ?? o.supplierArticle ?? `Задание ${o.id}`,
          qty: 1,
          sku: String(o.nmId ?? o.nm_id ?? o.id ?? ''),
        }));

      } else {
        const items = await getYandexSupplyRequestItems(store as any, this.detail.id);
        this.detailItems = items.map(i => ({ name: i.name, qty: i.qty, sku: i.offerId }));
        if (!this.detailItems.length) this.detailItemsUnavailable = true;
      }
    } catch (err: any) {
      this.detailItems = [];
      this.detailItemsError = String(err.message ?? err);
    } finally {
      this.detailItemsLoading = false; this.flush();
    }
  }

  // ── Data: returns ────────────────────────────────────────────────────────────

  private async loadDetailReturns(): Promise<void> {
    if (!this.detail) return;
    this.detailReturnsLoading = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) { this.detailReturns = []; return; }

      if (this.tab === 'ozon') {
        // Load supply items first to filter returns by SKU
        const itemSkus = new Set(this.detailItems.map(i => i.sku).filter(Boolean));
        const creds = { client_id: store.client_id, api_key: store.api_key };
        // FBO returns: paginate by offset (max 50 pages = 5000 returns)
        const fboReturns: any[] = [];
        for (let offset = 0, iter = 0; iter < 50; offset += 100, iter++) {
          const page = await ozonApi.getFboReturns(creds, { limit: 100, offset }).catch(() => []);
          fboReturns.push(...page);
          if (page.length < 100) break;
        }
        // FBS returns: paginate by cursor (last_id), max 100 pages = 10,000 returns
        const fbsReturns: any[] = [];
        let last_id = '';
        for (let iter = 0; iter < 100; iter++) {
          const res = await ozonApi.getFbsReturns(creds, { limit: 100, last_id }).catch(() => ({ returns: [], last_id: '', has_next: false }));
          fbsReturns.push(...res.returns);
          if (!res.has_next) break;
          last_id = res.last_id;
        }
        const allReturns = [...fboReturns, ...fbsReturns];
        const filtered = itemSkus.size > 0
          ? allReturns.filter((r: any) => itemSkus.has(String(r.sku ?? r.offer_id ?? '')))
          : allReturns.slice(0, 50);
        this.detailReturns = filtered.map((r: any) => ({
          name: r.product_name ?? r.name ?? `SKU ${r.sku ?? ''}`,
          qty: r.quantity ?? 1,
          reason: r.return_reason ?? r.reason_name ?? r.reason ?? '—',
          date: r.accepted_at ?? r.created_at,
        }));

      } else if (this.tab === 'wb') {
        const dateFrom = new Date(Date.now() - 90 * 86_400_000).toISOString();
        const [returns, supplyOrders] = await Promise.all([
          fetchWbReturns(store.api_key, dateFrom),
          wbApi.getSupplyOrders(store.api_key, this.detail.id).catch(() => []),
        ]);
        const orderNmIds = new Set(supplyOrders.map((o: any) => o.nmId ?? o.nm_id));
        const filtered = orderNmIds.size > 0
          ? returns.filter(r => r.nmId != null && orderNmIds.has(r.nmId))
          : returns.slice(0, 50);
        this.detailReturns = filtered.map(r => ({
          name: r.productName ?? r.subject ?? String(r.nmId ?? ''),
          qty: r.quantity ?? 1,
          reason: '—',
          date: r.returnDate,
        }));

      } else {
        // ЯМ отдаёт возвраты по кампании целиком (не по заявке), товары — массивом
        try {
          const dateFrom = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
          const dateTo = new Date().toISOString().slice(0, 10);
          const returns = await getYandexReturns(store as any, { dateFrom, dateTo });
          this.detailReturns = returns.slice(0, 50).flatMap((r: any) => {
            const items: any[] = Array.isArray(r.items) ? r.items : r.item ? [r.item] : [];
            const reason = r.refundStatus ?? r.returnType ?? r.returnDecision ?? '—';
            const date = r.creationDate ?? r.returnDate;
            if (!items.length) {
              return [{ name: `Заказ ${r.orderId ?? r.id}`, qty: 1, reason, date }];
            }
            return items.map((i: any) => ({
              name: i.offerName ?? i.name ?? i.offerId ?? i.shopSku ?? `Заказ ${r.orderId ?? r.id}`,
              qty: Number(i.count ?? i.quantity ?? 1),
              reason,
              date,
            }));
          });
        } catch {
          this.detailReturns = [];
        }
      }
    } catch (err: any) {
      this.detailReturns = [];
      this.detailReturnsError = String(err.message ?? err);
    } finally {
      this.detailReturnsLoading = false; this.flush();
    }
  }

  // ── Data: recommendations ────────────────────────────────────────────────────

  private async loadReco(): Promise<void> {
    this.recoLoading = true; this.flush();
    try {
      const w = window as any;
      const stockItems: any[] = w.stockModule?.items ?? [];
      const mpFilter = this.tab === 'ozon' ? 'ozon' : this.tab === 'wb' ? 'wb' : 'yandex';

      const baseItems = stockItems.filter(i =>
        i.mp === mpFilter && (!this.storeId || i.storeId === this.storeId),
      );

      if (!baseItems.length) {
        showToast('Сначала синхронизируйте остатки в разделе «Склад» — рекомендации строятся на этих данных', 'info');
        this.recoLoading = false; this.flush(); return;
      }

      let velocityMap: Map<string, number> = new Map();
      try {
        const store = this.stores.find(s => s.id === this.storeId) ?? this.stores[0];
        if (store) {
          if (this.tab === 'wb') {
            const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString();
            const sales = await fetchWbSalesAnalytics(store.api_key, dateFrom);
            const counts: Map<string, number> = new Map();
            for (const s of sales) {
              const key = String(s.nmId ?? '');
              if (key) counts.set(key, (counts.get(key) ?? 0) + (s.quantity ?? 1));
            }
            for (const [key, total] of counts) velocityMap.set(key, total / 30);

          } else if (this.tab === 'yandex') {
            const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
            const dateTo = new Date().toISOString().slice(0, 10);
            const offerIds = baseItems.slice(0, 200).map(i => i.offerId ?? i.offer_id).filter(Boolean);
            if (offerIds.length) {
              const stats = await getYandexSkuStats(store as any, { dateFrom, dateTo, offerIds });
              for (const s of stats) {
                const key = s.shopSku ?? s.offerId ?? '';
                if (key) velocityMap.set(key, (s.orderedItems ?? 0) / 30);
              }
            }

          } else if (this.tab === 'ozon') {
            const productIds: number[] = baseItems
              .map(i => Number(i.productId ?? i.product_id))
              .filter(id => id > 0)
              .slice(0, 200);
            if (productIds.length) {
              const dateTo = new Date().toISOString().slice(0, 10);
              const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
              const dynamics = await ozonApi.getStocksDynamics(
                { client_id: store.client_id, api_key: store.api_key },
                { productIds, dateFrom, dateTo },
              );
              for (const d of dynamics) {
                const key = String(d.product_id ?? d.sku ?? '');
                const sold = d.items?.reduce?.((acc: number, item: any) => acc + (item.quantity_sold ?? 0), 0) ?? 0;
                if (key && sold > 0) velocityMap.set(key, sold / 30);
              }
            }
          }
        }
      } catch { /* fallback to stock-only */ }

      this.recoItems = baseItems
        .map(i => {
          const stock = i.stockFbo ?? i.stockTotal ?? 0;
          const key = String(i.productId ?? i.product_id ?? i.nmId ?? i.offerId ?? i.offer_id ?? '');
          const dailySales = velocityMap.get(key) ?? (stock > 0 ? stock / 45 : 0.1);
          const daysLeft = dailySales > 0 ? Math.round(stock / dailySales) : 999;
          const recoQty = Math.max(0, Math.ceil((30 - daysLeft) * dailySales));
          return { name: (i.name ?? i.offerId ?? 'Товар').slice(0, 50), sku: key, stock, dailySales, daysLeft, mp: mpFilter, recoQty };
        })
        .filter(i => i.daysLeft <= 60)
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .slice(0, 20);

      if (!this.recoItems.length) showToast('Все товары в норме — остатков хватает на 60+ дней', 'success');
    } catch (err: any) {
      showToast(`Ошибка анализа: ${err.message}`, 'error');
    } finally {
      this.recoLoading = false; this.flush();
    }
  }

  // ── Dialogs ──────────────────────────────────────────────────────────────────

  private async openCreateDialog(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    if (this.tab === 'yandex') { this.openYmCreateInfo(); return; }
    if (this.tab === 'ozon')   { this.openOzonWizard(); return; }

    // WB FBS — поставка создаётся пустой, задания добавляются отдельно
    const ov = this.modal('Новая поставка Wildberries FBS');
    ov.body.innerHTML = `
      <form id="sp-dlg-form" class="sp-form">
        <div class="sp-field">
          <label class="sp-label">Название поставки</label>
          <input name="name" required placeholder="Например: Поставка 21 августа" class="sp-input" autofocus>
        </div>
        <div class="sp-help-note">
          Поставка создастся пустой. Дальше добавьте в неё сборочные задания —
          проще всего кнопкой <b>«Из заказов»</b>, она соберёт поставку из новых заказов сразу.
        </div>
        <div class="sp-form-footer">
          <button type="button" class="sp-btn sp-btn-ghost" data-close>Отмена</button>
          <button type="submit" class="sp-btn sp-btn-primary">${I.plus()} Создать</button>
        </div>
      </form>`;
    (ov.body.querySelector('#sp-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (new FormData(e.target as HTMLFormElement).get('name') as string).trim();
      ov.el.remove();
      await this.createWbSupply(name);
    });
  }

  /**
   * Яндекс FBY: заявку на поставку нельзя создать через API — Partner API
   * работает только на чтение. Честно объясняем это вместо мёртвой кнопки.
   */
  private openYmCreateInfo(): void {
    const ov = this.modal('Создание заявки FBY');
    ov.body.innerHTML = `
      <div class="sp-form">
        <div class="sp-callout sp-callout-info">
          <b>Заявку на поставку FBY можно создать только в кабинете Маркета.</b>
          <p>API Яндекс Маркета для FBY работает <b>только на чтение</b>: он отдаёт список заявок,
          их состав и документы, но метода создания в нём нет. Это ограничение Маркета, не SimaDesk.</p>
        </div>
        <div class="sp-help-note">
          <b>Как поставить товар на склад Яндекса:</b>
          <ol style="margin:6px 0 0 16px;padding:0;line-height:1.7">
            <li>Откройте кабинет Маркета → <b>Товары → Поставки</b></li>
            <li>Нажмите <b>«Создать заявку»</b>, выберите склад и дату</li>
            <li>Соберите состав — что и в каком количестве везёте</li>
            <li>Вернитесь сюда и нажмите <b>«Обновить»</b> — заявка появится в списке</li>
          </ol>
          <p style="margin-top:8px">Дальше SimaDesk покажет статус, состав и документы заявки.</p>
        </div>
        <div class="sp-form-footer">
          <a class="sp-btn sp-btn-primary" href="https://partner.market.yandex.ru/supplies" target="_blank" rel="noopener">
            Открыть кабинет Маркета
          </a>
          <button type="button" class="sp-btn sp-btn-ghost" data-close>Закрыть</button>
        </div>
      </div>`;
  }

  /**
   * Ozon FBO: реальный флоу создания — черновик → склад → таймслот → заявка.
   * Состав фиксируется на первом шаге: «дослать» товары в заявку Ozon нельзя.
   */
  private async openOzonWizard(preset?: Array<{ sku: number; quantity: number; name?: string }>): Promise<void> {
    const store = this.getStore();
    if (!store) { showToast('Магазин не найден', 'error'); return; }
    const creds = { client_id: store.client_id, api_key: store.api_key };
    const ov = this.modal('Новая поставка Ozon FBO');
    ov.el.querySelector('.sp-modal')!.classList.add('sp-modal-wide');

    let items: Array<{ sku: number; quantity: number; name?: string }> = preset ?? [];
    let draft: Awaited<ReturnType<typeof ozonApi.getSupplyDraftInfo>> | null = null;
    let warehouseId = 0;

    const steps = ['Состав', 'Склад', 'Дата приёмки'];
    const stepBar = (active: number) => `
      <div class="sp-steps">
        ${steps.map((s, i) => `
          <div class="sp-step-pill ${i === active ? 'active' : i < active ? 'done' : ''}">
            <span class="sp-step-num">${i < active ? '✓' : i + 1}</span>${s}
          </div>`).join('<div class="sp-step-sep"></div>')}
      </div>`;

    // ── Шаг 1: состав ───────────────────────────────────────────────────────
    const renderItems = () => {
      ov.body.innerHTML = `
        ${stepBar(0)}
        <div class="sp-form">
          <div class="sp-field">
            <label class="sp-label">Что везём на склад</label>
            <textarea id="sp-wz-items" rows="7" class="sp-input" style="resize:vertical;font-family:ui-monospace,monospace;font-size:12px"
              placeholder="12345678:10&#10;87654321:5">${items.map(i => `${i.sku}:${i.quantity}`).join('\n')}</textarea>
          </div>
          <div class="sp-help-note">
            Формат: <code>FBO_SKU:количество</code>, по одной позиции в строке.<br>
            SKU можно не искать вручную — откройте <b>«Пополнение»</b> и нажмите
            «Создать поставку», состав подставится сам.
          </div>
          <div class="sp-callout sp-callout-warn">
            Состав поставки Ozon фиксируется сразу и <b>не редактируется после создания</b> —
            проверьте количества перед следующим шагом.
          </div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" data-close>Отмена</button>
            <button type="button" class="sp-btn sp-btn-primary" id="sp-wz-next">Рассчитать склады →</button>
          </div>
        </div>`;
      ov.body.querySelector('#sp-wz-next')!.addEventListener('click', () => {
        const raw = (ov.body.querySelector('#sp-wz-items') as HTMLTextAreaElement).value;
        const parsed: Array<{ sku: number; quantity: number }> = [];
        for (const line of raw.trim().split('\n')) {
          if (!line.trim()) continue;
          const [s, q] = line.split(':');
          const sku = parseInt(s); const qty = parseInt(q ?? '1');
          if (!isNaN(sku) && qty > 0) parsed.push({ sku, quantity: qty });
        }
        if (!parsed.length) { showToast('Добавьте хотя бы одну позицию в формате SKU:количество', 'warning'); return; }
        items = parsed;
        calcDraft();
      });
    };

    // ── Шаг 2: расчёт черновика + выбор склада ──────────────────────────────
    const calcDraft = async () => {
      ov.body.innerHTML = `${stepBar(1)}
        <div class="sp-loading-inline" style="flex-direction:column;gap:10px;padding:32px 0">
          ${I.loader()}
          <div>Ozon подбирает склады под ваш состав…</div>
          <div style="font-size:11px;color:var(--text3)">Обычно занимает 5–15 секунд</div>
        </div>`;
      try {
        const { operationId } = await ozonApi.createSupplyDraft(creds, { items });
        if (!operationId) throw new Error('Ozon не вернул operation_id черновика');
        draft = await ozonApi.waitForSupplyDraft(creds, operationId);
      } catch (err: any) {
        ov.body.innerHTML = `${stepBar(1)}
          <div class="sp-error-block" style="margin:0">
            <div class="sp-error-icon">⚠️</div>
            <div class="sp-error-text">${esc(err.message)}</div>
            <p style="font-size:12px;color:var(--text2);margin-top:8px">
              Частая причина — неверный FBO SKU. Нужен именно числовой SKU из карточки Ozon, а не артикул продавца.
            </p>
          </div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" id="sp-wz-back">← Изменить состав</button>
            <button type="button" class="sp-btn sp-btn-ghost" data-close>Закрыть</button>
          </div>`;
        ov.body.querySelector('#sp-wz-back')?.addEventListener('click', renderItems);
        return;
      }

      const clusters = draft.clusters.filter(c => c.warehouses.length);
      if (!clusters.length) {
        ov.body.innerHTML = `${stepBar(1)}
          <div class="sp-error-block" style="margin:0">
            <div class="sp-error-text">Ozon не предложил ни одного склада для этого состава.
            Обычно это значит, что товары ещё не прошли модерацию или недоступны для FBO.</div>
          </div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" id="sp-wz-back">← Изменить состав</button>
            <button type="button" class="sp-btn sp-btn-ghost" data-close>Закрыть</button>
          </div>`;
        ov.body.querySelector('#sp-wz-back')?.addEventListener('click', renderItems);
        return;
      }

      const totalQty = items.reduce((s, i) => s + i.quantity, 0);
      ov.body.innerHTML = `
        ${stepBar(1)}
        <div class="sp-form">
          <div class="sp-help-note" style="margin-bottom:10px">
            Состав: <b>${items.length} позиций · ${totalQty} шт.</b> — Ozon подобрал склады, куда это можно везти.
          </div>
          <div class="sp-wh-list">
            ${clusters.map(c => `
              <div class="sp-wh-cluster">
                <div class="sp-wh-cluster-name">${esc(c.cluster_name)}</div>
                ${c.warehouses.map(w => `
                  <label class="sp-wh-item">
                    <input type="radio" name="wh" value="${w.warehouse_id}">
                    <span class="sp-wh-radio"></span>
                    <span class="sp-wh-body">
                      <span class="sp-wh-name">${esc(w.name)}</span>
                      ${w.address ? `<span class="sp-wh-addr">${esc(w.address)}</span>` : ''}
                    </span>
                    ${w.travel_time_days != null ? `<span class="sp-wh-eta">~${w.travel_time_days} дн. в пути</span>` : ''}
                  </label>`).join('')}
              </div>`).join('')}
          </div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" id="sp-wz-back">← Состав</button>
            <button type="button" class="sp-btn sp-btn-primary" id="sp-wz-slots" disabled>Выбрать дату →</button>
          </div>
        </div>`;
      const nextBtn = ov.body.querySelector('#sp-wz-slots') as HTMLButtonElement;
      ov.body.querySelectorAll<HTMLInputElement>('input[name=wh]').forEach(r => {
        r.addEventListener('change', () => { warehouseId = Number(r.value); nextBtn.disabled = false; });
      });
      ov.body.querySelector('#sp-wz-back')?.addEventListener('click', renderItems);
      nextBtn.addEventListener('click', pickSlot);
    };

    // ── Шаг 3: таймслот ─────────────────────────────────────────────────────
    const pickSlot = async () => {
      ov.body.innerHTML = `${stepBar(2)}
        <div class="sp-loading-inline" style="padding:32px 0">${I.loader()} Загружаем окна приёмки…</div>`;
      const dateFrom = new Date().toISOString().slice(0, 10);
      const dateTo = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      let slotData: Awaited<ReturnType<typeof ozonApi.getDraftTimeslots>> = [];
      try {
        slotData = await ozonApi.getDraftTimeslots(creds, {
          draftId: draft!.draftId, warehouseIds: [warehouseId], dateFrom, dateTo,
        });
      } catch (err: any) {
        ov.body.innerHTML = `${stepBar(2)}
          <div class="sp-error-block" style="margin:0"><div class="sp-error-text">${esc(err.message)}</div></div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" id="sp-wz-back2">← Склад</button>
            <button type="button" class="sp-btn sp-btn-ghost" data-close>Закрыть</button>
          </div>`;
        ov.body.querySelector('#sp-wz-back2')?.addEventListener('click', calcDraft);
        return;
      }

      const days = (slotData.find(w => w.warehouse_id === warehouseId) ?? slotData[0])?.days ?? [];
      const withSlots = days.filter(d => d.slots.length);
      if (!withSlots.length) {
        ov.body.innerHTML = `${stepBar(2)}
          <div class="sp-error-block" style="margin:0">
            <div class="sp-error-text">На ближайший месяц у этого склада нет свободных окон приёмки.
            Выберите другой склад или попробуйте позже.</div>
          </div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" id="sp-wz-back2">← Другой склад</button>
            <button type="button" class="sp-btn sp-btn-ghost" data-close>Закрыть</button>
          </div>`;
        ov.body.querySelector('#sp-wz-back2')?.addEventListener('click', calcDraft);
        return;
      }

      const fmtDay = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
      };
      const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      ov.body.innerHTML = `
        ${stepBar(2)}
        <div class="sp-form">
          <div class="sp-help-note" style="margin-bottom:10px">Выберите окно, когда привезёте товар на склад.</div>
          <div class="sp-slot-days">
            ${withSlots.map(d => `
              <div class="sp-slot-day">
                <div class="sp-slot-day-name">${fmtDay(d.date)}</div>
                <div class="sp-slot-row">
                  ${d.slots.map(s => `
                    <label class="sp-slot-label">
                      <input type="radio" name="slot" value="${esc(s.from)}|${esc(s.to)}" hidden>
                      <span class="sp-slot">${fmtTime(s.from)}–${fmtTime(s.to)}</span>
                    </label>`).join('')}
                </div>
              </div>`).join('')}
          </div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" id="sp-wz-back2">← Склад</button>
            <button type="button" class="sp-btn sp-btn-primary" id="sp-wz-create" disabled>${I.plus()} Создать заявку</button>
          </div>
        </div>`;
      const createBtn = ov.body.querySelector('#sp-wz-create') as HTMLButtonElement;
      let chosen = '';
      ov.body.querySelectorAll<HTMLInputElement>('input[name=slot]').forEach(r => {
        r.addEventListener('change', () => { chosen = r.value; createBtn.disabled = false; });
      });
      ov.body.querySelector('#sp-wz-back2')?.addEventListener('click', calcDraft);
      createBtn.addEventListener('click', async () => {
        const [from, to] = chosen.split('|');
        ov.body.innerHTML = `${stepBar(2)}
          <div class="sp-loading-inline" style="flex-direction:column;gap:10px;padding:32px 0">
            ${I.loader()}<div>Создаём заявку в Ozon…</div>
          </div>`;
        try {
          const { operationId } = await ozonApi.createSupplyFromDraft(creds, {
            draftId: draft!.draftId, warehouseId, timeslot: { from, to },
          });
          if (!operationId) throw new Error('Ozon не вернул operation_id заявки');
          const supplyId = await ozonApi.waitForSupplyCreate(creds, operationId);
          ov.el.remove();
          showToast(`Заявка на поставку создана (№ ${supplyId})`, 'success');
          this.showReco = false;
          await this.loadSupplies();
          const found = this.supplies.find(s => s.id === supplyId);
          if (found) { this.detail = found; this.detailTab = 'items'; this.detailItems = []; this.loadDetailItems(); }
          this.flush();
        } catch (err: any) {
          ov.body.innerHTML = `${stepBar(2)}
            <div class="sp-error-block" style="margin:0"><div class="sp-error-text">${esc(err.message)}</div></div>
            <div class="sp-form-footer"><button type="button" class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
        }
      });
    };

    renderItems();
  }

  private async openWbWizard(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    const store = this.getStore();
    if (!store) { showToast('Магазин не найден', 'error'); return; }
    const ov = this.modal('Создать поставку WB из новых заказов');
    ov.body.innerHTML = `<div class="sp-loading-inline">${I.loader()} Загружаем новые FBW-заказы...</div>`;

    let orders: any[] = [];
    try {
      orders = await wbApi.getNewOrders(store.api_key);
    } catch (err: any) {
      ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-text">${esc(err.message)}</div>
        <p style="font-size:12px;color:var(--text2);margin-top:8px">Проверьте, что токен WB имеет права «Поставки» и магазин работает по схеме FBW.</p>
      </div>
      <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
      return;
    }

    if (!orders.length) {
      ov.body.innerHTML = `<div class="sp-empty" style="height:80px">
        <p>Новых FBW-заказов нет</p>
        <p style="font-size:11px;color:var(--text2);margin-top:6px">Заказы появятся когда покупатели оформят их на WB</p>
      </div>
      <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
      return;
    }

    const grouped: Map<string, { article: string; count: number; ids: number[] }> = new Map();
    for (const o of orders) {
      const art = String(o.article ?? o.offerId ?? o.supplierArticle ?? o.id ?? '');
      const ex = grouped.get(art);
      if (ex) { ex.count++; ex.ids.push(o.id); }
      else grouped.set(art, { article: art, count: 1, ids: [o.id] });
    }
    const groups = [...grouped.values()];

    ov.body.innerHTML = `
      <div class="sp-form">
        <div style="font-size:13px;color:var(--text2);margin-bottom:12px">
          Найдено <strong style="color:var(--text)">${orders.length}</strong> заказов по
          <strong style="color:var(--text)">${groups.length}</strong> артикулам
        </div>
        <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
          <table class="sp-table" style="font-size:12px">
            <thead><tr>
              <th><input type="checkbox" id="sp-wiz-all" checked></th>
              <th>Артикул</th>
              <th style="text-align:right">Заказов</th>
            </tr></thead>
            <tbody>
              ${groups.map(g => `<tr>
                <td><input type="checkbox" class="sp-wiz-order" data-ids="${g.ids.join(',')}" checked></td>
                <td style="font-family:monospace">${esc(g.article)}</td>
                <td style="text-align:right;font-weight:700">${g.count}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="sp-field">
          <label class="sp-label">Название поставки</label>
          <input id="sp-wiz-name" class="sp-input" value="Поставка ${new Date().toLocaleDateString('ru-RU')}">
        </div>
        <div class="sp-form-footer">
          <button class="sp-btn sp-btn-ghost" data-close>Отмена</button>
          <button class="sp-btn sp-btn-primary" id="sp-wiz-submit">${I.plus()} Создать поставку</button>
        </div>
      </div>`;

    const allCb = ov.body.querySelector('#sp-wiz-all') as HTMLInputElement;
    allCb.addEventListener('change', () => {
      ov.body.querySelectorAll<HTMLInputElement>('.sp-wiz-order').forEach(cb => { cb.checked = allCb.checked; });
    });

    ov.body.querySelector('#sp-wiz-submit')?.addEventListener('click', async () => {
      const selected = [...ov.body.querySelectorAll<HTMLInputElement>('.sp-wiz-order:checked')]
        .flatMap(cb => cb.dataset.ids!.split(',').map(Number));
      if (!selected.length) { showToast('Выберите хотя бы один артикул', 'warning'); return; }
      const name = (ov.body.querySelector('#sp-wiz-name') as HTMLInputElement).value.trim();
      ov.el.remove();
      await this.createWbSupplyFromOrders(name, selected, store.api_key);
    });
  }

  // ── Help modal ────────────────────────────────────────────────────────────────

  private openHelpModal(defaultTab: Tab = this.tab): void {
    const ov = this.modal('Как работают поставки');
    ov.el.querySelector('.sp-modal')!.classList.add('sp-modal-wide');

    let activeTab = defaultTab;
    const render = () => {
      ov.body.innerHTML = `
        <div class="sp-help-tabs">
          ${(['ozon','wb','yandex'] as Tab[]).map(t => `
            <button class="sp-help-tab ${t===activeTab?'active':''}" data-htab="${t}">
              ${t==='ozon'?'Ozon FBO':t==='wb'?'Wildberries FBS':'Яндекс FBY'}
            </button>`).join('')}
        </div>
        <div class="sp-help-body">
          ${activeTab==='ozon' ? this.helpOzon() : activeTab==='wb' ? this.helpWb() : this.helpYm()}
        </div>`;
      ov.body.querySelectorAll('[data-htab]').forEach(btn => {
        btn.addEventListener('click', () => { activeTab = (btn as HTMLElement).dataset.htab as Tab; render(); });
      });
    };
    render();
  }

  private helpOzon(): string {
    return `
      <div class="sp-help-section">
        <h3>Что такое Ozon FBO?</h3>
        <p>FBO (Fulfillment by Ozon) — вы отгружаете товары на склад Ozon, а Ozon сам хранит, упаковывает и доставляет их покупателям.</p>
      </div>
      <div class="sp-help-section">
        <h3>Главное отличие Ozon от других МП</h3>
        <p>У Ozon <b>нельзя создать пустую поставку и потом добавлять товары</b>. Состав задаётся сразу:
        сначала вы говорите, что везёте, Ozon по этому составу подбирает доступные склады и окна приёмки,
        и только потом создаётся заявка. После создания состав <b>не редактируется</b> — только отмена и создание заново.</p>
      </div>
      <div class="sp-help-section">
        <h3>Что нужно заранее</h3>
        <ul>
          <li>API-ключ Ozon с доступом к разделу <b>«Поставки / FBO»</b></li>
          <li>Товары прошли модерацию и доступны для FBO</li>
          <li>Известны <b>числовые FBO SKU</b> товаров (не артикул продавца)</li>
        </ul>
      </div>
      <div class="sp-help-section">
        <h3>Как создать поставку — пошагово</h3>
        <ol>
          <li>Нажмите <b>«Создать»</b></li>
          <li><b>Шаг «Состав»</b> — впишите строки вида <code>FBO_SKU:количество</code>.
              Проще: откройте <b>«Пополнение»</b> и нажмите там «Создать поставку» — состав подставится сам</li>
          <li><b>Шаг «Склад»</b> — Ozon посчитает черновик (5–15 сек) и покажет склады по кластерам,
              с ориентировочным временем доставки</li>
          <li><b>Шаг «Дата приёмки»</b> — выберите свободное окно на складе</li>
          <li>Нажмите <b>«Создать заявку»</b> — она появится в списке</li>
          <li>Привезите товар на склад в выбранное окно. Этикетки грузомест печатаются в кабинете Ozon</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Частые проблемы</h3>
        <ul>
          <li><b>«Ozon не смог рассчитать черновик»</b> — почти всегда неверный SKU.
              Нужен числовой FBO SKU из карточки товара, а не ваш артикул</li>
          <li><b>«Не предложил ни одного склада»</b> — товары не прошли модерацию или недоступны для FBO</li>
          <li><b>Ошибка 403</b> — у API-ключа нет доступа к поставкам. Пересоздайте ключ с нужными правами</li>
          <li><b>Нет свободных окон</b> — склад забит, выберите другой или подождите</li>
        </ul>
      </div>`;
  }

  private helpWb(): string {
    return `
      <div class="sp-help-section">
        <h3>Это FBS, а не FBW</h3>
        <p>Вкладка работает с <b>FBS</b> (продажа со склада продавца): товар лежит у вас, под каждый заказ
        приходит сборочное задание, вы собираете их в поставку и везёте в пункт приёма WB.
        API Wildberries управляет именно этими поставками.</p>
        <p><b>FBW</b> (товар лежит на складе WB) через это API не заводится — такие поставки
        создаются в кабинете WB, раздел «Поставки».</p>
      </div>
      <div class="sp-help-section">
        <h3>Что нужно заранее</h3>
        <ul>
          <li>Токен WB с категорией <b>«Маркетплейс»</b> (не только «Контент»)</li>
          <li>Есть новые заказы — сборочные задания в статусе «новое»</li>
        </ul>
      </div>
      <div class="sp-help-section">
        <h3>Способ 1: Из новых заказов (рекомендуется)</h3>
        <ol>
          <li>Нажмите <b>«Из заказов»</b> — загрузятся новые сборочные задания</li>
          <li>Отметьте нужные артикулы, задайте название поставки</li>
          <li>Нажмите <b>«Создать поставку»</b> — задания добавятся автоматически</li>
          <li>В карточке нажмите <b>«Передать в доставку»</b></li>
          <li>Скачайте <b>QR-код</b> и везите товар в пункт приёма WB</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Способ 2: Вручную</h3>
        <ol>
          <li>Нажмите <b>«Создать»</b> и задайте название — поставка создастся пустой</li>
          <li>Добавьте задания через <b>ЛК WB → Поставки</b></li>
          <li>Вернитесь сюда и нажмите «Передать в доставку»</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Частые проблемы</h3>
        <ul>
          <li><b>«Нет новых заказов»</b> — заказы ещё не поступили либо уже в другой поставке</li>
          <li><b>Ошибка доступа</b> — у токена нет категории «Маркетплейс»</li>
          <li><b>Статус не меняется</b> — WB обновляет статусы асинхронно, обновите через пару минут</li>
          <li><b>Отмена</b> — WB не даёт отменять поставки через API, удаляйте в кабинете</li>
        </ul>
      </div>`;
  }

  private helpYm(): string {
    return `
      <div class="sp-help-section">
        <h3>Что такое Яндекс FBY?</h3>
        <p>FBY (Fulfillment by Yandex) — вы отгружаете товары на склад Яндекса, Яндекс хранит и доставляет их.</p>
      </div>
      <div class="sp-help-section">
        <h3>Важное ограничение Маркета</h3>
        <p>Partner API Яндекс Маркета для FBY работает <b>только на чтение</b>. Метода создания заявки
        на поставку в нём нет — заявка заводится в кабинете Маркета. SimaDesk показывает список заявок,
        их статусы, состав и документы, но создать заявку отсюда невозможно. Это ограничение Яндекса.</p>
      </div>
      <div class="sp-help-section">
        <h3>Что нужно заранее</h3>
        <ul>
          <li>В настройках магазина заполнен <b>Campaign ID</b> (ЯМ → Настройки → О магазине)</li>
          <li>У API-ключа есть доступ <b>«Поставки, вывоз и утилизация»</b></li>
          <li>Магазин работает по схеме <b>FBY</b></li>
        </ul>
      </div>
      <div class="sp-help-section">
        <h3>Как поставить товар на склад Яндекса</h3>
        <ol>
          <li>Кабинет Маркета → <b>Товары → Поставки → Создать заявку</b></li>
          <li>Выберите склад, дату приёмки и соберите состав</li>
          <li>Вернитесь в SimaDesk и нажмите <b>«Обновить»</b> — заявка появится в списке</li>
          <li>Следите за статусом здесь, документы — на вкладке «Документы»</li>
          <li>Привезите товар на склад в назначенное окно</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Частые проблемы</h3>
        <ul>
          <li><b>«Campaign ID не задан»</b> — Настройки → Магазины → ваш ЯМ-магазин</li>
          <li><b>«Маркет не отдаёт заявки»</b> — обычно Campaign ID от другого магазина, либо магазин не FBY</li>
          <li><b>Ошибка доступа</b> — выдайте ключу доступ «Поставки, вывоз и утилизация»</li>
          <li><b>Магазин на FBS/DBS</b> — товар хранится у вас, поставки на склад Маркета не нужны</li>
        </ul>
      </div>`;
  }

  // ── API Actions ───────────────────────────────────────────────────────────────

  private async createWbSupply(name: string): Promise<void> {
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) { showToast('Магазин не найден', 'error'); return; }
      const { supplyId } = await wbApi.createWbSupply(store.api_key, name);
      showToast('Поставка создана', 'success');
      await this.loadSupplies();
      if (supplyId) {
        const found = this.supplies.find(s => s.id === supplyId);
        if (found) { this.detail = found; this.detailTab = 'overview'; }
      }
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
  }

  private async createWbSupplyFromOrders(name: string, orderIds: number[], apiKey: string): Promise<void> {
    this.busy = true; this.flush();
    try {
      const { supplyId } = await wbApi.createWbSupply(apiKey, name);
      if (!supplyId) throw new Error('WB не вернул ID поставки');
      await wbApi.addOrdersToSupply(apiKey, supplyId, orderIds);
      showToast(`Поставка «${name}» создана с ${orderIds.length} заказами`, 'success');
      await this.loadSupplies();
      const found = this.supplies.find(s => s.id === supplyId);
      if (found) { this.detail = found; this.detailTab = 'overview'; }
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
  }

  /** Передать поставку в доставку — есть только у WB FBS. */
  private async sendSupply(): Promise<void> {
    if (!this.detail || this.tab !== 'wb') return;
    if (!confirm('Передать поставку в доставку? После этого состав менять нельзя.')) return;
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      await wbApi.deliverSupply(store.api_key, this.detail.id);
      showToast('Поставка передана в доставку', 'success');
      this.detail.status = 'sent';
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
    const detailId = this.detail?.id;
    if (detailId) {
      await this.loadSupplies();
      const refreshed = this.supplies.find(s => s.id === detailId);
      if (refreshed && this.detail?.id === detailId) { this.detail = { ...refreshed }; this.flush(); }
    }
  }

  /** QR-код поставки — только WB FBS (у Ozon FBO и ЯМ FBY такого метода нет). */
  private async downloadBarcodes(): Promise<void> {
    if (!this.detail || this.tab !== 'wb') return;
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      const blob = await wbApi.getSupplyBarcodePdf(store.api_key, this.detail.id);
      this.dlBlob(blob, `wb_supply_${this.detail.id}.pdf`);
      showToast('QR-код скачан', 'success');
    } catch (err: any) {
      showToast(`Ошибка скачивания: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
  }

  /** Документы заявки — только Яндекс FBY. */
  private async openYmDocuments(): Promise<void> {
    if (!this.detail || this.tab !== 'yandex') return;
    const store = this.getStore();
    if (!store) return;
    const ov = this.modal('Документы заявки');
    ov.body.innerHTML = `<div class="sp-loading-inline">${I.loader()} Загружаем документы…</div>`;
    try {
      const docs = await getYandexSupplyRequestDocuments(store as any, this.detail.id);
      ov.body.innerHTML = docs.length
        ? `<div class="sp-form"><div class="sp-doc-list">
            ${docs.map(d => `<a class="sp-doc" href="${esc(d.url)}" target="_blank" rel="noopener">
              ${I.download()} <span>${esc(YM_DOC_TYPE[d.type] ?? d.type ?? 'Документ')}</span></a>`).join('')}
          </div></div>`
        : `<div class="sp-empty" style="height:120px"><p>По этой заявке документов пока нет</p></div>`;
    } catch (err: any) {
      ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-text">${esc(err.message)}</div></div>`;
    }
  }

  private async cancelSupply(): Promise<void> {
    if (!this.detail) return;
    if (this.tab !== 'ozon') {
      showToast(this.tab === 'wb'
        ? 'WB не даёт отменять поставки через API — удалите её в кабинете WB'
        : 'Отмена заявки FBY доступна только в кабинете Маркета', 'info');
      return;
    }
    if (!confirm('Отменить заявку на поставку? Это действие необратимо.')) return;
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      await ozonApi.cancelSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      showToast('Заявка отменена', 'success');
      this.detail = null; this.detailItems = []; this.detailReturns = [];
      await this.loadSupplies();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
  }

  private exportCsv(): void {
    if (!this.detailItems.length) return;
    const rows = [['Название', 'SKU / Артикул', 'Количество']];
    for (const item of this.detailItems) rows.push([item.name, item.sku ?? '', String(item.qty)]);
    const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    this.dlBlob(blob, `supply_${this.detail?.id ?? 'export'}.csv`);
    showToast('CSV скачан', 'success');
  }

  // ── Create supply from recommendations ───────────────────────────────────────

  private async createSupplyFromReco(): Promise<void> {
    if (this.tab !== 'ozon') {
      showToast('Автосоздание из рекомендаций работает только для Ozon FBO — единственный МП, где API позволяет задать состав поставки', 'info');
      return;
    }
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    const store = this.getStore();
    if (!store) { showToast('Магазин не найден', 'error'); return; }

    // Sync qty values from DOM inputs before reading
    this.el.querySelectorAll<HTMLInputElement>('[data-reco-idx]').forEach(inp => {
      const idx = Number(inp.dataset.recoIdx);
      if (this.recoItems[idx] !== undefined) {
        this.recoItems[idx].recoQty = Math.max(0, parseInt(inp.value) || 0);
      }
    });

    // offer_id → FBO SKU: StockModule хранит только артикул продавца,
    // а черновику Ozon нужен числовой FBO SKU из карточки товара.
    const products = await ozonDb.getProducts().catch(() => [] as any[]);
    const skuByOfferId = new Map<string, number>(
      (products as any[])
        .filter(p => p.store_id === this.storeId && p.sku)
        .map(p => [String(p.offer_id), Number(p.sku)]),
    );

    const skipped: string[] = [];
    const items: Array<{ sku: number; quantity: number; name?: string }> = [];
    for (const r of this.recoItems) {
      if (r.recoQty <= 0) continue;
      const fboSku = skuByOfferId.get(r.sku);
      if (!fboSku) { skipped.push(r.name); continue; }
      items.push({ sku: fboSku, quantity: r.recoQty, name: r.name });
    }

    if (!items.length) {
      showToast(
        skipped.length
          ? `Не нашли FBO SKU ни для одного товара (${skipped.length} шт.). Синхронизируйте товары в разделе «Склад».`
          : 'Укажите количество хотя бы для одного товара',
        'warning',
      );
      return;
    }
    if (skipped.length) {
      showToast(`${skipped.length} товаров пропущено — нет FBO SKU. Синхронизируйте «Склад».`, 'info');
    }
    // Дальше — обычный мастер Ozon, но с уже заполненным составом
    this.openOzonWizard(items);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private getStore(): Record<string, any> | null {
    return this.stores.find(s => s.id === this.storeId) ?? null;
  }

  private dlBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  private calcStats(): void {
    const by = (g: StatusGroup) => this.supplies.filter(s => statusInfo(s.status).group === g).length;
    this.supplyStats = {
      draft:     by('draft'),
      sending:   by('sending'),
      delivered: by('delivered'),
      cancelled: by('cancelled'),
    };
  }

  // ── AI Public API ─────────────────────────────────────────────────────────────

  /** Список заявок FBY. Создание через API Маркет не поддерживает — только чтение. */
  async aiListYmSupplyRequests(): Promise<string> {
    if (!this.storeId && this.stores.length) this.storeId = this.stores[0].id;
    const store = this.getStore();
    if (!store) throw new Error('Нет магазинов Яндекс Маркет');
    if (!store.campaign_id) throw new Error('У магазина не заполнен Campaign ID');
    const list = await getYandexSupplyRequests(store as any, {
      dateFrom: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
      dateTo: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
      types: ['SUPPLY'],
    });
    if (!list.length) return 'Заявок на поставку FBY не найдено за последние 90 дней.';
    return `Заявки на поставку FBY (${list.length}):\n` + list.map(r =>
      `  • ${r.externalId || r.id} — ${statusInfo(r.status).text}` +
      `${r.warehouseName ? `, склад ${r.warehouseName}` : ''}` +
      `${r.planIntervalFrom ? `, приёмка с ${r.planIntervalFrom.slice(0, 10)}` : ''}`,
    ).join('\n') +
    '\n\nСоздать заявку FBY через API нельзя — Маркет разрешает это только в своём кабинете.';
  }

  async aiCreateWbSupplyFromNewOrders(name?: string): Promise<string> {
    if (!this.storeId && this.stores.length) this.storeId = this.stores[0].id;
    if (!this.storeId) throw new Error('Нет WB магазинов');
    const store = this.getStore();
    if (!store) throw new Error('Магазин не найден');
    const orders = await wbApi.getNewOrders(store.api_key);
    if (!orders.length) return 'Новых заказов для поставки нет';
    const supplyName = name ?? `Поставка ${new Date().toLocaleDateString('ru-RU')}`;
    await this.createWbSupplyFromOrders(supplyName, orders.map((o: any) => o.id), store.api_key);
    return `Создана поставка "${supplyName}" с ${orders.length} заказами`;
  }

  // ── Modal helper ──────────────────────────────────────────────────────────────

  private modal(title: string): { el: HTMLDivElement; body: HTMLDivElement } {
    const el = document.createElement('div');
    el.className = 'sp-overlay';
    el.innerHTML = `
      <div class="sp-modal">
        <div class="sp-modal-head">
          <span>${title}</span>
          <button data-close class="sp-modal-close">✕</button>
        </div>
        <div class="sp-modal-body"></div>
      </div>`;
    el.addEventListener('click', (e) => {
      if (e.target === el || (e.target as HTMLElement).dataset.close !== undefined) el.remove();
    });
    document.body.appendChild(el);
    return { el, body: el.querySelector('.sp-modal-body') as HTMLDivElement };
  }

  // ── CSS ───────────────────────────────────────────────────────────────────────

  private injectStyles(): void {
    if (document.getElementById('sp-styles')) return;
    const s = document.createElement('style');
    s.id = 'sp-styles';
    s.textContent = `
      .sp-root { display:flex;flex-direction:column;height:100%;min-height:0;font-family:inherit }

      /* Header */
      .sp-header {
        display:flex;align-items:center;justify-content:space-between;
        padding:10px 16px;border-bottom:1px solid var(--border);
        background:var(--bg2);flex-shrink:0;gap:12px;flex-wrap:wrap
      }
      .sp-header-left { display:flex;align-items:center;gap:10px;min-width:0 }
      .sp-header-right { display:flex;align-items:center;gap:6px;flex-wrap:wrap }
      .sp-logo-icon {
        width:32px;height:32px;border-radius:9px;
        background:linear-gradient(135deg,#f59e0b,#d97706);
        display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;flex-shrink:0
      }
      .sp-logo-text { font-size:15px;font-weight:800;color:var(--text);white-space:nowrap }

      /* Tabs */
      .sp-tabs { display:flex;gap:2px;background:var(--bg3);border-radius:8px;padding:2px }
      .sp-tab {
        padding:5px 14px;border:none;border-radius:6px;font-size:12px;font-weight:600;
        color:var(--text2);cursor:pointer;background:none;
        transition:background .2s ease, color .2s ease, box-shadow .2s ease, opacity .15s ease;
        white-space:nowrap
      }
      .sp-tab.active {
        background:var(--bg2);color:var(--text);
        box-shadow:0 1px 4px rgba(0,0,0,.12), 0 0 0 1px rgba(0,0,0,.04)
      }
      .sp-tab:hover:not(.active):not(:disabled) { color:var(--text);background:rgba(0,0,0,.04) }
      .sp-tab.disabled, .sp-tab:disabled {
        opacity:.38;cursor:not-allowed;pointer-events:none
      }

      /* Технические детали ошибки — по клику, чтобы не пугать кодами */
      .sp-error-details { margin-top:8px;font-size:11px;color:var(--text3);max-width:520px }
      .sp-error-details summary { cursor:pointer;user-select:none }
      .sp-error-details summary:hover { color:var(--text2) }
      .sp-error-details code {
        display:block;margin-top:6px;padding:8px 10px;border-radius:7px;background:var(--bg3);
        font-size:11px;line-height:1.5;word-break:break-word;text-align:left;color:var(--text2)
      }

      /* ── Мастер создания поставки ─────────────────────────────────────── */
      .sp-steps { display:flex;align-items:center;gap:6px;margin-bottom:18px;flex-wrap:wrap }
      .sp-step-pill {
        display:flex;align-items:center;gap:7px;padding:6px 13px;border-radius:20px;
        font-size:12px;font-weight:600;color:var(--text2);background:var(--bg3);
        transition:background .2s ease,color .2s ease
      }
      .sp-step-pill .sp-step-num {
        width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:11px;font-weight:700;background:var(--bg2);color:var(--text2)
      }
      .sp-step-pill.active { background:#6366f1;color:#fff }
      .sp-step-pill.active .sp-step-num { background:rgba(255,255,255,.25);color:#fff }
      .sp-step-pill.done { background:rgba(16,185,129,.13);color:#10b981 }
      .sp-step-pill.done .sp-step-num { background:#10b981;color:#fff }
      .sp-step-sep { flex:1;height:2px;background:var(--border);border-radius:1px;min-width:12px }

      /* Выбор склада */
      .sp-wh-list { max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:14px }
      .sp-wh-cluster-name {
        font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
        color:var(--text3);margin-bottom:6px
      }
      .sp-wh-item {
        display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;
        border:1px solid var(--border);cursor:pointer;margin-bottom:6px;
        transition:border-color .15s ease,background .15s ease
      }
      .sp-wh-item:hover { border-color:#6366f1;background:var(--bg3) }
      .sp-wh-item input { display:none }
      .sp-wh-radio {
        width:17px;height:17px;border-radius:50%;border:2px solid var(--border);flex-shrink:0;
        transition:border-color .15s ease,box-shadow .15s ease
      }
      .sp-wh-item input:checked ~ .sp-wh-radio { border-color:#6366f1;box-shadow:inset 0 0 0 4px #6366f1 }
      .sp-wh-item:has(input:checked) { border-color:#6366f1;background:rgba(99,102,241,.07) }
      .sp-wh-body { display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 }
      .sp-wh-name { font-size:13px;font-weight:600;color:var(--text) }
      .sp-wh-addr { font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .sp-wh-eta { font-size:11px;color:var(--text2);white-space:nowrap;flex-shrink:0 }

      /* Выбор таймслота */
      .sp-slot-days { max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:12px }
      .sp-slot-day-name {
        font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
        color:var(--text3);margin-bottom:5px
      }
      .sp-slot-row { display:flex;flex-wrap:wrap;gap:6px }

      /* Плашки-пояснения */
      .sp-callout { padding:11px 13px;border-radius:9px;font-size:12px;line-height:1.6;margin-bottom:12px }
      .sp-callout p { margin:6px 0 0 }
      .sp-callout-info { background:rgba(99,102,241,.09);border-left:3px solid #6366f1;color:var(--text) }
      .sp-callout-warn { background:rgba(245,158,11,.11);border-left:3px solid #f59e0b;color:var(--text) }

      /* Документы ЯМ */
      .sp-doc-list { display:flex;flex-direction:column;gap:7px }
      .sp-doc {
        display:flex;align-items:center;gap:9px;padding:11px 13px;border-radius:9px;
        border:1px solid var(--border);color:var(--text);text-decoration:none;font-size:13px;font-weight:600;
        transition:border-color .15s ease,background .15s ease
      }
      .sp-doc:hover { border-color:#6366f1;background:var(--bg3) }

      /* Buttons */
      .sp-btn {
        display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:8px;
        font-size:12px;font-weight:600;cursor:pointer;border:none;transition:all .15s;white-space:nowrap
      }
      .sp-btn-primary { background:#f59e0b;color:#fff }
      .sp-btn-primary:hover:not(:disabled) { background:#d97706 }
      .sp-btn-purple { background:#6366f122;color:#6366f1;border:1px solid #6366f133 }
      .sp-btn-purple:hover:not(:disabled) { background:#6366f133 }
      .sp-btn-ghost { background:var(--bg3);color:var(--text2);border:1px solid var(--border) }
      .sp-btn-ghost:hover:not(:disabled) { color:var(--text);background:var(--bg2) }
      .sp-btn-active { background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44 }
      .sp-btn-danger { background:#ef444422;color:#ef4444;border:1px solid #ef444433 }
      .sp-btn-danger:hover:not(:disabled) { background:#ef444433 }
      .sp-btn:disabled { opacity:.45;cursor:default }
      .sp-btn-icon {
        display:inline-flex;align-items:center;padding:4px;border-radius:6px;border:none;
        background:none;cursor:pointer;color:var(--text2);opacity:.6;transition:opacity .15s
      }
      .sp-btn-icon:hover { opacity:1 }
      .sp-help-btn {
        width:30px;height:30px;padding:0;border-radius:50%;font-size:14px;font-weight:800;
        display:flex;align-items:center;justify-content:center
      }

      /* Select */
      .sp-select {
        height:30px;font-size:12px;background:var(--bg3);border:1px solid var(--border);
        border-radius:8px;color:var(--text);padding:0 8px;min-width:160px;cursor:pointer
      }

      /* Filter bar */
      .sp-filter-bar {
        display:flex;align-items:center;gap:8px;padding:8px 12px;
        border-bottom:1px solid var(--border);background:var(--bg2);flex-wrap:wrap;flex-shrink:0
      }
      .sp-search {
        flex:1;min-width:160px;height:30px;padding:0 10px;font-size:12px;
        background:var(--bg3);border:1px solid var(--border);border-radius:8px;
        color:var(--text);outline:none;font-family:inherit;transition:border-color .15s
      }
      .sp-search:focus { border-color:#f59e0b }

      /* KPI */
      .sp-kpi-bar {
        display:flex;gap:8px;padding:10px 16px;flex-wrap:wrap;
        border-bottom:1px solid var(--border);background:var(--bg);flex-shrink:0
      }
      .sp-kpi-tile {
        flex:1;min-width:70px;background:var(--bg2);border:1px solid var(--border);
        border-radius:10px;padding:8px 12px
      }
      .sp-kpi-label { font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:2px }
      .sp-kpi-val { font-size:22px;font-weight:800;font-variant-numeric:tabular-nums }

      /* Content */
      .sp-content { flex:1;overflow:hidden;display:flex;flex-direction:column }
      .sp-body-wrap { display:flex;flex:1;overflow:hidden }
      .sp-list-pane { flex:1;overflow-y:auto;display:flex;flex-direction:column }
      .sp-reco-pane {
        width:280px;flex-shrink:0;border-left:1px solid var(--border);
        overflow-y:auto;background:var(--bg2)
      }

      /* Supply list */
      .sp-supply-list { display:flex;flex-direction:column }
      .sp-supply-row {
        display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;
        transition:background .12s;gap:8px
      }
      .sp-supply-row:hover { background:var(--bg3) }
      .sp-supply-row-left { display:flex;align-items:center;gap:10px;min-width:0;flex:1 }
      .sp-supply-row-right { display:flex;align-items:center;gap:8px;flex-shrink:0 }
      .sp-supply-status-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0 }
      .sp-supply-info { min-width:0 }
      .sp-supply-name { font-weight:600;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .sp-supply-meta { display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);margin-top:1px }
      .sp-supply-id { font-size:10px;background:var(--bg3);padding:1px 5px;border-radius:4px }
      .sp-supply-items-count { text-align:right;min-width:40px }
      .sp-chevron { color:var(--text2);font-size:18px;line-height:1;margin-left:2px }

      /* Status chip */
      .sp-chip {
        display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;
        background:color-mix(in srgb, var(--c) 15%, transparent);color:var(--c)
      }

      /* Badges */
      .sp-badge { display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.3px }
      .sp-badge-red    { background:#ef444422;color:#ef4444 }
      .sp-badge-orange { background:#f9731622;color:#f97316 }
      .sp-badge-yellow { background:#eab30822;color:#ca8a04 }
      .sp-badge-green  { background:#10b98122;color:#10b981 }

      /* Skeleton */
      .sp-skeleton-row { padding:12px 16px;border-bottom:1px solid var(--border) }
      .sp-skeleton {
        height:42px;border-radius:8px;background:var(--bg3);
        animation:sp-pulse 1.2s ease-in-out infinite
      }
      @keyframes sp-pulse { 0%,100%{opacity:.6} 50%{opacity:1} }

      /* Empty */
      .sp-empty {
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        height:200px;gap:10px;color:var(--text2);text-align:center;padding:20px;flex:1
      }
      .sp-empty-icon { font-size:36px;opacity:.25 }
      .sp-empty p { margin:0;font-size:14px }
      .sp-empty-actions { display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:center }

      /* Error block */
      .sp-error-block {
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:12px;padding:24px;text-align:center;flex:1
      }
      .sp-error-icon { font-size:32px }
      .sp-error-text { font-size:13px;color:var(--text);max-width:400px;line-height:1.5 }
      .sp-error-actions { display:flex;gap:8px }

      /* Detail */
      .sp-detail { display:flex;flex-direction:column;height:100%;overflow:hidden }
      .sp-detail-topbar {
        display:flex;align-items:center;gap:12px;padding:14px 16px;
        border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap
      }
      .sp-detail-title { display:flex;align-items:center;gap:10px;flex:1;min-width:0 }
      .sp-detail-name { font-size:15px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .sp-detail-actions { display:flex;gap:6px;flex-wrap:wrap }
      .sp-detail-meta-cards {
        display:flex;gap:10px;padding:14px 16px;flex-wrap:wrap;
        border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)
      }
      .sp-meta-card {
        flex:1;min-width:110px;background:var(--bg2);border:1px solid var(--border);
        border-radius:10px;padding:10px 14px
      }
      .sp-meta-label { font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:4px }
      .sp-meta-val { font-size:13px;color:var(--text) }
      .sp-detail-tabs {
        display:flex;gap:0;border-bottom:1px solid var(--border);flex-shrink:0;
        padding:0 16px;background:var(--bg)
      }
      .sp-detail-tab {
        padding:10px 16px;border:none;background:none;font-size:13px;font-weight:600;
        color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;
        transition:all .15s
      }
      .sp-detail-tab.active { color:#f59e0b;border-bottom-color:#f59e0b }
      .sp-detail-tab:hover:not(.active) { color:var(--text) }
      .sp-detail-body { flex:1;overflow-y:auto;padding:16px }

      /* Progress */
      .sp-detail-overview { display:flex;flex-direction:column;gap:20px }
      .sp-progress-section { background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px }
      .sp-progress-label { font-size:13px;font-weight:700;margin-bottom:10px }
      .sp-progress-track { height:6px;background:var(--bg3);border-radius:3px;margin-bottom:14px;overflow:hidden }
      .sp-progress-fill { height:100%;border-radius:3px;transition:width .5s ease }
      .sp-progress-steps { display:flex;justify-content:space-between }
      .sp-progress-step { display:flex;flex-direction:column;align-items:center;gap:4px;flex:1 }
      .sp-step-dot { width:10px;height:10px;border-radius:50%;background:var(--bg3);border:2px solid var(--border);transition:all .3s }
      .sp-progress-step.done .sp-step-dot { background:var(--c,#10b981);border-color:var(--c,#10b981) }
      .sp-step-label { font-size:10px;color:var(--text2);text-align:center }
      .sp-tips { display:flex;flex-direction:column;gap:8px }
      .sp-tip {
        font-size:12px;color:var(--text2);background:var(--bg2);border:1px solid var(--border);
        border-radius:8px;padding:10px 12px;line-height:1.6
      }

      /* Table */
      .sp-table { width:100%;border-collapse:collapse }
      .sp-table th {
        text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);
        padding:8px 10px;border-bottom:1px solid var(--border);font-weight:600
      }
      .sp-table td { padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text) }
      .sp-table tr:last-child td { border-bottom:none }
      .sp-table tr:hover td { background:var(--bg3) }

      /* Reco */
      .sp-reco { padding:12px;display:flex;flex-direction:column;gap:8px }
      .sp-reco-header { display:flex;align-items:center;justify-content:space-between }
      .sp-reco-loading { display:flex;flex-direction:column;gap:8px }
      .sp-reco-empty { font-size:12px;color:var(--text2);line-height:1.5 }
      .sp-reco-legend { display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2) }
      .sp-reco-list { display:flex;flex-direction:column;gap:8px }
      .sp-reco-item { background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px }
      .sp-reco-item-top { display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:3px }
      .sp-reco-name { font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 }
      .sp-reco-item-sub { font-size:11px;color:var(--text2);display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px }

      /* Loading */
      .sp-loading-inline { display:flex;align-items:center;gap:8px;color:var(--text2);font-size:13px;padding:16px }

      /* Modal */
      .sp-overlay {
        position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;
        display:flex;align-items:center;justify-content:center
      }
      .sp-modal {
        background:var(--bg2);border:1px solid var(--border);border-radius:16px;
        width:460px;max-width:92vw;max-height:85vh;overflow:hidden;
        display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)
      }
      .sp-modal-wide { width:600px }
      .sp-modal-head {
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px;border-bottom:1px solid var(--border);
        font-size:14px;font-weight:800;flex-shrink:0
      }
      .sp-modal-close { background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;line-height:1 }
      .sp-modal-body { overflow-y:auto;padding:20px }

      /* Form */
      .sp-form { display:flex;flex-direction:column;gap:14px }
      .sp-field { display:flex;flex-direction:column;gap:4px }
      .sp-label { font-size:12px;color:var(--text2) }
      .sp-input {
        width:100%;box-sizing:border-box;padding:8px 12px;background:var(--bg3);
        border:1px solid var(--border);border-radius:8px;color:var(--text);
        font-size:13px;outline:none;font-family:inherit;transition:border-color .15s
      }
      .sp-input:focus { border-color:#f59e0b }
      .sp-form-footer { display:flex;gap:8px;justify-content:flex-end;margin-top:4px }
      .sp-help-note {
        font-size:11px;color:var(--text2);background:var(--bg3);border-radius:8px;
        padding:8px 10px;line-height:1.6;border:1px solid var(--border)
      }
      .sp-help-note code { background:var(--bg2);padding:1px 4px;border-radius:3px;font-size:11px }

      /* Slots */
      .sp-slots { display:flex;flex-wrap:wrap;gap:6px }
      .sp-slot-label input:checked + .sp-slot {
        background:#f59e0b22;border-color:#f59e0b88;color:#f59e0b;font-weight:700
      }
      .sp-slot {
        display:inline-block;padding:5px 11px;border-radius:8px;font-size:12px;
        background:var(--bg3);border:1px solid var(--border);color:var(--text2);
        cursor:pointer;transition:all .15s
      }
      .sp-slot:hover { border-color:var(--text2) }

      /* Help modal */
      .sp-help-tabs {
        display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:0
      }
      .sp-help-tab {
        padding:8px 14px;border:none;background:none;font-size:12px;font-weight:600;
        color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;
        margin-bottom:-1px;transition:all .15s
      }
      .sp-help-tab.active { color:#f59e0b;border-bottom-color:#f59e0b }
      .sp-help-tab:hover:not(.active) { color:var(--text) }
      .sp-help-body { display:flex;flex-direction:column;gap:16px }
      .sp-help-section h3 { font-size:13px;font-weight:700;color:var(--text);margin:0 0 8px }
      .sp-help-section p { font-size:13px;color:var(--text2);line-height:1.6;margin:0 }
      .sp-help-section ul, .sp-help-section ol { margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px }
      .sp-help-section li { font-size:13px;color:var(--text2);line-height:1.5 }
      .sp-help-section b, .sp-help-section strong { color:var(--text) }
      .sp-help-section code { background:var(--bg3);padding:1px 5px;border-radius:3px;font-size:12px }
    `;
    document.head.appendChild(s);
  }

  show(): void { this.el.style.display = 'flex'; }
  hide(): void { this.el.style.display = 'none'; }
}
