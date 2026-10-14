/**
 * KPI и временные ряды по списку Order.
 */

import {
  Order, KPI, TimeseriesPoint, SkuPerformance, Mp,
  PeriodCost, PeriodCostKind, PERIOD_COST_LABEL, ManualEntry,
} from '../types';
import { mskDayKey } from '@/utils/mpDate';
import { calcProfitTax } from './taxCalculator';

/**
 * Заказ участвует в денежном P&L?
 *
 * Только выкупленные заказы приносят выручку, а возвраты и отмены — расходы
 * (обратная логистика, невозвращённая часть комиссии). Заказы в пути не входят:
 * денег по ним ещё нет, и включать их в прибыль — значит показывать продавцу
 * заработок, которого не существует. Их сумма выводится отдельно как прогноз.
 */
function isSettled(o: Order): boolean {
  if (o.status === 'returned' || o.status === 'cancelled') return true;
  // Выкупленный заказ попадает в деньги только с финотчётом МП.
  return o.status === 'delivered' && o.source === 'real';
}

/** Суммирует расходы периода и ручные записи в разбивку по категориям. */
function foldPeriodCosts(
  periodCosts: PeriodCost[],
  manual: ManualEntry[],
): { mp: number; manual: number; breakdown: Array<{ kind: PeriodCostKind; label: string; amount: number }> } {
  const acc = new Map<PeriodCostKind, number>();
  let mp = 0, manualTotal = 0;

  for (const c of periodCosts) {
    acc.set(c.kind, (acc.get(c.kind) ?? 0) + c.amount);
    mp += c.amount;
  }
  for (const e of manual) {
    // other_income уменьшает расходы периода, всё остальное — увеличивает
    const amount = e.type === 'other_income' ? -e.amount : e.amount;
    acc.set('manual', (acc.get('manual') ?? 0) + amount);
    manualTotal += amount;
  }

  const breakdown = [...acc.entries()]
    .filter(([, amount]) => Math.abs(amount) > 0.01)
    .map(([kind, amount]) => ({ kind, label: PERIOD_COST_LABEL[kind], amount }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return { mp, manual: manualTotal, breakdown };
}

export interface MissingCogsItem {
  vendor_code: string;
  name: string;
  mp: Mp;
  orders_count: number;
}

/** Уникальные артикулы без себестоимости (только доставленные/в пути, без возвратов).
 *  Если передан `knownVendorCodes` (lowercased set), показываются ТОЛЬКО артикулы,
 *  которые реально присутствуют в каталоге Репрайсера. Это убирает призраков из
 *  orphan-транзакций (числовые SKU удалённых товаров), которые пользователь
 *  всё равно не может найти в Репрайсере и задать им cost_price. */
export function computeMissingCogs(orders: Order[], knownVendorCodes?: Set<string>): MissingCogsItem[] {
  const map = new Map<string, { name: string; mp: Mp; count: number }>();
  for (const o of orders) {
    if (o.status === 'cancelled' || o.status === 'returned') continue;
    for (const it of o.items) {
      if (it.cost_price != null || it.quantity === 0) continue;
      const vcNorm = it.vendor_code.trim().toLowerCase();
      if (!vcNorm) continue;
      // Если знаем каталог — показываем только то, что реально в нём есть.
      if (knownVendorCodes && !knownVendorCodes.has(vcNorm)) continue;
      // Иначе хотя бы пропускаем чисто-числовые id (нерезолвированные SKU Ozon).
      if (!knownVendorCodes && /^\d+$/.test(it.vendor_code)) continue;
      const key = `${o.mp}|${it.vendor_code}`;
      const cur = map.get(key) ?? { name: it.name, mp: o.mp, count: 0 };
      cur.count++;
      map.set(key, cur);
    }
  }
  return [...map.entries()]
    .map(([k, v]) => ({ vendor_code: k.split('|')[1], name: v.name, mp: v.mp, orders_count: v.count }))
    .sort((a, b) => b.orders_count - a.orders_count);
}

/** Удержания маркетплейса по заказу (без себестоимости и налога). */
function feesOf(o: Order): number {
  return o.commission + o.logistics + o.logistics_return + o.services;
}

/** Сумма ручных записей: доход уменьшает расходы. */
function manualSigned(e: ManualEntry): number {
  return e.type === 'other_income' ? -e.amount : e.amount;
}

/**
 * Налог с прибыли (УСН 15%, ОСНО) за период, по магазинам.
 *
 * Раньше он считался по каждому заказу отдельно как max(0, прибыль) × ставка:
 * убыточные заказы, возвраты, реклама и хранение не уменьшали базу, и налог
 * получался завышенным. Теперь база — прибыль магазина за весь период;
 * для УСН 15% действует минимальный налог 1% от выручки.
 */
export function computeProfitTax(
  orders: Order[],
  periodCosts: PeriodCost[] = [],
  manualEntries: ManualEntry[] = [],
): { total: number; byStore: Map<string, number> } {
  type Acc = { revenue: number; expenses: number; rate: number; minRate: number };
  const stores = new Map<string, Acc>();
  for (const o of orders) {
    if (!o.profit_tax_rate) continue;
    if (!stores.has(o.store_id)) stores.set(o.store_id, { revenue: 0, expenses: 0, rate: o.profit_tax_rate, minRate: o.min_tax_rate ?? 0 });
  }
  if (!stores.size) return { total: 0, byStore: new Map() };

  for (const o of orders) {
    const acc = stores.get(o.store_id);
    if (!acc || !isSettled(o)) continue;
    acc.expenses += feesOf(o);
    if (o.status === 'delivered') {
      acc.revenue += o.revenue - (o.vat ?? 0);
      acc.expenses += o.cogs + (o.tax - (o.vat ?? 0));
    }
  }
  for (const c of periodCosts) {
    const acc = stores.get(c.store_id);
    if (acc) acc.expenses += c.amount;
  }
  // Ручные расходы без магазина делим между магазинами по выручке.
  const totalRevenue = [...stores.values()].reduce((s, a) => s + a.revenue, 0);
  for (const e of manualEntries) {
    if (e.store_id) {
      const acc = stores.get(e.store_id);
      if (acc) acc.expenses += manualSigned(e);
      continue;
    }
    for (const acc of stores.values()) {
      acc.expenses += totalRevenue > 0 ? manualSigned(e) * (acc.revenue / totalRevenue) : 0;
    }
  }
  const byStore = new Map<string, number>();
  let total = 0;
  for (const [id, a] of stores) {
    const t = calcProfitTax(a.revenue, a.expenses, a.rate, a.minRate);
    byStore.set(id, t);
    total += t;
  }
  return { total, byStore };
}

export function computeKPI(
  orders: Order[],
  periodCosts: PeriodCost[] = [],
  manualEntries: ManualEntry[] = [],
): KPI {
  let revenue = 0, returns_revenue = 0, cancelled_revenue = 0;
  let ordered_revenue = 0, in_transit_revenue = 0;
  let commission = 0, logistics = 0, services = 0, cogs = 0, tax = 0, vat = 0;
  let units_sold = 0;
  let delivered = 0, processing = 0, returned = 0, cancelled = 0;
  let deliveredCount = 0, realCount = 0, missingCogsOrders = 0;
  let awaitingOrders = 0, awaitingRevenue = 0;
  let ordersTotal = 0;

  for (const o of orders) {
    // is_orphan — устаревшие технические строки: в деньгах участвуют,
    // в счётчиках заказов — нет.
    const counted = !o.is_orphan;
    if (counted) {
      ordersTotal++;
      switch (o.status) {
        case 'delivered':   delivered++;  break;
        case 'processing':
        case 'in_delivery': processing++; break;
        case 'returned':    returned++;   break;
        case 'cancelled':   cancelled++;  break;
      }
      // Объём заказов — по дате заказа, включая ещё не доехавшие.
      ordered_revenue += o.revenue + (o.revenue_lost || 0);
    }
    if (o.status === 'processing' || o.status === 'in_delivery' || o.status === 'unknown') {
      in_transit_revenue += o.revenue;
      continue; // денег по ним ещё нет — в P&L не участвуют
    }

    if (o.missing_cogs_count > 0) missingCogsOrders++;

    if (o.status === 'delivered') {
      if (counted) deliveredCount++;
      // В P&L идут только заказы, по которым маркетплейс прислал расчёт.
      if (o.source !== 'real') {
        awaitingOrders++;
        awaitingRevenue += o.revenue;
        continue;
      }
      realCount++;
      revenue += o.revenue;
      cogs    += o.cogs;
      tax     += o.tax;
      vat     += o.vat ?? 0;
      // Частичный возврат: возвращённая часть — упущенная выручка
      if (counted) returns_revenue += o.revenue_lost || 0;
      if (counted) for (const it of o.items) units_sold += it.quantity - (it.returned_qty ?? 0);
    } else if (o.status === 'returned') {
      if (counted) returns_revenue += o.revenue_lost || 0;
    } else if (counted) {
      cancelled_revenue += o.revenue_lost || 0;
    }

    // Удержания списываются и по возвратам, и по отменам — это реальные потери.
    commission += o.commission;
    logistics  += o.logistics + o.logistics_return;
    services   += o.services;
  }

  const folded = foldPeriodCosts(periodCosts, manualEntries);
  const profitTax = computeProfitTax(orders, periodCosts, manualEntries).total;
  tax += profitTax;
  const total_expenses = commission + logistics + services + cogs + tax + folded.mp + folded.manual;
  const net_profit = revenue - total_expenses;
  const margin_pct = revenue > 0 ? (net_profit / revenue) * 100 : 0;
  const avg_check = realCount > 0 ? revenue / realCount : 0;
  const closed = delivered + returned + cancelled;

  return {
    revenue,
    revenue_gross: revenue,
    returns_revenue, cancelled_revenue,
    ordered_revenue, in_transit_revenue,
    commission, logistics, services, cogs, tax,
    vat, profit_tax: profitTax,
    period_costs: folded.mp,
    manual_costs: folded.manual,
    period_costs_breakdown: folded.breakdown,
    total_expenses, net_profit, margin_pct,
    orders_delivered: delivered, orders_processing: processing,
    orders_returned: returned, orders_cancelled: cancelled,
    orders_total: ordersTotal,
    units_sold, avg_check,
    buyout_pct: closed > 0 ? (delivered / closed) * 100 : 0,
    // Покрытие финотчётом — только по выкупленным заказам: только у них он должен быть.
    source_real_pct: deliveredCount > 0 ? Math.min(100, (realCount / deliveredCount) * 100) : 100,
    missing_cogs_orders: missingCogsOrders,
    awaiting_orders: awaitingOrders,
    awaiting_revenue: awaitingRevenue,
    orders_settled: realCount,
  };
}

/**
 * Ряд по дням. Сумма ряда обязана совпадать с KPI — иначе график спорит с
 * карточками. Поэтому здесь ровно те же правила: выручка только по выкупленным,
 * удержания по всем закрытым заказам, плюс расходы периода по своей дате.
 * Налог с прибыли за период раскладывается по дням пропорционально выручке.
 */
export function computeTimeseries(
  orders: Order[],
  dateFrom: Date,
  dateTo: Date,
  periodCosts: PeriodCost[] = [],
  manualEntries: ManualEntry[] = [],
): TimeseriesPoint[] {
  const byDay = new Map<string, { revenue: number; expenses: number }>();
  const bump = (day: string, revenue: number, expenses: number) => {
    const cur = byDay.get(day) ?? { revenue: 0, expenses: 0 };
    cur.revenue += revenue;
    cur.expenses += expenses;
    byDay.set(day, cur);
  };

  for (const o of orders) {
    if (!o.date || !isSettled(o)) continue;
    const isDelivered = o.status === 'delivered';
    bump(
      mskDayKey(o.date),
      isDelivered ? o.revenue : 0,
      feesOf(o) + (isDelivered ? o.cogs + o.tax : 0),
    );
  }

  // Сетка дней — тоже московская, иначе крайние дни периода не сойдутся
  // с ключами заказов и суммы графика разъехались бы с KPI.
  const from = mskDayKey(dateFrom.toISOString());
  const to   = mskDayKey(dateTo.toISOString());
  const inRange = (day: string) => day >= from && day <= to;

  for (const c of periodCosts) {
    const day = mskDayKey(c.date);
    if (day && inRange(day)) bump(day, 0, c.amount);
  }
  for (const e of manualEntries) {
    // Ручные записи пользователь вводит датой без времени — берём как есть.
    const day = (e.date || '').slice(0, 10);
    if (day && inRange(day)) bump(day, 0, manualSigned(e));
  }

  const profitTax = computeProfitTax(orders, periodCosts, manualEntries).total;
  if (profitTax > 0) {
    const days = [...byDay.entries()].filter(([d]) => inRange(d));
    const rev = days.reduce((s, [, v]) => s + v.revenue, 0);
    if (rev > 0) for (const [, v] of days) v.expenses += profitTax * (v.revenue / rev);
    else bump(to, 0, profitTax);
  }

  // Дозаполнить пустые дни нулями
  const out: TimeseriesPoint[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last   = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    const v = byDay.get(day) ?? { revenue: 0, expenses: 0 };
    out.push({ date: day, revenue: v.revenue, expenses: v.expenses, profit: v.revenue - v.expenses });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Строка для удержаний по заказам, у которых нет ни одной позиции. */
export const NO_ITEM_VENDOR_CODE = '—';

/**
 * Разбивка по товарам. Сумма прибыли товаров равна чистой прибыли сводки:
 * сюда входят продажи, потери по возвратам и отменам, налог с прибыли и
 * общие расходы периода (распределены пропорционально выкупленной выручке).
 */
export function computeSkuPerformance(
  orders: Order[],
  periodCosts: PeriodCost[] = [],
  manualEntries: ManualEntry[] = [],
): SkuPerformance[] {
  type Acc = {
    mp: Mp; name: string; image?: string;
    units: number; ordered: number; returned: number; cancelled: number;
    returnedRevenue: number; cancelledRevenue: number; revenue: number;
    commission: number; logistics: number; services: number; tax: number;
    cogs: number; missingCogs: number; profit: number; orders: Set<string>;
  };
  const map = new Map<string, Acc>();
  const get = (key: string, mp: Mp, name: string, image?: string): Acc => {
    let cur = map.get(key);
    if (!cur) {
      cur = {
        mp, name, image,
        units: 0, ordered: 0, returned: 0, cancelled: 0, returnedRevenue: 0, cancelledRevenue: 0,
        revenue: 0, commission: 0, logistics: 0, services: 0, tax: 0, cogs: 0, missingCogs: 0, profit: 0,
        orders: new Set<string>(),
      };
      map.set(key, cur);
    }
    return cur;
  };

  for (const o of orders) {
    // Та же база, что и в KPI: заказы в пути денег ещё не принесли.
    if (!isSettled(o)) continue;
    const isSale = o.status === 'delivered';
    const isReturn = o.status === 'returned';
    const fees = feesOf(o);
    const items = o.items.length ? o.items : null;
    if (!items) {
      // Удержание по заказу без позиций — отдельной строкой, чтобы итог сошёлся.
      const cur = get(`${o.mp}|${NO_ITEM_VENDOR_CODE}`, o.mp, 'Удержания без привязки к товару');
      cur.commission += o.commission;
      cur.logistics  += o.logistics + o.logistics_return;
      cur.services   += o.services;
      cur.revenue    += isSale ? o.revenue : 0;
      cur.cogs       += isSale ? o.cogs : 0;
      cur.tax        += isSale ? o.tax : 0;
      cur.profit     += (isSale ? o.revenue - o.cogs - o.tax : 0) - fees;
      cur.orders.add(o.order_key ?? o.order_id);
      continue;
    }
    const denom = items.reduce((s, it) => s + Math.max(0, it.revenue), 0);
    for (const it of items) {
      const cur = get(`${o.mp}|${it.vendor_code}`, o.mp, it.name, it.image);
      const share = denom > 0 ? Math.max(0, it.revenue) / denom : 1 / items.length;
      cur.commission += o.commission * share;
      cur.logistics  += (o.logistics + o.logistics_return) * share;
      cur.services   += o.services * share;
      cur.ordered    += it.quantity;
      if (isSale) {
        const retQty = it.returned_qty ?? 0;
        cur.units += it.quantity - retQty;
        cur.returned += retQty;
        cur.returnedRevenue += (o.revenue_lost || 0) * share;
        cur.revenue += it.revenue;
        cur.cogs += it.cogs;
        cur.tax += o.tax * share;
        if (it.cost_price == null) cur.missingCogs += it.quantity - retQty;
        cur.profit += it.revenue - it.cogs - (fees + o.tax) * share;
      } else if (isReturn) {
        cur.returned += it.quantity;
        cur.returnedRevenue += it.revenue;
        cur.profit -= fees * share;
      } else {
        cur.cancelled += it.quantity;
        cur.cancelledRevenue += it.revenue;
        cur.profit -= fees * share;
      }
      cur.orders.add(o.order_key ?? o.order_id);
    }
  }

  // Общие расходы и налог с прибыли не относятся к одному SKU. Для
  // управленческой unit-экономики распределяем их пропорционально выкупленной
  // выручке, чтобы сумма товаров сходилась с чистой прибылью сводки.
  const mpCommon = periodCosts.reduce((s, c) => s + c.amount, 0);
  const manualCommon = manualEntries.reduce((s, e) => s + manualSigned(e), 0);
  const profitTax = computeProfitTax(orders, periodCosts, manualEntries).total;
  const totalRevenue = [...map.values()].reduce((s, v) => s + v.revenue, 0);
  const commonShare = (v: Acc) => totalRevenue > 0
    ? v.revenue / totalRevenue
    : map.size > 0 ? 1 / map.size : 0;

  const arr: SkuPerformance[] = [];
  for (const [k, v] of map) {
    const share = commonShare(v);
    const periodShare = mpCommon * share;
    const manualShare = manualCommon * share;
    const taxShare = profitTax * share;
    const finalProfit = v.profit - periodShare - manualShare - taxShare;
    const tax = v.tax + taxShare;
    arr.push({
      vendor_code: k.slice(k.indexOf('|') + 1), mp: v.mp, name: v.name, image: v.image,
      units_sold: v.units, units_ordered: v.ordered, units_returned: v.returned, units_cancelled: v.cancelled,
      returned_revenue: v.returnedRevenue, cancelled_revenue: v.cancelledRevenue,
      revenue: v.revenue, commission: v.commission, logistics: v.logistics,
      services: v.services, tax, cogs: v.cogs,
      period_costs: periodShare,
      manual_costs: manualShare,
      // Все расходы товара: выручка − расходы = прибыль, включая потери по возвратам.
      total_expenses: v.revenue - finalProfit,
      net_profit: finalProfit,
      margin_pct: v.revenue > 0 ? (finalProfit / v.revenue) * 100 : 0,
      profit_per_unit: v.units > 0 ? finalProfit / v.units : 0,
      cogs_coverage_pct: v.units > 0 ? Math.max(0, ((v.units - v.missingCogs) / v.units) * 100) : 100,
      missing_cogs_units: v.missingCogs,
      return_rate_pct: (v.units + v.returned) > 0 ? (v.returned / (v.units + v.returned)) * 100 : 0,
      orders_count: v.orders.size,
    });
  }
  return arr.sort((a, b) => b.revenue - a.revenue);
}
