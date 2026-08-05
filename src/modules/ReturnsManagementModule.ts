/**
 * Модуль управления возвратами для всех маркетплейсов
 * Returns Management Module
 */

import { ozonApi } from '@/services/ozonApi';
import { 
  fetchWbDetailedReturns, 
  type WbReturn 
} from '@/services/wbApi';
import { getYandexReturns, processYandexReturn } from '@/services/yandexApi';
import type { OzonStore } from '@/types/ozon';
import type { WbStore } from '@/types/wb';
import type { YandexStore } from '@/types/yandex';

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

interface ReturnData {
  marketplace: 'ozon' | 'wb' | 'yandex';
  returnId: string;
  orderId: string;
  productName: string;
  quantity: number;
  amount: number;
  reason: string;
  status: string;
  date: string;
}

interface ReturnsStats {
  totalReturns: number;
  totalAmount: number;
  byMarketplace: Record<string, number>;
  byReason: Record<string, number>;
  byProduct: Map<string, { count: number; name: string }>;
  returnRate: number;
}

export class ReturnsManagementModule {
  private container: HTMLElement;
  private loading = false;
  private returns: ReturnData[] = [];
  private stats: ReturnsStats | null = null;
  private dateFrom: string;
  private dateTo: string;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;
    
    // Default: last 30 days
    const now = new Date();
    const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    this.dateTo = now.toISOString().split('T')[0];
    this.dateFrom = past.toISOString().split('T')[0];
    
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="returns-management">
        <div class="returns-header">
          <h2>🔄 Управление возвратами</h2>
          <div class="returns-filters">
            <input type="date" id="returns-date-from" value="${this.dateFrom}" />
            <span>—</span>
            <input type="date" id="returns-date-to" value="${this.dateTo}" />
            <button class="btn-primary" id="load-returns-btn">
              ${this.loading ? 'Загрузка...' : 'Загрузить данные'}
            </button>
          </div>
        </div>

        ${this.stats ? this.renderStats() : ''}

        <div class="returns-tabs">
          <button class="tab active" data-tab="list">Список возвратов</button>
          <button class="tab" data-tab="analytics">Аналитика</button>
          <button class="tab" data-tab="actions">Действия</button>
        </div>

