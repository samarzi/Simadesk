/**
 * Юнит-экономика 2.0 — прогноз прибыли по заказам периода.
 *
 * Сводка считает деньги по факту выкупа, а здесь — «что принесут заказы,
 * сделанные сегодня/за период»: менеджер видит экономику сразу, не дожидаясь
 * финотчёта через 1–3 недели.
 *
 *   заказано (шт, ₽)  ×  ожидаемый выкуп %  →  выкуплено (шт, ₽)
 *   на выкупленную шт: себестоимость, комиссия, налог, эквайринг, прямая
 *   логистика, последняя миля, обратная логистика по невыкупам, прочие услуги
 *   −  реклама за период  −  фактические штрафы и удержания
 *   =  прибыль, прибыль на шт, ROI (прибыль ÷ себестоимость)
 *
 * Откуда берутся ставки. Не из тарифных таблиц, а из фактических финотчётов
 * за опорное окно (по умолчанию 60 дней до периода с отступом 10 дней, чтобы
 * заказы успели закрыться). По каждому товару — его собственные цифры; если
 * данных мало, используется среднее по магазину, и это видно в «нюансах».
 *
 * Модуль чистый: на вход заказы и настройки, на выход — отчёт. Покрыт тестами.
 */

import { Order, Mp, PeriodCost, TaxModel, TAX_LABEL } from '../types';
import { calcOrderTax, calcProfitTax, isProfitTaxModel, minTaxRate } from './taxCalculator';

export interface UnitEconSettings {
  /** 'auto' — выкуп из истории; 'manual' — фиксированный процент. */
  buyoutMode: 'auto' | 'manual';
  /** Процент выкупа для ручного режима и запасной вариант, 0–100. */
  buyoutPct: number;
  /** Сценарий: себестоимость за штуку для всех товаров. null — не задан. */
  scenarioCost: number | null;
  /** Учитывать в прибыли фактические штрафы, хранение и прочие удержания за период. */
  includeFacts: boolean;
  /** Минимум закрытых штук товара, чтобы доверять его собственной статистике. */
  minSample: number;
}

export const DEFAULT_UNIT_SETTINGS: UnitEconSettings = {
  buyoutMode: 'auto',
  buyoutPct: 60,
  scenarioCost: null,
  includeFacts: true,
  minSample: 20,
};

export interface StoreTax {
  model: TaxModel;
  rate: number;
  vat: number;
}

/** Расход рекламной кампании (из Performance API) — подмножество PerfCampaignSpend. */
export interface UnitAdCampaign {
  title: string;
  group: string;
  strategy: string;
  money: number;
  bonus: number;
  /** SKU маркетплейса в кампании. */
  skus: string[];
}

export interface UnitAdsInput {
  source: 'performance' | 'finance' | 'manual' | 'none';
  campaigns: UnitAdCampaign[];
  /** Расход, который не разложен по кампаниям (финотчёт, ручные записи). */
  unassigned: number;
}

export interface UnitEconInput {
  /** Заказы периода (по дате заказа). */
  orders: Order[];
  /** Заказы опорного окна — из них выкуп и удельные расходы. */
  history: Order[];
  /** Расходы периода без заказа (штрафы, хранение, прочие удержания). */
  periodCosts: PeriodCost[];
  ads: UnitAdsInput;
  taxByStore: Record<string, StoreTax>;
  settings: UnitEconSettings;
  /** Отгрузки FBS за период (если известны). */
  fbs?: { postings: number; units: number; revenue: number } | null;
}

type Basis = 'sku' | 'store' | 'none';

export interface UnitCostLine {
  key: 'cogs' | 'commission' | 'tax' | 'acquiring' | 'logistics' | 'last_mile' | 'return_logistics' | 'other' | 'ads';
  label: string;
  /** ₽ на выкупленную штуку (средневзвешенно). */
  perUnit: number;
  /** % от цены выкупленной штуки. */
  pctOfPrice: number;
  /** Сумма за период. */
  total: number;
  /** Откуда цифра. */
  source: string;
}

