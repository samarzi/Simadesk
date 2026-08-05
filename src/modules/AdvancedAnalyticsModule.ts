/**
 * Продвинутая аналитика с прогнозами, трендами и сравнением периодов
 */

import { fetchWbSalesAnalytics } from '@/services/wbApi';
import { getYandexSkuStats } from '@/services/yandexApi';
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

interface ProductTrend {
  offerId: string;
  name: string;
  marketplace: string;
  currentRevenue: number;
  previousRevenue: number;
  trend: 'up' | 'down' | 'stable';
  trendPercent: number;
  forecast30days: number;
  views: number;
  conversion: number;
}

interface ComparisonData {
  metric: string;
  current: number;
  previous: number;
  change: number;
}

interface SeasonalityData {
  month: string;
  revenue: number;
  orders: number;
  avgPrice: number;
}

export class AdvancedAnalyticsModule {
  private container: HTMLElement;
  private loading = false;
  private trends: ProductTrend[] = [];
  private comparison: ComparisonData[] = [];
  private seasonality: SeasonalityData[] = [];
  private currentTab: 'trends' | 'forecast' | 'comparison' | 'seasonality' = 'trends';
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
      <div class="advanced-analytics">
        <div class="analytics-header">
          <h2>📈 Продвинутая аналитика</h2>
          <div class="analytics-controls">
            <input type="date" id="analytics-date-from" value="${this.dateFrom}" />
            <span>—</span>
            <input type="date" id="analytics-date-to" value="${this.dateTo}" />
            <button class="btn-primary" id="load-analytics-btn">
              ${this.loading ? 'Загрузка...' : 'Загрузить'}
            </button>
            <button class="btn-secondary" id="export-analytics-btn">📥 Экспорт</button>
          </div>
        </div>

        <div class="analytics-tabs">
          <button class="tab ${this.currentTab === 'trends' ? 'active' : ''}" data-tab="trends">
            Тренды продаж
          </button>
          <button class="tab ${this.currentTab === 'forecast' ? 'active' : ''}" data-tab="forecast">
            Прогноз спроса
          </button>
          <button class="tab ${this.currentTab === 'comparison' ? 'active' : ''}" data-tab="comparison">
            Сравнение периодов
          </button>
          <button class="tab ${this.currentTab === 'seasonality' ? 'active' : ''}" data-tab="seasonality">
            Сезонность
          </button>
        </div>

