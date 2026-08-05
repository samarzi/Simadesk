/**
 * Модуль управления контентом товаров
 * Content Management Module - bulk editing, media upload, SEO optimization
 */

import { uploadWbMedia } from '@/services/wbApi';
import type { OzonStore } from '@/types/ozon';
import type { WbStore } from '@/types/wb';

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

interface Product {
  marketplace: 'ozon' | 'wb' | 'yandex';
  id: string;
  name: string;
  description: string;
  images: string[];
  hasVideo: boolean;
  seoScore: number;
}

export class ContentManagementModule {
  private container: HTMLElement;
  private products: Product[] = [];
  private selectedProducts: Set<string> = new Set();

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="content-management">
        <div class="content-header">
          <h2>📝 Управление контентом</h2>
          <div class="content-controls">
            <button class="btn-primary" id="bulk-edit-btn" ${this.selectedProducts.size === 0 ? 'disabled' : ''}>
              ✏️ Массовое редактирование (${this.selectedProducts.size})
            </button>
            <button class="btn-secondary" id="upload-media-btn">
              📤 Загрузить медиа
            </button>
            <button class="btn-secondary" id="seo-optimize-btn">
              🔍 SEO-оптимизация
            </button>
          </div>
        </div>

        <div class="content-tabs">
          <button class="tab active" data-tab="products">Товары</button>
          <button class="tab" data-tab="bulk">Массовые операции</button>
          <button class="tab" data-tab="media">Медиа</button>
          <button class="tab" data-tab="seo">SEO</button>
        </div>

        <div class="tab-content">
          ${this.renderProductsList()}
        </div>
      </div>
    `;

    this.attachListeners();
  }

  private renderProductsList(): string {
    if (!this.products.length) {
      return `
        <div class="empty-state">
          <p>Нет товаров для редактирования.</p>
          <button class="btn-primary" id="load-products-btn">Загрузить товары</button>
        </div>
      `;
    }

    const rows = this.products.map(p => `
      <tr>
        <td>
          <input 
            type="checkbox" 
            class="product-checkbox" 
            data-product-id="${p.id}"
            ${this.selectedProducts.has(p.id) ? 'checked' : ''}
          />
        </td>
        <td><span class="mp-badge mp-${p.marketplace}">${p.marketplace}</span></td>
        <td>
          <div class="product-preview">
            ${p.images[0] ? `<img src="${p.images[0]}" alt="" />` : '<div class="no-image">Нет фото</div>'}
          </div>
        </td>
        <td>
          <div class="product-title">${escape(p.name)}</div>
          <div class="product-id">ID: ${escape(p.id)}</div>
        </td>
        <td>
          <div class="description-preview" title="${escape(p.description)}">
            ${escape(p.description.slice(0, 100))}${p.description.length > 100 ? '...' : ''}
          </div>
        </td>
        <td>
          <span class="badge">${p.images.length} фото</span>
          ${p.hasVideo ? '<span class="badge badge-video">Видео</span>' : ''}
        </td>
        <td>
          <div class="seo-score score-${this.getSeoScoreClass(p.seoScore)}">
            ${p.seoScore}/100
          </div>
        </td>
        <td>
          <button class="btn-sm btn-edit" data-product-id="${p.id}">
            ✏️ Редактировать
          </button>
        </td>
      </tr>
    `).join('');

    return `
      <div class="products-filters">
        <input type="text" id="search-products" placeholder="Поиск по названию..." class="form-input" />
        <select id="marketplace-filter" class="form-select">
          <option value="all">Все МП</option>
          <option value="ozon">Ozon</option>
          <option value="wb">Wildberries</option>
          <option value="yandex">Яндекс</option>
        </select>
        <select id="seo-filter" class="form-select">
          <option value="all">Любой SEO</option>
          <option value="low">Низкий (&lt;50)</option>
          <option value="medium">Средний (50-80)</option>
          <option value="high">Высокий (&gt;80)</option>
        </select>
      </div>

      <div class="products-table-wrapper">
        <table class="products-table">
          <thead>
            <tr>
              <th>
                <input type="checkbox" id="select-all-products" />
              </th>
              <th>МП</th>
              <th>Фото</th>
              <th>Название</th>
              <th>Описание</th>
              <th>Медиа</th>
              <th>SEO</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div class="content-actions">
        <button class="btn-secondary" id="export-csv-btn">📥 Экспорт в CSV</button>
        <button class="btn-secondary" id="import-csv-btn">📤 Импорт из CSV</button>
      </div>
    `;
  }

  private getSeoScoreClass(score: number): string {
    if (score < 50) return 'low';
    if (score < 80) return 'medium';
    return 'high';
  }

  private attachListeners(): void {
    // Load products button
    const loadBtn = this.container.querySelector('#load-products-btn');
    if (loadBtn) {
      loadBtn.addEventListener('click', () => this.loadProducts());
    }

    // Product checkboxes
    this.container.querySelectorAll('.product-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const productId = target.dataset.productId;
        if (productId) {
          if (target.checked) {
            this.selectedProducts.add(productId);
          } else {
            this.selectedProducts.delete(productId);
          }
          this.render();
        }
      });
    });

    // Select all checkbox
    const selectAll = this.container.querySelector('#select-all-products');
    if (selectAll) {
      selectAll.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        if (checked) {
          this.products.forEach(p => this.selectedProducts.add(p.id));
        } else {
          this.selectedProducts.clear();
        }
        this.render();
      });
    }

    // Bulk edit button
    const bulkEditBtn = this.container.querySelector('#bulk-edit-btn');
    if (bulkEditBtn) {
      bulkEditBtn.addEventListener('click', () => this.showBulkEditDialog());
    }

    // Upload media button
    const uploadBtn = this.container.querySelector('#upload-media-btn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', () => this.showUploadMediaDialog());
    }

    // SEO optimize button
    const seoBtn = this.container.querySelector('#seo-optimize-btn');
    if (seoBtn) {
      seoBtn.addEventListener('click', () => this.showSeoOptimizeDialog());
    }

    // Edit buttons
    this.container.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const productId = target.dataset.productId;
        if (productId) {
          this.editProduct(productId);
        }
      });
    });

    // Export CSV
    const exportBtn = this.container.querySelector('#export-csv-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportToCsv());
    }

    // Tabs
    this.container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        this.container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        target.classList.add('active');
      });
    });
  }

  async loadProducts(): Promise<void> {
    this.render();

    try {
      // TODO: Load actual products from stores
      // For now, create mock data
      this.products = [
        {
          marketplace: 'ozon',
          id: '123',
          name: 'Тестовый товар Ozon',
          description: 'Описание товара...',
          images: [],
          hasVideo: false,
          seoScore: 45,
        },
        {
          marketplace: 'wb',
          id: '456',
          name: 'Тестовый товар WB',
          description: 'Описание товара WB...',
          images: [],
          hasVideo: true,
          seoScore: 75,
        },
      ];

      toast.success(`Загружено ${this.products.length} товаров`);
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.render();
    }
  }

  private showBulkEditDialog(): void {
    if (this.selectedProducts.size === 0) return;

    const html = `
      <div class="modal-overlay" id="bulk-edit-modal">
        <div class="modal-content">
          <h3>Массовое редактирование (${this.selectedProducts.size} товаров)</h3>
          <form id="bulk-edit-form">
            <label>
              <input type="checkbox" name="edit-description" />
              Обновить описание
            </label>
            <textarea name="description" rows="5" placeholder="Новое описание..."></textarea>