export interface UnitSkuRow {
  mp: Mp;
  vendor_code: string;
  mp_sku: string;
  name: string;
  orders: number;
  orderedUnits: number;
  orderedRevenue: number;
  price: number;
  buyoutPct: number;
  buyoutBasis: Basis | 'manual';
  boughtUnits: number;
  boughtRevenue: number;
  cogsPerUnit: number | null;
  commissionPerUnit: number;
  taxPerUnit: number;
  acquiringPerUnit: number;
  logisticsPerUnit: number;
  lastMilePerUnit: number;
  returnLogisticsPerUnit: number;
  otherPerUnit: number;
  feesBasis: Basis;
  ads: number;
  drrOrdered: number;
  drrBought: number;
  profit: number;
  profitPerUnit: number;
  roi: number | null;
  margin: number;
}

export interface UnitEconResult {
  orders: number;
  orderedUnits: number;
  orderedRevenue: number;
  /** Уже отменено из заказов периода (видно сразу). */
  cancelledUnits: number;
  buyoutPct: number;
  buyoutSource: string;
  boughtUnits: number;
  boughtRevenue: number;
  avgPrice: number;

  ads: {
    source: UnitAdsInput['source'];
    total: number;
    bonus: number;
    perOrderedUnit: number;
    perBoughtUnit: number;
    drrOrdered: number;
    drrBought: number;
    groups: Array<{ label: string; money: number; drrOrdered: number; drrBought: number }>;
    strategies: Array<{ label: string; money: number; drrOrdered: number; drrBought: number }>;
    bonusGroups: Array<{ label: string; amount: number }>;
  };

  costs: UnitCostLine[];
  facts: { penalties: number | null; storage: number | null; other: number | null; included: boolean };
  profitTax: number;

  profit: number;
  profitPerUnit: number;
  roi: number | null;
  margin: number;
  cogsTotal: number;

  scenario: { cost: number; profit: number; profitPerUnit: number; roi: number | null } | null;
  fbs: { postings: number; units: number; revenue: number } | null;
  skus: UnitSkuRow[];
  nuances: Array<{ level: 'info' | 'warn'; text: string }>;
}

// ── Статистика из истории ─────────────────────────────────────────────────

interface FeeStats {
  boughtUnits: number;
  revenue: number;
  commission: number;
  acquiring: number;
  logistics: number;
  lastMile: number;
  other: number;
  /** Закрытые невыкупленные штуки и расходы по ним. */
  lostUnits: number;
  lostCost: number;
  /** Для процента выкупа: выкуплено / закрыто штук. */
  closedUnits: number;
}

const emptyStats = (): FeeStats => ({
  boughtUnits: 0, revenue: 0, commission: 0, acquiring: 0, logistics: 0, lastMile: 0, other: 0,
  lostUnits: 0, lostCost: 0, closedUnits: 0,
});

function feeOf(o: Order, type: string): number {
  return o.fee_breakdown.filter(f => f.type === type).reduce((s, f) => s + f.amount, 0);
}

const skuKey = (mp: Mp, vc: string) => `${mp}|${vc}`;

function collectHistory(history: Order[]): { bySku: Map<string, FeeStats>; byStore: Map<string, FeeStats> } {
  const bySku = new Map<string, FeeStats>();
  const byStore = new Map<string, FeeStats>();
  const bump = (map: Map<string, FeeStats>, key: string) => {
    let s = map.get(key);
    if (!s) { s = emptyStats(); map.set(key, s); }
    return s;
  };

  for (const o of history) {
    const closed = o.status === 'delivered' || o.status === 'returned' || o.status === 'cancelled';
    if (!closed || !o.items.length) continue;
    const units = o.items.reduce((s, it) => s + it.quantity, 0);
    if (units <= 0) continue;
    const denom = o.items.reduce((s, it) => s + Math.max(0, it.revenue), 0);

    // Реклама внутри заказов не входит в удельные расходы — она считается
    // отдельно по рекламному кабинету, иначе списалась бы дважды.
    const ads = feeOf(o, 'advertising');
    const acquiring = feeOf(o, 'acquiring');
    const lastMile = feeOf(o, 'last_mile');
    const logistics = o.logistics - lastMile;
    const other = o.services - acquiring - ads + o.logistics_return;
    const allFees = o.commission + o.logistics + o.logistics_return + o.services - ads;

    for (const it of o.items) {
      const share = denom > 0 ? Math.max(0, it.revenue) / denom : it.quantity / units;
      const targets = [bump(bySku, skuKey(o.mp, it.vendor_code)), bump(byStore, o.store_id)];
      for (const s of targets) {
        if (o.status === 'delivered') {
          const ret = it.returned_qty ?? 0;
          const bought = it.quantity - ret;
          s.closedUnits += it.quantity;
          s.lostUnits += ret;
          // Финансы — только по заказам с финотчётом: иначе удержаний ещё нет.
          if (o.source === 'real') {
            s.boughtUnits += bought;
            s.revenue += it.revenue;
            s.commission += o.commission * share;
            s.acquiring += acquiring * share;
            s.logistics += logistics * share;
            s.lastMile += lastMile * share;
            s.other += other * share;
          }
        } else {
          s.closedUnits += it.quantity;
          s.lostUnits += it.quantity;
          s.lostCost += allFees * share;
        }
      }
    }
  }
  return { bySku, byStore };
}

