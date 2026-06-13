/**
 * Ozon Finance API — реальные финансовые операции (комиссии, логистика, выплаты).
 *
 * Эндпоинт: POST /v3/finance/transaction/list
 * https://docs.ozon.ru/api/seller/#operation/FinanceAPI_FinanceTransactionListV3
 *
 * Возвращает per-operation:
 *   - accruals_for_sale  — выручка от продажи (положит.)
 *   - sale_commission    — комиссия маркетплейса (отриц.)
 *   - delivery_charge    — стоимость логистики до клиента (отриц.)
 *   - return_delivery_charge — стоимость возвратной логистики
 *   - services[]         — прочие услуги (упаковка, FBO/FBS, реклама внутр.)
 *   - amount             — нетто (сколько Ozon перечислит)
 *   - posting.posting_number — связь с заказом
 */

import { OzonStore } from '@/types/ozon';

type Creds = Pick<OzonStore, 'client_id' | 'api_key'>;

export interface OzonTransaction {
  operation_id: number;
  operation_type: string;
  operation_type_name: string;
  operation_date: string;
  amount: number;
  accruals_for_sale: number;
  sale_commission: number;
  delivery_charge: number;
  return_delivery_charge: number;
  services: Array<{ name: string; price: number }>;
  items: Array<{ name: string; sku: number }>;
  posting?: {
    posting_number: string;
    order_date: string;
    delivery_schema: string;
    warehouse_id?: number;
  };
  type: string;
}

interface TransactionListResponse {
  result: {
    operations: OzonTransaction[];
    page_count: number;
    row_count: number;
  };
}

export const ozonFinanceApi = {
  /**
   * Получить финансовые операции за период.
   * Пагинация: page=1..page_count, до 1000 операций на страницу.
   */
  async fetchTransactions(
    creds: Creds,
    dateFrom: string, // ISO 8601
    dateTo: string,   // ISO 8601
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<OzonTransaction[]> {
    const all: OzonTransaction[] = [];
    let page = 1;
    let totalPages = 1;
    const pageSize = 1000;

    while (page <= totalPages) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const res = await fetch('/ozon-api/v3/finance/transaction/list', {
        method: 'POST',
        headers: {
          'Client-Id': creds.client_id,
          'Api-Key': creds.api_key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: {
            date: { from: dateFrom, to: dateTo },
            operation_type: [],
            posting_number: '',
            transaction_type: 'all',
          },
          page,
          page_size: pageSize,
        }),
        signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ozon Finance ${res.status}: ${text.slice(0, 300)}`);
      }

      const data: TransactionListResponse = await res.json();
      // Ozon иногда возвращает 200 OK с error-телом: { "message": "...", "result": null }
      if (!data.result) {
        const msg = (data as any)?.message ?? (data as any)?.description ?? JSON.stringify(data).slice(0, 200);
        throw new Error(`Ozon Finance API error: ${msg}`);
      }
      const ops = data.result.operations ?? [];
      all.push(...ops);
      totalPages = data.result.page_count ?? 1;
      onProgress?.(all.length, data.result.row_count ?? all.length);
      page++;
    }

    return all;
  },
};
