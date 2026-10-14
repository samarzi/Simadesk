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
  PeriodCost, PeriodCostKind, PERIOD_COST_LABEL,
} from '../types';
import { normalizeMpDate } from '@/utils/mpDate';
import { CogsResolver } from './cogsResolver';
import { calcOrderTax, isProfitTaxModel, minTaxRate } from './taxCalculator';
import { settingsDb } from './settingsDb';

export interface ProductInfo {
  name: string;
  image?: string;
  vendor_code: string;
  mp_sku?: string;
}

/** Карта артикул→инфа товара. Ключи: `${mp}|${vendor_code}` и `${mp}|sku:${mp_sku}`. */
export type ProductMap = Map<string, ProductInfo>;

export interface AggregateResult {
  orders: Order[];
  /** Расходы МП, не привязанные к заказу: реклама, хранение, штрафы, подписки. */
  periodCosts: PeriodCost[];
}

export interface AggregateInput {
  ozonPostings: OzonPosting[];
  yandexOrders: YandexOrder[];
  wbOrders: WbOrder[];
  transactions: MpTransaction[];
  stores: StoreInfo[];
  products: ProductMap;
  cogs: CogsResolver;
  /** Диапазон отчёта. Нужен, чтобы расширенный диапазон транзакций не создавал
   * orphan-заказы и расходы за пределами выбранного периода. */
  periodStart?: Date;
  periodEnd?: Date;
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
    case 'complete':    return 'in_delivery';
    case 'cancel':      return 'cancelled';
    case 'arbitration': return 'processing';
    default:            return 'unknown';
  }
}

// ── Tx classification ───────────────────────────────────────────────────────

function isReturnTx(tx: MpTransaction): boolean {
  const k = tx.tx_kind;
  if (k === 'return' || k === 'return_svc') return true;
  if (k) return false;
  const opCode = (tx.operation_type ?? '').toLowerCase();
  const opName = (tx.operation_type_name ?? '').toLowerCase();
  return opCode.includes('return') || opName.includes('возврат') || opName.includes('невыкуп');
}
function isCancelTx(tx: MpTransaction): boolean {
  if (tx.tx_kind === 'cancel') return true;
  if (tx.tx_kind) return false;
  const op = (tx.operation_type ?? '').toLowerCase();
  return op.includes('cancel');
}

/**
 * Транзакция означает, что маркетплейс рассчитался по заказу: продажа, возврат
 * или отмена. Раньше признаком служила любая ненулевая выручка в транзакции —
 * и заказ Яндекс.Маркета «в доставке» (его статистика тоже несёт сумму)
 * становился проданным раньше, чем покупатель его получил.
 */
const SETTLE_KINDS = new Set(['sale', 'return', 'cancel']);
function isSettlementTx(tx: MpTransaction): boolean {
  if (tx.tx_kind) return SETTLE_KINDS.has(tx.tx_kind);
  return Math.abs(tx.accruals_for_sale || 0) > 0.01;
}

/** Нетто-расход по услугам МП за одну транзакцию (price < 0 в API = удержание). */
function servicesExpenseOf(tx: MpTransaction): number {
  const raw = (tx.raw_json as any)?.services;
  if (Array.isArray(raw) && raw.length) {
    return raw.reduce((sum: number, s: any) => sum - (Number(s?.price) || 0), 0);
  }
  const svc = tx.services_total || 0;
  return svc < 0 ? -svc : svc;
}

type FeeKind = FeeBreakdown['type'];

export const FEE_LABEL: Record<FeeKind, string> = {
  commission:       'Комиссия',
  logistics:        'Прямая логистика',
  last_mile:        'Последняя миля',
  logistics_return: 'Обратная логистика',
  storage:          'Хранение',
  advertising:      'Реклама/продвижение',
  penalty:          'Штрафы',
  acquiring:        'Эквайринг',
  service:          'Прочие услуги МП',
  other:            'Прочие удержания',
};

/**
 * Вид услуги по её названию. Ozon присылает коды вида
 * MarketplaceServiceItemDirectFlowLogistic — раньше они не распознавались, и вся
 * логистика Ozon попадала в «Услуги», а строка «Логистика» показывала ноль.
 */
