import type { StorefrontProduct } from '../services/storefrontDb';

const API_URL = import.meta.env.VITE_API_URL as string;
const API_KEY = import.meta.env.VITE_API_KEY as string;
const REST_URL = `${API_URL}/rest/v1`;

const SOURCE_LABELS: Record<string, string> = { wb: 'WB', ozon: 'OZON', yandex: 'Яндекс' };
const SOURCE_MARKET_LABELS: Record<string, string> = {
  wb: 'Купить на WB',
  ozon: 'Купить на Ozon',
  yandex: 'Яндекс Маркет',
};

function buildBuyUrl(source: string, sourceId: string): string {
  if (source === 'wb')     return `https://www.wildberries.ru/catalog/${sourceId}/detail.aspx`;
  if (source === 'ozon')   return `https://www.ozon.ru/product/${sourceId}/`;
  if (source === 'yandex') return `https://market.yandex.ru/product/${sourceId}`;
  return '#';
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function card(p: StorefrontProduct): string {
  const stockBadge = p.stock > 0
    ? `<div class="ss-card-stock">В наличии</div>`
    : `<div class="ss-card-stock out">Нет</div>`;

  const img = p.image
    ? `<img src="${p.image}" alt="${escHtml(p.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const placeholder = `<div class="ss-img-placeholder" style="${p.image ? 'display:none' : ''}">📦</div>`;

  const priceRow = p.discount > 0
    ? `<div class="ss-price-row">
        <span class="ss-price">${fmt(p.price)}</span>
        <span class="ss-price-old">${fmt(p.original_price)}</span>
        <span class="ss-badge-discount">-${p.discount}%</span>
       </div>`
    : `<div class="ss-price-row"><span class="ss-price">${fmt(p.price)}</span></div>`;

  const customBtn = p.custom_url
    ? `<a href="${escHtml(p.custom_url)}" class="ss-buy-btn site" target="_blank" rel="noopener">На сайте магазина →</a>`
    : '';

  const marketBtn = `<a href="${buildBuyUrl(p.source, p.source_id)}" class="ss-buy-btn ${p.source}" target="_blank" rel="noopener">${SOURCE_MARKET_LABELS[p.source]}</a>`;

  const brand = p.brand ? `<div class="ss-card-brand">${escHtml(p.brand)}</div>` : '';

  return `
<div class="ss-card" data-source="${p.source}" data-title="${escHtml(p.title.toLowerCase())}">
  <div class="ss-card-img">
    ${img}${placeholder}
    <div class="ss-card-source ${p.source}">${SOURCE_LABELS[p.source]}</div>
    ${stockBadge}
  </div>
  <div class="ss-card-body">
    <div class="ss-card-title">${escHtml(p.title)}</div>
    ${brand}
    ${priceRow}
    <div class="ss-card-actions">
      ${customBtn || marketBtn}
    </div>
  </div>
</div>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderGrid(products: StorefrontProduct[], query: string, source: string): string {
  const q = query.toLowerCase().trim();
  const filtered = products.filter(p => {
    const matchSrc  = source === 'all' || p.source === source;
    const matchText = !q || p.title.toLowerCase().includes(q) || p.vendor_code.toLowerCase().includes(q);
    return matchSrc && matchText;
  });

  if (filtered.length === 0) {
    return `<div class="ss-state">
      <div class="ss-state-icon">🔍</div>
      <div class="ss-state-title">Ничего не найдено</div>
      <div class="ss-state-sub">Попробуйте изменить запрос или сбросить фильтр</div>
    </div>`;
  }

  return filtered.map(card).join('');
}

export async function renderPublicStorefront(slug: string): Promise<void> {
  const app = document.getElementById('simastore-public')!;
  app.style.display = 'block';

  app.innerHTML = `
    <div class="ss-wrap">
      <div class="ss-state" style="min-height:80vh">
        <div class="ss-spinner"></div>
        <div class="ss-state-sub">Загружаем магазин…</div>
      </div>
    </div>`;

  let data: any;
  try {
    const res = await fetch(`${REST_URL}/rpc/get_storefront`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ p_slug: slug }),
    });
    data = await res.json();
  } catch {
    data = { error: 'network' };
  }

  if (data?.error) {
    app.innerHTML = `
      <div class="ss-wrap">
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
    store_name: string; tagline: string;
    telegram: string; whatsapp: string; website: string; slug: string;
    logo_url?: string | null;
  };
  const products: StorefrontProduct[] = data.products ?? [];

  document.title = s.store_name;

  const contactBtns = [
    s.telegram ? `<a href="https://t.me/${s.telegram.replace(/^@/, '')}" class="ss-contact-btn tg" target="_blank" rel="noopener">✈ Telegram</a>` : '',
    s.whatsapp  ? `<a href="https://wa.me/${s.whatsapp.replace(/\D/g, '')}" class="ss-contact-btn wa" target="_blank" rel="noopener">💬 WhatsApp</a>` : '',
    s.website   ? `<a href="${escHtml(s.website.startsWith('http') ? s.website : 'https://' + s.website)}" class="ss-contact-btn web" target="_blank" rel="noopener">🌐 Сайт</a>` : '',
  ].filter(Boolean).join('');

  const hasSrc = (src: string) => products.some(p => p.source === src);

  app.innerHTML = `
    <div class="ss-wrap">
      <header class="ss-header">
        <div class="ss-brand">
          ${s.logo_url
            ? `<img src="${escHtml(s.logo_url)}" alt="${escHtml(s.store_name)}" class="ss-logo-img">`
            : `<div class="ss-logo-badge">${escHtml(s.store_name.charAt(0).toUpperCase())}</div>`}
          <div class="ss-brand-text">
            <div class="ss-store-title">${escHtml(s.store_name)}</div>
            ${s.tagline ? `<div class="ss-tagline">${escHtml(s.tagline)}</div>` : ''}
          </div>
        </div>
        ${contactBtns ? `<div class="ss-contacts">${contactBtns}</div>` : ''}
      </header>

      <div class="ss-divider"></div>

      <div class="ss-toolbar">
        <input class="ss-search" id="ss-search" type="search" placeholder="Поиск товаров…">
        <div class="ss-tabs">
          <button class="ss-tab active" data-src="all">Все</button>
          ${hasSrc('wb')     ? `<button class="ss-tab" data-src="wb">WB</button>` : ''}
          ${hasSrc('ozon')   ? `<button class="ss-tab" data-src="ozon">Ozon</button>` : ''}
          ${hasSrc('yandex') ? `<button class="ss-tab" data-src="yandex">Яндекс</button>` : ''}
        </div>
        <div class="ss-count" id="ss-count">${products.length} товаров</div>
      </div>

      <div class="ss-grid" id="ss-grid">
        ${renderGrid(products, '', 'all')}
      </div>

      <footer class="ss-footer">
        Powered by <a href="/" target="_blank">SimaDesk</a>
      </footer>
    </div>`;

  let currentSrc = 'all';
  let currentQ   = '';

  function refresh() {
    const q = (document.getElementById('ss-search') as HTMLInputElement)?.value ?? '';
    currentQ = q;
    const grid = document.getElementById('ss-grid')!;
    grid.innerHTML = renderGrid(products, currentQ, currentSrc);
    const countEl = document.getElementById('ss-count')!;
    const visible = products.filter(p => {
      const matchSrc  = currentSrc === 'all' || p.source === currentSrc;
      const matchText = !currentQ.trim() || p.title.toLowerCase().includes(currentQ.toLowerCase()) || p.vendor_code.toLowerCase().includes(currentQ.toLowerCase());
      return matchSrc && matchText;
    }).length;
    countEl.textContent = `${visible} товаров`;
  }

  document.getElementById('ss-search')!.addEventListener('input', refresh);

  app.querySelectorAll('.ss-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      app.querySelectorAll('.ss-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSrc = (btn as HTMLElement).dataset.src ?? 'all';
      refresh();
    });
  });
}
