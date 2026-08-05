/**
 * Модуль управления поставками FBO/FBY для всех маркетплейсов.
 * Функции:
 * - Создание поставки
 * - Добавление товаров
 * - Генерация штрихкодов
 * - Отправка поставки
 * - Просмотр статуса
 */

import { ozonApi } from '@/services/ozonApi';
import { wbApi } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import type { OzonStore } from '@/types/ozon';
import type { WbStore } from '@/types/wb';
import type { YandexStore } from '@/types/yandex';

// Простые утилиты
const escape = (str: string): string => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

const toast = {
  success: (msg: string) => console.log('✅', msg),
  error: (msg: string) => console.error('❌', msg),
  warning: (msg: string) => console.warn('⚠️', msg),
  info: (msg: string) => console.info('ℹ️', msg),
};

type Marketplace = 'ozon' | 'wb' | 'yandex';

interface Supply {
  id: string;
  marketplace: Marketplace;
  name: string;
  status: string;
  createdAt: string;
  itemsCount: number;
}

export class SupplyManagementModule {
  private container: HTMLElement;
  private supplies: Supply[] = [];
  private currentSupply: Supply | null = null;
  private currentMarketplace: Marketplace = 'ozon';
  private loading: boolean = false;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="supply-module">
        <div class="supply-header">
          <h2>📦 Управление поставками</h2>
          <div class="supply-controls">
            <select id="supply-marketplace" class="marketplace-select">
              <option value="ozon" ${this.currentMarketplace === 'ozon' ? 'selected' : ''}>Ozon FBO</option>
              <option value="wb" ${this.currentMarketplace === 'wb' ? 'selected' : ''}>Wildberries</option>
              <option value="yandex" ${this.currentMarketplace === 'yandex' ? 'selected' : ''}>Яндекс FBY</option>
            </select>
            <button id="supply-create-btn" class="btn-primary">
              + Создать поставку
            </button>
            <button id="supply-refresh-btn" class="btn-secondary">
              🔄 Обновить
            </button>
          </div>
        </div>

