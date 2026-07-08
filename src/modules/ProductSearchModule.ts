import { esc } from '@/utils/format';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { costPriceDb } from '@/services/costPriceDb';
import { boxes } from '@/stores/appStore';
import type { OzonStore } from '@/types/ozon';
import type { WbStore } from '@/types/wb';
import type { YandexStore } from '@/types/yandex';
import type { Product } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MpSource {
  mp: 'ozon' | 'wb' | 'yandex';
  store_id: string;
  store_name: string;
  price: number | null;
}

interface BoxLink {
  box_id: string;
  box_name: string;
  product_name: string;
}

interface MpItem {
  article: string;
  name: string;
  image_url: string | null;
  sources: MpSource[];
  cost_price: number | null;
  box_links: BoxLink[];
}

interface BoxItem {
  article: string;
  name: string;
  image_url: string | null;
  box_id: string;
  box_name: string;
  cost_price: number | null;
  mp_sources: MpSource[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MP_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  ozon:   { bg: 'rgba(0,91,255,.15)',  text: '#4d8bff', label: 'Ozon' },
  wb:     { bg: 'rgba(203,17,171,.15)', text: '#e56bd6', label: 'WB' },
  yandex: { bg: 'rgba(252,63,29,.15)', text: '#fc824c', label: 'ЯМ' },
};

const PAGE_SIZE = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getArticle(data: Record<string, any>): string {
  for (const f of ['Артикул*', 'Артикул', 'Артикул продавца', 'Ваш SKU *']) {
    const v = String(data[f] ?? '').trim();
    if (v) return v;
  }
  return '';
}

function getName(data: Record<string, any>): string {
  for (const f of ['Название товара', 'Название товара *', 'Название']) {
    const v = String(data[f] ?? '').trim();
    if (v) return v;
  }
  return '';
}

function getImage(data: Record<string, any>): string | null {
  const url = String(data['Ссылка на главное фото*'] ?? data['Ссылка на фото'] ?? '').trim();
  return url.startsWith('http') ? url : null;
}

// ─── Module ───────────────────────────────────────────────────────────────────

export class ProductSearchModule {
  private mpItems: MpItem[] = [];
  private boxItems: BoxItem[] = [];
  private searchQ = '';
  private mpFilter = '';
  private noCostFilter = false;
  private noLinkFilter = false;
  private visibleCount = PAGE_SIZE;
  private loading = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private el: HTMLElement) {}