/** Доля выкупа: выкуплено / закрыто штук (доставлено + возвращено + отменено). */
function buyoutOf(s: FeeStats | undefined): number | null {
  if (!s || s.closedUnits <= 0) return null;
  return (s.closedUnits - s.lostUnits) / s.closedUnits;
}

// ── Основной расчёт ───────────────────────────────────────────────────────

interface SkuAcc {
  mp: Mp; vendor_code: string; mp_sku: string; name: string; store_id: string;
  orders: Set<string>; units: number; revenue: number; cancelledUnits: number;
  cogsSum: number; cogsUnits: number;
}

export function computeUnitEconomics(input: UnitEconInput): UnitEconResult {
  const { orders, history, settings } = input;
  const nuances: UnitEconResult['nuances'] = [];

  // 1. Заказано за период
  const skus = new Map<string, SkuAcc>();
  const orderIds = new Set<string>();
  for (const o of orders) {
    if (o.is_orphan || !o.items.length) continue;
    orderIds.add(o.order_key ?? o.order_id);
    for (const it of o.items) {
      const key = skuKey(o.mp, it.vendor_code);
      let s = skus.get(key);
      if (!s) {
        s = { mp: o.mp, vendor_code: it.vendor_code, mp_sku: it.mp_sku, name: it.name, store_id: o.store_id,
          orders: new Set(), units: 0, revenue: 0, cancelledUnits: 0, cogsSum: 0, cogsUnits: 0 };
        skus.set(key, s);
      }
      // Цена заказа — как у покупателя, до возвратов и отмен.
      const gross = (o.status === 'cancelled' || o.status === 'returned')
        ? it.price * it.quantity
        : it.revenue + (it.returned_qty ? it.price * it.returned_qty : 0);
      s.orders.add(o.order_key ?? o.order_id);
      s.units += it.quantity;
      s.revenue += gross;
      if (o.status === 'cancelled') s.cancelledUnits += it.quantity;
      if (it.cost_price != null) { s.cogsSum += it.cost_price * it.quantity; s.cogsUnits += it.quantity; }
      if (!s.mp_sku && it.mp_sku) s.mp_sku = it.mp_sku;
    }
  }

  const { bySku, byStore } = collectHistory(history);

  // 2. Реклама: кампании с известными SKU — на их товары, остальное — по выручке.
  const orderedRevenue = [...skus.values()].reduce((s, x) => s + x.revenue, 0);
  const adsBySku = new Map<string, number>();
  let adsPool = input.ads.unassigned;
  for (const c of input.ads.campaigns) {
    const targets = [...skus.entries()].filter(([, s]) =>
      c.skus.length && (c.skus.includes(s.mp_sku) || c.skus.includes(s.vendor_code)));
    const base = targets.reduce((sum, [, s]) => sum + s.revenue, 0);
    if (!targets.length || base <= 0) { adsPool += c.money; continue; }
    for (const [k, s] of targets) adsBySku.set(k, (adsBySku.get(k) ?? 0) + c.money * (s.revenue / base));
  }
  if (adsPool) {
    for (const [k, s] of skus) {
      adsBySku.set(k, (adsBySku.get(k) ?? 0) + (orderedRevenue > 0 ? adsPool * (s.revenue / orderedRevenue) : 0));
    }
  }
  const adsTotal = input.ads.campaigns.reduce((s, c) => s + c.money, 0) + input.ads.unassigned;

  // 3. По товарам
  const rows: UnitSkuRow[] = [];
  let skuFallbackFees = 0, skuNoFees = 0, skuFallbackBuyout = 0, skuNoCost = 0;
  const preTaxByStore = new Map<string, { revenueExVat: number; expenses: number }>();

  for (const [key, s] of skus) {
    const hs = bySku.get(key);
    const ss = byStore.get(s.store_id);
    const price = s.units > 0 ? s.revenue / s.units : 0;

    // Выкуп
    let buyout: number;
    let buyoutBasis: UnitSkuRow['buyoutBasis'];
    if (settings.buyoutMode === 'manual') {
      buyout = settings.buyoutPct / 100; buyoutBasis = 'manual';
    } else if (hs && hs.closedUnits >= settings.minSample && buyoutOf(hs) != null) {
      buyout = buyoutOf(hs)!; buyoutBasis = 'sku';
    } else if (ss && ss.closedUnits >= settings.minSample && buyoutOf(ss) != null) {
      buyout = buyoutOf(ss)!; buyoutBasis = 'store'; skuFallbackBuyout++;
    } else {
      buyout = settings.buyoutPct / 100; buyoutBasis = 'none'; skuFallbackBuyout++;
    }
    const bought = s.units * buyout;
    const boughtRevenue = bought * price;

    // Удельные расходы: доли от цены для комиссии/эквайринга, ₽ за штуку для логистики
    const minFeeUnits = Math.max(3, Math.round(settings.minSample / 4));
    let feesBasis: Basis;
    let st: FeeStats | undefined;
    if (hs && hs.boughtUnits >= minFeeUnits && hs.revenue > 0) { st = hs; feesBasis = 'sku'; }
    else if (ss && ss.boughtUnits > 0 && ss.revenue > 0) { st = ss; feesBasis = 'store'; skuFallbackFees++; }
    else { st = undefined; feesBasis = 'none'; skuNoFees++; }

    const pct = (v: number) => st && st.revenue > 0 ? v / st.revenue : 0;
    const perUnit = (v: number) => st && st.boughtUnits > 0 ? v / st.boughtUnits : 0;
    const commission = st ? pct(st.commission) * price : 0;
    const acquiring = st ? pct(st.acquiring) * price : 0;
    const other = st ? pct(st.other) * price : 0;
    const logistics = st ? perUnit(st.logistics) : 0;
    const lastMile = st ? perUnit(st.lastMile) : 0;
    // Обратная логистика: расход на невыкупленную штуку × невыкупов на выкупленную
    const lostSrc = hs && hs.lostUnits >= minFeeUnits ? hs : ss;
    const costPerLost = lostSrc && lostSrc.lostUnits > 0 ? lostSrc.lostCost / lostSrc.lostUnits : 0;
    const lostUnits = s.units - bought;
    const returnLogistics = bought > 0 ? costPerLost * lostUnits / bought : 0;

    const baseCost = s.cogsUnits > 0 ? s.cogsSum / s.cogsUnits : null;
    if (baseCost == null) skuNoCost++;
    const cogs = baseCost ?? 0;

    const tx = input.taxByStore[s.store_id] ?? { model: 'none' as TaxModel, rate: 0, vat: 0 };
    const mpFees = commission + acquiring + other + logistics + lastMile + returnLogistics;
    const { tax: taxPerUnit, vat: vatPerUnit } = calcOrderTax(price, mpFees, tx.model, tx.rate, tx.vat);

    const ads = adsBySku.get(key) ?? 0;
    const unitCosts = cogs + commission + taxPerUnit + acquiring + logistics + lastMile + returnLogistics + other;
    const profit = bought * (price - unitCosts) - ads;

    if (isProfitTaxModel(tx.model)) {
      const acc = preTaxByStore.get(s.store_id) ?? { revenueExVat: 0, expenses: 0 };
      acc.revenueExVat += bought * (price - vatPerUnit);
      acc.expenses += bought * (unitCosts - taxPerUnit + 0) + ads;
      preTaxByStore.set(s.store_id, acc);
    }

    rows.push({
      mp: s.mp, vendor_code: s.vendor_code, mp_sku: s.mp_sku, name: s.name,
      orders: s.orders.size, orderedUnits: s.units, orderedRevenue: s.revenue, price,
      buyoutPct: buyout * 100, buyoutBasis,
      boughtUnits: bought, boughtRevenue,
      cogsPerUnit: baseCost,
      commissionPerUnit: commission, taxPerUnit, acquiringPerUnit: acquiring,
      logisticsPerUnit: logistics, lastMilePerUnit: lastMile, returnLogisticsPerUnit: returnLogistics,
      otherPerUnit: other, feesBasis,
      ads,
      drrOrdered: s.revenue > 0 ? ads / s.revenue * 100 : 0,
      drrBought: boughtRevenue > 0 ? ads / boughtRevenue * 100 : 0,
      profit,
      profitPerUnit: bought > 0 ? profit / bought : 0,
      roi: baseCost != null && cogs * bought > 0 ? profit / (cogs * bought) * 100 : null,
      margin: boughtRevenue > 0 ? profit / boughtRevenue * 100 : 0,
    });
  }

  // 4. Итоги
  const sum = (f: (r: UnitSkuRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const orderedUnits = sum(r => r.orderedUnits);
  const boughtUnits = sum(r => r.boughtUnits);
  const boughtRevenue = sum(r => r.boughtRevenue);
  const cogsTotal = sum(r => (r.cogsPerUnit ?? 0) * r.boughtUnits);

  // Фактические удержания за период
  const factOf = (kinds: string[]) => {
    const list = input.periodCosts.filter(c => kinds.includes(c.kind));
    return list.length ? list.reduce((s, c) => s + c.amount, 0) : null;
  };
  const facts = {
    penalties: factOf(['penalty']),
    storage: factOf(['storage']),
    other: factOf(['service', 'acquiring']),
    included: settings.includeFacts,
  };
  const factsTotal = settings.includeFacts ? (facts.penalties ?? 0) + (facts.storage ?? 0) + (facts.other ?? 0) : 0;

  // Налог с прибыли — по магазину за период
  let profitTax = 0;
  for (const [storeId, acc] of preTaxByStore) {
    const tx = input.taxByStore[storeId];
    profitTax += calcProfitTax(acc.revenueExVat, acc.expenses, tx.rate, minTaxRate(tx.model));
  }
  // Распределяем налог с прибыли по товарам пропорционально выручке выкупа
  if (profitTax > 0 && boughtRevenue > 0) {
    for (const r of rows) {
      const t = profitTax * (r.boughtRevenue / boughtRevenue);
      r.profit -= t;
      if (r.boughtUnits > 0) { r.taxPerUnit += t / r.boughtUnits; r.profitPerUnit = r.profit / r.boughtUnits; }
      r.margin = r.boughtRevenue > 0 ? r.profit / r.boughtRevenue * 100 : 0;
      r.roi = r.cogsPerUnit != null && r.cogsPerUnit * r.boughtUnits > 0 ? r.profit / (r.cogsPerUnit * r.boughtUnits) * 100 : null;
    }
  }

  const profit = sum(r => r.profit) - factsTotal;
  const avgPrice = boughtUnits > 0 ? boughtRevenue / boughtUnits : 0;
  const line = (key: UnitCostLine['key'], label: string, total: number, source: string): UnitCostLine => ({
    key, label, total, source,
    perUnit: boughtUnits > 0 ? total / boughtUnits : 0,
    pctOfPrice: boughtRevenue > 0 ? total / boughtRevenue * 100 : 0,
  });
  const byBought = (f: (r: UnitSkuRow) => number) => sum(r => f(r) * r.boughtUnits);
  const feesSource = skuNoFees === rows.length && rows.length ? 'нет данных'
    : skuFallbackFees + skuNoFees > 0 ? 'факт по товарам + среднее магазина' : 'факт финотчётов по товарам';
  const taxModels = [...new Set(Object.values(input.taxByStore).map(t => t.model))];
  const costs: UnitCostLine[] = [
    line('cogs', 'Себестоимость', cogsTotal, skuNoCost ? `не задана у ${skuNoCost} тов.` : 'из «Себестоимостей»'),
    line('commission', 'Комиссия маркетплейса', byBought(r => r.commissionPerUnit), feesSource),
    line('tax', taxLine(input.taxByStore), byBought(r => r.taxPerUnit), taxModels.map(m => TAX_LABEL[m]).join(', ') || 'не задан'),
    line('acquiring', 'Эквайринг', byBought(r => r.acquiringPerUnit), feesSource),
    line('logistics', 'Прямая логистика', byBought(r => r.logisticsPerUnit), feesSource),
    line('last_mile', 'Последняя миля', byBought(r => r.lastMilePerUnit), feesSource),
    line('return_logistics', 'Обратная логистика по невыкупам', byBought(r => r.returnLogisticsPerUnit), 'факт по невыкупам за опорное окно'),
    line('other', 'Прочие услуги в заказах', byBought(r => r.otherPerUnit), feesSource),
    line('ads', 'Реклама', adsTotal, adsSourceLabel(input.ads.source)),
  ];

  // Реклама — группы и стратегии
  const group = (keyOf: (c: UnitAdCampaign) => string) => {
    const m = new Map<string, number>();
    for (const c of input.ads.campaigns) {
      const k = keyOf(c);
      if (!k || c.money <= 0) continue;
      m.set(k, (m.get(k) ?? 0) + c.money);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, money]) => ({
      label, money,
      drrOrdered: orderedRevenue > 0 ? money / orderedRevenue * 100 : 0,
      drrBought: boughtRevenue > 0 ? money / boughtRevenue * 100 : 0,
    }));
  };
  const bonusMap = new Map<string, number>();
  for (const c of input.ads.campaigns) {
    if (c.bonus > 0) bonusMap.set(c.group, (bonusMap.get(c.group) ?? 0) + c.bonus);
  }
  const groups = group(c => c.group);
  if (input.ads.unassigned > 0.01) {
    groups.push({
      label: input.ads.source === 'manual' ? 'Ручные записи' : 'Реклама из финотчёта',
      money: input.ads.unassigned,
      drrOrdered: orderedRevenue > 0 ? input.ads.unassigned / orderedRevenue * 100 : 0,
      drrBought: boughtRevenue > 0 ? input.ads.unassigned / boughtRevenue * 100 : 0,
    });
  }

  // Сценарий себестоимости
  let scenario: UnitEconResult['scenario'] = null;
  if (settings.scenarioCost != null && settings.scenarioCost >= 0) {
    const sc = settings.scenarioCost;
    const delta = rows.reduce((s, r) => s + ((r.cogsPerUnit ?? 0) - sc) * r.boughtUnits, 0);
    // Налог с прибыли тоже меняется — пересчитываем его по новой базе.
    let taxDelta = 0;
    for (const [storeId, acc] of preTaxByStore) {
      const tx = input.taxByStore[storeId];
      const storeDelta = rows.filter(r => skus.get(skuKey(r.mp, r.vendor_code))?.store_id === storeId)
        .reduce((s, r) => s + ((r.cogsPerUnit ?? 0) - sc) * r.boughtUnits, 0);
      const before = calcProfitTax(acc.revenueExVat, acc.expenses, tx.rate, minTaxRate(tx.model));
      const after = calcProfitTax(acc.revenueExVat, acc.expenses - storeDelta, tx.rate, minTaxRate(tx.model));
      taxDelta += after - before;
    }
    const p = profit + delta - taxDelta;
    const scCogs = sc * boughtUnits;
    scenario = {
      cost: sc, profit: p,
      profitPerUnit: boughtUnits > 0 ? p / boughtUnits : 0,
      roi: scCogs > 0 ? p / scCogs * 100 : null,
    };
  }

  // Нюансы
  const histOrders = history.filter(o => o.status === 'delivered' && o.source === 'real').length;
  if (!rows.length) nuances.push({ level: 'info', text: 'За период нет заказов.' });
  if (histOrders === 0 && rows.length) {
    nuances.push({ level: 'warn', text: 'В опорном окне нет выкупленных заказов с финотчётом — комиссия и логистика не рассчитаны. Нажмите «Обновить», чтобы подтянуть финотчёт.' });
  }
  if (skuNoCost) nuances.push({ level: 'warn', text: `У ${skuNoCost} товар(ов) не задана себестоимость — прибыль по ним завышена, ROI не считается.` });
  if (skuFallbackFees) nuances.push({ level: 'info', text: `${skuFallbackFees} товар(ов) с малой историей: комиссия и логистика взяты средними по магазину.` });
  if (skuNoFees && histOrders > 0) nuances.push({ level: 'warn', text: `${skuNoFees} товар(ов) без истории продаж: удержания маркетплейса не учтены.` });
  if (settings.buyoutMode === 'auto' && skuFallbackBuyout) {
    nuances.push({ level: 'info', text: `${skuFallbackBuyout} товар(ов) — меньше ${settings.minSample} закрытых штук: выкуп взят ${buyoutFallbackLabel(rows)}.` });
  }
  if (input.ads.source === 'none') nuances.push({ level: 'warn', text: 'Реклама не учтена: подключите ключи Ozon Performance в настройках аналитики или добавьте расход вручную.' });
  if (input.ads.source === 'finance') nuances.push({ level: 'info', text: 'Реклама взята из финотчёта маркетплейса: он приходит с задержкой, за свежие дни сумма может быть неполной. Точнее — через ключи Ozon Performance.' });
  if (facts.penalties == null) nuances.push({ level: 'info', text: 'Штрафы за период в финотчёте не найдены — в прибыль не заложены.' });
  if (facts.other == null && facts.storage == null) nuances.push({ level: 'info', text: 'Прочие удержания и хранение за период в финотчёте не найдены — в прибыль не заложены.' });
  if (!settings.includeFacts) nuances.push({ level: 'info', text: 'Фактические штрафы и удержания показаны справочно и в прибыль не входят.' });
  const pending = orders.filter(o => o.status === 'processing' || o.status === 'in_delivery').length;
  if (pending) nuances.push({ level: 'info', text: `${pending} заказ(ов) ещё в обработке или доставке — выкуп по ним прогнозный.` });

  const bonusTotal = [...bonusMap.values()].reduce((s, v) => s + v, 0);
  return {
    orders: orderIds.size,
    orderedUnits,
    orderedRevenue,
    cancelledUnits: [...skus.values()].reduce((s, x) => s + x.cancelledUnits, 0),
    buyoutPct: orderedUnits > 0 ? boughtUnits / orderedUnits * 100 : 0,
    buyoutSource: settings.buyoutMode === 'manual' ? 'задан вручную' : 'по истории выкупа за опорное окно',
    boughtUnits, boughtRevenue, avgPrice,
    ads: {
      source: input.ads.source,
      total: adsTotal,
      bonus: bonusTotal,
      perOrderedUnit: orderedUnits > 0 ? adsTotal / orderedUnits : 0,
      perBoughtUnit: boughtUnits > 0 ? adsTotal / boughtUnits : 0,
      drrOrdered: orderedRevenue > 0 ? adsTotal / orderedRevenue * 100 : 0,
      drrBought: boughtRevenue > 0 ? adsTotal / boughtRevenue * 100 : 0,
      groups,
      strategies: group(c => c.strategy),
      bonusGroups: [...bonusMap.entries()].map(([label, amount]) => ({ label, amount })),
    },
    costs,
    facts,
    profitTax,
    profit,
    profitPerUnit: boughtUnits > 0 ? profit / boughtUnits : 0,
    roi: cogsTotal > 0 ? profit / cogsTotal * 100 : null,
    margin: boughtRevenue > 0 ? profit / boughtRevenue * 100 : 0,
    cogsTotal,
    scenario,
    fbs: input.fbs ?? null,
    skus: rows.sort((a, b) => b.orderedRevenue - a.orderedRevenue),
    nuances,
  };
}

