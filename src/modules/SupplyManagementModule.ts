import { ozonApi } from '@/services/ozonApi';
import { wbApi } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import {
  getYandexShipments,
  getYandexAvailableSlots,
  getYandexShipmentLabels,
} from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'ozon' | 'wb' | 'yandex';

export interface Supply {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  itemsCount: number;
  done?: boolean;
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  draft:            { text: 'Черновик',    color: '#6b7280' },
  awaiting_deliver: { text: 'Ожидание',    color: '#f59e0b' },
  sent:             { text: 'Отправлена',  color: '#f59e0b' },
  delivering:       { text: 'В пути',      color: '#3b82f6' },
  delivered:        { text: 'Принята',     color: '#10b981' },
  received:         { text: 'Получена',    color: '#10b981' },
  cancelled:        { text: 'Отменена',    color: '#ef4444' },
  done:             { text: 'Завершена',   color: '#10b981' },
  // YM statuses
  CREATED:          { text: 'Создана',     color: '#6b7280' },
  ACCEPTED:         { text: 'Принята',     color: '#10b981' },
  CANCELLED_BY_PARTNER: { text: 'Отменена', color: '#ef4444' },
  READY_TO_TRANSFER: { text: 'Готова',     color: '#f59e0b' },
  TRANSFERRED:      { text: 'Передана',    color: '#3b82f6' },
};

function statusChip(s: string): string {
  const st = STATUS_LABEL[s] ?? { text: s, color: '#6b7280' };
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;
    font-size:11px;font-weight:700;letter-spacing:.3px;
    background:${st.color}22;color:${st.color}">${st.text}</span>`;
}

export class SupplyManagementModule {
  private el: HTMLElement;
  private tab: Tab = 'ozon';
  private storeId = '';
  private stores: Array<Record<string, any>> = [];
  private supplies: Supply[] = [];
  private loading = false;
  private detail: Supply | null = null;
  private detailItems: Array<{ name: string; qty: number; sku?: string }> = [];
  private detailLoading = false;

