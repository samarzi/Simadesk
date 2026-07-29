import { setFavicon } from './utils/favicon';

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
  show_price_filter?: boolean;
  show_brand_filter?: boolean;
  show_category_filter?: boolean;
  show_stock?: boolean;
  hide_out_of_stock?: boolean;
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
  category?: string;
  custom_url?: string;
  custom_price?: number;
  custom_title?: string;
  is_hidden?: boolean;
  stock?: number;
  weight_kg?: number | null;
  height_cm?: number | null;
  width_cm?: number | null;
  length_cm?: number | null;
}
interface VariantItem { vendor_code: string; label: string; color: string; sort_order: number; }
interface VariantGroup { id: string; sort_order: number; items: VariantItem[]; }
interface GroupedProduct {
  key: string;
  vendor_code: string;
  title: string;
  images: string[];
  brand?: string;
  category?: string;
  price_min: number;
  price_max: number;
  totalStock: number;
  weight_kg?: number | null;
  height_cm?: number | null;
  width_cm?: number | null;
  length_cm?: number | null;
  entries: Product[]; // sorted cheapest first
}
interface Banner { id: number; title?: string; image_url: string; link_url?: string; }
interface SGroup { id: string; name: string; cover_url: string; sort_order: number; vendor_codes: string[]; }
interface StoreData { settings: Settings; products: Product[]; banners: Banner[]; variants?: VariantGroup[]; groups?: SGroup[]; }

// ─── Constants ────────────────────────────────────────────────────────────────