        <div class="tab-content">
          ${this.renderReturnsList()}
        </div>
      </div>
    `;

    this.attachListeners();
  }

  private renderStats(): string {
    if (!this.stats) return '';

    const byMp = Object.entries(this.stats.byMarketplace)
      .map(([mp, count]) => `<span class="stat-badge">${mp}: ${count}</span>`)
      .join('');

    const topReasons = Object.entries(this.stats.byReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `<li>${escape(reason)}: <strong>${count}</strong></li>`)
      .join('');

    return `
      <div class="returns-stats">
        <div class="stat-card">
          <div class="stat-label">Всего возвратов</div>
          <div class="stat-value">${this.stats.totalReturns}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Сумма потерь</div>
          <div class="stat-value">${this.stats.totalAmount.toLocaleString()} ₽</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Процент возвратов</div>
          <div class="stat-value">${this.stats.returnRate.toFixed(2)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">По маркетплейсам</div>
          <div class="stat-badges">${byMp}</div>
        </div>
        <div class="stat-card wide">
          <div class="stat-label">Топ-5 причин</div>
          <ul class="reasons-list">${topReasons}</ul>
        </div>
      </div>
    `;
  }

  private renderReturnsList(): string {
    if (!this.returns.length) {
      return '<div class="empty-state">Нет данных. Загрузите возвраты за выбранный период.</div>';
    }

    const rows = this.returns.map(r => `
      <tr>
        <td><span class="mp-badge mp-${r.marketplace}">${r.marketplace}</span></td>
        <td>${escape(r.productName)}</td>
        <td>${r.quantity}</td>
        <td>${r.amount.toLocaleString()} ₽</td>
        <td>${escape(r.reason)}</td>
        <td><span class="status-badge status-${r.status}">${escape(r.status)}</span></td>
        <td>${new Date(r.date).toLocaleDateString('ru-RU')}</td>
        <td>
          <button class="btn-sm btn-action" data-return-id="${r.returnId}" data-marketplace="${r.marketplace}">
            Обработать
          </button>
        </td>
      </tr>
    `).join('');

    return `
      <div class="returns-table-wrapper">
        <table class="returns-table">
          <thead>
            <tr>
              <th>МП</th>
              <th>Товар</th>
              <th>Кол-во</th>
              <th>Сумма</th>
              <th>Причина</th>
              <th>Статус</th>
              <th>Дата</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  private attachListeners(): void {
    // Date filters
    const dateFrom = this.container.querySelector('#returns-date-from') as HTMLInputElement;
    const dateTo = this.container.querySelector('#returns-date-to') as HTMLInputElement;
    
    if (dateFrom) {
      dateFrom.addEventListener('change', (e) => {
        this.dateFrom = (e.target as HTMLInputElement).value;
      });
    }
    
    if (dateTo) {
      dateTo.addEventListener('change', (e) => {
        this.dateTo = (e.target as HTMLInputElement).value;
      });
    }

    // Load button
    const loadBtn = this.container.querySelector('#load-returns-btn');
    if (loadBtn) {
      loadBtn.addEventListener('click', () => this.loadReturns());
    }

    // Tabs
    this.container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        this.container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        target.classList.add('active');
        // Switch tab content (simplified)
        this.render();
      });
    });

    // Action buttons
    this.container.querySelectorAll('.btn-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const returnId = target.dataset.returnId;
        const marketplace = target.dataset.marketplace;
        if (returnId && marketplace) {
          await this.processReturn(returnId, marketplace as 'ozon' | 'wb' | 'yandex');
        }
      });
    });
  }

  async loadReturns(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      const allReturns: ReturnData[] = [];
      const stores = this.getAllStores();

      // Load from all marketplaces
      await Promise.all([
        this.loadOzonReturns(stores.ozon, allReturns),
        this.loadWbReturns(stores.wb, allReturns),
        this.loadYandexReturns(stores.yandex, allReturns),
      ]);

      this.returns = allReturns;
      this.calculateStats();
      toast.success(`Загружено ${allReturns.length} возвратов`);
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async loadOzonReturns(stores: OzonStore[], target: ReturnData[]): Promise<void> {
    for (const store of stores) {
      try {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const fboReturns = await ozonApi.getFboReturns(creds);
        const fbsReturnsResp = await ozonApi.getFbsReturns(creds);
        
        const allOzonReturns = [...fboReturns, ...fbsReturnsResp.returns];
        
        allOzonReturns.forEach((r: any) => {
          target.push({
            marketplace: 'ozon',
            returnId: r.return_id ?? r.id ?? '',
            orderId: r.posting_number ?? r.order_id ?? '',
            productName: r.product_name ?? r.sku_name ?? 'Неизвестно',
            quantity: r.quantity ?? 1,
            amount: r.price ?? r.amount ?? 0,
            reason: r.return_reason?.name ?? r.reason ?? 'Не указано',
            status: r.status ?? 'unknown',
            date: r.created_at ?? r.return_date ?? new Date().toISOString(),
          });
        });
      } catch (err) {
        console.error('[Ozon Returns]', err);
      }
    }
  }

  private async loadWbReturns(stores: WbStore[], target: ReturnData[]): Promise<void> {
    for (const store of stores) {
      try {
        const returns = await fetchWbDetailedReturns(
          store.api_key,
          new Date(this.dateFrom).toISOString(),
          new Date(this.dateTo).toISOString(),
        );

        returns.forEach((r: WbReturn) => {
          target.push({
            marketplace: 'wb',
            returnId: String(r.rid ?? r.id ?? ''),
            orderId: String(r.id ?? ''),
            productName: r.productName ?? r.supplierArticle ?? 'Неизвестно',
            quantity: r.quantity ?? 1,
            amount: r.retailPrice ?? 0,
            reason: r.statusTranslated ?? r.status ?? 'Не указано',
            status: r.status ?? 'unknown',
            date: r.returnDate ?? r.orderDt ?? new Date().toISOString(),
          });
        });
      } catch (err) {
        console.error('[WB Returns]', err);
      }
    }
  }

  private async loadYandexReturns(stores: YandexStore[], target: ReturnData[]): Promise<void> {
    for (const store of stores) {
      try {
        const returns = await getYandexReturns(store, {
          dateFrom: this.dateFrom,
          dateTo: this.dateTo,
        });

        returns.forEach((r: any) => {
          target.push({
            marketplace: 'yandex',
            returnId: String(r.id ?? ''),
            orderId: String(r.orderId ?? ''),
            productName: r.offerName ?? r.shopSku ?? 'Неизвестно',
            quantity: r.count ?? 1,
            amount: r.buyerPrice ?? 0,
            reason: r.returnReason ?? 'Не указано',
            status: r.status ?? 'unknown',
            date: r.createdAt ?? new Date().toISOString(),
          });
        });
      } catch (err) {
        console.error('[Yandex Returns]', err);
      }
    }
  }

  private calculateStats(): void {
    const stats: ReturnsStats = {
      totalReturns: this.returns.length,
      totalAmount: 0,
      byMarketplace: {},
      byReason: {},
      byProduct: new Map(),
      returnRate: 0,
    };

    this.returns.forEach(r => {
      stats.totalAmount += r.amount * r.quantity;
      stats.byMarketplace[r.marketplace] = (stats.byMarketplace[r.marketplace] || 0) + 1;
      stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;

      const existing = stats.byProduct.get(r.productName);
      if (existing) {
        existing.count += r.quantity;
      } else {
        stats.byProduct.set(r.productName, { count: r.quantity, name: r.productName });
      }
    });

    // TODO: calculate return rate (need total sales data)
    stats.returnRate = 0;

    this.stats = stats;
  }

  private async processReturn(returnId: string, marketplace: 'ozon' | 'wb' | 'yandex'): Promise<void> {
    // Простая реализация - нужен UI для выбора действия
    const action = confirm('Вернуть деньги покупателю?');
    if (!action) return;

    try {
      if (marketplace === 'yandex') {
        const stores = this.getAllStores().yandex;
        if (stores.length > 0) {
          await processYandexReturn(stores[0], 0, Number(returnId), 'REFUND_MONEY');
          toast.success('Возврат обработан');
          await this.loadReturns();
        }
      } else {
        toast.warning('Обработка возвратов для ' + marketplace + ' в разработке');
      }
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getAllStores(): {
    ozon: OzonStore[];
    wb: WbStore[];
    yandex: YandexStore[];
  } {
    // TODO: получить из глобального стейта
    return {
      ozon: [],
      wb: [],
      yandex: [],
    };
  }
}
