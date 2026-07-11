const API_URL = import.meta.env.VITE_API_URL as string;
const API_KEY = import.meta.env.VITE_API_KEY as string;
const REST_URL = `${API_URL}/rest/v1`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Settings {
  store_name: string;
  description?: string;
  logo_url?: string;
  telegram?: string;
  whatsapp?: string;
  phone?: string;
  website?: string;
}
interface Product {
  source: string;
  source_id: string;
  market_model_id?: string;
  ozon_sku?: string;
  title: string;
  price: number;
  original_price: number;
  discount: number;
  images: string[];
  image_url?: string;
  vendor_code?: string;
  brand?: string;
  description?: string;
  custom_url?: string;
  custom_price?: number;
}
interface GroupedProduct {
  key: string;
  vendor_code: string;
  title: string;
  images: string[];
  brand?: string;
  description?: string;
  price_min: number;
  price_max: number;
  entries: Product[]; // sorted cheapest first
}
interface Banner { id: number; title?: string; image_url: string; link_url?: string; }
interface StoreData { settings: Settings; products: Product[]; banners: Banner[]; }

// ─── Constants ────────────────────────────────────────────────────────────────

const BADGE: Record<string,string>    = { wb:'WB', ozon:'Ozon', yandex:'Яндекс' };
const BADGE_BG: Record<string,string> = { wb:'rgba(203,73,167,.9)', ozon:'rgba(0,91,255,.9)', yandex:'rgba(255,172,0,.9)' };
const BUY_LABEL: Record<string,string>= { wb:'Купить на WB', ozon:'Купить на Ozon', yandex:'Купить на Яндекс' };
const PRICE_GRAD = 'background:linear-gradient(to right,#00FFCC,#00CCAA);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(n: number): string {
  return new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(n ?? 0);
}
function fmtRange(min: number, max: number): string {
  return min === max ? fmt(min) : `${fmt(min)} — ${fmt(max)}`;
}
function getImages(p: Product): string[] {
  if (Array.isArray(p.images) && p.images.length) {
    const filtered = p.images.filter(Boolean);
    if (filtered.length) return filtered;
  }
  if (p.image_url) return [p.image_url];
  return [];
}
function buildEntryUrl(p: Product): string {
  if (p.source === 'wb') return `https://www.wildberries.ru/catalog/${p.source_id}/detail.aspx`;
  if (p.source === 'ozon') return `https://www.ozon.ru/product/${p.ozon_sku ?? p.source_id}/`;
  if (p.source === 'yandex') {
    if (p.market_model_id) return `https://market.yandex.ru/product/${p.market_model_id}?sku=${p.source_id}`;
    return `https://market.yandex.ru/search?text=${encodeURIComponent(p.title ?? '')}`;
  }
  return '#';
}
function groupProducts(products: Product[]): GroupedProduct[] {
  const map = new Map<string, GroupedProduct>();
  for (const p of products) {
    const effectivePrice = p.custom_price != null ? p.custom_price : p.price;
    if (effectivePrice <= 0) continue;
    const vc = (p.vendor_code ?? '').trim().toLowerCase();
    const key = vc ? `v:${vc}` : `s:${p.source}:${p.source_id}`;
    const imgs = getImages(p);
    if (!map.has(key)) {
      map.set(key, {
        key, vendor_code: vc, title: p.title,
        images: imgs, brand: p.brand, description: p.description,
        price_min: p.price, price_max: p.price, entries: [p],
      });
    } else {
      const g = map.get(key)!;
      g.entries.push(p);
      g.price_min = Math.min(g.price_min, p.price);
      g.price_max = Math.max(g.price_max, p.price);
      if (imgs.length > g.images.length) {
        g.images = imgs; g.title = p.title;
        g.brand = p.brand; g.description = p.description;
      }
    }
  }
  for (const g of map.values()) g.entries.sort((a, b) => a.price - b.price);
  return Array.from(map.values());
}

// ─── CSS injection ────────────────────────────────────────────────────────────

