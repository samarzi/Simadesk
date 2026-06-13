import { debug } from '@/utils/debug';
import { boxes, boxActions } from '../stores/appStore';
import { apiService } from '../services/api';
import { idbCache } from '../services/idbCache';
import { esc as escHtml } from '../utils/format';
import type { App } from '../App';

export class BoxMpLinkModule {
  constructor(private app: App) {}

  // ─────────────────────────────────────────────────────────────────────────
  // LINK/SYNC: Яндекс Маркет
  // ─────────────────────────────────────────────────────────────────────────

  async linkBoxToYM(boxId: string) {
    const skuField = (document.getElementById('bs-ym-sku-field') as HTMLSelectElement)?.value || 'Артикул*';
    const updates = { ym_linked: true, ym_sku_field: skuField };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.app.toast('Группа привязана к Яндекс Маркет', 'success');
    this.app.closeModal();
    this.app.renderBoxes();
    (window as any).settingsHub?.init?.();
    setTimeout(() => this.syncLinkedBoxYM(boxId), 300);
  }

  async unlinkBoxFromYM(boxId: string) {
    const updates = { ym_linked: false, ym_sku_field: null };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.app.toast('Группа отвязана от Яндекс Маркет', 'success');
    this.app.closeModal();
    this.app.renderBoxes();
    (window as any).settingsHub?.init?.();
  }

