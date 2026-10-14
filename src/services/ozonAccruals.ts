/**
 * Начисления Ozon — новый финансовый API.
 *
 * 8 сентября 2026 Ozon отключил /v3/finance/transaction/list и /totals (отвечают
 * 404). Замена — /v1/finance/accrual/by-day: начисления за ОДИН день,
 * постранично через last_id; расшифровка типов — /v1/finance/accrual/types.
 *
 * Публичного описания полей ответа нет, поэтому разбор написан с запасом:
 * принимаются известные варианты имён, суммы — числом, строкой или объектом
 * {amount, currency}. Каждое начисление переводится в прежнюю форму
 * MpTransaction (как давал старый метод), чтобы аналитика работала без
 * переделки: выручка, комиссия, услуги по видам, итог и номер отправления.
 *
 * Категории начислений (accrued_category):
 *   POSTING  — по отправлению: выручка, комиссия, логистика по товарам
 *   ITEM     — сборы по товару (эквайринг и т.п.)
 *   NON_ITEM — без товара: хранение, реклама, штрафы, подписки
 */

import type { MpTransaction, TxKind } from './mpTransactionsDb';
import { normalizeMpDate } from '@/utils/mpDate';

/** Сумма из ответа: число, «-21.75», {amount: "-21.75", currency}, {value: ...}. */
export function accrualMoney(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const m = v.match(/-?\d[\d\s]*(?:[.,]\d+)?/);
    if (!m) return 0;
    const n = Number(m[0].replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['amount', 'value', 'accrued', 'price', 'total']) {
      if (o[k] != null) return accrualMoney(o[k]);
    }
  }
  return 0;
}

type TypeName = (id: unknown) => string;

interface Fee { name: string; price: number }

/** Собрать услуги из узла: массив, объект с fees[], вложенные fees[].fees[]. */
function collectFees(node: unknown, typeName: TypeName, out: Fee[], fallback: string): void {
  if (node == null) return;
  if (Array.isArray(node)) { for (const x of node) collectFees(x, typeName, out, fallback); return; }
  if (typeof node !== 'object') return;
  const o = node as Record<string, any>;
  if (Array.isArray(o.fees)) { collectFees(o.fees, typeName, out, fallback); return; }
  if (Array.isArray(o.services)) { collectFees(o.services, typeName, out, fallback); return; }
  const amount = accrualMoney(o.accrued ?? o.amount ?? o.price ?? o.total_amount);
  if (!amount) return;
  const tid = o.type_id ?? o.accrual_type_id ?? o.id;
  out.push({ name: typeName(tid) || o.name || o.description || fallback, price: amount });
}

function classify(name: string, category: string, accruals: number): TxKind {
  const n = name.toLowerCase();
  if (n.includes('отмен') || n.includes('cancel')) return 'cancel';
  if (n.includes('возврат') || n.includes('невыкуп') || n.includes('return')) return accruals < -0.01 ? 'return' : 'return_svc';
  if (category === 'POSTING') {
    if (accruals > 0.01) return 'sale';
    if (accruals < -0.01) return 'return';
  }
  if (n.includes('реклам') || n.includes('продвиж') || n.includes('трафарет') || n.includes('promotion') || n.includes('отзыв')) return 'advertising';
  if (n.includes('хранен') || n.includes('размещен') || n.includes('storage')) return 'storage';
  if (n.includes('штраф') || n.includes('penalty') || n.includes('нарушен')) return 'penalty';
  if (n.includes('выплат') || n.includes('перевод') || n.includes('payout')) return 'payout';
  if (accruals > 0.01) return 'sale';
  return 'service';
}