const BADGE: Record<string,string>    = { wb:'WB', ozon:'Ozon', yandex:'Яндекс' };
const BADGE_BG: Record<string,string> = { wb:'rgba(203,73,167,.9)', ozon:'rgba(0,91,255,.9)', yandex:'rgba(255,172,0,.9)' };
const BUY_LABEL: Record<string,string>= { wb:'Купить на WB', ozon:'Купить на Ozon', yandex:'Купить на Яндекс' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getImages(p: Product): string[] {
  const validUrl = (u: unknown): u is string =>
    typeof u === 'string' && u.length > 0 && (u.startsWith('http') || u.startsWith('//'));
  if (Array.isArray(p.images) && p.images.length) {
    const filtered = p.images.filter(validUrl);
    if (filtered.length) return filtered;
  }
  if (validUrl(p.image_url)) return [p.image_url];
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
function groupProducts(products: Product[], hideOos = false): GroupedProduct[] {
  const map = new Map<string, GroupedProduct>();
  for (const p of products) {
    if (p.is_hidden) continue;
    const effectivePrice = p.custom_price != null ? p.custom_price : p.price;
    if (effectivePrice <= 0) continue;
    const vc = (p.vendor_code ?? '').trim().toLowerCase();
    const key = vc ? `v:${vc}` : `s:${p.source}:${p.source_id}`;
    const imgs = getImages(p);
    const title = p.custom_title || p.title;
    const pStock = p.stock ?? 0;
    if (!map.has(key)) {
      map.set(key, {
        key, vendor_code: vc, title,
        images: imgs, brand: p.brand, category: p.category,
        price_min: effectivePrice, price_max: effectivePrice,
        totalStock: pStock,
        weight_kg: p.weight_kg, height_cm: p.height_cm,
        width_cm: p.width_cm, length_cm: p.length_cm,
        entries: [p],
      });
    } else {
      const g = map.get(key)!;
      g.entries.push(p);
      g.totalStock += pStock;
      const ep = p.custom_price != null ? p.custom_price : p.price;
      g.price_min = Math.min(g.price_min, ep);
      g.price_max = Math.max(g.price_max, ep);
      if (p.custom_title && !g.title) g.title = p.custom_title;
      if (imgs.length > g.images.length) {
        g.images = imgs;
        if (!p.custom_title) g.title = title;
        g.brand = p.brand; g.category = p.category;
      }
      if (!g.weight_kg && p.weight_kg) g.weight_kg = p.weight_kg;
      if (!g.height_cm && p.height_cm) g.height_cm = p.height_cm;
      if (!g.width_cm  && p.width_cm)  g.width_cm  = p.width_cm;
      if (!g.length_cm && p.length_cm) g.length_cm = p.length_cm;
    }
  }
  for (const g of map.values()) g.entries.sort((a, b) => a.price - b.price);
  let result = Array.from(map.values());
  if (hideOos) result = result.filter(g => g.totalStock > 0);
  return result;
}

// ─── CSS injection ────────────────────────────────────────────────────────────

function injectCSS(): void {
  const el = document.createElement('style');
  el.textContent = `
html { scrollbar-gutter: stable; }
@keyframes ss-spin { to { transform: rotate(360deg); } }
@keyframes ss-shimmer { 0%,100%{opacity:.5} 50%{opacity:1} }
@keyframes ss-fadein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
@keyframes ss-float-in  { from{opacity:0;transform:translateX(-50%) translateY(calc(-200% - 4.5rem))} to{opacity:1;transform:translateX(-50%) translateY(0)} }
@keyframes ss-float-out { from{opacity:1;transform:translateX(-50%) translateY(0)} to{opacity:0;transform:translateX(-50%) translateY(calc(-200% - 4.5rem))} }
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
  display:none; border-radius:1rem; overflow:hidden; height:220px;
  position:relative; cursor:pointer; flex-shrink:0;
}
@media(min-width:1024px) { .ss-banner-side { display:block; } }
.ss-banner-side img { width:100%;height:100%;object-fit:cover;display:block; }
.ss-banner-side-ov { position:absolute;inset:0;background:rgba(0,0,0,.4);border-radius:1rem;transition:background .25s; }
.ss-banner-side:hover .ss-banner-side-ov { background:rgba(0,0,0,.2); }
.ss-banner-main { display:block;border-radius:1rem;overflow:hidden;height:200px;transition:opacity .3s; }
@media(min-width:640px) { .ss-banner-main { height:280px; } }
@media(min-width:1024px) { .ss-banner-main { height:220px; } }
.ss-banner-main img { width:100%;height:100%;object-fit:cover;display:block; }
.ss-ban-dots { display:flex;justify-content:center;gap:.5rem;margin-top:.75rem; }
@media(min-width:1024px) { .ss-ban-dots { display:none; } }
.ss-car-dot { width:8px;height:8px;border-radius:50%;background:hsl(var(--muted-foreground)/.3);border:none;cursor:pointer;padding:0;transition:all .2s; }
.ss-car-dot.active { background:hsl(var(--primary));transform:scale(1.25); }

/* ── Rec carousel ── */
.ss-rec-wrap { overflow:hidden; position:relative;
  mask-image:linear-gradient(to right,transparent 0,#000 6%,#000 94%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 0,#000 6%,#000 94%,transparent 100%); }
.ss-rec-track { display:flex; gap:.75rem; width:max-content; will-change:transform; }
.ss-rec-track .ss-card { width:148px; flex-shrink:0; }
.ss-rec-track .ss-card .ss-card-img { overflow:hidden; }
.ss-rec-track .ss-card .ss-card-img img { transform:scale(1.6); transform-origin:center center; }
.ss-rec-track .ss-card .ss-card-price-row { display:none; }
.ss-rec-track .ss-card .ss-card-buy { display:none; }
.ss-rec-track .ss-card .ss-card-body { padding:.4rem .5rem .5rem; }
.ss-rec-track .ss-card .ss-card-title {
  display:block; height:2.7em; overflow:hidden;
  mask-image:linear-gradient(to bottom,#000 40%,transparent 100%);
  -webkit-mask-image:linear-gradient(to bottom,#000 40%,transparent 100%);
}

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
.ss-rec-track .ss-card:hover { transform:none; }
.ss-card-img  { position:relative; aspect-ratio:3/4; background:hsl(var(--muted)/.3); overflow:hidden; }
.ss-card-img img { width:100%; height:100%; object-fit:cover; }
.ss-card-grad { position:absolute; inset:0; background:linear-gradient(to top,rgba(0,0,0,.6) 0%,rgba(0,0,0,.2) 40%,transparent 100%); pointer-events:none; }
.ss-card-body { padding:.5rem .625rem .375rem; }
/* ── Favourites ── */
.ss-fav-btn {
  position:absolute; top:.4rem; left:.4rem; z-index:5;
  width:1.75rem; height:1.75rem; border-radius:50%;
  background:rgba(0,0,0,.45); backdrop-filter:blur(6px);
  border:none; cursor:pointer; display:flex; align-items:center; justify-content:center;
  transition:transform .2s, background .2s;
}
.ss-fav-btn:active { transform:scale(.85); }
.ss-fav-btn svg { width:14px; height:14px; transition:fill .2s, stroke .2s; }
.ss-fav-btn svg { stroke:#fff; fill:none; }
.ss-fav-btn.active { background:rgba(220,38,38,.85); }
.ss-fav-btn.active svg { stroke:#fff; fill:#fff; }
@keyframes ss-fav-pop { 0%{transform:scale(1)} 40%{transform:scale(1.4)} 70%{transform:scale(.9)} 100%{transform:scale(1)} }
.ss-fav-btn.pop { animation:ss-fav-pop .35s ease; }
.ss-fav-header-btn {
  display:flex; align-items:center; gap:.35rem;
  background:none; border:1.5px solid hsl(var(--border)/.6); border-radius:999px;
  cursor:pointer; padding:.3rem .75rem .3rem .5rem; color:hsl(var(--foreground));
  font-size:.75rem; font-weight:700; transition:border-color .15s, background .15s;
}
.ss-fav-header-btn:hover { border-color:hsl(0 72% 51%/.5); background:hsl(0 72% 51%/.07); }
.ss-fav-header-btn.active { border-color:hsl(0 72% 51%/.7); color:hsl(0 72% 51%); }
.ss-fav-header-btn svg { width:14px; height:14px; }
.ss-fav-header-btn.active svg { fill:hsl(0 72% 51%); stroke:hsl(0 72% 51%); }
.ss-det-fav-btn {
  display:flex; align-items:center; gap:.5rem; width:100%;
  padding:.75rem 1rem; border-radius:.875rem;
  border:1.5px solid hsl(var(--border)/.6); background:none; cursor:pointer;
  font-size:.875rem; font-weight:700; color:hsl(var(--foreground));
  transition:border-color .15s, background .15s, color .15s;
}
.ss-det-fav-btn.active { border-color:hsl(0 72% 51%/.6); color:hsl(0 72% 51%); background:hsl(0 72% 51%/.07); }
.ss-det-fav-btn svg { width:16px; height:16px; flex-shrink:0; transition:fill .2s; }
.ss-det-fav-btn.active svg { fill:hsl(0 72% 51%); stroke:hsl(0 72% 51%); }
.ss-card-title { font-size:.75rem; font-weight:700; line-height:1.3; color:hsl(var(--foreground)); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2em; }
.ss-card-price-row { display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; padding:.35rem 0 .25rem; }
.ss-card-buy { padding:.25rem .5rem .5rem; }
.ss-card-buy-btn {
  display:flex; align-items:center; justify-content:center;
  width:100%; height:1.75rem; font-size:10px; font-weight:700;
  background:linear-gradient(135deg,#00FFCC,#00CCAA); color:#000;
  border-radius:.5rem; border:none; cursor:pointer;
}

/* ── Variant selector buttons (detail panel only) ── */
.ss-det-var-btn {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:3rem; height:2.75rem; padding:0 .75rem;
  border-radius:.625rem; border:2px solid hsl(var(--border)/.6);
  font-size:.8rem; font-weight:800; letter-spacing:.03em;
  color:hsl(var(--foreground)); background:hsl(var(--card));
  cursor:pointer; white-space:nowrap; overflow:hidden;
  transition:transform .15s, box-shadow .15s, border-color .15s, background .15s;
  outline:none; position:relative;
}
.ss-det-var-btn.has-color { color:#fff; text-shadow:0 1px 4px rgba(0,0,0,.65); border-color:transparent; }
.ss-det-var-btn:hover:not(:disabled) { transform:scale(1.07); box-shadow:0 4px 14px rgba(0,0,0,.22); border-color:hsl(var(--primary)/.5); }
.ss-det-var-btn.has-color:hover:not(:disabled) { box-shadow:0 6px 18px rgba(0,0,0,.45); border-color:rgba(255,255,255,.45); }
.ss-det-var-btn.active { border-color:hsl(var(--primary))!important; box-shadow:0 0 0 3px hsl(var(--primary)/.28), 0 4px 14px rgba(0,0,0,.2)!important; transform:scale(1.06)!important; }
.ss-det-var-btn.has-color.active { border-color:#fff!important; box-shadow:0 0 0 3px hsl(var(--primary)/.4), 0 6px 18px rgba(0,0,0,.4)!important; }
.ss-det-var-btn:disabled, .ss-det-var-btn.disabled { opacity:.35; cursor:not-allowed; text-decoration:line-through; transform:none!important; }

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

.ss-groups-row { display:flex; flex-wrap:wrap; gap:.5rem; }
.ss-group-chip {
  display:inline-flex; align-items:center; gap:.5rem;
  padding:.375rem .75rem .375rem .375rem;
  border:1px solid hsl(var(--border)/.6); border-radius:999px;
  background:hsl(var(--card)); cursor:pointer;
  font-size:.8rem; font-weight:700; color:hsl(var(--foreground));
  transition:border-color .15s, box-shadow .15s;
}
.ss-group-chip:hover { border-color:hsl(var(--primary)); box-shadow:0 2px 12px rgba(0,255,204,.2); }
.ss-group-chip-img { width:24px; height:24px; border-radius:50%; object-fit:cover; flex-shrink:0; }
.ss-group-chip-ph { width:24px; height:24px; border-radius:50%; background:hsl(var(--primary)/.2); display:flex; align-items:center; justify-content:center; font-size:.7rem; font-weight:900; color:hsl(var(--primary)); flex-shrink:0; }
.ss-group-chip-lbl { white-space:nowrap; }

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
  aspect-ratio:1/1; border-radius:1rem; overflow:hidden;
}
@media(min-width:640px) { .ss-gal-main { aspect-ratio:3/4; } }
.ss-gal-main::-webkit-scrollbar { display:none; }
.ss-gal-slide { flex:0 0 100%; scroll-snap-align:start; }
.ss-gal-slide img { width:100%; height:100%; object-fit:cover; display:block; }
.ss-gal-nav { position:absolute; top:0; bottom:0; z-index:5;
  width:30%; border:none; cursor:pointer;
  background:transparent; color:transparent;
  -webkit-tap-highlight-color:transparent; }
.ss-gal-nav-prev { left:0; }
.ss-gal-nav-next { right:0; }
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

.ss-search {
  width:100%; padding:.75rem 1rem .75rem 2.5rem;
  background:hsl(var(--muted)); border:1px solid hsl(var(--border)/.8);
  border-radius:.875rem; color:hsl(var(--foreground)); font-size:.875rem; outline:none;
  transition:border-color .15s, background .15s;
}
.ss-search:focus { border-color:hsl(var(--primary)/.6); background:hsl(var(--muted)/1.2); }
.ss-search::placeholder { color:hsl(var(--muted-foreground)/.8); }

/* ── Floating glass search bar ── */
.ss-float-bar {
  position:fixed; top:4.5rem; left:50%; z-index:45;
  transform:translateX(-50%) translateY(calc(-200% - 4.5rem));
  width:min(520px,calc(100vw - 2rem));
  padding:.28rem .28rem .28rem .28rem;
  background:rgba(10,20,18,.72);
  backdrop-filter:blur(32px) saturate(180%);
  -webkit-backdrop-filter:blur(32px) saturate(180%);
  border:1px solid rgba(255,255,255,.1);
  border-radius:999px;
  box-shadow:
    0 8px 32px rgba(0,0,0,.6),
    inset 0 1px 0 rgba(255,255,255,.08),
    inset 0 -1px 0 rgba(0,0,0,.25);
  display:flex; align-items:center; gap:.5rem;
  pointer-events:none; opacity:0;
  transition:none;
}
.ss-float-bar.visible {
  animation:ss-float-in .32s cubic-bezier(.34,1.56,.64,1) forwards;
  pointer-events:auto;
}
.ss-float-bar.hiding {
  animation:ss-float-out .22s cubic-bezier(.4,0,.6,1) forwards;
  pointer-events:none;
}
.ss-float-inp {
  flex:1; padding:.42rem .75rem .42rem 2.1rem;
  background:transparent; border:none;
  color:#f0f0f2; font-size:.9rem; font-weight:500; outline:none;
  min-width:0;
}
.ss-float-inp::placeholder { color:rgba(240,240,242,.45); }
.ss-float-ico {
  position:absolute; left:1.1rem; top:50%; transform:translateY(-50%);
  width:1rem; height:1rem; color:rgba(240,240,242,.55); pointer-events:none; flex-shrink:0;
}
.ss-float-clear {
  width:1.75rem; height:1.75rem; border-radius:50%; border:none; cursor:pointer;
  background:rgba(255,255,255,.15); color:rgba(240,240,242,.7);
  display:none; align-items:center; justify-content:center; font-size:.75rem;
  transition:background .15s; flex-shrink:0; margin-right:.1rem;
}
.ss-float-clear.visible { display:flex; }
.ss-float-clear:hover { background:rgba(255,255,255,.28); color:#f0f0f2; }
.ss-float-count {
  font-size:.7rem; font-weight:800; white-space:nowrap;
  padding:.25rem .6rem; border-radius:999px; margin-right:.35rem;
  background:rgba(212,240,0,.2); border:1px solid rgba(212,240,0,.3);
  color:#d4f000; flex-shrink:0;
}
@media (max-width:480px) { .ss-float-count { display:none; } }

.ss-src-tab {
  flex:1; height:2.5rem; font-size:.875rem; font-weight:600;
  border:none; background:none; cursor:pointer;
  color:hsl(var(--muted-foreground)); border-radius:.875rem;
  transition:background .15s,color .15s;
}
.ss-src-tab.active { background:hsl(var(--background)); color:hsl(var(--primary)); box-shadow:0 1px 4px rgba(0,0,0,.3); }

/* ── Filter modal ── */
.ss-filter-overlay { display:none; position:fixed; inset:0; z-index:200; background:rgba(0,0,0,.5); }
.ss-filter-overlay.open { display:flex; align-items:flex-end; }
.ss-filter-drawer { width:100%; background:hsl(var(--background)); border-radius:1.25rem 1.25rem 0 0; max-height:85vh; display:flex; flex-direction:column; animation:slideUp .22s ease; }
@keyframes slideUp { from { transform:translateY(100%); } to { transform:translateY(0); } }
@keyframes slideRight { from { transform:translateX(100%); } to { transform:translateX(0); } }
@media(min-width:640px) {
  .ss-filter-overlay.open { align-items:flex-start; justify-content:flex-end; }
  .ss-filter-drawer { width:360px; height:100%; max-height:none; border-radius:0; animation:slideRight .22s ease; }
}
.ss-filter-drawer-hdr { display:flex; align-items:center; justify-content:space-between; padding:.875rem 1rem .625rem; border-bottom:1px solid hsl(var(--border)/.4); flex-shrink:0; }
.ss-filter-drawer-body { overflow-y:auto; padding:.875rem 1rem; flex:1; display:flex; flex-direction:column; gap:1rem; }
.ss-filter-drawer-footer { display:flex; gap:.5rem; padding:.75rem 1rem max(1.25rem, env(safe-area-inset-bottom, 1.25rem)); border-top:1px solid hsl(var(--border)/.4); flex-shrink:0; }
.ss-filter-pill { display:flex; align-items:center; gap:.5rem; width:100%; padding:.625rem 1rem; border-radius:.875rem; border:1.5px solid hsl(var(--border)/.7); background:hsl(var(--muted)/.4); cursor:pointer; font-size:.875rem; font-weight:700; color:hsl(var(--foreground)); transition:background .15s; }
.ss-filter-pill.has-active { border-color:hsl(var(--primary)/.6); color:hsl(var(--primary)); }
.ss-filter-cnt { background:hsl(var(--primary)); color:#000; border-radius:999px; padding:.05rem .375rem; font-size:.68rem; font-weight:900; margin-left:auto; }
.ss-filters-bar { display:flex; flex-wrap:wrap; gap:.5rem .75rem; margin-bottom:.75rem; align-items:flex-start; }
.ss-filter-group { display:flex; flex-direction:column; gap:.3rem; }
.ss-filter-label { font-size:.65rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:hsl(var(--muted-foreground)); }
.ss-price-row { display:flex; align-items:center; gap:.35rem; }
.ss-price-inp {
  width:110px; padding:.3rem .5rem; border-radius:.5rem;
  background:hsl(var(--muted)/.4); border:1px solid hsl(var(--border)/.5);
  color:hsl(var(--foreground)); font-size:.8rem;
  outline:none; -moz-appearance:textfield;
}
.ss-price-inp::-webkit-outer-spin-button,
.ss-price-inp::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.ss-price-inp:focus { border-color:hsl(var(--primary)/.5); }
.ss-dim-inp { width:72px !important; }
.ss-price-sep { color:hsl(var(--muted-foreground)); font-size:.8rem; }
.ss-chips { display:flex; flex-wrap:wrap; gap:.3rem; }
.ss-chip {
  padding:.2rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700;
  background:hsl(var(--muted)/.4); border:1px solid hsl(var(--border)/.5);
  color:hsl(var(--foreground)/.8); cursor:pointer; transition:all .15s;
}
.ss-chip:hover { background:hsl(var(--primary)/.15); border-color:hsl(var(--primary)/.4); }
.ss-chip.active { background:hsl(var(--primary)/.2); border-color:hsl(var(--primary)/.6); color:hsl(var(--primary)); }
.ss-chip-reset {
  padding:.2rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700;
  background:hsl(0 60% 50%/.15); border:1px solid hsl(0 60% 50%/.3);
  color:hsl(0 60% 60%); cursor:pointer; align-self:flex-end;
}

.ss-grid {
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:.5rem;
}
@media (min-width:640px)  { .ss-grid{grid-template-columns:repeat(3,1fr);gap:.625rem;} }
@media (min-width:768px)  { .ss-grid{grid-template-columns:repeat(4,1fr);} }
@media (min-width:1024px) { .ss-grid{grid-template-columns:repeat(5,1fr);gap:.75rem;} }
@media (min-width:1280px) { .ss-grid{grid-template-columns:repeat(6,1fr);} }

/* ── Header classes ── */
.ss-hdr-inner {
  display:grid; grid-template-columns:1fr auto;
  align-items:center; height:3.5rem; padding:0 .75rem; gap:.5rem;
  max-width:1400px; margin:0 auto;
}
.ss-hdr-logo-cell { display:flex; align-items:center; gap:.5rem; overflow:hidden; min-width:0; }
.ss-hdr-logo-btn { background:none; border:none; cursor:pointer; padding:0; text-align:left; transition:opacity .15s; }
.ss-hdr-logo-btn:hover { opacity:.8; }
.ss-logo-img { width:2rem; height:2rem; border-radius:.5rem; object-fit:cover; flex-shrink:0; }
.ss-logo-init { width:2rem; height:2rem; border-radius:.5rem; background:linear-gradient(135deg,#00FFCC,#00CCAA); display:flex; align-items:center; justify-content:center; font-weight:900; font-size:.875rem; color:#000; flex-shrink:0; }
@media(min-width:640px) { .ss-logo-img,.ss-logo-init { width:2.5rem; height:2.5rem; border-radius:.625rem; font-size:1.1rem; } }
.ss-hdr-name { font-size:.95rem; font-weight:800; color:hsl(var(--foreground)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media(min-width:640px) { .ss-hdr-name { font-size:1.3rem; } }
/* Mobile: SimaStore on right, no contacts. Desktop: 3-column with contacts */
.ss-hdr-brand-cell { display:flex; align-items:center; white-space:nowrap; flex-shrink:0; }
.ss-hdr-contacts-cell { display:none; }
@media(min-width:640px) {
  .ss-hdr-inner { grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); padding:0 1rem; }
  .ss-hdr-brand-cell { justify-content:center; }
  .ss-hdr-contacts-cell { display:flex; align-items:center; gap:.4rem; justify-content:flex-end; overflow:hidden; min-width:0; }
}

/* ── Mobile contact bar ── */
.ss-mob-contacts { display:flex; gap:.5rem; overflow-x:auto; padding:.5rem .75rem .625rem; scrollbar-width:none; }
.ss-mob-contacts::-webkit-scrollbar { display:none; }
@media(min-width:640px) { .ss-mob-contacts { display:none; } }

.ss-contact {
  display:inline-flex; align-items:center; gap:.35rem;
  padding:.3rem .625rem; border-radius:999px; font-size:.75rem; font-weight:700;
  text-decoration:none; transition:opacity .15s; white-space:nowrap; flex-shrink:0;
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

const HEART_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

function renderCard(
  group: GroupedProduct,
  favs?: Set<string>,
  _variantMap?: Map<string, { items: VariantItem[]; groupId: string }>,
  showStock = false,
  _allGroups?: GroupedProduct[],
): string {
  const img = group.images[0] ?? null;
  const srcKeys = [...new Set(group.entries.map(e => e.source))];
  const badgesHtml = srcKeys.map(src =>
    `<span style="background:${BADGE_BG[src]??'rgba(100,100,100,.85)'};color:#fff;padding:.12rem .35rem;border-radius:999px;font-size:9px;font-weight:700">${BADGE[src]??src}</span>`
  ).join('');
  const isFav = favs?.has(group.key) ?? false;

  // Stock badge
  const stockHtml = showStock
    ? group.totalStock > 0
      ? `<div style="display:inline-flex;align-items:center;font-size:10px;font-weight:700;color:#44dd88;background:rgba(68,221,136,.12);padding:2px 7px;border-radius:6px;margin-top:4px">${group.totalStock} шт.</div>`
      : `<div style="display:inline-flex;align-items:center;font-size:10px;font-weight:700;color:#ff6b6b;background:rgba(255,107,107,.1);padding:2px 7px;border-radius:6px;margin-top:4px">нет в наличии</div>`
    : '';

  return `
<div class="ss-card" data-key="${esc(group.key)}">
  <div class="ss-card-img">
    ${img
      ? `<img src="${esc(img)}" alt="${esc(group.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')" style="display:block"><div style="display:none;width:100%;height:100%;align-items:center;justify-content:center;color:hsl(var(--foreground)/.15)"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:hsl(var(--foreground)/.15)"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>`}
    <div class="ss-card-grad"></div>
    <button class="ss-fav-btn${isFav?' active':''}" data-fav="${esc(group.key)}">${HEART_SVG}</button>
    <div style="position:absolute;top:.4rem;right:.4rem;display:flex;flex-direction:column;gap:.2rem;align-items:flex-end">${badgesHtml}</div>
  </div>
  <div class="ss-card-body">
    <div class="ss-card-title">${esc(group.title)}</div>
    ${stockHtml}
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

function contactLinksHtml(s: Settings): string {
  return [
    s.telegram ? `<a href="https://t.me/${esc(s.telegram.replace(/^@/,''))}" target="_blank" rel="noopener" class="ss-contact" style="color:rgb(38,160,218);background:rgba(38,160,218,.12);border:1px solid rgba(38,160,218,.25)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Telegram</a>` : '',
    s.whatsapp  ? `<a href="https://wa.me/${esc(s.whatsapp.replace(/\D/g,''))}" target="_blank" rel="noopener" class="ss-contact" style="color:rgb(37,211,102);background:rgba(37,211,102,.12);border:1px solid rgba(37,211,102,.25)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> WhatsApp</a>` : '',
    s.phone     ? `<a href="tel:${esc(s.phone.replace(/\s/g,''))}" class="ss-contact" style="color:rgb(99,179,120);background:rgba(99,179,120,.12);border:1px solid rgba(99,179,120,.25)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8 19.79 19.79 0 012 1.17 2 2 0 013.07 1a3.12 3.12 0 012 0h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L9.91 8.1a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg> Позвонить</a>` : '',
    s.website   ? `<a href="${esc(s.website.startsWith('http')?s.website:'https://'+s.website)}" target="_blank" rel="noopener" class="ss-contact" style="color:hsl(var(--primary));background:hsl(var(--primary)/.1);border:1px solid hsl(var(--border))"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg> Сайт</a>` : '',
  ].filter(Boolean).join('');
}

function headerHtml(s: Settings, showBack: boolean, _backLabel = 'Назад'): string {
  const logoHtml = s.logo_url
    ? `<img src="${esc(s.logo_url)}" alt="logo" class="ss-logo-img">`
    : `<div class="ss-logo-init">${esc(s.store_name.charAt(0).toUpperCase())}</div>`;

  const contacts = contactLinksHtml(s);

  const logoCell = showBack
    ? `<button id="ss-back-to-home" class="ss-hdr-logo-cell ss-hdr-logo-btn">
        ${logoHtml}
        <span class="ss-hdr-name">${esc(s.store_name)}</span>
      </button>`
    : `<div class="ss-hdr-logo-cell">
        ${logoHtml}
        <span class="ss-hdr-name">${esc(s.store_name)}</span>
      </div>`;

  return `
<header class="nav-modern" style="position:sticky;top:0;z-index:50">
  <div class="ss-hdr-inner">
    ${logoCell}
    <span class="ss-header-brand ss-hdr-brand-cell" style="font-size:1.1rem;padding:0 .25rem;white-space:nowrap">SimaStore</span>
    ${contacts ? `<div class="ss-hdr-contacts-cell">${contacts}</div>` : ''}
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
    <div class="ss-hiw-steps">
      <div class="ss-hiw-line"></div>
      ${steps.map((s,i) => `
      <div class="ss-hiw-step-card" style="animation:slideInScale .5s cubic-bezier(.34,1.56,.64,1) ${i*.1}s both">
        <div class="ss-hiw-icon-wrap" style="background:${s.grad};box-shadow:0 6px 20px rgba(0,0,0,.3)">
          <span style="position:relative;z-index:1;display:flex;align-items:center;justify-content:center">${s.icon}</span>
          <div class="ss-hiw-num" style="background:${s.num_bg}">${s.n}</div>
        </div>
        <h3 style="font-size:.875rem;font-weight:800;color:hsl(var(--foreground))">${s.title}</h3>
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
            <div style="font-size:.875rem;font-weight:800;color:hsl(var(--foreground))">${s.title}</div>
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

function mountHomePage(root: HTMLElement, data: StoreData, _slug: string, groups: GroupedProduct[], onCatalog: (groupFilter?: string) => void, _variantMap?: Map<string, { items: VariantItem[]; groupId: string }>, _showStock = false): (() => void) | null {
  const { settings: s, banners } = data;
  const storeGroups = (data.groups ?? []).filter(g => g.vendor_codes && g.vendor_codes.length > 0);
  const RECOMMENDED_COUNT = 12;
  const featured = groups.length > RECOMMENDED_COUNT ? shuffleSlice(groups, RECOMMENDED_COUNT) : [...groups];
  const mobContacts = contactLinksHtml(s);

  document.title = s.store_name;
  if (s.logo_url) setFavicon(s.logo_url);

  root.innerHTML = `
<div style="min-height:100vh;background:hsl(var(--background));color:hsl(var(--foreground))">
  ${headerHtml(s, false)}

  ${mobContacts ? `<div class="ss-mob-contacts">${mobContacts}</div>` : ''}

  ${banners.length > 0 ? `
  <div style="padding:1.25rem 0 .75rem">
    <div style="max-width:1400px;margin:0 auto;padding:0 .75rem" id="ss-banner-area"></div>
  </div>` : ''}

  <section style="padding:.75rem 0 .5rem">
    <div style="max-width:1400px;margin:0 auto;padding:0 .75rem">
      ${featured.length > 0 ? `
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.625rem">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:hsl(var(--primary))"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        <span style="font-size:.875rem;font-weight:700;color:hsl(var(--foreground))">Рекомендуем</span>
      </div>
      <div class="ss-rec-wrap" id="ss-rec-carousel">
        <div class="ss-rec-track" id="ss-rec-track"></div>
      </div>` : `
      <div style="text-align:center;padding:3rem 1rem">
        <div style="display:flex;justify-content:center;margin-bottom:.75rem;color:hsl(var(--foreground)/.2)"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg></div>
        <h3 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">Товары появятся скоро</h3>
        <p style="color:hsl(var(--muted-foreground));font-size:.875rem">Магазин пока пустой, загляните позже</p>
      </div>`}

      ${storeGroups.length > 0 ? `
      <div style="padding:1.25rem 0 .25rem">
        <div style="font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:hsl(var(--muted-foreground));margin-bottom:.625rem">Разделы</div>
        <div class="ss-groups-row" id="ss-home-groups">
          ${storeGroups.map(g => `
          <button class="ss-group-chip" data-gid="${esc(g.id)}" title="${esc(g.name)}">
            ${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" class="ss-group-chip-img">` : `<div class="ss-group-chip-ph">${esc(g.name.charAt(0).toUpperCase())}</div>`}
            <span class="ss-group-chip-lbl">${esc(g.name)}</span>
          </button>`).join('')}
        </div>
      </div>` : ''}

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

  let bannerCarousel: Carousel|null = null;
  if (banners.length > 0) {
    const area = document.getElementById('ss-banner-area');
    if (area) bannerCarousel = new Carousel(area, banners);
  }

  document.getElementById('ss-to-catalog')?.addEventListener('click', () => onCatalog());
  document.getElementById('ss-home-groups')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.ss-group-chip') as HTMLElement|null;
    if (!btn) return;
    onCatalog(btn.dataset.gid!);
  });

  // Rec carousel animation
  let recRaf = 0;
  const track = document.getElementById('ss-rec-track');
  const featuredWithPhoto = featured.filter(g => g.images[0]);
  if (track && featuredWithPhoto.length > 0) {
    const items = [...featuredWithPhoto, ...featuredWithPhoto];
    track.innerHTML = items.map(g => {
      const img = g.images[0] ?? null;
      return `<div class="ss-card" data-key="${esc(g.key)}" data-from-home="1">
  <div class="ss-card-img">
    ${img
      ? `<img src="${esc(img)}" alt="${esc(g.title)}" loading="lazy" style="display:block">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:hsl(var(--foreground)/.15)"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg></div>`}
    <div class="ss-card-grad"></div>
  </div>
  <div class="ss-card-body">
    <div class="ss-card-title">${esc(g.title)}</div>
  </div>
</div>`;
    }).join('');

    const trackEl = track;
    requestAnimationFrame(() => {
      if (!trackEl.isConnected) return;
      const singleWidth = trackEl.scrollWidth / 2;
      let pos = 0;
      const speed = 0.5;
      function tick() {
        if (!trackEl.isConnected) return;
        pos += speed;
        if (pos >= singleWidth) pos -= singleWidth;
        trackEl.style.transform = `translateX(-${pos}px)`;
        recRaf = requestAnimationFrame(tick);
      }
      recRaf = requestAnimationFrame(tick);
      const wrap = document.getElementById('ss-rec-carousel');
      wrap?.addEventListener('mouseenter', () => cancelAnimationFrame(recRaf));
      wrap?.addEventListener('mouseleave', () => { recRaf = requestAnimationFrame(tick); });
    });
  }

  return () => {
    bannerCarousel?.destroy();
    cancelAnimationFrame(recRaf);
  };
}

// ─── Catalog view ─────────────────────────────────────────────────────────────

function mountCatalogPage(root: HTMLElement, data: StoreData, _slug: string, allGroups: GroupedProduct[], onBack: () => void, variantMap?: Map<string, { items: VariantItem[]; groupId: string }>, showStock = false, initialGroupId?: string): void {
  const { settings: s } = data;
  document.title = `Каталог — ${s.store_name}`;

  // If a group filter was pre-selected, narrow the product list
  let groups = allGroups;
  if (initialGroupId) {
    const sg = (data.groups ?? []).find(g => g.id === initialGroupId);
    if (sg && sg.vendor_codes.length > 0) {
      const vcSet = new Set(sg.vendor_codes.map(v => v.trim().toLowerCase()));
      groups = allGroups.filter(g => {
        const vc = g.entries[0]?.vendor_code?.trim().toLowerCase() ?? '';
        return vcSet.has(vc) || vcSet.has(g.key.replace(/^[vs]:/, ''));
      });
    }
  }

  const hasSrc = (src: string) => groups.some(g => g.entries.some(e => e.source === src));

  root.innerHTML = `
<div style="min-height:100vh;background:hsl(var(--background));color:hsl(var(--foreground))">
  ${headerHtml(s, true, 'Главная')}

  <div style="max-width:1400px;margin:0 auto;padding:.75rem .75rem 4rem">

    <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem;flex-wrap:wrap">
      <h1 style="font-size:clamp(1.25rem,5vw,2rem);font-weight:900;text-transform:uppercase;letter-spacing:-.01em;color:hsl(var(--foreground));margin:0">${initialGroupId ? esc((data.groups ?? []).find(g => g.id === initialGroupId)?.name ?? 'Каталог') : 'Каталог'}</h1>
      <span id="ss-count" style="padding:.2rem .625rem;border-radius:999px;font-size:.75rem;font-weight:800;background:hsl(var(--primary)/.1);border:1px solid hsl(var(--primary)/.2);color:hsl(var(--primary))">${groups.length}</span>
      <button class="ss-fav-header-btn" id="ss-favs-toggle" style="margin-left:auto">
        ${HEART_SVG}
        <span id="ss-favs-count">Избранное</span>
      </button>
    </div>

    <div id="ss-search-anchor" style="margin-bottom:.75rem">
      <div style="position:relative;margin-bottom:.5rem">
        <svg style="position:absolute;left:.75rem;top:50%;transform:translateY(-50%);width:1rem;height:1rem;color:hsl(var(--foreground)/.4);pointer-events:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input id="ss-search" type="search" placeholder="Поиск товаров..." class="ss-search">
      </div>
      <div style="display:flex;gap:.5rem;padding:.375rem;background:hsl(var(--muted)/.5);border-radius:1rem;border:1px solid hsl(var(--border)/.4)">
        <button class="ss-src-tab active" data-src="all">Все</button>
        ${hasSrc('wb')     ? `<button class="ss-src-tab" data-src="wb">WB</button>` : ''}
        ${hasSrc('ozon')   ? `<button class="ss-src-tab" data-src="ozon">Ozon</button>` : ''}
        ${hasSrc('yandex') ? `<button class="ss-src-tab" data-src="yandex">Яндекс</button>` : ''}
      </div>
    </div>

    <div id="ss-filter-trigger-row" style="margin-bottom:.75rem"></div>

    <div class="ss-grid" id="ss-cat-grid">${renderSkeletons(12)}</div>
  </div>

  <footer style="text-align:center;padding:1.5rem;font-size:.75rem;color:hsl(var(--muted-foreground));border-top:1px solid hsl(var(--border)/.4)">
    Powered by <a href="https://simadesk.ru" style="color:hsl(var(--primary));font-weight:700;text-decoration:none">SimaDesk</a>
  </footer>

  <div class="ss-filter-overlay" id="ss-filter-overlay">
    <div class="ss-filter-drawer">
      <div class="ss-filter-drawer-hdr">
        <span style="font-size:1rem;font-weight:800">Фильтры</span>
        <button id="ss-filter-close" style="background:none;border:none;cursor:pointer;color:hsl(var(--foreground));font-size:1.25rem;padding:.25rem .5rem;border-radius:.4rem">✕</button>
      </div>
      <div class="ss-filter-drawer-body" id="ss-filters-bar"></div>
      <div class="ss-filter-drawer-footer">
        <button id="sf-reset" style="flex:1;padding:.65rem;border-radius:.75rem;border:1.5px solid hsl(var(--border)/.6);background:none;cursor:pointer;font-weight:700;font-size:.875rem;color:hsl(var(--foreground))">Сбросить</button>
        <button id="ss-filter-apply" style="flex:2;padding:.65rem;border-radius:.75rem;border:none;background:hsl(var(--primary));cursor:pointer;font-weight:800;font-size:.875rem;color:#000">Применить</button>
      </div>
    </div>
  </div>
</div>`;

  const PAGE_SIZE = 24;
  let currentSrc  = 'all';
  let searchQ     = '';
  let currentPage = 0;
  let lazyObserver: IntersectionObserver | null = null;
  let filterPriceMin: number | null = null;
  let filterPriceMax: number | null = null;
  let filterBrand   = '';
  let filterCat     = '';
  let filterH: number | null = null;
  let filterW: number | null = null;
  let filterL: number | null = null;
  let filterKg: number | null = null;
  let filterStock: 'instock' | 'oos' | '' = '';

  // Restore filter state from URL on load
  {
    const qp = new URLSearchParams(location.search);
    const pn = (k: string) => { const v = qp.get(k); return v ? Number(v) || null : null; };
    filterPriceMin = pn('pmin');
    filterPriceMax = pn('pmax');
    filterBrand    = qp.get('brand') || '';
    filterCat      = qp.get('cat')   || '';
    filterH        = pn('h');
    filterW        = pn('w');
    filterL        = pn('l');
    filterKg       = pn('kg');
    const sv = qp.get('stock') || '';
    filterStock = (sv === 'instock' || sv === 'oos') ? sv : '';
  }

  function updateFilterUrl(): void {
    const qp = new URLSearchParams();
    if (filterPriceMin != null) qp.set('pmin', String(filterPriceMin));
    if (filterPriceMax != null) qp.set('pmax', String(filterPriceMax));
    if (filterBrand)            qp.set('brand', filterBrand);
    if (filterCat)              qp.set('cat',   filterCat);
    if (filterH  != null)       qp.set('h',  String(filterH));
    if (filterW  != null)       qp.set('w',  String(filterW));
    if (filterL  != null)       qp.set('l',  String(filterL));
    if (filterKg != null)       qp.set('kg', String(filterKg));
    if (filterStock)            qp.set('stock', filterStock);
    const qs = qp.toString();
    history.replaceState({}, '', `/${_slug}/catalog${qs ? '?' + qs : ''}`);
  }

  // ── Favourites ────────────────────────────────────────────────────────────────
  const FAV_KEY = `ss-favs-${_slug}`;
  const favs = new Set<string>(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
  let showFavsOnly = false;

  function saveFavs(): void {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  }

  function updateFavHeaderBtn(): void {
    const btn = document.getElementById('ss-favs-toggle');
    const lbl = document.getElementById('ss-favs-count');
    if (!btn) return;
    btn.classList.toggle('active', showFavsOnly);
    if (lbl) lbl.textContent = favs.size > 0 ? `Избранное (${favs.size})` : 'Избранное';
  }

  function toggleFav(key: string, el?: HTMLElement | null): void {
    if (favs.has(key)) favs.delete(key); else favs.add(key);
    saveFavs();
    // Update all card hearts in the grid
    document.querySelectorAll<HTMLElement>(`.ss-fav-btn[data-fav="${CSS.escape(key)}"]`).forEach(btn => {
      btn.classList.toggle('active', favs.has(key));
      btn.classList.remove('pop');
      void btn.offsetWidth; // reflow to restart animation
      btn.classList.add('pop');
    });
    if (el) {
      el.classList.toggle('active', favs.has(key));
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
    updateFavHeaderBtn();
    if (showFavsOnly) refreshGrid();
  }
  _sharedFavs = favs;
  _sharedToggleFav = toggleFav;
  // ─────────────────────────────────────────────────────────────────────────────

  const hasDims = groups.some(g => g.height_cm || g.width_cm || g.length_cm || g.weight_kg);

  const allBrands     = [...new Set(groups.map(g => g.brand).filter((b): b is string => !!b))].sort();
  const allCategories = [...new Set(groups.map(g => g.category).filter((c): c is string => !!c))].sort();

  const anyPriceVisible = groups.some(g => g.entries.some(e => e.custom_price != null));
  const showPrice = s.show_price_filter !== false && anyPriceVisible;
  const showBrand = !!s.show_brand_filter && allBrands.length > 1;
  const showCat   = !!s.show_category_filter && allCategories.length > 1;
  const hideOos = !!s.hide_out_of_stock;
  const showStockFilter = showStock && !hideOos;

  const hasAnyFilter = showPrice || showBrand || showCat || hasDims || showStockFilter;

  function activeFilterCount(): number {
    return [filterPriceMin, filterPriceMax, filterBrand || null, filterCat || null,
            filterH, filterW, filterL, filterKg, filterStock || null].filter(v => v != null).length;
  }

  function renderFiltersBar(): void {
    // Update pill button
    const triggerRow = document.getElementById('ss-filter-trigger-row');
    if (triggerRow && hasAnyFilter) {
      const cnt = activeFilterCount();
      triggerRow.innerHTML = `
        <button class="ss-filter-pill${cnt > 0 ? ' has-active' : ''}" id="ss-open-filters">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          Фильтры${cnt > 0 ? `<span class="ss-filter-cnt">${cnt}</span>` : ''}
        </button>
        ${filterBrand ? `<button class="ss-chip active" data-brand="${esc(filterBrand)}">${esc(filterBrand)} ×</button>` : ''}
        ${filterCat   ? `<button class="ss-chip active" data-cat="${esc(filterCat)}">${esc(filterCat)} ×</button>` : ''}`;
    }
    // Update modal body
    const bar = document.getElementById('ss-filters-bar');
    if (!bar) return;
    bar.innerHTML = `
      ${showPrice ? `<div class="ss-filter-group">
        <div class="ss-filter-label">Цена, ₽</div>
        <div class="ss-price-row">
          <input class="ss-price-inp" id="sf-pmin" type="text" inputmode="numeric" placeholder="от" value="${filterPriceMin ?? ''}">
          <span class="ss-price-sep">—</span>
          <input class="ss-price-inp" id="sf-pmax" type="text" inputmode="numeric" placeholder="до" value="${filterPriceMax ?? ''}">
        </div>
      </div>` : ''}
      ${hasDims ? `<div class="ss-filter-group">
        <div class="ss-filter-label">Габариты (макс.), см / кг</div>
        <div class="ss-price-row" style="gap:.3rem;flex-wrap:wrap">
          <input class="ss-price-inp ss-dim-inp" id="sf-h" type="text" inputmode="numeric" placeholder="В, см" value="${filterH ?? ''}">
          <input class="ss-price-inp ss-dim-inp" id="sf-w" type="text" inputmode="numeric" placeholder="Ш, см" value="${filterW ?? ''}">
          <input class="ss-price-inp ss-dim-inp" id="sf-l" type="text" inputmode="numeric" placeholder="Д, см" value="${filterL ?? ''}">
          <input class="ss-price-inp ss-dim-inp" id="sf-kg" type="text" inputmode="decimal" placeholder="кг" value="${filterKg ?? ''}">
        </div>
      </div>` : ''}
      ${showBrand ? `<div class="ss-filter-group">
        <div class="ss-filter-label">Бренд</div>
        <div class="ss-chips">
          ${allBrands.map(b => `<button class="ss-chip${filterBrand===b?' active':''}" data-brand="${esc(b)}">${esc(b)}</button>`).join('')}
        </div>
      </div>` : ''}
      ${showCat ? `<div class="ss-filter-group">
        <div class="ss-filter-label">Категория</div>
        <div class="ss-chips">
          ${allCategories.map(c => `<button class="ss-chip${filterCat===c?' active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
      </div>` : ''}
      ${showStockFilter ? `<div class="ss-filter-group">
        <div class="ss-filter-label">Наличие</div>
        <div class="ss-chips">
          <button class="ss-chip${filterStock==='instock'?' active':''}" data-stock="instock">В наличии</button>
          <button class="ss-chip${filterStock==='oos'?' active':''}" data-stock="oos">Нет в наличии</button>
        </div>
      </div>` : ''}`;
  }

  function openFilterModal(): void {
    renderFiltersBar();
    document.getElementById('ss-filter-overlay')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeFilterModal(): void {
    document.getElementById('ss-filter-overlay')?.classList.remove('open');
    document.body.style.overflow = '';
  }

  function filtered(): GroupedProduct[] {
    const q = searchQ.trim().toLowerCase();
    return groups.filter(g => {
      const matchSrc   = currentSrc === 'all' || g.entries.some(e => e.source === currentSrc);
      const matchQ     = !q || g.title.toLowerCase().includes(q) || g.vendor_code.toLowerCase().includes(q) ||
                         g.entries.some(e => e.title.toLowerCase().includes(q));
      const matchPMin  = filterPriceMin == null || g.price_max >= filterPriceMin;
      const matchPMax  = filterPriceMax == null || g.price_min <= filterPriceMax;
      const matchBrand = !filterBrand || (g.brand ?? '') === filterBrand;
      const matchCat   = !filterCat   || (g.category ?? '') === filterCat;
      const matchH     = filterH  == null || !g.height_cm || g.height_cm  <= filterH;
      const matchW     = filterW  == null || !g.width_cm  || g.width_cm   <= filterW;
      const matchL     = filterL  == null || !g.length_cm || g.length_cm  <= filterL;
      const matchKg    = filterKg == null || !g.weight_kg || g.weight_kg  <= filterKg;
      const matchFavs  = !showFavsOnly || favs.has(g.key);
      const matchStock = !filterStock || (filterStock === 'instock' ? g.totalStock > 0 : g.totalStock === 0);
      return matchSrc && matchQ && matchPMin && matchPMax && matchBrand && matchCat && matchH && matchW && matchL && matchKg && matchFavs && matchStock;
    });
  }

  function renderPage(f: GroupedProduct[], page: number, grid: HTMLElement): void {
    const start = page * PAGE_SIZE;
    const slice = f.slice(start, start + PAGE_SIZE);
    if (page === 0) {
      grid.innerHTML = slice.map(g => renderCard(g, favs, variantMap, showStock, allGroups)).join('');
    } else {
      slice.forEach(g => { grid.insertAdjacentHTML('beforeend', renderCard(g, favs, variantMap, showStock, allGroups)); });
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

  requestAnimationFrame(() => { renderFiltersBar(); refreshGrid(); });

  // ── Floating glass search bar ─────────────────────────────────────────────
  const floatBar = document.createElement('div');
  floatBar.className = 'ss-float-bar';
  floatBar.innerHTML = `
    <div style="position:relative;flex:1">
      <svg class="ss-float-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <input id="ss-float-inp" class="ss-float-inp" type="search" placeholder="Поиск в каталоге…" autocomplete="off">
    </div>
    <button id="ss-float-clear" class="ss-float-clear" aria-label="Сбросить">✕</button>
    <span id="ss-float-count" class="ss-float-count">${groups.length}</span>`;
  document.body.appendChild(floatBar);

  let floatVisible = false;
  const floatInp   = document.getElementById('ss-float-inp')   as HTMLInputElement;
  const floatClear = document.getElementById('ss-float-clear') as HTMLButtonElement;
  const floatCount = document.getElementById('ss-float-count') as HTMLElement;

  const syncCount = () => { floatCount.textContent = String(filtered().length); };

  const obs = new IntersectionObserver(([entry]) => {
    const show = !entry.isIntersecting;
    if (show === floatVisible) return;
    floatVisible = show;
    floatBar.classList.remove('visible', 'hiding');
    if (show) {
      floatBar.classList.add('visible');
      floatInp.value = searchQ;
      floatClear.classList.toggle('visible', !!searchQ);
      syncCount();
    } else {
      floatBar.classList.add('hiding');
      floatBar.addEventListener('animationend', () => {
        if (!floatVisible) floatBar.classList.remove('hiding');
      }, { once: true });
    }
  }, { threshold: 0, rootMargin: '-56px 0px 0px 0px' });

  obs.observe(document.getElementById('ss-search-anchor') ?? document.body);

  floatInp.addEventListener('input', () => {
    searchQ = floatInp.value;
    const m = document.getElementById('ss-search') as HTMLInputElement | null;
    if (m) m.value = searchQ;
    floatClear.classList.toggle('visible', !!searchQ);
    syncCount(); refreshGrid();
  });

  floatClear.addEventListener('click', () => {
    searchQ = ''; floatInp.value = '';
    const m = document.getElementById('ss-search') as HTMLInputElement | null;
    if (m) m.value = '';
    floatClear.classList.remove('visible');
    syncCount(); refreshGrid();
  });
  // ─────────────────────────────────────────────────────────────────────────

  document.getElementById('ss-search')?.addEventListener('input', (e) => {
    searchQ = (e.target as HTMLInputElement).value;
    if (floatVisible) { floatInp.value = searchQ; floatClear.classList.toggle('visible', !!searchQ); syncCount(); }
    refreshGrid();
  });

  document.getElementById('ss-back-to-home')?.addEventListener('click', () => {
    obs.disconnect(); floatBar.remove(); onBack();
  });

  // Numeric filter inputs (debounced) — do NOT re-render filter bar on input
  // to avoid destroying focus while user is typing
  let filterTimer = 0;
  root.addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement;
    const id = inp.id;
    if (!['sf-pmin','sf-pmax','sf-h','sf-w','sf-l','sf-kg'].includes(id)) return;
    // Strip non-numeric characters except dots/commas
    inp.value = inp.value.replace(/[^0-9.,]/g, '');
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
      const v = inp.value ? Number(inp.value.replace(',', '.')) : null;
      if (id === 'sf-pmin') filterPriceMin = v;
      if (id === 'sf-pmax') filterPriceMax = v;
      if (id === 'sf-h')    filterH  = v;
      if (id === 'sf-w')    filterW  = v;
      if (id === 'sf-l')    filterL  = v;
      if (id === 'sf-kg')   filterKg = v;
      updateFilterUrl();
      refreshGrid(); // don't call renderFiltersBar() — it destroys focus
    }, 500);
  });

  requestAnimationFrame(() => updateFavHeaderBtn());

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;

    // Favourites toggle (header button)
    if (t.closest('#ss-favs-toggle')) {
      showFavsOnly = !showFavsOnly;
      updateFavHeaderBtn();
      refreshGrid();
      return;
    }

    // Heart button on card
    const favBtn = t.closest('.ss-fav-btn') as HTMLElement|null;
    if (favBtn) {
      e.stopPropagation();
      toggleFav(favBtn.dataset.fav!, favBtn);
      return;
    }

    // Open filter modal
    if (t.closest('#ss-open-filters')) { openFilterModal(); return; }

    // Close filter modal (close btn or backdrop)
    if (t.id === 'ss-filter-close' || t.id === 'ss-filter-apply') { closeFilterModal(); updateFilterUrl(); renderFiltersBar(); return; }
    if (t.id === 'ss-filter-overlay') { closeFilterModal(); updateFilterUrl(); renderFiltersBar(); return; }

    // Brand chip
    const brandChip = t.closest('[data-brand]') as HTMLElement|null;
    if (brandChip) {
      const b = brandChip.dataset.brand!;
      filterBrand = filterBrand === b ? '' : b;
      updateFilterUrl(); renderFiltersBar(); refreshGrid(); return;
    }
    // Category chip
    const catChip = t.closest('[data-cat]') as HTMLElement|null;
    if (catChip) {
      const c = catChip.dataset.cat!;
      filterCat = filterCat === c ? '' : c;
      updateFilterUrl(); renderFiltersBar(); refreshGrid(); return;
    }
    // Stock chip
    const stockChip = t.closest('[data-stock]') as HTMLElement|null;
    if (stockChip) {
      const sv = stockChip.dataset.stock as 'instock' | 'oos';
      filterStock = filterStock === sv ? '' : sv;
      updateFilterUrl(); renderFiltersBar(); refreshGrid(); return;
    }
    // Reset
    if (t.id === 'sf-reset') {
      filterPriceMin = null; filterPriceMax = null;
      filterBrand = ''; filterCat = ''; filterStock = '';
      filterH = null; filterW = null; filterL = null; filterKg = null;
      updateFilterUrl(); renderFiltersBar(); refreshGrid(); return;
    }

    const tab = t.closest('.ss-src-tab') as HTMLElement|null;
    if (tab && tab.dataset.src) {
      root.querySelectorAll('.ss-src-tab').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      currentSrc = tab.dataset.src;
      refreshGrid();
      return;
    }
  });
}

// ─── Detail overlay ───────────────────────────────────────────────────────────

// Shared favorites refs — set by mountCatalogPage, read by openProduct in init()
let _sharedFavs: Set<string> | undefined;
let _sharedToggleFav: ((key: string, el?: HTMLElement|null) => void) | undefined;

// Brand colors for each marketplace
const MKT_COLOR: Record<string, string> = {
  wb:     'background:#CB11AB;color:#fff;border:none;box-shadow:0 4px 16px rgba(203,17,171,.3)',
  ozon:   'background:#005BFF;color:#fff;border:none;box-shadow:0 4px 16px rgba(0,91,255,.3)',
  yandex: 'background:#FDE100;color:#000;border:none;box-shadow:0 4px 16px rgba(253,225,0,.35)',
};

function openDetail(
  group: GroupedProduct, allGroups: GroupedProduct[], slug: string, onClose: () => void,
  favs?: Set<string>, toggleFav?: (key: string, el?: HTMLElement|null) => void,
  variantMap?: Map<string, { items: VariantItem[]; groupId: string }>, showStock = false
): void {
  const imgs = group.images;

  // Build brand-colored buy buttons for all entries
  const mktBtn = (entry: typeof group.entries[0]) => {
    const url   = buildEntryUrl(entry);
    const label = BUY_LABEL[entry.source] ?? 'Купить';
    const style = MKT_COLOR[entry.source] ?? '';
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="ss-btn-pri" style="${style}">${label} ↗</a>`;
  };
  const buyButtonsHtml = group.entries.map(mktBtn).join('');

  // Custom URL button (extra "buy on website" button)
  const customEntry = group.entries.find(e => e.custom_url && e.custom_url.trim());
  const customBtnHtml = customEntry?.custom_url
    ? `<a href="${esc(customEntry.custom_url)}" target="_blank" rel="noopener noreferrer" class="ss-btn-sec" style="border-color:hsl(var(--primary)/.4);color:hsl(var(--primary));font-weight:800;display:flex;align-items:center;gap:.4rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg> Купить у продавца ↗
      </a>`
    : '';


  const related = allGroups
    .filter(g => g.key !== group.key)
    .sort(() => Math.random() - 0.5)
    .slice(0, 6);

  // Stock badge for detail panel — per-marketplace breakdown
  const MKT_LABEL: Record<string, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'Яндекс' };
  const stockHtmlDet = showStock
    ? group.totalStock > 0
      ? (() => {
          const parts = group.entries
            .filter(e => (e.stock ?? 0) > 0)
            .map(e => `${MKT_LABEL[e.source] ?? e.source}: ${e.stock ?? 0} шт.`)
            .join(' · ');
          return `<div style="display:inline-flex;align-items:center;gap:.35rem;margin-top:.5rem;padding:.35rem .65rem;border-radius:.5rem;background:hsl(142 72% 29% / .15);border:1px solid hsl(142 72% 29% / .3);font-size:.8rem;font-weight:700;color:hsl(142 72% 45%)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          ${parts || `В наличии: ${group.totalStock} шт.`}
        </div>`;
        })()
      : `<div style="display:inline-flex;align-items:center;gap:.35rem;margin-top:.5rem;padding:.35rem .65rem;border-radius:.5rem;background:hsl(var(--muted)/.4);font-size:.8rem;font-weight:700;color:hsl(var(--muted-foreground))">Нет в наличии</div>`
    : '';

  // Variant buttons for detail panel
  let variantsBtnsDet = '';
  if (variantMap) {
    const vg = variantMap.get(group.key);
    if (vg && vg.items.length > 1) {
      const btns = vg.items.map(it => {
        const itKey = `v:${it.vendor_code.trim().toLowerCase()}`;
        const isActive = itKey === group.key;
        const targetGroup = allGroups.find(g => g.key === itKey);
        const inStock = showStock ? (targetGroup?.totalStock ?? 0) : 1;
        const noTarget = !targetGroup;
        const oos = showStock && inStock === 0;
        // Color parsing: supports "color1|color2" for diagonal split
        const rawColor = (it.color ?? '').trim();
        const isNoColor = !rawColor || rawColor === '#888888';
        let btnStyle = '';
        if (!isNoColor) {
          const parts = rawColor.split('|');
          btnStyle = parts.length >= 2
            ? `background:linear-gradient(135deg,${parts[0].trim()} 50%,${parts[1].trim()} 50%)`
            : `background:${rawColor}`;
        }
        const stockLabel = showStock && targetGroup ? (inStock > 0 ? ` · ${inStock} шт.` : ' · нет') : '';
        const tooltip = `${targetGroup?.title ?? it.label}${stockLabel}`;
        return `<button
          class="ss-det-var-btn${isActive ? ' active' : ''}${(noTarget || oos) ? ' disabled' : ''}${!isNoColor ? ' has-color' : ''}"
          data-var-key="${esc(itKey)}"
          ${btnStyle ? `style="${btnStyle}"` : ''}
          title="${esc(tooltip)}"
          ${noTarget ? 'disabled' : ''}
        >${esc(it.label)}</button>`;
      }).join('');
      variantsBtnsDet = `
        <div style="margin:.875rem 0 .25rem">
          <div style="font-size:.7rem;font-weight:700;color:hsl(var(--muted-foreground));text-transform:uppercase;letter-spacing:.07em;margin-bottom:.5rem">Вариант</div>
          <div style="display:flex;flex-wrap:wrap;gap:.375rem">${btns}</div>
        </div>`
    }
  }

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
            ${imgs.length > 1 ? `
            <button class="ss-gal-nav ss-gal-nav-prev" id="ss-gal-prev" aria-label="Предыдущее фото">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="ss-gal-nav ss-gal-nav-next" id="ss-gal-next" aria-label="Следующее фото">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>` : ''}
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
      ${stockHtmlDet}
      ${variantsBtnsDet}
      <div class="ss-meta"></div>
      <div class="ss-buy-col" id="ss-buy-desktop">
        ${buyButtonsHtml}
        ${customBtnHtml}
        ${favs !== undefined ? `<button class="ss-det-fav-btn${favs.has(group.key)?' active':''}" id="ss-det-fav">${HEART_SVG}${favs.has(group.key) ? 'В избранном' : 'В избранное'}</button>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:.25rem;margin-top:.5rem">
        ${group.vendor_code ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0;border-bottom:1px solid hsl(var(--border)/.3)"><span style="color:hsl(var(--muted-foreground))">Артикул</span><span style="font-weight:600">${esc(group.vendor_code)}</span></div>` : ''}
        ${group.brand ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0;border-bottom:1px solid hsl(var(--border)/.3)"><span style="color:hsl(var(--muted-foreground))">Бренд</span><span style="font-weight:600">${esc(group.brand)}</span></div>` : ''}
        ${group.weight_kg  ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0;border-bottom:1px solid hsl(var(--border)/.3)"><span style="color:hsl(var(--muted-foreground))">Вес</span><span style="font-weight:600">${group.weight_kg} кг</span></div>` : ''}
        ${(group.length_cm || group.width_cm || group.height_cm) ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0;border-bottom:1px solid hsl(var(--border)/.3)"><span style="color:hsl(var(--muted-foreground))">Габариты (ДxШxВ)</span><span style="font-weight:600">${[group.length_cm,group.width_cm,group.height_cm].map(v=>v??'—').join(' × ')} см</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0">
          <span style="color:hsl(var(--muted-foreground))">Площадки</span>
          <span style="font-weight:600">${[...new Set(group.entries.map(e => BADGE[e.source]??e.source))].join(', ')}</span>
        </div>
      </div>
    </div>
  </div>

  ${related.length > 0 ? `
  <div style="margin-top:2rem">
    <h2 style="font-size:1rem;font-weight:800;margin-bottom:.75rem;color:hsl(var(--foreground))">Ещё товары</h2>
    <div class="ss-grid">${related.map(g => renderCard(g, favs, variantMap, showStock, allGroups)).join('')}</div>
  </div>` : ''}
</div>

`;

  document.body.appendChild(panel);
  requestAnimationFrame(() => requestAnimationFrame(() => { panel.classList.add('open'); }));

  // Gallery sync
  const galMain = panel.querySelector('#ss-gal-main') as HTMLElement|null;
  if (galMain && imgs.length > 1) {
    let galIdx = 0;
    const syncIdx = (idx: number) => {
      galIdx = idx;
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
    panel.querySelector('#ss-gal-prev')?.addEventListener('click', () => {
      const idx = (galIdx - 1 + imgs.length) % imgs.length;
      galMain.scrollTo({ left: idx * galMain.clientWidth, behavior:'smooth' });
      syncIdx(idx);
    });
    panel.querySelector('#ss-gal-next')?.addEventListener('click', () => {
      const idx = (galIdx + 1) % imgs.length;
      galMain.scrollTo({ left: idx * galMain.clientWidth, behavior:'smooth' });
      syncIdx(idx);
    });

    // Touch swipe on gallery
    let galTouchX = 0, galTouchY = 0, galTouchLocked = false, galTouchIsH = false;
    galMain.addEventListener('touchstart', (e: TouchEvent) => {
      galTouchX = e.changedTouches[0].clientX;
      galTouchY = e.changedTouches[0].clientY;
      galTouchLocked = false; galTouchIsH = false;
    }, { passive: true });
    galMain.addEventListener('touchmove', (e: TouchEvent) => {
      if (!galTouchLocked) {
        const dx = Math.abs(e.changedTouches[0].clientX - galTouchX);
        const dy = Math.abs(e.changedTouches[0].clientY - galTouchY);
        if (dx > 6 || dy > 6) { galTouchIsH = dx > dy; galTouchLocked = true; }
      }
      if (galTouchIsH) e.preventDefault();
    }, { passive: false });
    galMain.addEventListener('touchend', (e: TouchEvent) => {
      if (!galTouchIsH) return;
      const dx = e.changedTouches[0].clientX - galTouchX;
      if (Math.abs(dx) < 40) return;
      const idx = dx < 0
        ? (galIdx + 1) % imgs.length
        : (galIdx - 1 + imgs.length) % imgs.length;
      galMain.scrollTo({ left: idx * galMain.clientWidth, behavior: 'smooth' });
      syncIdx(idx);
    }, { passive: true });
  }

  // Variant buttons inside detail panel
  panel.querySelectorAll<HTMLElement>('.ss-det-var-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetKey = btn.dataset.varKey;
      if (!targetKey || (btn as HTMLButtonElement).disabled || targetKey === group.key) return;
      const targetGroup = allGroups.find(g => g.key === targetKey);
      if (!targetGroup) return;
      history.replaceState({ productKey: targetKey }, '', `/${slug}/product/${encodeURIComponent(targetKey)}`);
      // Open new panel immediately (no slide-out animation to avoid jerk)
      window.removeEventListener('popstate', onPop);
      openDetail(targetGroup, allGroups, slug, onClose, favs, toggleFav, variantMap, showStock);
      panel.remove();
      swipeInd.remove();
    });
  });

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

  // Favourites button inside detail
  if (toggleFav && favs) {
    const detFavBtn = panel.querySelector('#ss-det-fav') as HTMLElement|null;
    detFavBtn?.addEventListener('click', () => {
      toggleFav(group.key, detFavBtn);
      detFavBtn.classList.toggle('active', favs.has(group.key));
      detFavBtn.innerHTML = `${HEART_SVG}${favs.has(group.key) ? 'В избранном' : 'В избранное'}`;
    });
  }

  // Heart buttons on related cards
  panel.querySelectorAll<HTMLElement>('.ss-fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (toggleFav && favs) toggleFav(btn.dataset.fav!, btn);
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
      window.removeEventListener('popstate', onPop);
      openDetail(g, allGroups, slug, onClose, favs, toggleFav, variantMap, showStock);
      panel.remove();
      swipeInd.remove();
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
    history.back();
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
    if (swipeIsH && dx / window.innerWidth > 0.4) { history.back(); }
  }, { passive:true });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  injectCSS();

  const root = document.getElementById('root')!;
  const progress = document.getElementById('ss-progress');

  root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background))"></div>`;

  const parts = window.location.pathname.replace(/^\//, '').split('/');
  const slug  = parts[0];
  if (!slug) {
    root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">
      <div><div style="display:flex;justify-content:center;margin-bottom:1rem;color:hsl(var(--foreground)/.2)"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div><h1 style="font-size:1.5rem;font-weight:900;color:hsl(var(--foreground));margin-bottom:.5rem">Магазин не найден</h1>
      <p style="color:hsl(var(--muted-foreground))">Проверьте адрес</p></div></div>`;
    return;
  }

  const hideProgress = () => { if (progress) progress.style.opacity = '0'; };

  let data: StoreData | null = null;
  try { data = await fetchStoreData(slug); }
  catch {
    hideProgress();
    root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">
      <div><div style="display:flex;justify-content:center;margin-bottom:1rem;color:hsl(var(--foreground)/.2)"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"/></svg></div><h1 style="font-size:1.25rem;font-weight:900;color:hsl(var(--foreground));margin-bottom:.5rem">Ошибка соединения</h1>
      <p style="color:hsl(var(--muted-foreground));margin-bottom:1.5rem">Проверьте подключение к интернету</p>
      <button onclick="location.reload()" style="background:linear-gradient(135deg,#00FFCC,#00CCAA);color:#000;font-weight:800;padding:.75rem 2rem;border-radius:.875rem;border:none;cursor:pointer;font-size:.9rem">Обновить</button></div></div>`;
    return;
  }

  if (!data) {
    hideProgress();
    root.innerHTML = `<div style="min-height:100vh;background:hsl(var(--background));display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem">
      <div><div style="display:flex;justify-content:center;margin-bottom:1rem;color:hsl(var(--foreground)/.2)"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div><h1 style="font-size:1.5rem;font-weight:900;color:hsl(var(--foreground));margin-bottom:.5rem">Магазин не найден</h1>
      <p style="color:hsl(var(--muted-foreground));margin-bottom:1.5rem">Проверьте адрес или попросите владельца поделиться ссылкой</p>
      <a href="https://simadesk.ru" style="display:inline-block;background:linear-gradient(135deg,#00FFCC,#00CCAA);color:#000;font-weight:800;padding:.75rem 2rem;border-radius:.875rem;text-decoration:none">Открыть SimaDesk</a></div></div>`;
    return;
  }

  hideProgress();

  const showStock = !!data.settings.show_stock;
  const hideOos   = !!data.settings.hide_out_of_stock;
  const groups = groupProducts(data.products, hideOos);

  // Build variant map: group.key → {items, groupId}
  const variantMap = new Map<string, { items: VariantItem[]; groupId: string }>();
  for (const vg of (data.variants ?? [])) {
    for (const it of vg.items) {
      const k = `v:${it.vendor_code.trim().toLowerCase()}`;
      variantMap.set(k, { items: vg.items, groupId: vg.id });
    }
  }

  // Deduplicate: for variant groups, show only the first representative card
  const _seenVGIds = new Set<string>();
  const catalogGroups = groups.filter(g => {
    const vm = variantMap.get(g.key);
    if (!vm) return true;
    if (_seenVGIds.has(vm.groupId)) return false;
    _seenVGIds.add(vm.groupId);
    return true;
  });

  type View = 'home' | 'catalog';
  let view: View = 'home';
  let pageCleanup: (() => void) | null = null;

  function openProduct(key: string): void {
    const group = groups.find(g => g.key === key);
    if (!group) return;
    history.pushState({ productKey: key }, '', `/${slug}/product/${encodeURIComponent(key)}`);
    openDetail(group, groups, slug, () => {
      history.replaceState({}, '', view === 'catalog' ? `/${slug}/catalog` : `/${slug}`);
    }, _sharedFavs, _sharedToggleFav, variantMap, showStock);
  }

  root.addEventListener('click', (e) => {
    // Heart button stops propagation already, but guard here too
    if ((e.target as HTMLElement).closest('.ss-fav-btn')) return;

    // Variant button — switch to that variant's card
    const varBtn = (e.target as HTMLElement).closest('.ss-var-btn') as HTMLElement | null;
    if (varBtn) {
      e.stopPropagation();
      if (varBtn.hasAttribute('disabled')) return;
      const targetKey = varBtn.dataset.varKey!;
      openProduct(targetKey);
      return;
    }

    const card = (e.target as HTMLElement).closest('[data-key]') as HTMLElement | null;
    if (!card) return;
    const key = card.dataset.key;
    if (!key) return;
    if (card.dataset.fromHome) {
      const group = groups.find(g => g.key === key);
      if (!group) return;
      history.pushState({ productKey: key }, '', `/${slug}/product/${encodeURIComponent(key)}`);
      openDetail(group, groups, slug, () => { showCatalog(); }, _sharedFavs, _sharedToggleFav, variantMap, showStock);
    } else {
      openProduct(key);
    }
  });

  function showHome(): void {
    view = 'home';
    history.replaceState({}, '', `/${slug}`);
    pageCleanup?.();
    pageCleanup = mountHomePage(root, data!, slug, groups, showCatalog, variantMap, showStock);
  }

  function showCatalog(groupId?: string): void {
    view = 'catalog';
    history.replaceState({}, '', `/${slug}/catalog`);
    pageCleanup?.();
    pageCleanup = null;
    mountCatalogPage(root, data!, slug, catalogGroups, showHome, variantMap, showStock, groupId);
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