  async syncLinkedBoxYM(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.ym_linked) { this.app.toast('Группа не привязана к Яндекс Маркет', 'error'); return; }
    this.app.closeModal();
    this.app.toast('Синхронизация с Я.Маркет…', 'info', 2000);
    try {
      const { yandexDb } = await import('../services/yandexDb');
      const ymProducts = await yandexDb.getProducts();
      if (ymProducts.length === 0) {
        this.app.toast('Нет товаров ЯМ. Сначала выполните синхронизацию в разделе Яндекс Маркет.', 'error', 5000);
        return;
      }
      // Индекс по offer_id
      const ymByOfferId = new Map<string, typeof ymProducts[0][]>();
      for (const p of ymProducts) {
        const key = p.offer_id.toLowerCase().trim();
        if (!ymByOfferId.has(key)) ymByOfferId.set(key, []);
        ymByOfferId.get(key)!.push(p);
      }
      const ymStores: Array<{ id: string; name: string }> = (window as any).yandexModule?.stores || [];
      const groupProducts = await apiService.getProductsByBox(boxId);
      const skuField = box.ym_sku_field || 'Артикул*';

      type SyncStatus = 'matched' | 'not_found' | 'no_sku' | 'skipped';
      interface SyncResult { sku: string; name: string; status: SyncStatus; updatedFields: string[]; storeNames: string[] }
      const results: SyncResult[] = [];

      for (const prod of groupProducts) {
        // Проверяем флаг "синхронизация отключена"
        if (prod.data?.['_ym_sync_disabled']) {
          results.push({ sku: String(prod.data?.[skuField] || '—'), name: String(prod.data?.['Название товара'] || ''), status: 'skipped', updatedFields: [], storeNames: [] });
          continue;
        }
        const sku = String(prod.data?.[skuField] || '').trim();
        const prodName = String(prod.data?.['Название товара'] || sku);
        if (!sku) { results.push({ sku: '—', name: prodName, status: 'no_sku', updatedFields: [], storeNames: [] }); continue; }

        const ymGroup = ymByOfferId.get(sku.toLowerCase());
        if (!ymGroup || ymGroup.length === 0) {
          results.push({ sku, name: prodName, status: 'not_found', updatedFields: [], storeNames: [] });
          continue;
        }

        // Берём первый (или из предпочтительного магазина)
        const src = ymGroup[0];
        const storeNames = [...new Set(ymGroup.map(p => ymStores.find(s => s.id === p.store_id)?.name || p.store_id))];
        const updatedData: Record<string, any> = { ...prod.data };
        const changed: string[] = [];

        const maybeSet = (field: string, val: any) => {
          if (val != null && val !== '' && String(val) !== String(prod.data?.[field] ?? '')) {
            updatedData[field] = val;
            changed.push(field);
          }
        };
        maybeSet('Название товара', src.name);
        if (src.basic_price && src.basic_price > 0) maybeSet('Цена, руб.*', src.basic_price);
        if (src.stock_total != null) maybeSet('Остаток', src.stock_total);
        if (src.vendor) maybeSet('Бренд*', src.vendor);
        if (src.vendor_code) maybeSet('Артикул производителя', src.vendor_code);
        updatedData['_ym_synced_at'] = new Date().toISOString();

        await apiService.updateProduct(prod.id, { data: updatedData });
        results.push({ sku, name: prodName, status: 'matched', updatedFields: changed, storeNames });
      }

      this.app.cache.delete(boxId);
      idbCache.remove(boxId).catch((e) => debug.warn('[BoxMpLinkModule] swallowed error', e));
      if (this.app.activeBoxId === boxId) await this.app.loadBoxProducts();
      this.showMpSyncReport(results, box.name || boxId, 'Яндекс Маркет', '#fc3f1d');
    } catch (e: any) {
      this.app.toast('Ошибка синхронизации ЯМ: ' + e.message, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LINK/SYNC: Wildberries
  // ─────────────────────────────────────────────────────────────────────────

  async linkBoxToWB(boxId: string) {
    const skuField = (document.getElementById('bs-wb-sku-field') as HTMLSelectElement)?.value || 'Артикул*';
    const updates = { wb_linked: true, wb_sku_field: skuField };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.app.toast('Группа привязана к Wildberries', 'success');
    this.app.closeModal();
    this.app.renderBoxes();
    (window as any).settingsHub?.init?.();
    setTimeout(() => this.syncLinkedBoxWB(boxId), 300);
  }

  async unlinkBoxFromWB(boxId: string) {
    const updates = { wb_linked: false, wb_sku_field: null };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.app.toast('Группа отвязана от Wildberries', 'success');
    this.app.closeModal();
    this.app.renderBoxes();
    (window as any).settingsHub?.init?.();
  }

  async syncLinkedBoxWB(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.wb_linked) { this.app.toast('Группа не привязана к Wildberries', 'error'); return; }
    this.app.closeModal();
    this.app.toast('Синхронизация с WB…', 'info', 2000);
    try {
      const { wbDb } = await import('../services/wbDb');
      const wbProducts = await wbDb.getProducts();
      if (wbProducts.length === 0) {
        this.app.toast('Нет товаров WB. Сначала выполните синхронизацию в разделе Wildberries.', 'error', 5000);
        return;
      }
      // Индекс по vendor_code
      const wbByCode = new Map<string, typeof wbProducts[0][]>();
      for (const p of wbProducts) {
        const key = (p.vendor_code || '').toLowerCase().trim();
        if (!key) continue;
        if (!wbByCode.has(key)) wbByCode.set(key, []);
        wbByCode.get(key)!.push(p);
      }
      const wbStores: Array<{ id: string; name: string }> = (window as any).wbModule?.stores || [];
      const groupProducts = await apiService.getProductsByBox(boxId);
      const skuField = box.wb_sku_field || 'Артикул*';

      type SyncStatus = 'matched' | 'not_found' | 'no_sku' | 'skipped';
      interface SyncResult { sku: string; name: string; status: SyncStatus; updatedFields: string[]; storeNames: string[] }
      const results: SyncResult[] = [];

      for (const prod of groupProducts) {
        if (prod.data?.['_wb_sync_disabled']) {
          results.push({ sku: String(prod.data?.[skuField] || '—'), name: String(prod.data?.['Название товара'] || ''), status: 'skipped', updatedFields: [], storeNames: [] });
          continue;
        }
        const sku = String(prod.data?.[skuField] || '').trim();
        const prodName = String(prod.data?.['Название товара'] || sku);
        if (!sku) { results.push({ sku: '—', name: prodName, status: 'no_sku', updatedFields: [], storeNames: [] }); continue; }

        const wbGroup = wbByCode.get(sku.toLowerCase());
        if (!wbGroup || wbGroup.length === 0) {
          results.push({ sku, name: prodName, status: 'not_found', updatedFields: [], storeNames: [] });
          continue;
        }

        const src = wbGroup[0];
        const storeNames = [...new Set(wbGroup.map(p => wbStores.find(s => s.id === p.store_id)?.name || p.store_id))];
        const updatedData: Record<string, any> = { ...prod.data };
        const changed: string[] = [];

        const maybeSet = (field: string, val: any) => {
          if (val != null && val !== '' && String(val) !== String(prod.data?.[field] ?? '')) {
            updatedData[field] = val;
            changed.push(field);
          }
        };
        maybeSet('Название товара', src.title);
        if (src.price && src.price > 0) maybeSet('Цена, руб.*', src.price);
        if (src.stock_total != null) maybeSet('Остаток', src.stock_total);
        if (src.brand) maybeSet('Бренд*', src.brand);
        if (src.subject) maybeSet('Категория', src.subject);
        updatedData['_wb_synced_at'] = new Date().toISOString();
        updatedData['_wb_nm_id'] = src.nm_id;

        await apiService.updateProduct(prod.id, { data: updatedData });
        results.push({ sku, name: prodName, status: 'matched', updatedFields: changed, storeNames });
      }

      this.app.cache.delete(boxId);
      idbCache.remove(boxId).catch((e) => debug.warn('[BoxMpLinkModule] swallowed error', e));
      if (this.app.activeBoxId === boxId) await this.app.loadBoxProducts();
      this.showMpSyncReport(results, box.name || boxId, 'Wildberries', '#cb11ab');
    } catch (e: any) {
      this.app.toast('Ошибка синхронизации WB: ' + e.message, 'error');
    }
  }

  /** Сохранить метаданные группы (ym_linked, wb_linked и т.д.) в Supabase.
   *  Если колонки ещё не добавлены в БД — сохраняем в localStorage как fallback. */
  saveBoxMeta(boxId: string, updates: Partial<import('../types/index').Box>) {
    apiService.updateBox(boxId, updates).catch(_e => {
      // Fallback: сохраняем ym/wb линковку в localStorage до применения миграции
      const LS_KEY = 'box_meta_fallback';
      try {
        const store: Record<string, any> = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        store[boxId] = { ...(store[boxId] || {}), ...updates };
        localStorage.setItem(LS_KEY, JSON.stringify(store));
      } catch (e) { debug.warn('[BoxMpLinkModule] swallowed error', e); }
    });
    // Применяем к локальному стору немедленно
    boxActions.updateBox(boxId, updates as any);
  }

  /** Получить YM/WB метаданные из localStorage (fallback до применения миграции). */
  getBoxMetaFallback(boxId: string): Partial<import('../types/index').Box> {
    try {
      const store = JSON.parse(localStorage.getItem('box_meta_fallback') || '{}');
      return store[boxId] || {};
    } catch { return {}; }
  }

  /** Переключить флаг «синхронизация ЯМ/WB отключена» для конкретного товара. */
  async toggleSyncDisabled(prodId: string, mp: 'ym' | 'wb') {
    const prod = this.app.allProducts.find(p => p.id === prodId);
    if (!prod) return;
    const flag = `_${mp}_sync_disabled`;
    const current = !!prod.data?.[flag];
    const updatedData = { ...prod.data, [flag]: !current };
    await apiService.updateProduct(prodId, { data: updatedData });
    prod.data = updatedData;
    this.app.applyFilters(); // перерисовать
    this.app.toast(`Синхронизация ${mp === 'ym' ? 'ЯМ' : 'WB'} для товара ${!current ? 'отключена' : 'включена'}`, 'info', 1500);
  }

  /** Унифицированный отчёт синхронизации для ЯМ/WB. */
  private showMpSyncReport(
    results: Array<{ sku: string; name: string; status: 'matched' | 'not_found' | 'no_sku' | 'skipped'; updatedFields: string[]; storeNames: string[] }>,
    boxName: string,
    mpName: string,
    mpColor: string,
  ) {
    const matched   = results.filter(r => r.status === 'matched');
    const notFound  = results.filter(r => r.status === 'not_found');
    const noSku     = results.filter(r => r.status === 'no_sku');
    const skipped   = results.filter(r => r.status === 'skipped');
    const changed   = matched.filter(r => r.updatedFields.length > 0);
    const unchanged = matched.filter(r => r.updatedFields.length === 0);

    // Подсчёт по магазинам
    const storeCountMap = new Map<string, number>();
    for (const r of matched) {
      for (const s of r.storeNames) storeCountMap.set(s, (storeCountMap.get(s) || 0) + 1);
    }

    const statsHtml = `
      <div style="display:grid;grid-template-columns:repeat(${skipped.length > 0 ? 5 : 4},1fr);gap:10px;margin-bottom:20px">
        <div style="background:var(--green-dim);border:1px solid rgba(68,221,136,0.25);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${matched.length}</div>
          <div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Найдено</div>
        </div>
        <div style="background:color-mix(in srgb,${mpColor} 10%,transparent);border:1px solid color-mix(in srgb,${mpColor} 25%,transparent);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${mpColor}">${changed.length}</div>
          <div style="font-size:10px;color:${mpColor};text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Обновлено</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--text2)">${unchanged.length}</div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Без изменений</div>
        </div>
        <div style="background:${notFound.length > 0 ? 'var(--red-dim)' : 'var(--bg3)'};border:1px solid ${notFound.length > 0 ? 'rgba(255,68,68,0.25)' : 'var(--border)'};border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'}">${notFound.length}</div>
          <div style="font-size:10px;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'};text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Не найдено</div>
        </div>
        ${skipped.length > 0 ? `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--text3)">${skipped.length}</div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Пропущено</div>
        </div>` : ''}
      </div>
      ${noSku.length > 0 ? `<div style="font-size:11px;color:var(--text3);margin-bottom:12px">+ ${noSku.length} строк без артикула</div>` : ''}
      ${storeCountMap.size > 0 ? `
        <div style="margin-bottom:16px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">По магазинам</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${[...storeCountMap.entries()].map(([s, c]) => `
              <span style="padding:4px 10px;background:color-mix(in srgb,${mpColor} 10%,transparent);border:1px solid color-mix(in srgb,${mpColor} 25%,transparent);border-radius:20px;font-size:11px;color:${mpColor}">
                ${escHtml(s)} <strong>${c}</strong>
              </span>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;

    const tableRows = results.map(r => {
      const statusIcon = r.status === 'matched'
        ? (r.updatedFields.length > 0
          ? `<span style="color:var(--accent);font-size:11px;white-space:nowrap">✓ обновлён</span>`
          : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">= без изм.</span>`)
        : r.status === 'not_found'
          ? `<span style="color:var(--red);font-size:11px;white-space:nowrap">✕ не найден</span>`
          : r.status === 'skipped'
            ? `<span style="color:var(--text3);font-size:11px;white-space:nowrap">⏸ пропущен</span>`
            : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">— нет арт.</span>`;
      const borderStyle = r.status === 'matched' && r.updatedFields.length > 0
        ? `border-left:2px solid var(--accent);`
        : r.status === 'not_found' ? `border-left:2px solid var(--red);opacity:.65;` : '';
      return `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border);${borderStyle}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div>
              <code style="font-size:11px;color:var(--text3);background:var(--bg3);padding:1px 6px;border-radius:4px">${escHtml(r.sku)}</code>
              <span style="font-size:12px;color:var(--text);margin-left:8px">${escHtml(r.name.slice(0,60))}</span>
              ${r.updatedFields.length > 0 ? `<div style="font-size:10px;color:var(--muted);margin-top:3px">${r.updatedFields.map(f => `<span style="padding:1px 5px;background:color-mix(in srgb,${mpColor} 8%,transparent);border-radius:3px;color:${mpColor}">${escHtml(f.replace('*',''))}</span>`).join(' ')}</div>` : ''}
            </div>
            <div style="flex-shrink:0">${statusIcon}</div>
          </div>
        </div>`;
    }).join('');

