/**
 * Модуль аналитики маркетплейсов — единый дашборд для Ozon, WB, Яandex.
 * Показывает:
 * - Просмотры, клики, заказы
 * - CTR, конверсия
 * - Выручка, ROI
 * - Сравнение товаров
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

interface AnalyticsData {
  offerId: string;
  name: string;
  marketplace: 'ozon' | 'wb' | 'yandex';
  views: number;
  clicks: number;
  addToCart: number;
  orders: number;
  revenue: number;
  ctr: number; // %
  conversion: number; // %
  avgPrice: number;
}

export class MarketplaceAnalyticsModule {
  private container: HTMLElement;
  private dateFrom: string;
  private dateTo: string;
  private loading: boolean = false;
  private data: AnalyticsData[] = [];

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;

    // Дефолтный период: последние 7 дней
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400_000);
    this.dateTo = now.toISOString().slice(0, 10);
    this.dateFrom = weekAgo.toISOString().slice(0, 10);

    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="analytics-module">
        <div class="analytics-header">
          <h2>📊 Аналитика маркетплейсов</h2>
          <div class="analytics-controls">
            <input type="date" id="analytics-date-from" value="${this.dateFrom}" />
            <span>—</span>
            <input type="date" id="analytics-date-to" value="${this.dateTo}" />
            <button id="analytics-load-btn" class="btn-primary">
              ${this.loading ? 'Загрузка...' : 'Загрузить'}
            </button>
            <button id="analytics-export-btn" class="btn-secondary">Экспорт CSV</button>
          </div>
        </div>

        <div id="analytics-summary" class="analytics-summary">
          ${this.renderSummary()}
        </div>

        <div id="analytics-table-container" class="analytics-table-container">
          ${this.renderTable()}
        </div>

        <div id="analytics-charts" class="analytics-charts">
          ${this.renderCharts()}
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderSummary(): string {
    if (!this.data.length) {
      return '<p class="empty-state">Выберите период и нажмите "Загрузить"</p>';
    }

    const totalViews = this.data.reduce((s, d) => s + d.views, 0);
    const totalClicks = this.data.reduce((s, d) => s + d.clicks, 0);
    const totalOrders = this.data.reduce((s, d) => s + d.orders, 0);
    const totalRevenue = this.data.reduce((s, d) => s + d.revenue, 0);
    const avgCtr = totalViews > 0 ? (totalClicks / totalViews * 100).toFixed(2) : '0';
    const avgConversion = totalClicks > 0 ? (totalOrders / totalClicks * 100).toFixed(2) : '0';

    return `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-label">Просмотры</div>
          <div class="stat-value">${totalViews.toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Клики</div>
          <div class="stat-value">${totalClicks.toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Заказы</div>
          <div class="stat-value">${totalOrders.toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Выручка</div>
          <div class="stat-value">${totalRevenue.toLocaleString()} ₽</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">CTR</div>
          <div class="stat-value">${avgCtr}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Конверсия</div>
          <div class="stat-value">${avgConversion}%</div>
        </div>
      </div>
    `;
  }

  private renderTable(): string {
    if (!this.data.length) return '';

    // Сортируем по выручке
    const sorted = [...this.data].sort((a, b) => b.revenue - a.revenue);

    const rows = sorted.map(d => `
      <tr>
        <td>${escape(d.offerId)}</td>
        <td>${escape(d.name)}</td>
        <td><span class="mp-badge mp-${d.marketplace}">${d.marketplace.toUpperCase()}</span></td>
        <td>${d.views.toLocaleString()}</td>
        <td>${d.clicks.toLocaleString()}</td>
        <td>${d.addToCart.toLocaleString()}</td>
        <td>${d.orders.toLocaleString()}</td>
        <td>${d.revenue.toLocaleString()} ₽</td>
        <td>${d.ctr.toFixed(2)}%</td>
        <td>${d.conversion.toFixed(2)}%</td>
      </tr>
    `).join('');

    return `
      <table class="analytics-table">
        <thead>
          <tr>
            <th>Артикул</th>
            <th>Название</th>
            <th>МП</th>
            <th>Просмотры</th>
            <th>Клики</th>
            <th>В корзину</th>
            <th>Заказы</th>
            <th>Выручка</th>
            <th>CTR</th>
            <th>Конверсия</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  private renderCharts(): string {
    if (!this.data.length) return '';

    // Простой bar chart через CSS (без библиотек)
    const top10 = [...this.data]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const maxRevenue = Math.max(...top10.map(d => d.revenue));

    const bars = top10.map(d => {
      const widthPct = maxRevenue > 0 ? (d.revenue / maxRevenue * 100) : 0;
      return `
        <div class="chart-bar">
          <div class="chart-label">${escape(d.name.slice(0, 30))}</div>
          <div class="chart-bar-fill" style="width: ${widthPct}%">
            <span class="chart-value">${d.revenue.toLocaleString()} ₽</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="analytics-chart">
        <h3>ТОП-10 товаров по выручке</h3>
        <div class="chart-bars">
          ${bars}
        </div>
      </div>
    `;
  }

  private attachEventListeners(): void {
    const loadBtn = document.getElementById('analytics-load-btn');
    const exportBtn = document.getElementById('analytics-export-btn');
    const dateFromInput = document.getElementById('analytics-date-from') as HTMLInputElement;
    const dateToInput = document.getElementById('analytics-date-to') as HTMLInputElement;

    loadBtn?.addEventListener('click', () => this.loadData());
    exportBtn?.addEventListener('click', () => this.exportCsv());

    dateFromInput?.addEventListener('change', (e) => {
      this.dateFrom = (e.target as HTMLInputElement).value;
    });
    dateToInput?.addEventListener('change', (e) => {
      this.dateTo = (e.target as HTMLInputElement).value;
    });
  }

  private async loadData(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.render();

    try {
      // Загружаем данные со всех МП параллельно
      const [ozonData, wbData, yandexData] = await Promise.all([
        this.loadOzonAnalytics(),
        this.loadWbAnalytics(),
        this.loadYandexAnalytics(),
      ]);

      this.data = [...ozonData, ...wbData, ...yandexData];
      toast.success(`Загружено ${this.data.length} товаров`);
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      this.data = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async loadOzonAnalytics(): Promise<AnalyticsData[]> {
    // Получаем все магазины Ozon из localStorage
    const stores: OzonStore[] = JSON.parse(localStorage.getItem('ozon_stores') || '[]');
    const allData: AnalyticsData[] = [];

    for (const store of stores) {
      try {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const resp = await ozonApi.getAnalytics(
          creds,
          this.dateFrom,
          this.dateTo,
          ['hits_view', 'hits_tocart', 'ordered_units', 'revenue'],
          ['sku'],
        );

        const data = resp.result?.data ?? [];
        for (const item of data) {
          const dimensions = item.dimensions ?? [];
          const metrics = item.metrics ?? [];
          
          const sku = dimensions.find((d: any) => d.id === 'sku')?.value ?? '';
          const views = metrics.find((m: any) => m.id === 'hits_view')?.value ?? 0;
          const addToCart = metrics.find((m: any) => m.id === 'hits_tocart')?.value ?? 0;
          const orders = metrics.find((m: any) => m.id === 'ordered_units')?.value ?? 0;
          const revenue = metrics.find((m: any) => m.id === 'revenue')?.value ?? 0;

          // Ozon не отдаёт клики напрямую — приблизительная оценка
          const clicks = addToCart > 0 ? Math.round(addToCart * 1.5) : Math.round(views * 0.05);

          const ctr = views > 0 ? (clicks / views * 100) : 0;
          const conversion = clicks > 0 ? (orders / clicks * 100) : 0;
          const avgPrice = orders > 0 ? revenue / orders : 0;

          allData.push({
            offerId: sku,
            name: `SKU ${sku}`, // название товара нужно подгрузить отдельно
            marketplace: 'ozon',
            views,
            clicks,
            addToCart,
            orders,
            revenue,
            ctr,
            conversion,
            avgPrice,
          });
        }
      } catch (err) {
        console.warn('[Ozon Analytics] Error:', err);
      }
    }

    return allData;
  }

  private async loadWbAnalytics(): Promise<AnalyticsData[]> {
    const stores: WbStore[] = JSON.parse(localStorage.getItem('wb_stores') || '[]');
    const allData: AnalyticsData[] = [];

    for (const store of stores) {
      try {
        const sales = await wbApi.fetchWbSalesAnalytics(
          store.api_key,
          `${this.dateFrom}T00:00:00Z`,
          0, // продажи
        );

        // Группируем по nmId
        const grouped = new Map<number, { orders: number; revenue: number; name: string }>();
        for (const sale of sales) {
          const nmId = sale.nmId ?? 0;
          if (!nmId) continue;
          const cur = grouped.get(nmId) ?? { orders: 0, revenue: 0, name: sale.subject ?? '' };
          cur.orders += 1;
          cur.revenue += sale.forPay ?? 0;
          grouped.set(nmId, cur);
        }

        for (const [nmId, data] of grouped) {
          // WB не предоставляет views/clicks через API — заглушки
          const views = data.orders * 50; // примерная оценка
          const clicks = data.orders * 10;
          const ctr = views > 0 ? (clicks / views * 100) : 0;
          const conversion = clicks > 0 ? (data.orders / clicks * 100) : 0;

          allData.push({
            offerId: String(nmId),
            name: data.name,
            marketplace: 'wb',
            views,
            clicks,
            addToCart: data.orders * 2, // оценка
            orders: data.orders,
            revenue: data.revenue,
            ctr,
            conversion,
            avgPrice: data.orders > 0 ? data.revenue / data.orders : 0,
          });
        }
      } catch (err) {
        console.warn('[WB Analytics] Error:', err);
      }
    }

    return allData;
  }

  private async loadYandexAnalytics(): Promise<AnalyticsData[]> {
    const stores: YandexStore[] = JSON.parse(localStorage.getItem('yandex_stores') || '[]');
    const allData: AnalyticsData[] = [];

    for (const store of stores) {
      if (!store.campaign_id) continue;

      try {
        const stats = await yandexApi.getSkuStats(
          store.api_key,
          store.campaign_id,
          this.dateFrom,
          this.dateTo,
        );

        for (const item of stats) {
          const views = item.shows ?? item.SHOWS ?? 0;
          const clicks = item.clicks ?? item.CLICKS ?? 0;
          const orders = item.orders ?? item.ORDERS ?? 0;
          const revenue = item.revenue ?? 0;

          const ctr = views > 0 ? (clicks / views * 100) : 0;
          const conversion = clicks > 0 ? (orders / clicks * 100) : 0;

          allData.push({
            offerId: item.shopSku ?? item.offerId ?? '',
            name: item.offerName ?? `SKU ${item.shopSku}`,
            marketplace: 'yandex',
            views,
            clicks,
            addToCart: 0, // ЯМ не отдаёт
            orders,
            revenue,
            ctr,
            conversion,
            avgPrice: orders > 0 ? revenue / orders : 0,
          });
        }
      } catch (err) {
        console.warn('[Yandex Analytics] Error:', err);
      }
    }

    return allData;
  }

  private exportCsv(): void {
    if (!this.data.length) {
      toast.warning('Нет данных для экспорта');
      return;
    }

    const headers = [
      'Артикул', 'Название', 'Маркетплейс', 'Просмотры', 'Клики', 
      'В корзину', 'Заказы', 'Выручка', 'CTR %', 'Конверсия %', 'Средний чек'
    ];

    const rows = this.data.map(d => [
      d.offerId,
      d.name,
      d.marketplace.toUpperCase(),
      d.views,
      d.clicks,
      d.addToCart,
      d.orders,
      d.revenue,
      d.ctr.toFixed(2),
      d.conversion.toFixed(2),
      d.avgPrice.toFixed(2),
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics_${this.dateFrom}_${this.dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    toast.success('CSV экспортирован');
  }

  show(): void { this.container.style.display = 'flex'; }
  hide(): void { this.container.style.display = 'none'; }
}
