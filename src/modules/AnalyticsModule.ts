/**
 * AnalyticsModule — детальная аналитика продаж и конверсии.
 * 
 * Функционал:
 * - Аналитика Ozon (просмотры, конверсия, заказы)
 * - Аналитика WB (продажи по регионам)
 * - Аналитика ЯМ (клики, показы, CTR)
 * - Графики и статистика
 */

import { ozonApi } from '@/services/ozonApi';
import { fetchWbSalesAnalytics, WbSale } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { toast } from '@/utils/toast';

type Marketplace = 'ozon' | 'wb' | 'yandex';

export class AnalyticsModule {
  private root: HTMLElement;
  private selectedMp: Marketplace = 'ozon';
  private data: any[] = [];

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'analytics-module';
    container.appendChild(this.root);
  }

  async render(): Promise<void> {
    this.root.innerHTML = `
      <div class="module-header">
        <h2>${I.chart} Аналитика продаж</h2>
      </div>

      <div class="analytics-toolbar">
        <select id="mp-select">
          <option value="ozon">Ozon (просмотры, конверсия)</option>
          <option value="wb">WB (продажи, регионы)</option>
          <option value="yandex">ЯМ (клики, показы, CTR)</option>
        </select>

        <input type="date" id="date-from">
        <input type="date" id="date-to">

        <button id="load-analytics-btn" class="btn btn-primary">
          ${I.refresh} Загрузить
        </button>
      </div>

      <div class="analytics-content">
        <div class="analytics-cards">
          <div class="stat-card">
            <div class="stat-label">Просмотры</div>
            <div class="stat-value" id="stat-views">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Заказы</div>
            <div class="stat-value" id="stat-orders">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Конверсия</div>
            <div class="stat-value" id="stat-conversion">0%</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Выручка</div>
            <div class="stat-value" id="stat-revenue">0 ₽</div>
          </div>
        </div>

        <div class="analytics-table-container">
          <table class="analytics-table">
            <thead id="analytics-thead"></thead>
            <tbody id="analytics-tbody">
              <tr><td colspan="10" class="empty">Загрузите аналитику</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    this.attachListeners();
    this.setDefaultDates();
  }

  private setDefaultDates(): void {
    const today = new Date();
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    (this.root.querySelector('#date-to') as HTMLInputElement).valueAsDate = today;
    (this.root.querySelector('#date-from') as HTMLInputElement).valueAsDate = monthAgo;
  }

  private attachListeners(): void {
    const mpSelect = this.root.querySelector('#mp-select') as HTMLSelectElement;
    const loadBtn = this.root.querySelector('#load-analytics-btn') as HTMLButtonElement;

    mpSelect.addEventListener('change', () => {
      this.selectedMp = mpSelect.value as Marketplace;
    });

    loadBtn.addEventListener('click', () => this.loadAnalytics());
  }

  private async loadAnalytics(): Promise<void> {
    const dateFrom = (this.root.querySelector('#date-from') as HTMLInputElement).value;
    const dateTo = (this.root.querySelector('#date-to') as HTMLInputElement).value;

    if (!dateFrom || !dateTo) {
      toast('Выберите период', 'warning');
      return;
    }

    const loadBtn = this.root.querySelector('#load-analytics-btn') as HTMLButtonElement;
    loadBtn.disabled = true;
    loadBtn.innerHTML = `${I.spinner} Загрузка...`;

    try {
      if (this.selectedMp === 'ozon') {
        await this.loadOzonAnalytics(dateFrom, dateTo);
      } else if (this.selectedMp === 'wb') {
        await this.loadWbAnalytics(dateFrom);
      } else if (this.selectedMp === 'yandex') {
        await this.loadYandexAnalytics(dateFrom, dateTo);
      }
    } catch (err: any) {
      toast(`Ошибка: ${err.message}`, 'error');
    } finally {
      loadBtn.disabled = false;
      loadBtn.innerHTML = `${I.refresh} Загрузить`;
    }
  }

  private async loadOzonAnalytics(dateFrom: string, dateTo: string): Promise<void> {
    const stores = await ozonDb.getAllStores();
    const allData: any[] = [];

    for (const store of stores) {
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const resp = await ozonApi.getAnalytics(creds, dateFrom, dateTo);
      const rows = resp.result?.data ?? [];
      allData.push(...rows.map((r: any) => ({ ...r, storeName: store.name })));
    }

    this.data = allData;
    this.renderOzonTable();
    this.updateOzonStats();
  }

  private renderOzonTable(): void {
    const thead = this.root.querySelector('#analytics-thead') as HTMLTableSectionElement;
    const tbody = this.root.querySelector('#analytics-tbody') as HTMLTableSectionElement;

    thead.innerHTML = `
      <tr>
        <th>SKU</th>
        <th>Просмотры</th>
        <th>В корзину</th>
        <th>Заказы</th>
        <th>Выручка</th>
        <th>Конверсия</th>
        <th>Магазин</th>
      </tr>
    `;

    if (this.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Нет данных</td></tr>';
      return;
    }

    tbody.innerHTML = this.data.map((d: any) => {
      const views = d.hits_view || 0;
      const orders = d.ordered_units || 0;
      const conversion = views > 0 ? ((orders / views) * 100).toFixed(2) : '0.00';
      
      return `
        <tr>
          <td><code>${esc(String(d.sku || ''))}</code></td>
          <td>${views.toLocaleString()}</td>
          <td>${d.hits_tocart || 0}</td>
          <td>${orders}</td>
          <td>${(d.revenue || 0).toFixed(2)} ₽</td>
          <td>${conversion}%</td>
          <td>${esc(d.storeName)}</td>
        </tr>
      `;
    }).join('');
  }

  private updateOzonStats(): void {
    const totalViews = this.data.reduce((sum, d) => sum + (d.hits_view || 0), 0);
    const totalOrders = this.data.reduce((sum, d) => sum + (d.ordered_units || 0), 0);
    const totalRevenue = this.data.reduce((sum, d) => sum + (d.revenue || 0), 0);
    const conversion = totalViews > 0 ? ((totalOrders / totalViews) * 100).toFixed(2) : '0.00';

    (this.root.querySelector('#stat-views') as HTMLElement).textContent = totalViews.toLocaleString();
    (this.root.querySelector('#stat-orders') as HTMLElement).textContent = totalOrders.toLocaleString();
    (this.root.querySelector('#stat-conversion') as HTMLElement).textContent = `${conversion}%`;
    (this.root.querySelector('#stat-revenue') as HTMLElement).textContent = `${totalRevenue.toFixed(2)} ₽`;
  }

  private async loadWbAnalytics(dateFrom: string): Promise<void> {
    const stores = await wbDb.getAllStores();
    const allSales: WbSale[] = [];

    for (const store of stores) {
      const sales = await fetchWbSalesAnalytics(store.api_key, dateFrom);
      allSales.push(...sales);
    }

    this.data = allSales;
    this.renderWbTable();
    this.updateWbStats();
  }

  private renderWbTable(): void {
    const thead = this.root.querySelector('#analytics-thead') as HTMLTableSectionElement;
    const tbody = this.root.querySelector('#analytics-tbody') as HTMLTableSectionElement;

    thead.innerHTML = `
      <tr>
        <th>Дата</th>
        <th>Товар</th>
        <th>Регион</th>
        <th>Количество</th>
        <th>Сумма</th>
        <th>К выплате</th>
      </tr>
    `;

    if (this.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Нет данных</td></tr>';
      return;
    }

    tbody.innerHTML = this.data.map((s: WbSale) => `
      <tr>
        <td>${new Date(s.date || '').toLocaleDateString('ru-RU')}</td>
        <td>${esc(s.subject || '')}</td>
        <td>${esc(s.regionName || '')}</td>
        <td>${s.quantity || 0}</td>
        <td>${(s.priceWithDisc || 0).toFixed(2)} ₽</td>
        <td>${(s.forPay || 0).toFixed(2)} ₽</td>
      </tr>
    `).join('');
  }

  private updateWbStats(): void {
    const totalQty = this.data.reduce((sum, s: WbSale) => sum + (s.quantity || 0), 0);
    const totalRevenue = this.data.reduce((sum, s: WbSale) => sum + (s.priceWithDisc || 0) * (s.quantity || 0), 0);
    const regions = new Set(this.data.map((s: WbSale) => s.regionName)).size;

    (this.root.querySelector('#stat-views') as HTMLElement).textContent = `${regions} регионов`;
    (this.root.querySelector('#stat-orders') as HTMLElement).textContent = totalQty.toLocaleString();
    (this.root.querySelector('#stat-conversion') as HTMLElement).textContent = '-';
    (this.root.querySelector('#stat-revenue') as HTMLElement).textContent = `${totalRevenue.toFixed(2)} ₽`;
  }

  private async loadYandexAnalytics(dateFrom: string, dateTo: string): Promise<void> {
    const stores = await yandexDb.getAllStores();
    const allData: any[] = [];

    for (const store of stores) {
      if (!store.campaign_id) continue;
      const skus = await yandexApi.getSkuStats(store.api_key, store.campaign_id, dateFrom, dateTo);
      allData.push(...skus.map((s: any) => ({ ...s, storeName: store.name })));
    }

    this.data = allData;
    this.renderYandexTable();
    this.updateYandexStats();
  }

  private renderYandexTable(): void {
    const thead = this.root.querySelector('#analytics-thead') as HTMLTableSectionElement;
    const tbody = this.root.querySelector('#analytics-tbody') as HTMLTableSectionElement;

    thead.innerHTML = `
      <tr>
        <th>SKU</th>
        <th>Показы</th>
        <th>Клики</th>
        <th>CTR</th>
        <th>Заказы</th>
        <th>Магазин</th>
      </tr>
    `;

    if (this.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Нет данных</td></tr>';
      return;
    }

    tbody.innerHTML = this.data.map((d: any) => {
      const shows = d.SHOWS || 0;
      const clicks = d.CLICKS || 0;
      const ctr = shows > 0 ? ((clicks / shows) * 100).toFixed(2) : '0.00';

      return `
        <tr>
          <td><code>${esc(d.shopSku || '')}</code></td>
          <td>${shows.toLocaleString()}</td>
          <td>${clicks}</td>
          <td>${ctr}%</td>
          <td>${d.ORDERS || 0}</td>
          <td>${esc(d.storeName)}</td>
        </tr>
      `;
    }).join('');
  }

  private updateYandexStats(): void {
    const totalShows = this.data.reduce((sum, d: any) => sum + (d.SHOWS || 0), 0);
    const totalClicks = this.data.reduce((sum, d: any) => sum + (d.CLICKS || 0), 0);
    const totalOrders = this.data.reduce((sum, d: any) => sum + (d.ORDERS || 0), 0);
    const ctr = totalShows > 0 ? ((totalClicks / totalShows) * 100).toFixed(2) : '0.00';

    (this.root.querySelector('#stat-views') as HTMLElement).textContent = totalShows.toLocaleString();
    (this.root.querySelector('#stat-orders') as HTMLElement).textContent = totalOrders.toLocaleString();
    (this.root.querySelector('#stat-conversion') as HTMLElement).textContent = `${ctr}% CTR`;
    (this.root.querySelector('#stat-revenue') as HTMLElement).textContent = `${totalClicks} кликов`;
  }

  destroy(): void {
    this.root.remove();
  }
}
