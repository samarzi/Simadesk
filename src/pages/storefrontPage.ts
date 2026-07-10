import type { StorefrontProduct, StorefrontBanner } from '../services/storefrontDb';

const API_URL = import.meta.env.VITE_API_URL as string;
const API_KEY = import.meta.env.VITE_API_KEY as string;
const REST_URL = `${API_URL}/rest/v1`;

const MP_LABEL: Record<string, string> = { wb: 'Wildberries', ozon: 'Ozon', yandex: 'Яндекс Маркет' };

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
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
  image: string | null;
  minPrice: number;
  maxPrice: number;
  variants: StorefrontProduct[];  // one per source, best price wins
  customUrl: string;
  customPrice: number | null;
}

function groupProducts(all: StorefrontProduct[]): ProductGroup[] {
  const visible = all.filter(p => !p.is_hidden);

  // Group by vendor_code
  const byKey = new Map<string, StorefrontProduct[]>();
  for (const p of visible) {
    const key = p.vendor_code.trim().toLowerCase() || `__${p.source}:${p.source_id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(p);
  }

  const groups: ProductGroup[] = [];
  for (const [key, items] of byKey) {
    // 1 артикул = 1 маркетплейс: для каждого source берём товар с наилучшей ценой
    const bestPerSource = new Map<string, StorefrontProduct>();
    for (const p of items) {
      const price = p.custom_price ?? p.price;
      const cur = bestPerSource.get(p.source);
      if (!cur || price < (cur.custom_price ?? cur.price)) bestPerSource.set(p.source, p);
    }
    const variants = [...bestPerSource.values()];

    // Лучшее изображение — от варианта с наибольшим количеством фоток
    const withMostImages = variants.reduce((best, p) =>
      p.images.length > best.images.length ? p : best, variants[0]);
    const image = withMostImages.images[0] ?? null;

    // Диапазон цен
    const prices = variants.map(p => p.custom_price ?? p.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    // Лучший заголовок — самый длинный
    const title = variants.reduce((best, p) => p.title.length > best.length ? p.title : best, '');
    const brand = variants.find(p => p.brand)?.brand ?? '';

    // custom_url — берём из любого варианта
    const withCustomUrl = variants.find(p => p.custom_url);
    const customUrl = withCustomUrl?.custom_url ?? '';
    const customPrice = withCustomUrl?.custom_price ?? null;

    groups.push({ key, title, brand, image, minPrice, maxPrice, variants, customUrl, customPrice });
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
    const b = this.banners;
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
    const b = this.banners;
    const pi = this.prev(this.idx);
    const ni = this.next(this.idx);

    const prevEl  = this.el.querySelector('.ssc-prev .ssc-side-img img') as HTMLImageElement|null;
    const nextEl  = this.el.querySelector('.ssc-next .ssc-side-img img') as HTMLImageElement|null;
    const mainImg = this.el.querySelector('.ssc-main img') as HTMLImageElement|null;
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
    if (mainWrap) {
      if (b[this.idx].link_url && b[this.idx].link_url !== '/') {
        (mainWrap as HTMLAnchorElement).href = b[this.idx].link_url;
      }
    }

    this.el.querySelectorAll('.ssc-dot').forEach((d, i) =>
      d.classList.toggle('on', i === this.idx));
  }

  private bind() {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const side = t.closest('[data-go]') as HTMLElement|null;
      if (side) { side.dataset.go === 'prev' ? this.goPrev() : this.goNext(); return; }
      const dot = t.closest('[data-dot]') as HTMLElement|null;
      if (dot) { this.go(Number(dot.dataset.dot)); return; }
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

function renderCard(g: ProductGroup): string {
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

  return `<div class="ssp-card" data-key="${esc(g.key)}">
    <div class="ssp-img">
      ${img}${placeholder}
      <div class="ssp-src-badges">${srcBadges}</div>
    </div>
    <div class="ssp-body">
      ${g.brand ? `<div class="ssp-brand">${esc(g.brand)}</div>` : ''}
      <div class="ssp-title">${esc(g.title)}</div>
      <div class="ssp-price">${esc(priceStr)}</div>
      <button class="ssp-buy-btn" type="button">Купить</button>
    </div>
  </div>`;
}

/* ── Product modal ─────────────────────────────────────────────────────────── */

function openProductModal(g: ProductGroup) {
  const existing = document.getElementById('ssp-modal');
  if (existing) existing.remove();

  const priceStr = g.minPrice === g.maxPrice
    ? fmt(g.minPrice)
    : `${fmt(g.minPrice)} – ${fmt(g.maxPrice)}`;

  const mpButtons = g.variants.map(v => {
    const url = buildBuyUrl(v);
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
  div.id = 'ssp-modal';
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
      <div class="ssp-mp-list">
        ${mpButtons}
        ${websiteBtn}
      </div>
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
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  requestAnimationFrame(() => div.classList.add('open'));
}

/* ── Grid render ───────────────────────────────────────────────────────────── */

function renderGrid(groups: ProductGroup[], query: string, source: string): string {
  const q = query.toLowerCase().trim();
  const filtered = groups.filter(g => {
    if (source !== 'all' && !g.variants.some(v => v.source === source)) return false;
    if (q && !g.title.toLowerCase().includes(q) && !g.key.includes(q)) return false;
    return true;
  });

  if (!filtered.length) return `<div class="ssp-empty">
    <div class="ssp-empty-ico">🔍</div>
    <div class="ssp-empty-title">Ничего не найдено</div>
    <div class="ssp-empty-sub">Попробуйте изменить запрос или сбросить фильтр</div>
  </div>`;

  return filtered.map(renderCard).join('');
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

  if (data?.error) {
    app.innerHTML = `<div class="ss-wrap">
      <div class="ss-state" style="min-height:80vh">
        <div class="ss-state-icon">🏪</div>
        <div class="ss-state-title">Магазин не найден</div>
        <div class="ss-state-sub">Проверьте адрес или попросите владельца магазина поделиться правильной ссылкой</div>
      </div>
    </div>`;
    document.title = 'SimaStore — магазин не найден';
    return;
  }

  const s = data.settings as {
    store_name:string; tagline:string;
    telegram:string; whatsapp:string; website:string; slug:string; logo_url?:string|null;
  };
  const rawProducts: StorefrontProduct[] = data.products ?? [];
  const banners: StorefrontBanner[] = (data.banners ?? []).filter((b: StorefrontBanner) => b.is_active);
  const groups = groupProducts(rawProducts);

  document.title = s.store_name;

  const contactBtns = [
    s.telegram ? `<a href="https://t.me/${s.telegram.replace(/^@/,'')}" class="ss-contact-btn tg" target="_blank" rel="noopener">✈ Telegram</a>` : '',
    s.whatsapp  ? `<a href="https://wa.me/${s.whatsapp.replace(/\D/g,'')}" class="ss-contact-btn wa" target="_blank" rel="noopener">💬 WhatsApp</a>` : '',
    s.website   ? `<a href="${esc(s.website.startsWith('http')?s.website:'https://'+s.website)}" class="ss-contact-btn web" target="_blank" rel="noopener">🌐 Сайт</a>` : '',
  ].filter(Boolean).join('');

  const sources = [...new Set(rawProducts.map(p => p.source))];
  const hasSrc = (src: string) => sources.includes(src as any);

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
          ${hasSrc('wb')     ? `<button class="ss-tab" data-src="wb">WB</button>` : ''}
          ${hasSrc('ozon')   ? `<button class="ss-tab" data-src="ozon">Ozon</button>` : ''}
          ${hasSrc('yandex') ? `<button class="ss-tab" data-src="yandex">Яндекс</button>` : ''}
        </div>
      </div>

      <div class="ssp-grid" id="ssp-grid">${renderGrid(groups, '', 'all')}</div>

      <footer class="ss-footer">Powered by <a href="/" target="_blank">SimaDesk</a></footer>
    </div>`;

  // Инициализируем карусель
  const carouselEl = document.getElementById('ssc-root');
  if (carouselEl && banners.length) new BannerCarousel(carouselEl, banners);

  // Поиск и фильтр
  let currentSrc = 'all';
  let currentQ   = '';

  function refresh() {
    document.getElementById('ssp-grid')!.innerHTML = renderGrid(groups, currentQ, currentSrc);
    bindCards();
  }

  function bindCards() {
    document.querySelectorAll('.ssp-card').forEach(card => {
      card.addEventListener('click', () => {
        const key = (card as HTMLElement).dataset.key!;
        const g = groups.find(x => x.key === key);
        if (g) openProductModal(g);
      });
    });
  }

  document.getElementById('ssp-search')?.addEventListener('input', (e) => {
    currentQ = (e.target as HTMLInputElement).value;
    refresh();
  });

  document.querySelectorAll('.ss-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ss-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSrc = (btn as HTMLElement).dataset.src ?? 'all';
      refresh();
    });
  });

  bindCards();
}
