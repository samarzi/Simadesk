/**
 * mpTransactionsDb — CRUD для реальных финансовых транзакций маркетплейсов.
 *
 * Каждая транзакция уникальна по (store_id, mp_transaction_id).
 * Используется для замены прикидочных комиссий/логистики на реальные
 * цифры из финотчётов МП.
 */

import { dbFetch } from './dbClient';
import { companyService } from './companyService';

export type Marketplace = 'ozon' | 'yandex' | 'wb';

/**
 * tx_kind — тип операции транзакции, определяется при синхронизации (не в UI).
 * Руслан code-review: классификация должна быть детерминированной,
 * происходить один раз при синке, а не хрупкой эвристикой в buildAnalytics().
 *
 * sale       — продажа (accruals_for_sale > 0, реальный заказ)
 * return     — возврат покупателя (товар физически возвращён после доставки)
 * cancel     — отмена ДО доставки (заказ не состоялся, товар не дошёл до покупателя)
 *              Не влияет на счётчик заказов И на счётчик возвратов — только расходы.
 *              Отличие от return_svc: cancel относится к конкретному заказу (есть posting_number).
 * return_svc — сервисная операция возврата (логистика назад, утилизация) — НЕ возврат заказа
 * advertising — реклама, продвижение
 * storage    — хранение
 * penalty    — штрафы, компенсации
 * service    — прочие сервисные операции без выручки
 * unknown    — не классифицировано (старые данные, будет обновлено при следующем синке)
 */
export type TxKind = 'sale' | 'return' | 'cancel' | 'return_svc' | 'advertising' | 'storage' | 'penalty' | 'service' | 'unknown';

export interface MpTransaction {
  id?: string;
  company_id?: string;
  store_id: string;
  marketplace: Marketplace;
  mp_transaction_id: string;
  operation_type: string | null;
  operation_type_name: string | null;
  operation_date: string;          // ISO
  posting_number: string | null;
  items_json: Array<{ name: string; sku: number | string; quantity?: number; vendor_code?: string }> | null;
  accruals_for_sale: number;
  sale_commission: number;          // обычно отрицательная
  delivery_charge: number;          // обычно отрицательная
  return_delivery_charge: number;
  services_total: number;
  amount: number;
  /**
   * Тип операции — устанавливается при синхронизации через classifyTransactionKind().
   * null/undefined = старые данные (до миграции), fallback через classifyTransactionKind().
   */
  tx_kind?: TxKind | null;
  raw_json?: any;
  synced_at?: string;
}

