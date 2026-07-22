/**
 * SkuAuditModule — аудит карточек товаров по всем маркетплейсам.
 * WB: оценивает pictures, title, brand, subject, price.
 * Ozon: оценивает images, name, category, status, price.
 * Yandex Market: оценивает pictures, name, vendor, basic_price.
 */

import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { wbDb } from '@/services/wbDb';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { ozonApi } from '@/services/ozonApi';
import { skuEditLog, type EditField } from '@/services/skuEditLog';
import { helpBtn } from '@/services/helpModal';
import type { OzonStore } from '@/types/ozon';
import type { YandexStore } from '@/types/yandex';
// import type { WbStore } from '@/types/wb'; // Reserved for future WB inline editing

type Marketplace = 'wb' | 'ozon' | 'yandex';

interface StoreInfo {
  id: string;
  name: string;
  mp: Marketplace;
}

interface AuditItem {
  id: string;               // nmId / offer_id / offer_id
  marketplace: Marketplace;
  storeId: string;
  storeName: string;        // название магазина
  title: string;
  vendorCode: string;
  brand: string;
  category: string;
  photoCount: number;
  thumb: string;
  price: number | null;
  stock: number;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  issues: string[];
  tips: string[];
  // raw product data needed for editing
  rawImages?: string[];     // Ozon images array
  rawPictures?: string[];   // WB/YM pictures array
  description?: string;     // product description
}

type SortKey = 'score' | 'title' | 'photos' | 'mp';

const MP_LABEL: Record<Marketplace, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };
const MP_COLOR: Record<Marketplace, string> = { wb: '#cb11ab', ozon: '#005bff', yandex: '#fc3f1d' };

