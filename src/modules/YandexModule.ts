/**
 * YandexModule — управление магазинами и товарами Яндекс Маркета.
 * Два таба: «Товары» (главный экран) + «Магазины» (настройки).
 * Аналог OzonModule по функционалу: список товаров с фото, ценой, остатками,
 * фильтрация, поиск, синхронизация с API Я.Маркета.
 */

import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { YandexStore, YandexProduct } from '@/types/yandex';
import { yandexDb } from '@/services/yandexDb';
import { refreshNavLockState } from '@/modules/NavigationModule';
import { yandexApi, fetchAllYandexProducts } from '@/services/yandexApi';

type View = 'products' | 'stores';

export class YandexModule {
  private container: HTMLElement;
  private stores: YandexStore[] = [];
  private products: YandexProduct[] = [];
  private view: View = 'products';
  private activeStoreId: string | null = null;   // null = "все"
  private search = '';
  private syncing: Record<string, boolean> = {};   // storeId → syncing?
  private addBusy = false;
  private lastError = '';

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async init(): Promise<void> {
    this.stores = await yandexDb.getStores();
    this.products = await yandexDb.getProducts();
    if (this.stores.length === 0) this.view = 'stores';
    this.render();
  }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render(): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        ${this.renderTopbar()}
        ${this.stores.length > 0 ? this.renderViewSwitcher() : ''}
        ${this.view === 'stores' ? this.renderStoresView() : this.renderProductsView()}
      </div>
    `;
  }

  private renderTopbar(): string {
    return `
      <div class="oz-topbar">
        <div class="oz-topbar-left">
          <button class="btn btn-back" onclick="window.app.navigateTo('marketplaces')" title="Назад к API Маркет">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M10 2L4 8l6 6"/></svg>
          </button>
          <div class="oz-brand">
            <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="3" fill="#fc3f1d"/>
              <text x="12" y="17" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Arial">Я</text>
            </svg>
            <span class="oz-brand-name">Яндекс Маркет</span>
          </div>
        </div>
        <div class="oz-topbar-right">
        </div>
      </div>
    `;
  }

  private renderViewSwitcher(): string {
    return `
      <div class="oz-toolbar">
        <div class="oz-tabs-scroll">
          <div class="oz-tabs">
            <button class="oz-tab ${!this.activeStoreId && this.view === 'products' ? 'active' : ''}"
              onclick="window.yandexModule.selectStore(null)">
              Все товары
              <span class="oz-tab-cnt">${this.products.length.toLocaleString('ru')}</span>
            </button>
            ${this.stores.map(s => {
              const cnt = this.products.filter(p => p.store_id === s.id).length;
              const busy = this.syncing[s.id];
              return `
                <button class="oz-tab ${this.activeStoreId === s.id && this.view === 'products' ? 'active' : ''}"
                  onclick="window.yandexModule.selectStore('${s.id}')">
                  <span class="oz-dot" style="background:#fc3f1d"></span>
                  ${this.esc(s.name)}
                  <span class="oz-tab-cnt">${cnt.toLocaleString('ru')}</span>
                  <span class="oz-tab-btns">
                    <span class="oz-tab-btn ${busy ? 'spinning' : ''}" title="Синхронизировать"
                      onclick="event.stopPropagation();window.yandexModule.syncStore('${s.id}')">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                        stroke-linecap="round"><path d="M14 8A6 6 0 1 1 8.5 2.1M14 2v4h-4"/></svg>
                    </span>
                  </span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
        <div class="oz-toolbar-right">
          <div class="oz-toolbar-search">
            <div class="search-wrap">
              <span class="search-ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3" stroke-linecap="round"/></svg></span>
              <input class="search-input" placeholder="Поиск по артикулу или названию…"
                value="${this.esc(this.search)}"
                oninput="window.yandexModule.setSearch(this.value)">
            </div>
          </div>
          <button class="oz-tab ${this.view === 'stores' ? 'active' : ''}"
            onclick="window.yandexModule.setView('stores')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px">
              <circle cx="8" cy="8" r="2"/>
              <path d="M13 8a5 5 0 0 0-.1-1l1.5-1.2-1.4-2.4-1.8.5a5 5 0 0 0-1.8-1L8.9 1H7.1l-.5 1.8a5 5 0 0 0-1.8 1l-1.8-.5L1.6 5.8 3.1 7a5 5 0 0 0 0 2L1.6 10.2l1.4 2.4 1.8-.5a5 5 0 0 0 1.8 1l.5 1.8h1.8l.5-1.8a5 5 0 0 0 1.8-1l1.8.5 1.4-2.4L12.9 9c.1-.3.1-.7.1-1z"/>
            </svg>
            Настройки
          </button>
        </div>
      </div>
    `;
  }

  // ── View: Товары ────────────────────────────────────────────────────────────

  private renderProductsView(): string {
    if (this.stores.length === 0) return this.renderStoresView();

    let list = this.products;
    if (this.activeStoreId) list = list.filter(p => p.store_id === this.activeStoreId);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(p =>
        p.offer_id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.vendor ?? '').toLowerCase().includes(q) ||
        (p.vendor_code ?? '').toLowerCase().includes(q),
      );
    }

    if (list.length === 0) {
      return `
        <div class="oz-empty" style="flex:1">
          <div class="oz-empty-title">${this.products.length === 0 ? 'Товары ещё не загружены' : 'Ничего не найдено'}</div>
          <div class="oz-empty-sub">${this.products.length === 0 ? 'Нажми «Синхронизировать всё» в правом верхнем углу — товары подтянутся из API Яндекс Маркета' : 'Попробуй изменить запрос'}</div>
        </div>
      `;
    }

    const rows = list.map(p => {
      const img = p.pictures?.[0];
      const storeName = this.stores.find(s => s.id === p.store_id)?.name ?? '—';
      const price = p.basic_price != null
        ? `${Math.round(p.basic_price).toLocaleString('ru')} ₽`
        : '—';
      const stockTotal = p.stock_total ?? 0;
      const stockClass = stockTotal === 0 ? 'oz-stock-0' : stockTotal < 5 ? 'oz-stock-low' : '';
      return `
        <tr class="oz-row">
          <td style="width:60px;padding:6px 8px">
            ${img
              ? `<a href="${this.esc(img)}" target="_blank" rel="noopener">
                  <img src="${this.esc(img)}" alt="" loading="lazy"
                    style="width:50px;height:50px;border-radius:6px;object-fit:cover;border:1px solid var(--border);cursor:zoom-in"
                    onerror="this.style.display='none'">
                </a>`
              : `<div style="width:50px;height:50px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:18px">${I.package('',18)}</div>`
            }
          </td>
          <td>
            <span class="oz-sku-chip" onclick="window.yandexModule.copyText('${this.esc(p.offer_id)}', this)">
              <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
              <span class="oz-sku-chip-text">${this.esc(p.offer_id)}</span>
            </span>
            ${p.vendor_code && p.vendor_code !== p.offer_id ? `<div class="oz-muted" style="font-size:11px;margin-top:3px;display:flex;align-items:center;gap:4px">арт.: ${this.esc(p.vendor_code)}${copyButton(p.vendor_code, 'Копировать артикул')}</div>` : ''}
          </td>
          <td style="max-width:400px">
            <div style="display:flex;align-items:flex-start;gap:4px">
              <div style="min-width:0;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical" title="${this.esc(p.name)}">
                ${this.esc(p.name) || 'Без названия'}
              </div>
              ${p.name ? copyButton(p.name, 'Копировать название') : ''}
            </div>
            ${p.vendor ? `<div class="oz-muted" style="font-size:11px;margin-top:2px">${this.esc(p.vendor)}</div>` : ''}
          </td>
          <td><span style="font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:4px">${this.esc(storeName)}${copyButton(storeName, 'Копировать название магазина')}</span></td>
          <td style="text-align:right;white-space:nowrap;font-weight:700">${price}</td>
          <td style="text-align:center" class="${stockClass}">
            <span style="font-weight:700">${stockTotal}</span>
            ${(p.stock_available ?? 0) !== stockTotal ? `<div class="oz-muted" style="font-size:10px">сейч.: ${p.stock_available ?? 0}</div>` : ''}
          </td>
          <td>${p.archived ? '<span class="oz-badge oz-s-archived">В архиве</span>' : '<span class="oz-badge oz-s-processed">Активен</span>'}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="oz-body" style="flex:1;overflow:auto">
        <div class="oz-table-wrap">
          <table class="oz-table">
            <thead><tr>
              <th></th>
              <th>Артикул</th>
              <th>Название</th>
              <th>Магазин</th>
              <th style="text-align:right">Цена</th>
              <th style="text-align:center">Остаток</th>
              <th>Статус</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── View: Магазины ──────────────────────────────────────────────────────────

  private renderStoresView(): string {
    return `
      <div style="flex:1;overflow:auto;padding:24px 24px 100px">
        <div style="max-width:760px;margin:0 auto">
          <div class="ym-card">
            <div class="ym-card-title">Подключить магазин</div>
            <div class="ym-card-desc">
              Введи <b>Api-Key токен</b> из кабинета продавца
              (<a href="https://partner.market.yandex.ru/" target="_blank" rel="noopener" style="color:#fc3f1d">partner.market.yandex.ru</a>
              → Настройки → API-ключи). После проверки токена все доступные магазины будут добавлены автоматически.
            </div>
            <div class="ym-form-row">
              <input type="password" id="ym-key" class="ym-input"
                placeholder="Api-Key (например, ACMA:xxxxxx...)"
                autocomplete="new-password" spellcheck="false">
              <input type="text" id="ym-name" class="ym-input"
                placeholder="Название (опционально)" style="max-width:200px"
                autocomplete="off" spellcheck="false">
              <button class="btn btn-primary" id="ym-add-btn"
                onclick="window.yandexModule.addStore()" ${this.addBusy ? 'disabled' : ''}>
                ${this.addBusy ? 'Проверка…' : 'Добавить'}
              </button>
            </div>
            <div class="ym-card-hint">
              Совет: копируй токен <b>сразу из кабинета</b>, без пробелов и кавычек.
              Если копировал из мессенджера — могут попасть невидимые символы.
            </div>
            ${this.lastError ? `<div class="ym-error">${this.esc(this.lastError)}</div>` : ''}
          </div>

          ${this.stores.length === 0
            ? `<div class="ym-empty">
                <div class="ym-empty-icon">${I.store('',14)}</div>
                <div class="ym-empty-title">Магазины не подключены</div>
                <div class="ym-empty-sub">Добавь первый магазин выше</div>
              </div>`
            : `<div class="ym-stores">
                <div class="ym-stores-title">Подключённые магазины (${this.stores.length})</div>
                ${this.stores.map(s => {
                  const cnt = this.products.filter(p => p.store_id === s.id).length;
                  const busy = this.syncing[s.id];
                  return `
                    <div class="ym-store-card">
                      <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
                        <div class="ym-store-ic">Я</div>
                        <div style="min-width:0;flex:1">
                          <input class="ym-store-name-input" value="${this.esc(s.name)}" title="Нажми, чтобы изменить название магазина"
                            onchange="window.yandexModule.renameStore('${s.id}', this.value)"
                            onkeydown="if(event.key==='Enter') this.blur()">
                          <div class="ym-store-meta">
                            <span>Campaign: <b>${s.campaign_id ?? '—'}</b></span>
                            ${s.business_id ? `<span>· Business: ${s.business_id}</span>` : ''}
                            ${s.placement_type ? `<span class="ym-badge">${s.placement_type}</span>` : ''}
                            <span>· Товаров: <b>${cnt}</b></span>
                          </div>
                        </div>
                      </div>
                      <div style="display:flex;gap:6px">
                        <button class="btn" onclick="window.yandexModule.syncStore('${s.id}')" ${busy ? 'disabled' : ''}
                          style="padding:5px 12px;font-size:12px">
                          ${busy ? 'Синхронизация…' : 'Синхронизировать'}
                        </button>
                        <button class="btn btn-danger" onclick="window.yandexModule.removeStore('${s.id}')"
                          style="padding:5px 12px;font-size:12px">Удалить</button>
                      </div>
                      <!-- Налоговые настройки -->
                      <div style="width:100%;margin-top:4px;padding-top:10px;border-top:1px solid var(--border)">
                        <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px">Налоговый режим</div>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                          <select id="ym-tax-model-${s.id}" class="ym-input" style="width:220px;padding:5px 8px;font-size:12px"
                            onchange="window.yandexModule.saveTax('${s.id}')">
                            <option value="" ${!s.tax_model ? 'selected' : ''}>Не задан</option>
                            <option value="usn6" ${s.tax_model === 'usn6' ? 'selected' : ''}>УСН «Доходы» — 6%</option>
                            <option value="usn15" ${s.tax_model === 'usn15' ? 'selected' : ''}>УСН «Доходы − расходы» — 15%</option>
                            <option value="osn" ${s.tax_model === 'osn' ? 'selected' : ''}>ОСН (НДС 22% + налог на прибыль)</option>
                            <option value="patent" ${s.tax_model === 'patent' ? 'selected' : ''}>Патент (ПСН)</option>
                            <option value="npd6" ${s.tax_model === 'npd6' ? 'selected' : ''}>НПД — 6% (от юрлиц/ИП)</option>
                            <option value="npd4" ${s.tax_model === 'npd4' ? 'selected' : ''}>НПД — 4% (от физлиц)</option>
                            <option value="ausn8" ${s.tax_model === 'ausn8' ? 'selected' : ''}>АУСН «Доходы» — 8%</option>
                            <option value="ausn20" ${s.tax_model === 'ausn20' ? 'selected' : ''}>АУСН «Доходы − расходы» — 20%</option>
                            <option value="eshn" ${s.tax_model === 'eshn' ? 'selected' : ''}>ЕСХН — 6%</option>
                          </select>
                          <div style="display:flex;align-items:center;gap:4px">
                            <input type="number" id="ym-tax-rate-${s.id}" class="ym-input"
                              style="width:70px;padding:5px 8px;font-size:12px" placeholder="%"
                              value="${s.tax_rate ?? ''}" min="0" max="100" step="0.1"
                              onchange="window.yandexModule.saveTax('${s.id}')">
                            <span style="font-size:11px;color:var(--text-3)">%</span>
                          </div>
                        </div>
                        <div style="font-size:10px;color:var(--text-3);margin-top:4px">Ставка подставляется автоматически, можно изменить вручную</div>
                      </div>
                      <!-- Модель фулфилмента -->
                      <div style="width:100%;margin-top:8px;padding-top:10px;border-top:1px solid var(--border)">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                          <div style="font-size:11px;font-weight:600;color:var(--text-2);white-space:nowrap">Модель фулфилмента:</div>
                          <select id="ym-fm-${s.id}" class="ym-input" style="width:200px;padding:5px 8px;font-size:12px"
                            onchange="window.yandexModule.saveFulfillment('${s.id}')">
                            <option value="" ${!s.fulfillment_model ? 'selected' : ''}>Смешанная / Не задана</option>
                            <option value="FBY" ${s.fulfillment_model === 'FBY' ? 'selected' : ''}>FBY — склад Яндекса</option>
                            <option value="FBS" ${s.fulfillment_model === 'FBS' ? 'selected' : ''}>FBS — свой склад, доставка ЯМ</option>
                            <option value="DBS" ${s.fulfillment_model === 'DBS' ? 'selected' : ''}>DBS — своя доставка</option>
                          </select>
                          ${s.fulfillment_model ? `<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:#fc3f1d22;color:#fc3f1d;font-weight:600">${this.esc(s.fulfillment_model)}</span>` : ''}
                        </div>
                        <div style="font-size:10px;color:var(--text-3);margin-top:4px">FBY — хранение и доставка ЯМ; FBS — своё хранение, курьер ЯМ; DBS — полностью своё. Влияет на аналитику логистики.</div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>`
          }
        </div>
      </div>
    `;
  }

  // ── Действия ────────────────────────────────────────────────────────────────

  selectStore(id: string | null): void {
    this.activeStoreId = id;
    this.view = 'products';
    this.render();
  }

  setView(v: View): void {
    this.view = v;
    this.render();
  }

  setSearch(q: string): void {
    this.search = q;
    this.render();
  }

  private static TAX_DEFAULTS: Record<string, number> = {
    usn6: 6, usn15: 15, osn: 22, patent: 0, npd6: 6, npd4: 4, ausn8: 8, ausn20: 20, eshn: 6,
  };

  async saveTax(storeId: string): Promise<void> {
    const modelEl = document.getElementById(`ym-tax-model-${storeId}`) as HTMLSelectElement | null;
    const rateEl = document.getElementById(`ym-tax-rate-${storeId}`) as HTMLInputElement | null;
    const tax_model = modelEl?.value || null;
    if (tax_model && rateEl) {
      const oldModel = this.stores.find(x => x.id === storeId)?.tax_model;
      if (oldModel !== tax_model) {
        const def = YandexModule.TAX_DEFAULTS[tax_model];
        if (def !== undefined) rateEl.value = String(def);
      }
    }
    const tax_rate = rateEl?.value ? parseFloat(rateEl.value) : null;
    try {
      await yandexDb.updateStore(storeId, { tax_model, tax_rate });
      const s = this.stores.find(x => x.id === storeId);
      if (s) { s.tax_model = tax_model; s.tax_rate = tax_rate; }
    } catch (err) { console.error('[YM] saveTax error:', err); }
  }

  async renameStore(storeId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const s = this.stores.find(x => x.id === storeId);
    if (!s) return;
    if (!trimmed || trimmed === s.name) { this.render(); return; }
    try {
      await yandexDb.updateStore(storeId, { name: trimmed });
      s.name = trimmed;
      this.render();
    } catch (err) { console.error('[Yandex] renameStore error:', err); this.render(); }
  }

  async saveFulfillment(storeId: string): Promise<void> {
    const el = document.getElementById(`ym-fm-${storeId}`) as HTMLSelectElement | null;
    const fulfillment_model = el?.value || null;
    try {
      await yandexDb.updateStore(storeId, { fulfillment_model } as any);
      const s = this.stores.find(x => x.id === storeId);
      if (s) { s.fulfillment_model = fulfillment_model; }
      this.render();
    } catch (err) { console.error('[YM] saveFulfillment error:', err); }
  }

  async syncAll(): Promise<void> {
    for (const s of this.stores) {
      await this.syncStore(s.id);
    }
  }

  async syncStore(storeId: string): Promise<void> {
    const store = this.stores.find(s => s.id === storeId);
    if (!store) return;
    if (this.syncing[storeId]) return;
    this.syncing[storeId] = true;
    this.render();
    try {
      const products = await fetchAllYandexProducts(store);
      // If API returned empty (rate-limit, 429) — keep existing data in DB
      if (products.length > 0) {
        await yandexDb.replaceStoreProducts(storeId, products);
      }
      this.products = await yandexDb.getProducts();
    } catch (err: any) {
      this.lastError = `Синхронизация «${store.name}»: ${err.message ?? err}`;
      console.error('[Yandex] sync error:', err);
    }
    this.syncing[storeId] = false;
    this.render();
  }

  async addStore(): Promise<void> {
    const keyInp = document.getElementById('ym-key') as HTMLInputElement | null;
    const nameInp = document.getElementById('ym-name') as HTMLInputElement | null;
    const rawKey = keyInp?.value ?? '';
    const customName = nameInp?.value.trim() ?? '';

    const apiKey = rawKey
      .replace(/[ ​-‍﻿]/g, '')
      .replace(/[‘’“”]/g, '')
      .trim();

    this.lastError = '';
    if (!apiKey) {
      this.lastError = 'Введи Api-Key токен';
      this.render();
      return;
    }
    if (!/^[\x21-\x7E]+$/.test(apiKey)) {
      this.lastError = 'В токене недопустимые символы (кириллица, фигурные кавычки, невидимые пробелы). Скопируй заново из кабинета Я.Маркета.';
      this.render();
      return;
    }

    this.addBusy = true;
    this.render();

    try {
      await yandexApi.checkToken(apiKey);
      const campaigns = await yandexApi.getCampaigns(apiKey);
      if (!campaigns.length) {
        this.lastError = 'У этого токена нет доступных магазинов';
        this.addBusy = false;
        this.render();
        return;
      }
      for (const c of campaigns) {
        await yandexDb.createStore({
          name: customName || c.domain || `Campaign ${c.id}`,
          api_key: apiKey,
          campaign_id: c.id,
          business_id: c.business?.id ?? null,
          placement_type: c.placementType,
        });
      }
      this.stores = await yandexDb.getStores();
      refreshNavLockState();
      this.addBusy = false;
      if (keyInp) keyInp.value = '';
      if (nameInp) nameInp.value = '';
      this.view = 'products';
      this.render();
    } catch (err: any) {
      this.lastError = err.message ?? String(err);
      this.addBusy = false;
      this.render();
    }
  }

  async removeStore(id: string): Promise<void> {
    if (!confirm('Удалить магазин? Все его товары тоже будут удалены.')) return;
    await yandexDb.deleteStore(id);
    this.stores = await yandexDb.getStores();
    this.products = await yandexDb.getProducts();
    if (this.activeStoreId === id) this.activeStoreId = null;
    if (this.stores.length === 0) this.view = 'stores';
    this.render();
  }

  copyText(s: string, el?: HTMLElement): void {
    navigator.clipboard?.writeText(String(s)).catch((e) => debug.warn('[YandexModule] swallowed error', e));
    if (el) {
      el.classList.add('oz-sku-chip-copied');
      setTimeout(() => el.classList.remove('oz-sku-chip-copied'), 1200);
    }
  }

  private esc(s: string | null | undefined): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
