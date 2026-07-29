import type { StorefrontProduct, StorefrontBanner, StorefrontGroup, StorefrontVariantGroup, StorefrontVariantItem } from '../services/storefrontDb';
import { setFavicon } from '../utils/favicon';

const API_URL = import.meta.env.VITE_API_URL as string;
const API_KEY  = import.meta.env.VITE_API_KEY  as string;
const REST_URL = `${API_URL}/rest/v1`;

const MP_LABEL: Record<string, string> = { wb: 'Wildberries', ozon: 'Ozon', yandex: 'Яндекс Маркет' };

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function buildBuyUrl(p: StorefrontProduct): string {
  if (p.source === 'wb')     return `https://www.wildberries.ru/catalog/${p.source_id}/detail.aspx`;
  if (p.source === 'ozon')   return p.ozon_sku ? `https://www.ozon.ru/product/${p.ozon_sku}/` : `https://www.ozon.ru/product/${p.source_id}/`;
  if (p.yandex_market_model_id) return `https://market.yandex.ru/product/${p.yandex_market_model_id}?sku=${p.source_id}`;
  return `https://market.yandex.ru/search?text=${p.source_id}`;
}

/* ── Product grouping ──────────────────────────────────────────────────────── */

interface ProductGroup {
  key: string;
  title: string;
  brand: string;
  category: string;
  image: string | null;
  minPrice: number;
  maxPrice: number;
  variants: StorefrontProduct[];
  customUrl: string;
  customPrice: number | null;
  totalStock: number;
}

