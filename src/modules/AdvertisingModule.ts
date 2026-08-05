/**
 * Модуль управления рекламными кампаниями для всех маркетплейсов
 * Advertising Module
 */

import { ozonApi } from '@/services/ozonApi';
import {
  getWbCampaigns,
  createWbAdCampaign,
  updateWbCampaign,
  fetchWbAdStats,
} from '@/services/wbApi';
import { getYandexPromos } from '@/services/yandexApi';
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

interface Campaign {
  marketplace: 'ozon' | 'wb' | 'yandex';
  id: string | number;
  name: string;
  status: string;
  type: string;
  budget: number;
  spent: number;
  clicks: number;
  views: number;
  orders: number;
  revenue: number;
  roi: number;
}

export class AdvertisingModule {
  private container: HTMLElement;
  private loading = false;
  private campaigns: Campaign[] = [];
  private selectedMarketplace: 'all' | 'ozon' | 'wb' | 'yandex' = 'all';

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="advertising-module">
        <div class="advertising-header">
          <h2>📢 Управление рекламой</h2>
          <div class="advertising-controls">
            <select id="marketplace-filter" class="form-select">
              <option value="all">Все маркетплейсы</option>
              <option value="ozon">Ozon</option>
              <option value="wb">Wildberries</option>
              <option value="yandex">Яндекс.Маркет</option>
            </select>
            <button class="btn-primary" id="create-campaign-btn">+ Создать кампанию</button>
            <button class="btn-secondary" id="load-campaigns-btn">
              ${this.loading ? 'Загрузка...' : '🔄 Обновить'}
            </button>
          </div>
        </div>

        ${this.renderOverallStats()}

        <div class="campaigns-tabs">
          <button class="tab active" data-tab="campaigns">Кампании</button>
          <button class="tab" data-tab="stats">Статистика</button>
          <button class="tab" data-tab="promotions">Акции</button>
        </div>

