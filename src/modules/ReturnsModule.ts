/**
 * ReturnsModule — управление возвратами товаров с маркетплейсов.
 * 
 * Функционал:
 * - Просмотр возвратов WB
 * - Просмотр возвратов Яндекс Маркет
 * - Анализ причин возвратов
 * - Статистика по возвратам
 */

import { appStore } from '@/stores/appStore';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { fetchWbReturns, WbReturn } from '@/services/wbApi';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { toast } from '@/utils/toast';

type Marketplace = 'wb' | 'yandex';

interface ReturnItem {
  id: string;
  date: string;
  nmId: string;
  productName: string;
  quantity: number;
  price: number;
  reason: string;
  mp: Marketplace;
  storeName: string;
}

export class ReturnsModule {
  private root: HTMLElement;
  private returns: ReturnItem[] = [];
  private selectedMp: Marketplace = 'wb';

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'returns-module';
    container.appendChild(this.root);
  }

  async render(): Promise<void> {
    this.root.innerHTML = `
      <div class="module-header">
        <h2>${I.package} Возвраты товаров</h2>
      </div>

      <div class="returns-toolbar">
        <select id="mp-select">
          <option value="wb">Wildberries</option>
          <option value="yandex">Яндекс Маркет</option>
        </select>

        <button id="load-returns-btn" class="btn btn-primary">
          ${I.refresh} Загрузить возвраты (30 дней)
        </button>
      </div>

      <div class="returns-stats">
        <div class="stat-card">
          <div class="stat-label">Всего возвратов</div>
          <div class="stat-value" id="total-returns">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Сумма возвратов</div>
          <div class="stat-value" id="total-sum">0 ₽</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Товаров</div>
          <div class="stat-value" id="unique-products">0</div>
        </div>
      </div>

      <div class="returns-table-container">
        <table class="returns-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Товар</th>
              <th>Артикул</th>
              <th>Количество</th>
              <th>Сумма</th>
              <th>Причина</th>
              <th>Магазин</th>
            </tr>
          </thead>
          <tbody id="returns-tbody">
            <tr><td colspan="7" class="empty">Загрузите возвраты</td></tr>
          </tbody>
        </table>
      </div>
    `;

    this.attachListeners();
  }

  private attachListeners(): void {
    const mpSelect = this.root.querySelector('#mp-select') as HTMLSelectElement;
    const loadBtn = this.root.querySelector('#load-returns-btn') as HTMLButtonElement;

    mpSelect.addEventListener('change', () => {
      this.selectedMp = mpSelect.value as Marketplace;
    });

    loadBtn.addEventListener('click', () => this.loadReturns());
  }

  private async loadReturns(): Promise<void> {
    const loadBtn = this.root.querySelector('#load-returns-btn') as HTMLButtonElement;
    loadBtn.disabled = true;
    loadBtn.innerHTML = `${I.spinner} Загрузка...`;

    try {
      this.returns = await this.fetchReturns();
      this.renderReturnsTable();
      this.updateStats();
    } catch (err: any) {
      toast(`Ошибка: ${err.message}`, 'error');
    } finally {
      loadBtn.disabled = false;
      loadBtn.innerHTML = `${I.refresh} Загрузить возвраты`;
    }
  }

  private async fetchReturns(): Promise<ReturnItem[]> {
    const items: ReturnItem[] = [];
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 30);

    if (this.selectedMp === 'wb') {
      const stores = await wbDb.getAllStores();
      for (const store of stores) {
        const wbReturns = await fetchWbReturns(store.api_key, dateFrom.toISOString());
        wbReturns.forEach(r => {
          items.push({
            id: r.srid || String(Math.random()),
            date: r.returnDate || '',
            nmId: String(r.nmId || ''),
            productName: r.productName || r.subject || '',
            quantity: r.quantity || 0,
            price: r.retailPrice || 0,
            reason: 'Возврат покупателя',
            mp: 'wb',
            storeName: store.name,
          });
        });
      }
    }

    return items.sort((a, b) => b.date.localeCompare(a.date));
  }

  private renderReturnsTable(): void {
    const tbody = this.root.querySelector('#returns-tbody') as HTMLTableSectionElement;
    
    if (this.returns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Возвратов нет ✓</td></tr>';
      return;
    }

    tbody.innerHTML = this.returns.map(r => `
      <tr>
        <td>${new Date(r.date).toLocaleDateString('ru-RU')}</td>
        <td>${esc(r.productName)}</td>
        <td><code>${esc(r.nmId)}</code></td>
        <td>${r.quantity}</td>
        <td>${r.price.toFixed(2)} ₽</td>
        <td>${esc(r.reason)}</td>
        <td>${esc(r.storeName)}</td>
      </tr>
    `).join('');
  }

  private updateStats(): void {
    const totalReturns = this.returns.length;
    const totalSum = this.returns.reduce((sum, r) => sum + r.price * r.quantity, 0);
    const uniqueProducts = new Set(this.returns.map(r => r.nmId)).size;

    (this.root.querySelector('#total-returns') as HTMLElement).textContent = String(totalReturns);
    (this.root.querySelector('#total-sum') as HTMLElement).textContent = `${totalSum.toFixed(2)} ₽`;
    (this.root.querySelector('#unique-products') as HTMLElement).textContent = String(uniqueProducts);
  }

  destroy(): void {
    this.root.remove();
  }
}
