/**
 * Wildberries Finance API — отчёт детализации.
 *
 * Эндпоинт: GET /api/v5/supplier/reportDetailByPeriod
 * https://openapi.wildberries.ru/statistics/api/ru/#tag/Otchety/paths/~1api~1v5~1supplier~1reportDetailByPeriod/get
 *
 * Возвращает по каждой строке:
 *   - srid                — ID заказа (sticker)
 *   - nm_id, subject_name — товар
 *   - retail_amount       — выручка
 *   - ppvz_for_pay        — сколько получит продавец
 *   - delivery_rub        — стоимость доставки (логистика)
 *   - commission_percent  — % комиссии
 *   - ppvz_inflicted_for_supplier — штрафы / возмещения
 *   - rrd_id              — ID строки (для пагинации)
 *   - order_dt, sale_dt   — даты
 */

const SUPA_URL = import.meta.env.VITE_SUPA_URL as string;
const SUPA_KEY = import.meta.env.VITE_SUPA_KEY as string;
const WB_PROXY = `${SUPA_URL}/functions/v1/wb-proxy`;

export interface WbFinanceRow {
  realizationreport_id?: number;
  rrd_id: number;
  srid?: string;
  nm_id?: number;
  subject_name?: string;
  brand_name?: string;
  doc_type_name?: string;
  retail_amount?: number;
  ppvz_for_pay?: number;
  delivery_rub?: number;
  commission_percent?: number;
  ppvz_sales_commission?: number;
  ppvz_inflicted_for_supplier?: number;
  retail_price?: number;
  quantity?: number;
  storage_fee?: number;
  order_dt?: string;
  sale_dt?: string;
  rr_dt?: string;
  supplier_oper_name?: string;
  bonus_type_name?: string;
  sa_name?: string;   // Артикул продавца (vendor code)
  ts_name?: string;   // Наименование товара
}

export const wbFinanceApi = {
  /**
   * Получить отчёт детализации за период. Пагинация по rrdid (last row ID).
   * dateFrom / dateTo — RFC3339, например '2026-04-01'.
   */
  async fetchReport(
    apiKey: string,
    dateFrom: string,
    dateTo: string,
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal,
  ): Promise<WbFinanceRow[]> {
    const all: WbFinanceRow[] = [];
    let rrdid = 0;
    const limit = 100_000; // макс по доке

    // Чтобы не уйти в бесконечный цикл при ошибке
    let safety = 0;

    while (safety++ < 50) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const url = `${WB_PROXY}/wb-stats/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&limit=${limit}&rrdid=${rrdid}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': apiKey,
          'Accept': 'application/json',
          'apikey': SUPA_KEY,
        },
        signal,
      });

      if (res.status === 429) {
        // Ждём 60 секунд и пробуем ещё раз (максимум 2 retry)
        if (safety <= 3) {
          console.warn('[WB Finance] 429 rate-limit, ожидание 60 сек...');
          await new Promise(r => setTimeout(r, 60_000));
          continue;
        }
        throw new Error('WB rate-limit (429). API перегружен, попробуйте через несколько минут.');
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`WB Finance ${res.status}: ${text.slice(0, 200)}`);
      }

      const text = await res.text();
      if (!text) break;
      let rows: WbFinanceRow[];
      try { rows = JSON.parse(text); } catch { break; }
      if (!Array.isArray(rows) || rows.length === 0) break;

      all.push(...rows);
      onProgress?.(all.length);

      // Пагинация: последний rrd_id из ответа
      const lastRrdid = rows[rows.length - 1]?.rrd_id ?? 0;
      if (!lastRrdid || lastRrdid === rrdid) break;
      rrdid = lastRrdid;

      // Если получили меньше лимита — конец
      if (rows.length < limit) break;
    }

    return all;
  },
};
