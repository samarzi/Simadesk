# Техническая спецификация: "Мой сайт" — Генератор сайтов для клиентов

## 1. Обзор фичи

### 1.1 Цель
Создать модуль в SimaDesk, который позволяет пользователям (компаниям/продавцам) генерировать персонализированные каталог-сайты для своих клиентов. Сайты автоматически загружают товары с маркетплейсов (Ozon, WB, Yandex Market) через API, предоставляют редактирование контента и работают на индивидуальных поддоменах.

### 1.2 Ключевые возможности
- Автоматическая загрузка товаров с маркетплейсов через API
- Редактор шаблона сайта (баннеры, товары, статьи, контакты)
- Индивидуальный поддомен: `ivan.simadesk.ru`
- Кастомный домен клиента: `ivan.ru` → CNAME → `simadesk.ru`
- Публикация/обновление сайта одной кнопкой
- Адаптивный дизайн (мобайл + десктоп)

---

## 2. Архитектура

### 2.1 Общая схема

```
┌─────────────────────────────────────────────────────────────────┐
│                          VPS Server                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │   Nginx      │    │  SimaDesk    │    │  Parser Server   │   │
│  │   (443/80)   │───▶│  (port 3000) │    │  (port 5001)     │   │
│  │              │    │              │    │  Python + Flask   │   │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘   │
│         │                   │                      │             │
│         │   ┌───────────────┴──────────────┐       │             │
│         │   │                              │       │             │
│         ▼   ▼                              ▼       ▼             │
│  ┌──────────────┐                  ┌──────────────────────┐     │
│  │  Supabase    │                  │  Playwright Parsers   │     │
│  │  (PostgreSQL)│                  │  ozon.py, wb.py,      │     │
│  └──────────────┘                  │  yandex_market.py     │     │
│                                    └──────────────────────┘     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  /var/www/sites/{subdomain}/                              │   │
│  │  Статические файлы сгенерированных сайтов клиентов        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Поток данных

```
1. Пользователь в SimaDesk создаёт "Мой сайт"
2. Заполняет настройки: поддомен, логотип, баннеры, контакты
3. Выбирает товары из SimaDesk или импортирует через API
4. Нажимает "Опубликовать"
5. Система:
   a. Загружает данные из Supabase
   b. Генерирует HTML/JS/CSS файлы
   c. Копирует в /var/www/sites/{subdomain}/
   d. Nginx раздаёт статику по поддомену
6. Клиент открывает ivan.simadesk.ru → видит каталог
```

---

## 3. База данных (Supabase)

### 3.1 Новые таблицы

```sql
-- =====================================================
-- ТАБЛИЦА: user_sites — Сайты пользователей
-- =====================================================
CREATE TABLE user_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id UUID, -- ссылка на компанию в SimaDesk
  
  -- Домен
  subdomain TEXT UNIQUE NOT NULL, -- "ivan" (уникальный)
  custom_domain TEXT, -- "ivan.ru" (опционально)
  
  -- Шаблон
  template_id TEXT DEFAULT 'default', -- ID шаблона
  theme TEXT DEFAULT 'light', -- 'light' | 'dark' | 'auto'
  
  -- Настройки отображения
  settings JSONB DEFAULT '{
    "site_name": "",
    "logo_url": "",
    "favicon_url": "",
    "primary_color": "#3B82F6",
    "secondary_color": "#10B981",
    "phone": "",
    "email": "",
    "whatsapp": "",
    "telegram": "",
    "address": "",
    "working_hours": "",
    "about_text": "",
    "footer_text": "",
    "show_prices": true,
    "show_marketplace_links": true,
    "enable_search": true,
    "enable_filters": true
  }'::jsonb,
  
  -- SEO
  seo_title TEXT,
  seo_description TEXT,
  seo_keywords TEXT,
  
  -- Статус
  published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  last_build_at TIMESTAMPTZ,
  
  -- Мета
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Ограничения
  CONSTRAINT subdomain_format CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);

-- =====================================================
-- ТАБЛИЦА: site_products — Товары на сайте
-- =====================================================
CREATE TABLE site_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  
  -- Ссылка на товар в SimaDesk (опционально)
  product_id UUID, -- может быть null если товар добавлен вручную
  
  -- Данные товара
  title TEXT NOT NULL,
  description TEXT,
  short_description TEXT,
  
  -- Цена
  price DECIMAL(12,2),
  old_price DECIMAL(12,2),
  currency TEXT DEFAULT 'RUB',
  
  -- Изображения
  images TEXT[] DEFAULT '{}', -- массив URL картинок
  main_image_url TEXT,
  
  -- Ссылки на маркетплейсы
  marketplace_urls JSONB DEFAULT '{
    "ozon": "",
    "wb": "",
    "yandex": "",
    "custom": ""
  }'::jsonb,
  
  -- Дополнительные ссылки
  external_links JSONB DEFAULT '[]'::jsonb, -- [{name: "Наш сайт", url: "..."}]
  
  -- Категоризация
  category TEXT,
  tags TEXT[] DEFAULT '{}',
  
  -- Характеристики
  specifications JSONB DEFAULT '{}'::jsonb,
  
  -- Позиция и видимость
  sort_order INT DEFAULT 0,
  visible BOOLEAN DEFAULT true,
  is_featured BOOLEAN DEFAULT false,
  
  -- Мета
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- ТАБЛИЦА: site_banners — Баннеры
-- =====================================================
CREATE TABLE site_banners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  
  title TEXT,
  subtitle TEXT,
  image_url TEXT NOT NULL,
  link_url TEXT, -- куда ведёт клик
  
  -- Позиция и видимость
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  
  -- Период показа
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  
  -- Мета
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- ТАБЛИЦА: site_pages — Страницы/Статьи
-- =====================================================
CREATE TABLE site_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  
  slug TEXT NOT NULL, -- "about", "delivery", "contacts"
  title TEXT NOT NULL,
  content TEXT, -- HTML контент
  
  -- SEO
  seo_title TEXT,
  seo_description TEXT,
  
  -- Позиция в навигации
  sort_order INT DEFAULT 0,
  visible BOOLEAN DEFAULT true,
  show_in_menu BOOLEAN DEFAULT true,
  
  -- Мета
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(site_id, slug)
);

-- =====================================================
-- ТАБЛИЦА: site_categories — Категории товаров
-- =====================================================
CREATE TABLE site_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  
  sort_order INT DEFAULT 0,
  visible BOOLEAN DEFAULT true,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(site_id, slug)
);

-- =====================================================
-- ТАБЛИЦА: site_builds — История сборок
-- =====================================================
CREATE TABLE site_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  
  status TEXT NOT NULL DEFAULT 'pending', -- pending | building | success | error
  error_message TEXT,
  
  files_count INT,
  build_size_kb INT,
  build_duration_ms INT,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- ИНДЕКСЫ
-- =====================================================
CREATE INDEX idx_user_sites_user_id ON user_sites(user_id);
CREATE INDEX idx_user_sites_subdomain ON user_sites(subdomain);
CREATE INDEX idx_user_sites_custom_domain ON user_sites(custom_domain);
CREATE INDEX idx_site_products_site_id ON site_products(site_id);
CREATE INDEX idx_site_products_category ON site_products(site_id, category);
CREATE INDEX idx_site_banners_site_id ON site_banners(site_id);
CREATE INDEX idx_site_pages_site_id ON site_pages(site_id);

-- =====================================================
-- RLS ПОЛИТИКИ
-- =====================================================
ALTER TABLE user_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_builds ENABLE ROW LEVEL SECURITY;