export function classifyServiceName(name: string): FeeKind {
  const n = (name || '').toLowerCase();
  if (n.includes('delivtocustomer') || n.includes('последняя миля') || n.includes('last mile') || n.includes('места выдачи') || n.includes('пункта выдачи')) return 'last_mile';
  if (n.includes('acquiring') || n.includes('эквайр') || n.includes('приём платеж') || n.includes('прием платеж')) return 'acquiring';
  if (n.includes('return') || n.includes('возврат') || n.includes('невыкуп') || n.includes('обратн')) return 'logistics_return';
  if (n.includes('storage') || n.includes('хранен') || n.includes('размещени')) return 'storage';
  if (n.includes('penalty') || n.includes('штраф') || n.includes('defect') || n.includes('нарушен')) return 'penalty';
  if (n.includes('premium') || n.includes('promotion') || n.includes('cashback') || n.includes('points')
    || n.includes('review') || n.includes('stencil') || n.includes('gettingtothetop') || n.includes('marketing')
    || n.includes('рекл') || n.includes('продвиж') || n.includes('отзыв') || n.includes('бонус')
    || n.includes('клик') || n.includes('click') || n.includes('трафарет') || n.includes('буст')) return 'advertising';
  if (n.includes('directflow') || n.includes('dropoff') || n.includes('pickup') || n.includes('fulfillment')
    || n.includes('logistic') || n.includes('trans') || n.includes('deliv') || n.includes('логист')
    || n.includes('доставк') || n.includes('магистрал') || n.includes('сборк') || n.includes('обработк')
    || n.includes('выезд') || n.includes('отправлен')) return 'logistics';
  return 'service';
}

/** Строка отчёта WB — возврат товара: суммы в ней положительные, но смысл обратный. */
function isWbReturnRaw(raw: any): boolean {
  const doc = String(raw?.doc_type_name ?? '').toLowerCase();
  const op  = String(raw?.supplier_oper_name ?? '').toLowerCase();
  return doc === 'возврат' || op === 'возврат';
}

const WB_RAW_FIELDS = ['storage_fee', 'penalty', 'deduction', 'acquiring_fee', 'acceptance', 'ppvz_inflicted_for_supplier'];

/**
 * Расходы по одной транзакции, разложенные по видам. Положительное = расход
 * продавца, отрицательное = компенсация. Сумма по видам — ровно то, что
 * удержал маркетплейс, поэтому «выручка − удержания» сходится с выплатой.
 */
export function txFees(tx: MpTransaction): Partial<Record<FeeKind, number>> {
  const f: Partial<Record<FeeKind, number>> = {};
  const add = (k: FeeKind, v: number) => {
    if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return;
    f[k] = (f[k] ?? 0) + v;
  };
  add('commission', -(tx.sale_commission || 0));
  add('logistics', -(tx.delivery_charge || 0));
  add('logistics_return', -(tx.return_delivery_charge || 0));

  const raw = tx.raw_json as any;
  const services = raw?.services;
  if (tx.marketplace === 'wb' && raw && WB_RAW_FIELDS.some(k => raw[k] != null)) {
    const num = (k: string) => Number(raw[k]) || 0;
    const ret = isWbReturnRaw(raw) ? -1 : 1;
    const bonus = String(raw.bonus_type_name ?? '').toLowerCase();
    add('storage', num('storage_fee'));
    add('penalty', num('penalty'));
    add('acquiring', ret * num('acquiring_fee'));
    add('service', num('acceptance'));
    add(bonus.includes('продвиж') || bonus.includes('реклам') ? 'advertising' : 'other', num('deduction'));
    add('other', num('ppvz_inflicted_for_supplier'));
  } else if (Array.isArray(services) && services.length) {
    for (const s of services) add(classifyServiceName(String(s?.name ?? '')), -(Number(s?.price) || 0));
  } else if (tx.services_total) {
    add('service', servicesExpenseOf(tx));
  }

  // Ozon: всё, что изменило баланс, но не разложено по полям (эквайринг,
  // корректировки), — это разница между итогом операции и её составляющими.
  // Раньше эквайринг Ozon (отдельная операция с номером заказа) терялся.
  if (tx.marketplace === 'ozon' && raw && typeof raw === 'object' && raw.amount != null) {
    const servicesSigned = Array.isArray(services)
      ? services.reduce((s: number, x: any) => s + (Number(x?.price) || 0), 0) : 0;
    const expected = (tx.accruals_for_sale || 0) + (tx.sale_commission || 0)
      + (tx.delivery_charge || 0) + (tx.return_delivery_charge || 0) + servicesSigned;
    const residual = (tx.amount || 0) - expected;
    if (Math.abs(residual) > 0.01) {
      const op = `${tx.operation_type ?? ''} ${tx.operation_type_name ?? ''}`.toLowerCase();
      add(op.includes('acquiring') || op.includes('эквайр') ? 'acquiring' : classifyServiceName(op) === 'service' ? 'other' : classifyServiceName(op), -residual);
    }
  }
  return f;
}

