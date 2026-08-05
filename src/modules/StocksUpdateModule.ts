import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { ozonApi } from '@/services/ozonApi';
import { wbApi } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';
import type { OzonProduct } from '@/types/ozon';
import type { WbProduct } from '@/types/wb';
import type { YandexProduct } from '@/types/yandex';

type Marketplace = 'ozon' | 'wb' | 'yandex';

interface StockUpdateItem {
  offer_id: string;
  name: string;
  current_stock: number;
  new_stock: number;
  mp_id: string;
  mp: Marketplace;
  store_name: string;
}

export class StocksUpdateModule {
  private root: HTMLElement;
  private items: StockUpdateItem[] = [];
  private selectedMp: Marketplace = 'ozon';
  private selectedStoreId: string = '';

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'stocks-update-module';
    container.appendChild(this.root);
  }

  async render(): Promise<void> {
    this.root.innerHTML = `
      <div class="module-header">
        <h2>${I.refresh} Обновление остатков на маркетплейсах</h2>
        <p class="hint">Синхронизация остатков из SimaDesk на маркетплейсы</p>
      </div>

      <div class="stocks-toolbar">
        <div class="mp-selector">
          <label>Маркетплейс:</label>
          <select id="mp-select">
            <option value="ozon">Ozon FBS</option>
            <option value="wb">Wildberries FBS</option>
            <option value="yandex">Яндекс Маркет</option>
          </select>
        </div>

        <div class="store-selector">
          <label>Магазин:</label>
          <select id="store-select">
            <option value="">-- Выберите магазин --</option>
          </select>
        </div>

        <button id="load-stocks-btn" class="btn btn-primary">
          ${I.refresh} Загрузить остатки
        </button>

        <button id="sync-stocks-btn" class="btn btn-success" disabled>
          ${I.upload} Синхронизировать (<span id="selected-count">0</span>)
        </button>
      </div>

      <div class="stocks-table-container">
        <table class="stocks-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="select-all-stocks"></th>
              <th>Товар</th>
              <th>Артикул</th>
              <th>Текущий остаток (МП)</th>
              <th>Новый остаток</th>
              <th>Изменение</th>
            </tr>
          </thead>
          <tbody id="stocks-tbody">
            <tr><td colspan="6" class="empty">Выберите маркетплейс и загрузите остатки</td></tr>
          </tbody>
        </table>
      </div>

      <div class="stocks-footer">
        <div class="stats">
          Всего товаров: <strong id="total-items">0</strong> |
          Требуют обновления: <strong id="need-update">0</strong>
        </div>
      </div>
    `;

    this.attachListeners();
    await this.loadStores();
  }

  private attachListeners(): void {
    const mpSelect = this.root.querySelector('#mp-select') as HTMLSelectElement;
    const storeSelect = this.root.querySelector('#store-select') as HTMLSelectElement;
    const loadBtn = this.root.querySelector('#load-stocks-btn') as HTMLButtonElement;
    const syncBtn = this.root.querySelector('#sync-stocks-btn') as HTMLButtonElement;
    const selectAll = this.root.querySelector('#select-all-stocks') as HTMLInputElement;

    mpSelect.addEventListener('change', () => {
      this.selectedMp = mpSelect.value as Marketplace;
      this.loadStores();
    });

    storeSelect.addEventListener('change', () => {
      this.selectedStoreId = storeSelect.value;
    });

    loadBtn.addEventListener('click', () => this.loadStocks());
    syncBtn.addEventListener('click', () => this.syncStocks());
    selectAll.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      this.root.querySelectorAll<HTMLInputElement>('.stock-checkbox').forEach(cb => {
        cb.checked = checked;
      });
      this.updateSelectedCount();
    });
  }

  private async loadStores(): Promise<void> {
    const storeSelect = this.root.querySelector('#store-select') as HTMLSelectElement;
    storeSelect.innerHTML = '<option value="">-- Выберите магазин --</option>';

    let stores: Array<{ id: string; name: string }> = [];
    if (this.selectedMp === 'ozon') {
      stores = await ozonDb.getStores();
    } else if (this.selectedMp === 'wb') {
      stores = await wbDb.getStores();
    } else if (this.selectedMp === 'yandex') {
      stores = await yandexDb.getStores();
    }

    stores.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      storeSelect.appendChild(opt);
    });
  }

  private async loadStocks(): Promise<void> {
    if (!this.selectedStoreId) {
      showToast('Выберите магазин', 'warning');
      return;
    }

    const loadBtn = this.root.querySelector('#load-stocks-btn') as HTMLButtonElement;
    loadBtn.disabled = true;
    loadBtn.innerHTML = `${I.loader} Загрузка...`;

    try {
      this.items = await this.fetchStockItems();
      this.renderStocksTable();
      this.updateStats();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      loadBtn.disabled = false;
      loadBtn.innerHTML = `${I.refresh} Загрузить остатки`;
    }
  }

  private async fetchStockItems(): Promise<StockUpdateItem[]> {
    const items: StockUpdateItem[] = [];

    if (this.selectedMp === 'ozon') {
      const stores = await ozonDb.getStores();
      const store = stores.find(s => s.id === this.selectedStoreId);
      if (!store) throw new Error('Магазин не найден');

      const allProducts = await ozonDb.getProducts();
      const products = allProducts.filter((p: OzonProduct) => p.store_id === this.selectedStoreId);

      for (const p of products) {
        items.push({
          offer_id: p.offer_id,
          name: p.name,
          current_stock: p.stock_fbs ?? 0,
          new_stock: p.stock_fbs ?? 0,
          mp_id: p.offer_id,
          mp: 'ozon',
          store_name: store.name,
        });
      }
    } else if (this.selectedMp === 'wb') {
      const stores = await wbDb.getStores();
      const store = stores.find(s => s.id === this.selectedStoreId);
      if (!store) throw new Error('Магазин не найден');

      const products = await wbDb.getStoreProducts(this.selectedStoreId);

      for (const p of products) {
        items.push({
          offer_id: String((p as WbProduct).nm_id ?? ''),
          name: (p as WbProduct).title ?? '',
          current_stock: (p as WbProduct).stock_total ?? 0,
          new_stock: (p as WbProduct).stock_total ?? 0,
          mp_id: String((p as WbProduct).nm_id ?? ''),
          mp: 'wb',
          store_name: store.name,
        });
      }
    } else if (this.selectedMp === 'yandex') {
      const stores = await yandexDb.getStores();
      const store = stores.find(s => s.id === this.selectedStoreId);
      if (!store) throw new Error('Магазин не найден');

      const allProducts = await yandexDb.getProducts();
      const products = allProducts.filter((p: YandexProduct) => p.store_id === this.selectedStoreId);

      for (const p of products) {
        items.push({
          offer_id: p.offer_id,
          name: p.name,
          current_stock: p.stock_total ?? 0,
          new_stock: p.stock_total ?? 0,
          mp_id: p.offer_id,
          mp: 'yandex',
          store_name: store.name,
        });
      }
    }

    return items;
  }

  private renderStocksTable(): void {
    const tbody = this.root.querySelector('#stocks-tbody') as HTMLTableSectionElement;

    if (this.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Товары не найдены</td></tr>';
      return;
    }

    tbody.innerHTML = this.items.map((item, idx) => {
      const diff = item.new_stock - item.current_stock;
      const diffClass = diff > 0 ? 'positive' : diff < 0 ? 'negative' : '';
      const diffIcon = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';

      return `
        <tr>
          <td><input type="checkbox" class="stock-checkbox" data-idx="${idx}"></td>
          <td>${esc(item.name)}</td>
          <td><code>${esc(item.offer_id)}</code></td>
          <td>${item.current_stock}</td>
          <td><input type="number" class="stock-input" data-idx="${idx}" value="${item.new_stock}" min="0" style="width:80px"></td>
          <td class="diff ${diffClass}">${diffIcon} ${diff > 0 ? '+' : ''}${diff}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll<HTMLInputElement>('.stock-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset.idx || '0');
        this.items[idx].new_stock = parseInt((e.target as HTMLInputElement).value) || 0;
        this.renderStocksTable();
      });
    });

    tbody.querySelectorAll('.stock-checkbox').forEach(cb => {
      cb.addEventListener('change', () => this.updateSelectedCount());
    });

    this.updateSelectedCount();
  }

  private updateSelectedCount(): void {
    const selected = this.root.querySelectorAll<HTMLInputElement>('.stock-checkbox:checked').length;
    const countSpan = this.root.querySelector('#selected-count') as HTMLSpanElement;
    const syncBtn = this.root.querySelector('#sync-stocks-btn') as HTMLButtonElement;

    countSpan.textContent = String(selected);
    syncBtn.disabled = selected === 0;
  }

  private updateStats(): void {
    const totalEl = this.root.querySelector('#total-items') as HTMLElement;
    const needUpdateEl = this.root.querySelector('#need-update') as HTMLElement;
    const needUpdate = this.items.filter(i => i.new_stock !== i.current_stock).length;

    totalEl.textContent = String(this.items.length);
    needUpdateEl.textContent = String(needUpdate);
  }

  private async syncStocks(): Promise<void> {
    const selectedItems = Array.from(this.root.querySelectorAll<HTMLInputElement>('.stock-checkbox:checked'))
      .map(cb => parseInt(cb.dataset.idx || '0'))
      .map(idx => this.items[idx]);

    if (selectedItems.length === 0) return;

    const syncBtn = this.root.querySelector('#sync-stocks-btn') as HTMLButtonElement;
    syncBtn.disabled = true;
    syncBtn.innerHTML = `${I.loader} Синхронизация...`;

    try {
      if (this.selectedMp === 'ozon') {
        await this.syncOzonStocks(selectedItems);
      } else if (this.selectedMp === 'wb') {
        await this.syncWbStocks(selectedItems);
      } else if (this.selectedMp === 'yandex') {
        await this.syncYandexStocks(selectedItems);
      }

      showToast(`✓ Синхронизировано ${selectedItems.length} товаров`, 'success');
      await this.loadStocks();
    } catch (err: any) {
      showToast(`Ошибка синхронизации: ${err.message}`, 'error');
    } finally {
      syncBtn.disabled = false;
      syncBtn.innerHTML = `${I.upload} Синхронизировать`;
    }
  }

  private async syncOzonStocks(items: StockUpdateItem[]): Promise<void> {
    const stores = await ozonDb.getStores();
    const store = stores.find(s => s.id === this.selectedStoreId);
    if (!store) throw new Error('Магазин не найден');

    const creds = { client_id: store.client_id, api_key: store.api_key };
    await ozonApi.updateStocks(
      creds,
      items.map(i => ({ offer_id: i.offer_id, stock: i.new_stock })),
    );
  }

  private async syncWbStocks(items: StockUpdateItem[]): Promise<void> {
    const stores = await wbDb.getStores();
    const store = stores.find(s => s.id === this.selectedStoreId);
    if (!store) throw new Error('Магазин не найден');

    const warehouses = await wbApi.getWarehouses(store.api_key);
    if (!warehouses.length) throw new Error('Склады WB не найдены');

    const warehouseId = warehouses[0].id;

    const stocks: Array<{ sku: string; amount: number }> = [];
    for (const item of items) {
      const nmId = parseInt(item.offer_id);
      const barcodes = await wbApi.getCardBarcodes(store.api_key, nmId);
      if (barcodes.length > 0) {
        stocks.push({ sku: barcodes[0], amount: item.new_stock });
      }
    }

    await wbApi.updateFbsStocks(store.api_key, warehouseId, stocks);
  }

  private async syncYandexStocks(items: StockUpdateItem[]): Promise<void> {
    const stores = await yandexDb.getStores();
    const store = stores.find(s => s.id === this.selectedStoreId);
    if (!store) throw new Error('Магазин не найден');

    if (!store.campaign_id) throw new Error('campaign_id не указан');

    const stocksResp = await yandexApi.getStocks(store.api_key, store.campaign_id, '', undefined);
    const warehouses = stocksResp.warehouses;
    if (!warehouses.length) throw new Error('Склады ЯМ не найдены');

    const warehouseId = warehouses[0].id;

    await yandexApi.updateStocks(
      store.api_key,
      store.campaign_id,
      items.map(i => ({
        sku: i.offer_id,
        warehouseId,
        items: [{ count: i.new_stock, type: 'FIT', updatedAt: new Date().toISOString() }],
      })),
    );
  }

  destroy(): void {
    this.root.remove();
  }
}
