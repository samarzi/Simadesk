/**
 * Yandex Market Finance API — статистика по заказам с разбивкой по комиссиям.
 *
 * Эндпоинт: POST /campaigns/{campaignId}/stats/orders
 * https://yandex.ru/dev/market/partner-api/doc/ru/reference/stats/getOrdersStats
 *
 * Возвращает по каждой позиции заказа:
 *   - id (orderId), creationDate, statusUpdateDate
 *   - items[].priceForCustomer, payments[]
 *   - commissions[] — массив со ставками: FEE, AGENCY, FULFILLMENT, DELIVERY и т.д.
 *   - shipment / payment details
 */

import { YandexStore } from '@/types/yandex';

interface YmStatsOrderResponse {
  result?: {
    orders?: YmStatsOrder[];
    paging?: { nextPageToken?: string };
  };
}

export interface YmStatsOrder {
  id: number;
  creationDate?: string;
  statusUpdateDate?: string;
  status?: string;
  partnerOrderId?: string;
  items?: Array<{
    offerId?: string;       // может отсутствовать
    shopSku?: string;       // артикул продавца
    offerName?: string;     // название товара
    name?: string;          // fallback
    count?: number;
    priceForCustomer?: number;  // может быть пусто
    prices?: Array<{ type: string; costPerItem?: number; total?: number }>;
    commissions?: Array<{ type: string; actual: number }>;
    payments?: Array<{ type: string; date?: string; total?: number }>;
    marketSku?: number;
  }>;
  commissions?: Array<{ type: string; actual: number }>;
  payments?: Array<{ type: string; date?: string; total?: number }>;
  subsidies?: Array<{ amount?: number; type?: string; operationType?: string }>;
}

export const yandexFinanceApi = {
  /**
   * Получить статистику заказов с комиссиями за период.
   * dateFrom / dateTo — формат YYYY-MM-DD.
   */
  async fetchOrderStats(
    store: YandexStore,
    dateFrom: string,
    dateTo: string,
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal,
  ): Promise<YmStatsOrder[]> {
    const all: YmStatsOrder[] = [];
    let pageToken: string | undefined;
    let safety = 0;

    while (safety++ < 100) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (!store.campaign_id) throw new Error('campaign_id не задан');
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (pageToken) params.set('page_token', pageToken);

      // Yandex stats/orders — запрашиваем ТОЛЬКО завершённые заказы со статусами,
      // у которых уже рассчитаны комиссии. Незавершённые заказы (NEW, PROCESSING, DELIVERY)
      // возвращают commissions=[] что приводит к нулевым расходам и завышенной прибыли.
      // DELIVERED/PICKUP — доставлено, PARTIALLY_RETURNED/RETURNED — возвраты,
      // CANCELLED_IN_DELIVERY — отменено после отгрузки (за логистику возврата могут быть расходы).
      const res = await fetch(`/yandex-api/v2/campaigns/${store.campaign_id}/stats/orders?${params}`, {
        method: 'POST',
        headers: {
          'Api-Key': store.api_key,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          dateFrom,
          dateTo,
          statuses: [
            'DELIVERED',
            'PICKUP',
            'PARTIALLY_RETURNED',
            'RETURNED',
            'CANCELLED_IN_DELIVERY',
          ],
          hasCis: false,
          hasParentOrder: false,
        }),
        signal,
      });

      if (!res.ok) {
        const text = await res.text();
        console.error('[YM Finance]', res.status, text.slice(0, 500));
        throw new Error(`YM Finance ${res.status}: ${text.slice(0, 200)}`);
      }

      const data: YmStatsOrderResponse = await res.json();
      const orders = data.result?.orders ?? [];
      all.push(...orders);
      onProgress?.(all.length);

      pageToken = data.result?.paging?.nextPageToken;
      if (!pageToken) break;
    }

    return all;
  },
};