    this.app.openModalLg(
      `Синхронизация ${mpName} — ${escHtml(boxName)}`,
      `${matched.length} из ${results.length} строк найдено`,
      `${statsHtml}<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:360px;overflow-y:auto">${tableRows || '<div style="padding:16px;text-align:center;color:var(--text3)">Нет данных</div>'}</div>`,
      `<button class="btn btn-primary" onclick="window.app.closeModal()">Готово</button>`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SYNC: Группа ↔ весь пункт Ozon (все магазины, по артикулу)
  // ─────────────────────────────────────────────────────────────────────────

  async syncLinkedBox(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.ozon_store_id) { this.app.toast('Группа не привязана к Ozon', 'error'); return; }

    const ozonModule = (window as any).ozonModule;
    if (!ozonModule?.products?.length) {
      this.app.toast('Нет данных Ozon. Сначала синхронизируйте магазины в разделе Ozon.', 'error');
      return;
    }

    try {
      // ── Все товары Ozon сгруппированные по offer_id (все магазины) ─────────
      const ozonGroups: Map<string, any> = ozonModule.groups || new Map();
      const ozonByOfferId = new Map<string, any>();

      if (ozonGroups.size > 0) {
        for (const [offerId, group] of ozonGroups) {
          ozonByOfferId.set(offerId.trim().toLowerCase(), group);
        }
      } else {
        // Fallback: группируем products вручную
        for (const p of ozonModule.products) {
          const key = (p.offer_id || '').trim().toLowerCase();
          if (!ozonByOfferId.has(key)) {
            ozonByOfferId.set(key, {
              offer_id: p.offer_id,
              name: p.name,
              images: p.images || [],
              category: p.category || '',
              stores: new Map(),
            });
          }
          ozonByOfferId.get(key).stores.set(p.store_id, p);
        }
      }

      // ── Загружаем товары группы ────────────────────────────────────────────
      const groupProducts = await apiService.getProductsByBox(boxId);
      const skuField = box.ozon_sku_field || 'Артикул*';
      const { applyOzonData, buildColumnMap } = await import('../utils/columnMapper');

      // Маппинг столбцов один раз для всей группы
      const sampleCols = groupProducts[0] ? Object.keys(groupProducts[0].data || {}) : [];
      const colMap = buildColumnMap(sampleCols);

      // ── Результаты ────────────────────────────────────────────────────────
      type SyncStatus = 'matched' | 'not_found' | 'no_sku';
      interface SyncResult {
        sku: string; name: string; status: SyncStatus;
        updatedFields: string[]; ozonStores: string[];
        oldValues: Record<string, string>; newValues: Record<string, string>;
      }
      const results: SyncResult[] = [];

      for (const prod of groupProducts) {
        const sku = String(prod.data?.[skuField] || '').trim();
        const prodName = String(prod.data?.['Название товара'] || sku);

        if (!sku) {
          results.push({ sku: '—', name: prodName, status: 'no_sku', updatedFields: [], ozonStores: [], oldValues: {}, newValues: {} });
          continue;
        }

        const ozonGroup = ozonByOfferId.get(sku.toLowerCase());
        if (!ozonGroup) {
          results.push({ sku, name: prodName, status: 'not_found', updatedFields: [], ozonStores: [], oldValues: {}, newValues: {} });
          continue;
        }

        const storesMap: Map<string, any> = ozonGroup.stores || new Map();
        const allProducts = [...storesMap.values()];
        const storeNames = [...storesMap.keys()].map(sid =>
          ozonModule.stores?.find((s: any) => s.id === sid)?.name || sid
        );

        // Подбираем данные из предпочтительного магазина, если он задан и товар там есть
        let targetProduct = box.ozon_preferred_store_id ? storesMap.get(box.ozon_preferred_store_id) : null;

        // Если в предпочтительном нет товара или в нем цена 0 — пытаемся найти другой магазин с ценой > 0
        if (!targetProduct || !targetProduct.price) {
          const productWithPrice = allProducts.find(p => (p.price || 0) > 0);
          if (productWithPrice) {
            targetProduct = productWithPrice;
          } else if (!targetProduct) {
            // Если совсем ничего не нашли с ценой, но есть хоть какой-то — берем первый
            targetProduct = allProducts[0];
          }
        }

        const ozonFlat: Record<string, string | number> = {
          name:      ozonGroup.name || targetProduct?.name || '',
          barcode:   targetProduct?.barcode   || '',
          category:  ozonGroup.category   || targetProduct?.category || '',
          status:    targetProduct?.status    || '',
          stock_fbs: [...storesMap.values()].reduce((s, p) => s + (p.stock_fbs || 0), 0),
          stock_fbo: [...storesMap.values()].reduce((s, p) => s + (p.stock_fbo || 0), 0),
        };

        // Если цена есть и она > 0 — добавляем в плоский объект для обновления
        if (targetProduct && (targetProduct.price || 0) > 0) {
          ozonFlat.price = targetProduct.price;
          ozonFlat.old_price = targetProduct.old_price || 0;
          ozonFlat.min_price = targetProduct.min_price || 0;
        }

        // Запоминаем старые значения
        const oldValues: Record<string, string> = {};
        const newValues: Record<string, string> = {};
        for (const [ozonField, localCol] of colMap) {
          if (localCol && ozonFlat[ozonField] !== undefined) {
            oldValues[localCol] = String(prod.data?.[localCol] ?? '');
            newValues[localCol] = String(ozonFlat[ozonField]);
          }
        }

        const { data: updatedData, mappedFields } = applyOzonData(prod.data || {}, ozonFlat, skuField);
        updatedData['_ozon_synced_at'] = new Date().toISOString();
        updatedData['_ozon_store_id']  = box.ozon_store_id!;

        // Запоминаем какие конкретно колонки привязались, чтобы подсветить их в UI
        const mappedLocalCols = mappedFields.map(mf => mf.split(' → ')[1]).filter(Boolean);
        updatedData['_ozon_mapped_cols'] = JSON.stringify(mappedLocalCols);

        const changedFields = mappedFields
          .filter(mf => {
            const localCol = mf.split(' → ')[1];
            return localCol && oldValues[localCol] !== newValues[localCol];
          })
          .map(mf => mf.split(' → ')[1])
          .filter(Boolean);

        await apiService.updateProduct(prod.id, { data: updatedData });
        results.push({ sku, name: prodName, status: 'matched', updatedFields: changedFields, ozonStores: storeNames, oldValues, newValues });
      }

      this.app.cache.delete(boxId);
      idbCache.remove(boxId).catch((e) => debug.warn('[BoxMpLinkModule] swallowed error', e));
      if (this.app.activeBoxId === boxId) await this.app.loadBoxProducts();

      this.showSyncReport(results, colMap, box.name || boxId);

    } catch (e: any) {
      this.app.toast('Ошибка синхронизации: ' + e.message, 'error');
    }
  }

