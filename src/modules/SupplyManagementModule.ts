import { ozonApi } from '@/services/ozonApi';
import { wbApi } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'ozon' | 'wb' | 'yandex';

interface Supply {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  itemsCount: number;
  storeName?: string;
}

export class SupplyManagementModule {
  private el: HTMLElement;
  private tab: Tab = 'ozon';
  private supplies: Supply[] = [];
  private storeId = '';
  private loading = false;
  private openSupply: Supply | null = null;

  constructor(container: HTMLElement) {
    this.el = container;
    this.render();
    this.loadStores();
  }

  private render(): void {
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-primary)';
    this.el.innerHTML = `
      <div class="module-page">
        <div class="module-page__header">
          <div class="module-page__title">
            <h2>${I.truck} Поставки FBO/FBY</h2>
            <p class="module-page__subtitle">Управление поставками на склады маркетплейсов</p>
          </div>
          <div class="module-page__actions">
            <button class="btn btn-success" id="sp-create">${I.plus} Создать поставку</button>
            <button class="btn btn-ghost" id="sp-refresh">${I.refresh} Обновить</button>
          </div>
        </div>

        <div class="module-tabs">
          <button class="module-tab ${this.tab === 'ozon' ? 'active' : ''}" data-tab="ozon">
            <span class="mp-dot mp-ozon"></span> Ozon FBO
          </button>
          <button class="module-tab ${this.tab === 'wb' ? 'active' : ''}" data-tab="wb">
            <span class="mp-dot mp-wb"></span> Wildberries
          </button>
          <button class="module-tab ${this.tab === 'yandex' ? 'active' : ''}" data-tab="yandex">
            <span class="mp-dot mp-yandex"></span> Яндекс FBY
          </button>
        </div>

        <div class="module-toolbar">
          <select class="form-select" id="sp-store" style="min-width:200px">
            <option value="">Загрузка магазинов...</option>
          </select>
        </div>

        <div class="module-body" id="sp-body">
          ${this.loading ? this.renderSkeleton() : this.renderSupplyList()}
        </div>
      </div>
    `;
    this.bindEvents();
  }

  private renderSkeleton(): string {
    return `<div class="skeleton-rows">${Array(5).fill('<div class="skeleton-row"></div>').join('')}</div>`;
  }

  private renderSupplyList(): string {
    if (!this.storeId) {
      return `<div class="empty-state"><div class="empty-state__icon">${I.truck}</div><p>Выберите магазин для загрузки поставок</p></div>`;
    }
    if (this.supplies.length === 0) {
      return `<div class="empty-state"><div class="empty-state__icon">${I.truck}</div><p>Нет поставок. Создайте первую поставку.</p></div>`;
    }

    const statusLabel: Record<string, string> = {
      draft: 'Черновик', sent: 'Отправлена', received: 'Принята',
      cancelled: 'Отменена', delivered: 'Доставлена',
    };

    const rows = this.supplies.map(s => `
      <tr class="clickable-row" data-id="${esc(s.id)}">
        <td><span class="supply-name">${esc(s.name)}</span></td>
        <td><span class="status-chip status-${s.status}">${statusLabel[s.status] ?? s.status}</span></td>
        <td>${s.itemsCount}</td>
        <td>${new Date(s.createdAt).toLocaleDateString('ru-RU')}</td>
        <td class="actions-cell">
          <button class="btn btn-xs" data-action="open" data-id="${esc(s.id)}">${I.eye} Открыть</button>
        </td>
      </tr>
    `).join('');

    return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Статус</th>
            <th>Товаров</th>
            <th>Создана</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private renderSupplyDetail(s: Supply): string {
    const statusLabel: Record<string, string> = {
      draft: 'Черновик', sent: 'Отправлена', received: 'Принята',
      cancelled: 'Отменена', delivered: 'Доставлена',
    };
    const isDraft = s.status === 'draft';

    return `
      <div class="detail-panel">
        <div class="detail-panel__head">
          <button class="btn btn-ghost" id="sp-back">← Назад</button>
          <div>
            <h3>${esc(s.name)}</h3>
            <span class="status-chip status-${s.status}">${statusLabel[s.status] ?? s.status}</span>
          </div>
        </div>
        <div class="detail-panel__meta">
          <div class="meta-item"><span>ID</span><code>${esc(s.id)}</code></div>
          <div class="meta-item"><span>Товаров</span><strong>${s.itemsCount}</strong></div>
          <div class="meta-item"><span>Создана</span>${new Date(s.createdAt).toLocaleString('ru-RU')}</div>
        </div>
        <div class="detail-panel__actions">
          <button class="btn btn-primary" id="sp-add-items" ${isDraft ? '' : 'disabled'}>${I.plus} Добавить товары</button>
          <button class="btn" id="sp-barcodes">${I.download} Штрихкоды</button>
          <button class="btn btn-success" id="sp-send" ${isDraft ? '' : 'disabled'}>${I.send} Отправить поставку</button>
          <button class="btn btn-danger" id="sp-cancel" ${isDraft ? '' : 'disabled'}>${I.trash} Отменить</button>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      const tabEl = btn.closest('[data-tab]') as HTMLElement | null;
      if (tabEl?.dataset.tab) {
        this.tab = tabEl.dataset.tab as Tab;
        this.storeId = '';
        this.supplies = [];
        this.openSupply = null;
        this.render();
        this.loadStores();
        return;
      }

      const id = btn.id;
      if (id === 'sp-create')  { this.createSupply(); return; }
      if (id === 'sp-refresh') { this.loadSupplies(); return; }
      if (id === 'sp-back')    { this.openSupply = null; this.refreshBody(); return; }
      if (id === 'sp-send')    { this.sendSupply(); return; }
      if (id === 'sp-barcodes'){ this.downloadBarcodes(); return; }
      if (id === 'sp-cancel')  { this.cancelSupply(); return; }
      if (id === 'sp-add-items'){ showToast('Добавление товаров: выберите товары из каталога', 'info'); return; }

      const action = btn.dataset.action;
      if (action === 'open') {
        const found = this.supplies.find(s => s.id === btn.dataset.id);
        if (found) { this.openSupply = found; this.refreshBody(); }
      }
    });

    this.el.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.id === 'sp-store') {
        this.storeId = sel.value;
        this.supplies = [];
        this.openSupply = null;
        if (this.storeId) this.loadSupplies();
        else this.refreshBody();
      }
    });
  }

  private refreshBody(): void {
    const body = this.el.querySelector('#sp-body');
    if (!body) return;
    if (this.openSupply) {
      body.innerHTML = this.renderSupplyDetail(this.openSupply);
    } else {
      body.innerHTML = this.loading ? this.renderSkeleton() : this.renderSupplyList();
    }
  }

  private async loadStores(): Promise<void> {
    const sel = this.el.querySelector('#sp-store') as HTMLSelectElement;
    if (!sel) return;

    let stores: Array<{ id: string; name: string }> = [];
    try {
      if (this.tab === 'ozon') stores = await ozonDb.getStores();
      else if (this.tab === 'wb') stores = await wbDb.getStores();
      else stores = await yandexDb.getStores();
    } catch { /* ignore */ }

    if (stores.length === 0) {
      sel.innerHTML = '<option value="">Нет подключённых магазинов</option>';
      return;
    }

    sel.innerHTML = '<option value="">— Выберите магазин —</option>' +
      stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

    if (stores.length === 1) {
      sel.value = stores[0].id;
      this.storeId = stores[0].id;
      this.loadSupplies();
    }
  }

  private async loadSupplies(): Promise<void> {
    if (!this.storeId) return;
    this.loading = true;
    this.refreshBody();

    try {
      this.supplies = [];

      if (this.tab === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === this.storeId);
        if (!store) throw new Error('Магазин не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const list = await ozonApi.getSupplies(creds);
        for (const s of list) {
          this.supplies.push({
            id: s.supply_order_id ?? s.id ?? String(Math.random()),
            name: s.name ?? `Поставка ${s.supply_order_id}`,
            status: s.status ?? 'draft',
            createdAt: s.created_at ?? new Date().toISOString(),
            itemsCount: s.items?.length ?? 0,
          });
        }
      } else if (this.tab === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === this.storeId);
        if (!store) throw new Error('Магазин не найден');
        const list = await wbApi.getWbSupplies(store.api_key);
        for (const s of list) {
          this.supplies.push({
            id: s.id,
            name: s.name,
            status: s.done ? 'delivered' : 'draft',
            createdAt: s.createdAt ?? new Date().toISOString(),
            itemsCount: s.orderCount ?? 0,
          });
        }
      } else {
        showToast('Список отгрузок Яндекс Маркет: используйте раздел заказов', 'info');
      }
    } catch (err: any) {
      showToast(`Ошибка загрузки: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.refreshBody();
    }
  }

  private async createSupply(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }

    const name = prompt(`Название новой поставки (${this.tab.toUpperCase()}):`);
    if (!name?.trim()) return;

    const btn = this.el.querySelector('#sp-create') as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `${I.loader} Создание...`;

    try {
      if (this.tab === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const warehouses = await ozonApi.getWarehouses(creds);
        if (!warehouses.length) throw new Error('Нет складов Ozon');
        await ozonApi.createSupply(creds, warehouses[0].warehouse_id, name.trim());
      } else if (this.tab === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        await wbApi.createWbSupply(store.api_key, name.trim());
      } else {
        const stores = await yandexDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        if (!store.campaign_id) throw new Error('Нет campaign_id у магазина');
        const tomorrow = new Date(Date.now() + 86_400_000);
        const nextWeek = new Date(Date.now() + 7 * 86_400_000);
        const fmt = (d: Date) => d.toISOString().slice(0, 10);
        await yandexApi.createShipment(store.api_key, store.campaign_id, {
          planIntervalFrom: fmt(tomorrow),
          planIntervalTo: fmt(nextWeek),
        });
      }

      showToast('Поставка создана', 'success');
      await this.loadSupplies();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${I.plus} Создать поставку`;
    }
  }

  private async sendSupply(): Promise<void> {
    if (!this.openSupply) return;
    if (!confirm('Отправить поставку? После отправки изменения невозможны.')) return;

    try {
      if (this.tab === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        await ozonApi.sendSupply({ client_id: store.client_id, api_key: store.api_key }, this.openSupply.id);
      } else if (this.tab === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        await wbApi.deliverSupply(store.api_key, this.openSupply.id);
      } else {
        const stores = await yandexDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        await yandexApi.confirmShipment(store.api_key, store.campaign_id!, Number(this.openSupply.id));
      }

      showToast('Поставка отправлена', 'success');
      this.openSupply.status = 'sent';
      this.refreshBody();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async downloadBarcodes(): Promise<void> {
    if (!this.openSupply) return;

    try {
      let blob: Blob;

      if (this.tab === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        blob = await ozonApi.getSupplyBarcodes({ client_id: store.client_id, api_key: store.api_key }, this.openSupply.id);
      } else if (this.tab === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        blob = await wbApi.getSupplyBarcodePdf(store.api_key, this.openSupply.id);
      } else {
        showToast('Штрихкоды ЯМ: используйте Яндекс Маркет → Отгрузки', 'info');
        return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `supply_${this.openSupply.id}_barcodes.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Штрихкоды скачаны', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async cancelSupply(): Promise<void> {
    if (!this.openSupply) return;
    if (!confirm('Отменить поставку?')) return;

    try {
      if (this.tab === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        await ozonApi.cancelSupply({ client_id: store.client_id, api_key: store.api_key }, this.openSupply.id);
        showToast('Поставка отменена', 'success');
        this.openSupply = null;
        await this.loadSupplies();
      } else {
        showToast('Отмена поставки: доступна только для Ozon', 'info');
      }
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  show(): void { this.el.style.display = 'flex'; }
  hide(): void { this.el.style.display = 'none'; }
}