function sumFees(txs: MpTransaction[]): Partial<Record<FeeKind, number>> {
  const acc: Partial<Record<FeeKind, number>> = {};
  for (const tx of txs) {
    for (const [k, v] of Object.entries(txFees(tx)) as Array<[FeeKind, number]>) acc[k] = (acc[k] ?? 0) + v;
  }
  return acc;
}

function feeBreakdownOf(fees: Partial<Record<FeeKind, number>>): FeeBreakdown[] {
  return (Object.entries(fees) as Array<[FeeKind, number]>)
    .filter(([, v]) => Math.abs(v) > 0.01)
    .map(([type, amount]) => ({ type, label: FEE_LABEL[type], amount }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

/** Дата заказа из финотчёта: по ней заказ относится к периоду, как и живые заказы. */
function orderDateOfTx(tx: MpTransaction): string | null {
  const raw = tx.raw_json as any;
  let d: unknown = null;
  if (tx.marketplace === 'ozon') d = raw?.posting?.order_date;
  else if (tx.marketplace === 'wb') d = raw?.order_dt;
  else if (tx.marketplace === 'yandex') d = raw?.creationDate ?? tx.operation_date;
  const iso = typeof d === 'string' && d ? normalizeMpDate(d) : '';
  return iso || null;
}

// ── Билдер позиций заказа ───────────────────────────────────────────────────

function buildItems(
  mp: Mp,
  items: Array<{ vendor_code: string; mp_sku?: string; name: string; quantity: number; price: number }>,
  products: ProductMap,
  cogs: CogsResolver,
  date?: string,
): OrderItem[] {
  return items.map(it => {
    const revenue = it.price * it.quantity;
    // Lookup в products: сначала по vendor_code, затем по mp_sku (Ozon/WB шлют числовой SKU в транзакциях).
    const info = products.get(`${mp}|${it.vendor_code}`)
              ?? (it.mp_sku ? products.get(`${mp}|sku:${it.mp_sku}`) : undefined);
    // Если в исходных данных vendor_code был числовым SKU — резолвим на реальный артикул продавца
    // из карты products. Это даёт корректное отображение И верный лукап себестоимости.
    const resolvedVc = info?.vendor_code ?? it.vendor_code;
    const cost  = cogs.get(resolvedVc, it.mp_sku, date);
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

export function aggregateOrders(input: AggregateInput): AggregateResult {
  const { ozonPostings, yandexOrders, wbOrders, transactions, stores, products, cogs, periodStart, periodEnd } = input;

  const storeMap = new Map(stores.map(s => [s.id, s]));
  const txByOrder = groupTxByOrder(transactions);

  const orders: Order[] = [];

  // ── Ozon ──
  for (const p of ozonPostings) {
    const store = storeMap.get(p.store_id);
    if (!store) continue;
    const orderId = p.posting_number;
    const date = normalizeMpDate(p.created_at || p.in_process_at);
    const items = buildItems('ozon',
      p.products.map(pr => ({
        vendor_code: pr.offer_id,
        name: pr.name,
        quantity: pr.quantity,
        price: parseFloat(pr.price) || 0,
      })), products, cogs, date);
    const status = mapOzonStatus(p.status);
    orders.push(makeOrder({
      orderId, mp: 'ozon', store, date,
      status, status_raw: p.status, items,
      txs: txByOrder.get(makeOrderKey('ozon', store.id, orderId)) ?? [],
    }));
  }

  // ── Yandex ──
  for (const o of yandexOrders) {
    const store = storeMap.get(o.store_id);
    if (!store) continue;
    const orderId = String(o.id);
    const date = normalizeMpDate(o.creation_date);
    const items = buildItems('yandex',
      o.items.map(it => ({
        vendor_code: it.offer_id,
        name: it.name,
        quantity: it.count,
        price: it.price,
      })), products, cogs, date);
    orders.push(makeOrder({
      // Яндекс отдаёт «DD-MM-YYYY HH:mm:ss» по Москве — без нормализации такие
      // заказы выпадали из графика, тепловой карты и сортировались по числу месяца.
      orderId, mp: 'yandex', store, date,
      status: mapYandexStatus(o.status), status_raw: o.status, items,
      txs: txByOrder.get(makeOrderKey('yandex', store.id, orderId)) ?? [],
    }));
  }

  // ── WB ──
  for (const o of wbOrders) {
    const store = storeMap.get(o.store_id);
    if (!store) continue;
    const orderId = o.srid ?? String(o.id);
    const date = normalizeMpDate(o.created_at);
    const items = buildItems('wb',
      o.items.map(it => ({
        vendor_code: it.vendor_code,
        mp_sku: String(it.nm_id),
        name: it.name,
        quantity: it.count,
        price: it.price,
      })), products, cogs, date);
    orders.push(makeOrder({
      orderId, mp: 'wb', store, date,
      status: mapWbStatus(o.status), status_raw: o.status, items,
      txs: txByOrder.get(makeOrderKey('wb', store.id, orderId)) ?? [],
    }));
  }

  // ── Заказы, известные только по финотчёту: живой API их не вернул.
  //    К периоду относим по ДАТЕ ЗАКАЗА из финотчёта, как и живые заказы.
  //    Раньше брали дату операции — и сентябрьский заказ, рассчитанный в
  //    октябре, попадал в выручку и сентября, и октября. ──
  const seen = new Set(orders.map(o => o.order_key ?? makeOrderKey(o.mp, o.store_id, o.order_id)));
  const byOrphan = new Map<string, MpTransaction[]>();
  for (const tx of transactions) {
    if (!tx.posting_number) continue;
    const key = makeOrderKey(tx.marketplace, tx.store_id, tx.posting_number);
    if (seen.has(key)) continue;
    const list = byOrphan.get(key) ?? [];
    list.push(tx);
    byOrphan.set(key, list);
  }
  const inPeriod = (iso: string | null | undefined): boolean => {
    if (!periodStart || !periodEnd) return true;
    const ts = Date.parse(iso ?? '');
    return Number.isFinite(ts) && ts >= periodStart.getTime() && ts <= periodEnd.getTime();
  };
  const feeOnlyTxs: MpTransaction[] = [];
  for (const [, txs] of byOrphan) {
    const tx0 = txs[0];
    const store = storeMap.get(tx0.store_id);
    if (!store) continue;

    const orderDate = txs.map(orderDateOfTx).find(Boolean) ?? null;
    const hasItems = txs.some(t => (t.items_json ?? []).length > 0);
    const totalAccruals = txs.reduce((s, t) => s + Math.max(0, t.accruals_for_sale || 0), 0)
      || txs.reduce((s, t) => s + Math.abs(t.accruals_for_sale || 0), 0);

    // Нет ни товаров, ни выручки — это не заказ, а отдельное удержание
    // (эквайринг, корректировка). Учитываем как расход периода по дате операции.
    if (!hasItems && totalAccruals === 0) {
      if (orderDate ? inPeriod(orderDate) : true) feeOnlyTxs.push(...txs);
      continue;
    }
    if (!inPeriod(orderDate ?? tx0.operation_date)) continue;

    const itemsTx = txs.find(t => (t.items_json ?? []).length > 0) ?? tx0;
    const totalQty = (itemsTx.items_json ?? []).reduce((s, it) => s + (it.quantity ?? 1), 0) || 1;
    const pricePerUnit = totalAccruals > 0 ? totalAccruals / totalQty : 0;

    const items = buildItems(store.mp,
      (itemsTx.items_json ?? []).map(it => ({
        vendor_code: it.vendor_code ?? String(it.sku ?? ''),
        mp_sku: String(it.sku ?? ''),
        name: it.name,
        quantity: it.quantity ?? 1,
        price: pricePerUnit,
      })), products, cogs, orderDate ?? tx0.operation_date);
    orders.push(makeOrder({
      orderId: tx0.posting_number!, mp: store.mp, store,
      date: orderDate ?? normalizeMpDate(tx0.operation_date),
      // Статус уточнит сам финотчёт: продажа / возврат / отмена.
      status: 'in_delivery',
      status_raw: tx0.operation_type_name ?? tx0.operation_type ?? '',
      items, txs, finance_only: true,
    }));
  }

  return {
    orders: orders.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    periodCosts: [
      ...collectPeriodCosts(transactions.filter(t => !t.posting_number), storeMap, periodStart, periodEnd),
      ...collectPeriodCosts(feeOnlyTxs, storeMap, periodStart, periodEnd),
    ],
  };
}

/** Категория расхода периода по типу транзакции и названию операции. */
function classifyPeriodCost(tx: MpTransaction): PeriodCostKind {
  switch (tx.tx_kind) {
    case 'advertising': return 'advertising';
    case 'storage':     return 'storage';
    case 'penalty':     return 'penalty';
    default: break;
  }
  const raw = tx.raw_json as any;
  const n = `${tx.operation_type ?? ''} ${tx.operation_type_name ?? ''} ${raw?.bonus_type_name ?? ''}`.toLowerCase();
  if (n.includes('рекл') || n.includes('продвиж') || n.includes('advert') || n.includes('promot') || n.includes('marketing') || n.includes('costperclick') || n.includes('клик') || n.includes('трафарет')) return 'advertising';
  if (n.includes('хранен') || n.includes('storage')) return 'storage';
  if (n.includes('штраф') || n.includes('penalty') || n.includes('fine')) return 'penalty';
  if (n.includes('эквайр') || n.includes('acquir')) return 'acquiring';
  return 'service';
}

/**
 * Нетто-расход по транзакции без заказа. У Ozon итог операции (amount) —
 * ровно то, на сколько изменился баланс, поэтому берём его. У WB/ЯМ
 * суммируем удержания по полям.
 */
function periodCostAmountOf(tx: MpTransaction): number {
  const raw = tx.raw_json as any;
  if (tx.marketplace === 'ozon' && raw && typeof raw === 'object' && raw.amount != null) {
    return -(tx.amount || 0);
  }
  const fees = Object.values(txFees(tx)).reduce((s, v) => s + (v ?? 0), 0);
  if (Math.abs(fees) > 0.01) return fees - (tx.accruals_for_sale || 0);
  const amount = tx.amount || 0;
  return amount !== 0 ? -amount : 0;
}

/** Расходы, не привязанные к заказу: реклама, хранение, штрафы, подписки, эквайринг. */
function collectPeriodCosts(transactions: MpTransaction[], storeMap: Map<string, StoreInfo>, periodStart?: Date, periodEnd?: Date): PeriodCost[] {
  const out: PeriodCost[] = [];
  for (const tx of transactions) {
    if (periodStart && periodEnd) {
      const ts = Date.parse(tx.operation_date);
      if (!Number.isFinite(ts) || ts < periodStart.getTime() || ts > periodEnd.getTime()) continue;
    }
    // Продажа/выплата без posting не является расходом периода. Иначе amount
    // превращал обычную выплату продавцу в искусственный расход.
    const opText = `${tx.operation_type ?? ''} ${tx.operation_type_name ?? ''}`.toLowerCase();
    if (tx.tx_kind === 'sale' || tx.tx_kind === 'payout' || tx.tx_kind === 'transfer'
      || Math.abs(tx.accruals_for_sale || 0) > 0.01
      || opText.includes('реализац') || opText.includes('продаж') || opText.includes('выплат')) continue;
    const store = storeMap.get(tx.store_id);
    if (!store) continue;
    const amount = periodCostAmountOf(tx);
    if (Math.abs(amount) < 0.01) continue;
    const kind = classifyPeriodCost(tx);
    out.push({
      date: tx.operation_date,
      kind,
      label: tx.operation_type_name || tx.operation_type || PERIOD_COST_LABEL[kind],
      amount,
      store_id: tx.store_id,
      mp: store.mp,
    });
  }
  return out;
}

function groupTxByOrder(transactions: MpTransaction[]): Map<string, MpTransaction[]> {
  const map = new Map<string, MpTransaction[]>();
  for (const tx of transactions) {
    if (!tx.posting_number) continue;
    const key = makeOrderKey(tx.marketplace, tx.store_id, tx.posting_number);
    const list = map.get(key) ?? [];
    list.push(tx);
    map.set(key, list);
  }
  return map;
}

function makeOrderKey(mp: Mp, storeId: string, orderId: string): string {
  return `${mp}:${storeId}:${orderId}`;
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
  finance_only?: boolean;
}

function makeOrder(p: MakeOrderInput): Order {
  let revenue = p.items.reduce((s, it) => s + it.revenue, 0);

  const hasReal = p.txs.length > 0;
  const hasSettlement = p.txs.some(isSettlementTx);
  const source: SourceQuality = hasSettlement ? 'real' : 'estimated';

  // Удержания со знаком: компенсации и возвраты комиссии уменьшают расход.
  const fees = sumFees(p.txs);
  const commission       = fees.commission ?? 0;
  const logistics        = (fees.logistics ?? 0) + (fees.last_mile ?? 0);
  const logistics_return = fees.logistics_return ?? 0;
  const services = (fees.storage ?? 0) + (fees.advertising ?? 0) + (fees.penalty ?? 0)
    + (fees.acquiring ?? 0) + (fees.service ?? 0) + (fees.other ?? 0);
  const payout_actual = p.txs.reduce((s, t) => s + (t.amount || 0), 0);
  const fee_breakdown = feeBreakdownOf(fees);

  const accrPos = p.txs.reduce((s, t) => s + Math.max(0, t.accruals_for_sale || 0), 0);
  const accrNet = p.txs.reduce((s, t) => s + (t.accruals_for_sale || 0), 0);
  if (accrPos > 0 && revenue === 0) revenue = accrPos;

  const isReturnByTx = hasReal && p.txs.some(isReturnTx);
  const isCancelByTx = hasReal && p.txs.some(isCancelTx);

  // Частичный возврат: продажа прошла, покупателю вернули часть денег.
  // Раньше любой возврат обнулял выручку всего заказа.
  const refunded = accrPos - accrNet;
  const partialShare = isReturnByTx && !isCancelByTx && accrPos > 0.01
    && refunded > 0.01 && accrNet > 0.01 * accrPos
    ? Math.min(1, refunded / accrPos) : 0;

  // Уточнение статуса по факту фин. транзакций (приоритет финотчёта над live-статусом)
  let status = p.status;
  if (isCancelByTx) status = 'cancelled';
  else if (isReturnByTx) status = partialShare > 0 ? 'delivered' : 'returned';
  else if (hasSettlement && status !== 'returned' && status !== 'cancelled') status = 'delivered';

  let revenue_lost = 0;
  if (status === 'cancelled' || status === 'returned') {
    revenue_lost = revenue;
    revenue = 0;
    for (const it of p.items) { it.net_profit = 0; }
  } else if (partialShare > 0) {
    revenue_lost = revenue * partialShare;
    revenue -= revenue_lost;
    for (const it of p.items) {
      it.returned_qty = Math.min(it.quantity, Math.round(it.quantity * partialShare));
      it.revenue *= 1 - partialShare;
      it.cogs *= 1 - partialShare;
    }
  }

  // Есть транзакции, но выручки нет — сервисная операция, себестоимость не списываем.
  const feeOnlyTx = hasReal && revenue === 0;
  const cogsTotal = status === 'returned' || status === 'cancelled' || feeOnlyTx
    ? 0
    : p.items.reduce((s, it) => s + it.cogs, 0);

  // Налог: настройка магазина из API, локальная настройка имеет приоритет.
  const taxOv = settingsDb.get().store_tax[p.store.id];
  const model = taxOv?.model ?? p.store.tax_model;
  const rate  = taxOv?.rate  ?? p.store.tax_rate;
  const vatRate = taxOv?.vat_rate ?? p.store.vat_rate ?? 0;
  const mpFees = commission + logistics + logistics_return + services;
  const { tax, vat } = calcOrderTax(revenue, mpFees, model, rate, vatRate);

  const net_profit = revenue - mpFees - cogsTotal - tax;

  // Распределение удержаний и налога по позициям пропорционально выручке
  const denom = p.items.reduce((s, it) => s + Math.max(0, it.revenue), 0);
  for (const it of p.items) {
    const share = denom > 0 ? it.revenue / denom : 1 / Math.max(1, p.items.length);
    it.net_profit = status === 'returned' || status === 'cancelled'
      ? -(mpFees * share)
      : it.revenue - (mpFees + tax) * share - it.cogs;
  }

  // Отсутствие себестоимости НЕ делает финотчёт «нереальным» — пробел отражает missing_cogs_count.
  const missing_cogs_count = p.items.filter(it => it.cost_price == null && it.quantity > 0).length;
  const pending_settlement = !hasSettlement && status !== 'cancelled' && status !== 'returned';

  return {
    order_id: p.orderId,
    order_key: makeOrderKey(p.mp, p.store.id, p.orderId),
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
    vat,
    profit_tax_rate: isProfitTaxModel(model) ? rate : 0,
    min_tax_rate: minTaxRate(model),
    net_profit,
    payout_actual,
    source,
    missing_cogs_count,
    tx_ids: p.txs.map(t => t.mp_transaction_id),
    pending_settlement,
    is_orphan: false,
    finance_only: p.finance_only ?? false,
  };
}
