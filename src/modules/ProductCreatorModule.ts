/**
 * ProductCreatorModule — создание товаров на маркетплейсах.
 * 
 * Функционал:
 * - Создание товара на Ozon
 * - Создание товара на WB
 * - Создание товара на Яндекс Маркет
 * - Автоподбор категории
 * - Загрузка фотографий
 */

import { ozonApi } from '@/services/ozonApi';
import { createWbCard } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { toast } from '@/utils/toast';

type Marketplace = 'ozon' | 'wb' | 'yandex';

export class ProductCreatorModule {
  private root: HTMLElement;
  private selectedMp: Marketplace = 'ozon';
  private categories: any[] = [];

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'product-creator-module';
    container.appendChild(this.root);
  }

  async render(): Promise<void> {
    this.root.innerHTML = `
      <div class="module-header">
        <h2>${I.plus} Создание товара</h2>
      </div>

      <div class="creator-form">
        <div class="form-group">
          <label>Маркетплейс:</label>

          <select id="mp-select">
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="yandex">Яндекс Маркет</option>
          </select>
        </div>

        <div class="form-group">
          <label>Магазин:</label>
          <select id="store-select">
            <option value="">-- Выберите магазин --</option>
          </select>
        </div>

        <div class="form-group">
          <label>Артикул (offer_id / vendorCode):</label>
          <input type="text" id="offer-id" required>
        </div>

        <div class="form-group">
          <label>Название товара:</label>
          <input type="text" id="product-name" required>
        </div>

        <div class="form-group">
          <label>Описание:</label>
          <textarea id="product-description" rows="4"></textarea>
        </div>

        <div class="form-group">
          <label>Категория:</label>
          <div class="category-picker">
            <select id="category-select">
              <option value="">-- Загрузите категории --</option>
            </select>
            <button id="load-categories-btn" class="btn btn-sm">
              ${I.refresh} Загрузить
            </button>
            <button id="auto-category-btn" class="btn btn-sm">
              ${I.magic} Автоподбор
            </button>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Цена (₽):</label>
            <input type="number" id="price" required>
          </div>

          <div class="form-group">
            <label>Старая цена (₽):</label>
            <input type="number" id="old-price">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Ширина (мм):</label>
            <input type="number" id="width" required>
          </div>

          <div class="form-group">
            <label>Высота (мм):</label>
            <input type="number" id="height" required>
          </div>

          <div class="form-group">
            <label>Длина (мм):</label>
            <input type="number" id="depth" required>
          </div>

          <div class="form-group">
            <label>Вес (г):</label>
            <input type="number" id="weight" required>
          </div>
        </div>

        <div class="form-group">
          <label>Ссылки на фото (по одной в строке):</label>
          <textarea id="images" rows="5" placeholder="https://example.com/image1.jpg
https://example.com/image2.jpg"></textarea>
        </div>

        <div class="form-actions">
          <button id="create-btn" class="btn btn-success btn-lg">
            ${I.plus} Создать товар
          </button>
        </div>
      </div>
    `;

    this.attachListeners();
    await this.loadStores();
  }

  private attachListeners(): void {
    const mpSelect = this.root.querySelector('#mp-select') as HTMLSelectElement;
    const loadCategoriesBtn = this.root.querySelector('#load-categories-btn') as HTMLButtonElement;
    const autoCategoryBtn = this.root.querySelector('#auto-category-btn') as HTMLButtonElement;
    const createBtn = this.root.querySelector('#create-btn') as HTMLButtonElement;

    mpSelect.addEventListener('change', () => {
      this.selectedMp = mpSelect.value as Marketplace;
      this.loadStores();
      this.categories = [];
      (this.root.querySelector('#category-select') as HTMLSelectElement).innerHTML = 
        '<option value="">-- Загрузите категории --</option>';
    });

    loadCategoriesBtn.addEventListener('click', () => this.loadCategories());
    autoCategoryBtn.addEventListener('click', () => this.autoSelectCategory());
    createBtn.addEventListener('click', () => this.createProduct());
  }

  private async loadStores(): Promise<void> {
    const storeSelect = this.root.querySelector('#store-select') as HTMLSelectElement;
    storeSelect.innerHTML = '<option value="">-- Выберите магазин --</option>';

    let stores: any[] = [];
    if (this.selectedMp === 'ozon') {
      stores = await ozonDb.getAllStores();
    } else if (this.selectedMp === 'wb') {
      stores = await wbDb.getAllStores();
    } else if (this.selectedMp === 'yandex') {
      stores = await yandexDb.getAllStores();
    }

    stores.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      storeSelect.appendChild(opt);
    });
  }

  private async loadCategories(): Promise<void> {
    const storeId = (this.root.querySelector('#store-select') as HTMLSelectElement).value;
    if (!storeId) {
      toast('Выберите магазин', 'warning');
      return;
    }

    const loadBtn = this.root.querySelector('#load-categories-btn') as HTMLButtonElement;
    loadBtn.disabled = true;
    loadBtn.innerHTML = `${I.spinner} Загрузка...`;

    try {
      if (this.selectedMp === 'ozon') {
        const store = await ozonDb.getStore(storeId);
        if (!store) throw new Error('Магазин не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        this.categories = await ozonApi.getCategoryTree(creds);
      } else if (this.selectedMp === 'yandex') {
        const store = await yandexDb.getStore(storeId);
        if (!store) throw new Error('Магазин не найден');
        this.categories = await yandexApi.getCategoryTree(store.api_key);
      }

      const categorySelect = this.root.querySelector('#category-select') as HTMLSelectElement;
      categorySelect.innerHTML = '<option value="">-- Выберите категорию --</option>';
      this.categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = String(c.category_id || c.id);
        opt.textContent = c.title || c.name;
        categorySelect.appendChild(opt);
      });

      toast(`Загружено ${this.categories.length} категорий`, 'success');
    } catch (err: any) {
      toast(`Ошибка: ${err.message}`, 'error');
    } finally {
      loadBtn.disabled = false;
      loadBtn.innerHTML = `${I.refresh} Загрузить`;
    }
  }

  private async autoSelectCategory(): Promise<void> {
    const productName = (this.root.querySelector('#product-name') as HTMLInputElement).value.trim();
    if (!productName) {
      toast('Введите название товара', 'warning');
      return;
    }

    const storeId = (this.root.querySelector('#store-select') as HTMLSelectElement).value;
    if (!storeId) {
      toast('Выберите магазин', 'warning');
      return;
    }

    if (this.selectedMp !== 'yandex') {
      toast('Автоподбор доступен только для Яндекс Маркета', 'info');
      return;
    }

    const autoBtn = this.root.querySelector('#auto-category-btn') as HTMLButtonElement;
    autoBtn.disabled = true;
    autoBtn.innerHTML = `${I.spinner} Подбор...`;

    try {
      const store = await yandexDb.getStore(storeId);
      if (!store) throw new Error('Магазин не найден');
      if (!store.business_id) throw new Error('business_id не указан');

      const categoryId = await yandexApi.suggestCategory(store.api_key, store.business_id, productName);
      if (categoryId) {
        (this.root.querySelector('#category-select') as HTMLSelectElement).value = String(categoryId);
        toast(`Категория подобрана автоматически`, 'success');
      } else {
        toast('Не удалось подобрать категорию', 'warning');
      }
    } catch (err: any) {
      toast(`Ошибка: ${err.message}`, 'error');
    } finally {
      autoBtn.disabled = false;
      autoBtn.innerHTML = `${I.magic} Автоподбор`;
    }
  }

  private async createProduct(): Promise<void> {
    const offerId = (this.root.querySelector('#offer-id') as HTMLInputElement).value.trim();
    const name = (this.root.querySelector('#product-name') as HTMLInputElement).value.trim();
    const description = (this.root.querySelector('#product-description') as HTMLTextAreaElement).value.trim();
    const categoryId = parseInt((this.root.querySelector('#category-select') as HTMLSelectElement).value);
    const price = parseFloat((this.root.querySelector('#price') as HTMLInputElement).value);
    const oldPrice = parseFloat((this.root.querySelector('#old-price') as HTMLInputElement).value) || 0;
    const width = parseInt((this.root.querySelector('#width') as HTMLInputElement).value);
    const height = parseInt((this.root.querySelector('#height') as HTMLInputElement).value);
    const depth = parseInt((this.root.querySelector('#depth') as HTMLInputElement).value);
    const weight = parseInt((this.root.querySelector('#weight') as HTMLInputElement).value);
    const imagesText = (this.root.querySelector('#images') as HTMLTextAreaElement).value.trim();
    const images = imagesText.split('\n').filter(l => l.trim()).map(l => l.trim());

    if (!offerId || !name || !categoryId || !price || !width || !height || !depth || !weight) {
      toast('Заполните все обязательные поля', 'warning');
      return;
    }

    const storeId = (this.root.querySelector('#store-select') as HTMLSelectElement).value;
    if (!storeId) {
      toast('Выберите магазин', 'warning');
      return;
    }

    const createBtn = this.root.querySelector('#create-btn') as HTMLButtonElement;
    createBtn.disabled = true;
    createBtn.innerHTML = `${I.spinner} Создание...`;

    try {
      if (this.selectedMp === 'ozon') {
        const store = await ozonDb.getStore(storeId);
        if (!store) throw new Error('Магазин не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };

        const result = await ozonApi.createProducts(creds, [{
          offer_id: offerId,
          name,
          description,
          category_id: categoryId,
          price: String(price),
          old_price: oldPrice > 0 ? String(oldPrice) : undefined,
          vat: '0',
          height, width, depth,
          dimension_unit: 'mm',
          weight,
          weight_unit: 'g',
          images,
        }]);

        toast(`✓ Товар создан! Task ID: ${result.task_id}`, 'success');
      } else if (this.selectedMp === 'wb') {
        toast('Создание товаров WB через API требует характеристик категории', 'info');
      } else if (this.selectedMp === 'yandex') {
        const store = await yandexDb.getStore(storeId);
        if (!store) throw new Error('Магазин не найден');
        if (!store.business_id) throw new Error('business_id не указан');

        await yandexApi.createOffers(store.api_key, store.business_id, [{
          offerId,
          name,
          categoryId,
          pictures: images,
          description,
          weightDimensions: { length: depth, width, height, weight: weight / 1000 },
        }]);

        toast(`✓ Товар создан на Яндекс Маркете`, 'success');
      }

    } catch (err: any) {
      toast(`Ошибка создания: ${err.message}`, 'error');
    } finally {
      createBtn.disabled = false;
      createBtn.innerHTML = `${I.plus} Создать товар`;
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