export class SkuAuditModule {
  private container: HTMLElement;
  private items: AuditItem[] = [];
  private loading = false;
  private search = '';
  private sortKey: SortKey = 'score';
  private sortDir: 'asc' | 'desc' = 'asc';
  private gradeFilter: '' | 'A' | 'B' | 'C' | 'D' = '';
  // Stores cached for editing and filters
  private allStores: StoreInfo[] = [];
  private ozonStores: OzonStore[] = [];
  // private wbStores: WbStore[] = []; // Reserved for WB inline editing (requires full card data + content API v2)
  private ymStores: YandexStore[] = [];
  // Filters
  private mpFilter: '' | Marketplace = '';
  private storeFilter = ''; // store ID

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.load();
  }

  hide(): void { this.container.style.display = 'none'; }

  private async load(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const [wbProducts, ozonProducts, yandexProducts, wbSt, ozSt, ymSt] = await Promise.all([
        wbDb.getProducts().catch(() => []),
        ozonDb.getProducts().catch(() => []),
        yandexDb.getProducts().catch(() => []),
        wbDb.getStores().catch(() => []),
        ozonDb.getStores().catch(() => []),
        yandexDb.getStores().catch(() => []),
      ]);
      
      // this.wbStores = wbSt; // Reserved for future WB inline editing
      this.ozonStores = ozSt;
      this.ymStores = ymSt;
      
      // Сохраняем все магазины для фильтра
      this.allStores = [
        ...wbSt.map(s => ({ id: s.id, name: s.name, mp: 'wb' as Marketplace })),
        ...ozSt.map(s => ({ id: s.id, name: s.name, mp: 'ozon' as Marketplace })),
        ...ymSt.map(s => ({ id: s.id, name: s.name, mp: 'yandex' as Marketplace })),
      ];

      // Создаём карту для быстрого поиска названия магазина
      const storeNameMap = new Map<string, string>();
      this.allStores.forEach(s => storeNameMap.set(s.id, s.name));

      const audited: AuditItem[] = [];

      for (const p of wbProducts) {
        audited.push(this.auditWb(p, storeNameMap.get(p.store_id) || 'Без названия'));
      }
      for (const p of ozonProducts) {
        audited.push(this.auditOzon(p, storeNameMap.get(p.store_id) || 'Без названия'));
      }
      for (const p of yandexProducts) {
        audited.push(this.auditYandex(p, storeNameMap.get(p.store_id) || 'Без названия'));
      }

      // ИСПРАВЛЕНИЕ: убираем дедупликацию по vendorCode — каждый товар уникален по (marketplace, storeId, id)
      // Разные магазины могут иметь одинаковые артикулы, и это нормально!
      this.items = audited;
    } catch (e) {
      console.error('[SkuAudit]', e);
    }
    this.loading = false;
    this.render();
  }

  private score(checks: { pts: number; max: number; issue?: string; tip?: string }[]): { score: number; issues: string[]; tips: string[] } {
    let score = 0;
    const issues: string[] = [];
    const tips: string[] = [];
    for (const c of checks) {
      score += c.pts;
      if (c.pts < c.max && c.issue) issues.push(c.issue);
      if (c.pts < c.max && c.tip) tips.push(c.tip);
    }
    return { score, issues, tips };
  }

  private grade(s: number): 'A' | 'B' | 'C' | 'D' {
    return s >= 80 ? 'A' : s >= 60 ? 'B' : s >= 40 ? 'C' : 'D';
  }

  private auditWb(p: any, storeName: string): AuditItem {
    const photoCount = p.pictures?.length ?? 0;
    const titleLen = (p.title ?? '').length;
    const { score, issues, tips } = this.score([
      {
        max: 30,
        pts: photoCount === 0 ? 0 : photoCount < 3 ? 10 : photoCount < 5 ? 20 : 30,
        issue: photoCount === 0 ? 'Нет фотографий' : photoCount < 3 ? `Мало фото (${photoCount})` : photoCount < 5 ? `Добавьте ещё фото (${photoCount})` : undefined,
        tip: photoCount < 5 ? 'Рекомендуется 5–8 фото: главное, детали, инфографика' : undefined,
      },
      {
        max: 25,
        pts: titleLen === 0 ? 0 : titleLen < 30 ? 8 : titleLen < 60 ? 16 : titleLen <= 100 ? 25 : 20,
        issue: titleLen === 0 ? 'Нет названия' : titleLen < 30 ? `Короткое название (${titleLen} симв.)` : titleLen > 100 ? 'Название слишком длинное' : undefined,
        tip: titleLen < 60 ? 'Оптимальная длина названия: 60–80 символов с ключевыми словами' : undefined,
      },
      {
        max: 15,
        pts: p.subject ? 15 : 0,
        issue: !p.subject ? 'Не указана категория' : undefined,
        tip: !p.subject ? 'Добавьте товар в правильную категорию' : undefined,
      },
      {
        max: 15,
        pts: p.brand?.trim() ? 15 : 0,
        issue: !p.brand?.trim() ? 'Не указан бренд' : undefined,
        tip: !p.brand?.trim() ? 'Бренд влияет на поисковую выдачу' : undefined,
      },
      { max: 10, pts: p.price && p.price > 0 ? 10 : 0, issue: !p.price ? 'Цена не установлена' : undefined },
      { max: 5,  pts: p.vendor_code?.trim() ? 5 : 0, issue: !p.vendor_code?.trim() ? 'Нет артикула продавца' : undefined },
    ]);
    return {
      id: String(p.nm_id),
      marketplace: 'wb',
      storeId: p.store_id,
      storeName,
      title: p.title || '—',
      vendorCode: p.vendor_code || '',
      brand: p.brand || '',
      category: p.subject || '',
      photoCount,
      thumb: p.pictures?.[0] ?? '',
      price: p.price ?? null,
      stock: p.stock_total ?? 0,
      score, grade: this.grade(score), issues, tips,
      rawPictures: p.pictures ?? [],
    };
  }

  private auditOzon(p: any, storeName: string): AuditItem {
    const photoCount = p.images?.length ?? 0;
    const nameLen = (p.name ?? '').length;
    const { score, issues, tips } = this.score([
      {
        max: 30,
        pts: photoCount === 0 ? 0 : photoCount < 3 ? 10 : photoCount < 5 ? 20 : 30,
        issue: photoCount === 0 ? 'Нет фотографий' : photoCount < 3 ? `Мало фото (${photoCount})` : photoCount < 5 ? `Добавьте ещё фото (${photoCount})` : undefined,
        tip: photoCount < 5 ? 'Ozon рекомендует минимум 5 фото для лучшей конверсии' : undefined,
      },
      {
        max: 25,
        pts: nameLen === 0 ? 0 : nameLen < 20 ? 8 : nameLen < 50 ? 16 : nameLen <= 100 ? 25 : 20,
        issue: nameLen < 20 ? 'Короткое название' : nameLen > 100 ? 'Слишком длинное название' : undefined,
        tip: nameLen < 50 ? 'Название для Ozon: тип + бренд + характеристики, 50–100 символов' : undefined,
      },
      {
        max: 20,
        pts: p.category?.trim() ? 20 : 0,
        issue: !p.category?.trim() ? 'Не указана категория' : undefined,
        tip: !p.category?.trim() ? 'Выберите точную категорию — от неё зависит алгоритм ранжирования' : undefined,
      },
      {
        max: 15,
        pts: p.status === 'price_error' || p.status === 'sold_out' ? 0 : p.status ? 15 : 0,
        issue: p.status === 'price_error' ? 'Ошибка цены — товар скрыт' : p.status === 'sold_out' ? 'Нет остатков' : undefined,
        tip: p.status === 'price_error' ? 'Исправьте цену: она ниже минимальной или некорректна' : undefined,
      },
      { max: 10, pts: p.price && p.price > 0 ? 10 : 0, issue: !p.price ? 'Цена не установлена' : undefined },
    ]);
    return {
      id: p.offer_id,
      marketplace: 'ozon',
      storeId: p.store_id,
      storeName,
      title: p.name || '—',
      vendorCode: p.offer_id || '',
      brand: '',
      category: p.category || '',
      photoCount,
      thumb: p.images?.[0] ?? '',
      price: p.price ?? null,
      stock: (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0),
      score, grade: this.grade(score), issues, tips,
      rawImages: p.images ?? [],
      description: p.description ?? '',
    };
  }

  private auditYandex(p: any, storeName: string): AuditItem {
    const photoCount = p.pictures?.length ?? 0;
    const nameLen = (p.name ?? '').length;
    const { score, issues, tips } = this.score([
      {
        max: 30,
        pts: photoCount === 0 ? 0 : photoCount < 3 ? 10 : photoCount < 5 ? 20 : 30,
        issue: photoCount === 0 ? 'Нет фотографий' : photoCount < 3 ? `Мало фото (${photoCount})` : undefined,
        tip: photoCount < 5 ? 'ЯМ рекомендует 5+ фото для высокого CTR' : undefined,
      },
      {
        max: 25,
        pts: nameLen === 0 ? 0 : nameLen < 20 ? 8 : nameLen < 50 ? 16 : 25,
        issue: nameLen < 20 ? 'Короткое название' : undefined,
        tip: nameLen < 50 ? 'Добавьте в название ключевые характеристики' : undefined,
      },
      {
        max: 20,
        pts: p.vendor?.trim() ? 20 : 0,
        issue: !p.vendor?.trim() ? 'Не указан бренд/производитель' : undefined,
        tip: !p.vendor?.trim() ? 'Укажите бренд — Яндекс Маркет использует его для фильтрации' : undefined,
      },
      {
        max: 15,
        pts: p.category_id ? 15 : 0,
        issue: !p.category_id ? 'Категория не определена' : undefined,
      },
      { max: 10, pts: p.basic_price && p.basic_price > 0 ? 10 : 0, issue: !p.basic_price ? 'Цена не установлена' : undefined },
    ]);
    return {
      id: p.offer_id,
      marketplace: 'yandex',
      storeId: p.store_id,
      storeName,
      title: p.name || '—',
      vendorCode: p.offer_id || '',
      brand: p.vendor || '',
      category: p.category_id ? `Категория ${p.category_id}` : '',
      photoCount,
      thumb: p.pictures?.[0] ?? '',
      price: p.basic_price ?? null,
      stock: p.stock_total ?? 0,
      score, grade: this.grade(score), issues, tips,
      rawPictures: p.pictures ?? [],
    };
  }

  private gradeColor(g: string): string {
    return g === 'A' ? '#16a34a' : g === 'B' ? '#2563eb' : g === 'C' ? '#f97316' : '#dc2626';
  }

  private get filtered(): AuditItem[] {
    let list = [...this.items];
    if (this.mpFilter) list = list.filter(i => i.marketplace === this.mpFilter);
    if (this.storeFilter) list = list.filter(i => i.storeId === this.storeFilter);
    if (this.gradeFilter) list = list.filter(i => i.grade === this.gradeFilter);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.vendorCode.toLowerCase().includes(q) ||
        i.brand.toLowerCase().includes(q) ||
        i.storeName.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      let av: number | string, bv: number | string;
      if (this.sortKey === 'score')  { av = a.score; bv = b.score; }
      else if (this.sortKey === 'photos') { av = a.photoCount; bv = b.photoCount; }
      else if (this.sortKey === 'mp')  { av = a.marketplace; bv = b.marketplace; }
      else { av = a.title; bv = b.title; }
      if (av < bv) return this.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return this.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }

  setSearch(q: string) { this.search = q; this.render(); }
  setGradeFilter(g: string) { this.gradeFilter = g as any; this.render(); }
  setMpFilter(mp: string) { 
    this.mpFilter = mp as any; 
    // Сбрасываем фильтр магазина если сменили МП
    if (mp && this.storeFilter) {
      const store = this.allStores.find(s => s.id === this.storeFilter);
      if (!store || store.mp !== mp) this.storeFilter = '';
    }
    this.render(); 
  }
  setStoreFilter(storeId: string) { this.storeFilter = storeId; this.render(); }
  setSort(key: SortKey) {
    if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    else { this.sortKey = key; this.sortDir = 'asc'; }
    this.render();
  }

  openDetail(id: string, mp: string): void {
    const item = this.items.find(i => i.id === id && i.marketplace === mp);
    if (item) this.renderDetail(item);
  }

  async reload(): Promise<void> {
    // Re-sync товары с маркетплейсов перед загрузкой аудита
    this.items = [];
    this.loading = true;
    this.render();
    try {
      // Триггерим повторную синхронизацию каждого МП-модуля (если они подключены)
      try { await (window as any).ozonModule?.syncAll?.(); } catch (e) { debug.warn('[SkuAuditModule] swallowed error', e); }
      try { await (window as any).wbModule?.syncAll?.(); } catch (e) { debug.warn('[SkuAuditModule] swallowed error', e); }
      try { await (window as any).yandexModule?.syncAll?.(); } catch (e) { debug.warn('[SkuAuditModule] swallowed error', e); }
    } catch (e) {
      console.warn('[SkuAudit] reload sync:', e);
    }
    await this.load();
  }

  private render(): void {
    const list = this.filtered;
    const total = this.items.length;
    const grades = { A: 0, B: 0, C: 0, D: 0 };
    for (const i of this.items) grades[i.grade]++;
    const avgScore = total ? Math.round(this.items.reduce((s, i) => s + i.score, 0) / total) : 0;
    const avgGrade = avgScore >= 80 ? 'A' : avgScore >= 60 ? 'B' : avgScore >= 40 ? 'C' : 'D';

    const wbCount = this.items.filter(i => i.marketplace === 'wb').length;
    const ozonCount = this.items.filter(i => i.marketplace === 'ozon').length;
    const yandexCount = this.items.filter(i => i.marketplace === 'yandex').length;

    // Группировка по магазинам для дропдауна
    const storesForFilter = this.allStores.filter(s => {
      if (!this.mpFilter) return true;
      return s.mp === this.mpFilter;
    });

    const sortArrow = (k: SortKey) => this.sortKey === k ? (this.sortDir === 'asc' ? ' ↑' : ' ↓') : '';

    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" fill="#7c3aed"/>
                <text x="12" y="16" text-anchor="middle" fill="white" font-size="9" font-weight="800" font-family="Arial">SKU</text>
              </svg>
              <span class="oz-brand-name">Аудит карточек</span>
            </div>
          </div>
          <div class="oz-topbar-right">
            ${(() => {
              const st = skuEditLog.stats();
              if (st.submitted + st.synced + st.error === 0) return '';
              return `<div style="display:flex;gap:5px;align-items:center;margin-right:8px">
                ${st.submitted > 0 ? `<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:14px;background:#f59e0b18;color:#f59e0b">${I.hourglass('', 12)} ${st.submitted} на модерации</span>` : ''}
                ${st.synced > 0 ? `<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:14px;background:#16a34a18;color:#16a34a">✓ ${st.synced} обновлено</span>` : ''}
                ${st.error > 0 ? `<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:14px;background:#dc262618;color:#dc2626">⚠ ${st.error} ошибок</span>` : ''}
              </div>`;
            })()}
            ${helpBtn('sku-audit')}
            <button class="btn btn-primary" onclick="window.skuAuditModule.reload()">↻ Обновить из МП</button>
          </div>
        </div>

        ${this.loading ? `
          <div style="display:flex;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-2)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>
            Загружаем карточки со всех маркетплейсов…
          </div>
        ` : total === 0 ? `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-2);padding:40px">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12h6M12 9v6"/></svg>
            <div style="font-size:16px;font-weight:600">Нет товаров для аудита</div>
            <div style="font-size:13px;opacity:.6;text-align:center">Синхронизируйте магазины в разделе «Маркетплейсы»</div>
          </div>
        ` : `
          <!-- KPI bar -->
          <div style="display:flex;gap:12px;padding:14px 24px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center">
            <div class="an-kpi" style="flex:0 0 auto;min-width:110px">
              <div class="an-kpi-label">Средний балл</div>
              <div class="an-kpi-value" style="font-size:26px;font-weight:800;color:${this.gradeColor(avgGrade)}">${avgScore}</div>
            </div>
            ${(['A','B','C','D'] as const).map(g => `
              <div class="an-kpi" style="flex:0 0 auto;min-width:72px;cursor:pointer;border:2px solid ${this.gradeFilter === g ? this.gradeColor(g) : 'transparent'};border-radius:10px;padding:6px 10px"
                onclick="window.skuAuditModule.setGradeFilter('${this.gradeFilter === g ? '' : g}')">
                <div class="an-kpi-label">Оценка ${g}</div>
                <div class="an-kpi-value" style="font-size:22px;font-weight:800;color:${this.gradeColor(g)}">${grades[g]}</div>
              </div>
            `).join('')}
            <div style="width:1px;height:36px;background:var(--border);flex-shrink:0"></div>
            ${([['wb', wbCount], ['ozon', ozonCount], ['yandex', yandexCount]] as [Marketplace, number][]).map(([mp, cnt]) => cnt > 0 ? `
              <div class="an-kpi" style="flex:0 0 auto;min-width:72px;cursor:pointer;border:2px solid ${this.mpFilter === mp ? MP_COLOR[mp] : 'transparent'};border-radius:10px;padding:6px 10px"
                onclick="window.skuAuditModule.setMpFilter('${this.mpFilter === mp ? '' : mp}')">
                <div class="an-kpi-label" style="color:${MP_COLOR[mp]}">${MP_LABEL[mp]}</div>
                <div class="an-kpi-value" style="font-size:22px;font-weight:800">${cnt}</div>
              </div>
            ` : '').join('')}
          </div>

          <!-- Toolbar with filters -->
          <div style="display:flex;align-items:center;gap:8px;padding:10px 24px;border-bottom:1px solid var(--border);flex-wrap:wrap">
            <input type="text" class="oz-search" placeholder="Поиск по названию, ID, магазину…"
              value="${this.search}" oninput="window.skuAuditModule.setSearch(this.value)"
              style="flex:1;max-width:360px;min-width:180px">
            
            ${storesForFilter.length > 0 ? `
              <select onchange="window.skuAuditModule.setStoreFilter(this.value)" 
                style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;cursor:pointer">
                <option value="">Все магазины${this.mpFilter ? ' (' + MP_LABEL[this.mpFilter] + ')' : ''}</option>
                ${storesForFilter.map(s => `
                  <option value="${s.id}" ${this.storeFilter === s.id ? 'selected' : ''}>
                    ${s.name}${!this.mpFilter ? ' · ' + MP_LABEL[s.mp] : ''}
                  </option>
                `).join('')}
              </select>
            ` : ''}
            
            <span style="font-size:12px;color:var(--text-2);margin-left:auto">${list.length.toLocaleString('ru')} из ${total}</span>
          </div>

          <!-- Table -->
          <div style="flex:1;overflow:auto;padding-bottom:90px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:var(--bg-2);position:sticky;top:0;z-index:1">
                  <th style="padding:10px 24px;text-align:left;font-weight:600;color:var(--text-2);cursor:pointer" onclick="window.skuAuditModule.setSort('mp')">МП${sortArrow('mp')}</th>
                  <th style="padding:10px 8px;text-align:left;font-weight:600;color:var(--text-2)">Магазин</th>
                  <th style="padding:10px 8px;text-align:left;font-weight:600;color:var(--text-2);cursor:pointer" onclick="window.skuAuditModule.setSort('title')">Товар${sortArrow('title')}</th>
                  <th style="padding:10px 12px;text-align:center;font-weight:600;color:var(--text-2);cursor:pointer" onclick="window.skuAuditModule.setSort('photos')">Фото${sortArrow('photos')}</th>
                  <th style="padding:10px 12px;text-align:left;font-weight:600;color:var(--text-2)">Проблемы</th>
                  <th style="padding:10px 12px;text-align:center;font-weight:600;color:var(--text-2);cursor:pointer" onclick="window.skuAuditModule.setSort('score')">Балл${sortArrow('score')}</th>
                  <th style="padding:10px 24px;text-align:center;font-weight:600;color:var(--text-2)">Оценка</th>
                </tr>
              </thead>
              <tbody>${list.map(i => this.renderRow(i)).join('')}</tbody>
            </table>
          </div>
        `}
      </div>
    `;
  }

  /** Статус-бейдж по результатам последних правок (для строки и для detail). */
  private renderStatusBadge(item: AuditItem): string {
    const edits = skuEditLog.getAllForProduct(item.marketplace, item.id);
    if (edits.length === 0) return '';
    // Сверяем актуальные значения с отправленными
    const reconciled = edits.map(e => {
      let cur = '';
      if (e.field === 'name') cur = item.title;
      else if (e.field === 'brand') cur = item.brand;
      else if (e.field === 'photos') cur = (item.rawImages ?? []).join(',');
      return skuEditLog.reconcile(item.marketplace, item.id, e.field, cur) ?? e;
    });
    const hasErr = reconciled.some(e => e.status === 'error');
    const allSynced = reconciled.every(e => e.status === 'synced');
    const submittedCount = reconciled.filter(e => e.status === 'submitted').length;

    if (hasErr) {
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;background:#dc262618;color:#dc2626">⚠ Ошибка</span>`;
    }
    if (allSynced) {
      const last = reconciled.reduce((a, b) => new Date(a.syncedAt ?? a.submittedAt) > new Date(b.syncedAt ?? b.submittedAt) ? a : b);
      const date = last.syncedAt ? new Date(last.syncedAt).toLocaleDateString('ru', { day:'2-digit', month:'short' }) : '';
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;background:#16a34a18;color:#16a34a" title="Изменения применены ${date}">✓ Обновлено</span>`;
    }
    if (submittedCount > 0) {
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;background:#f59e0b18;color:#f59e0b" title="${submittedCount} изм. ожидает модерации МП">${I.hourglass('', 10)} На модерации</span>`;
    }
    return '';
  }

  private renderRow(item: AuditItem): string {
    const gc = this.gradeColor(item.grade);
    const statusBadge = this.renderStatusBadge(item);
    return `
      <tr style="border-bottom:1px solid var(--border);cursor:pointer"
        onmouseenter="this.style.background='var(--bg-2)'" onmouseleave="this.style.background=''"
        onclick="window.skuAuditModule.openDetail('${item.id.replace(/'/g, "\\'")}','${item.marketplace}')">
        <td style="padding:10px 24px">
          <span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;white-space:nowrap;background:${MP_COLOR[item.marketplace]}18;color:${MP_COLOR[item.marketplace]}">${MP_LABEL[item.marketplace]}</span>
        </td>
        <td style="padding:10px 8px">
          <div style="font-size:11px;color:var(--text-2);font-weight:600;margin-bottom:4px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.storeName}">${item.storeName}</div>
        </td>
        <td style="padding:10px 8px">
          <div style="display:flex;align-items:center;gap:10px">
            ${item.thumb
              ? `<img src="${item.thumb}" style="width:38px;height:38px;object-fit:cover;border-radius:6px;flex-shrink:0" loading="lazy">`
              : `<div style="width:38px;height:38px;border-radius:6px;background:var(--bg-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px">${I.camera('',16)}</div>`}
            <div style="min-width:0;flex:1">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
                <div style="font-weight:500;font-size:13px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.title}</div>
                ${copyButton(item.title, 'Копировать название')}
                ${statusBadge}
              </div>
              <div style="font-size:11px;color:var(--text-2);display:flex;align-items:center;gap:4px">${item.vendorCode || item.id}${item.brand ? ` · ${item.brand}` : ''}${copyButton(item.vendorCode || item.id, 'Копировать артикул')}</div>
            </div>
          </div>
        </td>
        <td style="padding:10px 12px;text-align:center">
          <span style="font-weight:600;color:${item.photoCount < 3 ? '#dc2626' : item.photoCount < 5 ? '#f97316' : '#16a34a'}">${item.photoCount}</span>
        </td>
        <td style="padding:10px 12px;max-width:240px">
          ${item.issues.length === 0
            ? `<span style="color:#16a34a;font-size:12px">✓ Без замечаний</span>`
            : item.issues.slice(0, 2).map(i => `<div style="font-size:11px;color:#dc2626">⚠ ${i}</div>`).join('') +
              (item.issues.length > 2 ? `<div style="font-size:11px;color:var(--text-2)">+${item.issues.length - 2} ещё</div>` : '')}
        </td>
        <td style="padding:10px 12px;text-align:center">
          <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
            <span style="font-weight:700;font-size:15px;color:${gc}">${item.score}</span>
            <div style="width:44px;height:4px;border-radius:2px;background:var(--border)">
              <div style="width:${item.score}%;height:100%;border-radius:2px;background:${gc}"></div>
            </div>
          </div>
        </td>
        <td style="padding:10px 24px;text-align:center">
          <span style="font-size:13px;font-weight:700;color:${gc};background:${gc}18;padding:3px 10px;border-radius:20px">${item.grade}</span>
        </td>
      </tr>
    `;
  }

  private renderDetail(item: AuditItem): void {
    const gc = this.gradeColor(item.grade);
    const color = MP_COLOR[item.marketplace];
    const cabinetUrl = this.getCabinetUrl(item);

    // Определяем какие проблемы можно исправить прямо здесь
    const fixableMap: Record<string, { label: string; field: string }> = {
      'Нет названия': { label: 'Изменить название', field: 'name' },
      'Короткое название': { label: 'Улучшить название', field: 'name' },
      'Название слишком длинное': { label: 'Сократить название', field: 'name' },
      'Не указан бренд': { label: 'Указать бренд', field: 'brand' },
      'Нет фотографий': { label: 'Добавить фото', field: 'photos' },
      'Мало фото': { label: 'Добавить фото', field: 'photos' },
      'Добавьте ещё фото': { label: 'Добавить фото', field: 'photos' },
    };
    const findFixable = (issue: string) => Object.entries(fixableMap).find(([k]) => issue.startsWith(k));

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
      <div style="background:var(--bg);border-radius:16px;width:100%;max-width:580px;max-height:92vh;overflow:auto;padding:26px;box-shadow:0 24px 64px rgba(0,0,0,.3)">
        <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:18px">
          ${item.thumb ? `<img src="${item.thumb}" style="width:64px;height:64px;object-fit:cover;border-radius:10px;flex-shrink:0">` : ''}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;background:${color}18;color:${color}">${MP_LABEL[item.marketplace]}</span>
              ${cabinetUrl ? `<a href="${cabinetUrl}" target="_blank" style="font-size:11px;color:var(--text-2);text-decoration:none;opacity:.7" title="Открыть в личном кабинете">↗ ЛК</a>` : ''}
            </div>
            <div style="font-size:15px;font-weight:600">${item.title}${copyButton(item.title, 'Копировать название')}</div>
            <div style="font-size:12px;color:var(--text-2)">${item.vendorCode || item.id}${item.brand ? ` · ${item.brand}` : ''}${item.category ? ` · ${item.category}` : ''}${copyButton(item.vendorCode || item.id, 'Копировать артикул')}</div>
          </div>
          <div style="text-align:center;flex-shrink:0">
            <div style="font-size:34px;font-weight:800;color:${gc}">${item.score}</div>
            <div style="font-size:13px;font-weight:700;color:${gc};background:${gc}18;padding:2px 10px;border-radius:20px">${item.grade}</div>
          </div>
        </div>
        <div style="height:7px;border-radius:4px;background:var(--border);overflow:hidden;margin-bottom:16px">
          <div style="width:${item.score}%;height:100%;background:${gc};border-radius:4px"></div>
        </div>

        ${(() => {
          const edits = skuEditLog.getAllForProduct(item.marketplace, item.id);
          if (edits.length === 0) return '';
          const pending = edits.filter(e => e.status === 'submitted');
          const synced = edits.filter(e => e.status === 'synced');
          const errors = edits.filter(e => e.status === 'error');
          return `<div style="background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px">
            <div style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">История правок</div>
            ${pending.length > 0 ? `
              <div style="font-size:12px;padding:8px 10px;background:#f59e0b15;border-radius:6px;margin-bottom:5px;color:#f59e0b">
                ${I.hourglass('', 12)} ${pending.length} изм. отправлено в МП и ждёт модерации.
                Нажмите <b>«↻ Обновить из МП»</b> в шапке чтобы проверить применение.
              </div>` : ''}
            ${synced.length > 0 ? `
              <div style="font-size:12px;padding:8px 10px;background:#16a34a15;border-radius:6px;margin-bottom:5px;color:#16a34a">
                ✓ ${synced.length} изм. подтверждены маркетплейсом (значение совпало с отправленным).
              </div>` : ''}
            ${errors.length > 0 ? `
              <div style="font-size:12px;padding:8px 10px;background:#dc262615;border-radius:6px;color:#dc2626">
                ⚠ ${errors.length} изм. с ошибкой: ${String((errors[0] as any).errorMsg ?? '—').replace(/[<>]/g,'').slice(0, 100)}
              </div>` : ''}
            <div style="font-size:10.5px;color:var(--text-2);margin-top:6px;line-height:1.5">
              Балл и список ошибок ниже рассчитаны по <b>текущим данным из БД</b>.
              Если МП ещё не применил изменения — балл устарел. Нажмите «↻ Обновить из МП».
            </div>
          </div>`;
        })()}

        ${item.issues.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#dc2626">⚠ Проблемы и устранение</div>
            ${item.issues.map((issue, idx) => {
              const fix = findFixable(issue);
              return `
                <div style="background:#dc262608;border:1px solid #dc262620;border-radius:8px;padding:10px 12px;margin-bottom:6px">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                    <div style="font-size:13px;color:#dc2626;flex:1">• ${issue}</div>
                    ${fix ? `<button style="flex-shrink:0;padding:4px 10px;border-radius:6px;border:1px solid ${color};background:${color}12;color:${color};font-size:11px;font-weight:600;cursor:pointer"
                      onclick="window.skuAuditModule.openInlineEdit('${item.id}','${item.marketplace}','${fix[1].field}',${idx})">${fix[1].label}</button>`
                    : cabinetUrl ? `<a href="${cabinetUrl}" target="_blank" style="flex-shrink:0;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-2);font-size:11px;text-decoration:none;font-weight:600">↗ В ЛК</a>` : ''}
                  </div>
                  <div id="inline-edit-${item.id}-${idx}" style="margin-top:0;overflow:hidden;max-height:0;transition:max-height .25s ease"></div>
                </div>
              `;
            }).join('')}
          </div>
        ` : `<div style="font-size:13px;color:#16a34a;padding:10px;background:#16a34a10;border-radius:8px;margin-bottom:16px">✓ Карточка заполнена отлично!</div>`}

        ${item.tips.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#2563eb">${I.lightbulb('',14)} Рекомендации</div>
            ${item.tips.map(t => `<div style="font-size:13px;padding:5px 10px;background:#2563eb10;border-radius:6px;margin-bottom:4px">• ${t}</div>`).join('')}
          </div>
        ` : ''}

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-bottom:20px">
          <div style="padding:8px 12px;background:var(--bg-2);border-radius:8px">${I.camera('',12)} Фото: <b>${item.photoCount}</b></div>
          <div style="padding:8px 12px;background:var(--bg-2);border-radius:8px">${I.type('',12)} Название: <b>${item.title.length} симв.</b></div>
          <div style="padding:8px 12px;background:var(--bg-2);border-radius:8px">${I.tag('',12)} Бренд: <b>${item.brand || '—'}</b></div>
          <div style="padding:8px 12px;background:var(--bg-2);border-radius:8px">${I.dollarSign('',12)} Цена: <b>${item.price ? item.price.toLocaleString('ru') + ' ₽' : '—'}</b></div>
          <div style="padding:8px 12px;background:var(--bg-2);border-radius:8px">${I.package('',12)} Остаток: <b>${item.stock.toLocaleString('ru')} шт.</b></div>
          <div style="padding:8px 12px;background:var(--bg-2);border-radius:8px">${I.folder('',12)} Категория: <b>${item.category || '—'}</b></div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          ${cabinetUrl ? `<a href="${cabinetUrl}" target="_blank" class="btn">↗ Открыть в личном кабинете</a>` : ''}
          <button class="btn btn-primary" onclick="this.closest('[style*=fixed]').remove()">Закрыть</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  /** Ссылка на карточку в личном кабинете маркетплейса */
  private getCabinetUrl(item: AuditItem): string {
    switch (item.marketplace) {
      case 'ozon':
        return `https://seller.ozon.ru/app/products?offer_id=${encodeURIComponent(item.id)}`;
      case 'wb':
        return `https://seller.wildberries.ru/goods-and-prices/products?search=${encodeURIComponent(item.vendorCode || item.id)}`;
      case 'yandex':
        return `https://partner.market.yandex.ru/`;
    }
  }

  /** Открывает inline-форму для исправления конкретной проблемы */
  openInlineEdit(productId: string, mp: string, field: string, issueIdx: number): void {
    const item = this.items.find(i => i.id === productId && i.marketplace === mp as Marketplace);
    if (!item) return;
    const container = document.getElementById(`inline-edit-${productId}-${issueIdx}`);
    if (!container) return;

    // Уже открыто — закрываем
    if (container.style.maxHeight !== '0px' && container.style.maxHeight !== '') {
      container.style.maxHeight = '0';
      return;
    }

    let formHtml = '';
    if (field === 'name') {
      formHtml = `
        <div style="padding-top:10px">
          <div style="font-size:11px;color:var(--text-2);margin-bottom:4px">Новое название ${item.marketplace === 'ozon' ? '(50–100 симв.)' : item.marketplace === 'wb' ? '(60–80 симв.)' : '(50–100 симв.)'}</div>
          <textarea id="ief-${productId}-name" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;resize:vertical">${item.title === '—' ? '' : item.title}</textarea>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="btn btn-primary" style="font-size:12px;padding:5px 12px"
              onclick="window.skuAuditModule.submitEdit('${productId}','${mp}','name')">Сохранить</button>
            <button class="btn" style="font-size:12px;padding:5px 12px"
              onclick="document.getElementById('inline-edit-${productId}-${issueIdx}').style.maxHeight='0'">Отмена</button>
          </div>
          <div id="ief-${productId}-status" style="font-size:11px;margin-top:4px"></div>
        </div>`;
    } else if (field === 'photos') {
      const current = (item.rawImages ?? item.rawPictures ?? []).join('\n');
      formHtml = `
        <div style="padding-top:10px">
          <div style="font-size:11px;color:var(--text-2);margin-bottom:6px">
            Фото — загрузите с устройства или вставьте URL${item.marketplace === 'ozon' ? ' (мин. 400×400 px)' : ' (JPEG/PNG)'}
          </div>
          <!-- Загрузка с устройства -->
          <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
            <label style="cursor:pointer">
              <input type="file" accept="image/*" multiple style="display:none"
                onchange="window.skuAuditModule.handlePhotoUpload(this,'${productId}')">
              <div class="btn" style="font-size:12px;padding:5px 12px;gap:4px;pointer-events:none">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:12px;height:12px"><path d="M7 1v8M4 5l3-4 3 4"/><path d="M2 11h10"/></svg>
                Загрузить с устройства
              </div>
            </label>
            <span style="font-size:11px;color:var(--muted);align-self:center">или вставьте URL ниже</span>
          </div>
          <div id="ief-${productId}-photo-preview" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px"></div>
          <textarea id="ief-${productId}-photos" rows="4" placeholder="https://example.com/photo1.jpg&#10;https://example.com/photo2.jpg"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;font-family:monospace;box-sizing:border-box;resize:vertical">${current}</textarea>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="btn btn-primary" style="font-size:12px;padding:5px 12px"
              onclick="window.skuAuditModule.submitEdit('${productId}','${mp}','photos')">Сохранить</button>
            <button class="btn" style="font-size:12px;padding:5px 12px"
              onclick="document.getElementById('inline-edit-${productId}-${issueIdx}').style.maxHeight='0'">Отмена</button>
          </div>
          <div id="ief-${productId}-status" style="font-size:11px;margin-top:4px"></div>
        </div>`;
    } else if (field === 'brand') {
      formHtml = `
        <div style="padding-top:10px">
          <div style="font-size:11px;color:var(--text-2);margin-bottom:4px">Бренд / производитель</div>
          <input type="text" id="ief-${productId}-brand" value="${item.brand || ''}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box">
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="btn btn-primary" style="font-size:12px;padding:5px 12px"
              onclick="window.skuAuditModule.submitEdit('${productId}','${mp}','brand')">Сохранить</button>
            <button class="btn" style="font-size:12px;padding:5px 12px"
              onclick="document.getElementById('inline-edit-${productId}-${issueIdx}').style.maxHeight='0'">Отмена</button>
          </div>
          <div id="ief-${productId}-status" style="font-size:11px;margin-top:4px"></div>
        </div>`;
    }

    container.innerHTML = formHtml;
    container.style.maxHeight = '300px';
  }

  /** Отправляет изменение через API маркетплейса */
  async submitEdit(productId: string, mp: string, field: string): Promise<void> {
    const item = this.items.find(i => i.id === productId && i.marketplace === mp as Marketplace);
    if (!item) return;
    const statusEl = document.getElementById(`ief-${productId}-status`);
    const setStatus = (msg: string, ok = false, err = false) => {
      if (statusEl) statusEl.innerHTML = `<span style="color:${ok ? '#16a34a' : err ? '#dc2626' : 'var(--text-2)'}">${msg}</span>`;
    };

    const logEntry = { id: item.id, marketplace: mp as 'ozon'|'wb'|'yandex', storeId: item.storeId, field: field as EditField, oldValue: '', newValue: '' };

    try {
      setStatus('Отправляем в ' + (mp === 'wb' ? 'WB' : mp === 'ozon' ? 'Ozon' : 'ЯМ') + '…');

      const nextStepsMsg = `Изменение отправлено. <b>Маркетплейс может применить его не сразу</b> — проверка модератора занимает от нескольких минут до 24 часов. Сейчас загрузим актуальные данные из МП.`;

      if (mp === 'ozon') {
        const store = this.ozonStores.find(s => s.id === item.storeId);
        if (!store) throw new Error('Магазин Ozon не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };

        if (field === 'name') {
          const newName = (document.getElementById(`ief-${productId}-name`) as HTMLTextAreaElement)?.value.trim();
          if (!newName) throw new Error('Название не может быть пустым');
          if (newName.length > 500) throw new Error('Название слишком длинное (макс. 500 символов)');
          if (newName === item.title) throw new Error('Название не изменилось');
          logEntry.oldValue = item.title;
          logEntry.newValue = newName;
          await ozonApi.updateProduct(creds, { offer_id: item.id, name: newName });
          skuEditLog.recordSubmit(logEntry);
          setStatus(`✓ Отправлено в Ozon · статус «<b style="color:#f59e0b">на модерации</b>». ${nextStepsMsg}`, true);

        } else if (field === 'photos') {
          const raw = (document.getElementById(`ief-${productId}-photos`) as HTMLTextAreaElement)?.value;
          const urls = raw.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
          if (!urls.length) throw new Error('Нет валидных ссылок на фото');
          if (urls.length > 15) throw new Error('Максимум 15 фото для Ozon');
          logEntry.oldValue = (item.rawImages ?? []).join(',');
          logEntry.newValue = urls.join(',');
          if (logEntry.oldValue === logEntry.newValue) throw new Error('Фото не изменились');
          await ozonApi.updateProduct(creds, { offer_id: item.id, images: urls });
          skuEditLog.recordSubmit(logEntry);
          setStatus(`✓ Фото (${urls.length} шт.) отправлены · статус «<b style="color:#f59e0b">на модерации</b>». ${nextStepsMsg}`, true);

        } else if (field === 'brand') {
          const newBrand = (document.getElementById(`ief-${productId}-brand`) as HTMLInputElement)?.value.trim();
          if (!newBrand) throw new Error('Бренд не может быть пустым');
          if (newBrand === item.brand) throw new Error('Бренд не изменился');
          logEntry.oldValue = item.brand;
          logEntry.newValue = newBrand;
          // Бренд у Ozon — это атрибут (id=85 обычно), а не верхнеуровневое поле.
          // Для надёжности отправляем атрибут brand_name.
          await ozonApi.updateProduct(creds, {
            offer_id: item.id,
            attributes: [{ id: 85, complex_id: 0, values: [{ value: newBrand }] }],
          });
          skuEditLog.recordSubmit(logEntry);
          setStatus(`✓ Бренд отправлен · статус «<b style="color:#f59e0b">на модерации</b>». ${nextStepsMsg}`, true);
        }

      } else if (mp === 'wb') {
        const url = this.getCabinetUrl(item);
        setStatus(`⚠ WB API не поддерживает частичное обновление одного поля. <a href="${url}" target="_blank" style="color:#cb11ab;font-weight:600">Откройте карточку в WB →</a> и измените вручную. После этого нажмите «↻ Обновить из МП».`);
        return;

      } else if (mp === 'yandex') {
        const store = this.ymStores.find(s => s.id === item.storeId);
        if (!store) throw new Error('Магазин ЯМ не найден');
        const { yandexApi } = await import('@/services/yandexApi');

        if (field === 'name') {
          const newName = (document.getElementById(`ief-${productId}-name`) as HTMLTextAreaElement)?.value.trim();
          if (!newName) throw new Error('Название не может быть пустым');
          if (newName.length > 512) throw new Error('Название слишком длинное (макс. 512 символов)');
          if (newName === item.title) throw new Error('Название не изменилось');
          const businessId = store.business_id ?? await yandexApi.getBusinessId(store.api_key, store.campaign_id!);
          if (!businessId) throw new Error('Не удалось получить business_id');
          logEntry.oldValue = item.title;
          logEntry.newValue = newName;
          await yandexApi.updateOfferName(store.api_key, businessId, item.id, newName);
          skuEditLog.recordSubmit(logEntry);
          setStatus(`✓ Отправлено в ЯМ · статус «<b style="color:#f59e0b">на модерации</b>». ${nextStepsMsg}`, true);

        } else if (field === 'photos') {
          const url = this.getCabinetUrl(item);
          setStatus(`<a href="${url}" target="_blank" style="color:#fc3f1d;font-weight:600">Откройте ЯМ →</a> — загрузка фото через API не поддерживается.`);
          return;
        }
      }

      // ИСПРАВЛЕНИЕ: автоматически перезагружаем данные из МП после успешной отправки
      // Это нужно чтобы пользователь сразу увидел обновлённые данные
      setTimeout(async () => {
        setStatus('Загружаем актуальные данные из маркетплейса…');
        await this.reload();
        // Закрываем модальное окно после reload
        document.querySelector('[style*="position:fixed"]')?.remove();
      }, 2000);

    } catch (e: any) {
      try { skuEditLog.recordError(logEntry, e.message || String(e)); } catch (e) { debug.warn('[SkuAuditModule] swallowed error', e); }
      setStatus(`✗ ${e.message}`, false, true);
    }
  }

  /** Загружает фото с устройства, получает URL через Supabase Storage и добавляет в textarea */
  async handlePhotoUpload(input: HTMLInputElement, productId: string): Promise<void> {
    const files = Array.from(input.files || []);
    if (!files.length) return;

    const textarea = document.getElementById(`ief-${productId}-photos`) as HTMLTextAreaElement;
    const preview  = document.getElementById(`ief-${productId}-photo-preview`);
    const statusEl = document.getElementById(`ief-${productId}-status`);

    if (statusEl) statusEl.innerHTML = `<span style="color:var(--muted)">${I.hourglass('', 12)} Загружаем ${files.length} фото...</span>`;

    const { uploadPhoto } = await import('@/services/photoUpload');
    const uploadedUrls: string[] = [];
    let errors = 0;

    for (const file of files) {
      try {
        const url = await uploadPhoto(file, productId);
        uploadedUrls.push(url);
        // Превью
        if (preview) {
          const img = document.createElement('img');
          img.src = url;
          img.style.cssText = 'width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border)';
          img.title = url;
          preview.appendChild(img);
        }
      } catch {
        errors++;
      }
    }

    // Добавляем URL в textarea (новыми строками)
    if (uploadedUrls.length > 0 && textarea) {
      const existing = textarea.value.trim();
      textarea.value = existing ? `${existing}\n${uploadedUrls.join('\n')}` : uploadedUrls.join('\n');
    }

    if (statusEl) {
      if (errors === 0) {
        statusEl.innerHTML = `<span style="color:#16a34a">✓ ${uploadedUrls.length} фото готовы — нажмите Сохранить</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:#f97316">⚠ Загружено: ${uploadedUrls.length}, ошибок: ${errors}</span>`;
      }
    }

    input.value = ''; // сбрасываем input для повторного выбора
  }
}