  // Public state for AI
  supplyStats: { draft: number; sending: number; delivered: number; cancelled: number } = {
    draft: 0, sending: 0, delivered: 0, cancelled: 0,
  };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden';
    this.buildShell();
    this.loadStores();
  }

  // ── Shell ───────────────────────────────────────────────────────────────────

  private buildShell(): void {
    this.el.innerHTML = `
      <div class="rpr" style="flex:1;min-height:0;display:flex;flex-direction:column">

        <div class="rpr-header">
          <div class="rpr-header-left">
            <div class="rpr-logo-icon" style="background:linear-gradient(135deg,#f59e0b,#d97706)">
              ${I.truck()}
            </div>
            <span class="rpr-logo-text">Поставки</span>
            <div class="an2-tabs" id="sp-tabs">
              ${(['ozon','wb','yandex'] as Tab[]).map(t => `
                <button class="an2-tab ${t === this.tab ? 'active' : ''}" data-tab="${t}">
                  ${t === 'ozon' ? 'Ozon FBO' : t === 'wb' ? 'Wildberries' : 'Яндекс FBY'}
                </button>`).join('')}
            </div>
          </div>
          <div class="rpr-header-actions">
            <select id="sp-store"
              style="min-width:180px;height:30px;font-size:12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:0 8px">
              <option value="">Загрузка...</option>
            </select>
            <button class="rpr-btn rpr-btn-green" id="sp-create">${I.plus()} Создать</button>
            ${this.tab === 'wb' ? `<button class="rpr-btn" style="background:#6366f122;color:#6366f1;border:1px solid #6366f133" id="sp-wizard">${I.truck()} Из заказов</button>` : ''}
            <button class="rpr-btn rpr-btn-ghost" id="sp-refresh">${I.refresh()}</button>
          </div>
        </div>

        <div id="sp-kpi"></div>

        <div class="rpr-body" id="sp-body" style="overflow:auto;flex:1">
          ${this.renderBody()}
        </div>
      </div>`;
    this.bindAll();
  }

  private updateTabUI(tabVal: Tab): void {
    this.el.querySelectorAll('.an2-tab').forEach(t =>
      t.classList.toggle('active', (t as HTMLElement).dataset.tab === tabVal));
    const actions = this.el.querySelector('.rpr-header-actions');
    if (!actions) return;
    const wizBtn = actions.querySelector('#sp-wizard');
    if (tabVal === 'wb' && !wizBtn) {
      const refreshBtn = actions.querySelector('#sp-refresh');
      const btn = document.createElement('button');
      btn.className = 'rpr-btn';
      btn.id = 'sp-wizard';
      btn.style.cssText = 'background:#6366f122;color:#6366f1;border:1px solid #6366f133';
      btn.innerHTML = `${I.truck()} Из заказов`;
      actions.insertBefore(btn, refreshBtn);
    } else if (tabVal !== 'wb' && wizBtn) {
      wizBtn.remove();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private renderKpi(): string {
    const s = this.supplyStats;
    const total = s.draft + s.sending + s.delivered + s.cancelled;
    if (!total) return '';
    const tiles = [
      { label: 'Всего',     val: total,       color: '#6366f1' },
      { label: 'Черновик',  val: s.draft,     color: '#6b7280' },
      { label: 'В пути',    val: s.sending,   color: '#3b82f6' },
      { label: 'Принято',   val: s.delivered, color: '#10b981' },
      { label: 'Отменено',  val: s.cancelled, color: '#ef4444' },
    ];
    return `<div style="display:flex;gap:8px;padding:10px 16px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      ${tiles.map(({ label, val, color }) => `
        <div style="flex:1;min-width:80px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:8px 12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:2px">${label}</div>
          <div style="font-size:20px;font-weight:800;color:${color};font-variant-numeric:tabular-nums">${val}</div>
        </div>`).join('')}
    </div>`;
  }

  private renderBody(): string {
    if (this.detail) return this.renderDetail();
    if (this.loading) return this.renderSkeleton();
    return this.renderList();
  }

  private renderSkeleton(): string {
    return `<div style="padding:20px;display:flex;flex-direction:column;gap:10px">
      ${Array(5).fill(`<div style="height:42px;border-radius:8px;background:var(--bg3);animation:pulse 1.2s ease-in-out infinite"></div>`).join('')}
    </div>`;
  }

  private renderList(): string {
    if (!this.storeId) {
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;gap:12px;color:var(--text2)">
        <div style="font-size:40px;opacity:.3">${I.truck()}</div>
        <p style="margin:0;font-size:14px">Выберите магазин для загрузки поставок</p>
      </div>`;
    }
    if (!this.supplies.length) {
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;gap:12px;color:var(--text2)">
        <div style="font-size:40px;opacity:.3">${I.truck()}</div>
        <p style="margin:0;font-size:14px">Поставок нет. Нажмите <strong>«Создать»</strong>${this.tab === 'wb' ? ' или <strong>«Из заказов»</strong>' : ''}.</p>
      </div>`;
    }

    return `<table class="rpr-table" style="width:100%">
      <thead><tr>
        <th>Название / ID</th>
        <th>Статус</th>
        <th style="text-align:center">Товаров</th>
        <th>Создана</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${this.supplies.map(s => `
          <tr>
            <td>
              <div style="font-weight:600;font-size:13px">${esc(s.name)}</div>
              <div style="font-size:11px;color:var(--text2);font-family:monospace">${esc(s.id)}</div>
            </td>
            <td>${statusChip(s.status)}</td>
            <td style="text-align:center;font-variant-numeric:tabular-nums">${s.itemsCount}</td>
            <td style="color:var(--text2);font-size:12px">${new Date(s.createdAt).toLocaleDateString('ru-RU')}</td>
            <td>
              <button class="rpr-btn rpr-btn-ghost" style="padding:4px 10px;font-size:11px"
                data-action="open" data-id="${esc(s.id)}">${I.eye()} Открыть</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  private renderDetail(): string {
    const s = this.detail!;
    const isDraft = s.status === 'draft' || s.status === 'CREATED';
    const canSend = isDraft || s.status === 'awaiting_deliver';

    const itemsHtml = this.detailLoading
      ? `<div style="color:var(--text2);font-size:13px;padding:8px 0">${I.loader()} Загрузка состава...</div>`
      : this.detailItems.length
        ? `<table class="rpr-table" style="width:100%;margin-top:4px">
            <thead><tr><th>Товар / SKU</th><th style="text-align:center">Кол-во</th></tr></thead>
            <tbody>
              ${this.detailItems.map(i => `<tr>
                <td>
                  <div style="font-size:13px">${esc(i.name)}</div>
                  ${i.sku ? `<div style="font-size:11px;color:var(--text2);font-family:monospace">${esc(i.sku)}</div>` : ''}
                </td>
                <td style="text-align:center;font-variant-numeric:tabular-nums;font-weight:700">${i.qty}</td>
              </tr>`).join('')}
            </tbody>
          </table>`
        : `<p style="color:var(--text2);font-size:13px;margin:8px 0">Состав пуст или недоступен</p>`;

    return `
      <div style="max-width:720px;padding:24px;display:flex;flex-direction:column;gap:20px">

        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <button class="rpr-btn rpr-btn-ghost" id="sp-back">← Назад</button>
          <h3 style="margin:0;font-size:16px;font-weight:800">${esc(s.name)}</h3>
          ${statusChip(s.status)}
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px">
          ${[
            ['ID поставки', `<code style="font-size:11px;word-break:break-all">${esc(s.id)}</code>`],
            ['Товаров', `<strong style="font-size:18px;color:var(--text)">${s.itemsCount}</strong>`],
            ['Создана', new Date(s.createdAt).toLocaleDateString('ru-RU')],
            ['Маркетплейс', this.tab === 'ozon' ? 'Ozon FBO' : this.tab === 'wb' ? 'WB FBO' : 'ЯМ FBY'],
          ].map(([label, val]) => `
            <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
              <div style="font-size:11px;color:var(--text2);margin-bottom:4px">${label}</div>
              <div style="font-size:13px;color:var(--text)">${val}</div>
            </div>`).join('')}
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="rpr-btn rpr-btn-green" id="sp-send" ${canSend ? '' : 'disabled'}>
            ${I.send()} ${this.tab === 'yandex' ? 'Подтвердить отгрузку' : 'Отправить поставку'}
          </button>
          <button class="rpr-btn rpr-btn-ghost" id="sp-barcodes">
            ${I.download()} Штрихкоды / Этикетки
          </button>
          ${isDraft && this.tab === 'ozon' ? `
            <button class="rpr-btn rpr-btn-ghost" id="sp-add-items">
              ${I.plus()} Добавить товары
            </button>` : ''}
          ${isDraft ? `
            <button class="rpr-btn" style="background:#ef444422;color:#ef4444;border:1px solid #ef444444" id="sp-cancel">
              ${I.trash()} Отменить
            </button>` : ''}
        </div>

        <div>
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:8px">
            Состав поставки
          </div>
          ${itemsHtml}
        </div>

      </div>`;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private bindAll(): void {
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      const tabVal = btn.dataset.tab as Tab | undefined;
      if (tabVal) {
        this.tab = tabVal;
        this.storeId = '';
        this.supplies = [];
        this.detail = null;
        this.supplyStats = { draft: 0, sending: 0, delivered: 0, cancelled: 0 };
        this.updateTabUI(tabVal);
        this.flush();
        this.loadStores();
        return;
      }

      switch (btn.id) {
        case 'sp-create':  this.openCreateDialog(); break;
        case 'sp-wizard':  this.openWbWizard(); break;
        case 'sp-refresh': this.loadSupplies(); break;
        case 'sp-back':    this.detail = null; this.detailItems = []; this.flush(); break;
        case 'sp-send':    this.sendSupply(); break;
        case 'sp-barcodes': this.downloadBarcodes(); break;
        case 'sp-add-items': this.openAddItemsDialog(); break;
        case 'sp-cancel':  this.cancelSupply(); break;
      }

      if (btn.dataset.action === 'open') {
        const found = this.supplies.find(s => s.id === btn.dataset.id);
        if (found) { this.detail = found; this.detailItems = []; this.flush(); this.loadDetailItems(); }
      }
    });

    this.el.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.id === 'sp-store') {
        this.storeId = sel.value;
        this.supplies = [];
        this.supplyStats = { draft: 0, sending: 0, delivered: 0, cancelled: 0 };
        this.detail = null;
        if (this.storeId) this.loadSupplies();
        else this.flush();
      }
    });
  }

  private flush(): void {
    const body = this.el.querySelector('#sp-body');
    if (body) body.innerHTML = this.renderBody();
    const kpi = this.el.querySelector('#sp-kpi');
    if (kpi) kpi.innerHTML = this.renderKpi();
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  private async loadStores(): Promise<void> {
    const sel = this.el.querySelector('#sp-store') as HTMLSelectElement | null;
    if (!sel) return;
    this.stores = [];
    try {
      if (this.tab === 'ozon')    this.stores = await ozonDb.getStores();
      else if (this.tab === 'wb') this.stores = await wbDb.getStores();
      else                        this.stores = await yandexDb.getStores();
    } catch { /* ignore */ }

    if (!this.stores.length) {
      sel.innerHTML = '<option value="">Нет магазинов</option>';
      this.storeId = '';
      this.flush();
      return;
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

  private async loadSupplies(): Promise<void> {
    if (!this.storeId) return;
    this.loading = true;
    this.flush();

    try {
      this.supplies = [];

      if (this.tab === 'ozon') {
        const store = this.stores.find(s => s.id === this.storeId)!;
        const creds = { client_id: store.client_id, api_key: store.api_key };
        let list: any[] = [];
        try {
          list = await ozonApi.getSupplies(creds);
        } catch (err: any) {
          if (err.message?.includes('404') || err.status === 404) {
            showToast('FBO поставки недоступны — у этого магазина нет FBO-склада', 'info');
          } else { throw err; }
        }
        this.supplies = list.map(s => ({
          id: s.supply_order_id ?? s.id ?? '',
          name: s.name ?? `Поставка ${s.supply_order_id}`,
          status: s.status ?? 'draft',
          createdAt: s.created_at ?? new Date().toISOString(),
          itemsCount: s.items_count ?? s.items?.length ?? 0,
        }));

      } else if (this.tab === 'wb') {
        const store = this.stores.find(s => s.id === this.storeId)!;
        const list = await wbApi.getWbSupplies(store.api_key);
        this.supplies = list.map(s => ({
          id: s.id,
          name: s.name ?? `Поставка ${s.id}`,
          status: s.done ? 'done' : 'draft',
          createdAt: s.createdAt ?? new Date().toISOString(),
          itemsCount: s.orderCount ?? 0,
          done: s.done,
        }));

      } else {
        const store = this.stores.find(s => s.id === this.storeId)!;
        const list = await getYandexShipments(store as any, {
          dateFrom: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
        });
        this.supplies = list.map((s: any) => ({
          id: String(s.id ?? s.shipmentId ?? ''),
          name: s.externalId ? `Отгрузка #${s.externalId}` : `Отгрузка YM-${s.id}`,
          status: s.status ?? 'CREATED',
          createdAt: s.planIntervalFrom ?? new Date().toISOString(),
          itemsCount: s.orderIds?.length ?? s.ordersCount ?? 0,
        }));
      }

      this.updateStats();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.flush();
    }
  }

  private updateStats(): void {
    const draftStatuses = new Set(['draft', 'CREATED', 'awaiting_deliver']);
    const sendingStatuses = new Set(['sent', 'delivering', 'READY_TO_TRANSFER', 'TRANSFERRED']);
    const doneStatuses = new Set(['delivered', 'received', 'done', 'ACCEPTED']);
    const cancelStatuses = new Set(['cancelled', 'CANCELLED_BY_PARTNER']);
    this.supplyStats = {
      draft:     this.supplies.filter(s => draftStatuses.has(s.status)).length,
      sending:   this.supplies.filter(s => sendingStatuses.has(s.status)).length,
      delivered: this.supplies.filter(s => doneStatuses.has(s.status)).length,
      cancelled: this.supplies.filter(s => cancelStatuses.has(s.status)).length,
    };
  }

  private async loadDetailItems(): Promise<void> {
    if (!this.detail || !this.storeId) return;
    this.detailLoading = true;
    this.flush();

    try {
      const store = this.stores.find(s => s.id === this.storeId)!;

      if (this.tab === 'ozon') {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const details = await ozonApi.getSupplyDetails(creds, this.detail.id);
        const items: any[] = details?.items ?? details?.supply_order_items ?? [];
        this.detailItems = items.map((i: any) => ({
          name: i.name ?? i.product_name ?? `SKU ${i.sku}`,
          qty: i.quantity ?? i.quantity_in_supply ?? 0,
          sku: String(i.sku ?? i.offer_id ?? ''),
        }));

      } else if (this.tab === 'wb') {
        const orders = await wbApi.getSupplyOrders(store.api_key, this.detail.id);
        this.detailItems = orders.map((o: any) => ({
          name: o.article ?? o.offerId ?? `Заказ ${o.id}`,
          qty: 1,
          sku: String(o.nmId ?? o.nm_id ?? ''),
        }));

      } else {
        this.detailItems = [];
      }
    } catch (err: any) {
      this.detailItems = [];
      showToast(`Состав поставки: ${err.message}`, 'warning');
    } finally {
      this.detailLoading = false;
      this.flush();
    }
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────────

  private openCreateDialog(): void {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }

    if (this.tab === 'yandex') {
      this.openYmShipmentDialog();
      return;
    }

    const overlay = this.makeOverlay();
    overlay.innerHTML = `
      <div class="sp-modal">
        <div class="sp-modal-header">
          <span>${I.truck()} Новая поставка ${this.tab === 'ozon' ? 'Ozon FBO' : 'WB'}</span>
          <button id="sp-dlg-close">✕</button>
        </div>
        <form id="sp-dlg-form" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="sp-label">Название поставки</label>
            <input name="name" required placeholder="Название поставки"
              style="${this.inputStyle()}">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" id="sp-dlg-cancel" class="rpr-btn rpr-btn-ghost">Отмена</button>
            <button type="submit" class="rpr-btn rpr-btn-green">${I.plus()} Создать</button>
          </div>
        </form>
      </div>`;
    this.attachModalClose(overlay);
    document.body.appendChild(overlay);

    (overlay.querySelector('#sp-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (new FormData(e.target as HTMLFormElement).get('name') as string).trim();
      overlay.remove();
      await this.createSupply(name);
    });
  }

  private openYmShipmentDialog(): void {
    const slots = getYandexAvailableSlots(14);
    const overlay = this.makeOverlay();
    overlay.innerHTML = `
      <div class="sp-modal">
        <div class="sp-modal-header">
          <span>${I.truck()} Новая отгрузка Яндекс FBY</span>
          <button id="sp-dlg-close">✕</button>
        </div>
        <form id="sp-dlg-form" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="sp-label">Дата начала окна приёмки</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${slots.map(sl => `
                <label style="cursor:pointer">
                  <input type="radio" name="slotFrom" value="${sl.date}" style="display:none">
                  <span class="sp-slot-btn" data-date="${sl.date}">${sl.label}</span>
                </label>`).join('')}
            </div>
          </div>
          <div>
            <label class="sp-label">Окно приёмки (дней)</label>
            <select name="window" style="${this.inputStyle()}">
              <option value="1">1 день</option>
              <option value="2" selected>2 дня</option>
              <option value="3">3 дня</option>
              <option value="7">7 дней</option>
            </select>
          </div>
          <div>
            <label class="sp-label">Внешний ID (необязательно)</label>
            <input name="externalId" placeholder="Ваш внутренний номер" style="${this.inputStyle()}">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" id="sp-dlg-cancel" class="rpr-btn rpr-btn-ghost">Отмена</button>
            <button type="submit" class="rpr-btn rpr-btn-green">${I.plus()} Создать отгрузку</button>
          </div>
        </form>
      </div>`;

    this.attachModalClose(overlay);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      const sl = (e.target as HTMLElement).closest('.sp-slot-btn') as HTMLElement | null;
      if (!sl) return;
      overlay.querySelectorAll('.sp-slot-btn').forEach(b => (b as HTMLElement).style.cssText = this.slotInactiveStyle());
      sl.style.cssText = this.slotActiveStyle();
      const radio = overlay.querySelector<HTMLInputElement>(`input[value="${sl.dataset.date}"]`);
      if (radio) radio.checked = true;
    });

    (overlay.querySelector('#sp-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      const slotFrom = fd.get('slotFrom') as string;
      if (!slotFrom) { showToast('Выберите дату', 'warning'); return; }
      const windowDays = Number(fd.get('window') ?? 2);
      const slotTo = new Date(new Date(slotFrom).getTime() + windowDays * 86_400_000).toISOString().slice(0, 10);
      const externalId = (fd.get('externalId') as string).trim() || undefined;
      overlay.remove();
      await this.createYmShipment(slotFrom, slotTo, externalId);
    });
  }

  private async openWbWizard(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    const store = this.stores.find(s => s.id === this.storeId)!;

    const overlay = this.makeOverlay();
    overlay.innerHTML = `
      <div class="sp-modal" style="max-width:580px;width:90vw">
        <div class="sp-modal-header">
          <span>${I.truck()} Создать поставку из заказов WB</span>
          <button id="sp-dlg-close">✕</button>
        </div>
        <div id="sp-wiz-loading" style="padding:20px;text-align:center;color:var(--text2)">
          ${I.loader()} Загружаем новые заказы...
        </div>
        <div id="sp-wiz-body" style="display:none;flex-direction:column;gap:14px"></div>
      </div>`;
    this.attachModalClose(overlay);
    document.body.appendChild(overlay);

    let newOrders: any[] = [];
    try {
      newOrders = await wbApi.getNewOrders(store.api_key);
    } catch (err: any) {
      showToast(`Ошибка загрузки заказов: ${err.message}`, 'error');
    }

    const loadingEl = overlay.querySelector('#sp-wiz-loading') as HTMLElement;
    const bodyEl = overlay.querySelector('#sp-wiz-body') as HTMLElement;
    loadingEl.style.display = 'none';
    bodyEl.style.display = 'flex';

    if (!newOrders.length) {
      bodyEl.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:0 0 8px">Новых заказов, ожидающих отгрузки, нет.</p>
        <div style="display:flex;justify-content:flex-end">
          <button class="rpr-btn rpr-btn-ghost" id="sp-wiz-close">Закрыть</button>
        </div>`;
      overlay.querySelector('#sp-wiz-close')?.addEventListener('click', () => overlay.remove());
      return;
    }

    bodyEl.innerHTML = `
      <div style="font-size:13px;color:var(--text2)">Найдено <strong style="color:var(--text)">${newOrders.length}</strong> заказов, ожидающих отгрузки:</div>
      <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table class="rpr-table" style="width:100%;font-size:12px">
          <thead><tr>
            <th style="width:28px"><input type="checkbox" id="sp-wiz-all"></th>
            <th>Артикул / NM</th>
            <th>Дата</th>
          </tr></thead>
          <tbody>
            ${newOrders.map(o => `<tr>
              <td><input type="checkbox" class="sp-wiz-order" value="${o.id}" checked></td>
              <td style="font-family:monospace">${esc(String(o.article ?? o.offerId ?? o.nmId ?? o.id))}</td>
              <td style="color:var(--text2)">${o.createdAt ? new Date(o.createdAt).toLocaleDateString('ru-RU') : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div>
        <label class="sp-label">Название поставки</label>
        <input id="sp-wiz-name" placeholder="Поставка ${new Date().toLocaleDateString('ru-RU')}"
          value="Поставка ${new Date().toLocaleDateString('ru-RU')}" style="${this.inputStyle()}">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="rpr-btn rpr-btn-ghost" id="sp-wiz-cancel">Отмена</button>
        <button class="rpr-btn rpr-btn-green" id="sp-wiz-submit">${I.plus()} Создать и добавить заказы</button>
      </div>`;

    const allCb = overlay.querySelector('#sp-wiz-all') as HTMLInputElement;
    allCb.addEventListener('change', () => {
      overlay.querySelectorAll<HTMLInputElement>('.sp-wiz-order').forEach(cb => { cb.checked = allCb.checked; });
    });

    overlay.querySelector('#sp-wiz-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#sp-wiz-submit')?.addEventListener('click', async () => {
      const selected = [...overlay.querySelectorAll<HTMLInputElement>('.sp-wiz-order:checked')].map(cb => Number(cb.value));
      if (!selected.length) { showToast('Выберите хотя бы один заказ', 'warning'); return; }
      const name = (overlay.querySelector('#sp-wiz-name') as HTMLInputElement).value.trim() || `Поставка ${new Date().toLocaleDateString('ru-RU')}`;
      overlay.remove();
      await this.createWbSupplyFromOrders(name, selected, store.api_key);
    });
  }

  private async openAddItemsDialog(): Promise<void> {
    if (this.tab !== 'ozon' || !this.detail) return;
    const overlay = this.makeOverlay();
    overlay.innerHTML = `
      <div class="sp-modal">
        <div class="sp-modal-header">
          <span>${I.plus()} Добавить товары в поставку</span>
          <button id="sp-dlg-close">✕</button>
        </div>
        <form id="sp-items-form" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="sp-label">SKU и количество (по одному на строку: SKU:кол-во)</label>
            <textarea name="items" rows="6" required placeholder="12345678:10&#10;87654321:5"
              style="${this.inputStyle()};resize:vertical"></textarea>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" id="sp-dlg-cancel" class="rpr-btn rpr-btn-ghost">Отмена</button>
            <button type="submit" class="rpr-btn rpr-btn-green">${I.plus()} Добавить</button>
          </div>
        </form>
      </div>`;
    this.attachModalClose(overlay);
    document.body.appendChild(overlay);

    (overlay.querySelector('#sp-items-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = (new FormData(e.target as HTMLFormElement).get('items') as string).trim();
      const items: Array<{ sku: number; quantity: number }> = [];
      for (const line of raw.split('\n')) {
        const [skuStr, qtyStr] = line.trim().split(':');
        const sku = parseInt(skuStr);
        const quantity = parseInt(qtyStr ?? '1');
        if (!isNaN(sku) && quantity > 0) items.push({ sku, quantity });
      }
      if (!items.length) { showToast('Неверный формат. Используйте: SKU:количество', 'warning'); return; }
      overlay.remove();
      try {
        const store = this.stores.find(s => s.id === this.storeId)!;
        await ozonApi.addProductsToSupply(
          { client_id: store.client_id, api_key: store.api_key },
          this.detail!.id,
          items,
        );
        showToast(`Добавлено ${items.length} позиций`, 'success');
        await this.loadDetailItems();
      } catch (err: any) {
        showToast(`Ошибка: ${err.message}`, 'error');
      }
    });
  }

  // ── API Actions ─────────────────────────────────────────────────────────────

  private async createSupply(name: string): Promise<void> {
    const btn = this.el.querySelector('#sp-create') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.innerHTML = `${I.loader()} Создание...`; }

    try {
      const store = this.stores.find(s => s.id === this.storeId)!;
      if (this.tab === 'ozon') {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const wh = await ozonApi.getWarehouses(creds);
        if (!wh.length) throw new Error('Нет складов Ozon FBO');
        await ozonApi.createSupply(creds, wh[0].warehouse_id, name);
      } else if (this.tab === 'wb') {
        await wbApi.createWbSupply(store.api_key, name);
      }
      showToast('Поставка создана', 'success');
      await this.loadSupplies();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `${I.plus()} Создать`; }
    }
  }

  private async createYmShipment(dateFrom: string, dateTo: string, externalId?: string): Promise<void> {
    try {
      const store = this.stores.find(s => s.id === this.storeId)!;
      if (!store.campaign_id) throw new Error('campaign_id не задан для этого магазина ЯМ');
      await yandexApi.createShipment(store.api_key, Number(store.campaign_id), {
        planIntervalFrom: dateFrom,
        planIntervalTo: dateTo,
        ...(externalId ? { externalId } : {}),
      });
      showToast('Отгрузка Яндекс Маркет создана', 'success');
      await this.loadSupplies();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async createWbSupplyFromOrders(name: string, orderIds: number[], apiKey: string): Promise<void> {
    try {
      const { supplyId } = await wbApi.createWbSupply(apiKey, name);
      await wbApi.addOrdersToSupply(apiKey, supplyId, orderIds);
      showToast(`Поставка создана, добавлено ${orderIds.length} заказов`, 'success');
      await this.loadSupplies();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async sendSupply(): Promise<void> {
    if (!this.detail || !confirm('Отправить/подтвердить поставку? После этого изменения невозможны.')) return;
    try {
      const store = this.stores.find(s => s.id === this.storeId)!;
      if (this.tab === 'ozon')
        await ozonApi.sendSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      else if (this.tab === 'wb')
        await wbApi.deliverSupply(store.api_key, this.detail.id);
      else
        await yandexApi.confirmShipment(store.api_key, Number(store.campaign_id), Number(this.detail.id));
      showToast('Поставка отправлена', 'success');
      this.detail.status = this.tab === 'yandex' ? 'ACCEPTED' : 'sent';
      this.flush();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private async downloadBarcodes(): Promise<void> {
    if (!this.detail) return;
    try {
      let blob: Blob;
      const store = this.stores.find(s => s.id === this.storeId)!;
      if (this.tab === 'ozon')
        blob = await ozonApi.getSupplyBarcodes({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      else if (this.tab === 'wb')
        blob = await wbApi.getSupplyBarcodePdf(store.api_key, this.detail.id);
      else
        blob = await getYandexShipmentLabels(store as any, Number(this.detail.id));

      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href: url, download: `supply_${this.detail.id}.pdf`,
      }).click();
      URL.revokeObjectURL(url);
      showToast('Файл скачан', 'success');
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private async cancelSupply(): Promise<void> {
    if (!this.detail || !confirm('Отменить поставку?')) return;
    try {
      if (this.tab !== 'ozon') { showToast('Отмена доступна только для Ozon', 'info'); return; }
      const store = this.stores.find(s => s.id === this.storeId)!;
      await ozonApi.cancelSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      showToast('Поставка отменена', 'success');
      this.detail = null;
      this.detailItems = [];
      await this.loadSupplies();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  // ── Public AI interface ──────────────────────────────────────────────────────

  /** Вызывается из AI: вернуть доступные слоты ЯМ. */
  getYmSlots(daysAhead = 14): Array<{ date: string; label: string }> {
    return getYandexAvailableSlots(daysAhead);
  }

  /** Вызывается из AI: создать отгрузку ЯМ на конкретную дату. */
  async aiCreateYmShipment(dateStr: string, windowDays = 2): Promise<string> {
    if (!this.storeId && this.stores.length) {
      this.storeId = this.stores[0].id;
    }
    if (!this.storeId) throw new Error('Сначала выберите магазин в разделе Поставки → ЯМ');
    const dateFrom = dateStr.slice(0, 10);
    const dateTo = new Date(new Date(dateFrom).getTime() + windowDays * 86_400_000).toISOString().slice(0, 10);
    await this.createYmShipment(dateFrom, dateTo);
    return `Отгрузка создана: окно ${dateFrom} — ${dateTo}`;
  }

  /** Вызывается из AI: создать WB поставку из новых заказов. */
  async aiCreateWbSupplyFromNewOrders(supplyName?: string): Promise<string> {
    if (this.tab !== 'wb') { window.app?.navigateTo?.('supply'); }
    if (!this.storeId && this.stores.length) this.storeId = this.stores[0].id;
    if (!this.storeId) throw new Error('Нет WB магазинов');
    const store = this.stores.find(s => s.id === this.storeId)!;
    const orders = await wbApi.getNewOrders(store.api_key);
    if (!orders.length) return 'Новых заказов для поставки нет';
    const name = supplyName ?? `Поставка ${new Date().toLocaleDateString('ru-RU')}`;
    await this.createWbSupplyFromOrders(name, orders.map((o: any) => o.id), store.api_key);
    return `Создана поставка "${name}" с ${orders.length} заказами`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private makeOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    this.injectModalStyles();
    return overlay;
  }

  private attachModalClose(overlay: HTMLElement): void {
    overlay.querySelector('#sp-dlg-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#sp-dlg-cancel')?.addEventListener('click', () => overlay.remove());
  }

  private inputStyle(): string {
    return 'width:100%;box-sizing:border-box;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;font-family:inherit';
  }

  private slotInactiveStyle(): string {
    return 'display:inline-block;padding:4px 10px;border-radius:8px;font-size:12px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;transition:all .15s';
  }

  private slotActiveStyle(): string {
    return 'display:inline-block;padding:4px 10px;border-radius:8px;font-size:12px;background:#f59e0b22;border:1px solid #f59e0b88;color:#f59e0b;cursor:pointer;font-weight:700;transition:all .15s';
  }

  private injectModalStyles(): void {
    if (document.getElementById('sp-modal-css')) return;
    const style = document.createElement('style');
    style.id = 'sp-modal-css';
    style.textContent = `
      .sp-modal {
        background:var(--bg2);border:1px solid var(--border);border-radius:16px;
        padding:24px;width:440px;max-width:90vw;max-height:85vh;overflow-y:auto;
        display:flex;flex-direction:column;gap:16px;
      }
      .sp-modal-header {
        display:flex;align-items:center;justify-content:space-between;
        font-size:15px;font-weight:800;
      }
      .sp-modal-header button {
        background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;line-height:1;
      }
      .sp-label { font-size:12px;color:var(--text2);display:block;margin-bottom:4px; }
      .sp-slot-btn {
        display:inline-block;padding:4px 10px;border-radius:8px;font-size:12px;
        background:var(--bg3);border:1px solid var(--border);color:var(--text2);
        cursor:pointer;transition:all .15s;
      }
      input[type=radio]:checked + .sp-slot-btn {
        background:#f59e0b22;border-color:#f59e0b88;color:#f59e0b;font-weight:700;
      }
    `;
    document.head.appendChild(style);
  }

  show(): void { this.el.style.display = 'flex'; }
  hide(): void { this.el.style.display = 'none'; }
}