function injectCSS(): void {
  const el = document.createElement('style');
  el.textContent = `
@keyframes ss-spin { to { transform: rotate(360deg); } }
@keyframes ss-shimmer { 0%,100%{opacity:.5} 50%{opacity:1} }
@keyframes ss-fadein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
@keyframes slideInScale { from{opacity:0;transform:translateY(30px) scale(.9)} to{opacity:1;transform:none} }
@keyframes slideInLeft  { from{opacity:0;transform:translateX(-20px)} to{opacity:1;transform:none} }
@keyframes ss-brand-shimmer {
  0%   { background-position:0% 50%; }
  50%  { background-position:100% 50%; }
  100% { background-position:0% 50%; }
}
.ss-header-brand {
  font-weight:800;
  background:linear-gradient(90deg,#00FFCC,#00CCAA,#7FFFD4,#00CED1,#00FFCC);
  background-size:300% 300%;
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  animation:ss-brand-shimmer 5s ease infinite;
  letter-spacing:.04em;
}

/* ── Banner carousel ── */
.ss-banner-grid { display:grid; grid-template-columns:1fr; gap:1rem; margin-bottom:.5rem; }
@media(min-width:1024px) { .ss-banner-grid { grid-template-columns:1fr 2fr 1fr; } }
.ss-banner-side {
  display:none; border-radius:1rem; overflow:hidden; height:320px;
  position:relative; cursor:pointer; flex-shrink:0;
}
@media(min-width:1024px) { .ss-banner-side { display:block; } }
.ss-banner-side img { width:100%;height:100%;object-fit:cover;display:block; }
.ss-banner-side-ov { position:absolute;inset:0;background:rgba(0,0,0,.4);border-radius:1rem;transition:background .25s; }
.ss-banner-side:hover .ss-banner-side-ov { background:rgba(0,0,0,.2); }
.ss-banner-main { display:block;border-radius:1rem;overflow:hidden;height:200px;transition:opacity .3s; }
@media(min-width:640px) { .ss-banner-main { height:280px; } }
@media(min-width:1024px) { .ss-banner-main { height:320px; } }
.ss-banner-main img { width:100%;height:100%;object-fit:cover;display:block; }
.ss-ban-dots { display:flex;justify-content:center;gap:.5rem;margin-top:.75rem; }
@media(min-width:1024px) { .ss-ban-dots { display:none; } }
.ss-car-dot { width:8px;height:8px;border-radius:50%;background:hsl(var(--muted-foreground)/.3);border:none;cursor:pointer;padding:0;transition:all .2s; }
.ss-car-dot.active { background:hsl(var(--primary));transform:scale(1.25); }

.ss-skel { background:hsl(var(--muted)/.5); border-radius:.875rem; overflow:hidden; animation:ss-shimmer 1.4s ease-in-out infinite; }
.ss-skel-img  { aspect-ratio:3/4; background:hsl(var(--muted)/.7); }
.ss-skel-body { padding:.5rem; }
.ss-skel-line { height:.7rem; background:hsl(var(--muted-foreground)/.2); border-radius:.35rem; margin:.4rem 0; }

.ss-card {
  background:hsl(var(--card)); border:1px solid hsl(var(--border)/.6);
  border-radius:.875rem; overflow:hidden; cursor:pointer;
  transition:transform .2s, box-shadow .2s;
  position:relative;
}
.ss-card:hover { transform:translateY(-3px); box-shadow:0 12px 40px rgba(0,0,0,.4); }
.ss-card-img  { position:relative; aspect-ratio:3/4; background:hsl(var(--muted)/.3); overflow:hidden; }
.ss-card-img img { width:100%; height:100%; object-fit:cover; }
.ss-card-grad { position:absolute; inset:0; background:linear-gradient(to top,rgba(0,0,0,.6) 0%,rgba(0,0,0,.2) 40%,transparent 100%); pointer-events:none; }
.ss-card-body { padding:.5rem .625rem .375rem; }
.ss-card-title { font-size:.75rem; font-weight:700; line-height:1.3; color:hsl(var(--foreground)); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2em; }
.ss-card-price-row { display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; padding:.35rem 0 .25rem; }
.ss-card-buy { padding:.25rem .5rem 1px; }
.ss-card-buy-btn {
  display:flex; align-items:center; justify-content:center;
  width:100%; height:1.75rem; font-size:10px; font-weight:700;
  background:linear-gradient(135deg,#00FFCC,#00CCAA); color:#000;
  border-radius:.5rem; border:none; cursor:pointer;
}

.ss-catalog-btn {
  display:flex; align-items:center; justify-content:center; gap:.75rem;
  width:100%; padding:1.1rem; border-radius:1rem;
  background:linear-gradient(135deg,#00FFCC,#00CCAA);
  color:#000; font-size:1.1rem; font-weight:900;
  text-decoration:none; border:none; cursor:pointer;
  box-shadow:0 8px 32px rgba(0,255,204,.25);
  transition:transform .2s, box-shadow .2s;
}
.ss-catalog-btn:hover { transform:translateY(-2px); box-shadow:0 14px 40px rgba(0,255,204,.35); }
.ss-catalog-btn svg { transition:transform .2s; }
.ss-catalog-btn:hover svg { transform:translateX(4px); }

.ss-detail {
  position:fixed; inset:0; z-index:100;
  background:hsl(var(--background));
  overflow-y:auto; overflow-x:hidden;
  transform:translateX(100%);
  transition:transform .35s cubic-bezier(.25,.46,.45,.94);
  will-change:transform;
}
.ss-detail.open { transform:translateX(0); }
.ss-detail.animating { transition:none; }

.ss-swipe-ind {
  position:fixed; left:0; top:50%; transform:translateY(-50%); z-index:200;
  width:2.5rem; height:5rem;
  background:hsl(var(--primary)/.8); border-radius:0 3rem 3rem 0;
  display:flex; align-items:center; justify-content:center;
  color:#000; font-size:1.1rem; opacity:0; transition:opacity .2s; pointer-events:none;
}
.ss-swipe-ind.visible { opacity:1; }

.ss-det-hdr {
  position:sticky; top:0; z-index:10;
  display:flex; align-items:center; gap:.75rem; padding:.75rem 1rem;
  background:hsl(var(--background)/.95); backdrop-filter:blur(16px);
  border-bottom:1px solid hsl(var(--border)/.5);
}
.ss-back {
  display:flex; align-items:center; gap:.35rem;
  font-weight:700; font-size:.875rem;
  background:none; border:none; cursor:pointer;
  color:hsl(var(--primary)); padding:.4rem .6rem;
  border-radius:.5rem; transition:background .15s; flex-shrink:0;
}
.ss-back:hover { background:hsl(var(--primary)/.1); }

.ss-gal { position:relative; }
.ss-gal-main {
  display:flex; overflow-x:auto; scroll-snap-type:x mandatory;
  scroll-behavior:smooth; -webkit-overflow-scrolling:touch;
  aspect-ratio:3/4; border-radius:1rem; overflow:hidden;
}
.ss-gal-main::-webkit-scrollbar { display:none; }
.ss-gal-slide { flex:0 0 100%; scroll-snap-align:start; }
.ss-gal-slide img { width:100%; height:100%; object-fit:contain; background:hsl(var(--muted)/.3); }
.ss-gal-dots { display:flex; justify-content:center; gap:.35rem; margin-top:.5rem; }
.ss-gal-dot { width:5px; height:5px; border-radius:50%; background:hsl(var(--foreground)/.2); transition:background .2s,transform .2s; cursor:pointer; border:none; padding:0; }
.ss-gal-dot.active { background:hsl(var(--primary)); transform:scale(1.4); }
.ss-gal-thumbs { display:none; gap:.4rem; margin-top:.5rem; overflow-x:auto; }
.ss-gal-thumbs::-webkit-scrollbar { display:none; }
@media (min-width:640px) { .ss-gal-thumbs{display:flex;} .ss-gal-dots{display:none;} }
.ss-gal-thumb { flex:0 0 4rem; height:4rem; border-radius:.5rem; overflow:hidden; cursor:pointer; border:2px solid transparent; transition:border-color .15s; background:hsl(var(--muted)/.3); }
.ss-gal-thumb.active { border-color:hsl(var(--primary)); }
.ss-gal-thumb img { width:100%; height:100%; object-fit:cover; }

.ss-det-body { padding:1rem 1rem 7rem; }
@media (min-width:1024px) {
  .ss-det-body { padding:1.5rem 2rem 5rem; }
  .ss-det-layout { display:grid; grid-template-columns:300px 1fr; gap:2rem; align-items:start; }
}
@media (min-width:1280px) { .ss-det-layout{grid-template-columns:400px 1fr;} }
.ss-det-title { font-size:1.25rem; font-weight:800; line-height:1.3; margin-bottom:.75rem; color:hsl(var(--foreground)); }
@media (min-width:640px) { .ss-det-title{font-size:1.5rem;} }
.ss-price-big { font-size:2rem; font-weight:900; background:linear-gradient(to right,#00FFCC,#00CCAA); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
.ss-price-row { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; margin-bottom:1rem; }
.ss-price-old  { font-size:1rem; text-decoration:line-through; opacity:.4; }
.ss-price-disc { font-size:.8rem; font-weight:800; color:#f87171; background:hsl(0 72% 51%/.12); border:1px solid hsl(0 72% 51%/.2); padding:.15rem .4rem; border-radius:.35rem; }
.ss-meta { display:flex; flex-direction:column; gap:.4rem; margin-bottom:1rem; }
.ss-meta-row { font-size:.8rem; color:hsl(var(--muted-foreground)); }
.ss-meta-row span { color:hsl(var(--foreground)); font-weight:600; }
.ss-buy-col { display:flex; flex-direction:column; gap:.6rem; margin-bottom:1.5rem; }
.ss-btn-pri {
  display:flex; align-items:center; justify-content:center; gap:.5rem;
  padding:.9rem 1.5rem; border-radius:.875rem; font-weight:800; font-size:.95rem;
  text-decoration:none; color:#000;
  background:linear-gradient(135deg,#00FFCC,#00CCAA);
  box-shadow:0 6px 20px hsl(var(--primary)/.3);
  transition:transform .15s,opacity .15s; border:none; cursor:pointer;
}
.ss-btn-pri:hover { opacity:.9; transform:translateY(-1px); }
.ss-btn-sec {
  display:flex; align-items:center; justify-content:center; gap:.5rem;
  padding:.75rem 1.5rem; border-radius:.875rem; font-weight:700; font-size:.875rem;
  text-decoration:none; color:hsl(var(--foreground));
  background:hsl(var(--secondary)); border:1.5px solid hsl(var(--border)); transition:background .15s; cursor:pointer;
}
.ss-btn-sec:hover { background:hsl(var(--accent)); }
.ss-tabs-bar { display:flex; border-bottom:1px solid hsl(var(--border)/.5); margin-bottom:1rem; }
.ss-tab-btn { padding:.6rem 1rem; font-size:.875rem; font-weight:600; border:none; background:none; cursor:pointer; color:hsl(var(--muted-foreground)); border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .15s,border-color .15s; }
.ss-tab-btn.active { color:hsl(var(--primary)); border-bottom-color:hsl(var(--primary)); }
.ss-tab-pane { display:none; }
.ss-tab-pane.active { display:block; }
.ss-tab-pane p { font-size:.875rem; line-height:1.7; color:hsl(var(--muted-foreground)); white-space:pre-wrap; }
.ss-mobile-bar {
  position:fixed; bottom:0; left:0; right:0; z-index:50;
  background:hsl(var(--background)/.95); backdrop-filter:blur(16px);
  border-top:1px solid hsl(var(--border)/.5);
  padding:.75rem 1rem env(safe-area-inset-bottom,.5rem);
  display:flex; gap:.5rem;
}
@media (min-width:1024px) { .ss-mobile-bar{display:none;} .ss-buy-col{display:flex;} }

.ss-search {
  width:100%; padding:.75rem 1rem .75rem 2.5rem;
  background:hsl(var(--muted)/.5); border:1px solid hsl(var(--border)/.6);
  border-radius:.875rem; color:hsl(var(--foreground)); font-size:.875rem; outline:none;
  transition:border-color .15s;
}
.ss-search:focus { border-color:hsl(var(--primary)/.5); }
.ss-search::placeholder { color:hsl(var(--muted-foreground)); }

.ss-src-tab {
  flex:1; height:2.5rem; font-size:.875rem; font-weight:600;
  border:none; background:none; cursor:pointer;
  color:hsl(var(--muted-foreground)); border-radius:.875rem;
  transition:background .15s,color .15s;
}
.ss-src-tab.active { background:hsl(var(--background)); color:hsl(var(--primary)); box-shadow:0 1px 4px rgba(0,0,0,.3); }

.ss-grid {
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:.5rem;
}
@media (min-width:640px)  { .ss-grid{grid-template-columns:repeat(3,1fr);gap:.625rem;} }
@media (min-width:768px)  { .ss-grid{grid-template-columns:repeat(4,1fr);} }
@media (min-width:1024px) { .ss-grid{grid-template-columns:repeat(5,1fr);gap:.75rem;} }
@media (min-width:1280px) { .ss-grid{grid-template-columns:repeat(6,1fr);} }

.ss-contact {
  display:inline-flex; align-items:center; gap:.35rem;
  padding:.3rem .75rem; border-radius:999px; font-size:.75rem; font-weight:700;
  text-decoration:none; transition:opacity .15s;
}
.ss-contact:hover { opacity:.85; }

.ss-hiw { position:relative; padding:2.5rem 0; overflow:hidden; }
.ss-hiw-bg1 { position:absolute; top:2rem; left:2rem; width:8rem; height:8rem; background:hsl(var(--primary)/.05); border-radius:50%; filter:blur(3rem); }
.ss-hiw-bg2 { position:absolute; bottom:2rem; right:2rem; width:10rem; height:10rem; background:rgba(168,85,247,.05); border-radius:50%; filter:blur(3rem); }
.ss-hiw-badge { display:inline-flex; align-items:center; gap:.5rem; padding:.375rem 1rem; border-radius:999px; background:hsl(var(--primary)/.1); color:hsl(var(--primary)); font-size:.8rem; font-weight:600; margin-bottom:1rem; }
.ss-hiw-title { font-size:clamp(1.5rem,4vw,2rem); font-weight:900; margin-bottom:.5rem; background:linear-gradient(to right,hsl(var(--foreground)),hsl(var(--foreground)/.7)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
.ss-hiw-sub { font-size:.875rem; color:hsl(var(--muted-foreground)); margin-bottom:2rem; }
.ss-hiw-steps { display:none; }
@media (min-width:640px) { .ss-hiw-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;position:relative;} }
.ss-hiw-line { position:absolute; top:34px; left:12%; right:12%; height:2px; background:linear-gradient(to right,transparent,hsl(var(--primary)/.3),transparent); border-radius:1px; }
.ss-hiw-step-card { position:relative; padding:1rem; border-radius:1rem; text-align:center; }
.ss-hiw-step-card:hover { background:hsl(var(--muted)/.4); }
.ss-hiw-icon-wrap { width:56px; height:56px; margin:0 auto 1rem; border-radius:1rem; display:flex; align-items:center; justify-content:center; font-size:1.5rem; position:relative; }
.ss-hiw-num { position:absolute; top:-4px; right:-4px; width:1.4rem; height:1.4rem; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.65rem; font-weight:900; color:#fff; box-shadow:0 0 0 2px hsl(var(--background)); }
.ss-hiw-steps-mob { display:flex; flex-direction:column; gap:.625rem; max-width:28rem; margin:0 auto; }
@media (min-width:640px) { .ss-hiw-steps-mob{display:none;} }
.ss-hiw-mob-card { display:flex; align-items:center; gap:.75rem; padding:.75rem 1rem; border-radius:.875rem; }
.ss-hiw-mob-icon { flex-shrink:0; width:2.75rem; height:2.75rem; border-radius:.75rem; display:flex; align-items:center; justify-content:center; font-size:1.2rem; position:relative; }
.ss-hiw-mob-num { position:absolute; top:-3px; right:-3px; width:1.1rem; height:1.1rem; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.55rem; font-weight:900; color:#000; background:#00FFCC; box-shadow:0 0 0 2px hsl(var(--background)); }
.ss-hiw-connector { width:1px; height:.75rem; background:linear-gradient(to bottom,hsl(var(--primary)/.4),transparent); margin:.15rem auto; }
`;
  document.head.appendChild(el);
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchStoreData(slug: string): Promise<StoreData | null> {
  const res = await fetch(`${REST_URL}/rpc/get_storefront`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', apikey:API_KEY, Authorization:`Bearer ${API_KEY}` },
    body: JSON.stringify({ p_slug: slug }),
  });
  const json = await res.json();
  if (!json || json.error || !json.settings) return null;
  return json as StoreData;
}

