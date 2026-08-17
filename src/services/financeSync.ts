/**
 * financeSync — оркестратор синхронизации финансовых транзакций.
 *
 * Поддерживает Ozon, Wildberries (отчёт детализации), Яндекс Маркет (stats/orders).
 */

import { debug } from '../utils/debug';
import { ozonDb } from './ozonDb';
import { wbDb } from './wbDb';
import { yandexDb } from './yandexDb';
import { ozonFinanceApi, OzonTransaction } from './ozonFinanceApi';
import { wbFinanceApi, WbFinanceRow } from './wbFinanceApi';
import { yandexFinanceApi, YmStatsOrder } from './yandexFinanceApi';
import { mpTransactionsDb, MpTransaction, TxKind } from './mpTransactionsDb';
import { YandexStore } from '@/types/yandex';

export interface SyncProgress {
  storeName: string;
  storeId: string;
  loaded: number;
  total: number;
  done: boolean;
  error?: string;
}

// ── Классификация типа транзакции при синхронизации ───────────────────────────
// Руслан code-review: классификация должна происходить ЗДЕСЬ (при синке),
// а не эвристикой в buildAnalytics(). Сохраняем tx_kind в БД.
// AnalyticsModule использует tx_kind из БД как primary signal,
// с fallback на classifyTransactionKind() для старых записей без tx_kind.

function classifyWbTxKind(row: WbFinanceRow): TxKind {
  const opName = (row.supplier_oper_name ?? row.doc_type_name ?? '').toLowerCase();
  const rev = Number(row.retail_amount) || 0;
  if (opName.includes('возврат') || opName.includes('невыкуп')) return 'return';
  if (opName.includes('хранен') || opName.includes('storage'))  return 'storage';
  if (opName.includes('штраф') || opName.includes('компенс'))   return 'penalty';
  if (opName.includes('реклам') || opName.includes('продвиж'))  return 'advertising';
  if (opName.includes('эквайр') || opName.includes('acquiring')) return 'service';
  if (rev > 0 || opName.includes('продаж') || opName.includes('sale')) return 'sale';
  if (rev < 0) return 'return';
  return 'service';
}

function classifyOzonTxKind(op: OzonTransaction): TxKind {
  const code = op.operation_type ?? '';
  const lower = code.toLowerCase();
  const rev = Number(op.accruals_for_sale) || 0;

  // ПРОДАЖИ
  if (code === 'RegularSale' || code === 'DepositToSeller'
      || code === 'OperationAgentDeliveredToCustomer'
      || code === 'OperationTransactionPayment' || code === 'Sale' || code === 'ExchangeSale') {
    return 'sale';
  }
  // ВОЗВРАТЫ покупателя
  if (code === 'ReturnAgentOperation' || code === 'ClientReturnAgentOperation'
      || code === 'OperationItemReturn' || code === 'OperationItemReturnDO'
      || code === 'ExchangeReturn' || code === 'OperationClaim'
      || code === 'OperationItemReturnExpired' || code === 'OperationReturnGoodsFBSofRMS') {
    return 'return';
  }
  // ОТМЕНЫ до доставки → 'cancel' (НЕ возврат: товар не дошёл до покупателя)
  // OperationReturnGoodsFBSofRMS — специфика FBS RMS, товар возвращён → return
  if (lower.includes('cancel')) return 'cancel';
  // СЕРВИСНЫЕ ОПЕРАЦИИ ВОЗВРАТА (НЕ возврат заказа — это расход на логистику возврата)
  if (code === 'ReturnNotDelivery' || code === 'ReturnNotDeliveryDO'
      || code === 'ReturnAgentDelivery' || code === 'ClientReturnDelivery'
      || code === 'ReturnScrapDisposal' || code === 'SellerReturnsDeliveryToPickupPoint'
      || code === 'OperationSellerReturnsCargoAssortmentValid'
      || code === 'OperationSellerReturnsCargoAssortmentInvalid'
      || code === 'MarketplaceSellerReexposureDeliveryReturnOperation') {
    return 'return_svc';
  }
  // РЕКЛАМА
  if (lower.includes('marketing') || lower.includes('costperclick')
      || lower.includes('promotion') || code === 'OperationGettingToTheTop'
      || code === 'CustomerReviews' || code === 'OperationMarketPlaceItemPinReview'
      || code === 'MarketplaceServiceBrandCommission' || code === 'OperationElectronicServiceStencil') {
    return 'advertising';
  }
  // ХРАНЕНИЕ
  if (lower.includes('storage') || lower.includes('temporarystorage')) return 'storage';
  // ШТРАФЫ
  if (lower.includes('penalty') || lower.includes('fine')) return 'penalty';
  // FALLBACK по знаку выручки
  if (rev > 0) return 'sale';
  if (rev < 0) return 'return';
  return 'service';
}