  // ── Детальный отчёт синхронизации ─────────────────────────────────────────

  private showSyncReport(
    results: Array<{
      sku: string; name: string;
      status: 'matched' | 'not_found' | 'no_sku';
      updatedFields: string[]; ozonStores: string[];
      oldValues: Record<string, string>; newValues: Record<string, string>;
    }>,
    colMap: Map<string, string>,
    boxName: string,
  ) {
    const matched   = results.filter(r => r.status === 'matched');
    const notFound  = results.filter(r => r.status === 'not_found');
    const noSku     = results.filter(r => r.status === 'no_sku');
    const changed   = matched.filter(r => r.updatedFields.length > 0);
    const unchanged = matched.filter(r => r.updatedFields.length === 0);

    const fieldCounts = new Map<string, number>();
    for (const r of changed) {
      for (const f of r.updatedFields) {
        fieldCounts.set(f, (fieldCounts.get(f) || 0) + 1);
      }
    }

    const statsHtml = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
        <div style="background:var(--green-dim);border:1px solid rgba(68,221,136,0.25);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${matched.length}</div>
          <div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Найдено</div>
        </div>
        <div style="background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--accent)">${changed.length}</div>
          <div style="font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Обновлено</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--text2)">${unchanged.length}</div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Без изменений</div>
        </div>
        <div style="background:${notFound.length > 0 ? 'var(--red-dim)' : 'var(--bg3)'};border:1px solid ${notFound.length > 0 ? 'rgba(255,68,68,0.25)' : 'var(--border)'};border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'}">${notFound.length}</div>
          <div style="font-size:10px;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'};text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Не найдено</div>
        </div>
      </div>
      ${noSku.length > 0 ? `<div style="font-size:11px;color:var(--text3);margin-bottom:12px">+ ${noSku.length} строк без артикула (пропущены)</div>` : ''}
    `;

    const fieldsHtml = fieldCounts.size > 0 ? `
      <div style="margin-bottom:16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">Обновлённые поля</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${[...fieldCounts.entries()].sort((a,b) => b[1]-a[1]).map(([field, count]) => `
            <span style="padding:4px 10px;background:color-mix(in srgb,var(--accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);border-radius:20px;font-size:11px;color:var(--accent)">
              ${escHtml(field.replace('*',''))} <strong>${count}</strong>
            </span>
          `).join('')}
        </div>
      </div>
    ` : '';

    const tableRows = results.map(r => {
      const statusIcon = r.status === 'matched'
        ? (r.updatedFields.length > 0
          ? `<span style="color:var(--accent);font-size:11px;font-weight:600;white-space:nowrap">✓ обновлён</span>`
          : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">= без изменений</span>`)
        : r.status === 'not_found'
          ? `<span style="color:var(--red);font-size:11px;white-space:nowrap">✕ нет в Ozon</span>`
          : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">— нет артикула</span>`;