function groupProducts(all: StorefrontProduct[]): ProductGroup[] {
  const visible = all.filter(p => !p.is_hidden);
  const byKey   = new Map<string, StorefrontProduct[]>();
  for (const p of visible) {
    const key = p.vendor_code.trim().toLowerCase() || `__${p.source}:${p.source_id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(p);
  }

  const groups: ProductGroup[] = [];
  for (const [key, items] of byKey) {
    const bestPerSource = new Map<string, StorefrontProduct>();
    for (const p of items) {
      const price = p.custom_price ?? p.price;
      const cur   = bestPerSource.get(p.source);
      if (!cur || price < (cur.custom_price ?? cur.price)) bestPerSource.set(p.source, p);
    }
    const variants = [...bestPerSource.values()];

    const withMostImages = variants.reduce((best, p) =>
      p.images.length > best.images.length ? p : best, variants[0]);
    const image = withMostImages.images[0] ?? null;

    const prices   = variants.map(p => p.custom_price ?? p.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const customTitleStr = variants.find(p => p.custom_title)?.custom_title ?? '';
    const title    = customTitleStr || variants.reduce((best, p) => p.title.length > best.length ? p.title : best, '');
    const brand    = variants.find(p => p.brand)?.brand ?? '';
    const category = variants.find(p => p.category)?.category ?? '';

    const withCustomUrl = variants.find(p => p.custom_url);
    const customUrl   = withCustomUrl?.custom_url ?? '';
    const customPrice = withCustomUrl?.custom_price ?? null;
    const totalStock  = variants.reduce((sum, v) => sum + (v.stock ?? 0), 0);

    groups.push({ key, title, brand, category, image, minPrice, maxPrice, variants, customUrl, customPrice, totalStock });
  }

  return groups;
}

/* ── Banner carousel ───────────────────────────────────────────────────────── */

class BannerCarousel {
  private idx = 0;
  private transitioning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private isHorizontal = false;

  constructor(private el: HTMLElement, private banners: StorefrontBanner[]) {
    this.render();
    this.bind();
    this.startAuto();
  }

  private get total() { return this.banners.length; }
  private prev(n: number) { return (n - 1 + this.total) % this.total; }
  private next(n: number) { return (n + 1) % this.total; }

  private go(to: number) {
    if (this.transitioning || to === this.idx) return;
    this.transitioning = true;
    this.idx = to;
    this.updateDOM();
    setTimeout(() => { this.transitioning = false; }, 320);
    this.resetAuto();
  }

  private goNext() { this.go(this.next(this.idx)); }
  private goPrev() { this.go(this.prev(this.idx)); }

  private startAuto() {
    if (this.total <= 1) return;
    this.timer = setInterval(() => this.goNext(), 5000);
  }
  private resetAuto() {
    if (this.timer) clearInterval(this.timer);
    this.startAuto();
  }

  private render() {
    if (!this.total) { this.el.style.display = 'none'; return; }
    const b  = this.banners;
    const pi = this.prev(this.idx);
    const ni = this.next(this.idx);

    this.el.innerHTML = `
      <div class="ssc-inner">
        ${this.total > 1 ? `<div class="ssc-side ssc-prev" data-go="prev">
          <div class="ssc-side-img"><img src="${esc(b[pi].image_url)}" alt="" loading="lazy"></div>
          <div class="ssc-side-dim"></div>
        </div>` : ''}
        <div class="ssc-main">
          ${b[this.idx].link_url && b[this.idx].link_url !== '/'
            ? `<a href="${esc(b[this.idx].link_url)}" class="ssc-main-img" target="_blank" rel="noopener">`
            : `<div class="ssc-main-img">`}
          <img src="${esc(b[this.idx].image_url)}" alt="${esc(b[this.idx].title??'')}" loading="eager">
          ${b[this.idx].link_url && b[this.idx].link_url !== '/' ? `</a>` : `</div>`}
        </div>
        ${this.total > 1 ? `<div class="ssc-side ssc-next" data-go="next">
          <div class="ssc-side-img"><img src="${esc(b[ni].image_url)}" alt="" loading="lazy"></div>
          <div class="ssc-side-dim"></div>
        </div>` : ''}
      </div>
      ${this.total > 1 ? `<div class="ssc-dots">
        ${b.map((_,i) => `<button class="ssc-dot ${i===this.idx?'on':''}" data-dot="${i}" aria-label="Баннер ${i+1}"></button>`).join('')}
      </div>` : ''}`;
  }

  private updateDOM() {
    const b   = this.banners;
    const pi  = this.prev(this.idx);
    const ni  = this.next(this.idx);
    const prevEl   = this.el.querySelector('.ssc-prev .ssc-side-img img') as HTMLImageElement|null;
    const nextEl   = this.el.querySelector('.ssc-next .ssc-side-img img') as HTMLImageElement|null;
    const mainImg  = this.el.querySelector('.ssc-main img') as HTMLImageElement|null;
    const mainWrap = this.el.querySelector('.ssc-main > *') as HTMLElement|null;

    if (prevEl)  prevEl.src = b[pi].image_url;
    if (nextEl)  nextEl.src = b[ni].image_url;
    if (mainImg) {
      mainImg.classList.add('ssc-fade');
      setTimeout(() => {
        mainImg.src = b[this.idx].image_url;
        mainImg.classList.remove('ssc-fade');
      }, 160);
    }
    if (mainWrap && b[this.idx].link_url && b[this.idx].link_url !== '/') {
      (mainWrap as HTMLAnchorElement).href = b[this.idx].link_url;
    }
    this.el.querySelectorAll('.ssc-dot').forEach((d, i) =>
      d.classList.toggle('on', i === this.idx));
  }

  private bind() {
    this.el.addEventListener('click', (e) => {
      const t    = e.target as HTMLElement;
      const side = t.closest('[data-go]') as HTMLElement|null;
      if (side) { side.dataset.go === 'prev' ? this.goPrev() : this.goNext(); return; }
      const dot = t.closest('[data-dot]') as HTMLElement|null;
      if (dot)  { this.go(Number(dot.dataset.dot)); return; }
    });
    this.el.addEventListener('touchstart', (e) => {
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
      this.isHorizontal = false;
    }, { passive: true });
    this.el.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - this.touchStartX);
      const dy = Math.abs(e.touches[0].clientY - this.touchStartY);
      if (!this.isHorizontal && dx > dy && dx > 8) this.isHorizontal = true;
      if (this.isHorizontal) e.preventDefault();
    }, { passive: false });
    this.el.addEventListener('touchend', (e) => {
      if (!this.isHorizontal) return;
      const dx = e.changedTouches[0].clientX - this.touchStartX;
      if (dx < -50) this.goNext();
      if (dx > 50)  this.goPrev();
    }, { passive: true });
  }
}

/* ── Product card ──────────────────────────────────────────────────────────── */

function renderCard(g: ProductGroup, showStock = false, variantBtns = ''): string {
  const priceStr = g.minPrice === g.maxPrice
    ? fmt(g.minPrice)
    : `${fmt(g.minPrice)} – ${fmt(g.maxPrice)}`;

  const img = g.image
    ? `<img src="${esc(g.image)}" alt="${esc(g.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const placeholder = `<div class="ssp-placeholder" style="${g.image?'display:none':''}">📦</div>`;

  const srcBadges = g.variants.map(v =>
    `<span class="ssp-src-badge ${v.source}">${MP_LABEL[v.source]?.split(' ')[0]??v.source}</span>`
  ).join('');

  const stockBadge = showStock
    ? g.totalStock > 0
      ? `<div class="ssp-stock">${g.totalStock} шт.</div>`
      : `<div class="ssp-stock out">нет в наличии</div>`
    : '';

  return `<div class="ssp-card" data-key="${esc(g.key)}">
    <div class="ssp-img">
      ${img}${placeholder}
      <div class="ssp-src-badges">${srcBadges}</div>
    </div>
    <div class="ssp-body">
      ${g.brand ? `<div class="ssp-brand">${esc(g.brand)}</div>` : ''}
      <div class="ssp-title">${esc(g.title)}</div>
      <div class="ssp-price">${esc(priceStr)}</div>
      ${stockBadge}
      ${variantBtns ? `<div class="ssp-variants">${variantBtns}</div>` : ''}
      <button class="ssp-buy-btn" type="button">Купить</button>
    </div>
  </div>`;
}

/* ── Product modal ─────────────────────────────────────────────────────────── */

function openProductModal(g: ProductGroup) {
  document.getElementById('ssp-modal')?.remove();

  const priceStr = g.minPrice === g.maxPrice
    ? fmt(g.minPrice)
    : `${fmt(g.minPrice)} – ${fmt(g.maxPrice)}`;

  const mpButtons = g.variants.map(v => {
    const url   = buildBuyUrl(v);
    const price = v.custom_price ?? v.price;
    return `<a href="${esc(url)}" class="ssp-mp-btn ${v.source}" target="_blank" rel="noopener">
      <span class="ssp-mp-name">${esc(MP_LABEL[v.source] ?? v.source)}</span>
      <span class="ssp-mp-price">${fmt(price)}</span>
    </a>`;
  }).join('');

  const websiteBtn = g.customUrl ? `<a href="${esc(g.customUrl)}" class="ssp-mp-btn site" target="_blank" rel="noopener">
    <span class="ssp-mp-name">На сайте магазина</span>
    ${g.customPrice != null ? `<span class="ssp-mp-price">${fmt(g.customPrice)}</span>` : ''}
  </a>` : '';

  const div = document.createElement('div');
  div.id    = 'ssp-modal';
  div.className = 'ssp-modal-bg';
  div.innerHTML = `<div class="ssp-modal" role="dialog" aria-modal="true">
    <button class="ssp-modal-close" id="ssp-modal-close" aria-label="Закрыть">✕</button>
    <div class="ssp-modal-img">
      ${g.image
        ? `<img src="${esc(g.image)}" alt="${esc(g.title)}">`
        : `<div class="ssp-modal-img-placeholder">📦</div>`}
    </div>
    <div class="ssp-modal-body">
      ${g.brand ? `<div class="ssp-modal-brand">${esc(g.brand)}</div>` : ''}
      <div class="ssp-modal-title">${esc(g.title)}</div>
      <div class="ssp-modal-price">${esc(priceStr)}</div>
      <div class="ssp-modal-subtitle">Выберите магазин</div>
      <div class="ssp-mp-list">${mpButtons}${websiteBtn}</div>
    </div>
  </div>`;

  document.body.appendChild(div);
  document.body.style.overflow = 'hidden';

  const close = () => {
    div.remove();
    document.body.style.overflow = '';
  };

  div.addEventListener('click', (e) => { if (e.target === div) close(); });
  document.getElementById('ssp-modal-close')?.addEventListener('click', close);
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  requestAnimationFrame(() => div.classList.add('open'));
}

/* ── Filters ───────────────────────────────────────────────────────────────── */

interface Filters {
  query:    string;
  source:   string;
  priceMin: number | null;
  priceMax: number | null;
  brand:    string;
  category: string;
}

function filterGroups(groups: ProductGroup[], f: Filters): ProductGroup[] {
  const q = f.query.toLowerCase().trim();
  return groups.filter(g => {
    if (f.source !== 'all' && !g.variants.some(v => v.source === f.source)) return false;
    if (q && !g.title.toLowerCase().includes(q) && !g.key.includes(q))       return false;
    if (f.priceMin != null && g.maxPrice < f.priceMin) return false;
    if (f.priceMax != null && g.minPrice > f.priceMax) return false;
    if (f.brand    && g.brand !== f.brand)     return false;
    if (f.category && g.category !== f.category) return false;
    return true;
  });
}

function renderFilters(
  groups: ProductGroup[],
  f: Filters,
  settings: { show_price_filter: boolean; show_brand_filter: boolean; show_category_filter: boolean },
): string {
  const allPrices = groups.flatMap(g => [g.minPrice, g.maxPrice]);
  const absMin    = allPrices.length ? Math.floor(Math.min(...allPrices)) : 0;
  const absMax    = allPrices.length ? Math.ceil(Math.max(...allPrices))  : 999999;

  const brands     = [...new Set(groups.map(g => g.brand).filter(Boolean))].sort();
  const categories = [...new Set(groups.map(g => g.category).filter(Boolean))].sort();

  const hasFilters = settings.show_price_filter || settings.show_brand_filter || settings.show_category_filter;
  if (!hasFilters) return '';

  return `<div class="ss-filters" id="ss-filters">
    ${settings.show_price_filter ? `
    <div class="ss-filter-group">
      <div class="ss-filter-label">Цена</div>
      <div class="ss-price-inputs">
        <input type="number" class="ss-price-inp" id="sf-pmin" placeholder="от" min="${absMin}" max="${absMax}" value="${f.priceMin ?? ''}">
        <span class="ss-price-sep">—</span>
        <input type="number" class="ss-price-inp" id="sf-pmax" placeholder="до" min="${absMin}" max="${absMax}" value="${f.priceMax ?? ''}">
        <span class="ss-price-cur">₽</span>
      </div>
    </div>` : ''}

    ${settings.show_brand_filter && brands.length > 1 ? `
    <div class="ss-filter-group">
      <div class="ss-filter-label">Бренд</div>
      <div class="ss-filter-chips">
        ${brands.map(b => `<button class="ss-chip ${f.brand===b?'on':''}" data-brand="${esc(b)}">${esc(b)}</button>`).join('')}
      </div>
    </div>` : ''}

    ${settings.show_category_filter && categories.length > 1 ? `
    <div class="ss-filter-group">
      <div class="ss-filter-label">Категория</div>
      <div class="ss-filter-chips">
        ${categories.map(c => `<button class="ss-chip ${f.category===c?'on':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
    </div>` : ''}

    ${(f.priceMin != null || f.priceMax != null || f.brand || f.category)
      ? `<button class="ss-chip ss-chip-reset" id="sf-reset">✕ Сбросить фильтры</button>`
      : ''}
  </div>`;
}

/* ── Groups sections (when no active filter) ───────────────────────────────── */

function buildVariantBtns(key: string, variantMap: Map<string, { items: StorefrontVariantItem[]; groupId: string }>, allGroups: ProductGroup[]): string {
  const vg = variantMap.get(key); // key is already lowercase
  if (!vg || vg.items.length < 2) return '';
  return vg.items.map(it => {
    const itKey = it.vendor_code.trim().toLowerCase();
    const isActive = itKey === key;
    const targetGroup = allGroups.find(g => g.key === itKey);
    return `<button class="ssp-var-btn ${isActive ? 'active' : ''}"
      style="background:${esc(it.color)};border-color:${esc(it.color)}"
      data-var-key="${esc(itKey)}"
      ${!targetGroup ? 'disabled' : ''}
      title="${esc(it.label)}">${esc(it.label.slice(0, 3))}</button>`;
  }).join('');
}

function renderGroupSections(
  groups: ProductGroup[],
  storefrontGroups: StorefrontGroup[],
  showStock = false,
  variantMap: Map<string, { items: StorefrontVariantItem[]; groupId: string }> = new Map(),
): string {
  if (!storefrontGroups.length) return renderFlatGrid(groups, showStock, variantMap);

  const groupedKeys = new Set<string>();
  let html = '';

  for (const sg of storefrontGroups) {
    const vcs     = new Set(sg.vendor_codes ?? []);
    const inGroup = groups.filter(g => vcs.has(g.key));
    if (!inGroup.length) continue;
    inGroup.forEach(g => groupedKeys.add(g.key));

    const cover = sg.cover_url
      ? `<div class="ssp-section-cover" style="background-image:url('${esc(sg.cover_url)}')">
           <div class="ssp-section-cover-dim"></div>
           <div class="ssp-section-name">${esc(sg.name)}</div>
         </div>`
      : `<div class="ssp-section-hdr"><div class="ssp-section-name-plain">${esc(sg.name)}</div></div>`;

    html += `<div class="ssp-section" id="sg-${esc(sg.id)}">
      ${cover}
      <div class="ssp-grid">${inGroup.map(g => renderCard(g, showStock, buildVariantBtns(g.key, variantMap, groups))).join('')}</div>
    </div>`;
  }

  const ungrouped = groups.filter(g => !groupedKeys.has(g.key));
  if (ungrouped.length) {
    html += `<div class="ssp-section">
      ${storefrontGroups.length > 0 ? `<div class="ssp-section-hdr"><div class="ssp-section-name-plain">Остальные товары</div></div>` : ''}
      <div class="ssp-grid">${ungrouped.map(g => renderCard(g, showStock, buildVariantBtns(g.key, variantMap, groups))).join('')}</div>
    </div>`;
  }

  return html || `<div class="ssp-empty"><div class="ssp-empty-ico">📦</div><div class="ssp-empty-title">Нет товаров</div></div>`;
}

function renderFlatGrid(groups: ProductGroup[], showStock = false, variantMap: Map<string, { items: StorefrontVariantItem[]; groupId: string }> = new Map()): string {
  if (!groups.length) return `<div class="ssp-empty">
    <div class="ssp-empty-ico">🔍</div>
    <div class="ssp-empty-title">Ничего не найдено</div>
    <div class="ssp-empty-sub">Попробуйте изменить запрос или сбросить фильтр</div>
  </div>`;
  return `<div class="ssp-grid">${groups.map(g => renderCard(g, showStock, buildVariantBtns(g.key, variantMap, groups))).join('')}</div>`;
}

/* ── Main entry ────────────────────────────────────────────────────────────── */

export async function renderPublicStorefront(slug: string): Promise<void> {
  const app = document.getElementById('simastore-public')!;
  app.style.display = 'block';

  app.innerHTML = `<div class="ss-wrap">
    <div class="ss-loading">
      <div class="ss-spinner"></div>
      <div class="ss-loading-txt">Загружаем магазин…</div>
    </div>
  </div>`;

  let data: any;
  try {
    const res = await fetch(`${REST_URL}/rpc/get_storefront`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'apikey':API_KEY, 'Authorization':`Bearer ${API_KEY}` },
      body: JSON.stringify({ p_slug: slug }),
    });
    data = await res.json();
  } catch {
    data = { error: 'network' };
  }

  if (!data || data.error) {
    app.innerHTML = `<div class="ss-wrap">
      <div class="ss-state" style="min-height:80vh">
        <div class="ss-state-icon">🏪</div>
        <div class="ss-state-title">Магазин не найден</div>
        <div class="ss-state-sub">Проверьте адрес или попросите владельца поделиться правильной ссылкой</div>
      </div>
    </div>`;
    document.title = 'SimaStore — магазин не найден';
    return;
  }

  const s = data.settings as {
    store_name: string; tagline: string;
    telegram: string; whatsapp: string; website: string; slug: string;
    logo_url?: string|null;
    show_price_filter: boolean; show_brand_filter: boolean; show_category_filter: boolean;
    show_stock: boolean; hide_out_of_stock: boolean;
  };
  const rawProducts: StorefrontProduct[]  = data.products ?? [];
  const banners: StorefrontBanner[]       = (data.banners ?? []).filter((b: StorefrontBanner) => b.is_active);
  const storefrontGroups: StorefrontGroup[] = data.groups ?? [];
  const storefrontVariants: StorefrontVariantGroup[] = data.variants ?? [];
  const groups = groupProducts(rawProducts);

  // Build vendor_code (lowercase) → variantGroup mapping — keys must match g.key which is always lowercase
  const variantMap = new Map<string, { items: StorefrontVariantItem[]; groupId: string }>();
  for (const vg of storefrontVariants) {
    for (const it of vg.items) {
      variantMap.set(it.vendor_code.trim().toLowerCase(), { items: vg.items, groupId: vg.id });
    }
  }

  document.title = s.store_name;

  if (s.logo_url) setFavicon(s.logo_url);

  const contactBtns = [
    s.telegram ? `<a href="https://t.me/${s.telegram.replace(/^@/,'')}" class="ss-contact-btn tg" target="_blank" rel="noopener">✈ Telegram</a>` : '',
    s.whatsapp  ? `<a href="https://wa.me/${s.whatsapp.replace(/\D/g,'')}" class="ss-contact-btn wa" target="_blank" rel="noopener">💬 WhatsApp</a>` : '',
    s.website   ? `<a href="${esc(s.website.startsWith('http')?s.website:'https://'+s.website)}" class="ss-contact-btn web" target="_blank" rel="noopener">🌐 Сайт</a>` : '',
  ].filter(Boolean).join('');

  const sources  = [...new Set(rawProducts.map(p => p.source))];
  const hasSrc   = (src: string) => sources.includes(src as any);

  const showStock = !!s.show_stock;

  const filters: Filters = { query: '', source: 'all', priceMin: null, priceMax: null, brand: '', category: '' };
  const hasAnyFilter = () =>
    filters.query || filters.source !== 'all' ||
    filters.priceMin != null || filters.priceMax != null ||
    filters.brand || filters.category;

  app.innerHTML = `
    <header class="ss-header">
      <div class="ss-brand">
        ${s.logo_url
          ? `<img src="${esc(s.logo_url)}" alt="${esc(s.store_name)}" class="ss-logo-img">`
          : `<div class="ss-logo-badge">${esc(s.store_name.charAt(0).toUpperCase())}</div>`}
        <div class="ss-brand-text">
          <div class="ss-store-label">SimaStore</div>
          <div class="ss-store-title">${esc(s.store_name)}</div>
          ${s.tagline ? `<div class="ss-tagline">${esc(s.tagline)}</div>` : ''}
        </div>
      </div>
      ${contactBtns ? `<div class="ss-contacts">${contactBtns}</div>` : ''}
    </header>

    ${banners.length ? `<div class="ssc-root" id="ssc-root"></div>` : ''}

    <div class="ss-wrap">
      <div class="ss-toolbar">
        <div class="ss-search-wrap">
          <svg class="ss-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="ss-search" id="ssp-search" type="search" placeholder="Поиск товаров…">
        </div>
        <div class="ss-tabs">
          <button class="ss-tab active" data-src="all">Все <span class="ss-tab-cnt">${groups.length}</span></button>
          ${hasSrc('wb')     ? `<button class="ss-tab" data-src="wb">WB</button>`       : ''}
          ${hasSrc('ozon')   ? `<button class="ss-tab" data-src="ozon">Ozon</button>`   : ''}
          ${hasSrc('yandex') ? `<button class="ss-tab" data-src="yandex">Яндекс</button>` : ''}
        </div>
      </div>

      ${renderFilters(groups, filters, s)}

      <div id="ssp-content">${renderGroupSections(groups, storefrontGroups, showStock, variantMap)}</div>

      <footer class="ss-footer">Powered by <a href="/" target="_blank">SimaDesk</a></footer>
    </div>`;

  if (banners.length) {
    const carouselEl = document.getElementById('ssc-root');
    if (carouselEl) new BannerCarousel(carouselEl, banners);
  }

  function refresh() {
    const active = filterGroups(groups, filters);
    const content = document.getElementById('ssp-content')!;

    if (hasAnyFilter()) {
      content.innerHTML = renderFlatGrid(active, showStock, variantMap);
    } else {
      content.innerHTML = renderGroupSections(groups, storefrontGroups, showStock, variantMap);
    }
    bindCards();
    // Refresh filter panel to update chip states / reset button
    const filtersEl = document.getElementById('ss-filters');
    if (filtersEl) filtersEl.outerHTML = renderFilters(groups, filters, s);
    bindFilters();
  }

  function bindCards() {
    document.querySelectorAll('.ssp-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const varBtn = (e.target as HTMLElement).closest('.ssp-var-btn') as HTMLElement|null;
        if (varBtn) {
          e.stopPropagation();
          if (varBtn.hasAttribute('disabled')) return;
          const targetKey = varBtn.dataset.varKey!;
          const g = groups.find(x => x.key === targetKey);
          if (g) openProductModal(g);
          return;
        }
        const key = (card as HTMLElement).dataset.key!;
        const g   = groups.find(x => x.key === key);
        if (g) openProductModal(g);
      });
    });
  }

  function bindFilters() {
    document.getElementById('sf-pmin')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value;
      filters.priceMin = v ? Number(v) : null;
      refresh();
    });
    document.getElementById('sf-pmax')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value;
      filters.priceMax = v ? Number(v) : null;
      refresh();
    });
    document.querySelectorAll('[data-brand]').forEach(btn => {
      btn.addEventListener('click', () => {
        const b = (btn as HTMLElement).dataset.brand!;
        filters.brand = filters.brand === b ? '' : b;
        refresh();
      });
    });
    document.querySelectorAll('[data-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = (btn as HTMLElement).dataset.cat!;
        filters.category = filters.category === c ? '' : c;
        refresh();
      });
    });
    document.getElementById('sf-reset')?.addEventListener('click', () => {
      filters.priceMin = null; filters.priceMax = null;
      filters.brand = ''; filters.category = '';
      refresh();
    });
  }

  document.getElementById('ssp-search')?.addEventListener('input', (e) => {
    filters.query = (e.target as HTMLInputElement).value;
    refresh();
  });

  document.querySelectorAll('.ss-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ss-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filters.source = (btn as HTMLElement).dataset.src ?? 'all';
      refresh();
    });
  });

  bindFilters();
  bindCards();
}
