import { storefrontDb } from '../services/storefrontDb';
import type { StorefrontSettings, StorefrontProduct, StorefrontBanner } from '../services/storefrontDb';
import { showToast } from '../utils/toast';

export class SimaStoreModule {
  private el!: HTMLElement;
  private companyId!: string;
  private settings: StorefrontSettings | null = null;
  private products: StorefrontProduct[] = [];
  private banners: StorefrontBanner[] = [];
  private activeTab: 'overview' | 'settings' | 'banners' | 'products' = 'overview';
  private slugTimer: ReturnType<typeof setTimeout> | null = null;
  private slugOk: boolean | null = null;

  init(sectionId: string, companyId: string): void {
    this.el = document.getElementById(sectionId)!;
    this.companyId = companyId;
  }

  show(): void {
    this.el.style.display = 'flex';
    this.load();
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  private async load(): Promise<void> {
    const [settings, products, overrides, banners] = await Promise.all([
      storefrontDb.get(this.companyId),
      storefrontDb.getProducts(this.companyId),
      storefrontDb.getOverrides(this.companyId),
      storefrontDb.getBanners(this.companyId),
    ]);
    this.settings = settings;
    this.products = products;
    this.banners = banners;
    for (const p of this.products) {
      const ov = overrides.get(`${p.source}:${p.source_id}`);
      if (ov) Object.assign(p, ov);
    }
    this.render();
  }

  private render(): void {
    const s = this.settings;
    const slug = s?.slug ?? '';
    const storeUrl = slug ? `${window.location.origin}/${slug}` : '';
    const total   = this.products.length;
    const wb      = this.products.filter(p => p.source === 'wb').length;
    const ozon    = this.products.filter(p => p.source === 'ozon').length;
    const yndx    = this.products.filter(p => p.source === 'yandex').length;
    const visible = this.products.filter(p => !p.is_hidden).length;

    this.el.innerHTML = `
<div style="width:100%;min-height:100%">

  <!-- Header -->
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border1)">
    <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#00FFCC,#00CCAA);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#000;flex-shrink:0">S</div>
    <div>
      <div style="font-size:17px;font-weight:700;color:var(--text1)">Витрина</div>
      <div style="font-size:12px;color:var(--text2)">Ваш публичный каталог товаров</div>
    </div>
    ${s?.is_enabled && storeUrl ? `
    <a href="${storeUrl}" target="_blank" rel="noopener" style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:var(--surface2);border:1px solid var(--border1);color:var(--text1);font-size:12px;font-weight:600;text-decoration:none;flex-shrink:0">
      🌐 Открыть магазин
    </a>` : ''}
  </div>

  <!-- Tabs -->
  <div style="display:flex;gap:4px;padding:4px;background:var(--surface2);border-radius:10px;border:1px solid var(--border1);margin-bottom:20px">
    <button class="sima-store-tab ${this.activeTab==='overview' ?'active':''}" data-tab="overview" style="flex:1">Обзор</button>
    <button class="sima-store-tab ${this.activeTab==='settings' ?'active':''}" data-tab="settings" style="flex:1">Настройки</button>
    <button class="sima-store-tab ${this.activeTab==='banners'  ?'active':''}" data-tab="banners"  style="flex:1">Баннеры <span style="color:var(--text2);font-weight:400">(${this.banners.length})</span></button>
    <button class="sima-store-tab ${this.activeTab==='products' ?'active':''}" data-tab="products" style="flex:1">Товары <span style="color:var(--text2);font-weight:400">(${total})</span></button>
  </div>

  <!-- OVERVIEW -->
  <div class="sima-store-panel ${this.activeTab==='overview'?'active':''}" data-panel="overview">
    ${!s?.is_enabled ? `
    <div style="padding:16px;background:var(--surface2);border:1.5px dashed var(--border1);border-radius:10px;margin-bottom:20px;display:flex;align-items:center;gap:14px">
      <div style="font-size:28px">🏪</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:600;color:var(--text1);margin-bottom:4px">Магазин не активирован</div>
        <div style="font-size:13px;color:var(--text2)">Перейдите в «Настройки», задайте название и адрес, затем включите магазин</div>
      </div>
      <button class="ss-save-btn" style="margin:0;flex-shrink:0" id="ss-go-settings">Настроить →</button>
    </div>` : ''}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
      ${[
        ['Всего товаров', total, `${visible} видимых`],
        ['Wildberries',   wb,    'товаров'],
        ['Ozon',          ozon,  'товаров'],
        ['Яндекс Маркет', yndx,  'товаров'],
        ['Баннеры',       this.banners.length, 'активных'],
      ].map(([label, value, sub]) => `
      <div style="padding:16px;background:var(--surface2);border:1px solid var(--border1);border-radius:10px">
        <div style="font-size:11px;color:var(--text2);font-weight:500;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">${label}</div>
        <div style="font-size:28px;font-weight:800;color:var(--text1);line-height:1">${value}</div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px">${sub}</div>
      </div>`).join('')}
    </div>

    ${storeUrl ? `
    <div style="padding:14px;background:var(--surface2);border:1px solid var(--border1);border-radius:10px;display:flex;align-items:center;gap:10px">
      <div style="flex:1;font-size:13px;color:var(--text1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🌐 ${storeUrl}</div>
      <button class="ss-copy-btn" id="ss-copy-link" style="flex-shrink:0">Копировать</button>
    </div>` : ''}
  </div>

  <!-- SETTINGS -->
  <div class="sima-store-panel ${this.activeTab==='settings'?'active':''}" data-panel="settings">
    <div class="ss-field-group">
      <div class="ss-toggle-row">
        <div class="ss-toggle-info">
          <div class="ss-toggle-title">Магазин активен</div>
          <div class="ss-toggle-sub">Когда включено — магазин доступен по публичной ссылке</div>
        </div>
        <label class="ss-toggle-switch">
          <input type="checkbox" id="ss-enabled" ${s?.is_enabled ? 'checked' : ''}>
          <span class="ss-toggle-slider"></span>
        </label>
      </div>

      <div class="ss-field">
        <label class="ss-label" for="ss-store-name">Название магазина <span>отображается в шапке</span></label>
        <input class="ss-input" id="ss-store-name" type="text" placeholder="Мой магазин" value="${escHtml(s?.store_name ?? '')}">
      </div>

      <div class="ss-field">
        <label class="ss-label" for="ss-slug-input">Адрес магазина <span>только латиница, цифры и дефис</span></label>
        <div class="ss-slug-wrap">
          <span class="ss-slug-prefix">${window.location.origin}/</span>
          <input class="ss-slug-input" id="ss-slug-input" type="text" placeholder="my-store" value="${escHtml(s?.slug ?? '')}">
        </div>
        <div class="ss-hint" id="ss-slug-hint"></div>
      </div>

      <div class="ss-field">
        <label class="ss-label" for="ss-tagline">Девиз / описание <span>необязательно</span></label>
        <input class="ss-input" id="ss-tagline" type="text" placeholder="Качественные товары для всей семьи" value="${escHtml(s?.tagline ?? '')}">
      </div>

      <div class="ss-field">
        <label class="ss-label" for="ss-telegram">Telegram <span>@username или ссылка</span></label>
        <input class="ss-input" id="ss-telegram" type="text" placeholder="@mystore" value="${escHtml(s?.telegram ?? '')}">
      </div>

      <div class="ss-field">
        <label class="ss-label" for="ss-whatsapp">WhatsApp <span>номер в международном формате</span></label>
        <input class="ss-input" id="ss-whatsapp" type="text" placeholder="+7 999 123-45-67" value="${escHtml(s?.whatsapp ?? '')}">
      </div>

      <div class="ss-field">
        <label class="ss-label" for="ss-website">Сайт <span>необязательно</span></label>
        <input class="ss-input" id="ss-website" type="text" placeholder="https://mystore.ru" value="${escHtml(s?.website ?? '')}">
      </div>

      <button class="ss-save-btn" id="ss-save-btn">Сохранить</button>
    </div>
  </div>

  <!-- BANNERS -->
  <div class="sima-store-panel ${this.activeTab==='banners'?'active':''}" data-panel="banners">
    ${this.renderBannersPanel()}
  </div>

  <!-- PRODUCTS -->
  <div class="sima-store-panel ${this.activeTab==='products'?'active':''}" data-panel="products">
    ${this.renderProductsTable()}
  </div>
</div>`;

    this.bindEvents();
  }

  // ── Banners Panel ──────────────────────────────────────────────────────────

  private renderBannersPanel(): string {
    return `
<div>
  <!-- Add banner form -->
  <div style="padding:16px;background:var(--surface2);border:1px solid var(--border1);border-radius:10px;margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;color:var(--text1);margin-bottom:12px">Добавить баннер</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px">URL изображения</label>
        <input id="ss-banner-img" class="ss-input" type="url" placeholder="https://... (jpg, png, webp)" style="width:100%">
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px">Ссылка при клике <span style="font-weight:400">(необязательно)</span></label>
        <input id="ss-banner-link" class="ss-input" type="url" placeholder="https://..." style="width:100%">
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button id="ss-banner-preview-btn" class="ss-copy-btn">Превью</button>
        <button id="ss-banner-add-btn" class="ss-save-btn" style="margin:0;flex:1">Добавить баннер</button>
      </div>
      <div id="ss-banner-preview-area" style="display:none;margin-top:8px;border-radius:8px;overflow:hidden;max-height:200px">
        <img id="ss-banner-preview-img" src="" alt="preview" style="width:100%;height:200px;object-fit:cover">
      </div>
    </div>
  </div>

  <!-- Banner list -->
  <div id="ss-banner-list">
    ${this.renderBannerList()}
  </div>
</div>`;
  }

  private renderBannerList(): string {
    if (this.banners.length === 0) {
      return `<div style="text-align:center;padding:40px 20px;color:var(--text2)">
        <div style="font-size:40px;margin-bottom:12px">🖼️</div>
        <div style="font-size:14px;font-weight:600;color:var(--text1);margin-bottom:4px">Баннеры не добавлены</div>
        <div style="font-size:13px">Добавьте первый баннер для отображения на главной странице магазина</div>
      </div>`;
    }

    return this.banners.map((b, i) => `
<div class="ss-banner-row" data-banner-id="${escHtml(b.id)}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border1);border-radius:10px;margin-bottom:8px">
  <div style="flex-shrink:0;width:64px;height:40px;border-radius:6px;overflow:hidden;background:var(--surface3,var(--surface2))">
    <img src="${escHtml(b.image_url)}" alt="banner" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.display='none'">
  </div>
  <div style="flex:1;min-width:0">
    <div style="font-size:12px;color:var(--text1);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(b.image_url)}</div>
    ${b.link_url && b.link_url !== '/' ? `<div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">→ ${escHtml(b.link_url)}</div>` : ''}
  </div>
  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
    ${i > 0 ? `<button class="ss-icon-btn" data-action="banner-up" title="Вверх">↑</button>` : '<span style="width:28px"></span>'}
    ${i < this.banners.length - 1 ? `<button class="ss-icon-btn" data-action="banner-down" title="Вниз">↓</button>` : '<span style="width:28px"></span>'}
    <label style="display:flex;align-items:center;cursor:pointer;margin:0 4px" title="${b.is_active ? 'Скрыть' : 'Показать'}">
      <input type="checkbox" ${b.is_active ? 'checked' : ''} data-action="banner-toggle" style="margin:0">
    </label>
    <button class="ss-icon-btn danger" data-action="banner-delete" title="Удалить">✕</button>
  </div>
</div>`).join('');
  }

  // ── Products Table ─────────────────────────────────────────────────────────

  private renderProductsTable(): string {
    if (this.products.length === 0) {
      return `<div style="text-align:center;padding:40px 20px">
        <div style="font-size:40px;margin-bottom:12px">📦</div>
        <div style="font-size:14px;font-weight:600;color:var(--text1);margin-bottom:4px">Товаров пока нет</div>
        <div style="font-size:13px;color:var(--text2)">Синхронизируйте товары с маркетплейсов, и они появятся здесь автоматически</div>
      </div>`;
    }

    const rows = this.products.slice(0, 300).map(p => {
      const img = p.image
        ? `<img class="ss-prod-img-cell" src="${p.image}" alt="" loading="lazy" onerror="this.src=''">`
        : `<div class="ss-prod-img-cell" style="display:flex;align-items:center;justify-content:center;font-size:18px">📦</div>`;
      const price = Math.round(p.price).toLocaleString('ru-RU') + ' ₽';

      return `<tr data-source="${p.source}" data-id="${escHtml(p.source_id)}" style="${p.is_hidden ? 'opacity:.5' : ''}">
        <td style="padding:6px 8px">${img}</td>
        <td style="padding:6px 8px">
          <div style="font-size:13px;font-weight:500;color:var(--text1);max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(p.title)}</div>
          <div style="font-size:11px;color:var(--text2)">${escHtml(p.vendor_code)}</div>
        </td>
        <td style="padding:6px 8px"><span class="ss-badge ${p.source}">${SOURCE_LABELS[p.source]}</span></td>
        <td style="padding:6px 8px;font-weight:600;font-size:13px;white-space:nowrap">${price}</td>
        <td style="padding:6px 8px;min-width:180px">
          <input
            type="url"
            class="ss-input ss-custom-url-input"
            placeholder="https://... (своя ссылка)"
            value="${escHtml(p.custom_url ?? '')}"
            style="font-size:11px;padding:4px 8px;height:auto;width:100%"
            data-source="${p.source}"
            data-id="${escHtml(p.source_id)}"
          >
        </td>
        <td style="padding:6px 8px">
          <div class="ss-admin-actions">
            <button class="ss-icon-btn ${p.is_hidden ? 'danger' : ''}" data-action="toggle-hide" title="${p.is_hidden ? 'Показать' : 'Скрыть'}">
              ${p.is_hidden ? '👁' : '🚫'}
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

    return `<div style="overflow-x:auto">
      <table class="ss-products-table" style="width:100%">
        <thead>
          <tr>
            <th style="width:48px"></th>
            <th>Название / Артикул</th>
            <th>Площадка</th>
            <th>Цена</th>
            <th>Своя ссылка</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="font-size:11px;color:var(--text2);margin-top:8px;padding:0 4px">
        💡 Своя ссылка — кнопка «Купить у продавца» в карточке товара на витрине. Сохраняется при потере фокуса.
      </div>
    </div>`;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    // Tab switching
    this.el.querySelectorAll('.sima-store-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab as typeof this.activeTab;
        this.activeTab = tab;
        this.el.querySelectorAll('.sima-store-tab').forEach(b => b.classList.remove('active'));
        this.el.querySelectorAll('.sima-store-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        this.el.querySelector(`[data-panel="${tab}"]`)?.classList.add('active');
      });
    });

    document.getElementById('ss-go-settings')?.addEventListener('click', () => {
      this.activeTab = 'settings';
      this.el.querySelectorAll('.sima-store-tab').forEach(b => b.classList.remove('active'));
      this.el.querySelectorAll('.sima-store-panel').forEach(p => p.classList.remove('active'));
      this.el.querySelector('[data-tab="settings"]')!.classList.add('active');
      this.el.querySelector('[data-panel="settings"]')!.classList.add('active');
    });

    document.getElementById('ss-copy-link')?.addEventListener('click', () => {
      const slug = this.settings?.slug;
      if (slug) {
        navigator.clipboard.writeText(`${window.location.origin}/${slug}`);
        showToast('Ссылка скопирована', 'success');
      }
    });

    // Settings: slug validation
    const slugInput = document.getElementById('ss-slug-input') as HTMLInputElement | null;
    if (slugInput) {
      slugInput.addEventListener('input', () => {
        const val = slugInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (slugInput.value !== val) slugInput.value = val;
        this.validateSlug(val);
      });
    }

    document.getElementById('ss-save-btn')?.addEventListener('click', () => this.save());

    // Products: hide toggle
    this.el.querySelectorAll('[data-action="toggle-hide"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = (btn as HTMLElement).closest('tr') as HTMLTableRowElement;
        const source = row.dataset.source!;
        const sourceId = row.dataset.id!;
        const p = this.products.find(x => x.source === source && x.source_id === sourceId);
        if (!p) return;
        p.is_hidden = !p.is_hidden;
        await storefrontDb.setOverride(this.companyId, source, sourceId, { is_hidden: p.is_hidden });
        (btn as HTMLElement).textContent = p.is_hidden ? '👁' : '🚫';
        (btn as HTMLElement).classList.toggle('danger', p.is_hidden);
        (btn as HTMLElement).title = p.is_hidden ? 'Показать' : 'Скрыть';
        const tr = (btn as HTMLElement).closest('tr') as HTMLTableRowElement;
        if (tr) tr.style.opacity = p.is_hidden ? '0.5' : '1';
        showToast(p.is_hidden ? 'Товар скрыт из магазина' : 'Товар снова в магазине', 'success');
      });
    });

    // Products: custom URL save on blur
    this.el.querySelectorAll('.ss-custom-url-input').forEach(input => {
      const inp = input as HTMLInputElement;
      inp.addEventListener('blur', async () => {
        const source   = inp.dataset.source!;
        const sourceId = inp.dataset.id!;
        const val      = inp.value.trim();
        const p = this.products.find(x => x.source === source && x.source_id === sourceId);
        if (!p || p.custom_url === val) return;
        p.custom_url = val;
        await storefrontDb.setOverride(this.companyId, source, sourceId, { custom_url: val });
        showToast('Ссылка сохранена', 'success');
      });
      inp.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') inp.blur();
      });
    });

    // Banners: preview
    document.getElementById('ss-banner-preview-btn')?.addEventListener('click', () => {
      const url = (document.getElementById('ss-banner-img') as HTMLInputElement)?.value?.trim();
      const area = document.getElementById('ss-banner-preview-area');
      const img  = document.getElementById('ss-banner-preview-img') as HTMLImageElement;
      if (url && area && img) {
        img.src = url;
        area.style.display = 'block';
      }
    });

    // Banners: add
    document.getElementById('ss-banner-add-btn')?.addEventListener('click', async () => {
      const imgUrl  = (document.getElementById('ss-banner-img')  as HTMLInputElement)?.value?.trim();
      const linkUrl = (document.getElementById('ss-banner-link') as HTMLInputElement)?.value?.trim();
      if (!imgUrl) { showToast('Введите URL изображения', 'error'); return; }
      const btn = document.getElementById('ss-banner-add-btn') as HTMLButtonElement;
      btn.disabled = true; btn.textContent = 'Добавляем…';
      try {
        const nextOrder = this.banners.length > 0 ? Math.max(...this.banners.map(b => b.sort_order)) + 1 : 0;
        await storefrontDb.addBanner(this.companyId, imgUrl, linkUrl || '/', nextOrder);
        showToast('Баннер добавлен', 'success');
        (document.getElementById('ss-banner-img')  as HTMLInputElement).value = '';
        (document.getElementById('ss-banner-link') as HTMLInputElement).value = '';
        const area = document.getElementById('ss-banner-preview-area');
        if (area) area.style.display = 'none';
        await this.reloadBanners();
      } catch {
        showToast('Ошибка при добавлении баннера', 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Добавить баннер';
      }
    });

    // Banners: row actions (delete, toggle, up/down)
    document.getElementById('ss-banner-list')?.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const row    = target.closest('.ss-banner-row') as HTMLElement | null;
      if (!row) return;
      const id  = row.dataset.bannerId!;
      const idx = this.banners.findIndex(b => b.id === id);
      if (idx < 0) return;

      const action = target.dataset.action;
      if (!action) return;

      if (action === 'banner-delete') {
        if (!confirm('Удалить баннер?')) return;
        await storefrontDb.deleteBanner(id);
        showToast('Баннер удалён', 'success');
        await this.reloadBanners();
        return;
      }

      if (action === 'banner-up' && idx > 0) {
        const a = this.banners[idx]; const b = this.banners[idx-1];
        const tmpOrder = a.sort_order; a.sort_order = b.sort_order; b.sort_order = tmpOrder;
        [this.banners[idx], this.banners[idx-1]] = [b, a];
        await storefrontDb.updateBannerOrder([
          { id: a.id, sort_order: a.sort_order },
          { id: b.id, sort_order: b.sort_order },
        ]);
        this.rerenderBannerList();
        return;
      }

      if (action === 'banner-down' && idx < this.banners.length - 1) {
        const a = this.banners[idx]; const b = this.banners[idx+1];
        const tmpOrder = a.sort_order; a.sort_order = b.sort_order; b.sort_order = tmpOrder;
        [this.banners[idx], this.banners[idx+1]] = [b, a];
        await storefrontDb.updateBannerOrder([
          { id: a.id, sort_order: a.sort_order },
          { id: b.id, sort_order: b.sort_order },
        ]);
        this.rerenderBannerList();
        return;
      }
    });

    // Banners: toggle active (checkbox)
    document.getElementById('ss-banner-list')?.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      if (target.dataset.action !== 'banner-toggle') return;
      const row = target.closest('.ss-banner-row') as HTMLElement | null;
      if (!row) return;
      const id  = row.dataset.bannerId!;
      const idx = this.banners.findIndex(b => b.id === id);
      if (idx < 0) return;
      this.banners[idx].is_active = target.checked;
      await storefrontDb.toggleBannerActive(id, target.checked);
      showToast(target.checked ? 'Баннер активен' : 'Баннер скрыт', 'success');
    });
  }

  private rerenderBannerList(): void {
    const listEl = document.getElementById('ss-banner-list');
    if (listEl) listEl.innerHTML = this.renderBannerList();
    // Re-bind events for the new list
    // banner list events are handled by the delegated listener bound in bindEvents()
  }

  private async reloadBanners(): Promise<void> {
    this.banners = await storefrontDb.getBanners(this.companyId);
    const listEl = document.getElementById('ss-banner-list');
    if (listEl) listEl.innerHTML = this.renderBannerList();
    // Re-bind banner list events
    const overview = this.el.querySelector('[data-panel="overview"]');
    if (overview) {
      const countEl = overview.querySelector('[data-banner-count]');
      if (countEl) countEl.textContent = String(this.banners.length);
    }
    // Update tab label
    const bannerTab = this.el.querySelector('[data-tab="banners"]');
    if (bannerTab) bannerTab.innerHTML = `Баннеры <span style="color:var(--text2);font-weight:400">(${this.banners.length})</span>`;
  }

  // ── Slug validation ────────────────────────────────────────────────────────

  private validateSlug(val: string): void {
    const hintEl = document.getElementById('ss-slug-hint')!;
    if (this.slugTimer) clearTimeout(this.slugTimer);
    if (!val) { hintEl.textContent = ''; hintEl.className = 'ss-hint'; this.slugOk = null; return; }
    if (val.length < 3) { hintEl.textContent = 'Минимум 3 символа'; hintEl.className = 'ss-hint error'; this.slugOk = false; return; }
    hintEl.textContent = 'Проверяем…'; hintEl.className = 'ss-hint';
    this.slugTimer = setTimeout(async () => {
      const available = await storefrontDb.checkSlugAvailable(val, this.companyId);
      this.slugOk = available;
      if (available) { hintEl.textContent = `✓ ${window.location.origin}/${val} — свободно`; hintEl.className = 'ss-hint ok'; }
      else           { hintEl.textContent = '✗ Этот адрес уже занят'; hintEl.className = 'ss-hint error'; }
    }, 500);
  }

  // ── Save settings ──────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    const btn = document.getElementById('ss-save-btn') as HTMLButtonElement;
    const slugInput = document.getElementById('ss-slug-input') as HTMLInputElement;
    const slug = slugInput?.value?.trim() ?? '';
    if (slug && this.slugOk === false) { showToast('Исправьте адрес магазина', 'error'); return; }
    const storeName = (document.getElementById('ss-store-name') as HTMLInputElement)?.value?.trim() ?? '';
    if (!storeName) { showToast('Введите название магазина', 'error'); return; }
    btn.disabled = true; btn.textContent = 'Сохранение…';
    try {
      const payload: Partial<StorefrontSettings> & { company_id: string } = {
        company_id: this.companyId,
        is_enabled: (document.getElementById('ss-enabled') as HTMLInputElement)?.checked ?? false,
        store_name: storeName,
        slug: slug || null as any,
        tagline:  (document.getElementById('ss-tagline')  as HTMLInputElement)?.value?.trim() ?? '',
        telegram: (document.getElementById('ss-telegram') as HTMLInputElement)?.value?.trim() ?? '',
        whatsapp: (document.getElementById('ss-whatsapp') as HTMLInputElement)?.value?.trim() ?? '',
        website:  (document.getElementById('ss-website')  as HTMLInputElement)?.value?.trim() ?? '',
      };
      await storefrontDb.save(payload);
      this.settings = { ...this.settings, ...payload } as StorefrontSettings;
      showToast('Настройки сохранены', 'success');
      this.render();
    } catch (e: any) {
      showToast('Ошибка при сохранении', 'error');
      console.error('[SimaStore] save error', e);
    } finally {
      btn.disabled = false; btn.textContent = 'Сохранить';
    }
  }
}

const SOURCE_LABELS: Record<string, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'Яндекс' };

function escHtml(s: string): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