            <label>
              <input type="checkbox" name="add-suffix" />
              Добавить суффикс к названию
            </label>
            <input type="text" name="suffix" placeholder="Суффикс..." />

            <label>
              <input type="checkbox" name="optimize-seo" />
              SEO-оптимизация
            </label>

            <div class="modal-actions">
              <button type="submit" class="btn-primary">Применить</button>
              <button type="button" class="btn-secondary" id="cancel-bulk-edit">Отмена</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const modal = document.createElement('div');
    modal.innerHTML = html;
    document.body.appendChild(modal.firstElementChild!);

    const form = document.getElementById('bulk-edit-form') as HTMLFormElement;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.applyBulkEdit(new FormData(form));
      document.getElementById('bulk-edit-modal')?.remove();
    });

    document.getElementById('cancel-bulk-edit')?.addEventListener('click', () => {
      document.getElementById('bulk-edit-modal')?.remove();
    });
  }

  private async applyBulkEdit(_formData: FormData): Promise<void> {
    try {
      const selectedIds = Array.from(this.selectedProducts);
      toast.info(`Обновление ${selectedIds.length} товаров...`);

      // TODO: Implement actual bulk update logic
      await new Promise(resolve => setTimeout(resolve, 1000));

      toast.success('Товары обновлены');
      this.selectedProducts.clear();
      await this.loadProducts();
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private showUploadMediaDialog(): void {
    const html = `
      <div class="modal-overlay" id="upload-media-modal">
        <div class="modal-content">
          <h3>Загрузить медиафайлы</h3>
          <form id="upload-media-form">
            <label>
              Маркетплейс:
              <select name="marketplace" required>
                <option value="ozon">Ozon</option>
                <option value="wb">Wildberries</option>
              </select>
            </label>

            <label>
              ID товара:
              <input type="text" name="productId" required />
            </label>

            <label>
              Файлы (изображения, видео):
              <input type="file" name="files" multiple accept="image/*,video/*" />
            </label>

            <div class="modal-actions">
              <button type="submit" class="btn-primary">Загрузить</button>
              <button type="button" class="btn-secondary" id="cancel-upload">Отмена</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const modal = document.createElement('div');
    modal.innerHTML = html;
    document.body.appendChild(modal.firstElementChild!);

    const form = document.getElementById('upload-media-form') as HTMLFormElement;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.uploadMedia(new FormData(form));
      document.getElementById('upload-media-modal')?.remove();
    });

    document.getElementById('cancel-upload')?.addEventListener('click', () => {
      document.getElementById('upload-media-modal')?.remove();
    });
  }

  private async uploadMedia(formData: FormData): Promise<void> {
    try {
      const files = formData.getAll('files') as File[];
      const marketplace = formData.get('marketplace') as string;

      if (files.length === 0) {
        toast.warning('Выберите файлы');
        return;
      }

      toast.info(`Загрузка ${files.length} файлов...`);

      if (marketplace === 'wb') {
        const stores = this.getAllStores().wb;
        if (stores.length > 0) {
          for (const file of files) {
            await uploadWbMedia(stores[0].api_key, file);
          }
        }
      }

      toast.success('Файлы загружены');
    } catch (err) {
      toast.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private showSeoOptimizeDialog(): void {
    toast.info('SEO-оптимизация в разработке');
  }

  private editProduct(_productId: string): void {
    toast.info('Редактирование товара в разработке');
  }

  private exportToCsv(): void {
    const csv = [
      ['Маркетплейс', 'ID', 'Название', 'Описание', 'SEO Score'],
      ...this.products.map(p => [
        p.marketplace,
        p.id,
        p.name,
        p.description,
        p.seoScore.toString(),
      ]),
    ].map(row => row.join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `products-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();

    toast.success('CSV экспортирован');
  }

  private getAllStores(): {
    ozon: OzonStore[];
    wb: WbStore[];
    yandex: never[];
  } {
    // TODO: получить из глобального стейта
    return {
      ozon: [],
      wb: [],
      yandex: [],
    };
  }
}