        <div class="tab-content">
          ${this.renderTabContent()}
        </div>
      </div>
    `;
    this.attachListeners();
  }

  private renderTabContent(): string {
    switch (this.currentTab) {
      case 'trends':
        return this.renderTrends();
      case 'forecast':
        return this.renderForecast();
      case 'comparison':
        return this.renderComparison();
      case 'seasonality':
        return this.renderSeasonality();
      default:
        return '';
    }
  }

  private renderTrends(): string {
    if (!this.trends.length) {
      return '<div class="empty-state">Нет данных. Загрузите аналитику.</div>';
    }

    const rows = this.trends.map(t => `
      <tr>
        <td><span class="mp-badge mp-${t.marketplace}">${t.marketplace}</span></td>
        <td>${escape(t.name)}</td>
        <td>${t.currentRevenue.toLocaleString()} ₽</td>
        <td>${t.previousRevenue.toLocaleString()} ₽</td>
        <td>
          <span class="trend-badge trend-${t.trend}">
            ${t.trend === 'up' ? '↑' : t.trend === 'down' ? '↓' : '→'} ${Math.abs(t.trendPercent).toFixed(1)}%
          </span>
        </td>
        <td>${t.views.toLocaleString()}</td>
        <td>${t.conversion.toFixed(2)}%</td>
        <td>${t.forecast30days.toLocaleString()} ₽</td>
      </tr>
    `).join('');

    return `
      <div class="trends-section">
        <table class="trends-table">
          <thead>
            <tr>
              <th>МП</th>
              <th>Товар</th>
              <th>Текущий период</th>
              <th>Предыдущий период</th>
              <th>Тренд</th>
              <th>Просмотры</th>
              <th>Конверсия</th>
              <th>Прогноз (30 дней)</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  private renderForecast(): string {
    if (!this.trends.length) {
      return '<div class="empty-state">Нет данных для прогноза. Загрузите аналитику.</div>';
    }

    const totalForecast = this.trends.reduce((sum, t) => sum + t.forecast30days, 0);
    const totalCurrent = this.trends.reduce((sum, t) => sum + t.currentRevenue, 0);
    const growthRate = totalCurrent > 0 ? ((totalForecast - totalCurrent) / totalCurrent) * 100 : 0;

    const topProducts = this.trends
      .sort((a, b) => b.forecast30days - a.forecast30days)
      .slice(0, 10)
      .map(t => `
        <div class="forecast-item">
          <div class="forecast-product">
            <span class="mp-badge mp-${t.marketplace}">${t.marketplace}</span>
            ${escape(t.name)}
          </div>
          <div class="forecast-value">${t.forecast30days.toLocaleString()} ₽</div>
          <div class="forecast-growth ${t.trendPercent >= 0 ? 'positive' : 'negative'}">
            ${t.trendPercent >= 0 ? '+' : ''}${t.trendPercent.toFixed(1)}%
          </div>
        </div>
      `).join('');

    return `
      <div class="forecast-section">
        <div class="forecast-summary">
          <div class="forecast-card">
            <div class="forecast-label">Прогноз на 30 дней</div>
            <div class="forecast-amount">${totalForecast.toLocaleString()} ₽</div>
          </div>
          <div class="forecast-card">
            <div class="forecast-label">Ожидаемый рост</div>
            <div class="forecast-amount ${growthRate >= 0 ? 'positive' : 'negative'}">
              ${growthRate >= 0 ? '+' : ''}${growthRate.toFixed(1)}%
            </div>
          </div>
        </div>

        <h3>Топ-10 товаров по прогнозу</h3>
        <div class="forecast-list">
          ${topProducts}
        </div>

        <div class="forecast-note">
          <strong>Примечание:</strong> Прогноз основан на трендах за выбранный период 
          и использует простую линейную экстраполяцию. Для точных прогнозов рекомендуется 
          учитывать сезонность и внешние факторы.
        </div>
      </div>
    `;
  }

