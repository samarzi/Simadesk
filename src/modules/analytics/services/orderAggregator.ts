/**
 * orderAggregator — pure functions: формирует единый список Order из:
 *   - live-заказов трёх МП (Ozon postings, Yandex orders, WB orders)
 *   - финансовых транзакций mp_transactions
 *   - карты товаров (vendor_code → name/image)
 *   - resolverа себестоимости
 *   - настроек (налог per-store)
 *
 * Источник истины по финансам: транзакции из финотчёта МП.
 * Live-заказ нужен для статуса «в обработке / в доставке» когда финотчёта ещё нет.
 */

import { MpTransaction } from '@/services/mpTransactionsDb';
import { OzonPosting } from '@/types/ozon';
import { YandexOrder } from '@/types/yandex';
import { WbOrder } from '@/types/wb';
import {
  Order, OrderItem, OrderStatus, FeeBreakdown, Mp, SourceQuality, StoreInfo,
} from '../types';
import { CogsResolver } from './cogsResolver';
import { calcTax } from './taxCalculator';
import { settingsDb } from './settingsDb';

export interface ProductInfo {
  name: string;
  image?: string;
  vendor_code: string;
  mp_sku?: string;
}

/** Карта артикул→инфа товара. Ключи: `${mp}|${vendor_code}` и `${mp}|sku:${mp_sku}`. */
export type ProductMap = Map<string, ProductInfo>;

export interface AggregateInput {
  ozonPostings: OzonPosting[];
  yandexOrders: YandexOrder[];
  wbOrders: WbOrder[];
  transactions: MpTransaction[];
  stores: StoreInfo[];
  products: ProductMap;
  cogs: CogsResolver;
}

// ── Status mapping ──────────────────────────────────────────────────────────

function mapOzonStatus(s: string): OrderStatus {
  switch (s) {
    case 'awaiting_packaging':
    case 'awaiting_deliver':
    case 'sent_by_seller':
    case 'arbitration':
      return 'processing';
    case 'delivering':            return 'in_delivery';
    case 'delivered':             return 'delivered';
    case 'cancelled':
    case 'not_accepted':          return 'cancelled';
    default:                      return 'unknown';
  }
}

function mapYandexStatus(s: string): OrderStatus {
  switch (s) {
    case 'PROCESSING':
    case 'RESERVED':
    case 'UNPAID':                return 'processing';
    case 'DELIVERY':
    case 'PICKUP':                return 'in_delivery';
    case 'DELIVERED':
    case 'PARTIALLY_DELIVERED':   return 'delivered';
    case 'CANCELLED':             return 'cancelled';
    case 'RETURNED':
    case 'PARTIALLY_RETURNED':    return 'returned';
    default:                      return 'unknown';
  }
}

function mapWbStatus(s: string): OrderStatus {
  switch (s) {
    case 'new':         return 'processing';
    case 'confirm':     return 'processing';
    case 'complete':    return 'delivered';
    case 'cancel':      return 'cancelled';
    case 'arbitration': return 'processing';
    default:            return 'unknown';
  }
}

// ── Tx classification ───────────────────────────────────────────────────────

function isReturnTx(tx: MpTransaction): boolean {
  const k = tx.tx_kind;
  if (k === 'return' || k === 'return_svc') return true;
  const opCode = (tx.operation_type ?? '').toLowerCase();
  const opName = (tx.operation_type_name ?? '').toLowerCase();
  return opCode.includes('return') || opName.includes('возврат') || opName.includes('невыкуп');
}
function isCancelTx(tx: MpTransaction): boolean {
  if (tx.tx_kind === 'cancel') return true;
  const op = (tx.operation_type ?? '').toLowerCase();
  return op.includes('cancel');
}