// ─── Carousel ─────────────────────────────────────────────────────────────────

class Carousel {
  private idx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private el: HTMLElement, private banners: Banner[]) {
    this.mount();
    this.start();
  }

  private mount(): void {
    const { banners } = this;
    const n = banners.length;
    const cur = banners[0];
    const prevB = banners[(n-1)%n];
    const nextB = banners[1%n];
    const linkAttrs = (b: Banner) => b.link_url && b.link_url !== '#'
      ? `href="${esc(b.link_url)}" target="_blank" rel="noopener"`
      : `href="#" onclick="return false"`;

    this.el.innerHTML = `
<div class="ss-banner-grid">
  ${n > 1 ? `
  <div class="ss-banner-side" id="ss-ban-prev">
    <img id="ss-ban-prev-img" src="${esc(prevB.image_url)}" alt="" loading="lazy">
    <div class="ss-banner-side-ov"></div>
  </div>` : ''}
  <div${n === 1 ? ' style="grid-column:1/-1"' : ''}>
    <a ${linkAttrs(cur)} id="ss-ban-link" class="ss-banner-main">
      <img id="ss-ban-main-img" src="${esc(cur.image_url)}" alt="banner" loading="eager">
    </a>
  </div>
  ${n > 1 ? `
  <div class="ss-banner-side" id="ss-ban-next">
    <img id="ss-ban-next-img" src="${esc(nextB.image_url)}" alt="" loading="lazy">
    <div class="ss-banner-side-ov"></div>
  </div>` : ''}
</div>
${n > 1 ? `
<div class="ss-ban-dots">
  ${banners.map((_,i)=>`<button class="ss-car-dot${i===0?' active':''}" data-i="${i}"></button>`).join('')}
</div>` : ''}`;
    this.bindAll();
  }

  private bindAll(): void {
    const n = this.banners.length;
    if (n < 2) return;
    this.el.querySelector('#ss-ban-prev')?.addEventListener('click', () => this.go(this.idx-1));
    this.el.querySelector('#ss-ban-next')?.addEventListener('click', () => this.go(this.idx+1));
    this.el.querySelectorAll('.ss-car-dot').forEach(d => {
      d.addEventListener('click', () => this.go(parseInt((d as HTMLElement).dataset.i ?? '0', 10)));
    });
    const main = this.el.querySelector('.ss-banner-main') as HTMLElement|null;
    if (main) {
      let sx = 0;
      main.addEventListener('touchstart', (e:TouchEvent) => { sx = e.changedTouches[0].clientX; }, { passive:true });
      main.addEventListener('touchend',   (e:TouchEvent) => {
        const dx = e.changedTouches[0].clientX - sx;
        if (Math.abs(dx) > 40) this.go(this.idx + (dx < 0 ? 1 : -1));
      }, { passive:true });
    }
  }

  private go(idx: number): void {
    const n = this.banners.length;
    this.idx = ((idx % n) + n) % n;
    this.update();
    this.start();
  }

  private update(): void {
    const { banners, idx } = this;
    const n = banners.length;
    const cur = banners[idx];
    const prevB = banners[((idx-1)+n)%n];
    const nextB = banners[(idx+1)%n];
    const linkAttrs = (b: Banner) => b.link_url && b.link_url !== '#'
      ? `href="${esc(b.link_url)}" target="_blank" rel="noopener"` : `href="#"`;
    const mainImg = this.el.querySelector('#ss-ban-main-img') as HTMLImageElement|null;
    const mainLink = this.el.querySelector('#ss-ban-link') as HTMLAnchorElement|null;
    const prevImg = this.el.querySelector('#ss-ban-prev-img') as HTMLImageElement|null;
    const nextImg = this.el.querySelector('#ss-ban-next-img') as HTMLImageElement|null;
    if (mainImg) { mainLink?.setAttribute('href', cur.link_url||'#'); mainImg.src = cur.image_url; }
    if (prevImg) prevImg.src = prevB.image_url;
    if (nextImg) nextImg.src = nextB.image_url;
    this.el.querySelectorAll('.ss-car-dot').forEach((d,i) => d.classList.toggle('active', i===idx));
    void linkAttrs; // suppress unused warning
  }

  private start(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.banners.length > 1) {
      this.timer = setInterval(() => this.go(this.idx+1), 5000);
    }
  }

  destroy(): void { if (this.timer) clearInterval(this.timer); }
}

