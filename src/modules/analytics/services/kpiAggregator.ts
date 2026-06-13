/**
 * KPI и временные ряды по списку Order.
 */

import { Order, KPI, TimeseriesPoint, SkuPerformance, Mp } from '../types';

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

export function computeKPI(orders: Order[]): KPI {
  let revenue_gross = 0, returns_revenue = 0;
  let commission = 0, logistics = 0, services = 0, cogs = 0, tax = 0;
  let units_sold = 0;
  let delivered = 0, processing = 0, returned = 0, cancelled = 0;
  let realCount = 0, missingCogsOrders = 0;

  for (const o of orders) {
    if (o.status === 'returned') {
      returns_revenue += o.revenue;
    } else if (o.status === 'cancelled') {
      // skip
    } else {
      revenue_gross += o.revenue;
    }
    commission += o.commission;
    logistics  += o.logistics + o.logistics_return;
    services   += o.services;
    cogs       += o.cogs;
    tax        += o.tax;

    if (o.status !== 'cancelled') {
      for (const it of o.items) units_sold += it.quantity;
    }

    switch (o.status) {
      case 'delivered':   delivered++;  break;
      case 'processing':
      case 'in_delivery': processing++; break;
      case 'returned':    returned++;   break;
      case 'cancelled':   cancelled++;  break;
    }
    if (o.source === 'real') realCount++;
    if (o.missing_cogs_count > 0) missingCogsOrders++;
  }

  const revenue = revenue_gross - returns_revenue;
  const total_expenses = commission + logistics + services + cogs + tax;
  const net_profit = revenue - total_expenses;
  const margin_pct = revenue > 0 ? (net_profit / revenue) * 100 : 0;
  const avg_check = delivered > 0 ? revenue / delivered : 0;
  const source_real_pct = orders.length > 0 ? (realCount / orders.length) * 100 : 0;

  return {
    revenue, revenue_gross, returns_revenue,
    commission, logistics, services, cogs, tax,
    total_expenses, net_profit, margin_pct,
    orders_delivered: delivered, orders_processing: processing,
    orders_returned: returned, orders_cancelled: cancelled,
    units_sold, avg_check,
    source_real_pct, missing_cogs_orders: missingCogsOrders,
  };
}

export function computeTimeseries(orders: Order[], dateFrom: Date, dateTo: Date): TimeseriesPoint[] {
  const byDay = new Map<string, { revenue: number; expenses: number }>();
  for (const o of orders) {
    if (!o.date) continue;
    const day = o.date.slice(0, 10);
    const cur = byDay.get(day) ?? { revenue: 0, expenses: 0 };
    if (o.status === 'cancelled') { byDay.set(day, cur); continue; }
    if (o.status === 'returned') {
      // возврат бьёт по тому же дню, но в выручку записываем 0, а возврат — в расходы
      cur.expenses += o.revenue;
    } else {
      cur.revenue += o.revenue;
    }
    cur.expenses += o.commission + o.logistics + o.logistics_return + o.services + o.cogs + o.tax;
    byDay.set(day, cur);
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
    if (o.status === 'cancelled') continue;
    const sign = o.status === 'returned' ? -1 : 1;
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
      cur.units      += sign * it.quantity;
      cur.revenue    += sign * it.revenue;
      cur.commission += sign * o.commission * share;
      cur.logistics  += sign * (o.logistics + o.logistics_return) * share;
      cur.cogs       += sign * it.cogs;
      cur.net_profit += sign * it.net_profit;
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