  show(): void {
    this.el.style.display = 'flex';
    this.renderShell();
    this.load();
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.el.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
        <div style="padding:16px 20px 12px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--bg);flex-shrink:0">
          <div style="position:relative;flex:1;min-width:220px;max-width:380px">
            <input id="ps-search" class="form-input" placeholder="Артикул или название…"
              style="width:100%;padding-left:34px" autocomplete="off" autofocus>
            <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;display:flex">${I.search('', 14)}</span>
          </div>

          <select id="ps-mp-filter" class="form-select" style="width:170px">
            <option value="">Все площадки</option>
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="yandex">Яндекс Маркет</option>
          </select>

          <button id="ps-no-cost" class="oz-tab-btn" style="font-size:12px;padding:5px 12px;height:32px;white-space:nowrap">
            Без себестоимости
          </button>
          <button id="ps-no-link" class="oz-tab-btn" style="font-size:12px;padding:5px 12px;height:32px;white-space:nowrap">
            Без связки
          </button>

          <div style="flex:1"></div>

          <button id="ps-reload" class="btn" style="font-size:12px;padding:5px 14px;height:32px;display:flex;align-items:center;gap:6px">
            ${I.refresh('', 13)} Обновить
          </button>
        </div>

        <div id="ps-content" style="flex:1;overflow-y:auto;padding:16px 20px 32px"></div>
      </div>
    `;

    const searchEl = this.el.querySelector<HTMLInputElement>('#ps-search')!;
    const mpEl     = this.el.querySelector<HTMLSelectElement>('#ps-mp-filter')!;
    const noCostEl = this.el.querySelector<HTMLButtonElement>('#ps-no-cost')!;
    const noLinkEl = this.el.querySelector<HTMLButtonElement>('#ps-no-link')!;
    const reloadEl = this.el.querySelector<HTMLButtonElement>('#ps-reload')!;

    searchEl.addEventListener('input', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.searchQ = searchEl.value.toLowerCase().trim();
        this.visibleCount = PAGE_SIZE;
        this.render();
      }, 250);
    });

    mpEl.addEventListener('change', () => {
      this.mpFilter = mpEl.value;
      this.visibleCount = PAGE_SIZE;
      this.render();
    });

    noCostEl.addEventListener('click', () => {
      this.noCostFilter = !this.noCostFilter;
      noCostEl.classList.toggle('on', this.noCostFilter);
      this.visibleCount = PAGE_SIZE;
      this.render();
    });

    noLinkEl.addEventListener('click', () => {
      this.noLinkFilter = !this.noLinkFilter;
      noLinkEl.classList.toggle('on', this.noLinkFilter);
      this.visibleCount = PAGE_SIZE;
      this.render();
    });

    reloadEl.addEventListener('click', () => this.load());
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.renderLoading();

    try {
      const [ozStores, wbStores, ymStores] = await Promise.all([
        ozonDb.getStores().catch((): OzonStore[] => []),
        wbDb.getStores().catch((): WbStore[] => []),
        yandexDb.getStores().catch((): YandexStore[] => []),
      ]);
      const ozMap = new Map(ozStores.map(s => [s.id, s.name]));
      const wbMap = new Map(wbStores.map(s => [s.id, s.name]));
      const ymMap = new Map(ymStores.map(s => [s.id, s.name]));

      const [ozProds, wbProds, ymProds] = await Promise.all([
        ozonDb.getProducts().catch(() => []),
        wbDb.getProducts().catch(() => []),
        yandexDb.getProducts().catch(() => []),
      ]);

      // Build mpByArticle
      const mpByArticle = new Map<string, MpItem>();

      const upsertMp = (rawArticle: string, name: string, image: string | null, src: MpSource) => {
        const key = rawArticle.toLowerCase().trim();
        if (!key) return;
        if (!mpByArticle.has(key)) {
          mpByArticle.set(key, {
            article: rawArticle,
            name,
            image_url: image,
            sources: [],
            cost_price: costPriceDb.get(rawArticle),
            box_links: [],
          });
        }
        const item = mpByArticle.get(key)!;
        if (!item.sources.some(s => s.mp === src.mp && s.store_id === src.store_id))
          item.sources.push(src);
        if (!item.image_url && image) item.image_url = image;
        if (!item.name && name) item.name = name;
      };

      for (const p of ozProds) {
        upsertMp(p.offer_id, p.name, p.images?.[0] ?? null, {
          mp: 'ozon', store_id: p.store_id,
          store_name: ozMap.get(p.store_id) ?? 'Ozon',
          price: p.price ?? null,
        });
      }
      for (const p of wbProds) {
        upsertMp(p.vendor_code, p.title, p.pictures?.[0] ?? null, {
          mp: 'wb', store_id: p.store_id,
          store_name: wbMap.get(p.store_id) ?? 'WB',
          price: p.price ?? null,
        });
      }
      for (const p of ymProds) {
        const art = p.offer_id || p.vendor_code || '';
        upsertMp(art, p.name, p.pictures?.[0] ?? null, {
          mp: 'yandex', store_id: p.store_id,
          store_name: ymMap.get(p.store_id) ?? 'ЯМ',
          price: p.basic_price ?? null,
        });
      }

      // Build box side — use app.cache (already loaded) as fast path
      const appCache = (window as any).app?.cache as Map<string, Product[]> | undefined;
      const boxByArticle = new Map<string, BoxLink[]>();
      const boxItems: BoxItem[] = [];

      for (const box of boxes.get()) {
        const prods = appCache?.get(box.id) ?? [];
        for (const p of prods) {
          const article = getArticle(p.data);
          if (!article) continue;
          const key = article.toLowerCase().trim();
          const name = getName(p.data);
          const image = getImage(p.data);
          const mpSources = mpByArticle.get(key)?.sources ?? [];

          if (!boxByArticle.has(key)) boxByArticle.set(key, []);
          const existing = boxByArticle.get(key)!;
          // De-duplicate same article in same box
          if (!existing.some(l => l.box_id === box.id)) {
            existing.push({ box_id: box.id, box_name: box.name, product_name: name });
          }

          boxItems.push({
            article, name, image_url: image,
            box_id: box.id, box_name: box.name,
            cost_price: costPriceDb.get(article),
            mp_sources: mpSources,
          });
        }
      }

      // Cross-link box_links into mpItems
      for (const [key, links] of boxByArticle) {
        const item = mpByArticle.get(key);
        if (item) item.box_links = links;
      }

      this.mpItems = [...mpByArticle.values()];
      this.boxItems = boxItems;
    } catch (e) {
      console.warn('[ProductSearchModule]', e);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  private filteredMp(): MpItem[] {
    const q = this.searchQ;
    return this.mpItems.filter(r => {
      if (q && !r.article.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      if (this.mpFilter && !r.sources.some(s => s.mp === this.mpFilter)) return false;
      if (this.noCostFilter && r.cost_price !== null) return false;
      if (this.noLinkFilter && r.box_links.length > 0) return false;
      return true;
    });
  }

  private filteredBox(): BoxItem[] {
    const q = this.searchQ;
    if (!q) return [];
    return this.boxItems.filter(r =>
      r.article.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
    );
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private renderLoading(): void {
    const c = this.el.querySelector('#ps-content');
    if (c) c.innerHTML = `
      <div style="padding:60px;text-align:center;color:var(--muted)">
        ${I.loader('', 20)} Загрузка товаров…
      </div>`;
  }

  private render(): void {
    const c = this.el.querySelector('#ps-content');
    if (!c) return;

    const mp  = this.filteredMp();
    const box = this.filteredBox();
    const vis = this.visibleCount;
    const showMore = vis < Math.max(mp.length, box.length);

    let html = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:14px">
        Товаров маркетплейсов: <b>${mp.length}</b> из ${this.mpItems.length}
        ${box.length > 0 ? ` · Товаров из групп: <b>${box.length}</b>` : ''}
      </div>
    `;

    if (box.length > 0) {
      html += `
        <div style="margin-bottom:20px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">
            Товары из групп (${box.length})
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${box.slice(0, vis).map(r => this.renderBoxItem(r)).join('')}
          </div>
        </div>
      `;
    }

    html += `
      <div>
        ${box.length > 0 ? `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Товары маркетплейсов (${mp.length})</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:6px">
          ${mp.length === 0
            ? `<div style="padding:60px;text-align:center;color:var(--muted)">Ничего не найдено</div>`
            : mp.slice(0, vis).map(r => this.renderMpItem(r)).join('')
          }
        </div>
        ${showMore ? `
          <div style="text-align:center;padding:20px 0">
            <button class="btn" onclick="window.productSearchModule?.loadMore()">
              Показать ещё (${Math.max(mp.length, box.length) - vis})
            </button>
          </div>
        ` : ''}
      </div>
    `;

    c.innerHTML = html;
  }

  loadMore(): void {
    this.visibleCount += PAGE_SIZE;
    this.render();
  }

  // ── Card renderers ─────────────────────────────────────────────────────────

  private sourceBadge(s: MpSource): string {
    const c = MP_COLORS[s.mp];
    const price = s.price ? ` · ${s.price.toLocaleString('ru')} ₽` : '';
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:4px;background:${c.bg};color:${c.text};font-size:10px;font-weight:700;white-space:nowrap" title="${esc(s.store_name)}">
      ${esc(c.label)} <span style="font-weight:400;opacity:.7;font-size:9px">${esc(s.store_name)}${price}</span>
    </span>`;
  }