// ─── Product card HTML ────────────────────────────────────────────────────────

function renderCard(group: GroupedProduct): string {
  const img = group.images[0] ?? null;
  const priceStr = fmtRange(group.price_min, group.price_max);
  const srcKeys = [...new Set(group.entries.map(e => e.source))];
  const badgesHtml = srcKeys.map(src =>
    `<span style="background:${BADGE_BG[src]??'rgba(100,100,100,.85)'};color:#fff;padding:.12rem .35rem;border-radius:999px;font-size:9px;font-weight:700">${BADGE[src]??src}</span>`
  ).join('');

  return `
<div class="ss-card" data-key="${esc(group.key)}">
  <div class="ss-card-img">
    ${img
      ? `<img src="${esc(img)}" alt="${esc(group.title)}" loading="lazy">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:hsl(var(--foreground)/.15)"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>`}
    <div class="ss-card-grad"></div>
    <div style="position:absolute;top:.4rem;right:.4rem;display:flex;flex-direction:column;gap:.2rem;align-items:flex-end">${badgesHtml}</div>
  </div>
  <div class="ss-card-body">
    <div class="ss-card-title">${esc(group.title)}</div>
    <div class="ss-card-price-row">
      <span style="${PRICE_GRAD};font-size:.9rem;font-weight:900">${priceStr}</span>
    </div>
  </div>
  <div class="ss-card-buy">
    <div class="ss-card-buy-btn">Купить</div>
  </div>
</div>`;
}

function renderSkeletons(n = 12): string {
  return Array.from({length:n}, () => `
<div class="ss-skel">
  <div class="ss-skel-img"></div>
  <div class="ss-skel-body">
    <div class="ss-skel-line" style="width:90%"></div>
    <div class="ss-skel-line" style="width:65%"></div>
    <div class="ss-skel-line" style="width:50%;height:.8rem"></div>
  </div>
</div>`).join('');
}

// ─── Shared header ────────────────────────────────────────────────────────────

function headerHtml(s: Settings, showBack: boolean, backLabel = 'Назад'): string {
  const contacts = [
    s.telegram ? `<a href="https://t.me/${esc(s.telegram.replace(/^@/,''))}" target="_blank" rel="noopener" class="ss-contact" style="color:rgb(38,160,218);background:rgba(38,160,218,.12);border:1px solid rgba(38,160,218,.25)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Telegram</a>` : '',
    s.whatsapp  ? `<a href="https://wa.me/${esc(s.whatsapp.replace(/\D/g,''))}" target="_blank" rel="noopener" class="ss-contact" style="color:rgb(37,211,102);background:rgba(37,211,102,.12);border:1px solid rgba(37,211,102,.25)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> WhatsApp</a>` : '',
    s.phone     ? `<a href="tel:${esc(s.phone.replace(/\s/g,''))}" class="ss-contact" style="color:rgb(99,179,120);background:rgba(99,179,120,.12);border:1px solid rgba(99,179,120,.25)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8 19.79 19.79 0 012 1.17 2 2 0 013.07 1a3.12 3.12 0 012 0h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L9.91 8.1a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg> Позвонить</a>` : '',
    s.website   ? `<a href="${esc(s.website.startsWith('http')?s.website:'https://'+s.website)}" target="_blank" rel="noopener" class="ss-contact" style="color:hsl(var(--primary));background:hsl(var(--primary)/.1);border:1px solid hsl(var(--border))"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg> Сайт</a>` : '',
  ].filter(Boolean).join('');

  const logoHtml = s.logo_url
    ? `<img src="${esc(s.logo_url)}" alt="logo" style="width:2.5rem;height:2.5rem;border-radius:.625rem;object-fit:cover;flex-shrink:0">`
    : `<div style="width:2.5rem;height:2.5rem;border-radius:.625rem;background:linear-gradient(135deg,#00FFCC,#00CCAA);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.1rem;color:#000;flex-shrink:0">${esc(s.store_name.charAt(0).toUpperCase())}</div>`;

  return `
<header class="nav-modern" style="position:sticky;top:0;z-index:50">
  <div style="position:relative;max-width:1400px;margin:0 auto;padding:0 1rem;height:3.5rem;display:flex;align-items:center">
    ${showBack ? `
    <button id="ss-back-to-home" style="position:absolute;left:1rem;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:hsl(var(--primary));font-weight:700;font-size:.8rem;display:flex;align-items:center;gap:.3rem;white-space:nowrap;z-index:2;padding:.2rem .4rem;border-radius:.4rem">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
      ${esc(backLabel)}
    </button>` : ''}
    <div style="flex:1;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.5rem;${showBack ? 'padding-left:5rem' : ''}">
      <div style="display:flex;align-items:center;gap:.5rem;overflow:hidden;min-width:0">
        ${logoHtml}
        <span style="font-size:1.1rem;font-weight:800;color:hsl(var(--foreground));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2">${esc(s.store_name)}</span>
      </div>
      <span class="ss-header-brand" style="font-size:1.15rem;padding:0 .5rem;white-space:nowrap">SimaStore</span>
      ${contacts ? `<div style="display:flex;align-items:center;gap:.4rem;justify-content:flex-end;overflow:hidden">${contacts}</div>` : '<div></div>'}
    </div>
  </div>
</header>`;
}

