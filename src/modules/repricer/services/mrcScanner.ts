/**
 * Клиентский анализ цен для правил типа «МРЦ» — кнопка «Анализ» в табе МРЦ.
 *
 * Постоянное автоматическое поддержание цены (скан + применение) теперь выполняет
 * серверная Edge Function backend/functions/mrc-scan каждые ~20 минут через pg_cron —
 * независимо от того, открыта ли вкладка SimaDesk. Этот клиентский движок — только
 * для ручной работы прямо сейчас:
 *
 * - runScan() — анализирует все включённые ячейки активных правил МРЦ: определяет
 *   текущую витринную цену и статус (ok / needs_update / error), ничего не меняет
 *   на маркетплейсах.
 * - applyEntry(entryId) — применить цену по одной ячейке после анализа (по кнопке
 *   «Применить»).
 * - applyAllDeviations() — применить цену по всем ячейкам со статусом needs_update
 *   (последовательно — чтобы не отправлять маркетплейсам пачку параллельных
 *   запросов на изменение цены и не упереться в rate-limit).
 * - После применения через 1 минуту перепроверяет витрину; если она не
 *   сдвинулась к цели — повторяет адаптивную корректировку (до MRC_MAX_ADJUST_ITERATIONS раз),
 *   после чего помечает запись needsConfirm (UI покажет кнопки «Применилось» / «Не применилось»).
 * - Незавершённые verify сохраняются в localStorage и возобновляются при перезагрузке страницы.
 */

import { debug } from '@/utils/debug';
import { updateWbPrices } from '@/services/wbApi';
import { ozonApi } from '@/services/ozonApi';
import { yandexApi } from '@/services/yandexApi';
import { detectSimaDeskExtension, checkPriceNow, sendConfigToExtension } from '@/services/extensionDetect';
import type { CheckPriceNowParams } from '@/services/extensionDetect';
import type { WbStore, WbProduct } from '@/types/wb';
import type { OzonStore, OzonProduct } from '@/types/ozon';
import type { YandexStore, YandexProduct } from '@/types/yandex';
import type {
  RepricerRule, MrcItem, MrcScanEntry, Mp, PendingVerify,
} from '../types';
import {
  MRC_SCAN_LOG_KEY,
  MRC_VERIFY_DELAY_MS, MRC_MAX_ADJUST_ITERATIONS,
  MRC_PENDING_VERIFY_KEY, MRC_PENDING_VERIFY_MAX_AGE_MS,
} from '../types';
import {
  computeNewSellerPrice, exactSellerPriceForMrc,
  mrcShowcaseDeviated, uid,
} from '../utils';
import {
  fetchOzonPricesForStore, fetchOzonBuyerPrices,
  fetchWbBuyerPrices,
  fetchYmSellerPrices, fetchYmBuyerPrices,
} from './priceApi';

const MAX_LOG_ENTRIES = 200;

// Задержка propagation: маркетплейс принял цену в ЛК, но витрина ещё не пересчиталась.
// Для ЯМ — типично 15–30 мин. Проверяем раз в 10 мин, ждём не дольше 45 мин.
const MRC_PROPAGATION_RETRY_MS = 10 * 60_000;
const MRC_PROPAGATION_MAX_WAIT_MS = 45 * 60_000;
// Порог «витрина не изменилась»: если |current - before| < N ₽, считаем что не обновилась
const MRC_SHOWCASE_UNCHANGED_RUB = 50;
// Окно недавнего применения (для скана): если не старше этого, suppressим needs_update
const MRC_PROPAGATION_SCAN_WINDOW_MS = 35 * 60_000;

const MP_LABEL: Record<Mp, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

interface ItemPrices {
  buyerPrice: number;
  sellerPrice: number;
  ozOldPrice?: number;
  /** false — buyerPrice — это лишь оценка (равна цене продавца, без учёта реальной витрины),
   *  настоящая витринная цена неизвестна (нет свежих данных от расширения SimaDesk). */
  buyerPriceKnown?: boolean;
}