  private thumb(url: string | null, size = 48): string {
    return url
      ? `<img src="${esc(url)}" style="width:${size}px;height:${size}px;border-radius:6px;object-fit:cover;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">`
      : `<div style="width:${size}px;height:${size}px;border-radius:6px;background:var(--bg3);flex-shrink:0"></div>`;
  }

  private copyBtn(article: string): string {
    return `<button onclick="navigator.clipboard.writeText('${esc(article)}'.replace(/&#39;/g,\"'\"))" title="Копировать артикул"
      style="background:none;border:none;cursor:pointer;color:var(--muted);padding:0;display:flex;align-items:center">${I.copy('', 12)}</button>`;
  }

  private renderMpItem(r: MpItem): string {
    const badges = r.sources.map(s => this.sourceBadge(s)).join('');
    const noSources = r.sources.length === 0
      ? `<span style="padding:2px 8px;border-radius:4px;background:var(--bg3);color:var(--muted);font-size:10px">Вручную</span>`
      : '';

    const costRow = r.cost_price !== null
      ? `<span style="font-size:11px;color:var(--text3)">Себестоимость: <b style="color:var(--text)">${r.cost_price.toLocaleString('ru')} ₽</b></span>`
      : `<span style="font-size:11px;color:var(--muted);font-style:italic">Себестоимость не задана</span>`;

    const links = r.box_links.length > 0
      ? `<div style="display:flex;flex-direction:column;gap:3px;margin-top:2px">
          <span style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Группы товаров:</span>
          ${r.box_links.map(l => `
            <div style="display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:4px;background:var(--bg2)">
              <span style="font-size:10px;font-weight:600;color:var(--muted);flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.box_name)}">${esc(l.box_name)}</span>
              ${copyButton(l.box_name, 'Копировать название группы')}
              <span style="font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.product_name)}</span>
              ${copyButton(l.product_name, 'Копировать название товара')}
            </div>
          `).join('')}
        </div>`
      : `<div style="font-size:11px;color:#f59e0b;margin-top:2px">⚠ Нет связки с группой товаров</div>`;

    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;gap:10px;background:var(--bg)">
        ${this.thumb(r.image_url)}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            <code style="font-size:12px;font-family:monospace;color:var(--text)">${esc(r.article)}</code>
            ${this.copyBtn(r.article)}
            ${badges}${noSources}
          </div>
          <div style="display:flex;align-items:center;gap:4px;min-width:0">
            <div style="flex:1;min-width:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.name)}">
              ${r.name ? esc(r.name) : `<span style="color:var(--muted);font-style:italic">без названия</span>`}
            </div>
            ${r.name ? copyButton(r.name, 'Копировать название') : ''}
          </div>
          <div>${costRow}</div>
          ${links}
        </div>
      </div>
    `;
  }

  private renderBoxItem(r: BoxItem): string {
    const boxBadge = `<span style="padding:2px 8px;border-radius:4px;background:var(--bg3);color:var(--text3);font-size:10px;font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.box_name)}">${esc(r.box_name)}</span>${copyButton(r.box_name, 'Копировать название группы')}`;

    const costRow = r.cost_price !== null
      ? `<span style="font-size:11px;color:var(--text3)">Себестоимость: <b style="color:var(--text)">${r.cost_price.toLocaleString('ru')} ₽</b></span>`
      : '';

    const mpRow = r.mp_sources.length > 0
      ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">${r.mp_sources.map(s => this.sourceBadge(s)).join('')}</div>`
      : `<div style="font-size:11px;color:#f59e0b">⚠ Не найден на маркетплейсах</div>`;

    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;gap:10px;background:var(--bg)">
        ${this.thumb(r.image_url, 40)}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            ${boxBadge}
            <code style="font-size:11px;font-family:monospace;color:var(--text)">${esc(r.article)}</code>
            ${this.copyBtn(r.article)}
          </div>
          <div style="display:flex;align-items:center;gap:4px;min-width:0">
            <div style="flex:1;min-width:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</div>
            ${copyButton(r.name, 'Копировать название')}
          </div>
          ${costRow ? `<div>${costRow}</div>` : ''}
          ${mpRow}
        </div>
      </div>
    `;
  }
}