// ─── How It Works ─────────────────────────────────────────────────────────────

const HOW_STEPS = [
  { icon:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>', title:'Выбери товар',      desc:'Просматривай каталог и нажимай на понравившийся товар', grad:'linear-gradient(135deg,#3b82f6,#06b6d4)', num_bg:'#3b82f6' },
  { icon:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>', title:'Перейди в магазин', desc:'Нажми кнопку «Купить» для перехода на маркетплейс',    grad:'linear-gradient(135deg,#a855f7,#ec4899)', num_bg:'#a855f7' },
  { icon:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>', title:'Оформи заказ',      desc:'Добавь в корзину и оформи заказ прямо в маркетплейсе', grad:'linear-gradient(135deg,#22c55e,#10b981)', num_bg:'#22c55e' },
  { icon:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', title:'Получи товар',      desc:'Курьером или в пункте выдачи — как тебе удобнее',      grad:'linear-gradient(135deg,#f97316,#ef4444)', num_bg:'#f97316' },
];

function renderHowItWorks(): string {
  const steps = HOW_STEPS.map((s,i) => ({...s, n: i+1}));
  return `
<section class="ss-hiw">
  <div class="ss-hiw-bg1"></div>
  <div class="ss-hiw-bg2"></div>
  <div style="max-width:1400px;margin:0 auto;padding:0 1rem">
    <div style="text-align:center">
      <div class="ss-hiw-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> <span>Как сделать заказ</span></div>
      <h2 class="ss-hiw-title">Как это работает?</h2>
      <p class="ss-hiw-sub">Находи и покупай товары из маркетплейсов в 4 шага</p>
    </div>
    <div class="ss-hiw-steps">
      <div class="ss-hiw-line"></div>
      ${steps.map((s,i) => `
      <div class="ss-hiw-step-card" style="animation:slideInScale .5s cubic-bezier(.34,1.56,.64,1) ${i*.1}s both">
        <div class="ss-hiw-icon-wrap" style="background:${s.grad};box-shadow:0 6px 20px rgba(0,0,0,.3)">
          <span style="position:relative;z-index:1;display:flex;align-items:center;justify-content:center">${s.icon}</span>
          <div class="ss-hiw-num" style="background:${s.num_bg}">${s.n}</div>
        </div>
        <h3 style="font-size:.875rem;font-weight:800;margin-bottom:.35rem;color:hsl(var(--foreground))">${s.title}</h3>
        <p style="font-size:.75rem;color:hsl(var(--muted-foreground));line-height:1.5">${s.desc}</p>
      </div>`).join('')}
    </div>
    <div class="ss-hiw-steps-mob">
      ${steps.map((s,i) => `
      <div style="animation:slideInLeft .4s cubic-bezier(.34,1.56,.64,1) ${i*.08}s both">
        <div class="ss-hiw-mob-card">
          <div class="ss-hiw-mob-icon" style="background:${s.grad};box-shadow:0 4px 12px rgba(0,0,0,.3)">
            <span style="display:flex;align-items:center;justify-content:center">${s.icon}</span>
            <div class="ss-hiw-mob-num">${s.n}</div>
          </div>
          <div>
            <div style="font-size:.875rem;font-weight:800;margin-bottom:.2rem;color:hsl(var(--foreground))">${s.title}</div>
            <div style="font-size:.75rem;color:hsl(var(--muted-foreground));line-height:1.5">${s.desc}</div>
          </div>
        </div>
        ${i<steps.length-1?'<div class="ss-hiw-connector"></div>':''}
      </div>`).join('')}
    </div>
  </div>
</section>`;
}

// ─── Homepage view ────────────────────────────────────────────────────────────

function shuffleSlice<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function mountHomePage(root: HTMLElement, data: StoreData, _slug: string, groups: GroupedProduct[], onCatalog: () => void): Carousel|null {
  const { settings: s, banners } = data;
  const RECOMMENDED_COUNT = 12;
  const featured = groups.length > RECOMMENDED_COUNT ? shuffleSlice(groups, RECOMMENDED_COUNT) : [...groups];

  document.title = `${s.store_name} — SimaStore`;

  root.innerHTML = `
<div style="min-height:100vh;background:hsl(var(--background));color:hsl(var(--foreground))">
  ${headerHtml(s, false)}

  ${banners.length > 0 ? `
  <div style="padding:.5rem 0 .75rem">
    <div style="max-width:1400px;margin:0 auto;padding:0 .75rem" id="ss-banner-area"></div>
  </div>` : ''}

  <section style="padding:.75rem 0 .5rem">
    <div style="max-width:1400px;margin:0 auto;padding:0 .75rem">
      ${featured.length > 0 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.625rem;flex-wrap:wrap;gap:.5rem">
        <div style="display:flex;align-items:center;gap:.5rem">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:hsl(var(--primary))"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <span style="font-size:.875rem;font-weight:700;color:hsl(var(--foreground))">Рекомендуем</span>
        </div>
        <button id="ss-refresh-rec" style="background:none;border:1px solid hsl(var(--border)/.5);border-radius:.5rem;padding:.2rem .5rem;font-size:.75rem;color:hsl(var(--muted-foreground));cursor:pointer;display:flex;align-items:center;gap:.3rem">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
          Обновить
        </button>
      </div>
      <div class="ss-grid" id="ss-home-grid">
        ${featured.map(g => renderCard(g)).join('')}
      </div>` : `
      <div style="text-align:center;padding:3rem 1rem">
        <div style="display:flex;justify-content:center;margin-bottom:.75rem;color:hsl(var(--foreground)/.2)"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg></div>
        <h3 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">Товары появятся скоро</h3>
        <p style="color:hsl(var(--muted-foreground));font-size:.875rem">Магазин пока пустой, загляните позже</p>
      </div>`}

      ${groups.length > 0 ? `
      <div style="padding:1.5rem 0 .5rem">
        <button class="ss-catalog-btn" id="ss-to-catalog">
          <span>Весь каталог</span>
          <span style="font-size:.9rem;opacity:.7">(${groups.length} позиций)</span>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>` : ''}
    </div>
  </section>

  ${renderHowItWorks()}

  <footer style="text-align:center;padding:1.5rem;font-size:.75rem;color:hsl(var(--muted-foreground));border-top:1px solid hsl(var(--border)/.4)">
    Powered by <a href="https://simadesk.ru" style="color:hsl(var(--primary));font-weight:700;text-decoration:none">SimaDesk</a>
  </footer>
</div>`;

  let carousel: Carousel|null = null;
  if (banners.length > 0) {
    const area = document.getElementById('ss-banner-area');
    if (area) carousel = new Carousel(area, banners);
  }

  document.getElementById('ss-to-catalog')?.addEventListener('click', onCatalog);

  document.getElementById('ss-refresh-rec')?.addEventListener('click', () => {
    const newFeatured = groups.length > RECOMMENDED_COUNT ? shuffleSlice(groups, RECOMMENDED_COUNT) : [...groups];
    const grid = document.getElementById('ss-home-grid');
    if (grid) grid.innerHTML = newFeatured.map(g => renderCard(g)).join('');
  });

  root.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest('.ss-card') as HTMLElement|null;
    if (card) {
      const key = card.dataset.key;
      if (key) root.dispatchEvent(new CustomEvent('open-product', { detail: { key }, bubbles: true }));
    }
  });

  return carousel;
}

// ─── Catalog view ─────────────────────────────────────────────────────────────

function mountCatalogPage(root: HTMLElement, data: StoreData, _slug: string, groups: GroupedProduct[], onBack: () => void): void {
  const { settings: s } = data;
  document.title = `Каталог — ${s.store_name}`;

  const hasSrc = (src: string) => groups.some(g => g.entries.some(e => e.source === src));

  root.innerHTML = `
<div style="min-height:100vh;background:hsl(var(--background));color:hsl(var(--foreground))">
  ${headerHtml(s, true, 'Главная')}

  <div style="max-width:1400px;margin:0 auto;padding:.75rem .75rem 4rem">

    <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem;flex-wrap:wrap">
      <h1 style="font-size:clamp(1.25rem,5vw,2rem);font-weight:900;text-transform:uppercase;letter-spacing:-.01em;color:hsl(var(--foreground));margin:0">Каталог</h1>
      <span id="ss-count" style="padding:.2rem .625rem;border-radius:999px;font-size:.75rem;font-weight:800;background:hsl(var(--primary)/.1);border:1px solid hsl(var(--primary)/.2);color:hsl(var(--primary))">${groups.length}</span>
    </div>

    <div style="position:relative;margin-bottom:.75rem">
      <svg style="position:absolute;left:.75rem;top:50%;transform:translateY(-50%);width:1rem;height:1rem;color:hsl(var(--foreground)/.4);pointer-events:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input id="ss-search" type="search" placeholder="Поиск товаров..." class="ss-search">
    </div>

    <div style="display:flex;gap:.5rem;padding:.375rem;background:hsl(var(--muted)/.5);border-radius:1rem;border:1px solid hsl(var(--border)/.4);margin-bottom:.75rem">
      <button class="ss-src-tab active" data-src="all">Все</button>
      ${hasSrc('wb')     ? `<button class="ss-src-tab" data-src="wb">WB</button>` : ''}
      ${hasSrc('ozon')   ? `<button class="ss-src-tab" data-src="ozon">Ozon</button>` : ''}
      ${hasSrc('yandex') ? `<button class="ss-src-tab" data-src="yandex">Яндекс</button>` : ''}
    </div>

    <div class="ss-grid" id="ss-cat-grid">${renderSkeletons(12)}</div>
  </div>

  <footer style="text-align:center;padding:1.5rem;font-size:.75rem;color:hsl(var(--muted-foreground));border-top:1px solid hsl(var(--border)/.4)">
    Powered by <a href="https://simadesk.ru" style="color:hsl(var(--primary));font-weight:700;text-decoration:none">SimaDesk</a>
  </footer>
</div>`;

  const PAGE_SIZE = 24;
  let currentSrc = 'all';
  let searchQ    = '';
  let currentPage = 0;
  let lazyObserver: IntersectionObserver | null = null;

  function filtered(): GroupedProduct[] {
    const q = searchQ.trim().toLowerCase();
    return groups.filter(g => {
      const matchSrc = currentSrc === 'all' || g.entries.some(e => e.source === currentSrc);
      const matchQ   = !q || g.title.toLowerCase().includes(q) || g.vendor_code.toLowerCase().includes(q) ||
                       g.entries.some(e => e.title.toLowerCase().includes(q));
      return matchSrc && matchQ;
    });
  }

  function renderPage(f: GroupedProduct[], page: number, grid: HTMLElement): void {
    const start = page * PAGE_SIZE;
    const slice = f.slice(start, start + PAGE_SIZE);
    if (page === 0) {
      grid.innerHTML = slice.map(g => renderCard(g)).join('');
    } else {
      slice.forEach(g => { grid.insertAdjacentHTML('beforeend', renderCard(g)); });
    }
    const sentinel = document.getElementById('ss-cat-sentinel');
    sentinel?.remove();
    lazyObserver?.disconnect();
    lazyObserver = null;
    if (start + slice.length < f.length) {
      const s = document.createElement('div');
      s.id = 'ss-cat-sentinel';
      s.style.cssText = 'height:1px;margin-top:1rem';
      grid.parentElement?.insertBefore(s, grid.nextSibling);
      lazyObserver = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting) return;
        lazyObserver?.disconnect();
        lazyObserver = null;
        currentPage++;
        renderPage(filtered(), currentPage, grid);
      }, { rootMargin: '300px' });
      lazyObserver.observe(s);
    }
  }

  function refreshGrid(): void {
    const grid  = document.getElementById('ss-cat-grid');
    const count = document.getElementById('ss-count');
    const f = filtered();
    currentPage = 0;
    document.getElementById('ss-cat-sentinel')?.remove();
    lazyObserver?.disconnect();
    lazyObserver = null;
    if (grid) {
      if (f.length === 0) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem 1rem">
          <div style="display:flex;justify-content:center;margin-bottom:.75rem;color:hsl(var(--foreground)/.2)"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
          <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:.5rem;color:hsl(var(--foreground))">Ничего не найдено</h3>
          <p style="color:hsl(var(--muted-foreground));font-size:.875rem">Попробуйте изменить запрос или сбросить фильтр</p>
        </div>`;
      } else {
        renderPage(f, 0, grid);
      }
    }
    if (count) count.textContent = String(f.length);
  }

  requestAnimationFrame(() => refreshGrid());

  document.getElementById('ss-search')?.addEventListener('input', (e) => {
    searchQ = (e.target as HTMLInputElement).value;
    refreshGrid();
  });

  document.getElementById('ss-back-to-home')?.addEventListener('click', onBack);

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;

    const tab = t.closest('.ss-src-tab') as HTMLElement|null;
    if (tab && tab.dataset.src) {
      root.querySelectorAll('.ss-src-tab').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      currentSrc = tab.dataset.src;
      refreshGrid();
      return;
    }

    const card = t.closest('.ss-card') as HTMLElement|null;
    if (card) {
      const key = card.dataset.key;
      if (key) root.dispatchEvent(new CustomEvent('open-product', { detail: { key }, bubbles: true }));
    }
  });
}

// ─── Detail overlay ───────────────────────────────────────────────────────────

function openDetail(group: GroupedProduct, allGroups: GroupedProduct[], slug: string, onClose: () => void): void {
  const imgs = group.images;
  const cheapest = group.entries[0];

  // Build buy buttons — cheapest entry gets primary style
  const buyButtonsHtml = group.entries.map((entry, i) => {
    const url   = buildEntryUrl(entry);
    const label = BUY_LABEL[entry.source] ?? 'Купить';
    const price = entry.custom_price != null ? ` · ${fmt(entry.custom_price)}` : ` · ${fmt(entry.price)}`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="${i === 0 ? 'ss-btn-pri' : 'ss-btn-sec'}">${label}${price} ↗</a>`;
  }).join('');

  // Custom URL button (extra "buy on website" button)
  const customEntry = group.entries.find(e => e.custom_url && e.custom_url.trim());
  const customBtnHtml = customEntry?.custom_url
    ? `<a href="${esc(customEntry.custom_url)}" target="_blank" rel="noopener noreferrer" class="ss-btn-sec" style="border-color:hsl(var(--primary)/.4);color:hsl(var(--primary));font-weight:800;display:inline-flex;align-items:center;gap:.4rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg> Купить у продавца${customEntry.custom_price != null ? ` · ${fmt(customEntry.custom_price)}` : ''} ↗
      </a>`
    : '';

  const related = allGroups
    .filter(g => g.key !== group.key)
    .sort(() => Math.random() - 0.5)
    .slice(0, 6);

  const swipeInd = document.createElement('div');
  swipeInd.className = 'ss-swipe-ind';
  swipeInd.innerHTML = '&#8592;';
  document.body.appendChild(swipeInd);

  const panel = document.createElement('div');
  panel.className = 'ss-detail';
  panel.innerHTML = `
<div class="ss-det-hdr">
  <button class="ss-back" id="ss-det-back">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
    Назад
  </button>
  <span style="flex:1;font-size:.8rem;font-weight:600;color:hsl(var(--muted-foreground));overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(group.title)}</span>
  <button id="ss-det-share" class="ss-btn-sec" style="padding:.4rem .75rem;font-size:.75rem;border-radius:.6rem;flex-shrink:0">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
    Поделиться
  </button>
</div>

<div class="ss-det-body">
  <div class="ss-det-layout">
    <div>
      ${imgs.length === 0
        ? `<div class="ss-gal"><div style="aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:hsl(var(--muted)/.3);border-radius:1rem;color:hsl(var(--foreground)/.2)"><svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div></div>`
        : `<div class="ss-gal">
            <div class="ss-gal-main" id="ss-gal-main">
              ${imgs.map(img => `<div class="ss-gal-slide"><img src="${esc(img)}" alt="photo" loading="lazy"></div>`).join('')}
            </div>
            <div class="ss-gal-dots" id="ss-gal-dots">
              ${imgs.map((_,i) => `<button class="ss-gal-dot${i===0?' active':''}" data-gi="${i}"></button>`).join('')}
            </div>
            <div class="ss-gal-thumbs" id="ss-gal-thumbs">
              ${imgs.map((img,i) => `<div class="ss-gal-thumb${i===0?' active':''}" data-gi="${i}"><img src="${esc(img)}" alt="thumb" loading="lazy"></div>`).join('')}
            </div>
          </div>`}
    </div>

    <div>
      <h1 class="ss-det-title">${esc(group.title)}</h1>
      <div class="ss-price-row">
        <span class="ss-price-big">${fmtRange(group.price_min, group.price_max)}</span>
        ${cheapest.discount > 0 && group.price_min === group.price_max
          ? `<span class="ss-price-old">${fmt(cheapest.original_price)}</span><span class="ss-price-disc">−${cheapest.discount}%</span>`
          : ''}
      </div>
      <div class="ss-meta">
        ${group.vendor_code ? `<div class="ss-meta-row">Артикул: <span>${esc(group.vendor_code)}</span></div>` : ''}
        ${group.brand ? `<div class="ss-meta-row">Бренд: <span>${esc(group.brand)}</span></div>` : ''}
      </div>
      <div class="ss-buy-col" id="ss-buy-desktop" style="display:none">
        ${buyButtonsHtml}
        ${customBtnHtml}
      </div>
      <div class="ss-tabs-bar">
        <button class="ss-tab-btn active" data-tab="desc">Описание</button>
        <button class="ss-tab-btn" data-tab="spec">Характеристики</button>
      </div>
      <div class="ss-tab-pane active" id="ss-pane-desc">
        ${group.description
          ? `<p>${esc(group.description)}</p>`
          : `<p style="color:hsl(var(--muted-foreground));font-style:italic">Описание не добавлено</p>`}
      </div>
      <div class="ss-tab-pane" id="ss-pane-spec">
        <div style="display:flex;flex-direction:column;gap:.25rem">
          ${group.vendor_code ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0;border-bottom:1px solid hsl(var(--border)/.3)"><span style="color:hsl(var(--muted-foreground))">Артикул</span><span style="font-weight:600">${esc(group.vendor_code)}</span></div>` : ''}
          ${group.brand ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0;border-bottom:1px solid hsl(var(--border)/.3)"><span style="color:hsl(var(--muted-foreground))">Бренд</span><span style="font-weight:600">${esc(group.brand)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0">
            <span style="color:hsl(var(--muted-foreground))">Площадки</span>
            <span style="font-weight:600">${[...new Set(group.entries.map(e => BADGE[e.source]??e.source))].join(', ')}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  ${related.length > 0 ? `
  <div style="margin-top:2rem">
    <h2 style="font-size:1rem;font-weight:800;margin-bottom:.75rem;color:hsl(var(--foreground))">Ещё товары</h2>
    <div class="ss-grid">${related.map(g => renderCard(g)).join('')}</div>
  </div>` : ''}
</div>

<div class="ss-mobile-bar">
  <a href="${esc(buildEntryUrl(cheapest))}" target="_blank" rel="noopener noreferrer" class="ss-btn-pri" style="flex:1">${BUY_LABEL[cheapest.source] ?? 'Купить'} ↗</a>
  ${customEntry?.custom_url ? `<a href="${esc(customEntry.custom_url)}" target="_blank" rel="noopener noreferrer" class="ss-btn-sec" style="display:inline-flex;align-items:center;gap:.35rem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg> Сайт</a>` : ''}
</div>`;

  document.body.appendChild(panel);
  requestAnimationFrame(() => requestAnimationFrame(() => { panel.classList.add('open'); }));

  const buyDesktop = panel.querySelector('#ss-buy-desktop') as HTMLElement|null;
  if (buyDesktop) buyDesktop.style.display = 'flex';

  // Gallery sync
  const galMain = panel.querySelector('#ss-gal-main') as HTMLElement|null;
  if (galMain && imgs.length > 1) {
    const syncIdx = (idx: number) => {
      panel.querySelectorAll('.ss-gal-dot').forEach((d,i) => d.classList.toggle('active', i===idx));
      panel.querySelectorAll('.ss-gal-thumb').forEach((t,i) => t.classList.toggle('active', i===idx));
    };
    galMain.addEventListener('scroll', () => {
      syncIdx(Math.round(galMain.scrollLeft / galMain.clientWidth));
    }, { passive:true });
    panel.querySelectorAll('.ss-gal-dot,.ss-gal-thumb').forEach(el => {
      el.addEventListener('click', () => {
        const i = parseInt((el as HTMLElement).dataset.gi ?? '0', 10);
        galMain.scrollTo({ left: i * galMain.clientWidth, behavior:'smooth' });
        syncIdx(i);
      });
    });
  }

  // Tabs
  panel.querySelectorAll('.ss-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab!;
      panel.querySelectorAll('.ss-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      panel.querySelectorAll('.ss-tab-pane').forEach(p => p.classList.remove('active'));
      panel.querySelector(`#ss-pane-${tab}`)?.classList.add('active');
    });
  });

  // Related card clicks
  panel.querySelectorAll('.ss-card').forEach(card => {
    card.addEventListener('click', () => {
      const key = (card as HTMLElement).dataset.key;
      if (!key) return;
      const g = allGroups.find(x => x.key === key);
      if (!g) return;
      history.replaceState({ productKey: g.key }, '', `/${slug}/product/${encodeURIComponent(g.key)}`);
      panel.scrollTo({ top:0, behavior:'instant' });
      closePanel(false);
      openDetail(g, allGroups, slug, onClose);
    });
  });

  // Share
  panel.querySelector('#ss-det-share')?.addEventListener('click', () => {
    const url = window.location.href;
    if (navigator.share) { navigator.share({ title: group.title, url }).catch(() => {}); }
    else { navigator.clipboard.writeText(url).then(() => {
      const btn = panel.querySelector('#ss-det-share');
      if (btn) { btn.textContent = '✓ Скопировано'; setTimeout(() => { btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Поделиться`; }, 2000); }
    }).catch(() => {}); }
  });

  function closePanel(goBack = true): void {
    window.removeEventListener('popstate', onPop);
    panel.classList.remove('open');
    swipeInd.classList.remove('visible');
    setTimeout(() => { panel.remove(); swipeInd.remove(); }, 350);
    if (goBack) onClose();
  }

  panel.querySelector('#ss-det-back')?.addEventListener('click', () => {
    closePanel(true);
  });

  const onPop = (e: PopStateEvent) => {
    if (!e.state?.productKey) closePanel(true);
  };
  window.addEventListener('popstate', onPop);

  // Swipe to go back
  let swipeStartX = 0, swipeStartY = 0, swipeIsH = false, swipeLocked = false;
  panel.addEventListener('touchstart', (e:TouchEvent) => {
    swipeStartX = e.changedTouches[0].clientX;
    swipeStartY = e.changedTouches[0].clientY;
    swipeIsH = false; swipeLocked = false;
  }, { passive:true });
  panel.addEventListener('touchmove', (e:TouchEvent) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (!swipeLocked) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { swipeIsH = Math.abs(dx) > Math.abs(dy); swipeLocked = true; }
    }
    if (!swipeIsH || dx < 0) return;
    if (swipeStartX > 40 && panel.scrollTop > 0) return;
    panel.classList.add('animating');
    panel.style.transform = `translateX(${dx * 0.6}px)`;
    swipeInd.classList.toggle('visible', dx / window.innerWidth > 0.4);
  }, { passive:true });
  panel.addEventListener('touchend', (e:TouchEvent) => {
    swipeInd.classList.remove('visible');
    panel.classList.remove('animating');
    panel.style.transform = '';
    const dx = e.changedTouches[0].clientX - swipeStartX;
    if (swipeIsH && dx / window.innerWidth > 0.4) { closePanel(true); }
  }, { passive:true });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  injectCSS();

  const root = document.getElementById('root')!;

  root.innerHTML = `
<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center">
  <div style="text-align:center">
    <div style="width:3.5rem;height:3.5rem;border:3px solid hsl(var(--primary)/.3);border-top-color:hsl(var(--primary));border-radius:9999px;animation:ss-spin .8s linear infinite;margin:0 auto 1rem"></div>
    <p style="color:hsl(var(--muted-foreground));font-size:.875rem">Загружаем магазин…</p>
  </div>
</div>`;

  const parts = window.location.pathname.replace(/^\//, '').split('/');
  const slug  = parts[0];
  if (!slug) {
    root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">
      <div><div style="display:flex;justify-content:center;margin-bottom:1rem;color:hsl(var(--foreground)/.2)"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div><h1 style="font-size:1.5rem;font-weight:900;color:hsl(var(--foreground));margin-bottom:.5rem">Магазин не найден</h1>
      <p style="color:hsl(var(--muted-foreground))">Проверьте адрес</p></div></div>`;
    return;
  }

  let data: StoreData | null = null;
  try { data = await fetchStoreData(slug); }
  catch {
    root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">
      <div><div style="display:flex;justify-content:center;margin-bottom:1rem;color:hsl(var(--foreground)/.2)"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"/></svg></div><h1 style="font-size:1.25rem;font-weight:900;color:hsl(var(--foreground));margin-bottom:.5rem">Ошибка соединения</h1>
      <p style="color:hsl(var(--muted-foreground));margin-bottom:1.5rem">Проверьте подключение к интернету</p>
      <button onclick="location.reload()" style="background:linear-gradient(135deg,#00FFCC,#00CCAA);color:#000;font-weight:800;padding:.75rem 2rem;border-radius:.875rem;border:none;cursor:pointer;font-size:.9rem">Обновить</button></div></div>`;
    return;
  }

  if (!data) {
    root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">
      <div><div style="display:flex;justify-content:center;margin-bottom:1rem;color:hsl(var(--foreground)/.2)"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div><h1 style="font-size:1.5rem;font-weight:900;color:hsl(var(--foreground));margin-bottom:.5rem">Магазин не найден</h1>
      <p style="color:hsl(var(--muted-foreground));margin-bottom:1.5rem">Проверьте адрес или попросите владельца поделиться ссылкой</p>
      <a href="https://simadesk.ru" style="display:inline-block;background:linear-gradient(135deg,#00FFCC,#00CCAA);color:#000;font-weight:800;padding:.75rem 2rem;border-radius:.875rem;text-decoration:none">Открыть SimaDesk</a></div></div>`;
    return;
  }

  const groups = groupProducts(data.products);

  type View = 'home' | 'catalog';
  let view: View = 'home';
  let carousel: Carousel | null = null;

  function openProduct(key: string): void {
    const group = groups.find(g => g.key === key);
    if (!group) return;
    history.replaceState({ productKey: key }, '', `/${slug}/product/${encodeURIComponent(key)}`);
    openDetail(group, groups, slug, () => {
      history.replaceState({}, '', view === 'catalog' ? `/${slug}/catalog` : `/${slug}`);
    });
  }

  // Single persistent listener — never removed, catches events from home and catalog pages
  root.addEventListener('open-product', ((e: CustomEvent) => openProduct(e.detail.key)) as EventListener);

  function showHome(): void {
    view = 'home';
    history.replaceState({}, '', `/${slug}`);
    carousel?.destroy();
    carousel = mountHomePage(root, data!, slug, groups, showCatalog);
  }

  function showCatalog(): void {
    view = 'catalog';
    history.replaceState({}, '', `/${slug}/catalog`);
    carousel?.destroy();
    carousel = null;
    mountCatalogPage(root, data!, slug, groups, showHome);
  }

  const isProduct = parts[1] === 'product' && parts[2];
  const isCatalog = parts[1] === 'catalog';

  if (isCatalog) {
    showCatalog();
  } else {
    showHome();
    if (isProduct) {
      const rawKey = decodeURIComponent(parts[2]);
      setTimeout(() => openProduct(rawKey), 120);
    }
  }
}

init().catch(console.error);