  private renderComparison(): string {
    if (!this.comparison.length) {
      return '<div class="empty-state">Нет данных для сравнения. Загрузите аналитику.</div>';
    }

    const rows = this.comparison.map(c => `
      <tr>
        <td>${escape(c.metric)}</td>
        <td>${c.current.toLocaleString()}</td>
        <td>${c.previous.toLocaleString()}</td>
        <td class="${c.change >= 0 ? 'positive' : 'negative'}">
          ${c.change >= 0 ? '+' : ''}${c.change.toFixed(1)}%
        </td>
      </tr>
    `).join('');

    return `
      <div class="comparison-section">
        <table class="comparison-table">
          <thead>
            <tr>
              <th>Метрика</th>
              <th>Текущий период</th>
              <th>Предыдущий период</th>
              <th>Изменение</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  private renderSeasonality(): string {
    if (!this.seasonality.length) {
      return '<div class="empty-state">Нет данных о сезонности. Требуется история за год.</div>';
    }

    const rows = this.seasonality.map(s => `
      <tr>
        <td>${escape(s.month)}</td>
        <td>${s.revenue.toLocaleString()} ₽</td>
        <td>${s.orders}</td>
        <td>${s.avgPrice.toLocaleString()} ₽</td>
      </tr>
    `).join('');

    return `
      <div class="seasonality-section">
        <table class="seasonality-table">
          <thead>
            <tr>
              <th>Месяц</th>
              <th>Выручка</th>
              <th>Заказы</th>
              <th>Средний чек</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  private attachListeners(): void {
    // Date filters
    const dateFrom = this.container.querySelector('#analytics-date-from') as HTMLInputElement;
    const dateTo = this.container.querySelector('#analytics-date-to') as HTMLInputElement;

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
    const loadBtn = this.container.querySelector('#load-analytics-btn');
    if (loadBtn) {
      loadBtn.addEventListener('click', () => this.loadAnalytics());
    }

    // Export button
    const exportBtn = this.container.querySelector('#export-analytics-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportAnalytics());
    }

    // Tabs switching
    this.container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const tabName = target.dataset.tab as any;
        if (tabName) {
          this.currentTab = tabName;
          this.render();
        }
      });
    });
  }

  async loadAnalytics(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      await Promise.all([
        this.loadTrends(),
        this.loadComparison(),
        this.loadSeasonality(),
      ]);

      toast.success('Аналитика загружена');
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async loadTrends(): Promise<void> {
    this.trends = [];
    const stores = this.getAllStores();

    // Load from all marketplaces
    await Promise.all([
      this.loadOzonTrends(stores.ozon),
      this.loadWbTrends(stores.wb),
      this.loadYandexTrends(stores.yandex),
    ]);
  }

  private async loadOzonTrends(stores: OzonStore[]): Promise<void> {
    for (const store of stores) {
      try {
        // TODO: Implement actual analytics loading
        // const creds = { client_id: store.client_id, api_key: store.api_key };
        // const stats = await ozonApi.getProductStatistics(creds, productIds);
        console.log('Loading Ozon trends for', store.name);
      } catch (err) {
        console.error('[Ozon Analytics]', err);
      }
    }
  }

  private async loadWbTrends(stores: WbStore[]): Promise<void> {
    for (const store of stores) {
      try {
        // TODO: Process sales data and calculate trends
        await fetchWbSalesAnalytics(
          store.api_key,
          new Date(this.dateFrom).toISOString(),
        );
      } catch (err) {
        console.error('[WB Analytics]', err);
      }
    }
  }

  private async loadYandexTrends(stores: YandexStore[]): Promise<void> {
    for (const store of stores) {
      try {
        // TODO: Process stats and calculate trends
        await getYandexSkuStats(store, {
          dateFrom: this.dateFrom,
          dateTo: this.dateTo,
        });
      } catch (err) {
        console.error('[Yandex Analytics]', err);
      }
    }
  }

  private async loadComparison(): Promise<void> {
    // Calculate comparison metrics
    const totalCurrent = this.trends.reduce((sum, t) => sum + t.currentRevenue, 0);
    const totalPrevious = this.trends.reduce((sum, t) => sum + t.previousRevenue, 0);

    this.comparison = [
      {
        metric: 'Выручка',
        current: totalCurrent,
        previous: totalPrevious,
        change: totalPrevious > 0 ? ((totalCurrent - totalPrevious) / totalPrevious) * 100 : 0,
      },
      {
        metric: 'Средний чек',
        current: totalCurrent / (this.trends.length || 1),
        previous: totalPrevious / (this.trends.length || 1),
        change: 0,
      },
    ];
  }

  private async loadSeasonality(): Promise<void> {
    // TODO: Implement seasonality analysis
    this.seasonality = [];
  }

  private exportAnalytics(): void {
    const csv = [
      ['Маркетплейс', 'Товар', 'Текущая выручка', 'Предыдущая выручка', 'Тренд %', 'Прогноз'],
      ...this.trends.map(t => [
        t.marketplace,
        t.name,
        t.currentRevenue.toString(),
        t.previousRevenue.toString(),
        t.trendPercent.toFixed(2),
        t.forecast30days.toString(),
      ]),
    ].map(row => row.join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `analytics-${this.dateFrom}-${this.dateTo}.csv`;
    link.click();

    toast.success('Аналитика экспортирована');
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