/** Одно начисление → транзакция в прежней форме. */
export function accrualToTransaction(a: any, typeName: TypeName, storeId: string): MpTransaction | null {
  const id = a?.accrual_id ?? a?.id ?? a?.operation_id;
  if (id == null || id === '') return null;
  const category = String(a?.accrued_category ?? a?.category ?? '').toUpperCase();
  const typeId = a?.type_id ?? a?.accrual_type_id ?? a?.accrual_type?.id;
  const label = String(a?.accrual_type?.name ?? a?.accrual_type?.description ?? a?.name ?? (typeName(typeId) || category || 'Начисление Ozon'));
  const posting = (a?.posting && typeof a.posting === 'object') ? a.posting : {};
  const postingNumber = a?.unit_number ?? posting.posting_number ?? a?.posting_number ?? null;
  const products: any[] = Array.isArray(posting.products) ? posting.products : Array.isArray(a?.products) ? a.products : [];
  const amount = accrualMoney(a?.total_amount ?? a?.amount);

  // Комиссия и услуги — со знаком как в ответе: минус = удержание у продавца.
  let commission = 0;
  let sellerPrice = 0;
  let hasSellerPrice = false;
  const services: Fee[] = [];
  for (const p of products) {
    commission += accrualMoney(p?.commission?.accrued ?? p?.commission?.amount ?? p?.commission);
    collectFees(p?.delivery?.services ?? p?.delivery, typeName, services, 'Логистика');
    collectFees(p?.services, typeName, services, 'Услуга Ozon');
    if (p?.seller_price != null) {
      hasSellerPrice = true;
      sellerPrice += accrualMoney(p.seller_price) * (Number(p?.quantity ?? 1) || 1);
    }
  }
  collectFees(a?.item_fees, typeName, services, label);
  collectFees(a?.non_item_fee, typeName, services, label);
  collectFees(a?.container_fees, typeName, services, 'Услуги по грузоместам');

  const servicesSigned = services.reduce((s, f) => s + f.price, 0);
  // Выручка: явная цена продавца, иначе итог минус удержания.
  let accruals = 0;
  if (products.length) accruals = hasSellerPrice ? sellerPrice : amount - commission - servicesSigned;
  // Начисление без разбивки (хранение, эквайринг одной суммой) — целиком как услуга.
  if (!products.length && !services.length && Math.abs(amount) > 0.001) services.push({ name: label, price: amount });

  const date = normalizeMpDate(String(a?.accrual_date ?? a?.date ?? a?.operation_date ?? '')) || new Date().toISOString();
  const orderDate = posting.order_date ?? a?.order_date ?? null;
  const op = {
    operation_id: id,
    operation_type: String(typeId ?? category),
    operation_type_name: label,
    operation_date: date,
    amount,
    accruals_for_sale: accruals,
    sale_commission: commission,
    delivery_charge: 0,
    return_delivery_charge: 0,
    services,
    posting: { posting_number: postingNumber ?? '', order_date: orderDate },
    accrued_category: category,
    source: 'accrual/by-day',
  };

  return {
    store_id: storeId,
    marketplace: 'ozon',
    mp_transaction_id: String(id),
    operation_type: op.operation_type,
    operation_type_name: label,
    operation_date: date,
    posting_number: postingNumber ? String(postingNumber) : null,
    items_json: products.length ? products.map(p => ({
      name: String(p?.name ?? p?.item?.name ?? ''),
      sku: Number(p?.sku ?? p?.item?.sku ?? p?.product?.sku) || 0,
      vendor_code: p?.offer_id ?? p?.item?.offer_id ?? undefined,
      quantity: Number(p?.quantity ?? p?.qty ?? 1) || 1,
    })) : null,
    accruals_for_sale: accruals,
    sale_commission: commission,
    delivery_charge: 0,
    return_delivery_charge: 0,
    services_total: services.reduce((s, f) => s + Math.abs(f.price), 0),
    amount,
    tx_kind: classify(label, category, accruals),
    raw_json: { ...a, ...op },
  };
}

// ── Сеть ──────────────────────────────────────────────────────────────────

interface Creds { client_id: string; api_key: string }

async function ozonPost(creds: Creds, path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`/ozon-api${path}`, {
      method: 'POST', signal,
      headers: { 'Client-Id': creds.client_id, 'Api-Key': creds.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Ozon: у API-ключа нет доступа к финансам (${res.status}). Создайте ключ с правом «Финансы» или «Admin».`);
    }
    throw new Error(`Ozon ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  throw new Error(`Ozon ${path}: сервис перегружен, повторите позже`);
}

const typesCache = new Map<string, Map<string, string>>();

export async function fetchAccrualTypes(creds: Creds, signal?: AbortSignal): Promise<Map<string, string>> {
  const cached = typesCache.get(creds.client_id);
  if (cached) return cached;
  const map = new Map<string, string>();
  try {
    const r = await ozonPost(creds, '/v1/finance/accrual/types', {}, signal);
    const list: any[] = r?.accrual_types ?? r?.result?.accrual_types ?? r?.types ?? r?.result ?? [];
    if (Array.isArray(list)) {
      for (const t of list) {
        const id = t?.id ?? t?.type_id;
        if (id != null) map.set(String(id), String(t?.description ?? t?.name ?? t?.title ?? ''));
      }
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    console.warn('[Ozon accruals] types unavailable', e);
  }
  typesCache.set(creds.client_id, map);
  return map;
}

/** Все начисления за один московский день «YYYY-MM-DD». */
export async function fetchAccrualsByDay(creds: Creds, day: string, signal?: AbortSignal): Promise<any[]> {
  const out: any[] = [];
  let lastId = '';
  for (let page = 0; page < 500; page++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const r = await ozonPost(creds, '/v1/finance/accrual/by-day', lastId ? { date: day, last_id: lastId } : { date: day }, signal);
    const list: any[] = r?.accruals ?? r?.result?.accruals ?? [];
    out.push(...list);
    const next = String(r?.last_id ?? r?.result?.last_id ?? '');
    const hasNext = r?.has_next ?? r?.result?.has_next;
    if (!list.length || !next || next === lastId || hasNext === false) break;
    lastId = next;
  }
  return out;
}

// ── Какие дни уже загружены ───────────────────────────────────────────────
// Начисления за прошедший день окончательны. Повторно грузим только сегодня,
// вчера и дни, которые синхронизировались, когда ещё не закончились.

const SYNC_KEY = (storeId: string) => `ozon_accrual_days_v1_${storeId}`;

export function daysToSync(storeId: string, days: string[], todayMsk: string): string[] {
  let synced: Record<string, string> = {};
  try { synced = JSON.parse(localStorage.getItem(SYNC_KEY(storeId)) || '{}'); } catch { synced = {}; }
  return days.filter(d => {
    const at = synced[d];
    if (!at) return true;
    const yesterday = new Date(Date.parse(`${todayMsk}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (d >= yesterday) return true;
    // Синкнули в тот же день или на следующий — день мог быть неполным.
    return at.slice(0, 10) <= d || at.slice(0, 10) === new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  });
}

export function markDaySynced(storeId: string, day: string, todayMsk: string): void {
  try {
    const synced: Record<string, string> = JSON.parse(localStorage.getItem(SYNC_KEY(storeId)) || '{}');
    synced[day] = todayMsk;
    localStorage.setItem(SYNC_KEY(storeId), JSON.stringify(synced));
  } catch { /* кеш — не критично */ }
}