        <div class="tab-content">
          ${this.renderCampaignsList()}
        </div>
      </div>
    `;

    this.attachListeners();
  }

  private renderOverallStats(): string {
    if (!this.campaigns.length) return '';

    const totalBudget = this.campaigns.reduce((sum, c) => sum + c.budget, 0);
    const totalSpent = this.campaigns.reduce((sum, c) => sum + c.spent, 0);
    const totalRevenue = this.campaigns.reduce((sum, c) => sum + c.revenue, 0);
    const totalOrders = this.campaigns.reduce((sum, c) => sum + c.orders, 0);
    const avgROI = totalSpent > 0 ? ((totalRevenue - totalSpent) / totalSpent) * 100 : 0;

    return `
      <div class="advertising-stats">
        <div class="stat-card">
          <div class="stat-label">Общий бюджет</div>
          <div class="stat-value">${totalBudget.toLocaleString()} ₽</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Потрачено</div>
          <div class="stat-value">${totalSpent.toLocaleString()} ₽</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Выручка</div>
          <div class="stat-value">${totalRevenue.toLocaleString()} ₽</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Заказы</div>
          <div class="stat-value">${totalOrders}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">ROI</div>
          <div class="stat-value ${avgROI >= 0 ? 'positive' : 'negative'}">
            ${avgROI.toFixed(1)}%
          </div>
        </div>
      </div>
    `;
  }

  private renderCampaignsList(): string {
    if (!this.campaigns.length) {
      return '<div class="empty-state">Нет активных кампаний. Создайте первую кампанию.</div>';
    }

    const filtered = this.selectedMarketplace === 'all'
      ? this.campaigns
      : this.campaigns.filter(c => c.marketplace === this.selectedMarketplace);

    const rows = filtered.map(c => `
      <tr>
        <td><span class="mp-badge mp-${c.marketplace}">${c.marketplace}</span></td>
        <td>${escape(c.name)}</td>
        <td><span class="status-badge status-${c.status}">${escape(c.status)}</span></td>
        <td>${escape(c.type)}</td>
        <td>${c.budget.toLocaleString()} ₽</td>
        <td>${c.spent.toLocaleString()} ₽</td>
        <td>${c.views.toLocaleString()}</td>
        <td>${c.clicks}</td>
        <td>${c.orders}</td>
        <td>${c.revenue.toLocaleString()} ₽</td>
        <td class="${c.roi >= 0 ? 'positive' : 'negative'}">${c.roi.toFixed(1)}%</td>
        <td>
          <button class="btn-sm btn-edit" data-campaign-id="${c.id}" data-marketplace="${c.marketplace}">
            ✏️
          </button>
          <button class="btn-sm btn-pause" data-campaign-id="${c.id}" data-marketplace="${c.marketplace}">
            ⏸️
          </button>
        </td>
      </tr>
    `).join('');

    return `
      <div class="campaigns-table-wrapper">
        <table class="campaigns-table">
          <thead>
            <tr>
              <th>МП</th>
              <th>Название</th>
              <th>Статус</th>
              <th>Тип</th>
              <th>Бюджет</th>
              <th>Потрачено</th>
              <th>Показы</th>
              <th>Клики</th>
              <th>Заказы</th>
              <th>Выручка</th>
              <th>ROI</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  private attachListeners(): void {
    // Marketplace filter
    const filter = this.container.querySelector('#marketplace-filter') as HTMLSelectElement;
    if (filter) {
      filter.value = this.selectedMarketplace;
      filter.addEventListener('change', (e) => {
        this.selectedMarketplace = (e.target as HTMLSelectElement).value as any;
        this.render();
      });
    }

    // Load button
    const loadBtn = this.container.querySelector('#load-campaigns-btn');
    if (loadBtn) {
      loadBtn.addEventListener('click', () => this.loadCampaigns());
    }

    // Create campaign button
    const createBtn = this.container.querySelector('#create-campaign-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => this.showCreateCampaignDialog());
    }

    // Edit/Pause buttons
    this.container.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const id = target.dataset.campaignId;
        const mp = target.dataset.marketplace;
        if (id && mp) {
          this.editCampaign(id, mp as 'ozon' | 'wb' | 'yandex');
        }
      });
    });

    this.container.querySelectorAll('.btn-pause').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const id = target.dataset.campaignId;
        const mp = target.dataset.marketplace;
        if (id && mp) {
          this.pauseCampaign(id, mp as 'ozon' | 'wb' | 'yandex');
        }
      });
    });

    // Tabs
    this.container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        this.container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        target.classList.add('active');
      });
    });
  }

  async loadCampaigns(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      const allCampaigns: Campaign[] = [];
      const stores = this.getAllStores();

      // Load from all marketplaces
      await Promise.all([
        this.loadOzonCampaigns(stores.ozon, allCampaigns),
        this.loadWbCampaigns(stores.wb, allCampaigns),
        this.loadYandexCampaigns(stores.yandex, allCampaigns),
      ]);

      this.campaigns = allCampaigns;
      toast.success(`Загружено ${allCampaigns.length} кампаний`);
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async loadOzonCampaigns(stores: OzonStore[], target: Campaign[]): Promise<void> {
    for (const store of stores) {
      try {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const promos = await ozonApi.getPromotions(creds);

        promos.forEach((p: any) => {
          target.push({
            marketplace: 'ozon',
            id: p.action_id ?? p.id,
            name: p.title ?? p.name ?? 'Акция Ozon',
            status: p.is_active ? 'active' : 'paused',
            type: p.action_type ?? 'promotion',
            budget: 0, // Ozon не предоставляет бюджет
            spent: 0,
            clicks: 0,
            views: 0,
            orders: 0,
            revenue: 0,
            roi: 0,
          });
        });
      } catch (err) {
        console.error('[Ozon Campaigns]', err);
      }
    }
  }

  private async loadWbCampaigns(stores: WbStore[], target: Campaign[]): Promise<void> {
    for (const store of stores) {
      try {
        const campaigns = await getWbCampaigns(store.api_key);

        for (const c of campaigns) {
          // Load stats for each campaign
          let stats: any = {};
          try {
            const now = new Date();
            const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const statsData = await fetchWbAdStats(
              store.api_key,
              [c.advertId],
              past.toISOString().split('T')[0],
              now.toISOString().split('T')[0],
            );
            if (statsData.length > 0) {
              stats = statsData[0];
            }
          } catch (err) {
            console.error('[WB Campaign Stats]', err);
          }

          const spent = stats.sum ?? 0;
          const revenue = (stats.orders ?? 0) * (stats.avgPrice ?? 0);
          const roi = spent > 0 ? ((revenue - spent) / spent) * 100 : 0;

          target.push({
            marketplace: 'wb',
            id: c.advertId,
            name: c.name ?? `Кампания ${c.advertId}`,
            status: c.status === 9 ? 'active' : c.status === 11 ? 'paused' : 'stopped',
            type: c.type === 8 ? 'Авто' : c.type === 6 ? 'Поиск' : 'Каталог',
            budget: c.dailyBudget ?? 0,
            spent,
            clicks: stats.clicks ?? 0,
            views: stats.views ?? 0,
            orders: stats.orders ?? 0,
            revenue,
            roi,
          });
        }
      } catch (err) {
        console.error('[WB Campaigns]', err);
      }
    }
  }

  private async loadYandexCampaigns(stores: YandexStore[], target: Campaign[]): Promise<void> {
    for (const store of stores) {
      try {
        // Яндекс пока не имеет API для рекламы (только акции)
        const promos = await getYandexPromos(store, 0); // TODO: get businessId

        promos.forEach((p: any) => {
          target.push({
            marketplace: 'yandex',
            id: p.id,
            name: p.name ?? 'Акция Яндекс',
            status: p.status === 'ACTIVE' ? 'active' : 'inactive',
            type: 'promotion',
            budget: 0,
            spent: 0,
            clicks: 0,
            views: 0,
            orders: 0,
            revenue: 0,
            roi: 0,
          });
        });
      } catch (err) {
        console.error('[Yandex Campaigns]', err);
      }
    }
  }

  private showCreateCampaignDialog(): void {
    const html = `
      <div class="modal-overlay" id="create-campaign-modal">
        <div class="modal-content">
          <h3>Создать рекламную кампанию</h3>
          <form id="create-campaign-form">
            <label>
              Маркетплейс:
              <select name="marketplace" required>
                <option value="wb">Wildberries</option>
                <option value="ozon">Ozon</option>
              </select>
            </label>
            <label>
              Название:
              <input type="text" name="name" required />
            </label>
            <label>
              Дневной бюджет (₽):
              <input type="number" name="budget" min="100" required />
            </label>
            <label>
              Тип кампании:
              <select name="type" required>
                <option value="8">Автоматическая</option>
                <option value="6">Поиск</option>
                <option value="7">Каталог</option>
              </select>
            </label>
            <div class="modal-actions">
              <button type="submit" class="btn-primary">Создать</button>
              <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const modal = document.createElement('div');
    modal.innerHTML = html;
    document.body.appendChild(modal.firstElementChild!);

    const form = document.getElementById('create-campaign-form') as HTMLFormElement;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(form);
      await this.createCampaign(
        formData.get('marketplace') as 'wb' | 'ozon',
        formData.get('name') as string,
        Number(formData.get('budget')),
        Number(formData.get('type')),
      );
      document.getElementById('create-campaign-modal')?.remove();
    });

    document.getElementById('cancel-modal')?.addEventListener('click', () => {
      document.getElementById('create-campaign-modal')?.remove();
    });
  }

  private async createCampaign(
    marketplace: 'wb' | 'ozon',
    name: string,
    dailyBudget: number,
    type: number,
  ): Promise<void> {
    try {
      if (marketplace === 'wb') {
        const stores = this.getAllStores().wb;
        if (stores.length > 0) {
          await createWbAdCampaign(stores[0].api_key, {
            name,
            subjectId: 0, // TODO: choose category
            type,
            nms: [], // TODO: choose products
            dailyBudget: dailyBudget * 100, // convert to kopecks
          });
          toast.success('Кампания создана');
          await this.loadCampaigns();
        }
      } else {
        toast.warning('Создание кампаний Ozon в разработке');
      }
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async editCampaign(_id: string, _marketplace: 'ozon' | 'wb' | 'yandex'): Promise<void> {
    toast.info('Редактирование кампаний в разработке');
  }

  private async pauseCampaign(id: string, marketplace: 'ozon' | 'wb' | 'yandex'): Promise<void> {
    try {
      if (marketplace === 'wb') {
        const stores = this.getAllStores().wb;
        if (stores.length > 0) {
          await updateWbCampaign(stores[0].api_key, Number(id), { status: 11 }); // 11 = pause
          toast.success('Кампания приостановлена');
          await this.loadCampaigns();
        }
      } else {
        toast.warning('Управление кампаниями ' + marketplace + ' в разработке');
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

  show(): void { this.container.style.display = 'flex'; }
  hide(): void { this.container.style.display = 'none'; }
}