function classifyYmTxKind(status: string): TxKind {
  switch (status.toUpperCase()) {
    case 'DELIVERED': case 'PICKUP': return 'sale';
    case 'RETURNED': case 'PARTIALLY_RETURNED': return 'return';
    case 'CANCELLED_IN_DELIVERY': return 'return'; // отменено после отгрузки → физический возврат
    default:
      // Прочие CANCEL* — отмена ДО доставки → 'cancel' (не возврат)
      return status.toUpperCase().startsWith('CANCEL') ? 'cancel' : 'service';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function wbRowToTransaction(row: WbFinanceRow, storeId: string): MpTransaction {
  const commission = Number(row.ppvz_sales_commission) || 0;
  const logistics  = Number(row.delivery_rub) || 0;
  const revenue    = Number(row.retail_amount) || 0;
  const seller     = Number(row.ppvz_for_pay) || 0;
  const date = row.rr_dt ?? row.sale_dt ?? row.order_dt ?? new Date().toISOString();
  return {
    store_id: storeId,
    marketplace: 'wb',
    mp_transaction_id: String(row.rrd_id),
    operation_type: row.supplier_oper_name ?? row.doc_type_name ?? null,
    operation_type_name: row.supplier_oper_name ?? row.doc_type_name ?? null,
    operation_date: new Date(date).toISOString(),
    posting_number: row.srid ? String(row.srid) : null,
    items_json: row.nm_id ? [{ name: row.ts_name ?? row.subject_name ?? '', sku: row.nm_id, vendor_code: row.sa_name ?? undefined, quantity: row.quantity ?? 1 }] : null,
    accruals_for_sale: revenue,
    sale_commission: -Math.abs(commission),
    delivery_charge: -Math.abs(logistics),
    return_delivery_charge: 0,
    services_total: Math.abs(Number(row.storage_fee) || 0) + Math.max(0, -(Number(row.ppvz_inflicted_for_supplier) || 0)),
    amount: seller,
    // Классифицируем тип операции при синке — не эвристикой в UI
    tx_kind: classifyWbTxKind(row),
    raw_json: row,
  };
}

function ymOrderToTransactions(order: YmStatsOrder, storeId: string): MpTransaction[] {
  const txs: MpTransaction[] = [];
  const date = order.creationDate ?? order.statusUpdateDate ?? new Date().toISOString();
  const orderCommissions = order.commissions ?? [];
  const items = order.items ?? [];
  const status = order.status ?? '';

  let revenue = 0;
  let commission = 0;
  let delivery = 0;
  let services = 0;

  // НОРМАЛИЗОВАННАЯ выручка — gross_revenue покупателя из BUYER-цены.
  // Руслан: accruals_for_sale должен хранить единый нормализованный gross_revenue,
  // не зависеть от того какой МП прислал данные. После этого buildAnalytics()
  // не нужно пересчитывать из raw_json — данные уже корректны в БД.
  //
  // BUYER.total — итог за ВСЕ единицы позиции (НЕ умножать на count).
  // BUYER.costPerItem / priceForCustomer — цена за единицу (умножать на count).
  for (const it of items) {
    const count = it.count ?? 1;
    const buyerPrice = (it.prices ?? []).find((p: any) => p.type === 'BUYER');
    if (buyerPrice?.total && buyerPrice.total > 0) {
      revenue += buyerPrice.total;
    } else if (buyerPrice?.costPerItem && buyerPrice.costPerItem > 0) {
      revenue += buyerPrice.costPerItem * count;
    } else if (it.priceForCustomer) {
      revenue += it.priceForCustomer * count;
    }
  }

  // Комиссии: используем item-level ИЛИ order-level, но не оба сразу.
  // Order-level обычно агрегирует item-level (суммируем только один уровень).
  const hasItemCommissions = items.some(it => (it.commissions?.length ?? 0) > 0);

  // ИСПРАВЛЕНО: субсидии ЯМ (FEE/AGENCY с отрицательным actual) уменьшают комиссию,
  // а не игнорируются. Для delivery/other отрицательные значения по-прежнему пропускаем.
  const applyCommission = (c: any) => {
    const v = Number(c.actual) || 0;
    if (v === 0) return;
    const t: string = (c.type ?? '').toUpperCase();
    if (t === 'FEE' || t === 'AGENCY') {
      commission = Math.max(0, commission + v); // субсидия (отриц.) снижает комиссию, но не уходит в минус
    } else if (t === 'DELIVERY' || t === 'FULFILLMENT' || t === 'DELIVERY_TO_CUSTOMER') {
      if (v > 0) delivery += v;
    } else if (t === 'PAYMENT_TRANSFER') {
      if (v > 0) services += v;
    } else {
      if (v > 0) services += v;
    }
  };

  if (hasItemCommissions) {
    for (const it of items) {
      for (const c of (it.commissions ?? [])) applyCommission(c);
    }
  } else {
    for (const c of orderCommissions) applyCommission(c);
  }

  // Выплата: выручка - все комиссии
  const payout = revenue - commission - delivery - services;

  // Для возвратов и отменённых после отгрузки: accruals_for_sale хранится как ОТРИЦАТЕЛЬНОЕ число.
  // Это согласуется с конвенцией Ozon/WB: отрицательные accruals = возвращённые деньги покупателю.
  // buildAnalytics() использует знак accruals_for_sale для определения: продажа или возврат.
  const isReturnStatus = status === 'RETURNED' || status === 'PARTIALLY_RETURNED' || status === 'CANCELLED_IN_DELIVERY';
  const signedRevenue = isReturnStatus ? -Math.abs(revenue) : revenue;

  txs.push({
    store_id: storeId,
    marketplace: 'yandex',
    mp_transaction_id: `ym-${order.id}`,
    operation_type: status || null,
    operation_type_name: status || null,
    operation_date: new Date(date).toISOString(),
    posting_number: String(order.id),
    items_json: items.map(it => ({
      name: it.offerName ?? it.name ?? '',
      sku: it.shopSku ?? it.offerId ?? '',
      quantity: it.count ?? 1,
    })),
    // НОРМАЛИЗОВАННЫЕ поля — gross_revenue сохранён в accruals_for_sale (Руслан #2)
    // Знак: продажа → положительный; возврат → отрицательный (как в Ozon/WB).
    accruals_for_sale: signedRevenue,
    sale_commission: -Math.abs(commission),
    delivery_charge: -Math.abs(delivery),
    return_delivery_charge: 0,
    services_total: Math.abs(services),
    amount: payout,
    // tx_kind определён при синке (Руслан #3) — НЕ эвристика в buildAnalytics()
    tx_kind: classifyYmTxKind(status),
    raw_json: order,
  });

  return txs;
}

function ozonOpToTransaction(op: OzonTransaction, storeId: string): MpTransaction {
  const servicesTotal = (op.services ?? []).reduce((s, x) => s + Math.abs(Number(x.price) || 0), 0);
  return {
    store_id: storeId,
    marketplace: 'ozon',
    mp_transaction_id: String(op.operation_id),
    operation_type: op.operation_type ?? null,
    operation_type_name: op.operation_type_name ?? null,
    operation_date: op.operation_date,
    posting_number: op.posting?.posting_number ?? null,
    items_json: op.items ?? null,
    accruals_for_sale: Number(op.accruals_for_sale) || 0,
    sale_commission: Number(op.sale_commission) || 0,
    delivery_charge: Number(op.delivery_charge) || 0,
    return_delivery_charge: Number(op.return_delivery_charge) || 0,
    services_total: servicesTotal,
    amount: Number(op.amount) || 0,
    // tx_kind определён при синке (Руслан #3) — НЕ хрупкая эвристика в buildAnalytics()
    tx_kind: classifyOzonTxKind(op),
    raw_json: op,
  };
}

export const financeSync = {
  /**
   * Синхронизировать финансовые транзакции Ozon за период для всех магазинов.
   * dateFrom/dateTo — ISO 8601 строки.
   * Ozon Finance API ограничивает диапазон 90 днями — автоматически бьём на чанки.
   */
  async syncOzon(
    dateFrom: string,
    dateTo: string,
    onProgress?: (p: SyncProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ total: number; perStore: Record<string, number> }> {
    const stores = await ozonDb.getStores();
    const result: Record<string, number> = {};
    let total = 0;

    // Ozon /v3/finance/transaction/list принимает не более 1 месяца за запрос.
    // Превышение лимита → HTTP 400 "too long period, only one month allowed".
    // Разбиваем на чанки по 28 дней — гарантированно меньше любого календарного месяца.
    const CHUNK_MS = 28 * 24 * 3600 * 1000;
    const periodStart = new Date(dateFrom);
    const periodEnd   = new Date(dateTo);
    const chunks: Array<{ from: string; to: string }> = [];
    let cs = periodStart;
    while (cs < periodEnd) {
      const ce = new Date(Math.min(cs.getTime() + CHUNK_MS, periodEnd.getTime()));
      chunks.push({ from: cs.toISOString(), to: ce.toISOString() });
      cs = new Date(ce.getTime() + 1);
    }

    for (const store of stores) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: 0, total: 0, done: false });
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const allOps: OzonTransaction[] = [];
        for (const { from, to } of chunks) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const ops = await ozonFinanceApi.fetchTransactions(
            creds, from, to,
            (loaded) => onProgress?.({
              storeName: store.name, storeId: store.id,
              loaded: allOps.length + loaded, total: 0, done: false,
            }),
            signal,
          );
          allOps.push(...ops);
        }
        // Дедупликация по operation_id — Ozon может вернуть одну операцию
        // в двух соседних чанках (граница 28 дней совпадает с датой операции).
        const seenOps = new Set<string>();
        const uniqueOps = allOps.filter(op => {
          const key = String(op.operation_id);
          if (seenOps.has(key)) return false;
          seenOps.add(key);
          return true;
        });
        if (uniqueOps.length < allOps.length) {
          console.warn(`[Ozon Sync] ${store.name}: дедуплицировано ${allOps.length - uniqueOps.length} операций из ${allOps.length}`);
        }
        const txs = uniqueOps.map(op => ozonOpToTransaction(op, store.id));
        await mpTransactionsDb.upsertBatch(txs);
        result[store.id] = txs.length;
        total += txs.length;
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: txs.length, total: txs.length, done: true });
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        const errMsg = (e instanceof Error ? e.message : String(e)) ?? String(e);
        console.error(`[Ozon Sync] ${store.name}: ${errMsg}`);
        // Диагностика: частые причины ошибок Ozon Finance API
        if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
          console.error('[Ozon Sync] Причина: неверный Client-Id или Api-Key, либо ключ не имеет доступа к Finance API. Создайте новый ключ с разрешением "Финансы".');
        } else if (errMsg.includes('403')) {
          console.error('[Ozon Sync] Причина: API ключ не имеет прав на финансовые операции. Проверьте разрешения ключа в ЛК Ozon.');
        } else if (errMsg.includes('400')) {
          console.error('[Ozon Sync] Причина: неверный формат запроса (возможно, неверный диапазон дат или формат client_id).');
        }
        result[store.id] = 0;
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: 0, total: 0, done: true, error: errMsg });
      }
    }

    return { total, perStore: result };
  },

  /**
   * Синхронизировать WB отчёт детализации за период.
   * dateFrom/dateTo формат: 'YYYY-MM-DD'.
   */
  async syncWb(
    dateFrom: string,
    dateTo: string,
    onProgress?: (p: SyncProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ total: number; perStore: Record<string, number> }> {
    const stores = await wbDb.getStores();
    const result: Record<string, number> = {};
    let total = 0;

    for (const store of stores) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: 0, total: 0, done: false });
        const rows = await wbFinanceApi.fetchReport(
          store.api_key,
          dateFrom,
          dateTo,
          (loaded) => onProgress?.({ storeName: store.name, storeId: store.id, loaded, total: loaded, done: false }),
          signal,
        );
        const txs = rows.map(r => wbRowToTransaction(r, store.id));
        await mpTransactionsDb.upsertBatch(txs);
        result[store.id] = txs.length;
        total += txs.length;
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: txs.length, total: txs.length, done: true });
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        result[store.id] = 0;
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: 0, total: 0, done: true, error: (e instanceof Error ? e.message : String(e)) ?? String(e) });
      }
    }
    return { total, perStore: result };
  },

  /**
   * Синхронизировать Яндекс Маркет stats/orders.
   * dateFrom/dateTo формат: 'YYYY-MM-DD'.
   * preloadedStores — если передан из AnalyticsModule, используем их вместо повторного запроса к БД
   * (обходит проблему когда yandexDb.getStores() возвращает [] из-за контекста company_id).
   */
  async syncYandex(
    dateFrom: string,
    dateTo: string,
    onProgress?: (p: SyncProgress) => void,
    signal?: AbortSignal,
    preloadedStores?: YandexStore[],
  ): Promise<{ total: number; perStore: Record<string, number> }> {
    // Используем переданные магазины, либо запрашиваем заново
    let stores: YandexStore[];
    if (preloadedStores && preloadedStores.length > 0) {
      stores = preloadedStores;
      debug.log(`[YM Sync] используем ${stores.length} магазинов из AnalyticsModule:`, stores.map(s => s.name));
    } else {
      stores = await yandexDb.getStores();
      debug.log(`[YM Sync] найдено магазинов через yandexDb: ${stores.length}`, stores.map(s => s.name));
    }
    if (stores.length === 0) {
      console.warn('[YM Sync] ⚠ Нет подключённых магазинов Яндекс Маркет — синхронизация пропущена.');
      // Показываем пользователю что ЯМ не синхронизируется
      onProgress?.({ storeName: 'Яндекс Маркет', storeId: 'ym-none', loaded: 0, total: 0, done: true,
        error: 'Магазины ЯМ не найдены. Откройте аналитику (загрузите страницу) и повторите синхронизацию.' });
    }
    const result: Record<string, number> = {};
    let total = 0;

    for (const store of stores) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: 0, total: 0, done: false });
        const orders = await yandexFinanceApi.fetchOrderStats(
          store,
          dateFrom,
          dateTo,
          (loaded) => onProgress?.({ storeName: store.name, storeId: store.id, loaded, total: loaded, done: false }),
          signal,
        );
        const txs = orders.flatMap(o => ymOrderToTransactions(o, store.id));

        // Диагностика: проверяем сколько заказов получили данные о комиссиях
        const withCommission = txs.filter(t => Math.abs(t.sale_commission || 0) > 0).length;
        const withDelivery   = txs.filter(t => Math.abs(t.delivery_charge || 0) > 0).length;
        const noCommission   = txs.length - withCommission;
        debug.log(
          `[YM Sync] ${store.name}: ${txs.length} заказов, ` +
          `с комиссией: ${withCommission}, без комиссии: ${noCommission}, ` +
          `с логистикой: ${withDelivery}`,
        );
        if (noCommission > 0 && txs.length > 0) {
          const pct = Math.round(noCommission / txs.length * 100);
          console.warn(
            `[YM Sync] ⚠ ${pct}% заказов ЯМ без комиссии. ` +
            `Возможные причины: заказы ещё не завершены (нет статуса DELIVERED), ` +
            `или stats/orders API не вернул данные по комиссиям. ` +
            `Прибыль по этим заказам будет завышена.`,
          );
        }

        await mpTransactionsDb.upsertBatch(txs);
        result[store.id] = txs.length;
        total += txs.length;
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: txs.length, total: txs.length, done: true });
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        result[store.id] = 0;
        onProgress?.({ storeName: store.name, storeId: store.id, loaded: 0, total: 0, done: true, error: (e instanceof Error ? e.message : String(e)) ?? String(e) });
      }
    }
    return { total, perStore: result };
  },

  /**
   * Унифицированный синк по всем трём МП. Параметры — ISO 8601 (datetime).
   * Внутри конвертирует в нужные форматы для каждого API.
   * preloadedYmStores — ЯМ магазины уже загруженные в AnalyticsModule (обходит повторный запрос к БД).
   */
  async syncAll(
    dateFromIso: string,
    dateToIso: string,
    onProgress?: (p: SyncProgress) => void,
    signal?: AbortSignal,
    preloadedYmStores?: YandexStore[],
  ): Promise<{ total: number }> {
    // YYYY-MM-DD для WB / YM
    const ymd = (iso: string) => new Date(iso).toISOString().slice(0, 10);
    const dFromYmd = ymd(dateFromIso);
    const dToYmd = ymd(dateToIso);

    let total = 0;
    const [oz, wb, ym] = await Promise.allSettled([
      this.syncOzon(dateFromIso, dateToIso, onProgress, signal),
      this.syncWb(dFromYmd, dToYmd, onProgress, signal),
      this.syncYandex(dFromYmd, dToYmd, onProgress, signal, preloadedYmStores),
    ]);
    if (oz.status === 'fulfilled') total += oz.value.total;
    else console.error('[syncAll] Ozon упал с исключением:', oz.reason);
    if (wb.status === 'fulfilled') total += wb.value.total;
    else console.error('[syncAll] WB упал с исключением:', wb.reason);
    if (ym.status === 'fulfilled') total += ym.value.total;
    else {
      console.error('[syncAll] ЯМ упал с исключением:', ym.reason);
      // Показываем ошибку пользователю через onProgress с фиктивным магазином
      onProgress?.({ storeName: 'Яндекс Маркет', storeId: 'ym-global', loaded: 0, total: 0, done: true,
        error: `Критическая ошибка ЯМ: ${(ym.reason as any)?.message ?? String(ym.reason)}` });
    }
    return { total };
  },
};