export const mpTransactionsDb = {
  /** Получить транзакции по магазинам за период.
   *  Для длинных периодов (> 30 дней) бьём на 30-дневные чанки, чтобы избежать
   *  Postgres statement timeout на больших магазинах (десятки тысяч tx). */
  async getByStores(storeIds: string[], dateFrom: string, dateTo: string): Promise<MpTransaction[]> {
    if (!storeIds.length) return [];
    // authenticated role has statement_timeout=8s — keep chunks small (7 days)
    // so each chunk has ~300-2500 rows and fits within the timeout
    const CHUNK_DAYS = 7;
    const start = new Date(dateFrom).getTime();
    const end   = new Date(dateTo).getTime();
    const spanMs = end - start;

    // Короткий период — один запрос
    if (spanMs <= CHUNK_DAYS * 86400_000) {
      return this._fetchPage(storeIds, dateFrom, dateTo);
    }

    // Длинный период — разбиваем на 7-дневные чанки, параллельно max 4
    const chunks: Array<{ from: string; to: string }> = [];
    let cs = start;
    while (cs < end) {
      const ce = Math.min(cs + CHUNK_DAYS * 86400_000, end);
      chunks.push({ from: new Date(cs).toISOString(), to: new Date(ce).toISOString() });
      cs = ce + 1;
    }

    const results: MpTransaction[][] = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const slice = chunks.slice(i, i + CONCURRENCY);
      const batch = await Promise.all(slice.map(c => this._fetchPage(storeIds, c.from, c.to)));
      results.push(...batch);
    }
    return results.flat();
  },

  /** Внутренний метод: одна страница транзакций с пагинацией. */
  async _fetchPage(storeIds: string[], dateFrom: string, dateTo: string): Promise<MpTransaction[]> {
    const ids = storeIds.join(',');
    const PAGE = 1000;
    let all: MpTransaction[] = [];
    let offset = 0;
    while (true) {
      const batch = await dbFetch<MpTransaction[]>(
        `mp_transactions?store_id=in.(${ids})&operation_date=gte.${encodeURIComponent(dateFrom)}&operation_date=lte.${encodeURIComponent(dateTo)}&order=operation_date.desc&limit=${PAGE}&offset=${offset}`,
      );
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
      // Защита от runaway: не более 50 страниц = 50k транзакций за чанк
      if (offset > 50_000) break;
    }
    return all;
  },

  /** Узнать дату последней синхронизации для магазина. */
  async getLastSync(storeId: string): Promise<string | null> {
    const rows = await dbFetch<Array<{ operation_date: string; synced_at: string }>>(
      `mp_transactions?store_id=eq.${storeId}&select=operation_date,synced_at&order=operation_date.desc&limit=1`,
    );
    if (!rows.length) return null;
    return rows[0].synced_at;
  },

  /** Узнать самую раннюю дату транзакции для магазина. */
  async getEarliestDate(storeId: string): Promise<string | null> {
    const rows = await dbFetch<Array<{ operation_date: string }>>(
      `mp_transactions?store_id=eq.${storeId}&select=operation_date&order=operation_date.asc&limit=1`,
    );
    if (!rows.length) return null;
    return rows[0].operation_date;
  },

  /** Узнать самую позднюю дату транзакции для магазина. */
  async getLatestDate(storeId: string): Promise<string | null> {
    const rows = await dbFetch<Array<{ operation_date: string }>>(
      `mp_transactions?store_id=eq.${storeId}&select=operation_date&order=operation_date.desc&limit=1`,
    );
    if (!rows.length) return null;
    return rows[0].operation_date;
  },

  /** Upsert батч транзакций. Дубликаты игнорируются (resolution=merge-duplicates). */
  async upsertBatch(transactions: MpTransaction[]): Promise<void> {
    if (!transactions.length) return;
    const cid = companyService.getActiveId();
    if (!cid) throw new Error('Нет активной компании');

    // Дедупликация по (store_id, mp_transaction_id) внутри батча.
    // Postgres ON CONFLICT DO UPDATE падает с кодом 21000 если в ОДНОМ INSERT есть
    // дублирующиеся строки с одинаковым constraint-ключом.
    // Ozon Finance API может вернуть одну операцию в нескольких чанках (граничные даты).
    const seen = new Set<string>();
    const deduped: MpTransaction[] = [];
    for (const tx of transactions) {
      const key = `${tx.store_id}__${tx.mp_transaction_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(tx);
      }
    }
    if (deduped.length < transactions.length) {
      console.warn(`[mpTransactionsDb] upsertBatch: удалено ${transactions.length - deduped.length} дублей из ${transactions.length} транзакций`);
    }

    const payload = deduped.map(t => ({ ...t, company_id: cid }));
    // Меньшие батчи (100 вместо 200) — реже ловим ERR_CONNECTION_CLOSED
    // на больших полях items_json. + retry с экспоненциальной задержкой.
    const BATCH = 100;
    for (let i = 0; i < payload.length; i += BATCH) {
      const slice = payload.slice(i, i + BATCH);
      let attempt = 0;
      while (true) {
        try {
          await dbFetch('mp_transactions?on_conflict=store_id,mp_transaction_id', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(slice),
          });
          break;
        } catch (e: any) {
          attempt++;
          const msg = String(e?.message ?? e);
          const retriable = msg.includes('Failed to fetch')
                          || msg.includes('CONNECTION_CLOSED')
                          || msg.includes('504')
                          || msg.includes('502')
                          || msg.includes('500');
          if (!retriable || attempt >= 3) throw e;
          // 400ms → 1200ms → 3600ms
          await new Promise(r => setTimeout(r, 400 * Math.pow(3, attempt - 1)));
          console.warn(`[mpTransactionsDb] upsert retry ${attempt}/3 after: ${msg.slice(0, 100)}`);
        }
      }
    }
  },

  /** Удалить все транзакции магазина (для full re-sync). */
  async clearStore(storeId: string): Promise<void> {
    await dbFetch(`mp_transactions?store_id=eq.${storeId}`, { method: 'DELETE' });
  },

  /** Статистика синхронизации по магазинам. */
  async getSyncStats(storeIds: string[]): Promise<Record<string, { count: number; latest: string | null; earliest: string | null }>> {
    if (!storeIds.length) return {};
    const ids = storeIds.join(',');
    const rows = await dbFetch<Array<{ store_id: string; operation_date: string }>>(
      `mp_transactions?store_id=in.(${ids})&select=store_id,operation_date&order=operation_date.desc&limit=20000`,
    );
    const stats: Record<string, { count: number; latest: string | null; earliest: string | null }> = {};
    for (const id of storeIds) stats[id] = { count: 0, latest: null, earliest: null };
    for (const r of rows) {
      const s = stats[r.store_id];
      if (!s) continue;
      s.count++;
      if (!s.latest || r.operation_date > s.latest) s.latest = r.operation_date;
      if (!s.earliest || r.operation_date < s.earliest) s.earliest = r.operation_date;
    }
    return stats;
  },
};
