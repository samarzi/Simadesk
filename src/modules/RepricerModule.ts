/**
 * RepricerModule — управление правилами ценообразования.
 * WB, Ozon, Яндекс Маркет. Несколько магазинов на каждом МП.
 *
 * Это «оркестратор»: хранит состояние и бизнес-логику, а рендер HTML и
 * расчёт цен вынесены в src/modules/repricer/*:
 *  - pricing.ts            — единая формула расчёта целевой цены (display === apply)
 *  - catalog.ts             — объединение каталога МП, остатки/цены/картинки
 *  - tabs/RulesTab.ts        — вкладка «Правила»
 *  - tabs/CostsTab.ts        — вкладка «Себестоимости»
 *  - tabs/LogTab.ts          — вкладка «История»
 *  - components/RuleForm.ts — форма создания/редактирования правила
 *  - components/ProductPicker.ts — пикер товаров
 */

import { I } from '@/utils/icons';
import { debug } from '@/utils/debug';
import { wbDb } from '@/services/wbDb';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { updateWbPrices } from '@/services/wbApi';
import { ozonApi } from '@/services/ozonApi';
import { helpBtn } from '@/services/helpModal';
import { yandexApi } from '@/services/yandexApi';
import { costPriceDb } from '@/services/costPriceDb';
import { repricerRulesDb } from '@/services/repricerRulesDb';
import { WbProduct, WbStore } from '@/types/wb';
import { OzonProduct, OzonStore } from '@/types/ozon';
import { YandexProduct, YandexStore } from '@/types/yandex';
import * as XLSX from 'xlsx';
import '@/styles/repricer.css';

import { LOG_KEY } from './repricer/types';
import type { Mp, PriceLog, RepricerRule, RuleProduct, RuleStatus, RuleType, SchedulePeriod, UnifiedProduct } from './repricer/types';
import { ruleProducts, uid } from './repricer/utils';
import { computeTargetPrice } from './repricer/pricing';
import * as catalog from './repricer/catalog';
import type { CatalogData } from './repricer/catalog';
import { renderRules as renderRulesTab, renderRulesInner as renderRulesInnerTab } from './repricer/tabs/RulesTab';
import type { RulesTabProps } from './repricer/tabs/RulesTab';
import { renderLog as renderLogTab } from './repricer/tabs/LogTab';
import { renderCosts as renderCostsTab } from './repricer/tabs/CostsTab';
import type { CostsTabProps } from './repricer/tabs/CostsTab';
import { renderForm as renderRuleForm } from './repricer/components/RuleForm';
import type { RuleFormProps } from './repricer/components/RuleForm';
import { renderPicker, renderPickerOverlay } from './repricer/components/ProductPicker';
import type { ProductPickerProps } from './repricer/components/ProductPicker';

export type { RepricerRule };

function loadLog(): PriceLog[] { try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]'); } catch { return []; } }
function saveLog(l: PriceLog[]): void { localStorage.setItem(LOG_KEY, JSON.stringify(l.slice(0, 500))); }

export class RepricerModule {
  private container: HTMLElement;
  private rules: RepricerRule[] = [];
  private log: PriceLog[] = [];

  private wbProducts:    WbProduct[]     = [];
  private ozonProducts:  OzonProduct[]   = [];
  private ymProducts:    YandexProduct[] = [];
  private wbStores:      WbStore[]       = [];
  private ozonStores:    OzonStore[]     = [];
  private ymStores:      YandexStore[]   = [];

  private tab: 'rules' | 'log' | 'costs' = 'rules';

  // ── Cost-prices manager ───────────────────────────────────────────
  private costsSearch = '';
  private costsMpFilter: '' | Mp = '';
  private costsSelected = new Set<string>();      // vendorCode (нормализован)
  private costsBulkValue: number | '' = '';
  /** Lowercased vendor_code/sku из исторических транзакций МП.
   *  Используется чтобы помечать orphan-артикулы как "архив" (был в продажах)
   *  vs "удалён" (нигде не встречался). Грузится один раз при открытии таба. */
  private soldVendorCodes: Set<string> | null = null;
  private soldVendorCodesLoading = false;
  private editId: string | null = null;
  private showForm = false;
  private form: Partial<RepricerRule> = {};
  private formError = '';
  // Выбранные магазины в форме (до выбора товара)
  private formStoreIds = new Set<string>();
  // Список выбранных товаров для правила (мульти-выбор)
  private formProducts: RuleProduct[] = [];
  private applying = new Set<string>();
  private applyErrors = new Map<string, string>(); // ruleId → error message

  // ── Per-store formulas (для типа formula: каждый магазин = своя формула) ──
  private formStoreFormulas: Map<string, string> = new Map(); // storeId → formula

  // ── Rules list filter / search ──────────────────────────────────────────────
  private rulesSearch = '';
  private rulesTypeFilter: '' | RuleType = '';

  // ── Product picker (выбор товаров из всех МП с дедупликацией по артикулу) ──
  private pickerOpen = false;
  private pickerSelected = new Set<string>();      // ключи UnifiedProduct.vendorCode
  private pickerSearch = '';
  private pickerSelectedMps  = new Set<Mp>();      // выбранные маркетплейсы (кнопки)
  private pickerSelectedStores = new Set<string>(); // выбранные магазины (кнопки)
  private pickerStockFilter: 'all' | 'in' | 'out' = 'all';

  constructor(container: HTMLElement) { this.container = container; }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    await repricerRulesDb.refresh();
    this.rules = repricerRulesDb.all();
    this.log   = loadLog();

    const [[wbS, wbP], [ozS, ozP], [ymS, ymP]] = await Promise.all([
      Promise.all([wbDb.getStores(), wbDb.getProducts()]).catch(() => [[], []] as [WbStore[], WbProduct[]]),
      Promise.all([ozonDb.getStores(), ozonDb.getProducts()]).catch(() => [[], []] as [OzonStore[], OzonProduct[]]),
      Promise.all([yandexDb.getStores(), yandexDb.getProducts()]).catch(() => [[], []] as [YandexStore[], YandexProduct[]]),
    ]);
    this.wbStores = wbS as WbStore[]; this.wbProducts = wbP as WbProduct[];
    this.ozonStores = ozS as OzonStore[]; this.ozonProducts = ozP as OzonProduct[];
    this.ymStores = ymS as YandexStore[]; this.ymProducts = ymP as YandexProduct[];

