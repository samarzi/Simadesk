import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { OzonStore, OzonProduct } from '@/types/ozon';
import { ozonApi, fetchAllOzonProducts } from '@/services/ozonApi';
import { ozonDb } from '@/services/ozonDb';

type View = 'products' | 'stores';

export class OzonModule {
  private container: HTMLElement;
  private stores: OzonStore[] = [];
  private products: OzonProduct[] = [];
  private view: View = 'products';
  private activeStoreId: string | null = null;
  private search = '';
  private syncing: Record<string, boolean> = {};
  private addBusy = false;
  private lastError = '';

  constructor(container: HTMLElement) { this.container = container; }

  async init(): Promise<void> {
    this.stores = await ozonDb.getStores();
    this.products = await ozonDb.getProducts();
    if (this.stores.length === 0) this.view = 'stores';
    this.render();
  }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }
  hide(): void { this.container.style.display = 'none'; }

  render(): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        ${this.renderTopbar()}
        ${this.stores.length > 0 ? this.renderSwitcher() : ''}
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
              <rect x="3" y="3" width="18" height="18" rx="3" fill="#005bff"/>
              <text x="12" y="17" text-anchor="middle" fill="white" font-size="11" font-weight="800" font-family="Arial">OZ</text>
            </svg>
            <span class="oz-brand-name">Ozon</span>
          </div>
        </div>
        <div class="oz-topbar-right">
        </div>
      </div>
    `;
  }

  private renderSwitcher(): string {
    return `
      <div class="oz-toolbar">
        <div class="oz-tabs-scroll">
          <div class="oz-tabs">
            <button class="oz-tab ${!this.activeStoreId && this.view === 'products' ? 'active' : ''}"
              onclick="window.ozonModule.selectStore(null)">
              Все товары
              <span class="oz-tab-cnt">${this.products.length.toLocaleString('ru')}</span>
            </button>
            ${this.stores.map(s => {
              const cnt = this.products.filter(p => p.store_id === s.id).length;
              const busy = this.syncing[s.id];
              return `
                <button class="oz-tab ${this.activeStoreId === s.id && this.view === 'products' ? 'active' : ''}"
                  onclick="window.ozonModule.selectStore('${s.id}')">
                  <span class="oz-dot" style="background:#005bff"></span>
                  ${this.esc(s.name)}
                  <span class="oz-tab-cnt">${cnt.toLocaleString('ru')}</span>
                  <span class="oz-tab-btns">
                    <span class="oz-tab-btn ${busy ? 'spinning' : ''}" title="Синхронизировать"
                      onclick="event.stopPropagation();window.ozonModule.syncStore('${s.id}')">
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
                oninput="window.ozonModule.setSearch(this.value)">
            </div>
          </div>
          <button class="oz-tab ${this.view === 'stores' ? 'active' : ''}"
            onclick="window.ozonModule.setView('stores')">
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

  private renderProductsView(): string {
    if (this.stores.length === 0) return this.renderStoresView();

    let list = this.products;
    if (this.activeStoreId) list = list.filter(p => p.store_id === this.activeStoreId);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(p =>
        p.offer_id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
      );
    }

    if (list.length === 0) {
      return `
        <div class="oz-empty" style="flex:1">
          <div class="oz-empty-title">${this.products.length === 0 ? 'Товары ещё не загружены' : 'Ничего не найдено'}</div>
          <div class="oz-empty-sub">${this.products.length === 0 ? 'Нажми «Синхронизировать всё» — товары подтянутся из Ozon' : 'Попробуй изменить запрос'}</div>
        </div>
      `;
    }

    const rows = list.map(p => {
      const img = p.images?.[0];
      const storeName = this.stores.find(s => s.id === p.store_id)?.name ?? '—';
      const price = p.price != null ? `${Math.round(p.price).toLocaleString('ru')} ₽` : '—';
      const stock = (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0);
      const stockClass = stock === 0 ? 'oz-stock-0' : stock < 5 ? 'oz-stock-low' : '';
      const statusLabel = p.status === 'processed' ? 'Активен'
        : p.status === 'disabled' ? 'Скрыт'
        : p.status === 'archived' ? 'Архив'
        : p.status ?? '—';
      const statusClass = p.status === 'processed' ? 'oz-s-processed'
        : p.status === 'disabled' ? 'oz-s-cancelled'
        : 'oz-s-archived';
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
            <span class="oz-sku-chip" onclick="window.ozonModule.copyText('${this.esc(p.offer_id)}', this)">
              <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
              <span class="oz-sku-chip-text">${this.esc(p.offer_id)}</span>
            </span>
          </td>
          <td style="max-width:400px">
            <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical" title="${this.esc(p.name)}">
              ${this.esc(p.name) || 'Без названия'}
            </div>
          </td>
          <td><span style="font-size:11px;color:var(--muted)">${this.esc(storeName)}</span></td>
          <td style="text-align:right;white-space:nowrap;font-weight:700">${price}</td>
          <td style="text-align:center" class="${stockClass}">
            <span style="font-weight:700">${stock}</span>
            ${p.stock_fbs || p.stock_fbo ? `<div class="oz-muted" style="font-size:10px">fbs:${p.stock_fbs ?? 0} fbo:${p.stock_fbo ?? 0}</div>` : ''}
          </td>
          <td><span class="oz-badge ${statusClass}">${statusLabel}</span></td>
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

  private renderStoresView(): string {
    return `
      <div style="flex:1;overflow:auto;padding:24px 24px 100px">
        <div style="max-width:760px;margin:0 auto">
          <div class="ym-card">
            <div class="ym-card-title">Подключить магазин Ozon</div>
            <div class="ym-card-desc">
              Введи <b>Client ID</b> и <b>Api Key</b> из кабинета продавца Ozon
              (<a href="https://seller.ozon.ru/" target="_blank" rel="noopener" style="color:#005bff">seller.ozon.ru</a>
              → Настройки → API-ключи → Создать ключ).
              Нужны права: <b>«Чтение»</b> для товаров и остатков.
            </div>
            <div class="ym-form-row" style="flex-wrap:wrap">
              <input type="text" id="oz-client-id" class="ym-input"
                placeholder="Client ID (числовой)" style="max-width:160px"
                autocomplete="off" spellcheck="false">
              <input type="password" id="oz-api-key" class="ym-input"
                placeholder="Api Key (xxxxxxxx-xxxx-...)"
                autocomplete="new-password" spellcheck="false">
              <input type="text" id="oz-name" class="ym-input"
                placeholder="Название (опционально)" style="max-width:200px"
                autocomplete="off" spellcheck="false">
              <button class="btn btn-primary" onclick="window.ozonModule.addStore()" ${this.addBusy ? 'disabled' : ''}>
                ${this.addBusy ? 'Проверка…' : 'Добавить'}
              </button>
            </div>
            <div class="ym-card-hint">
              Client ID — целое число (например, 12345). Api Key — UUID-подобная строка из кабинета.
            </div>
            ${this.lastError ? `<div class="ym-error">${this.esc(this.lastError)}</div>` : ''}
          </div>

          ${this.stores.length === 0
            ? `<div class="ym-empty">
                <div class="ym-empty-icon">${I.ozon('',14)}</div>
                <div class="ym-empty-title">Магазины Ozon не подключены</div>
                <div class="ym-empty-sub">Добавь Client ID и Api Key выше</div>
              </div>`
            : `<div class="ym-stores">
                <div class="ym-stores-title">Подключённые магазины (${this.stores.length})</div>
                ${this.stores.map(s => {
                  const cnt = this.products.filter(p => p.store_id === s.id).length;
                  const busy = this.syncing[s.id];
                  return `
                    <div class="ym-store-card">
                      <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
                        <div class="ym-store-ic" style="background:#005bff;font-size:11px">OZ</div>
                        <div style="min-width:0;flex:1">
                          <input class="ym-store-name-input" value="${this.esc(s.name)}" title="Нажми, чтобы изменить название магазина"
                            onchange="window.ozonModule.renameStore('${s.id}', this.value)"
                            onkeydown="if(event.key==='Enter') this.blur()">
                          <div class="ym-store-meta">
                            <span>Client ID: <b>${this.esc(s.client_id)}</b></span>
                            <span>· Товаров: <b>${cnt}</b></span>
                          </div>
                        </div>
                      </div>
                      <div style="display:flex;gap:6px">
                        <button class="btn" onclick="window.ozonModule.syncStore('${s.id}')" ${busy ? 'disabled' : ''}
                          style="padding:5px 12px;font-size:12px">
                          ${busy ? 'Синхронизация…' : 'Синхронизировать'}
                        </button>
                        <button class="btn btn-danger" onclick="window.ozonModule.removeStore('${s.id}')"
                          style="padding:5px 12px;font-size:12px">Удалить</button>
                      </div>
                      <!-- Налоговые настройки -->
                      <div style="width:100%;margin-top:4px;padding-top:10px;border-top:1px solid var(--border)">
                        <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:6px">Налоговый режим</div>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                          <select id="oz-tax-model-${s.id}" class="ym-input" style="width:220px;padding:5px 8px;font-size:12px"
                            onchange="window.ozonModule.saveTax('${s.id}')">
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
                            <input type="number" id="oz-tax-rate-${s.id}" class="ym-input"
                              style="width:70px;padding:5px 8px;font-size:12px" placeholder="%"
                              value="${s.tax_rate ?? ''}" min="0" max="100" step="0.1"
                              onchange="window.ozonModule.saveTax('${s.id}')">
                            <span style="font-size:11px;color:var(--text-3)">%</span>
                          </div>
                        </div>
                        <div style="font-size:10px;color:var(--text-3);margin-top:4px">Ставка подставляется автоматически, можно изменить вручную</div>
                      </div>
                      <!-- Модель фулфилмента -->
                      <div style="width:100%;margin-top:8px;padding-top:10px;border-top:1px solid var(--border)">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                          <div style="font-size:11px;font-weight:600;color:var(--text-2);white-space:nowrap">Модель фулфилмента:</div>
                          <select id="oz-fm-${s.id}" class="ym-input" style="width:180px;padding:5px 8px;font-size:12px"
                            onchange="window.ozonModule.saveFulfillment('${s.id}')">
                            <option value="" ${!s.fulfillment_model ? 'selected' : ''}>Смешанная / Не задана</option>
                            <option value="FBO" ${s.fulfillment_model === 'FBO' ? 'selected' : ''}>FBO — склад Ozon</option>
                            <option value="FBS" ${s.fulfillment_model === 'FBS' ? 'selected' : ''}>FBS — свой склад, доставка Ozon</option>
                            <option value="rFBS" ${s.fulfillment_model === 'rFBS' ? 'selected' : ''}>rFBS — своя доставка</option>
                          </select>
                          ${s.fulfillment_model ? `<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:#005bff22;color:#005bff;font-weight:600">${this.esc(s.fulfillment_model)}</span>` : ''}
                        </div>
                        <div style="font-size:10px;color:var(--text-3);margin-top:4px">Влияет на аналитику: FBO — логистика Ozon, FBS — своя. Если магазин смешанный — оставь пустым.</div>
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

  selectStore(id: string | null): void {
    this.activeStoreId = id;
    this.view = 'products';
    this.render();
  }
  setView(v: View): void { this.view = v; this.render(); }
  setSearch(q: string): void { this.search = q; this.render(); }

  private static TAX_DEFAULTS: Record<string, number> = {
    usn6: 6, usn15: 15, osn: 22, patent: 0, npd6: 6, npd4: 4, ausn8: 8, ausn20: 20, eshn: 6,
  };

  async saveTax(storeId: string): Promise<void> {
    const modelEl = document.getElementById(`oz-tax-model-${storeId}`) as HTMLSelectElement | null;
    const rateEl = document.getElementById(`oz-tax-rate-${storeId}`) as HTMLInputElement | null;
    const tax_model = modelEl?.value || null;
    if (tax_model && rateEl) {
      const oldModel = this.stores.find(x => x.id === storeId)?.tax_model;
      if (oldModel !== tax_model) {
        const def = OzonModule.TAX_DEFAULTS[tax_model];
        if (def !== undefined) rateEl.value = String(def);
      }
    }
    const tax_rate = rateEl?.value ? parseFloat(rateEl.value) : null;
    try {
      await ozonDb.updateStore(storeId, { tax_model, tax_rate });
      const s = this.stores.find(x => x.id === storeId);
      if (s) { s.tax_model = tax_model; s.tax_rate = tax_rate; }
    } catch (err) { console.error('[Ozon] saveTax error:', err); }
  }

  async renameStore(storeId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const s = this.stores.find(x => x.id === storeId);
    if (!s) return;
    if (!trimmed || trimmed === s.name) { this.render(); return; }
    try {
      await ozonDb.updateStore(storeId, { name: trimmed });
      s.name = trimmed;
      this.render();
    } catch (err) { console.error('[Ozon] renameStore error:', err); this.render(); }
  }

  async saveFulfillment(storeId: string): Promise<void> {
    const el = document.getElementById(`oz-fm-${storeId}`) as HTMLSelectElement | null;
    const fulfillment_model = el?.value || null;
    try {
      await ozonDb.updateStore(storeId, { fulfillment_model } as any);
      const s = this.stores.find(x => x.id === storeId);
      if (s) { s.fulfillment_model = fulfillment_model; }
      this.render();
    } catch (err) { console.error('[Ozon] saveFulfillment error:', err); }
  }

  async syncAll(): Promise<void> {
    for (const s of this.stores) await this.syncStore(s.id);
  }

  async syncStore(storeId: string): Promise<void> {
    const store = this.stores.find(s => s.id === storeId);
    if (!store || this.syncing[storeId]) return;
    this.syncing[storeId] = true;
    this.render();
    try {
      const products = await fetchAllOzonProducts(store);
      // If API returned empty (rate-limit, 429) — keep existing data in DB
      if (products.length > 0) {
        await ozonDb.replaceStoreProducts(storeId, products);
      }
      this.products = await ozonDb.getProducts();
    } catch (err: any) {
      this.lastError = `Синхронизация «${store.name}»: ${err.message ?? err}`;
      console.error('[Ozon] sync error:', err);
    }
    this.syncing[storeId] = false;
    this.render();
  }

  async addStore(): Promise<void> {
    const clientIdInp = document.getElementById('oz-client-id') as HTMLInputElement | null;
    const keyInp = document.getElementById('oz-api-key') as HTMLInputElement | null;
    const nameInp = document.getElementById('oz-name') as HTMLInputElement | null;

    const clientId = (clientIdInp?.value ?? '').trim();
    const apiKey = (keyInp?.value ?? '')
      .replace(/[ ​-‏﻿]/g, '')
      .replace(/[''""]/g, '')
      .trim();
    const customName = nameInp?.value.trim() ?? '';

    this.lastError = '';
    if (!clientId) { this.lastError = 'Введи Client ID'; this.render(); return; }
    if (!apiKey) { this.lastError = 'Введи Api Key'; this.render(); return; }
    if (!/^\d+$/.test(clientId)) { this.lastError = 'Client ID должен быть числом'; this.render(); return; }

    this.addBusy = true;
    this.render();

    try {
      const creds = { client_id: clientId, api_key: apiKey };
      await ozonApi.checkToken(creds);
      await ozonDb.createStore({
        name: customName || `Ozon ${clientId}`,
        client_id: clientId,
        api_key: apiKey,
      });
      this.stores = await ozonDb.getStores();
      this.addBusy = false;
      if (clientIdInp) clientIdInp.value = '';
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
    if (!confirm('Удалить магазин Ozon? Все его товары тоже будут удалены.')) return;
    await ozonDb.deleteStore(id);
    await ozonDb.deleteProductsByStore(id);
    this.stores = await ozonDb.getStores();
    this.products = await ozonDb.getProducts();
    if (this.activeStoreId === id) this.activeStoreId = null;
    if (this.stores.length === 0) this.view = 'stores';
    this.render();
  }

  copyText(s: string, el?: HTMLElement): void {
    navigator.clipboard?.writeText(String(s)).catch((e) => debug.warn('[OzonModule] swallowed error', e));
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
