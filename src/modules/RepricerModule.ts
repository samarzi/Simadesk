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
import { costProducerLinks } from '@/services/costProducerLinks';
import { producerMappingDb, producerProductDb, producerFieldDb } from '@/services/producerDb';
import { repricerRulesDb } from '@/services/repricerRulesDb';
import { WbProduct, WbStore } from '@/types/wb';
import { OzonProduct, OzonStore } from '@/types/ozon';
import { YandexProduct, YandexStore } from '@/types/yandex';
import * as XLSX from 'xlsx';
import '@/styles/repricer.css';

import { LOG_KEY, RULE_LABELS } from './repricer/types';
import type { Mp, MrcItem, MrcScanEntry, PriceLog, RepricerRule, RuleProduct, RuleStatus, RuleType, SchedulePeriod, UnifiedProduct } from './repricer/types';
import { ruleProducts, uid, buildMrcItems, productPageUrl } from './repricer/utils';
import { computeTargetPrice } from './repricer/pricing';
import * as catalog from './repricer/catalog';
import type { CatalogData } from './repricer/catalog';
import { renderRules as renderRulesTab, renderRulesInner as renderRulesInnerTab } from './repricer/tabs/RulesTab';
import type { RulesTabProps } from './repricer/tabs/RulesTab';
import { renderLog as renderLogTab } from './repricer/tabs/LogTab';
import { renderCosts as renderCostsTab, renderCostsInner as renderCostsInnerTab } from './repricer/tabs/CostsTab';
import type { CostsTabProps } from './repricer/tabs/CostsTab';
import { renderMrc as renderMrcTab } from './repricer/tabs/MrcTab';
import type { MrcTabProps } from './repricer/tabs/MrcTab';
import { renderForm as renderRuleForm } from './repricer/components/RuleForm';
import type { RuleFormProps } from './repricer/components/RuleForm';
import { renderPicker, renderPickerOverlay } from './repricer/components/ProductPicker';
import type { ProductPickerProps } from './repricer/components/ProductPicker';
import { MrcScanner } from './repricer/services/mrcScanner';

export type { RepricerRule };