/** Нетто-расход по услугам МП за одну транзакцию.
 *
 *  Почему не `Math.abs(services_total)`: у Ozon поле `services[]` содержит и удержания
 *  (price < 0), и компенсации/возвраты услуг (price > 0). financeSync складывает их
 *  через Math.abs(), из-за чего компенсация попадала в расходы вторым удержанием и
 *  завышала «Расходы». Если raw_json с разбивкой есть — считаем со знаком по нему,
 *  иначе падаем на агрегат (WB/ЯМ пишут туда уже нормализованный положительный расход).
 */
function servicesExpenseOf(tx: MpTransaction): number {
  const raw = (tx.raw_json as any)?.services;
  if (Array.isArray(raw) && raw.length) {
    // price < 0 = удержание → расход положительный
    return raw.reduce((sum: number, s: any) => sum - (Number(s?.price) || 0), 0);
  }
  const svc = tx.services_total || 0;
  return svc < 0 ? -svc : svc;
}

// ── Fee breakdown из raw_json (где МП раскрывает) ───────────────────────────

function buildFeeBreakdown(txs: MpTransaction[]): FeeBreakdown[] {
  // Накапливаем СО ЗНАКОМ — отрицательные значения в БД = удержание у продавца.
  // Инвертируем при отображении: расход показываем как положительное число.
  // Если в итоге значение отрицательное (компенсаций > удержаний) — это «возврат продавцу».
  const acc = new Map<string, FeeBreakdown>();
  const add = (type: FeeBreakdown['type'], label: string, amount: number) => {
    if (!amount) return;
    const cur = acc.get(type) ?? { type, label, amount: 0 };
    cur.amount += amount;
    acc.set(type, cur);
  };

  for (const tx of txs) {
    add('commission', 'Комиссия', -(tx.sale_commission || 0));
    add('logistics',  'Логистика', -(tx.delivery_charge || 0));
    add('logistics_return', 'Возврат логистики', -(tx.return_delivery_charge || 0));

    // Разбивка услуг — если МП прислал детализацию
    const services = (tx.raw_json as any)?.services as Array<{ name: string; price: number }> | undefined;
    if (Array.isArray(services)) {
      for (const s of services) {
        const raw = s.price || 0;
        if (!raw) continue;
        // У услуг знак тоже инвертируем: отрицательное в API = удержание
        const amt = -raw;
        const n = (s.name || '').toLowerCase();
        if (n.includes('хран') || n.includes('storage')) add('storage', 'Хранение', amt);
        else if (n.includes('рекл') || n.includes('продвиж') || n.includes('promo') || n.includes('advert')) add('advertising', 'Реклама/продвижение', amt);
        else if (n.includes('штраф') || n.includes('penalty') || n.includes('компенсац')) add('penalty', 'Штрафы и удержания', amt);
        else if (n.includes('эквайр') || n.includes('acquir')) add('acquiring', 'Эквайринг', amt);
        else add('service', s.name || 'Сервис МП', amt);
      }
    } else if (tx.services_total) {
      // Если детализации нет — используем агрегат (WB/ЯМ пишут уже положительный расход)
      add('other', 'Прочие услуги МП', servicesExpenseOf(tx));
    }
  }

  // Удаляем нулевые и сортируем по абсолютной величине (большие удержания сверху)
  return [...acc.values()]
    .filter(f => Math.abs(f.amount) > 0.01)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

// ── Билдер позиций заказа ───────────────────────────────────────────────────

function buildItems(
  mp: Mp,
  items: Array<{ vendor_code: string; mp_sku?: string; name: string; quantity: number; price: number }>,
  products: ProductMap,
  cogs: CogsResolver,
): OrderItem[] {
  return items.map(it => {
    const revenue = it.price * it.quantity;
    // Lookup в products: сначала по vendor_code, затем по mp_sku (Ozon/WB шлют числовой SKU в транзакциях).
    const info = products.get(`${mp}|${it.vendor_code}`)
              ?? (it.mp_sku ? products.get(`${mp}|sku:${it.mp_sku}`) : undefined);
    // Если в исходных данных vendor_code был числовым SKU — резолвим на реальный артикул продавца
    // из карты products. Это даёт корректное отображение И верный лукап себестоимости.
    const resolvedVc = info?.vendor_code ?? it.vendor_code;
    const cost  = cogs.get(resolvedVc, it.mp_sku);
    const cogsAmt = cost != null ? cost * it.quantity : 0;
    return {
      vendor_code: resolvedVc,
      mp_sku: it.mp_sku ?? '',
      name: info?.name ?? it.name ?? resolvedVc,
      image: info?.image,
      quantity: it.quantity,
      price: it.price,
      revenue,
      cost_price: cost,
      cogs: cogsAmt,
      net_profit: 0, // заполним после распределения общих расходов
    } satisfies OrderItem;
  });
}

// ── Главная сборка ──────────────────────────────────────────────────────────

export function aggregateOrders(input: AggregateInput): Order[] {
  const { ozonPostings, yandexOrders, wbOrders, transactions, stores, products, cogs } = input;

  const storeMap = new Map(stores.map(s => [s.id, s]));
  const txByOrder = groupTxByOrder(transactions);

  const orders: Order[] = [];

  // ── Ozon ──
  for (const p of ozonPostings) {
    const store = storeMap.get(p.store_id);
    if (!store) continue;
    const orderId = p.posting_number;
    const items = buildItems('ozon',
      p.products.map(pr => ({
        vendor_code: pr.offer_id,
        name: pr.name,
        quantity: pr.quantity,
        price: parseFloat(pr.price) || 0,
      })), products, cogs);
    const status = mapOzonStatus(p.status);
    orders.push(makeOrder({
      orderId, mp: 'ozon', store, date: p.created_at || p.in_process_at || '',
      status, status_raw: p.status, items,
      txs: txByOrder.get(orderId) ?? [],
    }));
  }

  // ── Yandex ──
  for (const o of yandexOrders) {
    const store = storeMap.get(o.store_id);
    if (!store) continue;
    const orderId = String(o.id);
    const items = buildItems('yandex',
      o.items.map(it => ({
        vendor_code: it.offer_id,
        name: it.name,
        quantity: it.count,
        price: it.price,
      })), products, cogs);
    orders.push(makeOrder({
      orderId, mp: 'yandex', store, date: o.creation_date,
      status: mapYandexStatus(o.status), status_raw: o.status, items,
      txs: txByOrder.get(orderId) ?? [],
    }));
  }

  // ── WB ──
  for (const o of wbOrders) {
    const store = storeMap.get(o.store_id);
    if (!store) continue;
    const orderId = o.srid ?? String(o.id);
    const items = buildItems('wb',
      o.items.map(it => ({
        vendor_code: it.vendor_code,
        mp_sku: String(it.nm_id),
        name: it.name,
        quantity: it.count,
        price: it.price,
      })), products, cogs);
    orders.push(makeOrder({
      orderId, mp: 'wb', store, date: o.created_at,
      status: mapWbStatus(o.status), status_raw: o.status, items,
      txs: txByOrder.get(orderId) ?? [],
    }));
  }

  // ── Orphan-транзакции: posting в БД есть, а заказа не дотянуло (период не совпал
  //    или live-API не вернул). Создаём заказ-«скелет» чтобы расходы не пропали. ──
  const seen = new Set(orders.map(o => o.order_id));
  const byOrphan = new Map<string, MpTransaction[]>();
  for (const tx of transactions) {
    if (!tx.posting_number || seen.has(tx.posting_number)) continue;
    const list = byOrphan.get(tx.posting_number) ?? [];
    list.push(tx);
    byOrphan.set(tx.posting_number, list);
  }
  for (const [orderId, txs] of byOrphan) {
    const tx0 = txs[0];
    const store = storeMap.get(tx0.store_id);
    if (!store) continue;

    // Сервисные операции МП (компенсации, разовые комиссии без posting'а товара):
    // нет items + нет accruals + нет удержаний — НЕ показываем как заказ.
    const hasItems = (tx0.items_json ?? []).length > 0;
    const totalAccruals = txs.reduce((s, t) => s + Math.abs(t.accruals_for_sale || 0), 0);
    const totalFees = txs.reduce((s, t) =>
      s + Math.abs(t.sale_commission || 0) + Math.abs(t.delivery_charge || 0)
        + Math.abs(t.return_delivery_charge || 0) + Math.abs(t.services_total || 0), 0);
    if (!hasItems && totalAccruals === 0 && totalFees === 0) continue;

    // Для orphan-возврата: цена за единицу = abs(accruals) / qty (грубая оценка).
    const totalQty = (tx0.items_json ?? []).reduce((s, it) => s + (it.quantity ?? 1), 0) || 1;
    const pricePerUnit = totalAccruals > 0 ? totalAccruals / totalQty : 0;

    const items = buildItems(store.mp,
      (tx0.items_json ?? []).map(it => ({
        vendor_code: it.vendor_code ?? String(it.sku ?? ''),
        mp_sku: String(it.sku ?? ''),
        name: it.name,
        quantity: it.quantity ?? 1,
        price: pricePerUnit,
      })), products, cogs);
    const isReturn = txs.some(isReturnTx);
    const isCancel = txs.some(isCancelTx);
    orders.push(makeOrder({
      orderId, mp: store.mp, store, date: tx0.operation_date,
      status: isCancel ? 'cancelled' : isReturn ? 'returned' : 'delivered',
      status_raw: tx0.operation_type_name ?? tx0.operation_type ?? '',
      items, txs, is_orphan: true,
    }));
  }

  estimatePendingFinancials(orders, storeMap);

  return orders.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/** Типовые ставки МП — fallback, когда в срезе вообще нет заказов с финотчётом. */
const FALLBACK_RATES: Record<Mp, { commission: number; logistics: number; services: number }> = {
  ozon:   { commission: 0.16, logistics: 0.07, services: 0.01 },
  wb:     { commission: 0.19, logistics: 0.08, services: 0.01 },
  yandex: { commission: 0.13, logistics: 0.06, services: 0.01 },
};

/**
 * Дозаполняет удержания у заказов без финотчёта (pending_settlement).
 *
 * Зачем: раньше такие заказы просто выбрасывались из всех денежных расчётов
 * (`if (o.pending_settlement) continue`), при этом продолжая считаться в
 * «Заказов доставлено». Получалась картина вида «94 доставлено, выручка 121 тыс»,
 * где выручка покрывала лишь 40% этих заказов, график был из одного пика,
 * а Топ-товаров пустовал. Теперь по ним считаются оценочные удержания
 * по фактическим ставкам этого же среза, а флаг fees_estimated позволяет
 * честно показать долю оценки в интерфейсе.
 */
function estimatePendingFinancials(orders: Order[], storeMap: Map<string, StoreInfo>): void {
  // Фактические ставки по каждому МП — из заказов, где финотчёт уже есть.
  const acc = new Map<Mp, { revenue: number; commission: number; logistics: number; services: number }>();
  for (const o of orders) {
    if (o.pending_settlement || o.revenue <= 0) continue;
    const cur = acc.get(o.mp) ?? { revenue: 0, commission: 0, logistics: 0, services: 0 };
    cur.revenue    += o.revenue;
    cur.commission += o.commission;
    cur.logistics  += o.logistics + o.logistics_return;
    cur.services   += o.services;
    acc.set(o.mp, cur);
  }

  const rateFor = (mp: Mp) => {
    const a = acc.get(mp);
    const fb = FALLBACK_RATES[mp];
    // Требуем осмысленную базу — на паре заказов ставка шумит сильнее, чем типовая.
    if (!a || a.revenue < 1000) return fb;
    const clamp = (v: number, max: number) => (isFinite(v) && v > 0 ? Math.min(v, max) : 0);
    return {
      commission: clamp(a.commission / a.revenue, 0.5) || fb.commission,
      logistics:  clamp(a.logistics  / a.revenue, 0.5),
      services:   clamp(a.services   / a.revenue, 0.3),
    };
  };

  for (const o of orders) {
    if (!o.pending_settlement) continue;
    if (o.status === 'cancelled' || o.status === 'returned') continue;
    if (o.revenue <= 0) continue;

    const r = rateFor(o.mp);
    o.commission = o.revenue * r.commission;
    o.logistics  = o.revenue * r.logistics;
    o.services   = o.revenue * r.services;
    o.fees_estimated = true;
    o.source = 'estimated';

    const store = storeMap.get(o.store_id);
    const taxOv = store ? settingsDb.taxFor(store.id) : { model: 'none' as const, rate: 0 };
    o.tax = calcTax(o.revenue, o.commission + o.logistics + o.logistics_return + o.services + o.cogs, taxOv.model, taxOv.rate);

    const totalExpenses = o.commission + o.logistics + o.logistics_return + o.services + o.cogs + o.tax;
    o.net_profit = o.revenue - totalExpenses;

    const denom = o.items.reduce((s, it) => s + Math.max(0, it.revenue), 0);
    for (const it of o.items) {
      const share = denom > 0 ? it.revenue / denom : 1 / Math.max(1, o.items.length);
      it.net_profit = it.revenue - ((totalExpenses - o.cogs) * share + it.cogs);
    }
  }
}

function groupTxByOrder(transactions: MpTransaction[]): Map<string, MpTransaction[]> {
  const map = new Map<string, MpTransaction[]>();
  for (const tx of transactions) {
    if (!tx.posting_number) continue;
    const list = map.get(tx.posting_number) ?? [];
    list.push(tx);
    map.set(tx.posting_number, list);
  }
  return map;
}

interface MakeOrderInput {
  orderId: string;
  mp: Mp;
  store: StoreInfo;
  date: string;
  status: OrderStatus;
  status_raw: string;
  items: OrderItem[];
  txs: MpTransaction[];
  is_orphan?: boolean;
}

function makeOrder(p: MakeOrderInput): Order {
  let revenue = p.items.reduce((s, it) => s + it.revenue, 0);
  let commission = 0, logistics = 0, logistics_return = 0, services = 0, payout_actual = 0;
  const fee_breakdown: FeeBreakdown[] = [];

  const hasReal = p.txs.length > 0;
  let source: SourceQuality = hasReal ? 'real' : 'estimated';
  let isReturnByTx = false;
  let isCancelByTx = false;

  if (hasReal) {
    // Ozon/WB/YM хранят удержания с отрицательным знаком (выручка минус для продавца),
    // а корректировки/возвраты комиссии — с положительным (возврат продавцу).
    // Складываем со знаком и инвертируем → получаем «нетто-расход».
    // Это критично для возвратов: исходное удержание -7056 + возврат +6500 = -556 → расход 556,
    // а не двойное удержание 13556 как было раньше с Math.abs().
    for (const tx of p.txs) {
      commission       += -(tx.sale_commission || 0);
      logistics        += -(tx.delivery_charge || 0);
      logistics_return += -(tx.return_delivery_charge || 0);
      services += servicesExpenseOf(tx);
      payout_actual += tx.amount || 0;
    }
    // Защита: если из-за компенсаций сумма ушла в минус (МП вернул больше чем удержал) —
    // это редкий случай, но математически корректно: расход меньше нуля = компенсация.
    // Оставляем как есть, чтобы прибыль отражала реальный нетто-эффект.
    // Если у заказа в транзакциях нет revenue (только возврат-операция) — пересчитываем
    const accrued = p.txs.reduce((s, t) => s + (t.accruals_for_sale || 0), 0);
    if (accrued > 0 && revenue === 0) revenue = accrued;

    isReturnByTx = p.txs.some(isReturnTx);
    isCancelByTx = p.txs.some(isCancelTx);

    fee_breakdown.push(...buildFeeBreakdown(p.txs));
  }

  // Уточнение статуса по факту фин. транзакций (приоритет финотчёта над live-статусом)
  let status = p.status;
  if (isCancelByTx) status = 'cancelled';
  else if (isReturnByTx) status = 'returned';
  else if (hasReal && status !== 'returned' && status !== 'cancelled') status = 'delivered';

  // Cancel / Return: revenue зануляем. Возврат — покупатель вернул товар,
  // значит нет чистой продажи. Себес при этом тоже не списываем (уже в cogsTotal ниже).
  // revenue_lost сохраняет исходную сумму — без неё строка «Возвраты» в P&L всегда 0.
  let revenue_lost = 0;
  if (status === 'cancelled' || status === 'returned') {
    revenue_lost = revenue;
    revenue = 0;
    // Позиции сохраняют исходную выручку — она нужна и для карточки заказа,
    // и для корректного вычитания возврата в разбивке по SKU. Обнуляется только
    // прибыль: заработка по этому заказу нет.
    for (const it of p.items) { it.net_profit = 0; }
  }

  // Если есть реальные транзакции но revenue = 0 — это сервисная/компенсационная операция
  // (хранение, штраф, частичная корректировка), а не настоящая продажа. COGS не списываем.
  const feeOnlyTx = hasReal && revenue === 0;
  const cogsTotal = status === 'returned' || status === 'cancelled' || feeOnlyTx
    ? 0
    : p.items.reduce((s, it) => s + it.cogs, 0);

  // Налог по заказу (используем настройки магазина)
  const taxOv = settingsDb.taxFor(p.store.id);
  const tax = calcTax(revenue, commission + logistics + logistics_return + services + cogsTotal, taxOv.model, taxOv.rate);

  const totalExpenses = commission + logistics + logistics_return + services + cogsTotal + tax;
  const net_profit = revenue - totalExpenses;

  // Распределение комиссии/логистики/налога по позициям пропорционально выручке
  const denom = p.items.reduce((s, it) => s + Math.max(0, it.revenue), 0);
  const shareDenom = denom > 0 ? denom : Math.max(1, p.items.length);
  for (const it of p.items) {
    const share = denom > 0 ? it.revenue / denom : 1 / shareDenom;
    const itemExpenses = (commission + logistics + logistics_return + services + tax) * share + it.cogs;
    it.net_profit = it.revenue - itemExpenses;
  }

  // ВАЖНО: отсутствие себестоимости НЕ делает финотчёт «нереальным».
  // Раньше здесь стоял downgrade source → 'estimated', из-за чего показатель
  // «Финотчёт пришёл по N% заказов» падал до 40-50% на магазинах без заполненных
  // себестоимостей и выдавал ложную тревогу. Пробел в COGS отражает missing_cogs_count.
  const missing_cogs_count = p.items.filter(it => it.cost_price == null && it.quantity > 0).length;

  // Финотчёта по заказу ещё нет вообще — комиссия/логистика неизвестны,
  // а заказ ещё может быть отменён на ПВЗ. Cancel/return уже занулены явно выше.
  const pending_settlement = !hasReal && status !== 'cancelled' && status !== 'returned';

  return {
    order_id: p.orderId,
    date: p.date,
    mp: p.mp,
    store_id: p.store.id,
    store_name: p.store.name,
    status,
    status_raw: p.status_raw,
    items: p.items,
    revenue,
    revenue_lost,
    commission,
    logistics,
    logistics_return,
    services,
    fee_breakdown,
    cogs: cogsTotal,
    tax,
    net_profit,
    payout_actual,
    source,
    missing_cogs_count,
    tx_ids: p.txs.map(t => t.mp_transaction_id),
    pending_settlement,
    is_orphan: p.is_orphan ?? false,
  };
}
