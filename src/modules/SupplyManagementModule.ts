import { ozonApi } from '@/services/ozonApi';
import { wbApi, fetchWbReturns, fetchWbSalesAnalytics } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import {
  getYandexShipments,
  getYandexAvailableSlots,
  getYandexShipmentLabels,
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

const STATUS: Record<string, { text: string; color: string }> = {
  draft:               { text: 'Черновик',   color: '#6b7280' },
  awaiting_deliver:    { text: 'Ожидание',   color: '#f59e0b' },
  sent:                { text: 'Отправлена', color: '#f59e0b' },
  delivering:          { text: 'В пути',     color: '#3b82f6' },
  delivered:           { text: 'Принята',    color: '#10b981' },
  received:            { text: 'Получена',   color: '#10b981' },
  cancelled:           { text: 'Отменена',   color: '#ef4444' },
  done:                { text: 'Завершена',  color: '#10b981' },
  CREATED:             { text: 'Создана',    color: '#6b7280' },
  ACCEPTED:            { text: 'Принята',    color: '#10b981' },
  READY_TO_TRANSFER:   { text: 'Готова',     color: '#f59e0b' },
  TRANSFERRED:         { text: 'Передана',   color: '#3b82f6' },
  CANCELLED_BY_PARTNER:{ text: 'Отменена',   color: '#ef4444' },
};

function chip(s: string): string {
  const st = STATUS[s] ?? { text: s, color: '#6b7280' };
  return `<span class="sp-chip" style="--c:${st.color}">${st.text}</span>`;
}

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
  private detailReturnsLoading = false;
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
    this.checkConnectedMps();
    this.loadStores();
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
    const recoBtn = `<button class="sp-btn ${this.showReco ? 'sp-btn-active' : 'sp-btn-ghost'}" id="sp-reco">
      ${I.info()} Пополнение</button>`;
    return `
      <select id="sp-store" class="sp-select">
        <option value="">Загрузка...</option>
      </select>
      ${wizBtn}
      <button class="sp-btn sp-btn-primary" id="sp-create" ${this.busy ? 'disabled' : ''}>${I.plus()} Создать</button>
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
          <button class="sp-btn sp-btn-primary" id="sp-create-empty">${I.plus()} Создать поставку</button>
          ${this.tab === 'wb' ? `<button class="sp-btn sp-btn-purple" id="sp-wizard-empty">${I.truck()} Из заказов</button>` : ''}
          <button class="sp-btn sp-btn-ghost" id="sp-help-empty">? Как создать</button>
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
    if (this.tab === 'ozon') return 'Поставок Ozon FBO нет. Убедитесь, что у магазина подключён FBO-склад.';
    if (this.tab === 'wb') return 'Поставок WB нет. Создайте поставку или используйте «Из заказов».';
    return 'Отгрузок Яндекс FBY нет. Создайте первую отгрузку.';
  }

  private filteredSupplies(): Supply[] {
    const statusGroupMap: Record<string, string[]> = {
      draft:     ['draft', 'CREATED', 'awaiting_deliver'],
      sending:   ['sent', 'delivering', 'READY_TO_TRANSFER', 'TRANSFERRED'],
      delivered: ['delivered', 'received', 'done', 'ACCEPTED'],
      cancelled: ['cancelled', 'CANCELLED_BY_PARTNER'],
    };
    const allowed = this.statusFilter ? statusGroupMap[this.statusFilter] : null;
    const q = this.searchQuery.toLowerCase().trim();
    return this.supplies.filter(s => {
      if (allowed && !allowed.includes(s.status)) return false;
      if (q && !s.name.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  private renderSupplyRow(s: Supply): string {
    const st = STATUS[s.status] ?? { text: s.status, color: '#6b7280' };
    const isDraft = s.status === 'draft' || s.status === 'CREATED';
    const date = new Date(s.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return `<div class="sp-supply-row" data-action="open" data-id="${esc(s.id)}">
      <div class="sp-supply-row-left">
        <div class="sp-supply-status-dot" style="background:${st.color}"></div>
        <div class="sp-supply-info">
          <div class="sp-supply-name">${esc(s.name)}</div>
          <div class="sp-supply-meta">
            <code class="sp-supply-id">${esc(s.id)}</code>
            <span>·</span><span>${date}</span>
          </div>
        </div>
      </div>
      <div class="sp-supply-row-right">
        ${chip(s.status)}
        <div class="sp-supply-items-count">
          <span style="font-weight:700;color:var(--text)">${s.itemsCount}</span>
          <span style="font-size:11px;color:var(--text2)"> тов.</span>
        </div>
        ${isDraft ? `<button class="sp-btn-icon" title="Отправить" data-action="quick-send" data-id="${esc(s.id)}">${I.send()}</button>` : ''}
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
    const isDraft = s.status === 'draft' || s.status === 'CREATED';
    const canSend = isDraft || s.status === 'awaiting_deliver' || s.status === 'READY_TO_TRANSFER';
    return `<div class="sp-detail">
      <div class="sp-detail-topbar">
        <button class="sp-btn sp-btn-ghost" id="sp-back">← Назад</button>
        <div class="sp-detail-title">
          <span class="sp-detail-name">${esc(s.name)}</span>
          ${chip(s.status)}
        </div>
        <div class="sp-detail-actions">
          <button class="sp-btn sp-btn-primary" id="sp-send" ${canSend && !this.busy ? '' : 'disabled'}>
            ${this.busy ? I.loader() : I.send()} ${this.tab === 'yandex' ? 'Подтвердить' : 'Отправить'}
          </button>
          <button class="sp-btn sp-btn-ghost" id="sp-barcodes" ${this.busy ? 'disabled' : ''}>${I.download()} Этикетки</button>
          ${isDraft && this.tab === 'ozon' ? `<button class="sp-btn sp-btn-ghost" id="sp-add-items">${I.plus()} Товары</button>` : ''}
          ${isDraft ? `<button class="sp-btn sp-btn-danger" id="sp-cancel" ${this.busy ? 'disabled' : ''}>${I.trash()}</button>` : ''}
        </div>
      </div>

      <div class="sp-detail-meta-cards">
        ${[
          ['ID', `<code style="font-size:11px;user-select:all">${esc(s.id)}</code>`],
          ['Товаров', `<span style="font-size:20px;font-weight:800;color:var(--text)">${s.itemsCount}</span>`],
          ['Создана', new Date(s.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })],
          ['Тип', this.tab === 'ozon' ? 'Ozon FBO' : this.tab === 'wb' ? 'WB FBW' : 'ЯМ FBY'],
        ].map(([l,v]) => `<div class="sp-meta-card"><div class="sp-meta-label">${l}</div><div class="sp-meta-val">${v}</div></div>`).join('')}
      </div>

      <div class="sp-detail-tabs">
        ${(this.tab === 'yandex' ? ['overview','returns'] : ['overview','items','returns'] as DetailTab[]).map((dt: string) => `
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
    const st = STATUS[s.status] ?? { text: s.status, color: '#6b7280' };

    const steps: [string, string][] =
      this.tab === 'yandex'
        ? [['CREATED','Создана'],['READY_TO_TRANSFER','Готова'],['TRANSFERRED','Передана'],['ACCEPTED','Принята']]
        : this.tab === 'ozon'
          ? [['draft','Черновик'],['awaiting_deliver','Ожидание'],['delivering','В пути'],['delivered','Принята']]
          : [['draft','Черновик'],['sent','Отправлена'],['done','Принята WB']];

    const currentIdx = steps.findIndex(([k]) => k === s.status);
    const progressPct = steps.length > 1 && currentIdx >= 0
      ? Math.max(0, Math.min(100, (currentIdx / (steps.length - 1)) * 100))
      : currentIdx < 0 ? 0 : 100;

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
    if (this.tab === 'ozon') {
      if (status === 'draft' || status === 'awaiting_deliver') return [
        'Добавьте товары через кнопку «Товары» — вводите <b>числовой SKU Ozon</b> и количество.',
        'SKU найдёте в личном кабинете Ozon: Товары → карточка товара → FBO SKU.',
        'После добавления нажмите «Отправить» — поставка перейдёт в статус «Ожидание».',
        'Физически доставьте товар на FBO-склад Ozon в оговорённые сроки.',
      ];
      if (status === 'delivering') return ['Поставка в пути. Ожидайте приёмки на складе Ozon.'];
      if (status === 'delivered') return ['Поставка принята складом Ozon. Товары скоро появятся в остатках.'];
    }
    if (this.tab === 'wb') {
      if (status === 'draft') return [
        'Добавляйте FBW-заказы в поставку через «Из заказов» или вручную в ЛК WB.',
        'Когда товар готов, нажмите «Отправить» — поставка будет передана в доставку.',
        'Скачайте QR-код (кнопка «Этикетки») — он нужен для сдачи на ПВЗ WB.',
        'Привезите товары в любой ПВЗ WB и отсканируйте QR-код поставки.',
      ];
      if (status === 'done') return ['Поставка завершена — товары приняты WB на хранение.'];
    }
    if (this.tab === 'yandex') {
      if (status === 'CREATED') return [
        'Яндекс Маркет автоматически добавит заказы в вашу отгрузку по расписанию.',
        'Нажмите «Подтвердить» — отгрузка будет подтверждена в ЯМ.',
        'Доставьте товары на склад ЯМ в указанное окно приёмки.',
      ];
      if (status === 'READY_TO_TRANSFER' || status === 'TRANSFERRED') return [
        'Отгрузка подтверждена. Привезите товары на склад ЯМ в указанные даты.',
      ];
      if (status === 'ACCEPTED') return ['Отгрузка принята Яндекс Маркетом.'];
    }
    return [];
  }

  private renderDetailItems(): string {
    if (this.detailItemsLoading) {
      return `<div class="sp-loading-inline">${I.loader()} Загружаем состав поставки...</div>`;
    }
    if (!this.detailItems.length) {
      return `<div class="sp-empty" style="height:140px">
        <p style="font-size:13px">Состав пуст или данные недоступны</p>
        ${this.tab === 'ozon' ? `<button class="sp-btn sp-btn-primary" id="sp-add-items" style="margin-top:8px">${I.plus()} Добавить товары</button>` : ''}
        ${this.tab === 'wb' ? `<p style="font-size:11px;color:var(--text2);margin-top:6px">Состав добавляется через ЛК WB или кнопку «Из заказов»</p>` : ''}
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
    if (!this.detailReturns.length) {
      const msg = this.tab === 'yandex'
        ? 'Данные о возвратах FBY недоступны через API.'
        : 'Возвратов не найдено за последние 90 дней.';
      return `<div class="sp-empty" style="height:120px">
        <p style="font-size:13px;color:#10b981">${msg}</p>
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
            <td style="color:var(--text2);font-size:12px">${esc(r.reason ?? '—')}</td>
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
          case 'sp-back': this.detail = null; this.detailItems = []; this.detailReturns = []; this.flush(); break;
          case 'sp-send': this.sendSupply(); break;
          case 'sp-barcodes': this.downloadBarcodes(); break;
          case 'sp-add-items': this.openAddItemsDialog(); break;
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
          if (found) { this.detail = found; this.detailTab = 'overview'; this.detailItems = []; this.detailReturns = []; this.detailItemsUnavailable = false; this.flush(); }
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
    const labels: Record<Tab, string> = { ozon: 'Ozon FBO', wb: 'Wildberries', yandex: 'Яндекс FBY' };
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

  private async checkConnectedMps(): Promise<void> {
    const [ozonStores, wbStores, ymStores] = await Promise.all([
      ozonDb.getStores().catch(() => [] as any[]),
      wbDb.getStores().catch(() => [] as any[]),
      yandexDb.getStores().catch(() => [] as any[]),
    ]);
    this.connectedMps.clear();
    if (ozonStores.length > 0) this.connectedMps.add('ozon');
    if (wbStores.length > 0)   this.connectedMps.add('wb');
    if (ymStores.length > 0)   this.connectedMps.add('yandex');
    // If active tab has no stores, switch to first connected tab
    if (this.connectedMps.size > 0 && !this.connectedMps.has(this.tab)) {
      const first = (['ozon', 'wb', 'yandex'] as Tab[]).find(t => this.connectedMps.has(t));
      if (first) this.tab = first;
    }
    this.rebuildTabs();
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
    const sel = this.el.querySelector('#sp-store') as HTMLSelectElement | null;
    if (!sel) return;
    this.stores = [];
    try {
      if (this.tab === 'ozon')    this.stores = await ozonDb.getStores();
      else if (this.tab === 'wb') this.stores = await wbDb.getStores();
      else                        this.stores = await yandexDb.getStores();
    } catch { /**/ }

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
          if (err.message?.includes('404') || String(err.status) === '404') {
            this.error = 'У этого магазина нет FBO-склада Ozon. Подключите FBO в Seller Portal → Склады → Добавить склад Ozon.';
          } else {
            this.error = `Ошибка Ozon API: ${err.message}`;
          }
        }
        this.supplies = list.map(s => ({
          id: String(s.supply_order_id ?? s.id ?? ''),
          name: s.name ?? `Поставка ${s.supply_order_id ?? s.id}`,
          status: s.status ?? 'draft',
          createdAt: s.created_at ?? new Date().toISOString(),
          itemsCount: s.items_count ?? s.items?.length ?? 0,
        }));

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
        // Yandex
        const placement = store.placement_type ?? store.fulfillment_model;
        if (placement && placement !== 'FBY') {
          this.error = `Этот магазин работает по схеме ${placement}, а не FBY. ` +
            'Вкладка «Поставки» поддерживает только FBY (Fulfillment by Yandex). ' +
            (placement === 'FBS' || placement === 'DBS'
              ? 'Для FBS/DBS управляйте отгрузками напрямую в личном кабинете Яндекс Маркет.'
              : 'Если считаете это ошибкой — проверьте тип схемы в Настройках магазина.');
        } else {
        const campaign_id = store.campaign_id;
        if (!campaign_id) {
          this.error = 'У магазина не заполнен Campaign ID. Откройте Настройки → Магазины → Яндекс и укажите ID кампании (находится в ЯМ → Настройки → О магазине).';
        } else {
          try {
            const list = await getYandexShipments(store as any, {
              dateFrom: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10),
            });
            this.supplies = list.map((s: any) => ({
              id: String(s.id ?? ''),
              name: s.externalId ? `Отгрузка #${s.externalId}` : s.planIntervalFrom ? `Отгрузка ${s.planIntervalFrom.slice(0,10)}` : `Отгрузка ЯМ-${s.id}`,
              status: s.status ?? 'CREATED',
              createdAt: s.planIntervalFrom ?? new Date().toISOString(),
              itemsCount: s.ordersCount ?? s.orderIds?.length ?? 0,
            }));
          } catch (err: any) {
            const msg = String(err.message ?? '');
            if (msg.includes('404') || msg.includes('NOT_FOUND')) {
              this.error = 'Этот магазин Яндекс Маркет не использует схему FBY (Fulfillment by Yandex). ' +
                'Вкладка «Поставки» работает только с FBY-магазинами. ' +
                'Если ваш магазин работает по DBS или Экспресс — управляйте отгрузками напрямую в ЛК Яндекс Маркет. ' +
                'Если вы уверены что магазин FBY, проверьте правильность Campaign ID в настройках.';
            } else if (msg.includes('403') || msg.includes('FORBIDDEN')) {
              this.error = 'Нет доступа к отгрузкам ЯМ. Проверьте что API-ключ имеет права на управление отгрузками (FBY).';
            } else {
              this.error = `Ошибка ЯМ API: ${msg}`;
            }
          }
        }
        } // end else (placement is FBY or unknown)
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
        const d = await ozonApi.getSupplyDetails({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
        // Ozon API can return items in different shapes
        const items: any[] = d?.items ?? d?.supply_order_items ?? d?.result?.items ?? [];
        this.detailItems = items.map((i: any) => ({
          name: i.name ?? i.product_name ?? `SKU ${i.sku ?? i.offer_id ?? ''}`,
          qty: i.quantity ?? i.quant ?? 0,
          sku: String(i.sku ?? i.offer_id ?? i.product_id ?? ''),
        }));

      } else if (this.tab === 'wb') {
        const orders = await wbApi.getSupplyOrders(store.api_key, this.detail.id);
        this.detailItems = orders.map((o: any) => ({
          name: o.article ?? o.offerId ?? o.supplierArticle ?? `Заказ ${o.id}`,
          qty: 1,
          sku: String(o.nmId ?? o.nm_id ?? o.id ?? ''),
        }));

      } else {
        // YM: no direct shipment-items endpoint
        this.detailItems = [];
        this.detailItemsUnavailable = true;
      }
    } catch (err: any) {
      this.detailItems = [];
      showToast(`Состав: ${err.message}`, 'warning');
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
        // Yandex: use getYandexReturns (global for this campaign)
        try {
          const dateFrom = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
          const returns = await getYandexReturns(store as any, { dateFrom });
          this.detailReturns = returns.slice(0, 50).map((r: any) => ({
            name: r.item?.offerName ?? r.item?.offerId ?? `Заказ ${r.orderId}`,
            qty: r.item?.count ?? 1,
            reason: r.returnDecision ?? r.status ?? '—',
            date: r.creationDate ?? r.returnDate,
          }));
        } catch {
          this.detailReturns = [];
        }
      }
    } catch {
      this.detailReturns = [];
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
    if (this.tab === 'yandex') { this.openYmDialog(); return; }

    const ov = this.modal(`Новая поставка ${this.tab === 'ozon' ? 'Ozon FBO' : 'WB FBW'}`);

    if (this.tab === 'ozon') {
      ov.body.innerHTML = `<div class="sp-loading-inline">${I.loader()} Загружаем склады Ozon...</div>`;
      const store = this.getStore();
      if (!store) { ov.el.remove(); showToast('Магазин не найден', 'error'); return; }

      let warehouses: any[] = [];
      try {
        warehouses = await ozonApi.getWarehouses({ client_id: store.client_id, api_key: store.api_key });
      } catch (err: any) {
        ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
          <div class="sp-error-text">Ошибка загрузки складов: ${esc(err.message)}</div>
        </div>
        <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
        return;
      }

      // Prefer FBO warehouses (is_rfbs === false); fallback to all if none explicitly marked
      const fboWarehouses = warehouses.filter(w => w.is_rfbs === false);
      const displayWarehouses = fboWarehouses.length > 0 ? fboWarehouses : warehouses;

      if (!displayWarehouses.length) {
        ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
          <div class="sp-error-text">У магазина нет FBO-складов. Подключите FBO-склад в Ozon Seller Portal → Склады.</div>
        </div>
        <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
        return;
      }

      const warehouseField = displayWarehouses.length === 1
        ? `<input type="hidden" name="warehouseId" value="${displayWarehouses[0].warehouse_id}">
           <div class="sp-help-note">Склад: <b>${esc(displayWarehouses[0].name)}</b></div>`
        : `<div class="sp-field">
             <label class="sp-label">FBO-склад Ozon</label>
             <select name="warehouseId" class="sp-input" required>
               ${displayWarehouses.map(w => `<option value="${w.warehouse_id}">${esc(w.name)}</option>`).join('')}
             </select>
           </div>`;

      ov.body.innerHTML = `
        <form id="sp-dlg-form" class="sp-form">
          <div class="sp-field">
            <label class="sp-label">Название поставки</label>
            <input name="name" required placeholder="Например: Поставка июль 2026" class="sp-input" autofocus>
          </div>
          ${warehouseField}
          <div class="sp-help-note">После создания откроется состав поставки — там добавите товары по SKU.</div>
          <div class="sp-form-footer">
            <button type="button" class="sp-btn sp-btn-ghost" data-close>Отмена</button>
            <button type="submit" class="sp-btn sp-btn-primary">${I.plus()} Создать</button>
          </div>
        </form>`;
      (ov.body.querySelector('#sp-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target as HTMLFormElement);
        const name = (fd.get('name') as string).trim();
        const warehouseId = Number(fd.get('warehouseId'));
        ov.el.remove();
        await this.createSupply(name, warehouseId);
      });

    } else {
      // WB — simple name form
      ov.body.innerHTML = `
        <form id="sp-dlg-form" class="sp-form">
          <div class="sp-field">
            <label class="sp-label">Название поставки</label>
            <input name="name" required placeholder="Например: Поставка июль 2026" class="sp-input" autofocus>
          </div>
          <div class="sp-help-note">
            После создания добавьте FBW-заказы через ЛК WB или используйте «Из заказов» при создании.
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
        await this.createSupply(name);
      });
    }
  }

  private openYmDialog(): void {
    const store = this.getStore();
    if (!store) { showToast('Магазин не найден', 'error'); return; }
    if (!store.campaign_id) {
      this.openHelpModal('yandex');
      showToast('У магазина не задан Campaign ID — смотри инструкцию', 'warning');
      return;
    }
    const slots = getYandexAvailableSlots(14);
    const ov = this.modal('Новая отгрузка Яндекс FBY');
    ov.body.innerHTML = `
      <form id="sp-dlg-form" class="sp-form">
        <div class="sp-field">
          <label class="sp-label">Дата начала приёмки</label>
          <div class="sp-slots">
            ${slots.map((sl, i) => `
              <label class="sp-slot-label">
                <input type="radio" name="slotFrom" value="${sl.date}" ${i===0?'checked':''} style="display:none">
                <span class="sp-slot">${sl.label}</span>
              </label>`).join('')}
          </div>
        </div>
        <div class="sp-field">
          <label class="sp-label">Длительность окна приёмки</label>
          <select name="window" class="sp-input">
            <option value="1">1 день</option>
            <option value="2" selected>2 дня</option>
            <option value="3">3 дня</option>
            <option value="7">7 дней</option>
          </select>
        </div>
        <div class="sp-field">
          <label class="sp-label">Внешний ID (необязательно)</label>
          <input name="externalId" placeholder="Ваш номер для учёта" class="sp-input">
        </div>
        <div class="sp-help-note">ЯМ автоматически добавит заказы в вашу отгрузку по расписанию. После создания подтвердите её кнопкой «Подтвердить».</div>
        <div class="sp-form-footer">
          <button type="button" class="sp-btn sp-btn-ghost" data-close>Отмена</button>
          <button type="submit" class="sp-btn sp-btn-primary">${I.plus()} Создать отгрузку</button>
        </div>
      </form>`;
    (ov.body.querySelector('#sp-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      const slotFrom = fd.get('slotFrom') as string;
      const windowDays = Number(fd.get('window') ?? 2);
      const slotTo = new Date(new Date(slotFrom).getTime() + windowDays * 86_400_000).toISOString().slice(0, 10);
      ov.el.remove();
      await this.createYmShipment(slotFrom, slotTo, (fd.get('externalId') as string).trim() || undefined);
    });
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

  private async openAddItemsDialog(): Promise<void> {
    if (this.tab !== 'ozon' || !this.detail) return;
    const ov = this.modal('Добавить товары в поставку Ozon');
    ov.body.innerHTML = `
      <form id="sp-items-form" class="sp-form">
        <div class="sp-field">
          <label class="sp-label">SKU и количество (каждый товар с новой строки)</label>
          <textarea name="items" rows="6" class="sp-input" placeholder="12345678:10&#10;87654321:5" style="resize:vertical;font-family:monospace"></textarea>
        </div>
        <div class="sp-help-note">
          Формат: <code>числовой_SKU:количество</code><br>
          FBO SKU найдёте в Ozon Seller → Товары → карточка → раздел «Характеристики» → FBO SKU (числовой).
        </div>
        <div class="sp-form-footer">
          <button type="button" class="sp-btn sp-btn-ghost" data-close>Отмена</button>
          <button type="submit" class="sp-btn sp-btn-primary">${I.plus()} Добавить</button>
        </div>
      </form>`;
    (ov.body.querySelector('#sp-items-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = new FormData(e.target as HTMLFormElement).get('items') as string;
      const items: Array<{ sku: number; quantity: number }> = [];
      for (const line of raw.trim().split('\n')) {
        const [skuStr, qtyStr] = line.trim().split(':');
        const sku = parseInt(skuStr); const qty = parseInt(qtyStr ?? '1');
        if (!isNaN(sku) && qty > 0) items.push({ sku, quantity: qty });
      }
      if (!items.length) { showToast('Неверный формат. Пример: 12345:10', 'warning'); return; }
      ov.el.remove();
      try {
        const store = this.getStore();
        if (!store || !this.detail) { showToast('Магазин не найден', 'error'); return; }
        await ozonApi.addProductsToSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id, items);
        showToast(`Добавлено ${items.length} позиций`, 'success');
        this.detailItems = []; this.detailTab = 'items';
        await this.loadDetailItems();
      } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
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
              ${t==='ozon'?'Ozon FBO':t==='wb'?'Wildberries FBW':'Яндекс FBY'}
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
        <p>FBO (Fulfillment by Ozon) — модель, при которой вы отгружаете товары на склад Ozon, а Ozon сам хранит, упаковывает и доставляет их покупателям.</p>
      </div>
      <div class="sp-help-section">
        <h3>Предварительные требования</h3>
        <ul>
          <li>В <b>Ozon Seller Portal</b> подключён FBO-склад: раздел <b>Склады → Добавить склад Ozon</b></li>
          <li>API-ключ в настройках SimaDesk имеет права <b>«Поставки»</b></li>
          <li>Товары загружены в Ozon и имеют <b>FBO SKU</b> (числовой)</li>
        </ul>
      </div>
      <div class="sp-help-section">
        <h3>Как создать поставку — пошагово</h3>
        <ol>
          <li>Нажмите <b>«Создать»</b>, введите название поставки</li>
          <li>Откроется карточка поставки в статусе «Черновик»</li>
          <li>Перейдите во вкладку <b>«Состав»</b>, нажмите <b>«+ Товары»</b></li>
          <li>Введите <b>числовой FBO SKU</b> и количество (SKU есть в карточке товара Ozon Seller → Характеристики)</li>
          <li>Нажмите <b>«Отправить»</b> — поставка перейдёт в «Ожидание»</li>
          <li>Физически привезите товар на FBO-склад Ozon в согласованные сроки</li>
          <li>После приёмки статус изменится на <b>«Принята»</b></li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Частые проблемы</h3>
        <ul>
          <li><b>Ошибка 404</b> — нет FBO-склада. Подключите в Seller Portal → Склады</li>
          <li><b>Ошибка 403</b> — у API-ключа нет прав на поставки. Создайте ключ с нужными правами</li>
          <li><b>«Нет товаров в составе»</b> — добавьте SKU через кнопку «+ Товары» в карточке поставки</li>
        </ul>
      </div>`;
  }

  private helpWb(): string {
    return `
      <div class="sp-help-section">
        <h3>Что такое WB FBW?</h3>
        <p>FBW (Fulfillment by Wildberries) — вы привозите товары на склад WB, WB хранит их и отправляет покупателям. Называется также «FBO на WB».</p>
      </div>
      <div class="sp-help-section">
        <h3>Предварительные требования</h3>
        <ul>
          <li>Токен WB в настройках SimaDesk должен иметь права <b>«Поставки»</b></li>
          <li>В WB ЛК у вас активирована схема работы <b>FBW</b></li>
          <li>Покупатели уже оформили заказы (или создавайте поставку без заказов)</li>
        </ul>
      </div>
      <div class="sp-help-section">
        <h3>Способ 1: Из новых заказов (рекомендуется)</h3>
        <ol>
          <li>Нажмите <b>«Из заказов»</b> — загрузятся новые FBW-заказы</li>
          <li>Выберите нужные артикулы и задайте название поставки</li>
          <li>Нажмите <b>«Создать поставку»</b></li>
          <li>В карточке поставки нажмите <b>«Отправить»</b></li>
          <li>Скачайте <b>QR-код (Этикетки)</b> — он нужен на ПВЗ WB</li>
          <li>Привезите товары в любой ПВЗ/склад WB, предъявите QR-код</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Способ 2: Вручную</h3>
        <ol>
          <li>Нажмите <b>«Создать»</b>, задайте название</li>
          <li>Добавьте заказы в поставку через <b>ЛК WB → Поставки</b></li>
          <li>Вернитесь в SimaDesk и нажмите «Отправить»</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Частые проблемы</h3>
        <ul>
          <li><b>«Нет новых заказов»</b> — заказы ещё не поступили или уже добавлены в другую поставку</li>
          <li><b>Ошибка API</b> — проверьте что токен WB имеет права «Поставки» (не только «Контент»)</li>
          <li><b>Статус не меняется</b> — WB обновляет статусы асинхронно, обновите список через несколько минут</li>
        </ul>
      </div>`;
  }

  private helpYm(): string {
    return `
      <div class="sp-help-section">
        <h3>Что такое Яндекс FBY?</h3>
        <p>FBY (Fulfillment by Yandex) — вы отгружаете товары на склад Яндекса, Яндекс хранит и доставляет их. Это основная схема хранения на ЯМ.</p>
      </div>
      <div class="sp-help-section">
        <h3>Предварительные требования</h3>
        <ul>
          <li>В настройках магазина в SimaDesk заполнен <b>Campaign ID</b></li>
          <li>Где взять Campaign ID: <b>Яндекс Маркет → Настройки → О магазине → ID кампании</b></li>
          <li>API-ключ должен иметь права для работы с отгрузками</li>
          <li>Магазин работает по схеме <b>FBY</b> в ЯМ</li>
        </ul>
      </div>
      <div class="sp-help-section">
        <h3>Как создать отгрузку — пошагово</h3>
        <ol>
          <li>Нажмите <b>«Создать»</b></li>
          <li>Выберите <b>дату начала приёмки</b> — ближайший рабочий день когда привезёте товар</li>
          <li>Выберите <b>длительность окна</b> — сколько дней у вас займёт доставка (обычно 1–2 дня)</li>
          <li>Нажмите <b>«Создать отгрузку»</b></li>
          <li>ЯМ автоматически добавит заказы в отгрузку по плановому интервалу</li>
          <li>Нажмите <b>«Подтвердить»</b> — отгрузка будет подтверждена</li>
          <li>Привезите товары на <b>склад Яндекса</b> в указанное окно</li>
          <li>Скачайте <b>Этикетки</b> — потребуются при сдаче на склад</li>
        </ol>
      </div>
      <div class="sp-help-section">
        <h3>Частые проблемы</h3>
        <ul>
          <li><b>«Campaign ID не задан»</b> — откройте Настройки → Магазины → ваш ЯМ магазин → укажите Campaign ID</li>
          <li><b>Нет отгрузок</b> — возможно, у магазина нет активных заказов в этом периоде</li>
          <li><b>Ошибка подтверждения</b> — отгрузку нельзя подтвердить раньше определённого срока, попробуйте позже</li>
        </ul>
      </div>`;
  }

  // ── API Actions ───────────────────────────────────────────────────────────────

  private async createSupply(name: string, warehouseId?: number): Promise<void> {
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) { showToast('Магазин не найден', 'error'); return; }
      let newId = '';
      if (this.tab === 'ozon') {
        let resolvedWarehouseId = warehouseId;
        if (!resolvedWarehouseId) {
          // Fallback for AI API calls: auto-select FBO warehouse
          const warehouses = await ozonApi.getWarehouses({ client_id: store.client_id, api_key: store.api_key });
          if (!warehouses.length) throw new Error('У магазина нет складов Ozon. Подключите FBO-склад в Seller Portal.');
          const fboWh = warehouses.find(w => w.is_rfbs === false) ?? warehouses.find(w => /fbo/i.test(w.name)) ?? warehouses[0];
          resolvedWarehouseId = fboWh.warehouse_id;
        }
        const res = await ozonApi.createSupply({ client_id: store.client_id, api_key: store.api_key }, resolvedWarehouseId, name);
        newId = res.supplyId;
      } else {
        const res = await wbApi.createWbSupply(store.api_key, name);
        newId = res.supplyId;
      }
      showToast('Поставка создана', 'success');
      await this.loadSupplies();
      if (newId) {
        const found = this.supplies.find(s => s.id === newId);
        if (found) { this.detail = found; this.detailTab = 'overview'; }
      }
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
  }

  private async createYmShipment(dateFrom: string, dateTo: string, externalId?: string): Promise<void> {
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      if (!store.campaign_id) throw new Error('campaign_id не задан — укажите в настройках магазина');
      const { id: newId } = await yandexApi.createShipment(store.api_key, Number(store.campaign_id), {
        planIntervalFrom: dateFrom,
        planIntervalTo: dateTo,
        ...(externalId ? { externalId } : {}),
      });
      showToast('Отгрузка ЯМ создана', 'success');
      await this.loadSupplies();
      if (newId) {
        const found = this.supplies.find(s => s.id === String(newId));
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

  private async sendSupply(): Promise<void> {
    if (!this.detail) return;
    const confirmMsg = this.tab === 'yandex'
      ? 'Подтвердить отгрузку в Яндекс Маркет?'
      : 'Отправить поставку? После отправки редактирование будет невозможно.';
    if (!confirm(confirmMsg)) return;
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      if (this.tab === 'ozon')
        await ozonApi.sendSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      else if (this.tab === 'wb')
        await wbApi.deliverSupply(store.api_key, this.detail.id);
      else {
        if (!store.campaign_id) throw new Error('campaign_id не задан');
        await yandexApi.confirmShipment(store.api_key, Number(store.campaign_id), Number(this.detail.id));
      }
      showToast('Поставка отправлена/подтверждена', 'success');
      // Optimistic update — correct transitional status per marketplace
      const optimisticStatus =
        this.tab === 'yandex' ? 'READY_TO_TRANSFER' :
        this.tab === 'ozon'   ? 'awaiting_deliver'  : 'sent';
      if (this.detail) this.detail.status = optimisticStatus;
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
    // Reload from API after UI unlocks to get the real status
    const detailId = this.detail?.id;
    if (detailId) {
      await this.loadSupplies();
      const refreshed = this.supplies.find(s => s.id === detailId);
      if (refreshed && this.detail?.id === detailId) { this.detail = { ...refreshed }; this.flush(); }
    }
  }

  private async downloadBarcodes(): Promise<void> {
    if (!this.detail) return;
    this.busy = true; this.flush();
    try {
      let blob: Blob;
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      if (this.tab === 'ozon')
        blob = await ozonApi.getSupplyBarcodes({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      else if (this.tab === 'wb')
        blob = await wbApi.getSupplyBarcodePdf(store.api_key, this.detail.id);
      else
        blob = await getYandexShipmentLabels(store as any, Number(this.detail.id));
      this.dlBlob(blob, `supply_${this.detail.id}.pdf`);
      showToast('Этикетки скачаны', 'success');
    } catch (err: any) {
      showToast(`Ошибка скачивания: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
  }

  private async cancelSupply(): Promise<void> {
    if (!this.detail || !confirm('Отменить поставку? Это действие необратимо.')) return;
    if (this.tab !== 'ozon') { showToast('Отмена через API доступна только для Ozon', 'info'); return; }
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      await ozonApi.cancelSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      showToast('Поставка отменена', 'success');
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

    const ov = this.modal('Создать поставку из рекомендаций');
    ov.body.innerHTML = `<div class="sp-loading-inline">${I.loader()} Загружаем склады и SKU...</div>`;

    let warehouses: any[] = [];
    let products: any[] = [];
    try {
      [warehouses, products] = await Promise.all([
        ozonApi.getWarehouses({ client_id: store.client_id, api_key: store.api_key }),
        ozonDb.getProducts().catch(() => []),
      ]);
    } catch (err: any) {
      ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-text">Ошибка: ${esc(err.message)}</div>
      </div>
      <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
      return;
    }

    // offer_id → FBO SKU map for this store
    const skuByOfferId = new Map<string, number>(
      (products as any[])
        .filter(p => p.store_id === this.storeId && p.sku)
        .map(p => [String(p.offer_id), Number(p.sku)]),
    );

    const skipped: string[] = [];
    const items: Array<{ sku: number; quantity: number }> = [];
    for (const r of this.recoItems) {
      if (r.recoQty <= 0) continue;
      const fboSku = skuByOfferId.get(r.sku);
      if (!fboSku) { skipped.push(r.name); continue; }
      items.push({ sku: fboSku, quantity: r.recoQty });
    }

    if (!items.length) {
      ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-text">Нет товаров для добавления${skipped.length ? ` — у ${skipped.length} товаров не найден FBO SKU` : ''}</div>
        <p style="font-size:12px;color:var(--text2);margin-top:6px">Синхронизируйте товары в разделе «Склад» чтобы загрузить FBO SKU</p>
      </div>
      <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
      return;
    }

    const fboWarehouses = warehouses.filter(w => w.is_rfbs === false);
    const displayWarehouses = fboWarehouses.length > 0 ? fboWarehouses : warehouses;
    if (!displayWarehouses.length) {
      ov.body.innerHTML = `<div class="sp-error-block" style="margin:0">
        <div class="sp-error-text">У магазина нет FBO-складов. Подключите FBO-склад в Seller Portal → Склады.</div>
      </div>
      <div class="sp-form-footer"><button class="sp-btn sp-btn-ghost" data-close>Закрыть</button></div>`;
      return;
    }

    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    const warehouseField = displayWarehouses.length === 1
      ? `<input type="hidden" name="warehouseId" value="${displayWarehouses[0].warehouse_id}">
         <div class="sp-help-note">Склад: <b>${esc(displayWarehouses[0].name)}</b></div>`
      : `<div class="sp-field">
           <label class="sp-label">FBO-склад Ozon</label>
           <select name="warehouseId" class="sp-input">
             ${displayWarehouses.map(w => `<option value="${w.warehouse_id}">${esc(w.name)}</option>`).join('')}
           </select>
         </div>`;

    ov.body.innerHTML = `
      <form id="sp-dlg-form" class="sp-form">
        <div class="sp-field">
          <label class="sp-label">Название поставки</label>
          <input name="name" required class="sp-input" autofocus
            value="Пополнение ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}">
        </div>
        ${warehouseField}
        <div class="sp-help-note">
          ${items.length} позиций · ${totalQty} шт. — товары добавятся автоматически
          ${skipped.length ? `<br><span style="color:var(--text3)">⚠ ${skipped.length} пропущено (нет FBO SKU) — синхронизируйте «Склад»</span>` : ''}
        </div>
        <div class="sp-form-footer">
          <button type="button" class="sp-btn sp-btn-ghost" data-close>Отмена</button>
          <button type="submit" class="sp-btn sp-btn-primary">${I.plus()} Создать и добавить товары</button>
        </div>
      </form>`;

    (ov.body.querySelector('#sp-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      const name = (fd.get('name') as string).trim();
      const warehouseId = Number(fd.get('warehouseId'));
      ov.el.remove();
      await this.createSupplyWithItems(name, warehouseId, items);
    });
  }

  private async createSupplyWithItems(name: string, warehouseId: number, items: Array<{ sku: number; quantity: number }>): Promise<void> {
    this.busy = true; this.flush();
    try {
      const store = this.getStore();
      if (!store) throw new Error('Магазин не найден');
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const { supplyId } = await ozonApi.createSupply(creds, warehouseId, name);
      if (!supplyId) throw new Error('Ozon не вернул ID поставки');
      await ozonApi.addProductsToSupply(creds, supplyId, items);
      showToast(`Поставка «${name}» создана — ${items.length} позиций добавлено`, 'success');
      this.showReco = false;
      await this.loadSupplies();
      const found = this.supplies.find(s => s.id === supplyId);
      if (found) { this.detail = found; this.detailTab = 'items'; this.detailItems = []; this.loadDetailItems(); }
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.busy = false; this.flush();
    }
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
    const draft = new Set(['draft','CREATED','awaiting_deliver']);
    const send  = new Set(['sent','delivering','READY_TO_TRANSFER','TRANSFERRED']);
    const done  = new Set(['delivered','received','done','ACCEPTED']);
    const cncl  = new Set(['cancelled','CANCELLED_BY_PARTNER']);
    this.supplyStats = {
      draft:     this.supplies.filter(s => draft.has(s.status)).length,
      sending:   this.supplies.filter(s => send.has(s.status)).length,
      delivered: this.supplies.filter(s => done.has(s.status)).length,
      cancelled: this.supplies.filter(s => cncl.has(s.status)).length,
    };
  }

  // ── AI Public API ─────────────────────────────────────────────────────────────

  getYmSlots(daysAhead = 14) { return getYandexAvailableSlots(daysAhead); }

  async aiCreateYmShipment(dateStr: string, windowDays = 2): Promise<string> {
    if (!this.storeId && this.stores.length) this.storeId = this.stores[0].id;
    if (!this.storeId) throw new Error('Выберите магазин ЯМ в разделе Поставки');
    const dateFrom = dateStr.slice(0, 10);
    const dateTo = new Date(new Date(dateFrom).getTime() + windowDays * 86_400_000).toISOString().slice(0, 10);
    await this.createYmShipment(dateFrom, dateTo);
    return `Отгрузка создана: окно ${dateFrom} — ${dateTo}`;
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