const RULE_TYPES = Object.keys(RULE_LABELS) as RuleType[];

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

  // ── МРЦ ────────────────────────────────────────────────────────────
  private mrcScanner: MrcScanner;
  private mrcApplyingKeys = new Set<string>();

  // ── Cost-prices manager ───────────────────────────────────────────
  private costsSearch = '';
  private costsMpFilter: '' | Mp = '';
  private costsSelected = new Set<string>();      // vendorCode (нормализован)
  private costsBulkValue: number | '' = '';
  private costsSearchTimer: number | null = null;
  /** Lowercased vendor_code/sku из исторических транзакций МП.
   *  Используется чтобы помечать orphan-артикулы как "архив" (был в продажах)
   *  vs "удалён" (нигде не встречался). Грузится один раз при открытии таба. */
  private soldVendorCodes: Set<string> | null = null;
  private soldVendorCodesLoading = false;
  /** Карта: article_lower → { cost, producerProductId, producerName }
   *  Артикулы, у которых ЕСТЬ связка с производителем И в карточке указана себестоимость.
   *  Загружается при открытии вкладки «Себестоимости». */
  private producerCostMap = new Map<string, { cost: number; producerProductId: string; producerName: string }>();
  private producerCostMapLoaded = false;
  private editId: string | null = null;
  private showForm = false;
  private form: Partial<RepricerRule> = {};
  private formError = '';
  // Выбранные магазины в форме (до выбора товара)
  private formStoreIds = new Set<string>();
  // Список выбранных товаров для правила (мульти-выбор)
  private formProducts: RuleProduct[] = [];
  private applying = new Set<string>();
  private applyingAll = false;
  private applyErrors = new Map<string, string>(); // ruleId → error message
  private reverting = new Set<string>(); // logId → откат в процессе
  private revertErrors = new Map<string, string>(); // logId → error message

  // ── Per-store formulas (для типа formula: каждый магазин = своя формула) ──
  private formStoreFormulas: Map<string, string> = new Map(); // storeId → formula

  // ── Rules list filter / search ──────────────────────────────────────────────
  private rulesSearch = '';
  private rulesTypeFilter: RuleType = 'target';

  // ── Product picker (выбор товаров из всех МП с дедупликацией по артикулу) ──
  private pickerOpen = false;
  private pickerSearchTimer: number | null = null;
  private pickerSelected = new Set<string>();      // ключи UnifiedProduct.vendorCode
  private pickerSearch = '';
  private pickerSelectedMps  = new Set<Mp>();      // выбранные маркетплейсы (кнопки)
  private pickerSelectedStores = new Set<string>(); // выбранные магазины (кнопки)
  private pickerStockFilter: 'all' | 'in' | 'out' = 'all';

  constructor(container: HTMLElement) {
    this.container = container;
    this.mrcScanner = new MrcScanner({
      getRules: () => this.rules,
      getWbStores: () => this.wbStores,
      getWbProducts: () => this.wbProducts,
      getOzonStores: () => this.ozonStores,
      getOzonProducts: () => this.ozonProducts,
      getYmStores: () => this.ymStores,
      getYmProducts: () => this.ymProducts,
      onChange: () => this.render(),
    });
  }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    await repricerRulesDb.refresh();
    this.rules = repricerRulesDb.all();
    this.log   = loadLog();
    const firstWithRules = RULE_TYPES.find(rt => this.rules.some(r => r.type === rt));
    this.rulesTypeFilter = firstWithRules ?? 'target';

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
      this.loadProducerCostMap();
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
    const stock = catalog.getStock(this.catalogData(), rule.marketplace, rule.productId, rule.storeId);
    const cost = costPriceDb.get(rule.vendorCode);
    return computeTargetPrice(rule, { stock, cost });
  }

  /** Целевая цена для конкретного товара правила (себестоимость и остаток — свои). */
  private computePriceForProduct(rule: RepricerRule, prod: RuleProduct): number | null {
    const stock = catalog.getStock(this.catalogData(), rule.marketplace, prod.productId, rule.storeId);
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

  setPickerSearch(q: string): void {
    this.pickerSearch = q;
    if (this.pickerSearchTimer != null) clearTimeout(this.pickerSearchTimer);
    this.pickerSearchTimer = window.setTimeout(() => this.renderPickerOnly(), 200);
  }
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

  openAddForm(type?: RuleType): void {
    this.editId = null;
    this.form = { type: type ?? 'target', status: 'active' };
    this.formStoreIds.clear();
    this.formProducts = [];
    this.formStoreFormulas = new Map();
    this.showForm = true; this.formError = '';
    this.tab = 'rules';
    if (type) this.rulesTypeFilter = type;
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
    this.rulesTypeFilter = rule.type;
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

  /** Проверка формы под выбранный тип правила. Возвращает текст ошибки или null если всё ок. */
  private validateFormForType(): string | null {
    const f = this.form;
    if (this.formProducts.length === 0 && !f.productId) return 'Выберите товар';
    if (!f.type) return 'Выберите тип правила';

    switch (f.type) {
      case 'target':
        return !f.targetPrice ? 'Укажите целевую цену' : null;

      case 'margin': {
        if (!f.marginMultiplier) return 'Укажите множитель';
        const missing = this.formProducts.filter(p => costPriceDb.get(p.vendorCode) == null);
        if (missing.length > 0) {
          return `⚠ Не задана себестоимость для: ${missing.map(p => p.vendorCode).join(', ')}. Перейдите во вкладку «Себестоимости».`;
        }
        return null;
      }

      case 'stock': {
        const tiers = f.stockTiers ?? [];
        if (tiers.length === 0 || tiers.some(t => !isFinite(t.maxStock) || !isFinite(t.price))) {
          return 'Добавьте хотя бы один порог с корректными значениями';
        }
        return null;
      }

      case 'schedule': {
        const periods = f.schedulePeriods ?? [];
        if (periods.length === 0 || periods.some(p => p.days.length === 0 || !isFinite(p.price))) {
          return 'Добавьте хотя бы один период с днями и ценой';
        }
        return null;
      }

      case 'mrc': {
        const mrcProducts = this.formProducts.length > 0
          ? this.formProducts
          : (f.productId && f.vendorCode ? [{ productId: f.productId, vendorCode: f.vendorCode, productTitle: f.productTitle ?? f.productId }] : []);
        if (mrcProducts.length === 0) return 'Выберите товар';
        const missing = mrcProducts.filter(prod => !((f as any)[`mrcPrice__${prod.vendorCode}`] > 0));
        if (missing.length > 0) return `Укажите цену МРЦ для: ${missing.map(p => p.vendorCode).join(', ')}`;
        return null;
      }

      case 'formula': {
        if (!f.formula?.trim()) return 'Введите формулу';
        if (/\bcost_price\b/.test(f.formula)) {
          const missing = this.formProducts.filter(p => costPriceDb.get(p.vendorCode) == null);
          if (missing.length > 0) {
            return `⚠ Формула использует cost_price, но себестоимость не задана для: ${missing.map(p => p.vendorCode).join(', ')}.`;
          }
        }
        const cost = costPriceDb.get(f.vendorCode ?? '') ?? 0;
        const test = computeTargetPrice({ ...f, type: 'formula' } as RepricerRule, { stock: 0, cost });
        return test == null ? 'Формула некорректна — проверьте синтаксис' : null;
      }

      default:
        return null;
    }
  }

  /** Сохраняет правило типа «МРЦ» — отдельная ветка, т.к. одно правило хранит
   *  mrcItems на все выбранные товары × магазины (ячейка = товар на конкретном МП). */
  private saveMrcRule(products: RuleProduct[]): void {
    const f = this.form;
    const now = new Date().toISOString();
    const unified = this.buildUnifiedProducts();
    const mrcPriceFor = (vc: string) => Number((f as any)[`mrcPrice__${vc}`]) || 0;

    if (this.editId) {
      const existing = this.rules.find(r => r.id === this.editId);
      const mrcItems = buildMrcItems(unified, products, mrcPriceFor, existing?.mrcItems ?? []);
      const first = mrcItems[0];
      const rule: RepricerRule = {
        id: this.editId,
        marketplace: existing?.marketplace ?? first?.mp ?? (f.marketplace as Mp) ?? 'wb',
        storeId: existing?.storeId ?? first?.storeId ?? '',
        storeName: existing?.storeName ?? first?.storeName ?? '',
        productId: existing?.productId ?? first?.productId ?? products[0].productId,
        vendorCode: existing?.vendorCode ?? first?.vendorCode ?? products[0].vendorCode,
        productTitle: existing?.productTitle ?? first?.productTitle ?? products[0].productTitle,
        type: 'mrc',
        status: (f.status ?? 'active') as RuleStatus,
        mrcItems,
        createdAt: existing?.createdAt ?? now,
      };
      const idx = this.rules.findIndex(r => r.id === this.editId);
      if (idx >= 0) this.rules[idx] = rule;
    } else {
      const mrcItems = buildMrcItems(unified, products, mrcPriceFor);
      const first = mrcItems[0];
      const rule: RepricerRule = {
        id: uid(),
        marketplace: first?.mp ?? (f.marketplace as Mp) ?? 'wb',
        storeId: first?.storeId ?? '',
        storeName: first?.storeName ?? '',
        productId: first?.productId ?? products[0].productId,
        vendorCode: first?.vendorCode ?? products[0].vendorCode,
        productTitle: first?.productTitle ?? products[0].productTitle,
        type: 'mrc',
        status: (f.status ?? 'active') as RuleStatus,
        mrcItems,
        createdAt: now,
      };
      this.rules.unshift(rule);
    }

    repricerRulesDb.saveMany(this.rules);
  }

  /** Сохраняет правило обычного типа (target/margin/stock/schedule/formula) при редактировании. */
  private saveEditedRule(baseRule: Omit<RepricerRule, 'id' | 'marketplace' | 'storeId' | 'storeName' | 'createdAt'>, mp: Mp, now: string): void {
    const f = this.form;
    const rule: RepricerRule = {
      ...baseRule,
      id: this.editId!,
      marketplace: mp,
      storeId: f.storeId ?? '',
      storeName: f.storeName ?? '',
      createdAt: this.rules.find(r => r.id === this.editId)?.createdAt ?? now,
    };
    const idx = this.rules.findIndex(r => r.id === this.editId);
    if (idx >= 0) this.rules[idx] = rule;
  }

  /** Создаёт новые правила: одно правило на каждый выбранный магазин из formStoreIds. */
  private createNewRules(baseRule: Omit<RepricerRule, 'id' | 'marketplace' | 'storeId' | 'storeName' | 'createdAt'>, products: RuleProduct[], mp: Mp, now: string): void {
    const f = this.form;
    const allStores = catalog.allStoresFlat(this.catalogData());
    let targetStores = allStores.filter(s => this.formStoreIds.has(s.id));

    if (targetStores.length === 0) {
      targetStores.push({ id: f.storeId ?? '', name: f.storeName ?? '', mp });
    }
    for (const store of targetStores) {
      const resolvedProducts: RuleProduct[] = products.map(prod =>
        catalog.resolveProductForStore(this.catalogData(), store, prod),
      );

      const storeFormula = f.type === 'formula'
        ? (this.formStoreFormulas.get(store.id) || f.formula || '')
        : undefined;

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
        ...(storeFormula !== undefined ? { formula: storeFormula } : {}),
        createdAt: now,
      };
      this.rules.unshift(rule);
    }
  }

  saveForm(): void {
    const f = this.form;
    const mp = (f.marketplace ?? 'wb') as Mp;

    const error = this.validateFormForType();
    if (error) { this.formError = error; this.render(); return; }

    const now = new Date().toISOString();

    // Собираем products — список всех выбранных товаров
    const products: RuleProduct[] = this.formProducts.length > 0
      ? [...this.formProducts]
      : [{ productId: f.productId!, vendorCode: f.vendorCode ?? '', productTitle: f.productTitle ?? f.productId! }];

    // ── Тип «МРЦ» — особая логика: одно правило хранит mrcItems на все
    // выбранные товары × магазины (одна ячейка = товар на конкретном МП).
    if (f.type === 'mrc') {
      this.saveMrcRule(products);
      this.showForm = false; this.formError = '';
      this.formStoreIds.clear();
      this.formProducts = [];
      this.render();
      return;
    }

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
      this.saveEditedRule(baseRule, mp, now);
    } else {
      this.createNewRules(baseRule, products, mp, now);
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
        // newPrice может быть отрицательным (например, из формулы с вычитанием) —
        // `!newPrice` такое не отсекает, т.к. отрицательные числа truthy в JS.
        if (newPrice == null || !isFinite(newPrice) || newPrice <= 0) continue;

        // Цена ДО изменения — читаем сейчас, до мутации in-memory кеша ниже.
        const oldPrice =
          rule.marketplace === 'wb'    ? (this.wbProducts.find(p => String(p.nm_id) === prod.productId && p.store_id === rule.storeId)?.price ?? null) :
          rule.marketplace === 'ozon'  ? (this.ozonProducts.find(p => p.offer_id === prod.productId)?.price ?? null) :
                                         (this.ymProducts.find(p => p.offer_id === prod.productId)?.basic_price ?? null);

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

          // Для визуального "до скидки" используем old_price или текущую цену,
          // если они выше новой. Иначе явно шлём "0" — Ozon сбросит зачёркнутую цену
          // и не выдаст VALIDATION_ERROR из-за устаревшего old_price в своей базе.
          if (p?.old_price && p.old_price > ozonPrice) ozonRefOldPrice = p.old_price;
          else if (p?.price && p.price > ozonPrice) ozonRefOldPrice = p.price;

          const rawMinP = rule.minPrice ?? Math.round(ozonPrice * 0.8);
          const minP = rawMinP >= ozonPrice ? Math.max(1, ozonPrice - 1) : rawMinP;
          const safeOldPrice = (ozonRefOldPrice ?? 0) > ozonPrice ? Math.round(ozonRefOldPrice!) : 0;
          await ozonApi.updatePrices(
            creds,
            [{
              offer_id: prod.productId,
              price: String(Math.round(ozonPrice)),
              old_price: String(safeOldPrice),  // "0" сбрасывает зачёркнутую цену в Ozon
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

        const entry: PriceLog = {
          id: uid(), ruleId: id, marketplace: rule.marketplace,
          storeId: rule.storeId, storeName: rule.storeName,
          productId: prod.productId, productTitle: prod.productTitle,
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
    if (this.applyingAll) return;
    this.applyingAll = true;
    try {
      const active = this.rules.filter(r => r.status === 'active' && !this.applying.has(r.id));
      for (const r of active) await this.applyRule(r.id);
    } finally {
      this.applyingAll = false;
    }
  }

  /** Ставит цену напрямую через API маркетплейса, без логики правил (используется для откатов). */
  private async setMarketplacePrice(mp: Mp, storeId: string, productId: string, price: number): Promise<void> {
    if (mp === 'wb') {
      const store = this.wbStores.find(s => s.id === storeId);
      if (!store) throw new Error('Магазин WB не найден');
      await updateWbPrices(store.api_key, [{ nmID: Number(productId), price, discount: 0 }]);
      const wbProd = this.wbProducts.find(p => String(p.nm_id) === productId && p.store_id === storeId);
      if (wbProd) wbProd.price = price;
    } else if (mp === 'ozon') {
      const store = this.ozonStores.find(s => s.id === storeId);
      if (!store) throw new Error('Магазин Ozon не найден');
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const rawMinP = Math.round(price * 0.8);
      await ozonApi.updatePrices(creds, [{
        offer_id: productId,
        price: String(Math.round(price)),
        old_price: '0',
        min_price: String(rawMinP),
        auto_action_enabled: 'ENABLED',
      }]);
      const p = this.ozonProducts.find(p => p.offer_id === productId);
      if (p) p.price = price;
    } else {
      const store = this.ymStores.find(s => s.id === storeId);
      if (!store?.campaign_id) throw new Error('Магазин ЯМ или campaign_id не найден');
      await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id), [{
        offerId: productId, price,
      }]);
      const ymProd = this.ymProducts.find(p => p.offer_id === productId && p.store_id === store.id);
      if (ymProd) ymProd.basic_price = price;
    }
  }

  /** Откатывает цену из записи журнала обратно на oldPrice. */
  async revertLog(logId: string): Promise<void> {
    const entry = this.log.find(l => l.id === logId);
    if (!entry || entry.oldPrice == null || this.reverting.has(logId)) return;
    this.reverting.add(logId); this.render();

    try {
      await this.setMarketplacePrice(entry.marketplace, entry.storeId, entry.productId, entry.oldPrice);
      const revertEntry: PriceLog = {
        id: uid(), ruleId: entry.ruleId, marketplace: entry.marketplace,
        storeId: entry.storeId, storeName: entry.storeName,
        productId: entry.productId, productTitle: entry.productTitle,
        oldPrice: entry.newPrice, newPrice: entry.oldPrice,
        appliedAt: new Date().toISOString(), reason: 'Откат', isRevert: true,
      };
      this.log.unshift(revertEntry); saveLog(this.log);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      console.error('[Repricer] revertLog:', msg);
      this.revertErrors.set(logId, msg);
      setTimeout(() => { this.revertErrors.delete(logId); this.render(); }, 8000);
    }
    this.reverting.delete(logId); this.render();
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
    const mrcNeedsConfirm = this.mrcScanner.scanLog.some(e => e.needsConfirm);
    const TAB_CFG = [
      { id: 'rules',     label: 'Правила',       count: this.rules.length, violet: false, amber: mrcNeedsConfirm },
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
              <button class="rpr-btn rpr-btn-outline" onclick="window.repricerModule.applyAll()" ${this.applyingAll || this.applying.size > 0 ? 'disabled' : ''}>
                ${this.applyingAll || this.applying.size > 0
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
      mrcAlert: this.mrcScanner.scanLog.some(e => e.needsConfirm),
      renderMrcContent: () => this.renderMrc(),
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
    this.rulesTypeFilter = t as RuleType;
    this.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «ИСТОРИЯ»
  // ════════════════════════════════════════════════════════════════════════

  private renderLog(): string {
    return renderLogTab(this.log, this.reverting, this.revertErrors);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «МРЦ»
  // ════════════════════════════════════════════════════════════════════════

  /** Последняя запись анализа по каждой ячейке (ключ = `${ruleId}:${itemKey}`). */
  private mrcAnalysisMap(): Map<string, MrcScanEntry> {
    const m = new Map<string, MrcScanEntry>();
    for (const e of this.mrcScanner.scanLog) {
      const k = `${e.ruleId}:${e.itemKey}`;
      if (!m.has(k)) m.set(k, e);
    }
    return m;
  }

  private renderMrc(): string {
    const props: MrcTabProps = {
      rules: this.rules.filter(r => r.type === 'mrc'),
      analysis: this.mrcAnalysisMap(),
      applyingKeys: this.mrcApplyingKeys,
      productLink: (item) => this.mrcItemLink(item),
      scanning: this.mrcScanner.scanning,
      scanLog: this.mrcScanner.scanLog,
      scanProgress: this.mrcScanner.scanProgress,
      extensionAvailable: this.mrcScanner.extensionAvailable,
    };
    return renderMrcTab(props);
  }

  /** Публичная ссылка на карточку товара на маркетплейсе (та же логика, что и в каталоге). */
  private mrcItemLink(item: MrcItem): string | null {
    if (item.mp === 'ozon') {
      const product = this.ozonProducts.find(p => p.offer_id === item.productId && p.store_id === item.storeId);
      return productPageUrl('ozon', item.productId, { ozonSku: product?.sku ?? null });
    }
    if (item.mp === 'yandex') {
      const product = this.ymProducts.find(p => p.offer_id === item.productId && p.store_id === item.storeId);
      return productPageUrl('yandex', item.productId, { marketSku: product?.market_sku ?? null, marketModelId: product?.market_model_id ?? null });
    }
    return productPageUrl('wb', item.productId);
  }

  async analyzeMrc(): Promise<void> {
    await this.mrcScanner.runScan();
  }

  async applyMrcEntry(entryId: string): Promise<void> {
    const entry = this.mrcScanner.scanLog.find(e => e.id === entryId);
    if (!entry) return;
    const key = `${entry.ruleId}:${entry.itemKey}`;
    this.mrcApplyingKeys.add(key); this.render();
    try {
      await this.mrcScanner.applyEntry(entryId);
    } finally {
      this.mrcApplyingKeys.delete(key); this.render();
    }
  }

  async applyAllMrcDeviations(): Promise<void> {
    const ids = this.mrcScanner.scanLog.filter(e => e.action === 'needs_update').map(e => `${e.ruleId}:${e.itemKey}`);
    for (const k of ids) this.mrcApplyingKeys.add(k);
    this.render();
    try {
      await this.mrcScanner.applyAllDeviations();
    } finally {
      for (const k of ids) this.mrcApplyingKeys.delete(k);
      this.render();
    }
  }

  confirmMrcEntry(entryId: string, applied: boolean): void {
    this.mrcScanner.confirmEntry(entryId, applied);
  }

  async retryMrcItem(ruleId: string, itemKey: string): Promise<void> {
    await this.mrcScanner.retryItem(ruleId, itemKey);
  }

  removeMrcProduct(ruleId: string, vendorCode: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return;
    rule.mrcItems = (rule.mrcItems ?? []).filter(i => i.vendorCode !== vendorCode);
    repricerRulesDb.save(rule);
    this.render();
  }

  toggleMrcItem(ruleId: string, itemKey: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    const item = rule?.mrcItems?.find(i => i.key === itemKey);
    if (!rule || !item) return;
    item.enabled = !item.enabled;
    repricerRulesDb.save(rule);
    this.render();
  }

  updateMrcItemPrice(ruleId: string, itemKey: string, price: number): void {
    const rule = this.rules.find(r => r.id === ruleId);
    const item = rule?.mrcItems?.find(i => i.key === itemKey);
    if (!rule || !item || !isFinite(price) || price < 0) return;
    item.mrcPrice = price;
    repricerRulesDb.save(rule);
  }

  /** Ручное снятие паузы ячейки МРЦ (см. MrcCellState.paused) — сервер также снимает её
   *  сам после нескольких здоровых чтений подряд; эта кнопка — дополнительный быстрый путь. */
  clearMrcPause(ruleId: string, itemKey: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    const state = rule?.mrcState?.[itemKey];
    if (!rule || !state) return;
    state.paused = false;
    state.pausedReason = undefined;
    state.pausedAt = undefined;
    state.consecutiveAnomalies = 0;
    state.consecutiveHealthy = 0;
    repricerRulesDb.save(rule);
    this.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «СЕБЕСТОИМОСТИ» — управление cost_price для всех товаров
  // ════════════════════════════════════════════════════════════════════════

  private costsTabProps(): CostsTabProps {
    return {
      products: this.buildUnifiedProducts(),
      costsSearch: this.costsSearch,
      costsMpFilter: this.costsMpFilter,
      costsSelected: this.costsSelected,
      costsBulkValue: this.costsBulkValue,
      soldVendorCodes: this.soldVendorCodes ?? null,
      getCost: (vendorCode: string) => costPriceDb.get(vendorCode),
      allCostEntries: costPriceDb.all(),
      producerLinks: costProducerLinks.all(),
      producerCostMap: this.producerCostMap,
    };
  }

  private renderCosts(): string {
    return renderCostsTab(this.costsTabProps());
  }

  /** Лёгкая перерисовка только фильтров/таблицы себестоимостей без потери фокуса на поиске. */
  private renderCostsOnly(): void {
    const host = document.getElementById('rpr-costs-host');
    if (!host) return;
    const active = document.activeElement as HTMLInputElement | null;
    const wasSearch = active?.classList.contains('rpr-search');
    const selStart = wasSearch ? active!.selectionStart : null;
    const selEnd   = wasSearch ? active!.selectionEnd   : null;
    host.innerHTML = renderCostsInnerTab(this.costsTabProps());
    if (wasSearch) {
      const inp = host.querySelector('input.rpr-search') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        if (selStart !== null && selEnd !== null) inp.setSelectionRange(selStart, selEnd);
      }
    }
  }

  setCostsSearch(q: string): void {
    this.costsSearch = q;
    if (this.costsSearchTimer != null) clearTimeout(this.costsSearchTimer);
    this.costsSearchTimer = window.setTimeout(() => this.renderCostsOnly(), 200);
  }
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
      const { dbFetch } = await import('@/services/dbClient');
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
      const rows = await dbFetch<Array<{ items_json: Array<{ sku?: any; vendor_code?: any }> | null }>>(
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

  /** Загрузить карту «артикул МП → себестоимость от производителя».
   *  Автоматически привязывает себестоимость для всех найденных совпадений. */
  private async loadProducerCostMap(): Promise<void> {
    if (this.producerCostMapLoaded) return;
    try {
      const [mappings, products, fields] = await Promise.all([
        producerMappingDb.list(),
        producerProductDb.list(),
        producerFieldDb.list(),
      ]);
      const costField = fields.find(f => /себестоимост/i.test(f.name));
      if (!costField) { this.producerCostMapLoaded = true; return; }

      const productsById = new Map(products.map(p => [p.id, p]));
      const map = new Map<string, { cost: number; producerProductId: string; producerName: string }>();

      for (const m of mappings) {
        const product = productsById.get(m.producer_product_id);
        if (!product) continue;
        const rawVal = product.field_values?.[costField.id];
        if (!rawVal) continue;
        const cost = parseFloat(String(rawVal).replace(',', '.'));
        if (!isFinite(cost) || cost <= 0) continue;
        map.set(m.marketplace_article.trim().toLowerCase(), {
          cost,
          producerProductId: m.producer_product_id,
          producerName: product.name,
        });
      }

      this.producerCostMap = map;
      this.producerCostMapLoaded = true;

      // Автоматическая привязка себестоимости для непривязанных артикулов
      let linkedCount = 0;
      for (const [article, info] of map) {
        if (costProducerLinks.isLinked(article)) continue;
        costPriceDb.set(article, info.cost);
        costProducerLinks.link(article, info.producerProductId, info.producerName, info.cost);
        linkedCount++;
      }
      if (linkedCount > 0) {
        console.info(`[Repricer] Auto-linked ${linkedCount} cost prices from producers`);
      }

      if (this.tab === 'costs') this.render();
    } catch (e: any) {
      console.warn('[Repricer] loadProducerCostMap failed:', e?.message ?? e);
    }
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

  /**
   * Изменить себестоимость с проверкой привязки к производителю.
   * Если артикул привязан — показывает предупреждение. При подтверждении снимает привязку.
   */
  setCostWithProducerCheck(vendorCode: string, cost: number): void {
    if (costProducerLinks.isLinked(vendorCode)) {
      const link = costProducerLinks.get(vendorCode)!;
      const ok = confirm(
        `Себестоимость этого артикула привязана к производителю «${link.producerName}».\n` +
        `Текущее значение: ${link.costAtLink.toLocaleString('ru')} ₽\n\n` +
        `Хотите изменить вручную и снять привязку к производителю?`
      );
      if (!ok) { this.render(); return; }
      costProducerLinks.unlink(vendorCode);
    }
    this.setCost(vendorCode, cost);
  }

  /** Перепривязать себестоимость от производителя (восстановить после ручного изменения). */
  relinkFromProducer(vendorCode: string): void {
    const available = this.producerCostMap.get(vendorCode.trim().toLowerCase());
    if (!available) return;
    const ok = confirm(
      `Привязать себестоимость «${vendorCode}» от производителя?\n` +
      `Будет установлено: ${available.cost.toLocaleString('ru')} ₽`
    );
    if (!ok) return;
    costPriceDb.set(vendorCode, available.cost);
    costProducerLinks.link(vendorCode, available.producerProductId, available.producerName, available.cost);
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