-- Пользователи видят только свои сайты
CREATE POLICY "Users can view own sites" ON user_sites
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sites" ON user_sites
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own sites" ON user_sites
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own sites" ON user_sites
  FOR DELETE USING (auth.uid() = user_id);

-- Аналитики видят все (для парсинга по поддомену)
CREATE POLICY "Service role full access" ON user_sites
  FOR ALL USING (auth.role() = 'service_role');

-- Аналогичные политики для остальных таблиц
CREATE POLICY "Users can manage own site products" ON site_products
  FOR ALL USING (
    site_id IN (SELECT id FROM user_sites WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can manage own site banners" ON site_banners
  FOR ALL USING (
    site_id IN (SELECT id FROM user_sites WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can manage own site pages" ON site_pages
  FOR ALL USING (
    site_id IN (SELECT id FROM user_sites WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can manage own site categories" ON site_categories
  FOR ALL USING (
    site_id IN (SELECT id FROM user_sites WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can manage own site builds" ON site_builds
  FOR ALL USING (
    site_id IN (SELECT id FROM user_sites WHERE user_id = auth.uid())
  );

-- Публичный доступ для чтения опубликованных сайтов
CREATE POLICY "Public can read published sites" ON user_sites
  FOR SELECT USING (published = true);

CREATE POLICY "Public can read visible products" ON site_products
  FOR SELECT USING (
    visible = true AND
    site_id IN (SELECT id FROM user_sites WHERE published = true)
  );

CREATE POLICY "Public can read active banners" ON site_banners
  FOR SELECT USING (
    is_active = true AND
    site_id IN (SELECT id FROM user_sites WHERE published = true)
  );

CREATE POLICY "Public can read visible pages" ON site_pages
  FOR SELECT USING (
    visible = true AND
    site_id IN (SELECT id FROM user_sites WHERE published = true)
  );
```

---

## 4. Структура модуля в SimaDesk

### 4.1 Новые файлы

```
src/
├── modules/
│   └── SiteBuilderModule.ts          # Основной модуль (UI + логика)
│
├── services/
│   ├── siteBuilderDb.ts              # CRUD операции с Supabase
│   ├── siteBuilderApi.ts             # API для парсинга маркетплейсов
│   ├── siteBuilderDeploy.ts          # Деплой сайтов на VPS
│   └── siteBuilderTemplates.ts       # Шаблоны сайтов
│
└── types/
    └── siteBuilder.ts                # Типы для модуля
```

### 4.2 Структура модуля SiteBuilderModule.ts

```typescript
// src/modules/SiteBuilderModule.ts

import { SiteBuilderDb } from '../services/siteBuilderDb';
import { SiteBuilderApi } from '../services/siteBuilderApi';
import { SiteBuilderDeploy } from '../services/siteBuilderDeploy';

interface SiteBuilderState {
  currentSite: UserSite | null;
  sites: UserSite[];
  products: SiteProduct[];
  banners: SiteBanner[];
  pages: SitePage[];
  categories: SiteCategory[];
  isLoading: boolean;
  activeTab: 'sites' | 'products' | 'banners' | 'pages' | 'settings' | 'deploy';
}

export class SiteBuilderModule {
  private container: HTMLElement;
  private state: SiteBuilderState;
  private db: SiteBuilderDb;
  private api: SiteBuilderApi;
  private deploy: SiteBuilderDeploy;

  constructor(container: HTMLElement) {
    this.container = container;
    this.db = new SiteBuilderDb();
    this.api = new SiteBuilderApi();
    this.deploy = new SiteBuilderDeploy();
    this.state = this.getInitialState();
    this.init();
  }

  private getInitialState(): SiteBuilderState {
    return {
      currentSite: null,
      sites: [],
      products: [],
      banners: [],
      pages: [],
      categories: [],
      isLoading: false,
      activeTab: 'sites'
    };
  }

  private async init() {
    await this.loadSites();
    this.render();
  }

  // =====================
  // ЗАГРУЗКА ДАННЫХ
  // =====================

  private async loadSites() {
    this.state.isLoading = true;
    try {
      this.state.sites = await this.db.getSites();
      if (this.state.sites.length > 0 && !this.state.currentSite) {
        await this.selectSite(this.state.sites[0].id);
      }
    } catch (error) {
      console.error('Failed to load sites:', error);
      this.showError('Ошибка загрузки сайтов');
    } finally {
      this.state.isLoading = false;
      this.render();
    }
  }

  private async selectSite(siteId: string) {
    this.state.isLoading = true;
    try {
      this.state.currentSite = await this.db.getSite(siteId);
      await this.loadSiteData(siteId);
    } catch (error) {
      console.error('Failed to load site:', error);
    } finally {
      this.state.isLoading = false;
      this.render();
    }
  }

  private async loadSiteData(siteId: string) {
    const [products, banners, pages, categories] = await Promise.all([
      this.db.getProducts(siteId),
      this.db.getBanners(siteId),
      this.db.getPages(siteId),
      this.db.getCategories(siteId)
    ]);
    
    this.state.products = products;
    this.state.banners = banners;
    this.state.pages = pages;
    this.state.categories = categories;
  }

  // =====================
  // СОЗДАНИЕ САЙТА
  // =====================

  private async createSite(subdomain: string) {
    if (!this.validateSubdomain(subdomain)) {
      this.showError('Некорректный поддомен. Только латинские буквы, цифры и дефис.');
      return;
    }

    try {
      const site = await this.db.createSite({
        subdomain,
        settings: this.getDefaultSettings()
      });
      
      this.state.sites.push(site);
      await this.selectSite(site.id);
      this.showSuccess('Сайт создан!');
    } catch (error: any) {
      if (error.code === '23505') {
        this.showError('Этот поддомен уже занят');
      } else {
        this.showError('Ошибка создания сайта');
      }
    }
  }

  // =====================
  // ИМПОРТ ТОВАРОВ
  // =====================

  private async importProductFromUrl(url: string) {
    this.state.isLoading = true;
    this.showLoading('Парсим товар с маркетплейса...');
    
    try {
      const productData = await this.api.parseProduct(url);
      
      // Добавляем товар на сайт
      const product = await this.db.addProduct(this.state.currentSite!.id, {
        title: productData.title,
        description: productData.description,
        price: productData.price,
        old_price: productData.old_price,
        images: productData.images,
        marketplace_urls: { 
          ozon: url.includes('ozon') ? url : '',
          wb: url.includes('wildberries') ? url : '',
          yandex: url.includes('market.yandex') ? url : '',
          custom: ''
        },
        specifications: productData.specifications
      });
      
      this.state.products.push(product);
      this.showSuccess('Товар добавлен!');
    } catch (error) {
      this.showError('Ошибка парсинга товара');
    } finally {
      this.state.isLoading = false;
      this.render();
    }
  }

  private async importFromMarketplace(marketplace: 'ozon' | 'wb' | 'yandex', query: string) {
    this.state.isLoading = true;
    this.showLoading(`Поиск товаров на ${marketplace}...`);
    
    try {
      const products = await this.api.searchProducts(marketplace, query);
      
      // Показываем результаты для выбора
      this.showProductSelectionModal(products);
    } catch (error) {
      this.showError('Ошибка поиска товаров');
    } finally {
      this.state.isLoading = false;
    }
  }

  private async importSelectedProducts(selectedProducts: any[]) {
    for (const productData of selectedProducts) {
      await this.db.addProduct(this.state.currentSite!.id, {
        title: productData.title,
        description: productData.description,
        price: productData.price,
        images: productData.images,
        marketplace_urls: productData.urls
      });
    }
    
    await this.loadSiteData(this.state.currentSite!.id);
    this.showSuccess(`Импортировано ${selectedProducts.length} товаров`);
  }

  // =====================
  // РЕДАКТИРОВАНИЕ
  // =====================

  private async updateSiteSettings(settings: Partial<SiteSettings>) {
    await this.db.updateSite(this.state.currentSite!.id, { settings });
    this.state.currentSite!.settings = { ...this.state.currentSite!.settings, ...settings };
    this.render();
  }

  private async updateProduct(productId: string, updates: Partial<SiteProduct>) {
    await this.db.updateProduct(productId, updates);
    const index = this.state.products.findIndex(p => p.id === productId);
    if (index !== -1) {
      this.state.products[index] = { ...this.state.products[index], ...updates };
    }
    this.render();
  }

  private async deleteProduct(productId: string) {
    await this.db.deleteProduct(productId);
    this.state.products = this.state.products.filter(p => p.id !== productId);
    this.render();
  }

  private async reorderProducts(productIds: string[]) {
    await this.db.reorderProducts(this.state.currentSite!.id, productIds);
    // Обновляем порядок в state
    this.state.products = productIds.map(id => 
      this.state.products.find(p => p.id === id)!
    ).filter(Boolean);
    this.render();
  }

  // =====================
  // ДЕПЛОЙ
  // =====================

  private async publishSite() {
    if (!this.state.currentSite) return;
    
    this.state.isLoading = true;
    this.showLoading('Сборка сайта...');
    
    try {
      // 1. Получаем все данные
      const siteData = await this.db.getFullSiteData(this.state.currentSite.id);
      
      // 2. Генерируем файлы
      const files = await this.deploy.generateSite(siteData);
      
      // 3. Деплоим на VPS
      await this.deploy.deployToVps(this.state.currentSite.subdomain, files);
      
      // 4. Обновляем статус
      await this.db.updateSite(this.state.currentSite.id, {
        published: true,
        published_at: new Date().toISOString(),
        last_build_at: new Date().toISOString()
      });
      
      this.state.currentSite.published = true;
      this.showSuccess('Сайт опубликован!');
    } catch (error) {
      this.showError('Ошибка публикации');
    } finally {
      this.state.isLoading = false;
      this.render();
    }
  }

  private async unpublishSite() {
    await this.db.updateSite(this.state.currentSite!.id, {
      published: false
    });
    this.state.currentSite!.published = false;
    this.render();
    this.showSuccess('Сайт снят с публикации');
  }

  // =====================
  // UI РЕНДЕРИНГ
  // =====================

  private render() {
    this.container.innerHTML = `
      <div class="site-builder">
        ${this.renderHeader()}
        ${this.state.isLoading ? this.renderLoading() : ''}
        <div class="site-builder__content">
          ${this.renderSidebar()}
          <div class="site-builder__main">
            ${this.renderTabContent()}
          </div>
        </div>
      </div>
    `;
    
    this.attachEventListeners();
  }

  private renderHeader(): string {
    return `
      <div class="site-builder__header">
        <h2>Мой сайт</h2>
        <div class="site-builder__actions">
          <button class="btn btn--secondary" data-action="preview">
            Предпросмотр
          </button>
          <button class="btn btn--primary" data-action="publish">
            ${this.state.currentSite?.published ? 'Обновить' : 'Опубликовать'}
          </button>
        </div>
      </div>
    `;
  }

  private renderSidebar(): string {
    const tabs = [
      { id: 'sites', label: 'Мои сайты', icon: '🌐' },
      { id: 'products', label: 'Товары', icon: '📦' },
      { id: 'banners', label: 'Баннеры', icon: '🖼️' },
      { id: 'pages', label: 'Страницы', icon: '📄' },
      { id: 'settings', label: 'Настройки', icon: '⚙️' },
      { id: 'deploy', label: 'Публикация', icon: '🚀' }
    ];

    return `
      <div class="site-builder__sidebar">
        ${tabs.map(tab => `
          <button 
            class="site-builder__tab ${this.state.activeTab === tab.id ? 'active' : ''}"
            data-tab="${tab.id}"
          >
            <span class="site-builder__tab-icon">${tab.icon}</span>
            <span class="site-builder__tab-label">${tab.label}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  private renderTabContent(): string {
    switch (this.state.activeTab) {
      case 'sites':
        return this.renderSitesTab();
      case 'products':
        return this.renderProductsTab();
      case 'banners':
        return this.renderBannersTab();
      case 'pages':
        return this.renderPagesTab();
      case 'settings':
        return this.renderSettingsTab();
      case 'deploy':
        return this.renderDeployTab();
      default:
        return '';
    }
  }

  private renderSitesTab(): string {
    return `
      <div class="sites-tab">
        <div class="sites-tab__header">
          <h3>Мои сайты</h3>
          <button class="btn btn--primary" data-action="create-site">
            + Создать сайт
          </button>
        </div>
        
        <div class="sites-list">
          ${this.state.sites.map(site => `
            <div class="site-card ${this.state.currentSite?.id === site.id ? 'active' : ''}"
                 data-site-id="${site.id}">
              <div class="site-card__preview">
                <div class="site-card__domain">${site.subdomain}.simadesk.ru</div>
                <div class="site-card__status ${site.published ? 'published' : 'draft'}">
                  ${site.published ? 'Опубликован' : 'Черновик'}
                </div>
              </div>
              <div class="site-card__actions">
                <button class="btn btn--icon" data-action="edit-site" data-site-id="${site.id}">
                  ✏️
                </button>
                <button class="btn btn--icon btn--danger" data-action="delete-site" data-site-id="${site.id}">
                  🗑️
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  private renderProductsTab(): string {
    return `
      <div class="products-tab">
        <div class="products-tab__header">
          <h3>Товары на сайте</h3>
          <div class="products-tab__actions">
            <button class="btn btn--secondary" data-action="import-url">
              Импорт по URL
            </button>
            <button class="btn btn--secondary" data-action="import-search">
              Поиск на маркетплейсе
            </button>
            <button class="btn btn--primary" data-action="add-product">
              + Добавить вручную
            </button>
          </div>
        </div>

        <div class="products-import-bar">
          <input type="text" 
                 class="input" 
                 placeholder="Вставьте URL товара с Ozon, WB или Yandex Market..."
                 id="import-url-input">
          <button class="btn btn--primary" data-action="parse-url">
            Парсить
          </button>
        </div>

        <div class="products-list">
          ${this.state.products.map(product => `
            <div class="product-item" data-product-id="${product.id}">
              <div class="product-item__image">
                <img src="${product.main_image_url || product.images[0] || ''}" 
                     alt="${product.title}"
                     onerror="this.src='/placeholder.png'">
              </div>
              <div class="product-item__info">
                <div class="product-item__title">${product.title}</div>
                <div class="product-item__price">
                  ${product.price ? product.price + ' ₽' : 'Цена не указана'}
                  ${product.old_price ? `<span class="old-price">${product.old_price} ₽</span>` : ''}
                </div>
                <div class="product-item__marketplaces">
                  ${this.renderMarketplaceLinks(product.marketplace_urls)}
                </div>
              </div>
              <div class="product-item__actions">
                <button class="btn btn--icon" data-action="edit-product" data-product-id="${product.id}">
                  ✏️
                </button>
                <button class="btn btn--icon" data-action="toggle-visible" data-product-id="${product.id}">
                  ${product.visible ? '👁️' : '👁️‍🗨️'}
                </button>
                <button class="btn btn--icon btn--danger" data-action="delete-product" data-product-id="${product.id}">
                  🗑️
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  private renderMarketplaceLinks(urls: MarketplaceUrls): string {
    const links = [];
    if (urls.ozon) links.push(`<a href="${urls.ozon}" target="_blank" class="mp-link mp-link--ozon">Ozon</a>`);
    if (urls.wb) links.push(`<a href="${urls.wb}" target="_blank" class="mp-link mp-link--wb">WB</a>`);
    if (urls.yandex) links.push(`<a href="${urls.yandex}" target="_blank" class="mp-link mp-link--yandex">Яндекс</a>`);
    return links.join('');
  }

  private renderBannersTab(): string {
    return `
      <div class="banners-tab">
        <div class="banners-tab__header">
          <h3>Баннеры</h3>
          <button class="btn btn--primary" data-action="add-banner">
            + Добавить баннер
          </button>
        </div>

        <div class="banners-list">
          ${this.state.banners.map(banner => `
            <div class="banner-item" data-banner-id="${banner.id}">
              <div class="banner-item__preview">
                <img src="${banner.image_url}" alt="${banner.title || ''}">
              </div>
              <div class="banner-item__info">
                <div class="banner-item__title">${banner.title || 'Без названия'}</div>
                <div class="banner-item__link">${banner.link_url || 'Без ссылки'}</div>
              </div>
              <div class="banner-item__actions">
                <button class="btn btn--icon" data-action="edit-banner" data-banner-id="${banner.id}">
                  ✏️
                </button>
                <button class="btn btn--icon" data-action="toggle-banner" data-banner-id="${banner.id}">
                  ${banner.is_active ? '✅' : '❌'}
                </button>
                <button class="btn btn--icon btn--danger" data-action="delete-banner" data-banner-id="${banner.id}">
                  🗑️
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  private renderSettingsTab(): string {
    if (!this.state.currentSite) return '';
    
    const settings = this.state.currentSite.settings;
    
    return `
      <div class="settings-tab">
        <h3>Настройки сайта</h3>
        
        <form class="settings-form" id="settings-form">
          <div class="form-group">
            <label>Название сайта</label>
            <input type="text" 
                   class="input" 
                   name="site_name" 
                   value="${settings.site_name || ''}"
                   placeholder="Мой магазин">
          </div>
          
          <div class="form-group">
            <label>Поддомен</label>
            <div class="input-group">
              <input type="text" 
                     class="input" 
                     name="subdomain" 
                     value="${this.state.currentSite.subdomain}"
                     disabled>
              <span class="input-suffix">.simadesk.ru</span>
            </div>
          </div>
          
          <div class="form-group">
            <label>Кастомный домен (опционально)</label>
            <input type="text" 
                   class="input" 
                   name="custom_domain" 
                   value="${this.state.currentSite.custom_domain || ''}"
                   placeholder="ivan.ru">
            <small>Настройте CNAME в DNS вашего домена → simadesk.ru</small>
          </div>
          
          <div class="form-group">
            <label>Логотип (URL)</label>
            <input type="url" 
                   class="input" 
                   name="logo_url" 
                   value="${settings.logo_url || ''}"
                   placeholder="https://example.com/logo.png">
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label>Основной цвет</label>
              <input type="color" 
                     class="input input--color" 
                     name="primary_color" 
                     value="${settings.primary_color || '#3B82F6'}">
            </div>
            <div class="form-group">
              <label>Дополнительный цвет</label>
              <input type="color" 
                     class="input input--color" 
                     name="secondary_color" 
                     value="${settings.secondary_color || '#10B981'}">
            </div>
          </div>
          
          <div class="form-group">
            <label>Телефон</label>
            <input type="tel" 
                   class="input" 
                   name="phone" 
                   value="${settings.phone || ''}"
                   placeholder="+7 (999) 123-45-67">
          </div>
          
          <div class="form-group">
            <label>Email</label>
            <input type="email" 
                   class="input" 
                   name="email" 
                   value="${settings.email || ''}"
                   placeholder="info@example.com">
          </div>
          
          <div class="form-group">
            <label>WhatsApp</label>
            <input type="text" 
                   class="input" 
                   name="whatsapp" 
                   value="${settings.whatsapp || ''}"
                   placeholder="+79991234567">
          </div>
          
          <div class="form-group">
            <label>Telegram</label>
            <input type="text" 
                   class="input" 
                   name="telegram" 
                   value="${settings.telegram || ''}"
                   placeholder="@username">
          </div>
          
          <div class="form-group">
            <label>Адрес</label>
            <textarea class="input textarea" 
                      name="address">${settings.address || ''}</textarea>
          </div>
          
          <div class="form-group">
            <label>О нас</label>
            <textarea class="input textarea" 
                      name="about_text" 
                      rows="4">${settings.about_text || ''}</textarea>
          </div>
          
          <div class="form-group">
            <label>Текст в футере</label>
            <textarea class="input textarea" 
                      name="footer_text">${settings.footer_text || ''}</textarea>
          </div>
          
          <div class="form-group">
            <label>SEO Title</label>
            <input type="text" 
                   class="input" 
                   name="seo_title" 
                   value="${this.state.currentSite.seo_title || ''}"
                   placeholder="Мой магазин - купить товары онлайн">
          </div>
          
          <div class="form-group">
            <label>SEO Description</label>
            <textarea class="input textarea" 
                      name="seo_description">${this.state.currentSite.seo_description || ''}</textarea>
          </div>
          
          <div class="form-checkboxes">
            <label class="checkbox">
              <input type="checkbox" 
                     name="show_prices" 
                     ${settings.show_prices ? 'checked' : ''}>
              <span>Показывать цены</span>
            </label>
            
            <label class="checkbox">
              <input type="checkbox" 
                     name="show_marketplace_links" 
                     ${settings.show_marketplace_links ? 'checked' : ''}>
              <span>Показывать ссылки на маркетплейсы</span>
            </label>
            
            <label class="checkbox">
              <input type="checkbox" 
                     name="enable_search" 
                     ${settings.enable_search ? 'checked' : ''}>
              <span>Включить поиск</span>
            </label>
            
            <label class="checkbox">
              <input type="checkbox" 
                     name="enable_filters" 
                     ${settings.enable_filters ? 'checked' : ''}>
              <span>Включить фильтры</span>
            </label>
          </div>
          
          <div class="form-actions">
            <button type="submit" class="btn btn--primary">
              Сохранить настройки
            </button>
          </div>
        </form>
      </div>
    `;
  }

  private renderDeployTab(): string {
    if (!this.state.currentSite) return '';
    
    const site = this.state.currentSite;
    const siteUrl = site.custom_domain || `${site.subdomain}.simadesk.ru`;
    
    return `
      <div class="deploy-tab">
        <h3>Публикация</h3>
        
        <div class="deploy-info">
          <div class="deploy-info__item">
            <span class="label">Статус:</span>
            <span class="value ${site.published ? 'published' : 'draft'}">
              ${site.published ? 'Опубликован' : 'Черновик'}
            </span>
          </div>
          
          ${site.published_at ? `
            <div class="deploy-info__item">
              <span class="label">Опубликован:</span>
              <span class="value">${new Date(site.published_at).toLocaleString('ru-RU')}</span>
            </div>
          ` : ''}
          
          ${site.last_build_at ? `
            <div class="deploy-info__item">
              <span class="label">Последняя сборка:</span>
              <span class="value">${new Date(site.last_build_at).toLocaleString('ru-RU')}</span>
            </div>
          ` : ''}
          
          <div class="deploy-info__item">
            <span class="label">URL сайта:</span>
            <a href="https://${siteUrl}" target="_blank" class="value link">
              https://${siteUrl}
            </a>
          </div>
        </div>
        
        <div class="deploy-actions">
          ${site.published ? `
            <button class="btn btn--primary" data-action="republish">
              🔄 Обновить сайт
            </button>
            <button class="btn btn--danger" data-action="unpublish">
              ⏸️ Снять с публикации
            </button>
          ` : `
            <button class="btn btn--primary btn--lg" data-action="publish">
              🚀 Опубликовать сайт
            </button>
          `}
        </div>
        
        <div class="deploy-instructions">
          <h4>Настройка кастомного домена</h4>
          <ol>
            <li>Добавьте CNAME-запись в DNS вашего домена:</li>
            <code>ivan.ru. CNAME simadesk.ru.</code>
            <li>Подождите распространения DNS (до 24 часов)</li>
            <li>Введите домен в настройках сайта</li>
          </ol>
        </div>
      </div>
    `;
  }

  // =====================
  // EVENT LISTENERS
  // =====================

  private attachEventListeners() {
    // Tab switching
    this.container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.state.activeTab = (e.currentTarget as HTMLElement).dataset.tab as any;
        this.render();
      });
    });

    // Actions
    this.container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = (e.currentTarget as HTMLElement).dataset.action;
        this.handleAction(action!, e.currentTarget as HTMLElement);
      });
    });

    // Settings form
    const form = this.container.querySelector('#settings-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSettingsSubmit(new FormData(form as HTMLFormElement));
      });
    }

    // Import URL input
    const importInput = this.container.querySelector('#import-url-input');
    if (importInput) {
      importInput.addEventListener('keypress', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          this.importProductFromUrl((importInput as HTMLInputElement).value);
        }
      });
    }
  }

  private handleAction(action: string, element: HTMLElement) {
    switch (action) {
      case 'create-site':
        this.showCreateSiteModal();
        break;
      case 'publish':
        this.publishSite();
        break;
      case 'unpublish':
        this.unpublishSite();
        break;
      case 'import-url':
        this.showImportUrlModal();
        break;
      case 'parse-url':
        const url = (this.container.querySelector('#import-url-input') as HTMLInputElement).value;
        this.importProductFromUrl(url);
        break;
      case 'edit-product':
        const productId = element.dataset.productId;
        this.showEditProductModal(productId!);
        break;
      case 'delete-product':
        if (confirm('Удалить товар?')) {
          this.deleteProduct(element.dataset.productId!);
        }
        break;
      // ...其他 actions
    }
  }

  private handleSettingsSubmit(formData: FormData) {
    const settings: any = {};
    formData.forEach((value, key) => {
      settings[key] = value;
    });
    
    // Convert checkboxes
    settings.show_prices = formData.has('show_prices');
    settings.show_marketplace_links = formData.has('show_marketplace_links');
    settings.enable_search = formData.has('enable_search');
    settings.enable_filters = formData.has('enable_filters');
    
    this.updateSiteSettings(settings);
    this.showSuccess('Настройки сохранены');
  }

  // =====================
  // MODALS
  // =====================

  private showCreateSiteModal() {
    // Модальное окно для создания сайта
    // Поле ввода поддомена
    // Валидация
    // Создание
  }

  private showImportUrlModal() {
    // Модальное окно с полем URL
    // Примеры URL
  }

  private showEditProductModal(productId: string) {
    // Модальное окно редактирования товара
    // Все поля: название, описание, цена, изображения, ссылки
  }

  private showProductSelectionModal(products: any[]) {
    // Модальное окно с выбором товаров из поиска
    // Чекбоксы, кнопка "Импортировать выбранные"
  }

  // =====================
  // UTILITIES
  // =====================

  private validateSubdomain(subdomain: string): boolean {
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain);
  }

  private getDefaultSettings(): SiteSettings {
    return {
      site_name: '',
      logo_url: '',
      favicon_url: '',
      primary_color: '#3B82F6',
      secondary_color: '#10B981',
      phone: '',
      email: '',
      whatsapp: '',
      telegram: '',
      address: '',
      working_hours: '',
      about_text: '',
      footer_text: '',
      show_prices: true,
      show_marketplace_links: true,
      enable_search: true,
      enable_filters: true
    };
  }

  private showLoading(message: string) {
    // Показать индикатор загрузки
  }

  private showSuccess(message: string) {
    // Показать toast.success
  }

  private showError(message: string) {
    // Показать toast.error
  }

  private showError(message: string) {
    // Показать toast.error
  }

  destroy() {
    // Cleanup
  }
}
```

---

## 5. Сервисы

### 5.1 siteBuilderDb.ts

```typescript
// src/services/siteBuilderDb.ts