    this.render();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  setTab(t: 'rules' | 'log' | 'costs'): void {
    this.tab = t;
    if (t === 'costs') {
      costPriceDb.refresh().then(() => this.render()).catch(() => this.render());
      this.loadSoldVendorCodes();
    } else {
      this.render();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  КАТАЛОГ / ЦЕНЫ
  // ════════════════════════════════════════════════════════════════════════

  private catalogData(): CatalogData {
    return {
      wbProducts: this.wbProducts, wbStores: this.wbStores,
      ozonProducts: this.ozonProducts, ozonStores: this.ozonStores,
      ymProducts: this.ymProducts, ymStores: this.ymStores,
    };
  }

  /** Объединяет товары всех МП по артикулу (vendorCode). */
  private buildUnifiedProducts(): UnifiedProduct[] {
    return catalog.buildUnifiedProducts(this.catalogData());
  }

  /**
   * Целевая цена правила для отображения в списке («цель») — считается по
   * первому/основному товару правила. Та же формула, что и при применении
   * (см. computePriceForProduct), поэтому индикатор «✓/≠ совпадает с текущей»
   * соответствует тому, что реально будет установлено по кнопке «▶».
   */
  private computePrice(rule: RepricerRule): number | null {
    const stock = catalog.getStock(this.catalogData(), rule.marketplace, rule.productId);
    const cost = costPriceDb.get(rule.vendorCode);
    return computeTargetPrice(rule, { stock, cost });
  }

  /** Целевая цена для конкретного товара правила (себестоимость и остаток — свои). */
  private computePriceForProduct(rule: RepricerRule, prod: RuleProduct): number | null {
    const stock = catalog.getStock(this.catalogData(), rule.marketplace, prod.productId);
    const cost = costPriceDb.get(prod.vendorCode);
    return computeTargetPrice(rule, { stock, cost });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PRODUCT PICKER
  // ════════════════════════════════════════════════════════════════════════

  /** Отфильтрованный список юнифицированных товаров для пикера.
   *  Базовый фильтр — formStoreIds (магазины выбранные в форме).
   *  Дополнительные фильтры пикера — pickerSelectedMps, pickerSelectedStores.
   */
  private get pickerFiltered(): UnifiedProduct[] {
    const all = this.buildUnifiedProducts();
    const q = this.pickerSearch.toLowerCase().trim();
    return all.filter(p => {
      // Базовый фильтр: только товары из выбранных в форме магазинов
      if (this.formStoreIds.size > 0 && !p.variants.some(v => this.formStoreIds.has(v.storeId))) return false;
      // Дополнительные фильтры пикера
      if (this.pickerSelectedMps.size > 0 && !p.variants.some(v => this.pickerSelectedMps.has(v.mp))) return false;
      if (this.pickerSelectedStores.size > 0 && !p.variants.some(v => this.pickerSelectedStores.has(v.storeId))) return false;
      if (this.pickerStockFilter !== 'all') {
        const totalStock = p.variants.reduce((s, v) => s + v.stock, 0);
        if (this.pickerStockFilter === 'in' && totalStock === 0) return false;
        if (this.pickerStockFilter === 'out' && totalStock > 0) return false;
      }
      if (q) {
        const hay = `${p.vendorCode} ${p.title}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  togglePickerMp(mp: Mp): void {
    if (this.pickerSelectedMps.has(mp)) this.pickerSelectedMps.delete(mp);
    else this.pickerSelectedMps.add(mp);
    this.pickerSelectedStores.clear(); // сбрасываем магазины при смене МП-фильтра
    this.renderPickerOnly();
  }

  togglePickerStore(storeId: string): void {
    if (this.pickerSelectedStores.has(storeId)) this.pickerSelectedStores.delete(storeId);
    else this.pickerSelectedStores.add(storeId);
    this.renderPickerOnly();
  }

  clearPickerStores(): void {
    this.pickerSelectedStores.clear();
    this.renderPickerOnly();
  }

  clearPickerMps(): void {
    this.pickerSelectedMps.clear();
    this.pickerSelectedStores.clear();
    this.renderPickerOnly();
  }

  /** Магазины, показываемые в пикере с учётом выбранных МП (или все если МП не выбраны). */
  private storesForPicker(): Array<{ id: string; name: string; mp: Mp }> {
    const mps = this.pickerSelectedMps;
    const all = catalog.allStoresFlat(this.catalogData());
    if (mps.size === 0) return all;
    return all.filter(s => mps.has(s.mp));
  }

  openProductPicker(): void {
    this.pickerOpen = true;
    this.pickerSelected.clear();
    this.pickerSearch = '';
    this.pickerSelectedMps.clear();
    this.pickerSelectedStores.clear();
    this.pickerStockFilter = 'all';
    // Подхватываем все товары из formProducts
    for (const p of this.formProducts) {
      this.pickerSelected.add(p.vendorCode.toLowerCase());
    }
    this.render();
  }

  closeProductPicker(): void {
    this.pickerOpen = false;
    this.render();
  }

  setPickerSearch(q: string): void { this.pickerSearch = q; this.renderPickerOnly(); }
  setPickerStock(s: string): void { this.pickerStockFilter = s as any; this.renderPickerOnly(); }

  togglePickerItem(vendorCode: string): void {
    const k = vendorCode.toLowerCase();
    if (this.pickerSelected.has(k)) this.pickerSelected.delete(k);
    else this.pickerSelected.add(k);
    this.renderPickerOnly();
  }

  togglePickerAll(): void {
    const filtered = this.pickerFiltered;
    const allSelected = filtered.every(p => this.pickerSelected.has(p.vendorCode.toLowerCase()));
    if (allSelected) filtered.forEach(p => this.pickerSelected.delete(p.vendorCode.toLowerCase()));
    else filtered.forEach(p => this.pickerSelected.add(p.vendorCode.toLowerCase()));
    this.renderPickerOnly();
  }

  applyPickerSelection(): void {
    const all = this.buildUnifiedProducts();
    const selected = all.filter(p => this.pickerSelected.has(p.vendorCode.toLowerCase()));
    if (selected.length === 0) { this.closeProductPicker(); return; }

    if (selected.length === 1) {
      // Один товар → подставляем в форму
      const p = selected[0];
      const candidates = p.variants.filter(v => this.formStoreIds.has(v.storeId));
      const v = candidates[0] ?? p.variants[0];
      this.form.marketplace = v.mp;
      this.form.productId = v.productId;
      this.form.vendorCode = p.vendorCode;
      this.form.productTitle = p.title;
      this.form.storeId = v.storeId;
      this.form.storeName = v.storeName;
      this.formProducts = [{ productId: v.productId, vendorCode: p.vendorCode, productTitle: p.title }];
    } else {
      // Несколько товаров → добавляем все в список формы
      this.formProducts = selected.map(p => {
        const candidates = p.variants.filter(v => this.formStoreIds.has(v.storeId));
        const v = candidates[0] ?? p.variants[0];
        return { productId: v.productId, vendorCode: p.vendorCode, productTitle: p.title };
      });
      const first = selected[0];
      const fv = first.variants.filter(v => this.formStoreIds.has(v.storeId))[0] ?? first.variants[0];
      this.form.marketplace = fv.mp;
      this.form.productId = fv.productId;
      this.form.vendorCode = first.vendorCode;
      this.form.productTitle = first.title;
      this.form.storeId = fv.storeId;
      this.form.storeName = fv.storeName;
    }
    this.pickerOpen = false;
    this.render();
  }

  /** Удалить товар из списка формы */
  removeFormProduct(vendorCode: string): void {
    this.formProducts = this.formProducts.filter(p => p.vendorCode !== vendorCode);
    if (this.formProducts.length === 0) {
      delete this.form.productId;
      delete this.form.vendorCode;
      delete this.form.productTitle;
    } else if (this.form.vendorCode === vendorCode) {
      // Если удалили текущий "основной" — берём первый из списка
      const f = this.formProducts[0];
      this.form.productId = f.productId;
      this.form.vendorCode = f.vendorCode;
      this.form.productTitle = f.productTitle;
    }
    this.render();
  }

  private pickerProps(): ProductPickerProps {
    return {
      list: this.pickerFiltered,
      allCount: this.buildUnifiedProducts().length,
      pickerSelected: this.pickerSelected,
      pickerSearch: this.pickerSearch,
      pickerSelectedMps: this.pickerSelectedMps,
      pickerSelectedStores: this.pickerSelectedStores,
      pickerStockFilter: this.pickerStockFilter,
      pickerStores: this.storesForPicker(),
      hasWb: this.wbStores.length > 0,
      hasOzon: this.ozonStores.length > 0,
      hasYandex: this.ymStores.length > 0,
    };
  }

  /** Лёгкая перерисовка только содержимого пикера без потери фокуса на поиске */
  private renderPickerOnly(): void {
    const host = document.getElementById('rp-picker-host');
    if (!host) return;
    const active = document.activeElement as HTMLInputElement | null;
    const wasSearch = active?.type === 'search';
    const selStart = wasSearch ? active!.selectionStart : null;
    const selEnd   = wasSearch ? active!.selectionEnd   : null;
    host.innerHTML = renderPicker(this.pickerProps());
    if (wasSearch) {
      const inp = host.querySelector('input[type="search"]') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        if (selStart !== null && selEnd !== null) inp.setSelectionRange(selStart, selEnd);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ФОРМА ПРАВИЛА
  // ════════════════════════════════════════════════════════════════════════

  openAddForm(): void {
    this.editId = null;
    this.form = { type: 'target', status: 'active' };
    this.formStoreIds.clear();
    this.formProducts = [];
    this.formStoreFormulas = new Map();
    this.showForm = true; this.formError = '';
    this.tab = 'rules';
    this.render();
  }

  openEditForm(id: string): void {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) return;
    this.editId = id; this.form = { ...rule };
    this.formStoreIds.clear();
    if (rule.storeId) this.formStoreIds.add(rule.storeId);
    this.formProducts = ruleProducts(rule).map(p => ({ ...p }));
    this.formStoreFormulas = new Map();
    // При редактировании формулы — загружаем формулу для магазина
    if (rule.type === 'formula' && rule.storeId && rule.formula) {
      this.formStoreFormulas.set(rule.storeId, rule.formula);
    }
    this.showForm = true; this.formError = '';
    this.render();
  }

  closeForm(): void {
    this.showForm = false; this.formError = '';
    this.formStoreIds.clear(); this.formProducts = [];
    this.formStoreFormulas = new Map();
    this.render();
  }

  updateStoreFormula(storeId: string, formula: string): void {
    this.formStoreFormulas.set(storeId, formula);
  }

  toggleFormStore(storeId: string): void {
    if (this.formStoreIds.has(storeId)) this.formStoreIds.delete(storeId);
    else this.formStoreIds.add(storeId);
    // Сбросить выбранный товар если магазины изменились
    delete this.form.productId;
    delete this.form.vendorCode;
    delete this.form.productTitle;
    delete this.form.storeId;
    delete this.form.storeName;
    delete this.form.marketplace;
    this.render();
  }

  updateForm(key: string, value: any): void {
    (this.form as any)[key] = value;
    if (key === 'marketplace') {
      delete this.form.productId;
      this.form.productTitle = ''; this.form.vendorCode = '';
      this.form.storeId = ''; this.form.storeName = '';
    }
    if (key === 'productId') {
      const mp = this.form.marketplace ?? 'wb';
      if (mp === 'wb') {
        const p = this.wbProducts.find(p => String(p.nm_id) === String(value));
        if (p) {
          this.form.productTitle = p.title; this.form.vendorCode = p.vendor_code;
          this.form.storeId = p.store_id;
          this.form.storeName = this.wbStores.find(s => s.id === p.store_id)?.name ?? '';
        }
      } else if (mp === 'ozon') {
        const p = this.ozonProducts.find(p => p.offer_id === value);
        if (p) {
          this.form.productTitle = p.name; this.form.vendorCode = p.offer_id;
          this.form.storeId = p.store_id;
          this.form.storeName = this.ozonStores.find(s => s.id === p.store_id)?.name ?? '';
        }
      } else {
        const p = this.ymProducts.find(p => p.offer_id === value);
        if (p) {
          this.form.productTitle = p.name; this.form.vendorCode = p.vendor_code ?? p.offer_id;
          this.form.storeId = p.store_id;
          this.form.storeName = this.ymStores.find(s => s.id === p.store_id)?.name ?? '';
        }
      }
    }
    // Числовые поля используют onchange — полная перерисовка не нужна,
    // обновляем только расчётную цену (margin-тип) без потери фокуса
    const numKeys = new Set(['targetPrice','minPrice','maxPrice','marginMultiplier']);
    if (numKeys.has(key)) {
      const calcEl = document.getElementById('ri-calc-price');
      if (calcEl && this.form.type === 'margin') {
        const f = this.form;
        const cost = costPriceDb.get(f.vendorCode ?? '');
        calcEl.textContent = cost != null && f.marginMultiplier
          ? `${Math.round(cost * f.marginMultiplier).toLocaleString('ru')} ₽` : '—';
      }
      if (this.form.type === 'formula') this.updateFormulaPreview();
      return;
    }
    this.render();
  }

  saveForm(): void {
    const f = this.form;
    const mp = (f.marketplace ?? 'wb') as Mp;
    if (this.formProducts.length === 0 && !f.productId) { this.formError = 'Выберите товар'; this.render(); return; }
    if (!f.type) { this.formError = 'Выберите тип правила'; this.render(); return; }
    if (f.type === 'target'   && !f.targetPrice)                                  { this.formError = 'Укажите целевую цену'; this.render(); return; }
    if (f.type === 'margin') {
      if (!f.marginMultiplier) { this.formError = 'Укажите множитель'; this.render(); return; }
      // Проверяем себестоимость для всех товаров
      const missing = this.formProducts.filter(p => costPriceDb.get(p.vendorCode) == null);
      if (missing.length > 0) {
        this.formError = `⚠ Не задана себестоимость для: ${missing.map(p => p.vendorCode).join(', ')}. Перейдите во вкладку «Себестоимости».`;
        this.render(); return;
      }
    }
    if (f.type === 'stock') {
      const tiers = f.stockTiers ?? [];
      if (tiers.length === 0 || tiers.some(t => !isFinite(t.maxStock) || !isFinite(t.price))) {
        this.formError = 'Добавьте хотя бы один порог с корректными значениями'; this.render(); return;
      }
    }
    if (f.type === 'schedule') {
      const periods = f.schedulePeriods ?? [];
      if (periods.length === 0 || periods.some(p => p.days.length === 0 || !isFinite(p.price))) {
        this.formError = 'Добавьте хотя бы один период с днями и ценой'; this.render(); return;
      }
    }
    if (f.type === 'formula') {
      if (!f.formula?.trim()) { this.formError = 'Введите формулу'; this.render(); return; }
      if (/\bcost_price\b/.test(f.formula)) {
        const missing = this.formProducts.filter(p => costPriceDb.get(p.vendorCode) == null);
        if (missing.length > 0) {
          this.formError = `⚠ Формула использует cost_price, но себестоимость не задана для: ${missing.map(p => p.vendorCode).join(', ')}.`;
          this.render(); return;
        }
      }
      const cost = costPriceDb.get(f.vendorCode ?? '') ?? 0;
      const test = computeTargetPrice({ ...f, type: 'formula' } as RepricerRule, { stock: 0, cost });
      if (test == null) { this.formError = 'Формула некорректна — проверьте синтаксис'; this.render(); return; }
    }

    const now = new Date().toISOString();

    // Собираем products — список всех выбранных товаров
    const products: RuleProduct[] = this.formProducts.length > 0
      ? [...this.formProducts]
      : [{ productId: f.productId!, vendorCode: f.vendorCode ?? '', productTitle: f.productTitle ?? f.productId! }];

    const baseRule = {
      productId: products[0].productId,
      vendorCode: products[0].vendorCode,
      productTitle: products[0].productTitle,
      products: products.length > 1 ? products : undefined,
      type: f.type! as RuleType,
      status: (f.status ?? 'active') as RuleStatus,
      targetPrice: f.targetPrice, marginMultiplier: f.marginMultiplier,
      minPrice: f.minPrice, maxPrice: f.maxPrice,
      stockTiers: f.stockTiers,
      schedulePeriods: f.schedulePeriods,
      formula: f.formula,
    };

    if (this.editId) {
      // Редактирование — обновляем одно правило
      const rule: RepricerRule = {
        ...baseRule,
        id: this.editId,
        marketplace: mp,
        storeId: f.storeId ?? '',
        storeName: f.storeName ?? '',
        createdAt: this.rules.find(r => r.id === this.editId)?.createdAt ?? now,
      };
      const idx = this.rules.findIndex(r => r.id === this.editId);
      if (idx >= 0) this.rules[idx] = rule;
    } else {
      // Создание — одно правило на магазин из formStoreIds, со ВСЕМИ товарами внутри
      const allStores = catalog.allStoresFlat(this.catalogData());
      let targetStores = allStores.filter(s => this.formStoreIds.has(s.id));

      if (targetStores.length === 0) {
        targetStores.push({ id: f.storeId ?? '', name: f.storeName ?? '', mp });
      }
      for (const store of targetStores) {
        // Резолвим productId для каждого товара в этом магазине
        const resolvedProducts: RuleProduct[] = products.map(prod =>
          catalog.resolveProductForStore(this.catalogData(), store, prod),
        );

        if (f.type === 'formula') {
          // Формула: одно правило на магазин, у каждого магазина своя формула
          const storeFormula = this.formStoreFormulas.get(store.id) || f.formula || '';
          const rule: RepricerRule = {
            ...baseRule,
            id: uid(),
            marketplace: store.mp,
            storeId: store.id,
            storeName: store.name,
            productId: resolvedProducts[0].productId,
            vendorCode: resolvedProducts[0].vendorCode,
            productTitle: resolvedProducts[0].productTitle,
            products: resolvedProducts.length > 1 ? resolvedProducts : undefined,
            formula: storeFormula,
            createdAt: now,
          };
          this.rules.unshift(rule);
        } else {
          const rule: RepricerRule = {
            ...baseRule,
            id: uid(),
            marketplace: store.mp,
            storeId: store.id,
            storeName: store.name,
            productId: resolvedProducts[0].productId,
            vendorCode: resolvedProducts[0].vendorCode,
            productTitle: resolvedProducts[0].productTitle,
            products: resolvedProducts.length > 1 ? resolvedProducts : undefined,
            createdAt: now,
          };
          this.rules.unshift(rule);
        }
      }
    }

    repricerRulesDb.saveMany(this.rules);
    this.showForm = false; this.formError = '';
    this.formStoreIds.clear();
    this.formProducts = [];
    this.render();
  }

  deleteRule(id: string): void {
    this.rules = this.rules.filter(r => r.id !== id);
    repricerRulesDb.remove(id); this.render();
  }

  toggleStatus(id: string): void {
    const r = this.rules.find(r => r.id === id);
    if (r) { r.status = r.status === 'active' ? 'paused' : 'active'; repricerRulesDb.save(r); }
    this.render();
  }

  // ── Stock tiers management ────────────────────────────────────
  updateStockTier(idx: number, key: 'maxStock' | 'price', value: number): void {
    if (!this.form.stockTiers) this.form.stockTiers = [];
    this.form.stockTiers[idx] = { ...this.form.stockTiers[idx], [key]: value };
  }
  addStockTier(): void {
    if (!this.form.stockTiers) this.form.stockTiers = [];
    const last = this.form.stockTiers[this.form.stockTiers.length - 1];
    this.form.stockTiers.push({ maxStock: (last?.maxStock ?? 10) * 2, price: last?.price ?? 0 });
    this.render();
  }
  removeStockTier(idx: number): void {
    if (this.form.stockTiers) this.form.stockTiers.splice(idx, 1);
    this.render();
  }

  // ── Schedule periods management ────────────────────────────────
  updateSchedulePeriod(idx: number, key: 'fromTime' | 'toTime' | 'price', value: string | number): void {
    if (!this.form.schedulePeriods) this.form.schedulePeriods = [];
    (this.form.schedulePeriods[idx] as any)[key] = value;
  }
  toggleScheduleDay(periodIdx: number, day: number): void {
    if (!this.form.schedulePeriods) return;
    const p = this.form.schedulePeriods[periodIdx];
    if (!p) return;
    const i = p.days.indexOf(day);
    if (i >= 0) p.days.splice(i, 1);
    else p.days.push(day);
    p.days.sort();
    this.render();
  }
  addSchedulePeriod(): void {
    if (!this.form.schedulePeriods) this.form.schedulePeriods = [];
    this.form.schedulePeriods.push({ days: [1,2,3,4,5], fromTime: '09:00', toTime: '18:00', price: 0 } as SchedulePeriod);
    this.render();
  }
  removeSchedulePeriod(idx: number): void {
    if (this.form.schedulePeriods) this.form.schedulePeriods.splice(idx, 1);
    this.render();
  }

  // Быстрая вставка в textarea формулы
  insertFormulaToken(token: string): void {
    const ta = document.getElementById('ri-formula') as HTMLTextAreaElement | null;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const newVal = ta.value.slice(0, start) + token + ta.value.slice(end);
    ta.value = newVal;
    this.form.formula = newVal;
    ta.focus();
    const pos = start + token.length;
    ta.setSelectionRange(pos, pos);
    this.updateFormulaPreview();
  }

  updateFormula(value: string): void {
    this.form.formula = value;
    this.updateFormulaPreview();
  }

  private updateFormulaPreview(): void {
    const el = document.getElementById('ri-formula-preview');
    if (!el) return;
    const f = this.form;
    const cost = costPriceDb.get(f.vendorCode ?? '') ?? 0;
    const result = computeTargetPrice({ ...f, type: 'formula' } as RepricerRule, { stock: 0, cost });
    if (result == null) {
      el.innerHTML = '<span style="color:var(--text2)">— (укажите корректную формулу)</span>';
    } else {
      el.innerHTML = `<span style="color:#16a34a;font-weight:700">${Math.round(result).toLocaleString('ru')} ₽</span>
        <span style="color:var(--text2);font-size:11px;margin-left:6px">при cost_price=${cost}, margin=${f.marginMultiplier ?? 1}</span>`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ПРИМЕНЕНИЕ ПРАВИЛ
  // ════════════════════════════════════════════════════════════════════════

  async applyRule(id: string): Promise<void> {
    const rule = this.rules.find(r => r.id === id);
    if (!rule || this.applying.has(id)) return;
    this.applying.add(id); this.render();

    const products = ruleProducts(rule);

    try {
      for (const prod of products) {
        // Вычисляем цену для каждого товара (себестоимость может отличаться)
        const newPrice = this.computePriceForProduct(rule, prod);
        if (!newPrice) continue;

        if (rule.marketplace === 'wb') {
          const store = this.wbStores.find(s => s.id === rule.storeId);
          if (!store) throw new Error('Магазин WB не найден');
          const wbProd = this.wbProducts.find(p => String(p.nm_id) === prod.productId && p.store_id === rule.storeId);
          const wbPrice = newPrice;
          await updateWbPrices(store.api_key, [{ nmID: Number(prod.productId), price: wbPrice, discount: 0 }]);
          // Обновляем in-memory кеш
          if (wbProd) wbProd.price = wbPrice;
        } else if (rule.marketplace === 'ozon') {
          const store = this.ozonStores.find(s => s.id === rule.storeId);
          if (!store) throw new Error('Магазин Ozon не найден');
          const creds = { client_id: store.client_id, api_key: store.api_key };
          const p = this.ozonProducts.find(p => p.offer_id === prod.productId);
          let ozonPrice = newPrice;
          let ozonRefOldPrice: number | null = null;

          // Для обычных правил оставляем old_price для визуального "до скидки"
          if (p?.old_price && p.old_price > ozonPrice) ozonRefOldPrice = p.old_price;
          else if (p?.price && p.price > ozonPrice) ozonRefOldPrice = p.price;

          const rawMinP = rule.minPrice ?? Math.round(ozonPrice * 0.8);
          const minP = rawMinP >= ozonPrice ? Math.max(1, ozonPrice - 1) : rawMinP;
          const safeOldPrice = (ozonRefOldPrice ?? 0) > ozonPrice ? ozonRefOldPrice! : 0;
          await ozonApi.updatePrices(
            creds,
            [{
              offer_id: prod.productId,
              price: String(ozonPrice),
              ...(safeOldPrice > 0 ? { old_price: String(safeOldPrice) } : {}),
              min_price: String(minP),
              auto_action_enabled: 'ENABLED',
            }],
          );
          if (p) p.price = ozonPrice;
        } else {
          const store = this.ymStores.find(s => s.id === rule.storeId);
          if (!store?.campaign_id) throw new Error('Магазин ЯМ или campaign_id не найден');
          const ymProd = this.ymProducts.find(p => p.offer_id === prod.productId && p.store_id === store.id);

          let ymSellerPrice: number;

          {
            // Пробуем скорректировать на коэффициент скидки ЯМ
            let ymCatalogPrice = ymProd?.basic_price ?? 0;
            let ymSetPrice     = ymCatalogPrice; // цена которую мы ставили раньше
            try {
              const priceMap = await yandexApi.getOfferPrices(store.api_key, String(store.campaign_id));
              const d = priceMap.get(prod.productId);
              if (d?.price && d.price > 0)       ymSetPrice     = d.price;
              if (d?.discountBase && d.discountBase > 0) ymCatalogPrice = d.discountBase;
            } catch { /* fallback на basic_price */ }
            ymSellerPrice = newPrice;
            if (ymCatalogPrice > 0 && ymSetPrice > 0 && ymCatalogPrice > ymSetPrice) {
              ymSellerPrice = Math.ceil(newPrice * ymCatalogPrice / ymSetPrice);
            }
          }

          await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id), [{
            offerId: prod.productId,
            price: ymSellerPrice,
            oldPrice: ymProd?.basic_price || undefined,
          }]);
          if (ymProd) ymProd.basic_price = ymSellerPrice;
        }

        const oldPrice =
          rule.marketplace === 'wb'    ? (this.wbProducts.find(p => String(p.nm_id) === prod.productId)?.price ?? null) :
          rule.marketplace === 'ozon'  ? (this.ozonProducts.find(p => p.offer_id === prod.productId)?.price ?? null) :
                                         (this.ymProducts.find(p => p.offer_id === prod.productId)?.basic_price ?? null);

        const entry: PriceLog = {
          id: uid(), ruleId: id, marketplace: rule.marketplace,
          storeName: rule.storeName, productTitle: prod.productTitle,
          oldPrice, newPrice, appliedAt: new Date().toISOString(), reason: rule.type,
        };
        this.log.unshift(entry); saveLog(this.log);
      }
      rule.lastAppliedAt = new Date().toISOString();
      repricerRulesDb.save(rule);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      console.error('[Repricer] applyRule:', msg);
      this.applyErrors.set(id,
        msg.includes('429') ? 'WB: слишком много запросов — подождите несколько минут и повторите' :
        msg.includes('LOCKED') ? 'ЯМ: в настройках магазина отключено изменение цен через API (LOCKED)' :
        msg
      );
      setTimeout(() => { this.applyErrors.delete(id); this.render(); }, 8000);
    }
    this.applying.delete(id); this.render();
  }

  async applyAll(): Promise<void> {
    const active = this.rules.filter(r => r.status === 'active' && !this.applying.has(r.id));
    for (const r of active) await this.applyRule(r.id);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════════════════

  render(): void {
    const activeCount = this.rules.filter(r => r.status === 'active').length;
    const costsCount  = costPriceDb.all().length;
    const products    = this.buildUnifiedProducts();
    const withoutCost = products.filter(p => costPriceDb.get(p.vendorCode) == null).length;

    // ── ЭКРАН СОЗДАНИЯ / РЕДАКТИРОВАНИЯ ПРАВИЛА ──
    if (this.showForm) {
      this.container.innerHTML = `
        <div class="rpr">
          <div class="rpr-header">
            <div class="rpr-header-left">
              <button onclick="window.repricerModule.closeForm()"
                style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px 5px 7px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                Назад
              </button>
              <span class="rpr-logo-text" style="margin-left:4px">${this.editId ? 'Редактировать правило' : 'Новое правило'}</span>
            </div>
            <div class="rpr-header-actions">
              ${helpBtn('repricer')}
            </div>
          </div>
          <div class="rpr-body">
            ${this.renderForm()}
          </div>
        </div>
      `;
      return;
    }

    // ── ОСНОВНОЙ ЭКРАН (СПИСОК ПРАВИЛ / ИСТОРИЯ / ...) ──
    const TAB_CFG = [
      { id: 'rules',     label: 'Правила',       count: this.rules.length, violet: false },
      { id: 'costs',     label: 'Себестоимости', count: costsCount, violet: false, warn: withoutCost > 0 },
      { id: 'log',       label: 'История',       count: this.log.length, violet: false },
    ] as const;

    this.container.innerHTML = `
      <div class="rpr">

        <!-- HEADER -->
        <div class="rpr-header">
          <div class="rpr-header-left">
            <div class="rpr-logo-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
            </div>
            <span class="rpr-logo-text">Репрайсер</span>
            ${activeCount > 0 ? `<span class="rpr-badge">${activeCount} активных</span>` : ''}
            ${withoutCost > 0 ? `<span style="padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;background:rgba(251,191,36,.12);color:#f59e0b;letter-spacing:.2px">⚠ ${withoutCost} без cost</span>` : ''}
          </div>
          <div class="rpr-header-actions">
            ${helpBtn('repricer')}
            ${activeCount > 0 ? `
              <button class="rpr-btn rpr-btn-outline" onclick="window.repricerModule.applyAll()" ${this.applying.size > 0 ? 'disabled' : ''}>
                ${this.applying.size > 0
                  ? `<span style="display:inline-flex;align-items:center;gap:5px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="animation:spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>Применяем…</span>`
                  : `▶ Применить все`}
              </button>
            ` : ''}
            ${this.tab === 'rules' ? `
              <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.openAddForm()">
                + Правило
              </button>` : ''}
          </div>
        </div>

        <!-- TABS -->
        <div class="rpr-tabs">
          ${TAB_CFG.map(t => {
            const isActive = this.tab === t.id;
            const amberClass = 'amber' in t && t.amber ? ' amber' : '';
            return `<button class="rpr-tab${isActive ? ' active' : ''}${t.violet ? ' violet' : ''}${amberClass}"
              onclick="window.repricerModule.setTab('${t.id}')">
              ${t.label}
              ${t.count != null ? `<span class="rpr-tab-badge">${t.count}</span>` : ''}
              ${'warn' in t && t.warn && !isActive ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-left:3px;vertical-align:middle"></span>` : ''}
            </button>`;
          }).join('')}
        </div>

        <div class="rpr-body">
          ${this.tab === 'rules' ? this.renderRules()
          : this.tab === 'costs' ? this.renderCosts()
          : this.renderLog()}
        </div>
      </div>
    `;
  }

  private renderForm(): string {
    const props: RuleFormProps = {
      form: this.form,
      formProducts: this.formProducts,
      formStoreIds: this.formStoreIds,
      formStoreFormulas: this.formStoreFormulas,
      editId: this.editId,
      formError: this.formError,
      allStores: catalog.allStoresFlat(this.catalogData()),
      getCost: (vendorCode: string) => costPriceDb.get(vendorCode),
      pickerOverlay: this.pickerOpen ? renderPickerOverlay(renderPicker(this.pickerProps())) : '',
    };
    return renderRuleForm(props);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «ПРАВИЛА»
  // ════════════════════════════════════════════════════════════════════════

  private rulesTabProps(): RulesTabProps {
    return {
      rules: this.rules,
      rulesSearch: this.rulesSearch,
      rulesTypeFilter: this.rulesTypeFilter,
      computePrice: (r) => this.computePrice(r),
      getCurrentPrice: (r) => catalog.getCurrentPrice(this.catalogData(), r),
      getProductImage: (r) => catalog.getProductImage(this.catalogData(), r),
      applying: this.applying,
      applyErrors: this.applyErrors,
    };
  }

  private renderRules(): string {
    return renderRulesTab(this.rulesTabProps());
  }

  setRulesSearch(q: string): void {
    this.rulesSearch = q;
    const host = document.getElementById('rpr-rules-host');
    if (host) host.innerHTML = renderRulesInnerTab(this.rulesTabProps());
  }

  setRulesTypeFilter(t: string): void {
    this.rulesTypeFilter = t as any;
    this.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «ИСТОРИЯ»
  // ════════════════════════════════════════════════════════════════════════

  private renderLog(): string {
    return renderLogTab(this.log);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «СЕБЕСТОИМОСТИ» — управление cost_price для всех товаров
  // ════════════════════════════════════════════════════════════════════════

  private renderCosts(): string {
    const props: CostsTabProps = {
      products: this.buildUnifiedProducts(),
      costsSearch: this.costsSearch,
      costsMpFilter: this.costsMpFilter,
      costsSelected: this.costsSelected,
      costsBulkValue: this.costsBulkValue,
      soldVendorCodes: this.soldVendorCodes ?? null,
      getCost: (vendorCode: string) => costPriceDb.get(vendorCode),
      allCostEntries: costPriceDb.all(),
    };
    return renderCostsTab(props);
  }

  setCostsSearch(q: string): void { this.costsSearch = q; this.render(); }
  setCostsMp(mp: string): void { this.costsMpFilter = mp as any; this.render(); }
  toggleCostsRow(vendorCode: string): void {
    const k = vendorCode.toLowerCase();
    if (this.costsSelected.has(k)) this.costsSelected.delete(k);
    else this.costsSelected.add(k);
    this.render();
  }
  toggleCostsAll(): void {
    const products = this.buildUnifiedProducts();
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const orphans = costPriceDb.all().filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()));
    const q = this.costsSearch.toLowerCase().trim();
    const filtered = [
      ...products.filter(p => {
        if (this.costsMpFilter && !p.variants.some(v => v.mp === this.costsMpFilter)) return false;
        if (q && !`${p.vendorCode} ${p.title}`.toLowerCase().includes(q)) return false;
        return true;
      }),
      ...(this.costsMpFilter ? [] : orphans.filter(e => !q || e.vendorCode.toLowerCase().includes(q))),
    ];
    const allSelected = filtered.every(r => this.costsSelected.has(r.vendorCode.toLowerCase()));
    if (allSelected) filtered.forEach(r => this.costsSelected.delete(r.vendorCode.toLowerCase()));
    else filtered.forEach(r => this.costsSelected.add(r.vendorCode.toLowerCase()));
    this.render();
  }

  /** Подгружает Set всех vendor_code/sku когда-либо встреченных в mp_transactions
   *  для определения статуса orphan-артикулов: архив vs удалён. */
  private async loadSoldVendorCodes(): Promise<void> {
    if (this.soldVendorCodes || this.soldVendorCodesLoading) return;
    this.soldVendorCodesLoading = true;
    try {
      const { supaFetch } = await import('@/services/supabaseClient');
      const { companyService } = await import('@/services/companyService');
      const cid = companyService.getActiveId();
      if (!cid) { this.soldVendorCodes = new Set(); this.soldVendorCodesLoading = false; return; }

      const allStoreIds = [
        ...this.wbStores.map(s => s.id),
        ...this.ozonStores.map(s => s.id),
        ...this.ymStores.map(s => s.id),
      ];
      if (allStoreIds.length === 0) { this.soldVendorCodes = new Set(); this.soldVendorCodesLoading = false; return; }

      const ids = allStoreIds.map(id => `"${id}"`).join(',');
      // Берём только items_json — экономим трафик. До 50k записей.
      const rows = await supaFetch<Array<{ items_json: Array<{ sku?: any; vendor_code?: any }> | null }>>(
        `mp_transactions?store_id=in.(${ids})&select=items_json&items_json=not.is.null&limit=50000`,
      );

      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.items_json) continue;
        for (const it of row.items_json) {
          const sku = String(it.sku ?? it.vendor_code ?? '').trim().toLowerCase();
          if (sku) seen.add(sku);
        }
      }
      this.soldVendorCodes = seen;
      console.info(`[Repricer] sold vendor_codes loaded: ${seen.size} unique`);
    } catch (e: any) {
      console.warn('[Repricer] loadSoldVendorCodes failed:', e?.message ?? e);
      this.soldVendorCodes = new Set(); // не показываем ошибку — fallback на "архив"
    }
    this.soldVendorCodesLoading = false;
    if (this.tab === 'costs') this.render();
  }

  /** Удалить все cost_price-записи, которые помечены как "удалён"
   *  (нет в каталоге И никогда не встречались в продажах). */
  deleteAllDeletedCosts(): void {
    if (!this.soldVendorCodes) return;
    const sold = this.soldVendorCodes;
    const products = this.buildUnifiedProducts();
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const toDelete = costPriceDb.all().filter(e => {
      const k = e.vendorCode.trim().toLowerCase();
      return !catalogKeys.has(k) && !sold.has(k);
    });
    if (toDelete.length === 0) return;
    if (!confirm(`Удалить ${toDelete.length} записей себестоимости для артикулов, которые нигде не встречаются?`)) return;
    for (const e of toDelete) costPriceDb.remove(e.vendorCode);
    this.render();
    try { window.app?.toast?.(`${I.trash()} Удалено ${toDelete.length} записей`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Сохранить себестоимость одного товара */
  setCost(vendorCode: string, cost: number): void {
    if (!isFinite(cost) || cost < 0) { costPriceDb.remove(vendorCode); }
    else { costPriceDb.set(vendorCode, cost); }
    this.render();
  }

  /** Добавить себестоимость вручную (для артикулов не в каталоге) */
  addCostManual(): void {
    const vcInput = document.getElementById('rp-manual-vc') as HTMLInputElement | null;
    const costInput = document.getElementById('rp-manual-cost') as HTMLInputElement | null;
    const vc = vcInput?.value?.trim() ?? '';
    const cost = parseFloat(costInput?.value ?? '');
    if (!vc) {
      if (vcInput) { vcInput.style.border = '1.5px solid #ef4444'; setTimeout(() => { if (vcInput) vcInput.style.border = ''; }, 1500); }
      return;
    }
    if (!isFinite(cost) || cost < 0) {
      if (costInput) { costInput.style.border = '1.5px solid #ef4444'; setTimeout(() => { if (costInput) costInput.style.border = ''; }, 1500); }
      return;
    }
    costPriceDb.set(vc, cost);
    if (vcInput) vcInput.value = '';
    if (costInput) costInput.value = '';
    this.render();
    try { window.app?.toast?.(`✓ Себестоимость ${cost.toLocaleString('ru')} ₽ сохранена для «${vc}»`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Применить массовое значение ко всем выбранным */
  applyCostsBulk(): void {
    const inp = document.getElementById('rp-bulk-cost') as HTMLInputElement | null;
    const val = parseFloat(inp?.value ?? '');
    if (!isFinite(val) || val < 0) { alert('Введите корректное значение'); return; }
    const codes = [...this.costsSelected];
    const products = this.buildUnifiedProducts();
    // Каталожные артикулы
    const catalogCodes = products.filter(p => codes.includes(p.vendorCode.toLowerCase())).map(p => p.vendorCode);
    // Orphan-артикулы (вне каталога) — используем vendorCode как есть из costPriceDb
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const orphanCodes = costPriceDb.all()
      .filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()) && codes.includes(e.vendorCode.toLowerCase()))
      .map(e => e.vendorCode);
    const realCodes = [...catalogCodes, ...orphanCodes];
    const saved = costPriceDb.setMany(realCodes, val);
    this.costsBulkValue = val;
    this.render();
    try { window.app?.toast?.(`✓ Установлено ${val.toLocaleString('ru')} ₽ для ${saved} товара(ов)`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Скачать xlsx с артикулами и пустым полем cost */
  exportCostsTemplate(): void {
    const products = this.buildUnifiedProducts();
    const rows: any[][] = [
      ['Артикул', 'Название', 'Себестоимость, ₽'],
    ];
    for (const p of products) {
      const cost = costPriceDb.get(p.vendorCode);
      rows.push([p.vendorCode, p.title, cost ?? '']);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 50 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Себестоимость');
    const fname = `cost_prices_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    try { window.app?.toast?.(`${I.download()} Скачан шаблон с ${products.length} товарами`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Импорт xlsx-файла с себестоимостью */
  importCostsFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const buf = e.target!.result as ArrayBuffer;
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null });
        if (rows.length < 2) { alert('Файл пуст или не содержит данных.'); return; }
        // Найти колонки: артикул и cost
        const headers = (rows[0] as any[]).map(h => String(h ?? '').toLowerCase().trim());
        const artCol = headers.findIndex(h => h.includes('артикул') || h === 'sku' || h.includes('vendor'));
        const costCol = headers.findIndex(h => h.includes('себестоим') || h === 'cost' || h.includes('cost_price'));
        if (artCol === -1 || costCol === -1) {
          alert('Не найдены колонки «Артикул» и «Себестоимость». Скачайте шаблон.');
          return;
        }
        const items: Array<{ vendorCode: string; cost: number }> = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i] as any[];
          if (!r) continue;
          const vc = String(r[artCol] ?? '').trim();
          const cost = parseFloat(String(r[costCol] ?? '').replace(',', '.'));
          if (!vc || !isFinite(cost) || cost < 0) continue;
          items.push({ vendorCode: vc, cost });
        }
        const { saved, skipped } = costPriceDb.bulkSet(items);
        try { window.app?.toast?.(`✓ Импортировано: ${saved}. Пропущено: ${skipped}.`, 'success', 4000); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
        this.render();
      } catch (err: any) {
        alert('Ошибка чтения файла: ' + (err?.message ?? err));
      }
      input.value = '';
    };
    reader.readAsArrayBuffer(file);
  }
}
