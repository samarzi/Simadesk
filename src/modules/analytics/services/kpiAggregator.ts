/**
 * KPI и временные ряды по списку Order.
 */

import {
  Order, KPI, TimeseriesPoint, SkuPerformance, Mp,
  PeriodCost, PeriodCostKind, PERIOD_COST_LABEL, ManualEntry,
} from '../types';

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

export function computeKPI(
  orders: Order[],
  periodCosts: PeriodCost[] = [],
  manualEntries: ManualEntry[] = [],
): KPI {
  let revenue = 0, returns_revenue = 0, cancelled_revenue = 0;
  let ordered_revenue = 0, in_transit_revenue = 0;
  let commission = 0, logistics = 0, services = 0, cogs = 0, tax = 0;
  let units_sold = 0;
  let delivered = 0, processing = 0, returned = 0, cancelled = 0;
  let deliveredCount = 0, realCount = 0, missingCogsOrders = 0;
  let awaitingOrders = 0, awaitingRevenue = 0;
  let ordersTotal = 0;

  for (const o of orders) {
    if (!o.is_orphan) ordersTotal++;

    switch (o.status) {
      case 'delivered':   delivered++;  break;
      case 'processing':
      case 'in_delivery': processing++; break;
      case 'returned':    returned++;   break;
      case 'cancelled':   cancelled++;  break;
    }

    // Объём заказов — по дате заказа, включая ещё не доехавшие.
    ordered_revenue += o.revenue + (o.revenue_lost || 0);
    if (o.status === 'processing' || o.status === 'in_delivery') {
      in_transit_revenue += o.revenue;
      continue; // денег по ним ещё нет — в P&L не участвуют
    }

    if (o.missing_cogs_count > 0) missingCogsOrders++;

    if (o.status === 'delivered') {
      deliveredCount++;
      // В P&L идут только заказы, по которым маркетплейс прислал расчёт.
      // Без этого пришлось бы либо выдумывать комиссию, либо показывать выручку
      // с нулевыми удержаниями — и то и другое завышает прибыль.
      if (o.source !== 'real') {
        awaitingOrders++;
        awaitingRevenue += o.revenue;
        continue;
      }
      realCount++;
      revenue += o.revenue;
      cogs    += o.cogs;
      tax     += o.tax;
      for (const it of o.items) units_sold += it.quantity;
    } else if (o.status === 'returned') {
      returns_revenue += o.revenue_lost || 0;
    } else {
      cancelled_revenue += o.revenue_lost || 0;
    }

    // Удержания списываются и по возвратам, и по отменам — это реальные потери.
    commission += o.commission;
    logistics  += o.logistics + o.logistics_return;
    services   += o.services;
  }

  const folded = foldPeriodCosts(periodCosts, manualEntries);
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
    period_costs: folded.mp,
    manual_costs: folded.manual,
    period_costs_breakdown: folded.breakdown,
    total_expenses, net_profit, margin_pct,
    orders_delivered: delivered, orders_processing: processing,
    orders_returned: returned, orders_cancelled: cancelled,
    orders_total: ordersTotal,
    units_sold, avg_check,
    buyout_pct: closed > 0 ? (delivered / closed) * 100 : 0,
    // Покрытие финотчётом считаем только по выкупленным заказам: только у них
    // отчёт вообще должен быть. Раньше в числитель попадали orphan-строки,
    // а в знаменатель — нет, из-за чего доля могла превысить 100%.
    source_real_pct: deliveredCount > 0 ? (realCount / deliveredCount) * 100 : 100,
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
 *
 * Раньше сюда дополнительно приплюсовывалась «возвращённая выручка» в расходы,
 * которой в KPI не было, и итог графика не сходился с чистой прибылью.
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
    const fees = o.commission + o.logistics + o.logistics_return + o.services;
    const isDelivered = o.status === 'delivered';
    bump(
      o.date.slice(0, 10),
      isDelivered ? o.revenue : 0,
      fees + (isDelivered ? o.cogs + o.tax : 0),
    );
  }

  const from = dateFrom.toISOString().slice(0, 10);
  const to   = dateTo.toISOString().slice(0, 10);
  const inRange = (day: string) => day >= from && day <= to;

  for (const c of periodCosts) {
    const day = (c.date || '').slice(0, 10);
    if (day && inRange(day)) bump(day, 0, c.amount);
  }
  for (const e of manualEntries) {
    const day = (e.date || '').slice(0, 10);
    if (day && inRange(day)) bump(day, 0, e.type === 'other_income' ? -e.amount : e.amount);
  }

  // Дозаполнить пустые дни нулями
  const out: TimeseriesPoint[] = [];
  const cursor = new Date(Date.UTC(dateFrom.getUTCFullYear(), dateFrom.getUTCMonth(), dateFrom.getUTCDate()));
  const last = new Date(Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth(), dateTo.getUTCDate()));
  while (cursor.getTime() <= last.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    const v = byDay.get(day) ?? { revenue: 0, expenses: 0 };
    out.push({ date: day, revenue: v.revenue, expenses: v.expenses, profit: v.revenue - v.expenses });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function computeSkuPerformance(orders: Order[]): SkuPerformance[] {
  type Acc = {
    mp: Mp; name: string; image?: string;
    units: number; revenue: number; commission: number; logistics: number;
    cogs: number; net_profit: number; orders: Set<string>;
  };
  const map = new Map<string, Acc>();
  for (const o of orders) {
    // Та же база, что и в KPI: заказы в пути денег ещё не принесли.
    if (!isSettled(o) || o.status === 'cancelled') continue;
    const isReturn = o.status === 'returned';
    // Доли по позиции от заказа: распределяем commission/logistics пропорционально revenue
    const denom = o.items.reduce((s, it) => s + Math.max(0, it.revenue), 0);
    for (const it of o.items) {
      const key = `${o.mp}|${it.vendor_code}`;
      const cur = map.get(key) ?? {
        mp: o.mp, name: it.name, image: it.image,
        units: 0, revenue: 0, commission: 0, logistics: 0, cogs: 0, net_profit: 0,
        orders: new Set<string>(),
      };
      const share = denom > 0 ? it.revenue / denom : 1 / Math.max(1, o.items.length);
      const fees = (o.commission + o.logistics + o.logistics_return + o.services) * share;
      cur.commission += o.commission * share;
      cur.logistics  += (o.logistics + o.logistics_return) * share;
      if (isReturn) {
        // Возврат не приносит ни выручки, ни проданных единиц — только расходы
        // на обратную логистику и невозвращённую часть комиссии.
        cur.net_profit -= fees;
      } else {
        cur.units      += it.quantity;
        cur.revenue    += it.revenue;
        cur.cogs       += it.cogs;
        cur.net_profit += it.net_profit;
      }
      cur.orders.add(o.order_id);
      map.set(key, cur);
    }
  }
  const arr: SkuPerformance[] = [];
  for (const [k, v] of map) {
    const vc = k.split('|')[1];
    arr.push({
      vendor_code: vc, mp: v.mp, name: v.name, image: v.image,
      units_sold: v.units, revenue: v.revenue,
      commission: v.commission, logistics: v.logistics, cogs: v.cogs,
      net_profit: v.net_profit,
      margin_pct: v.revenue > 0 ? (v.net_profit / v.revenue) * 100 : 0,
      orders_count: v.orders.size,
    });
  }
  return arr.sort((a, b) => b.revenue - a.revenue);
}
