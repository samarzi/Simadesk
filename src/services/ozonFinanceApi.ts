/**
 * Ozon Finance API — реальные финансовые операции (комиссии, логистика, выплаты).
 *
 * Финансовые операции теперь грузит ozonAccruals.ts (/v1/finance/accrual/by-day):
 * метод /v3/finance/transaction/list Ozon отключил 8.09.2026. Здесь остались
 * баланс кошелька и тип OzonTransaction — форма, в которую переводятся начисления.
 *
 * Было: POST /v3/finance/transaction/list
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

export interface OzonTreasuryTotals {
  /** Текущий баланс кошелька (руб). */
  balance: number;
  /** Заблокировано (резерв). */
  lock: number;
  /** Начислено, ещё не выплачено. */
  reward: number;
}

export const ozonFinanceApi = {
  /**
   * Баланс кошелька продавца.
   * Пробуем v2 (новый путь), затем v1 (старый).
   * Если оба вернули 404 — эндпоинт недоступен для данного типа API-ключа.
   */
  async fetchTreasuryTotals(creds: Creds, signal?: AbortSignal): Promise<OzonTreasuryTotals> {
    const tryEndpoint = async (path: string): Promise<Response> => {
      return fetch(`/ozon-api${path}`, {
        method: 'POST',
        headers: {
          'Client-Id': creds.client_id,
          'Api-Key': creds.api_key,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal,
      });
    };

    let res = await tryEndpoint('/v2/finance/treasury/totals');
    if (res.status === 404) {
      res = await tryEndpoint('/v1/finance/treasury/totals');
    }

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Ozon не предоставляет API для баланса кошелька — проверьте кабинет продавца');
      }
      const text = await res.text();
      const msg = (text.slice(0, 200) || String(res.status));
      throw new Error(`Ошибка Ozon (${res.status}): ${msg}`);
    }

    const data = await res.json();
    const r = data?.result ?? data;
    return {
      balance: Number(r?.balance ?? r?.total_balance ?? 0),
      lock:    Number(r?.lock ?? r?.locked_amount ?? 0),
      reward:  Number(r?.reward ?? r?.pending_amount ?? 0),
    };
  },
};