        <div class="supply-content">
          ${this.currentSupply ? this.renderSupplyDetails() : this.renderSupplyList()}
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderSupplyList(): string {
    if (this.loading) {
      return '<div class="loading-state">Загрузка поставок...</div>';
    }

    if (!this.supplies.length) {
      return `
        <div class="empty-state">
          <p>Нет активных поставок</p>
          <p class="hint">Создайте новую поставку для отправки товаров на склад маркетплейса</p>
        </div>
      `;
    }

    const rows = this.supplies.map(s => `
      <tr class="supply-row" data-supply-id="${escape(s.id)}">
        <td>${escape(s.name)}</td>
        <td><span class="mp-badge mp-${s.marketplace}">${s.marketplace.toUpperCase()}</span></td>
        <td><span class="status-badge status-${s.status}">${escape(s.status)}</span></td>
        <td>${s.itemsCount}</td>
        <td>${new Date(s.createdAt).toLocaleDateString('ru-RU')}</td>
        <td>
          <button class="btn-sm" data-action="view" data-supply-id="${escape(s.id)}">Открыть</button>
        </td>
      </tr>
    `).join('');

    return `
      <table class="supply-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Маркетплейс</th>
            <th>Статус</th>
            <th>Товаров</th>
            <th>Создана</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  private renderSupplyDetails(): string {
    if (!this.currentSupply) return '';

    return `
      <div class="supply-details">
        <div class="supply-details-header">
          <button id="supply-back-btn" class="btn-secondary">← Назад</button>
          <h3>${escape(this.currentSupply.name)}</h3>
          <span class="status-badge status-${this.currentSupply.status}">
            ${escape(this.currentSupply.status)}
          </span>
        </div>

        <div class="supply-info">
          <div class="info-row">
            <label>ID поставки:</label>
            <span>${escape(this.currentSupply.id)}</span>
          </div>
          <div class="info-row">
            <label>Маркетплейс:</label>
            <span class="mp-badge mp-${this.currentSupply.marketplace}">
              ${this.currentSupply.marketplace.toUpperCase()}
            </span>
          </div>
          <div class="info-row">
            <label>Создана:</label>
            <span>${new Date(this.currentSupply.createdAt).toLocaleString('ru-RU')}</span>
          </div>
          <div class="info-row">
            <label>Товаров:</label>
            <span>${this.currentSupply.itemsCount}</span>
          </div>
        </div>

        <div class="supply-actions">
          <button id="supply-add-items-btn" class="btn-primary" ${this.currentSupply.status !== 'draft' ? 'disabled' : ''}>
            + Добавить товары
          </button>
          <button id="supply-barcode-btn" class="btn-secondary">
            🖨️ Штрихкоды
          </button>
          <button id="supply-send-btn" class="btn-success" ${this.currentSupply.status !== 'draft' ? 'disabled' : ''}>
            ✓ Отправить поставку
          </button>
        </div>

        <div id="supply-items-container" class="supply-items">
          ${this.renderSupplyItems()}
        </div>
      </div>
    `;
  }

  private renderSupplyItems(): string {
    // Здесь должен быть список товаров поставки
    // Пока заглушка
    return `
      <div class="empty-state">
        <p>Товары поставки будут отображаться здесь</p>
      </div>
    `;
  }

  private attachEventListeners(): void {
    const createBtn = document.getElementById('supply-create-btn');
    const refreshBtn = document.getElementById('supply-refresh-btn');
    const backBtn = document.getElementById('supply-back-btn');
    const marketplaceSelect = document.getElementById('supply-marketplace') as HTMLSelectElement;
    const sendBtn = document.getElementById('supply-send-btn');
    const barcodeBtn = document.getElementById('supply-barcode-btn');
    const addItemsBtn = document.getElementById('supply-add-items-btn');

    createBtn?.addEventListener('click', () => this.createSupply());
    refreshBtn?.addEventListener('click', () => this.loadSupplies());
    backBtn?.addEventListener('click', () => {
      this.currentSupply = null;
      this.render();
    });

    marketplaceSelect?.addEventListener('change', (e) => {
      this.currentMarketplace = (e.target as HTMLSelectElement).value as Marketplace;
      this.loadSupplies();
    });

    sendBtn?.addEventListener('click', () => this.sendSupply());
    barcodeBtn?.addEventListener('click', () => this.downloadBarcodes());
    addItemsBtn?.addEventListener('click', () => this.showAddItemsDialog());

    // Делегирование для кнопок в таблице
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.dataset.action === 'view') {
        const supplyId = target.dataset.supplyId;
        this.viewSupply(supplyId!);
      }
    });
  }

  private async createSupply(): Promise<void> {
    const name = prompt(`Название поставки (${this.currentMarketplace.toUpperCase()}):`);
    if (!name) return;

    this.loading = true;
    this.render();

    try {
      let supplyId: string;

      switch (this.currentMarketplace) {
        case 'ozon': {
          const stores: OzonStore[] = JSON.parse(localStorage.getItem('ozon_stores') || '[]');
          if (!stores.length) throw new Error('Нет магазинов Ozon');
          const store = stores[0];
          const creds = { client_id: store.client_id, api_key: store.api_key };
          
          // Нужно выбрать склад — для примера используем первый
          const warehouses = await ozonApi.getWarehouses(creds);
          if (!warehouses.length) throw new Error('Нет складов');
          
          const result = await ozonApi.createSupply(creds, warehouses[0].warehouse_id, name);
          supplyId = result.supplyId;
          break;
        }

        case 'wb': {
          const stores: WbStore[] = JSON.parse(localStorage.getItem('wb_stores') || '[]');
          if (!stores.length) throw new Error('Нет магазинов WB');
          const store = stores[0];
          const result = await wbApi.createWbSupply(store.api_key, name);
          supplyId = result.supplyId;
          break;
        }

        case 'yandex': {
          const stores: YandexStore[] = JSON.parse(localStorage.getItem('yandex_stores') || '[]');
          if (!stores.length) throw new Error('Нет магазинов Яндекс');
          const store = stores[0];
          if (!store.campaign_id) throw new Error('У магазина нет campaign_id');

          const tomorrow = new Date(Date.now() + 86400_000);
          const nextWeek = new Date(Date.now() + 7 * 86400_000);
          const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

          const result = await yandexApi.createShipment(
            store.api_key,
            store.campaign_id,
            {
              planIntervalFrom: fmtDate(tomorrow),
              planIntervalTo: fmtDate(nextWeek),
            },
          );
          supplyId = String(result.id);
          break;
        }

        default:
          throw new Error('Unknown marketplace');
      }

      toast.success(`Поставка создана: ${supplyId}`);
      await this.loadSupplies();
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async loadSupplies(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      this.supplies = [];

      switch (this.currentMarketplace) {
        case 'ozon': {
          const stores: OzonStore[] = JSON.parse(localStorage.getItem('ozon_stores') || '[]');
          for (const store of stores) {
            const creds = { client_id: store.client_id, api_key: store.api_key };
            const supplies = await ozonApi.getSupplies(creds);
            
            for (const s of supplies) {
              this.supplies.push({
                id: s.supply_order_id ?? s.id,
                marketplace: 'ozon',
                name: s.name ?? `Поставка ${s.supply_order_id}`,
                status: s.status ?? 'draft',
                createdAt: s.created_at ?? new Date().toISOString(),
                itemsCount: s.items?.length ?? 0,
              });
            }
          }
          break;
        }

        case 'wb': {
          const stores: WbStore[] = JSON.parse(localStorage.getItem('wb_stores') || '[]');
          for (const store of stores) {
            const supplies = await wbApi.getWbSupplies(store.api_key);
            
            for (const s of supplies) {
              this.supplies.push({
                id: s.id,
                marketplace: 'wb',
                name: s.name,
                status: s.done ? 'delivered' : 'draft',
                createdAt: s.createdAt ?? new Date().toISOString(),
                itemsCount: s.orderCount ?? 0,
              });
            }
          }
          break;
        }

        case 'yandex': {
          // У ЯМ нет прямого API для списка поставок
          // Можно реализовать через хранение в localStorage
          toast.info('Список поставок ЯМ пока недоступен через API');
          break;
        }
      }
    } catch (err) {
      toast.error(`Ошибка загрузки: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private viewSupply(supplyId: string): void {
    const supply = this.supplies.find(s => s.id === supplyId);
    if (!supply) return;
    this.currentSupply = supply;
    this.render();
  }

  private async sendSupply(): Promise<void> {
    if (!this.currentSupply) return;
    if (!confirm('Отправить поставку на склад? После отправки изменения невозможны.')) return;

    try {
      switch (this.currentSupply.marketplace) {
        case 'ozon': {
          const stores: OzonStore[] = JSON.parse(localStorage.getItem('ozon_stores') || '[]');
          const store = stores[0];
          const creds = { client_id: store.client_id, api_key: store.api_key };
          await ozonApi.sendSupply(creds, this.currentSupply.id);
          break;
        }

        case 'wb': {
          const stores: WbStore[] = JSON.parse(localStorage.getItem('wb_stores') || '[]');
          const store = stores[0];
          await wbApi.deliverSupply(store.api_key, this.currentSupply.id);
          break;
        }

        case 'yandex': {
          const stores: YandexStore[] = JSON.parse(localStorage.getItem('yandex_stores') || '[]');
          const store = stores[0];
          if (!store.campaign_id) throw new Error('Нет campaign_id');
          await yandexApi.confirmShipment(store.api_key, store.campaign_id, Number(this.currentSupply.id));
          break;
        }
      }

      toast.success('Поставка отправлена!');
      this.currentSupply.status = 'sent';
      this.render();
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async downloadBarcodes(): Promise<void> {
    if (!this.currentSupply) return;

    try {
      let blob: Blob;

      switch (this.currentSupply.marketplace) {
        case 'ozon': {
          const stores: OzonStore[] = JSON.parse(localStorage.getItem('ozon_stores') || '[]');
          const store = stores[0];
          const creds = { client_id: store.client_id, api_key: store.api_key };
          blob = await ozonApi.getSupplyBarcodes(creds, this.currentSupply.id);
          break;
        }

        case 'wb': {
          const stores: WbStore[] = JSON.parse(localStorage.getItem('wb_stores') || '[]');
          const store = stores[0];
          blob = await wbApi.getSupplyBarcodePdf(store.api_key, this.currentSupply.id);
          break;
        }

        case 'yandex': {
          toast.info('Штрихкоды ЯМ доступны через метод getShipmentLabels');
          return;
        }

        default:
          throw new Error('Unknown marketplace');
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `supply_${this.currentSupply.id}_barcodes.pdf`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success('Штрихкоды скачаны');
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private showAddItemsDialog(): void {
    toast.info('Функция добавления товаров в разработке');
  }

  show(): void { this.container.style.display = 'flex'; }
  hide(): void { this.container.style.display = 'none'; }
}