function taxLine(taxByStore: Record<string, StoreTax>): string {
  const t = Object.values(taxByStore);
  if (t.length !== 1) return 'Налоги';
  const { model, rate, vat } = t[0];
  if (model === 'none') return vat > 0 ? `НДС ${+(vat * 100).toFixed(0)}%` : 'Налог';
  const pct = +(rate * 100).toFixed(2);
  const name = model === 'usn6' || model === 'usn15'
    ? `УСН ${String(pct).replace('.', ',')}%${model === 'usn15' ? ' с прибыли' : ''}`
    : `${TAX_LABEL[model]}${pct ? ` ${String(pct).replace('.', ',')}%` : ''}`;
  return `Налог ${name}${vat > 0 ? ` + НДС ${+(vat * 100).toFixed(0)}%` : ''}`;
}

function adsSourceLabel(s: UnitAdsInput['source']): string {
  switch (s) {
    case 'performance': return 'Ozon Performance API';
    case 'finance':     return 'финотчёт маркетплейса';
    case 'manual':      return 'ручные записи';
    default:            return 'не подключено';
  }
}

function buyoutFallbackLabel(rows: UnitSkuRow[]): string {
  const store = rows.some(r => r.buyoutBasis === 'store');
  const none = rows.some(r => r.buyoutBasis === 'none');
  if (store && none) return 'средним по магазину или из настроек';
  return store ? 'средним по магазину' : 'из настроек';
}