export interface MrcScannerContext {
  getRules: () => RepricerRule[];
  getWbStores: () => WbStore[];
  getWbProducts: () => WbProduct[];
  getOzonStores: () => OzonStore[];
  getOzonProducts: () => OzonProduct[];
  getYmStores: () => YandexStore[];
  getYmProducts: () => YandexProduct[];
  onChange: () => void;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}
function saveJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

export class MrcScanner {
  lastScanAt: string | null = null;
  scanning = false;
  scanLog: MrcScanEntry[] = [];
  /** Прогресс проверки точной цены через расширение (во время «Анализ»). */
  scanProgress: { current: number; total: number } | null = null;
  /** Доступно ли расширение SimaDesk — проверяется при каждом скане. */
  extensionAvailable: boolean | null = null;
  private verifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private ctx: MrcScannerContext) {
    this.scanLog = loadJson(MRC_SCAN_LOG_KEY, []);
    this.resumePendingVerifies();
  }

  // ── Получение цен по одной ячейке ───────────────────────────────────────

  private async fetchItemPrices(item: MrcItem): Promise<ItemPrices | null> {
    if (item.mp === 'wb') {
      // Берём цену продавца из кеша каталога (wb_products) — без обращения к API WB,
      // которое таймаутится при rate-limit. Данные синхронизируются при открытии каталога.
      const nmId = Number(item.productId);
      const wbProduct = this.ctx.getWbProducts().find(p => p.nm_id === nmId && p.store_id === item.storeId);
      if (!wbProduct?.price) return null;
      const sellerPrice = wbProduct.price;
      // Витрина — только от расширения (wb_buyer_prices, цена без WB Кошелька/СПП).
      // Без свежих данных buyerPrice — лишь оценка (= цена продавца), не настоящая витрина.
      const buyerInfo = (await fetchWbBuyerPrices([nmId])).get(nmId);
      const buyerPrice = buyerInfo?.fresh ? buyerInfo.price : sellerPrice;
      return { buyerPrice, sellerPrice, buyerPriceKnown: buyerInfo?.fresh === true };
    }
    if (item.mp === 'ozon') {
      const store = this.ctx.getOzonStores().find(s => s.id === item.storeId);
      if (!store) return null;
      const d = (await fetchOzonPricesForStore(store, [item.productId])).get(item.productId);
      if (!d) return null;
      // Витрина — только от расширения (ozon_buyer_prices, цена без Ozon Card).
      // Ключуем по глобальному Ozon product_id, а не по offer_id — артикул продавца
      // не уникален между разными продавцами (см. комментарий в priceApi.ts).
      const ozonProduct = this.ctx.getOzonProducts().find(p => p.offer_id === item.productId && p.store_id === item.storeId);
      const buyerInfo = (await fetchOzonBuyerPrices([{ offerId: item.productId, productId: ozonProduct?.product_id ?? null }])).get(item.productId);
      const buyerPrice = buyerInfo?.fresh ? buyerInfo.price : d.sellerPrice;
      return { buyerPrice, sellerPrice: d.sellerPrice, ozOldPrice: d.oldPrice, buyerPriceKnown: buyerInfo?.fresh === true };
    }
    // yandex
    const store = this.ctx.getYmStores().find(s => s.id === item.storeId);
    if (!store?.campaign_id) return null;
    // ЛК-цена = basicPrice из каталога (что продавец выставил в своём кабинете).
    // getOfferPrices возвращает цену покупателя с учётом акций/карты — для ЛК она не подходит.
    const ymProduct = this.ctx.getYmProducts().find(
      p => p.offer_id === item.productId && p.store_id === item.storeId,
    );
    let sellerPrice: number = ymProduct?.basic_price ?? 0;
    if (!sellerPrice) {
      // Fallback: если basic_price не закеширован — спросим API
      const sellerData = (await fetchYmSellerPrices(store)).get(item.productId);
      sellerPrice = sellerData?.price ?? 0;
    }
    // Ключуем по глобальному market_sku, а не по offer_id — артикул продавца
    // не уникален между разными продавцами (см. комментарий в priceApi.ts).
    const buyerInfo = (await fetchYmBuyerPrices([{ offerId: item.productId, marketSku: ymProduct?.market_sku ?? null }])).get(item.productId);
    if (!sellerPrice && !buyerInfo?.price) return null;
    // У ЯМ нет API для расчётной витринной цены — без СВЕЖИХ данных расширения (буст/карта
    // могут сильно отличать витрину от цены продавца, а устаревшая запись может относиться
    // к давно прошедшей акции) считаем buyerPrice неизвестным и используем sellerPrice.
    const buyerPrice = buyerInfo?.fresh ? buyerInfo.price : sellerPrice;
    return { buyerPrice, sellerPrice: sellerPrice || buyerPrice, buyerPriceKnown: buyerInfo?.fresh === true };
  }

  /** Параметры для запроса расширению — открыть карточку товара и считать точную цену. */
  private checkPriceNowParams(item: MrcItem): CheckPriceNowParams | { error: string } {
    if (item.mp === 'wb') {
      const nmId = Number(item.productId);
      if (!nmId) return { error: 'Не определён артикул WB (nmId)' };
      return { marketplace: 'wb', nmId, productTitle: item.productTitle };
    }
    if (item.mp === 'ozon') {
      const product = this.ctx.getOzonProducts().find(p => p.offer_id === item.productId && p.store_id === item.storeId);
      if (!product) return { error: 'Товар Ozon не найден в каталоге — обновите синхронизацию' };
      if (!product.sku) return { error: 'У товара Ozon не определён SKU витрины' };
      return { marketplace: 'ozon', sku: String(product.sku), offerId: item.productId, productTitle: item.productTitle };
    }
    // yandex
    const product = this.ctx.getYmProducts().find(p => p.offer_id === item.productId && p.store_id === item.storeId);
    if (!product?.market_sku) return { error: 'У товара ЯМ не определён marketSku — обновите синхронизацию' };
    return {
      marketplace: 'yandex', marketSku: product.market_sku,
      marketModelId: product.market_model_id ?? undefined,
      offerId: item.productId, productTitle: item.productTitle,
    };
  }

  /**
   * Применяет новую цену продавца на маркетплейсе, возвращает применённую цену.
   *
   * WB / Ozon / ЯМ: масштабирует цену продавца пропорционально отклонению витрины
   *   от МРЦ с клампингом ±20% за цикл (зависимость витрина/цена не всегда строго
   *   линейна, поэтому ограничение нужно). Ozon: auto_action_enabled всегда DISABLED —
   *   иначе автоакции Ozon сами двигают витрину и конфликтуют с поддержанием МРЦ.
   *
   * @param opts.skipPromoRemoval ЯМ: не снимать товар с акций повторно — используется
   *   для повторных итераций adaptивного подбора (verify), где товар уже сняли с акций
   *   на первом применении в этой цепочке корректировок.
   */
  private async applyPrice(item: MrcItem, prices: ItemPrices, opts: { skipPromoRemoval?: boolean; priceOverride?: number } = {}): Promise<number> {
    const targetShowcase = item.mrcPrice;
    const calcPrice = opts.priceOverride != null
      ? (_sp: number, _bp: number) => opts.priceOverride!
      : (sp: number, bp: number) => computeNewSellerPrice(targetShowcase, sp, bp);

    if (item.mp === 'wb') {
      const store = this.ctx.getWbStores().find(s => s.id === item.storeId);
      if (!store) throw new Error('Магазин WB не найден');
      const nmId = Number(item.productId);
      const newPrice = calcPrice(prices.sellerPrice, prices.buyerPrice);
      if (!isFinite(newPrice) || newPrice <= 0) throw new Error(`Рассчитанная цена некорректна (${newPrice})`);
      await updateWbPrices(store.api_key, [{ nmID: nmId, price: newPrice }]);
      // Обновляем локальный кеш, чтобы verify видел актуальные данные без пересинхронизации каталога
      const cached = this.ctx.getWbProducts().find(p => p.nm_id === nmId && p.store_id === item.storeId);
      if (cached) cached.price = newPrice;
      return newPrice;
    }

    if (item.mp === 'ozon') {
      const store = this.ctx.getOzonStores().find(s => s.id === item.storeId);
      if (!store) throw new Error('Магазин Ozon не найден');
      const newPrice = calcPrice(prices.sellerPrice, prices.buyerPrice);
      if (!isFinite(newPrice) || newPrice <= 0) throw new Error(`Рассчитанная цена некорректна (${newPrice})`);
      const minP = Math.min(newPrice - 1, Math.round(newPrice * 0.8));
      await ozonApi.updatePrices({ client_id: store.client_id, api_key: store.api_key }, [{
        offer_id: item.productId,
        price: String(newPrice),
        ...((prices.ozOldPrice ?? 0) > newPrice ? { old_price: String(prices.ozOldPrice) } : {}),
        min_price: String(Math.max(1, minP)),
        auto_action_enabled: 'DISABLED',
      }]);
      const cachedOzon = this.ctx.getOzonProducts().find(p => p.offer_id === item.productId && p.store_id === item.storeId);
      if (cachedOzon) (cachedOzon as any).price = newPrice;
      return newPrice;
    }

    // yandex
    const store = this.ctx.getYmStores().find(s => s.id === item.storeId);
    if (!store?.campaign_id) throw new Error('Магазин ЯМ не найден');
    const newPrice = calcPrice(prices.sellerPrice, prices.buyerPrice);
    if (!isFinite(newPrice) || newPrice <= 0) throw new Error(`Рассчитанная цена некорректна (${newPrice})`);
    if (store.business_id && !opts.skipPromoRemoval) {
      await yandexApi.removeOffersFromAllPromos(store.api_key, store.business_id, [item.productId]);
    }
    await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id), [{
      offerId: item.productId, price: newPrice, clearDiscountBase: true,
    }]);
    const cachedYm = this.ctx.getYmProducts().find(p => p.offer_id === item.productId && p.store_id === item.storeId);
    if (cachedYm) cachedYm.basic_price = newPrice;
    return newPrice;
  }

  // ── Анализ ───────────────────────────────────────────────────────────────

  /** Все включённые ячейки активных MRC-правил. */
  private enabledItems(): Array<{ rule: RepricerRule; item: MrcItem }> {
    const out: Array<{ rule: RepricerRule; item: MrcItem }> = [];
    for (const rule of this.ctx.getRules()) {
      if (rule.type !== 'mrc' || rule.status !== 'active') continue;
      for (const item of rule.mrcItems ?? []) {
        if (item.enabled) out.push({ rule, item });
      }
    }
    return out;
  }

  /** Анализирует все включённые ячейки — определяет текущую витрину и статус, ничего не применяет. */
  async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.scanProgress = null;
    this.ctx.onChange();

    try {
      const items = this.enabledItems();

      this.extensionAvailable = await detectSimaDeskExtension().catch(() => false);
      if (this.extensionAvailable) sendConfigToExtension();
      debug.log('[mrcScanner] scan start', { extensionAvailable: this.extensionAvailable, items: items.length });

      for (let i = 0; i < items.length; i++) {
        const { rule, item } = items[i];
        if (this.extensionAvailable) {
          this.scanProgress = { current: i + 1, total: items.length };
          this.ctx.onChange();
        }
        await this.scanOne(rule, item);
      }
    } finally {
      this.scanProgress = null;
      this.lastScanAt = new Date().toISOString();
      this.scanning = false;
      this.saveLog();
      this.ctx.onChange();
    }
  }

  /** Повторить анализ одной ячейки (по кнопке «Повторить» в журнале/сетке). */
  async retryItem(ruleId: string, itemKey: string): Promise<void> {
    if (this.scanning) return;
    const ri = this.findRuleItem(ruleId, itemKey);
    if (!ri) return;

    this.scanning = true;
    this.ctx.onChange();
    try {
      this.extensionAvailable = await detectSimaDeskExtension().catch(() => false);
      if (this.extensionAvailable) sendConfigToExtension();
      await this.scanOne(ri.rule, ri.item);
    } finally {
      this.scanning = false;
      this.saveLog();
      this.ctx.onChange();
    }
  }

  /** Анализирует одну ячейку: точная цена через расширение (если доступно) + цены ЛК/витрины, пишет запись в журнал. */
  private async scanOne(rule: RepricerRule, item: MrcItem): Promise<void> {
    let extensionError: string | undefined;
    // Витринная цена напрямую от расширения (res.price) — не ждём записи в БД,
    // потому что reportXxxPrice в background.js fire-and-forget и может завершиться
    // позже, чем мы читаем из базы в fetchItemPrices.
    let extensionBuyerPrice: number | null = null;
    if (this.extensionAvailable) {
      try {
        const params = this.checkPriceNowParams(item);
        if ('error' in params) {
          extensionError = params.error;
        } else {
          const res = await checkPriceNow(params);
          if (res.ok && res.price) {
            extensionBuyerPrice = res.price;
            debug.log(`[mrcScanner] ${item.productTitle} (${item.mp}): найдена цена ${res.price} ₽`);
          } else {
            extensionError = res.error ?? 'Не удалось проверить цену на странице товара';
          }
        }
      } catch (e: unknown) {
        extensionError = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? String(e);
      }
      if (extensionError) debug.warn(`[mrcScanner] ${item.productTitle} (${item.mp}): ${extensionError}`);
    }

    try {
      const prices = await this.fetchItemPrices(item);
      if (!prices) {
        // Цена ЛК недоступна, но расширение могло уже получить витринную цену —
        // показываем её без возможности менять (нет данных для расчёта целевой цены ЛК).
        const buyerForDisplay = extensionBuyerPrice ?? 0;
        this.pushEntry(rule, item, 0, buyerForDisplay, 'error',
          'Цена ЛК недоступна — показана витрина, изменение невозможно',
          undefined, extensionError);
        return;
      }

      // Расширение вернуло свежую витринную цену — подставляем её напрямую,
      // не полагаясь на то, что БД уже обновилась (race condition).
      if (extensionBuyerPrice != null) {
        // Ozon: зачёркнутая «старая» цена всегда выше цены ЛК продавца.
        // Если расширение вернуло цену > sellerPrice * 1.05 — это зачёркнутая цена → игнорируем.
        const isLikelyStrikethrough =
          item.mp === 'ozon' &&
          prices.sellerPrice > 0 &&
          extensionBuyerPrice > prices.sellerPrice * 1.05;
        if (!isLikelyStrikethrough) {
          prices.buyerPrice = extensionBuyerPrice;
          prices.buyerPriceKnown = true;
        }
      }

      if (prices.buyerPriceKnown === false) {
        // Реальная витринная цена неизвестна (нет свежих данных расширения) — без неё точно
        // посчитать целевую цену продавца нельзя (источник витрины для МРЦ — только расширение).
        this.pushEntry(
          rule, item, prices.sellerPrice, 0, 'error',
          `Нет данных о витринной цене ${MP_LABEL[item.mp]} — нажмите «Повторить» (нужно расширение SimaDesk)`,
          undefined, extensionError,
        );
        return;
      }

      if (!mrcShowcaseDeviated(prices.buyerPrice, item.mrcPrice)) {
        this.pushEntry(rule, item, prices.sellerPrice, prices.buyerPrice, 'ok', undefined, undefined, extensionError);
        return;
      }

      // Витрина отклонилась, но возможно цена только что поставлена — маркетплейс ещё не
      // пересчитал витрину (ЯМ: 15–30 мин). Если в лог-журнале есть недавняя 'adjusted'
      // запись для этой ячейки с той же ЛК-ценой — не показываем needs_update, ждём.
      if (prices.sellerPrice > 0) {
        const recentApply = this.scanLog.find(e =>
          e.ruleId === rule.id &&
          e.itemKey === item.key &&
          e.action === 'adjusted' &&
          e.newPrice != null &&
          e.newPrice === prices.sellerPrice &&
          Date.now() - new Date(e.scannedAt).getTime() < MRC_PROPAGATION_SCAN_WINDOW_MS,
        );
        if (recentApply) {
          this.pushEntry(rule, item, prices.sellerPrice, prices.buyerPrice, 'adjusted',
            undefined, recentApply.newPrice, extensionError);
          return;
        }
      }

      const suggested = exactSellerPriceForMrc(item.mrcPrice, prices.sellerPrice, prices.buyerPrice);

      this.pushEntry(rule, item, prices.sellerPrice, prices.buyerPrice, 'needs_update', undefined, suggested, extensionError);
    } catch (e: unknown) {
      // Если расширение успело получить витринную цену до того, как API ЛК упало —
      // сохраняем её, чтобы хотя бы показать в ячейке.
      const buyerForErr = extensionBuyerPrice ?? 0;
      this.pushEntry(rule, item, 0, buyerForErr, 'error', (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? String(e), undefined, extensionError);
    }
  }

  // ── Применение по результатам анализа ───────────────────────────────────

  /** Применить новую цену по одной записи анализа (action === 'needs_update'). */
  async applyEntry(entryId: string): Promise<void> {
    const entry = this.scanLog.find(e => e.id === entryId);
    if (!entry || entry.action !== 'needs_update') return;

    const ri = this.findRuleItem(entry.ruleId, entry.itemKey);
    if (!ri) return;

    try {
      const prices = await this.fetchItemPrices(ri.item);
      if (!prices) throw new Error('Не удалось получить цены');

      // Apply exactly the price shown to the user at scan time ("поставьте цену N ₽").
      // This avoids stale-buyerPrice pitfalls and the ±20% cap — both belong only in verify().
      const newPrice = await this.applyPrice(ri.item, prices, { priceOverride: entry.newPrice });

      entry.sellerPrice = prices.sellerPrice;
      entry.buyerPrice = entry.buyerPrice; // keep scan-time showcase price
      entry.action = 'adjusted';
      entry.newPrice = newPrice;
      entry.adjustIteration = 0;
      delete entry.errorMsg;
      delete entry.needsConfirm;
      this.saveLog();
      this.ctx.onChange();
      this.scheduleVerify(ri.rule.id, ri.item.key, entry.id);
    } catch (e: unknown) {
      entry.action = 'error';
      entry.errorMsg = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? String(e);
      this.saveLog();
      this.ctx.onChange();
    }
  }

  /** Применить новую цену по всем записям анализа со статусом needs_update — последовательно
   *  (не параллельно), чтобы не отправлять маркетплейсам пачку конкурентных запросов на
   *  изменение цены и не упереться в rate-limit (особенно у WB). */
  async applyAllDeviations(): Promise<void> {
    const ids = this.scanLog.filter(e => e.action === 'needs_update').map(e => e.id);
    for (const id of ids) {
      await this.applyEntry(id);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }

  private findRuleItem(ruleId: string, itemKey: string): { rule: RepricerRule; item: MrcItem } | null {
    const rule = this.ctx.getRules().find(r => r.id === ruleId);
    const item = rule?.mrcItems?.find(i => i.key === itemKey);
    return rule && item ? { rule, item } : null;
  }

  // ── Адаптивный подбор цены (итерации) ─────────────────────────────────

  /**
   * Через MRC_VERIFY_DELAY_MS проверяет витринную цену и, если она ещё не
   * совпала с МРЦ, применяет скорректированную цену ЛК ещё раз.
   * Алгоритм: new_lk = current_lk × (target / current_vitrina).
   * До MRC_MAX_ADJUST_ITERATIONS итераций; после — needsConfirm.
   *
   * Параметры ruleId/itemKey/entryId (а не объекты) позволяют корректно
   * возобновить verify после перезагрузки страницы через resumePendingVerifies().
   */
  private scheduleVerify(ruleId: string, itemKey: string, entryId: string, delayMs = MRC_VERIFY_DELAY_MS): void {
    if (this.verifyTimers.has(entryId)) clearTimeout(this.verifyTimers.get(entryId)!);
    const verifyAt = new Date(Date.now() + delayMs).toISOString();
    this.addPendingVerify({ ruleId, itemKey, entryId, verifyAt });
    const handle = setTimeout(() => {
      this.verifyTimers.delete(entryId);
      void this.verify(ruleId, itemKey, entryId);
    }, delayMs);
    this.verifyTimers.set(entryId, handle);
  }

  private async verify(ruleId: string, itemKey: string, entryId: string): Promise<void> {
    this.removePendingVerify(entryId);

    const entry = this.scanLog.find(e => e.id === entryId);
    if (!entry) return;

    const ri = this.findRuleItem(ruleId, itemKey);
    if (!ri) return; // правило или товар удалены — молча выходим

    let prices: ItemPrices | null = null;
    try {
      prices = await this.fetchItemPrices(ri.item);
    } catch (e) { debug.warn('[mrcScanner] verify:', e); }

    if (prices?.buyerPriceKnown === false) {
      entry.needsConfirm = true;
      this.saveLog();
      this.ctx.onChange();
      return;
    }

    const buyerPrice = prices?.buyerPrice ?? 0;
    const sellerPrice = prices?.sellerPrice ?? 0;

    // Цена поставлена в ЛК (sellerPrice совпадает с тем, что мы отправили), витрина сдвинулась
    // незначительно и ещё отклонена от МРЦ — маркетплейс обрабатывает изменение (ЯМ: 15–30 мин).
    // Условие: 1) showcase ПЕРЕМЕСТИЛСЯ (хоть немного) — признак идущей propagation;
    //           2) всё ещё отклонён от МРЦ — если уже сошлось, сразу переходим к OK.
    if (
      buyerPrice > 0 &&
      sellerPrice > 0 &&
      entry.newPrice != null &&
      sellerPrice === entry.newPrice &&
      entry.buyerPrice > 0 &&
      buyerPrice !== entry.buyerPrice &&
      Math.abs(buyerPrice - entry.buyerPrice) < MRC_SHOWCASE_UNCHANGED_RUB &&
      mrcShowcaseDeviated(buyerPrice, ri.item.mrcPrice)
    ) {
      const elapsed = Date.now() - new Date(entry.scannedAt).getTime();
      if (elapsed < MRC_PROPAGATION_MAX_WAIT_MS) {
        this.scheduleVerify(ruleId, itemKey, entryId, MRC_PROPAGATION_RETRY_MS);
      } else {
        entry.needsConfirm = true;
        this.saveLog();
        this.ctx.onChange();
      }
      return;
    }

    if (buyerPrice && !mrcShowcaseDeviated(buyerPrice, ri.item.mrcPrice)) {
      entry.buyerPrice = buyerPrice;
      if (prices) entry.sellerPrice = prices.sellerPrice;
      entry.action = 'ok';
      delete entry.needsConfirm;
      this.saveLog();
      this.ctx.onChange();
      return;
    }

    const iteration = entry.adjustIteration ?? 0;

    // Витрина не сошлась — корректируем цену ЛК и ждём снова. Это повторная итерация
    // одной и той же цепочки корректировок, поэтому товар с акций ЯМ уже снят на первом
    // применении (applyEntry) — повторно снимать не нужно (skipPromoRemoval).
    if (buyerPrice > 0 && prices && iteration < MRC_MAX_ADJUST_ITERATIONS) {
      try {
        if (entry.action !== 'adjusted') return;
        const newPrice = await this.applyPrice(ri.item, prices, { skipPromoRemoval: true });

        entry.sellerPrice = prices.sellerPrice;
        entry.buyerPrice = buyerPrice;
        entry.newPrice = newPrice;
        entry.adjustIteration = iteration + 1;
        entry.action = 'adjusted';
        delete entry.needsConfirm;
        this.saveLog();
        this.ctx.onChange();
        this.scheduleVerify(ruleId, itemKey, entryId);
        return;
      } catch (e: unknown) {
        entry.errorMsg = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? String(e);
        entry.action = 'error';
      }
    } else {
      // Исчерпали итерации или нет данных с витрины — просим подтверждения
      entry.needsConfirm = true;
      if (buyerPrice) entry.buyerPrice = buyerPrice;
    }

    this.saveLog();
    this.ctx.onChange();
  }

  /** Пользователь подтвердил/отклонил результат изменения цены.
   *  Если не применилось — возвращаем запись в needs_update, чтобы пользователь
   *  мог сразу повторить применение, не дожидаясь нового «Анализа». */
  confirmEntry(entryId: string, applied: boolean): void {
    const entry = this.scanLog.find(e => e.id === entryId);
    if (!entry) return;
    entry.needsConfirm = false;
    if (!applied) {
      entry.action = 'needs_update';
      delete entry.newPrice;
    }
    this.saveLog();
    this.ctx.onChange();
  }

  // ── Persistence для pending verifies ─────────────────────────────────────

  /**
   * Возобновляет verify-таймеры, пережившие перезагрузку страницы.
   * Вызывается в конструкторе — до загрузки правил из БД, поэтому
   * findRuleItem не вызывается здесь: он вызовется внутри verify(),
   * когда правила уже будут загружены.
   */
  private resumePendingVerifies(): void {
    const pending = loadJson<PendingVerify[]>(MRC_PENDING_VERIFY_KEY, []);
    if (pending.length === 0) return;

    const now = Date.now();
    // Убираем устаревшие записи (старше 24 часов)
    const fresh = pending.filter(p => now - new Date(p.verifyAt).getTime() < MRC_PENDING_VERIFY_MAX_AGE_MS);
    if (fresh.length !== pending.length) saveJson(MRC_PENDING_VERIFY_KEY, fresh);

    for (const p of fresh) {
      // Если срок уже прошёл — запускаем через 5 секунд (дать время загрузиться правилам)
      const delay = Math.max(5_000, new Date(p.verifyAt).getTime() - now);
      setTimeout(() => { void this.verify(p.ruleId, p.itemKey, p.entryId); }, delay);
    }
  }

  private addPendingVerify(p: PendingVerify): void {
    const list = loadJson<PendingVerify[]>(MRC_PENDING_VERIFY_KEY, []);
    list.push(p);
    saveJson(MRC_PENDING_VERIFY_KEY, list);
  }

  private removePendingVerify(entryId: string): void {
    const list = loadJson<PendingVerify[]>(MRC_PENDING_VERIFY_KEY, []);
    const filtered = list.filter(p => p.entryId !== entryId);
    if (filtered.length !== list.length) saveJson(MRC_PENDING_VERIFY_KEY, filtered);
  }

  // ── Журнал ───────────────────────────────────────────────────────────────

  private pushEntry(
    rule: RepricerRule, item: MrcItem,
    sellerPrice: number, buyerPrice: number,
    action: MrcScanEntry['action'], errorMsg?: string, newPrice?: number, extensionError?: string,
  ): MrcScanEntry {
    const entry: MrcScanEntry = {
      id: uid(),
      scannedAt: new Date().toISOString(),
      ruleId: rule.id,
      itemKey: item.key,
      mp: item.mp as Mp,
      storeName: item.storeName,
      productTitle: item.productTitle,
      vendorCode: item.vendorCode,
      mrcPrice: item.mrcPrice,
      sellerPrice,
      buyerPrice,
      action,
      ...(newPrice != null ? { newPrice } : {}),
      ...(errorMsg ? { errorMsg } : {}),
      ...(extensionError ? { extensionError } : {}),
    };
    this.scanLog.unshift(entry);
    if (this.scanLog.length > MAX_LOG_ENTRIES) {
      const pendingIds = new Set(loadJson<PendingVerify[]>(MRC_PENDING_VERIFY_KEY, []).map(p => p.entryId));
      const excess = this.scanLog.slice(MAX_LOG_ENTRIES);
      this.scanLog = [
        ...this.scanLog.slice(0, MAX_LOG_ENTRIES),
        ...excess.filter(e => pendingIds.has(e.id)),
      ];
    }
    return entry;
  }

  private saveLog(): void { saveJson(MRC_SCAN_LOG_KEY, this.scanLog); }
}