import { supabase } from './supabaseClient';

export class SiteBuilderDb {
  // =====================
  // SITES
  // =====================

  async getSites(): Promise<UserSite[]> {
    const { data, error } = await supabase
      .from('user_sites')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getSite(id: string): Promise<UserSite> {
    const { data, error } = await supabase
      .from('user_sites')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  async getSiteBySubdomain(subdomain: string): Promise<UserSite | null> {
    const { data, error } = await supabase
      .from('user_sites')
      .select('*')
      .eq('subdomain', subdomain)
      .eq('published', true)
      .single();

    if (error) return null;
    return data;
  }

  async createSite(site: {
    subdomain: string;
    settings: SiteSettings;
  }): Promise<UserSite> {
    const { data, error } = await supabase
      .from('user_sites')
      .insert(site)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateSite(id: string, updates: Partial<UserSite>): Promise<UserSite> {
    const { data, error } = await supabase
      .from('user_sites')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async deleteSite(id: string): Promise<void> {
    const { error } = await supabase
      .from('user_sites')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  // =====================
  // PRODUCTS
  // =====================

  async getProducts(siteId: string): Promise<SiteProduct[]> {
    const { data, error } = await supabase
      .from('site_products')
      .select('*')
      .eq('site_id', siteId)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async addProduct(siteId: string, product: Partial<SiteProduct>): Promise<SiteProduct> {
    const { data, error } = await supabase
      .from('site_products')
      .insert({ ...product, site_id: siteId })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateProduct(id: string, updates: Partial<SiteProduct>): Promise<SiteProduct> {
    const { data, error } = await supabase
      .from('site_products')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async deleteProduct(id: string): Promise<void> {
    const { error } = await supabase
      .from('site_products')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  async reorderProducts(siteId: string, productIds: string[]): Promise<void> {
    const updates = productIds.map((id, index) => ({
      id,
      sort_order: index
    }));

    for (const update of updates) {
      await supabase
        .from('site_products')
        .update({ sort_order: update.sort_order })
        .eq('id', update.id);
    }
  }

  // =====================
  // BANNERS
  // =====================

  async getBanners(siteId: string): Promise<SiteBanner[]> {
    const { data, error } = await supabase
      .from('site_banners')
      .select('*')
      .eq('site_id', siteId)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async addBanner(siteId: string, banner: Partial<SiteBanner>): Promise<SiteBanner> {
    const { data, error } = await supabase
      .from('site_banners')
      .insert({ ...banner, site_id: siteId })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateBanner(id: string, updates: Partial<SiteBanner>): Promise<SiteBanner> {
    const { data, error } = await supabase
      .from('site_banners')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async deleteBanner(id: string): Promise<void> {
    const { error } = await supabase
      .from('site_banners')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  // =====================
  // PAGES
  // =====================

  async getPages(siteId: string): Promise<SitePage[]> {
    const { data, error } = await supabase
      .from('site_pages')
      .select('*')
      .eq('site_id', siteId)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async addPage(siteId: string, page: Partial<SitePage>): Promise<SitePage> {
    const { data, error } = await supabase
      .from('site_pages')
      .insert({ ...page, site_id: siteId })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updatePage(id: string, updates: Partial<SitePage>): Promise<SitePage> {
    const { data, error } = await supabase
      .from('site_pages')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async deletePage(id: string): Promise<void> {
    const { error } = await supabase
      .from('site_pages')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  // =====================
  // FULL SITE DATA
  // =====================

  async getFullSiteData(siteId: string) {
    const site = await this.getSite(siteId);
    const [products, banners, pages, categories] = await Promise.all([
      this.getProducts(siteId),
      this.getBanners(siteId),
      this.getPages(siteId),
      this.getCategories(siteId)
    ]);

    return { site, products, banners, pages, categories };
  }

  async getCategories(siteId: string): Promise<SiteCategory[]> {
    const { data, error } = await supabase
      .from('site_categories')
      .select('*')
      .eq('site_id', siteId)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return data || [];
  }
}
```

### 5.2 siteBuilderApi.ts

```typescript
// src/services/siteBuilderApi.ts

export class SiteBuilderApi {
  private parserBaseUrl = 'http://localhost:5001';

  async parseProduct(url: string): Promise<ParsedProduct> {
    const response = await fetch(`${this.parserBaseUrl}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      throw new Error('Failed to parse product');
    }

    return response.json();
  }

  async searchProducts(
    marketplace: 'ozon' | 'wb' | 'yandex',
    query: string
  ): Promise<ParsedProduct[]> {
    const response = await fetch(`${this.parserBaseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace, query })
    });

    if (!response.ok) {
      throw new Error('Failed to search products');
    }

    return response.json();
  }
}

interface ParsedProduct {
  title: string;
  description: string;
  price: number;
  old_price?: number;
  images: string[];
  specifications: Record<string, string>;
  marketplace_url: string;
}
```

### 5.3 siteBuilderDeploy.ts

```typescript
// src/services/siteBuilderDeploy.ts

import * as fs from 'fs/promises';
import * as path from 'path';

export class SiteBuilderDeploy {
  private sitesDir = '/var/www/sites';

  async generateSite(siteData: FullSiteData): Promise<SiteFiles> {
    const { site, products, banners, pages, categories } = siteData;
    
    // Генерируем HTML
    const html = this.generateHtml(site, products, banners, pages);
    
    // Генерируем CSS
    const css = this.generateCss(site.settings);
    
    // Генерируем JS
    const js = this.generateJs(products, site.settings);
    
    return {
      'index.html': html,
      'styles.css': css,
      'app.js': js,
      ...this.generateAssets(banners, products)
    };
  }

  private generateHtml(
    site: UserSite,
    products: SiteProduct[],
    banners: SiteBanner[],
    pages: SitePage[]
  ): string {
    const settings = site.settings;
    
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${site.seo_title || settings.site_name || site.subdomain}</title>
  <meta name="description" content="${site.seo_description || ''}">
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" href="${settings.favicon_url || '/favicon.ico'}">
</head>
<body>
  <header class="header">
    <div class="container">
      <div class="header__logo">
        ${settings.logo_url 
          ? `<img src="${settings.logo_url}" alt="${settings.site_name}">`
          : `<span>${settings.site_name || site.subdomain}</span>`
        }
      </div>
      <nav class="header__nav">
        <a href="/" class="active">Главная</a>
        <a href="/catalog">Каталог</a>
        ${pages.filter(p => p.show_in_menu).map(p => 
          `<a href="/${p.slug}">${p.title}</a>`
        ).join('')}
      </nav>
      ${settings.enable_search ? `
        <div class="header__search">
          <input type="text" placeholder="Поиск..." id="search-input">
        </div>
      ` : ''}
    </div>
  </header>

  <main>
    <!-- Баннеры -->
    <section class="banners">
      <div class="banner-carousel">
        ${banners.map(banner => `
          <div class="banner">
            <img src="${banner.image_url}" alt="${banner.title || ''}">
            ${banner.link_url ? `<a href="${banner.link_url}" class="banner__link"></a>` : ''}
          </div>
        `).join('')}
      </div>
    </section>

    <!-- Товары -->
    <section class="catalog">
      <div class="container">
        <h2>Каталог</h2>
        
        ${settings.enable_filters ? `
          <div class="filters">
            <input type="text" placeholder="Поиск товаров..." id="catalog-search">
            <select id="category-filter">
              <option value="">Все категории</option>
              ${categories.map(cat => 
                `<option value="${cat.slug}">${cat.name}</option>`
              ).join('')}
            </select>
          </div>
        ` : ''}
        
        <div class="products-grid" id="products-grid">
          ${products.filter(p => p.visible).map(product => `
            <div class="product-card" data-category="${product.category || ''}">
              <div class="product-card__image">
                <img src="${product.main_image_url || product.images[0] || '/placeholder.png'}" 
                     alt="${product.title}">
              </div>
              <div class="product-card__info">
                <h3 class="product-card__title">${product.title}</h3>
                ${product.short_description ? `
                  <p class="product-card__description">${product.short_description}</p>
                ` : ''}
                ${settings.show_prices && product.price ? `
                  <div class="product-card__price">
                    <span class="price">${product.price} ₽</span>
                    ${product.old_price ? `
                      <span class="old-price">${product.old_price} ₽</span>
                    ` : ''}
                  </div>
                ` : ''}
                ${settings.show_marketplace_links ? `
                  <div class="product-card__links">
                    ${this.generateMarketplaceLinks(product.marketplace_urls)}
                  </div>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container">
      <div class="footer__content">
        <div class="footer__info">
          <p>${settings.footer_text || `© ${new Date().getFullYear()} ${settings.site_name || site.subdomain}`}</p>
        </div>
        <div class="footer__contacts">
          ${settings.phone ? `<a href="tel:${settings.phone}">${settings.phone}</a>` : ''}
          ${settings.email ? `<a href="mailto:${settings.email}">${settings.email}</a>` : ''}
          ${settings.whatsapp ? `<a href="https://wa.me/${settings.whatsapp}" target="_blank">WhatsApp</a>` : ''}
          ${settings.telegram ? `<a href="https://t.me/${settings.telegram.replace('@', '')}" target="_blank">Telegram</a>` : ''}
        </div>
      </div>
    </div>
  </footer>

  <script src="/app.js"></script>
</body>
</html>`;
  }

  private generateMarketplaceLinks(urls: MarketplaceUrls): string {
    const links = [];
    
    if (urls.ozon) {
      links.push(`
        <a href="${urls.ozon}" target="_blank" class="mp-link mp-link--ozon">
          Купить на Ozon
        </a>
      `);
    }
    
    if (urls.wb) {
      links.push(`
        <a href="${urls.wb}" target="_blank" class="mp-link mp-link--wb">
          Купить на Wildberries
        </a>
      `);
    }
    
    if (urls.yandex) {
      links.push(`
        <a href="${urls.yandex}" target="_blank" class="mp-link mp-link--yandex">
          Купить на Яндекс Маркете
        </a>
      `);
    }
    
    return links.join('');
  }

  private generateCss(settings: SiteSettings): string {
    const primaryColor = settings.primary_color || '#3B82F6';
    const secondaryColor = settings.secondary_color || '#10B981';
    
    return `
:root {
  --primary: ${primaryColor};
  --secondary: ${secondaryColor};
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
  color: #333;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 20px;
}

/* Header */
.header {
  background: white;
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header .container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 20px;
}

.header__logo img {
  height: 40px;
}

.header__nav {
  display: flex;
  gap: 30px;
}

.header__nav a {
  text-decoration: none;
  color: #333;
  font-weight: 500;
}

.header__nav a:hover,
.header__nav a.active {
  color: var(--primary);
}

/* Banners */
.banners {
  margin-bottom: 40px;
}

.banner-carousel {
  display: flex;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  gap: 20px;
  padding: 20px;
}

.banner {
  min-width: 100%;
  scroll-snap-align: start;
  position: relative;
}

.banner img {
  width: 100%;
  height: 300px;
  object-fit: cover;
  border-radius: 12px;
}

.banner__link {
  position: absolute;
  inset: 0;
}

/* Products */
.catalog {
  padding: 40px 0;
}

.catalog h2 {
  font-size: 28px;
  margin-bottom: 30px;
}

.products-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 20px;
}

.product-card {
  background: white;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 10px rgba(0,0,0,0.05);
  transition: transform 0.2s, box-shadow 0.2s;
}

.product-card:hover {
  transform: translateY(-5px);
  box-shadow: 0 10px 30px rgba(0,0,0,0.1);
}

.product-card__image img {
  width: 100%;
  height: 200px;
  object-fit: cover;
}

.product-card__info {
  padding: 15px;
}

.product-card__title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
}

.product-card__price {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 15px;
}

.product-card__price .price {
  font-size: 20px;
  font-weight: 700;
  color: var(--primary);
}

.product-card__price .old-price {
  font-size: 14px;
  color: #999;
  text-decoration: line-through;
}

.product-card__links {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mp-link {
  display: inline-block;
  padding: 8px 16px;
  border-radius: 8px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
}

.mp-link--ozon {
  background: #005bff;
  color: white;
}

.mp-link--wb {
  background: #cb11ab;
  color: white;
}

.mp-link--yandex {
  background: #fc3f1d;
  color: white;
}

/* Footer */
.footer {
  background: #f5f5f5;
  padding: 40px 0;
  margin-top: 60px;
}

.footer__content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.footer__contacts {
  display: flex;
  gap: 20px;
}

.footer__contacts a {
  color: #666;
  text-decoration: none;
}

.footer__contacts a:hover {
  color: var(--primary);
}

/* Responsive */
@media (max-width: 768px) {
  .header .container {
    flex-direction: column;
    gap: 15px;
  }
  
  .header__nav {
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .products-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .footer__content {
    flex-direction: column;
    gap: 20px;
    text-align: center;
  }
  
  .footer__contacts {
    flex-wrap: wrap;
    justify-content: center;
  }
}
    `;
  }

  private generateJs(products: SiteProduct[], settings: SiteSettings): string {
    return `
// Поиск и фильтры
document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('search-input');
  const catalogSearch = document.getElementById('catalog-search');
  const categoryFilter = document.getElementById('category-filter');
  const productsGrid = document.getElementById('products-grid');
  
  const products = ${JSON.stringify(products)};
  
  function filterProducts() {
    const searchQuery = (searchInput?.value || catalogSearch?.value || '').toLowerCase();
    const selectedCategory = categoryFilter?.value || '';
    
    const filtered = products.filter(product => {
      const matchesSearch = !searchQuery || 
        product.title.toLowerCase().includes(searchQuery) ||
        (product.description || '').toLowerCase().includes(searchQuery);
      
      const matchesCategory = !selectedCategory || product.category === selectedCategory;
      
      return matchesSearch && matchesCategory && product.visible;
    });
    
    renderProducts(filtered);
  }
  
  function renderProducts(items) {
    if (!productsGrid) return;
    
    productsGrid.innerHTML = items.map(product => \`
      <div class="product-card" data-category="\${product.category || ''}">
        <div class="product-card__image">
          <img src="\${product.main_image_url || product.images[0] || '/placeholder.png'}" 
               alt="\${product.title}">
        </div>
        <div class="product-card__info">
          <h3 class="product-card__title">\${product.title}</h3>
          \${product.short_description ? \`
            <p class="product-card__description">\${product.short_description}</p>
          \` : ''}
          \${settings.show_prices && product.price ? \`
            <div class="product-card__price">
              <span class="price">\${product.price} ₽</span>
              \${product.old_price ? \`
                <span class="old-price">\${product.old_price} ₽</span>
              \` : ''}
            </div>
          \` : ''}
          \${settings.show_marketplace_links ? \`
            <div class="product-card__links">
              \${generateMarketplaceLinks(product.marketplace_urls)}
            </div>
          \` : ''}
        </div>
      </div>
    \`).join('');
  }
  
  function generateMarketplaceLinks(urls) {
    const links = [];
    if (urls.ozon) links.push(\`<a href="\${urls.ozon}" target="_blank" class="mp-link mp-link--ozon">Купить на Ozon</a>\`);
    if (urls.wb) links.push(\`<a href="\${urls.wb}" target="_blank" class="mp-link mp-link--wb">Купить на Wildberries</a>\`);
    if (urls.yandex) links.push(\`<a href="\${urls.yandex}" target="_blank" class="mp-link mp-link--yandex">Купить на Яндекс Маркете</a>\`);
    return links.join('');
  }
  
  // Event listeners
  searchInput?.addEventListener('input', filterProducts);
  catalogSearch?.addEventListener('input', filterProducts);
  categoryFilter?.addEventListener('change', filterProducts);
  
  // Banner carousel auto-scroll
  const carousel = document.querySelector('.banner-carousel');
  if (carousel && carousel.children.length > 1) {
    let currentSlide = 0;
    setInterval(() => {
      currentSlide = (currentSlide + 1) % carousel.children.length;
      carousel.children[currentSlide].scrollIntoView({ behavior: 'smooth' });
    }, 5000);
  }
});
    `;
  }

  private generateAssets(
    banners: SiteBanner[],
    products: SiteProduct[]
  ): Record<string, string> {
    // Генерация дополнительных файлов (favicon, placeholder и т.д.)
    return {};
  }

  async deployToVps(subdomain: string, files: SiteFiles): Promise<void> {
    const siteDir = path.join(this.sitesDir, subdomain);
    
    // Создаём директорию
    await fs.mkdir(siteDir, { recursive: true });
    
    // Записываем файлы
    for (const [filename, content] of Object.entries(files)) {
      await fs.writeFile(path.join(siteDir, filename), content);
    }
    
    // Создаём/обновляем Nginx конфиг
    await this.updateNginxConfig(subdomain);
  }

  private async updateNginxConfig(subdomain: string): Promise<void> {
    const config = `
server {
    listen 80;
    server_name ${subdomain}.simadesk.ru;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${subdomain}.simadesk.ru;
    
    ssl_certificate /etc/letsencrypt/live/simadesk.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/simadesk.ru/privkey.pem;
    
    root /var/www/sites/${subdomain};
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    location ~* \\.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
    `;
    
    await fs.writeFile(
      path.join('/etc/nginx/sites-available', `${subdomain}.simadesk.ru`),
      config
    );
    
    // Создаём symlink
    await fs.symlink(
      path.join('/etc/nginx/sites-available', `${subdomain}.simadesk.ru`),
      path.join('/etc/nginx/sites-enabled', `${subdomain}.simadesk.ru`)
    ).catch(() => {}); // Игнорируем если уже существует
    
    // Перезагружаем Nginx
    await this.reloadNginx();
  }

  private async reloadNginx(): Promise<void> {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      exec('sudo nginx -t && sudo systemctl reload nginx', (error: any) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

interface SiteFiles {
  [filename: string]: string;
}

interface FullSiteData {
  site: UserSite;
  products: SiteProduct[];
  banners: SiteBanner[];
  pages: SitePage[];
  categories: SiteCategory[];
}
```

---

## 6. Типы (types/siteBuilder.ts)

```typescript
// src/types/siteBuilder.ts

export interface UserSite {
  id: string;
  user_id: string;
  company_id?: string;
  subdomain: string;
  custom_domain?: string;
  template_id: string;
  theme: 'light' | 'dark' | 'auto';
  settings: SiteSettings;
  seo_title?: string;
  seo_description?: string;
  seo_keywords?: string;
  published: boolean;
  published_at?: string;
  last_build_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SiteSettings {
  site_name: string;
  logo_url: string;
  favicon_url: string;
  primary_color: string;
  secondary_color: string;
  phone: string;
  email: string;
  whatsapp: string;
  telegram: string;
  address: string;
  working_hours: string;
  about_text: string;
  footer_text: string;
  show_prices: boolean;
  show_marketplace_links: boolean;
  enable_search: boolean;
  enable_filters: boolean;
}

export interface SiteProduct {
  id: string;
  site_id: string;
  product_id?: string;
  title: string;
  description?: string;
  short_description?: string;
  price?: number;
  old_price?: number;
  currency: string;
  images: string[];
  main_image_url?: string;
  marketplace_urls: MarketplaceUrls;
  external_links: ExternalLink[];
  category?: string;
  tags: string[];
  specifications: Record<string, string>;
  sort_order: number;
  visible: boolean;
  is_featured: boolean;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceUrls {
  ozon: string;
  wb: string;
  yandex: string;
  custom: string;
}

export interface ExternalLink {
  name: string;
  url: string;
}

export interface SiteBanner {
  id: string;
  site_id: string;
  title?: string;
  subtitle?: string;
  image_url: string;
  link_url?: string;
  sort_order: number;
  is_active: boolean;
  starts_at?: string;
  ends_at?: string;
  created_at: string;
}

export interface SitePage {
  id: string;
  site_id: string;
  slug: string;
  title: string;
  content?: string;
  seo_title?: string;
  seo_description?: string;
  sort_order: number;
  visible: boolean;
  show_in_menu: boolean;
  created_at: string;
  updated_at: string;
}

export interface SiteCategory {
  id: string;
  site_id: string;
  name: string;
  slug: string;
  description?: string;
  image_url?: string;
  sort_order: number;
  visible: boolean;
  created_at: string;
}

export interface SiteBuild {
  id: string;
  site_id: string;
  status: 'pending' | 'building' | 'success' | 'error';
  error_message?: string;
  files_count?: number;
  build_size_kb?: number;
  build_duration_ms?: number;
  created_at: string;
}
```

---

## 7. Nginx конфигурация

### 7.1 Wildcard SSL (один сертификат на все поддомены)

```bash
# Установка certbot
sudo apt install certbot python3-certbot-nginx

# Получение wildcard-сертификата (через DNS-челлендж)
sudo certbot certonly --manual --preferred-challenges dns \
  -d "*.simadesk.ru" -d "simadesk.ru" \
  --email admin@simadesk.ru --agree-tos

# Конфиг Nginx (/etc/nginx/sites-available/simadesk-wildcard)
server {
    listen 80;
    server_name *.simadesk.ru simadesk.ru;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name *.simadesk.ru simadesk.ru;
    
    ssl_certificate /etc/letsencrypt/live/simadesk.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/simadesk.ru/privkey.pem;
    
    # Основной сайт (SimaDesk)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Активация
sudo ln -s /etc/nginx/sites-available/simadesk-wildcard /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 7.2 Конфиг для сайтов клиентов

```bash
# Скрипт добавления нового сайта
#!/bin/bash
# /usr/local/bin/add-client-site.sh

SUBDOMAIN=$1
SITES_DIR="/var/www/sites"

# Создаём директорию
mkdir -p "$SITES_DIR/$SUBDOMAIN"

# Генерируем конфиг
cat > "/etc/nginx/sites-available/$SUBDOMAIN.simadesk.ru" << EOF
server {
    listen 80;
    server_name $SUBDOMAIN.simadesk.ru;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $SUBDOMAIN.simadesk.ru;
    
    ssl_certificate /etc/letsencrypt/live/simadesk.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/simadesk.ru/privkey.pem;
    
    root $SITES_DIR/$SUBDOMAIN;
    index index.html;
    
    location / {
        try_files \$uri \$uri/ /index.html;
    }
    
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# Активируем
ln -sf "/etc/nginx/sites-available/$SUBDOMAIN.simadesk.ru" \
       "/etc/nginx/sites-enabled/$SUBDOMAIN.simadesk.ru"

# Проверяем и перезагружаем
nginx -t && systemctl reload nginx

echo "Site $SUBDOMAIN.simadesk.ru added successfully!"
```

---

## 8. Реализация в SurpriseT

### 8.1 Что взять из SurpriseT

| Компонент | Файл | Использование |
|-----------|------|---------------|
| ProductCard | `src/components/products/ProductCard.tsx` | Карточка товара на сайте клиента |
| BannerCarousel | `src/components/ui/banner-carousel.tsx` | Баннеры на главной |
| HomePage | `src/pages/HomePage.tsx` | Структура главной страницы |
| CatalogPage | `src/pages/CatalogPage.tsx` | Каталог с фильтрами |
| ProductDetailPage | `src/pages/ProductDetailPage.tsx` | Страница товара |
| database.ts | `src/lib/database.ts` | CRUD операции с Supabase |
| marketplaceParsers.ts | `src/lib/marketplaceParsers.ts` | Парсинг URL маркетплейсов |
| Парсеры | `parsers/*.py` | Playwright парсеры для WB, Ozon, YM |

### 8.2 Адаптация

1. **Убрать** корзину, checkout, заказы (не нужны для каталог-сайта)
2. **Убрать** авторизацию через Telegram (сайт публичный)
3. **Добавить** ссылки на маркетплейсы вместо кнопки "В корзину"
4. **Добавить** кастомизацию темы (цвета, логотип)
5. **Интегрировать** с Supabase таблицами из SimaDesk

---

## 9. Порядок реализации

### Фаза 1: Базовая инфраструктура (3-5 дней)
- [ ] Создать Supabase миграции
- [ ] Создать `siteBuilderDb.ts`
- [ ] Создать `types/siteBuilder.ts`
- [ ] Создать каркас `SiteBuilderModule.ts`

### Фаза 2: UI модуля (5-7 дней)
- [ ] Реализовать вкладку "Мои сайты"
- [ ] Реализовать вкладку "Товары"
- [ ] Реализовать вкладку "Баннеры"
- [ ] Реализовать вкладку "Настройки"
- [ ] Реализовать модальные окна

### Фаза 3: Импорт с маркетплейсов (3-5 дней)
- [ ] Интегрировать парсеры из SurpriseT
- [ ] Создать `siteBuilderApi.ts`
- [ ] Реализовать импорт по URL
- [ ] Реализовать поиск на маркетплейсе

### Фаза 4: Генерация и деплой (5-7 дней)
- [ ] Создать шаблоны HTML/CSS/JS
- [ ] Реализовать `siteBuilderDeploy.ts`
- [ ] Настроить Nginx на VPS
- [ ] Протестировать деплой

### Фаза 5: Тестирование и доработка (3-5 дней)
- [ ] Unit-тесты
- [ ] Интеграционные тесты
- [ ] UI/UX доработки
- [ ] Документация

---

## 10. Итого

**Общий объём работ:** 19-29 дней (1 разработчик)

**Стек:**
- Frontend: TypeScript + Vanilla DOM (как в SimaDesk)
- Backend: Supabase (PostgreSQL + RLS)
- Парсеры: Python + Playwright (из SurpriseT)
- Деплой: VPS + Nginx
- SSL: Let's Encrypt wildcard

**Ключевые файлы для создания:**
1. `src/modules/SiteBuilderModule.ts`
2. `src/services/siteBuilderDb.ts`
3. `src/services/siteBuilderApi.ts`
4. `src/services/siteBuilderDeploy.ts`
5. `src/types/siteBuilder.ts`
6. SQL миграции

**Из SurpriseT берём:**
- React-компоненты (адаптируем под Vanilla JS)
- Парсеры маркетплейсов (используем как есть)
- Структуру данных Supabase (расширяем)