      const changesHtml = r.updatedFields.length > 0
        ? r.updatedFields.map(f => {
            const oldV = String(r.oldValues[f] || '—').slice(0, 25);
            const newV = String(r.newValues[f] || '—').slice(0, 25);
            return `<div style="font-size:10px;color:var(--text2);margin-top:2px">
              <span style="color:var(--text3)">${escHtml(f.replace('*',''))}: </span>
              <span style="text-decoration:line-through;color:var(--text3)">${escHtml(oldV)}</span>
              <span style="color:var(--accent);margin-left:4px">→ ${escHtml(newV)}</span>
            </div>`;
          }).join('')
        : '';

      const storesHtml = r.ozonStores.length > 0
        ? `<div style="margin-top:3px">${r.ozonStores.map(s =>
            `<span style="padding:1px 6px;background:color-mix(in srgb,#005bff 10%,transparent);border-radius:3px;color:#005bff;font-size:10px;margin-right:3px">${escHtml(s)}</span>`
          ).join('')}</div>`
        : '';

      const borderStyle = r.status === 'matched' && r.updatedFields.length > 0
        ? 'border-left:2px solid var(--accent);'
        : r.status === 'not_found'
          ? 'border-left:2px solid var(--red);opacity:.65;'
          : '';

      return `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border);${borderStyle}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div style="min-width:0;flex:1">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <code style="font-size:11px;color:var(--text3);flex-shrink:0;background:var(--bg3);padding:1px 6px;border-radius:4px">${escHtml(r.sku)}</code>
                <span style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">${escHtml(r.name.slice(0,60))}</span>
              </div>
              ${storesHtml}
              ${changesHtml}
            </div>
            <div style="flex-shrink:0;padding-top:1px">${statusIcon}</div>
          </div>
        </div>
      `;
    }).join('');

    const mappingRows = [...colMap.entries()]
      .filter(([, local]) => local)
      .map(([ozon, local]) => `
        <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11px">
          <code style="color:#005bff;background:color-mix(in srgb,#005bff 8%,transparent);padding:2px 6px;border-radius:4px;flex-shrink:0">${escHtml(ozon)}</code>
          <span style="color:var(--text3)">→</span>
          <span style="color:var(--text2)">${escHtml(local.replace('*',''))}</span>
        </div>
      `).join('');

    const body = `
      ${statsHtml}
      ${fieldsHtml}
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">
        Результат по строкам (${results.length} строк в группе)
      </div>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:340px;overflow-y:auto;margin-bottom:16px">
        ${tableRows || '<div style="padding:16px;text-align:center;color:var(--text3)">Нет данных</div>'}
      </div>
      ${colMap.size > 0 ? `
        <details>
          <summary style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);cursor:pointer;user-select:none;margin-bottom:4px">
            Маппинг столбцов (${colMap.size} полей)
          </summary>
          <div style="margin-top:8px;padding:10px 12px;background:var(--bg3);border-radius:8px">${mappingRows}</div>
        </details>
      ` : ''}
    `;

    this.app.openModalLg(
      `Синхронизация — ${escHtml(boxName)}`,
      `${matched.length} из ${results.length} строк найдено в Ozon`,
      body,
      `<button class="btn btn-primary" onclick="window.app.closeModal()">Готово</button>`
    );
  }
}
