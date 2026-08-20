/**
 * API клиент Яндекс Маркета.
 * docs: https://yandex.ru/dev/market/partner-api/doc/ru
 * Авторизация: HTTP заголовок `Api-Key: <token>`
 */

import { YandexOrder, YandexOrderItem, YandexStore, YandexProduct } from '@/types/yandex';
import { fromYm } from './dimensionsUnit';
import { debug } from '@/utils/debug';

/** Extract a human-readable message from an unknown catch value. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface YandexFeedback {
  id: string;
  createdAt: string;
  rating: number;
  authorName: string;
  text: string;
  advantages: string;
  disadvantages: string;
  productName: string;
  productPhoto: string;
  reviewPhotos?: string[];
  reviewVideo?: string;
  orderId?: string;
  productSku?: string;
  answerText: string | null;
  state: string;
}

const PROXY = '/yandex-api';

const RETRYABLE = new Set([429, 500, 502, 503]);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

/** Универсальный HTTP-запрос к Яндекс Маркету с экспоненциальным retry. */
async function yandexFetch<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal,
  retries = 5,
): Promise<T> {
  let lastErr: Error = new Error('unknown');

  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (attempt > 0) {
      const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 32000);
      await sleep(delay, signal);
    }

    let res: Response;
    try {
      res = await fetch(`${PROXY}${path}`, {
        method,
        headers: {
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 204 || !ct.includes('application/json')) {
        try { return await res.json() as T; } catch { return undefined as T; }
      }
      return res.json() as Promise<T>;
    }

    const text = await res.text();
    console.error(`[Yandex API] ${method} ${path} → ${res.status}:`, text.slice(0, 300));
    lastErr = new Error(`Yandex ${res.status} (${path}): ${text.slice(0, 150)}`);
    if (!RETRYABLE.has(res.status)) throw lastErr;
  }

  throw lastErr;
}

// ─── Маппинг сырого ответа Yandex → наш тип ────────────────────────────────────

function mapOrder(raw: any, storeId: string): YandexOrder {
  const items: YandexOrderItem[] = (raw.items ?? []).map((it: any) => ({
    offer_id: it.offerId ?? it.shopSku ?? it.offer_id ?? '',
    name: it.offerName ?? it.name ?? '',
    count: Number(it.count) || 0,
    price: parseFloat(it.price ?? it.buyerPrice ?? '0') || 0,
    currency_code: it.currency ?? raw.currency ?? 'RUR',
  }));

  return {
    id: raw.id,
    status: raw.status,
    substatus: raw.substatus ?? null,
    creation_date: raw.creationDate ?? raw.creation_date ?? '',
    delivery_date: raw.delivery?.deliveryDate ?? raw.delivery?.dates?.toDate ?? null,
    items,
    total: items.reduce((s, i) => s + i.price * i.count, 0),
    currency_code: raw.currency ?? items[0]?.currency_code ?? 'RUR',
    store_id: storeId,
    delivery_type: raw.delivery?.type ?? raw.deliveryType ?? undefined,
    delivery_region: raw.delivery?.region?.name ?? null,
    buyer_total: raw.buyerTotal ?? raw.buyerItemsTotal ?? null,
  };
}

// ─── Публичный API ─────────────────────────────────────────────────────────────

export const yandexApi = {
  /**
   * GET /v2/campaigns — проверка токена через список магазинов.
   * /v2/auth/token не существует в Yandex Market API; авторизация через Api-Key заголовок.
   * Если запрос прошёл — ключ валиден.
   */
  async checkToken(apiKey: string, signal?: AbortSignal): Promise<any> {
    return yandexFetch('/v2/campaigns', 'GET', apiKey, undefined, signal);
  },

  /**
   * GET /v2/campaigns — список магазинов (campaigns) продавца.
   * Возвращает [{id, domain, business: {id, name}, placementType}].
   */
  async getCampaigns(apiKey: string, signal?: AbortSignal): Promise<any[]> {
    const resp = await yandexFetch<any>('/v2/campaigns', 'GET', apiKey, undefined, signal);
    return resp.campaigns ?? [];
  },

  /**
   * PUT /businesses/{businessId}/offer-mappings — обновление отдельных полей оффера (название и т.д.)
   */
  async updateOfferName(
    apiKey: string,
    businessId: number,
    offerId: string,
    name: string,
  ): Promise<void> {
    await yandexFetch(
      `/businesses/${businessId}/offer-mappings/update`,
      'POST', apiKey,
      { offerMappings: [{ offer: { offerId, name } }] },
    );
  },

  /**
   * POST /businesses/{businessId}/offer-mappings/update — обновление произвольных полей оффера.
   * offer — объект с полями offerId + любые изменяемые поля (name, description, vendor, parameterValues и т.д.)
   */
  async updateOffer(
    apiKey: string,
    businessId: number,
    offer: Record<string, any>,
  ): Promise<void> {
    await yandexFetch(
      `/businesses/${businessId}/offer-mappings/update`,
      'POST', apiKey,
      { offerMappings: [{ offer }] },
    );
  },

  /**
   * POST /v2/businesses/{businessId}/offer-mappings — карточка одного оффера по offerId
   * (для ленивой подгрузки описания/штрихкодов в редакторе).
   */
  async getOfferMapping(
    apiKey: string,
    businessId: number,
    offerId: string,
    signal?: AbortSignal,
  ): Promise<any | null> {
    const resp = await yandexFetch<any>(
      `/v2/businesses/${businessId}/offer-mappings?limit=1`,
      'POST', apiKey, { offerIds: [offerId] }, signal,
    );
    const offers = resp.result?.offerMappings ?? [];
    return offers[0]?.offer ?? null;
  },

  /**
   * POST /v2/businesses/{businessId}/offer-mappings — список товаров.
   * Cursor-пагинация через result.paging.nextPageToken.
   */
  async getOfferMappings(
    apiKey: string,
    businessId: number,
    pageToken: string,
    signal?: AbortSignal,
  ): Promise<{ offers: any[]; nextPageToken: string }> {
    const qs = new URLSearchParams({ limit: '100' });
    if (pageToken) qs.set('page_token', pageToken);
    const resp = await yandexFetch<any>(
      `/v2/businesses/${businessId}/offer-mappings?${qs.toString()}`,
      'POST', apiKey, {}, signal,
    );
    const offers = resp.result?.offerMappings ?? [];
    const nextPageToken = resp.result?.paging?.nextPageToken ?? '';
    return { offers, nextPageToken };
  },

  /**
   * POST /v2/campaigns/{campaignId}/offers/stocks — остатки по складам.
   */
  async getStocks(
    apiKey: string,
    campaignId: number,
    pageToken: string,
    signal?: AbortSignal,
  ): Promise<{ warehouses: any[]; nextPageToken: string }> {
    const body: any = { withTurnover: false };
    if (pageToken) body.pageToken = pageToken;
    const resp = await yandexFetch<any>(
      `/v2/campaigns/${campaignId}/offers/stocks`,
      'POST', apiKey, body, signal,
    );
    return {
      warehouses: resp.result?.warehouses ?? [],
      nextPageToken: resp.result?.paging?.nextPageToken ?? '',
    };
  },

  /**
   * PUT /v2/campaigns/{campaignId}/orders/{orderId}/status — изменить статус заказа.
   * Статусы: PROCESSING, DELIVERY, CANCELLED и т.п. Для FBS-отгрузки → DELIVERY с substatus READY_TO_SHIP.
   */
  async setOrderStatus(
    store: YandexStore,
    orderId: number | string,
    status: string,
    substatus?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    if (!store.campaign_id) throw new Error('campaign_id не задан');
    const body: any = { order: { status } };
    if (substatus) body.order.substatus = substatus;
    // Yandex API использует PUT, а не POST — кастомный fetch
    const res = await fetch(`${PROXY}/v2/campaigns/${store.campaign_id}/orders/${orderId}/status`, {
      method: 'PUT',
      headers: {
        'Api-Key': store.api_key,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Yandex ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  },

  /**
   * GET /v2/campaigns/{campaignId}/orders/{orderId}/delivery/labels — PDF ярлыков заказа.
   */
  async getOrderLabelPdf(
    store: YandexStore,
    orderId: number | string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (!store.campaign_id) throw new Error('campaign_id не задан');
    const res = await fetch(`${PROXY}/v2/campaigns/${store.campaign_id}/orders/${orderId}/delivery/labels`, {
      method: 'GET',
      headers: { 'Api-Key': store.api_key, 'Accept': 'application/pdf' },
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Yandex ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.blob();
  },

  /**
   * GET /v2/campaigns/{campaignId}/orders/{orderId} — детальная информация о заказе.
   * Возвращает полный объект: items, delivery, buyer, fulfilment, payment.
   */
  async getOrderDetail(
    store: YandexStore,
    orderId: number | string,
    signal?: AbortSignal,
  ): Promise<any> {
    if (!store.campaign_id) throw new Error('campaign_id не задан');
    const resp = await yandexFetch<any>(
      `/v2/campaigns/${store.campaign_id}/orders/${orderId}`,
      'GET', store.api_key, undefined, signal,
    );
    return resp.order ?? resp;
  },

  /**
   * Получение заказов магазина. Использует deprecated, но рабочий endpoint
   * GET /v2/campaigns/{campaignId}/orders с параметрами в URL.
   * Современный POST /v1/businesses/{businessId}/orders требует businessId,
   * который не всегда удобно получать; campaignId доступен сразу.
   *
   * Cursor-based пагинация через nextPageToken.
   */
  async getOrders(
    store: YandexStore,
    fromDate: string,           // YYYY-MM-DD
    toDate: string,             // YYYY-MM-DD
    pageToken: string,          // '' для первой страницы
    signal?: AbortSignal,
  ): Promise<{ orders: YandexOrder[]; nextPageToken: string }> {
    if (!store.campaign_id) {
      throw new Error('campaign_id магазина не указан');
    }
    const qs = new URLSearchParams({
      fromDate,
      toDate,
      limit: '50',
    });
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = await yandexFetch<any>(
      `/v2/campaigns/${store.campaign_id}/orders?${qs.toString()}`,
      'GET',
      store.api_key,
      undefined,
      signal,
    );
    const raw: any[] = resp.orders ?? [];
    const orders = raw.map(r => mapOrder(r, store.id));
    const nextPageToken: string = resp.paging?.nextPageToken ?? '';
    return { orders, nextPageToken };
  },
  /**
   * GET /v2/campaigns/{campaignId}/offer-prices — текущие цены офферов.
   * Возвращает Map<offerId, { price, discountBase? }> — цена покупателя на ЯМ.
   */
  async getOfferPrices(
    apiKey: string,
    campaignId: string,
  ): Promise<Map<string, { price: number; discountBase?: number }>> {
    const result = new Map<string, { price: number; discountBase?: number }>();
    let pageToken: string | undefined;
    const MAX_PAGES = 50;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ pageSize: '200' });
      if (pageToken) params.set('page_token', pageToken);
      try {
        const resp = await yandexFetch<any>(
          `/v2/campaigns/${campaignId}/offer-prices?${params}`,
          'GET', apiKey,
        );
        const items: any[] = resp.result?.items ?? [];
        for (const item of items) {
          const offerId = item.id ?? item.offerId ?? '';
          const price = Number(item.price?.value ?? 0);
          const discountBase = item.price?.discountBase ? Number(item.price.discountBase) : undefined;
          if (offerId && price > 0) result.set(offerId, { price, discountBase });
        }
        pageToken = resp.result?.paging?.nextPageToken;
        if (!pageToken || items.length === 0) break;
      } catch { break; }
    }
    return result;
  },

  async updateOfferPrices(
    apiKey: string,
    campaignId: string,
    offers: Array<{ offerId: string; price: number; oldPrice?: number; clearDiscountBase?: boolean }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const businessId = await this.getBusinessIdOrThrow(apiKey, Number(campaignId));

    const buildDiscountBase = (o: { price: number; oldPrice?: number; clearDiscountBase?: boolean }) => {
      if (o.clearDiscountBase) return {}; // явно не отправляем — ЯМ сбросит зачёркнутую цену
      const discountPct = o.oldPrice ? (o.oldPrice - o.price) / o.oldPrice * 100 : 0;
      const validDiscount = discountPct >= 5 && discountPct <= 99;
      return validDiscount ? { discountBase: o.oldPrice } : {};
    };

    // Метод 1: offer-mappings/update — обновляем basicPrice (основная цена товара в каталоге,
    // именно её видит покупатель когда кампания настроена на «использовать цену прайс-листа»)
    const mappingsBody = {
      offerMappings: offers.map(o => ({
        offer: {
          offerId: o.offerId,
          basicPrice: {
            value: o.price,
            currencyId: 'RUR',
            ...buildDiscountBase(o),
          },
        },
      })),
    };

    // Метод 2: offer-prices/updates — переопределяет цену на уровне бизнеса
    const pricesBody = {
      offers: offers.map(o => ({
        offerId: o.offerId,
        price: {
          value: o.price,
          currencyId: 'RUR',
          ...buildDiscountBase(o),
        },
      })),
    };

    // Вызываем оба метода — у разных типов кампаний работает разный
    await Promise.all([
      yandexFetch(`/v2/businesses/${businessId}/offer-mappings/update`, 'POST', apiKey, mappingsBody, signal)
        .catch(e => console.warn('[YM] offer-mappings/update failed:', (e instanceof Error ? e.message : String(e)))),
      yandexFetch(`/v2/businesses/${businessId}/offer-prices/updates`, 'POST', apiKey, pricesBody, signal)
        .catch(e => console.warn('[YM] offer-prices/updates failed:', (e instanceof Error ? e.message : String(e)))),
    ]);
  },

  /**
   * Убрать товары из всех активных промо-акций на Яндекс.Маркете.

   * Вызывать ДО/ПОСЛЕ обновления цены через updateOfferPrices.
   */
  async removeOffersFromAllPromos(
    apiKey: string,
    businessId: number,
    offerIds: string[],
  ): Promise<void> {
    if (!offerIds.length) return;
    try {
      // Получаем список всех активных промо
      const resp = await yandexFetch<any>(
        `/v2/businesses/${businessId}/promos`,
        'POST',
        apiKey,
        { statuses: ['ACTIVE', 'UPCOMING'] },
      );
      const promos: any[] = resp?.promos ?? [];
      if (!promos.length) return;

      // Для каждого промо убираем наши товары
      await Promise.all(promos.map(async (promo: any) => {
        const promoId: string = promo.id;
        try {
          await yandexFetch(
            `/v2/businesses/${businessId}/promos/offers/delete`,
            'POST',
            apiKey,
            { promoId, deleteAllOffers: false, offerIds },
          );
        } catch (e: unknown) {
          // Некоторые промо могут не поддерживать ручное удаление — игнорируем
          console.warn(`[YM] removeOffersFromAllPromos: promo ${promoId} skip:`, errMsg(e));
        }
      }));
    } catch (e: unknown) {
      console.warn('[YM] removeOffersFromAllPromos failed:', errMsg(e));
    }
  },

  /**
   * Получить business_id по campaign_id через GET /v2/campaigns/{campaignId}
   */
  async getBusinessId(apiKey: string, campaignId: number): Promise<number | null> {
    try {
      const resp = await yandexFetch<any>(`/v2/campaigns/${campaignId}`, 'GET', apiKey);
      return resp?.campaign?.business?.id ?? null;
    } catch { return null; }
  },

  /**
   * Получить отзывы на товары через актуальный API:
   * GET /businesses/{businessId}/goods-feedback (новый, требует business_id)
   * Fallback: GET /campaigns/{campaignId}/feedback/updates (старый, часто 404)
   */
  async getFeedbacks(
    apiKey: string,
    campaignId: number,
    pageToken?: string,
    signal?: AbortSignal,
    businessId?: number | null,
  ): Promise<{ feedbacks: YandexFeedback[]; nextPageToken: string }> {
    // Пробуем новый endpoint через business_id
    // YM API: POST /businesses/{businessId}/goods-feedback (не GET!)
    if (businessId) {
      try {
        const body: Record<string, any> = {
          pageRequest: { count: 100, ...(pageToken ? { pageToken } : {}) },
        };
        const resp = await yandexFetch<any>(
          `/businesses/${businessId}/goods-feedback`,
          'POST', apiKey, body, signal,
        );
        // YM API: реальные поля ответа /businesses/{id}/goods-feedback
        // — feedbackId, createdAt, statistics.rating, description.{advantages,disadvantages,comment},
        //   author (строка), identifiers.modelId, media.photos[], shopFeedback.text
        const items: any[] = resp.result?.feedbacks ?? resp.feedbacks ?? [];
        const feedbacks: YandexFeedback[] = items.map((u: any) => {
          const desc = u.description ?? u.comment ?? {};
          const adv  = desc.advantages ?? u.advantages ?? '';
          const dis  = desc.disadvantages ?? u.disadvantages ?? '';
          const txt  = desc.comment ?? desc.text ?? u.text ?? '';
          // Автор может быть строкой или объектом
          let authorName = 'Покупатель';
          if (typeof u.author === 'string') authorName = u.author;
          else if (u.author?.name) authorName = u.author.name;
          else if (u.author?.login) authorName = u.author.login;
          // Извлекаем все фото из media.photos (массив объектов с url)
          const allPhotos: string[] = Array.isArray(u.media?.photos)
            ? u.media.photos.map((p: any) => p?.url ?? p?.photoUrl ?? p).filter(Boolean)
            : [];
          const productPhoto = u.product?.photoUrl ?? u.sku?.imageUrl ?? allPhotos[0] ?? '';
          // Покупательские фото: всё кроме фото товара
          const reviewPhotos = allPhotos.filter(url => url !== productPhoto);
          return {
            id: String(u.feedbackId ?? u.id ?? Math.random()),
            createdAt: u.createdAt ?? u.created_at ?? new Date().toISOString(),
            rating: Number(u.statistics?.rating ?? u.statistics?.overallRating ?? u.rating ?? 0),
            authorName,
            text: [adv && `Плюсы: ${adv}`, dis && `Минусы: ${dis}`, txt].filter(Boolean).join('\n').trim(),
            advantages: adv,
            disadvantages: dis,
            productName: u.product?.name ?? u.sku?.name ?? (u.identifiers?.modelId ? `Товар #${u.identifiers.modelId}` : ''),
            productPhoto,
            reviewPhotos,
            reviewVideo: u.media?.videos?.[0]?.url ?? '',
            orderId: u.identifiers?.orderId ?? u.orderId ?? '',
            productSku: u.identifiers?.shopSku ?? u.identifiers?.modelId ? String(u.identifiers?.shopSku ?? u.identifiers?.modelId) : '',
            answerText: u.shopFeedback?.text ?? u.shop?.comment?.text ?? u.shop?.response ?? null,
            state: u.state ?? (u.needReaction ? 'NEED_REACTION' : 'PROCESSED'),
          };
        });
        return {
          feedbacks,
          nextPageToken: resp.result?.paging?.nextPageToken ?? resp.paging?.nextPageToken ?? '',
        };
      } catch (err: unknown) {
        const msg = errMsg(err);
        if (msg.includes('403') || msg.includes('401')) {
          throw new Error('Нет доступа к отзывам Яндекс Маркет. Проверьте API-ключ и настройки магазина.');
        }
        // 404/405 — попробуем старый endpoint как fallback
        if (!msg.includes('404') && !msg.includes('405')) throw err;
      }
    }

    // Fallback: старый endpoint /v2/campaigns/{campaignId}/feedback/updates
    try {
      const qs = new URLSearchParams({ count: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const resp = await yandexFetch<any>(
        `/v2/campaigns/${campaignId}/feedback/updates?${qs}`,
        'GET', apiKey, undefined, signal,
      );
      const updates: any[] = resp.result?.updates ?? resp.updates ?? [];
      const feedbacks: YandexFeedback[] = updates.map((u: any) => ({
        id: String(u.feedbackId ?? u.id ?? Math.random()),
        createdAt: u.createdAt ?? u.created_at ?? new Date().toISOString(),
        rating: Number(u.rating ?? u.grade ?? 0),
        authorName: u.author?.name ?? u.author?.login ?? 'Покупатель',
        text: [u.advantages, u.disadvantages, u.text].filter(Boolean).join('\n').trim(),
        advantages: u.advantages ?? '',
        disadvantages: u.disadvantages ?? '',
        productName: u.sku?.name ?? u.product?.name ?? '',
        productPhoto: u.sku?.photo ?? u.sku?.imageUrl ?? '',
        answerText: u.shop?.response ?? null,
        state: u.state ?? 'UNREAD',
      }));
      return {
        feedbacks,
        nextPageToken: resp.result?.paging?.nextPageToken ?? resp.paging?.nextPageToken ?? '',
      };
    } catch (err: unknown) {
      const msg = errMsg(err);
      if (msg.includes('404')) return { feedbacks: [], nextPageToken: '' };
      if (msg.includes('403') || msg.includes('401') || msg.includes('PermissionDenied')) {
        throw new Error('Нет доступа к отзывам Яндекс Маркет. Проверьте API-ключ и campaign_id в настройках магазина.');
      }
      throw err;
    }
  },

  /**
   * Yandex Goods Feedback Comments API:
   *   POST /businesses/{businessId}/goods-feedback/comments
   *   { feedbackId: Int64, comment: { text: string } }
   *
   * ⚠ feedbackId должен быть ЧИСЛОМ (Int64), не строкой!
   */
  async replyFeedback(
    apiKey: string,
    campaignId: number,
    feedbackId: string,
    text: string,
    signal?: AbortSignal,
    businessId?: number | null,
  ): Promise<void> {
    // feedbackId — Int64, не конвертируем в number чтобы не потерять точность
    if (!feedbackId || feedbackId === '0') {
      throw new Error(`Некорректный feedbackId: "${feedbackId}"`);
    }
    debug.log(`[YM replyFeedback] → businessId=${businessId} feedbackId=${feedbackId} mp=${campaignId ? 'campaign:'+campaignId : 'unknown'}`);
    if (businessId) {
      let firstErr: any = null;
      try {
        await yandexFetch(
          `/businesses/${businessId}/goods-feedback/${feedbackId}/response`,
          'POST', apiKey,
          { text },
          signal,
        );
        debug.log(`[YM replyFeedback] ✓ success via new endpoint`);
        return;
      } catch (e) {
        firstErr = e;
        debug.warn('[YM replyFeedback] new endpoint failed:', (e as any)?.message);
        const msg = String((e as any)?.message ?? '');
        if (msg.includes('403') || msg.includes('Forbidden') || msg.includes('Permission')) {
          throw e;
        }
      }
      try {
        await yandexFetch(
          `/v2/campaigns/${campaignId}/feedback/updates/${feedbackId}/respond`,
          'POST', apiKey, { text }, signal,
        );
        debug.log(`[YM replyFeedback] ✓ success via old endpoint`);
      } catch (e2: any) {
        console.error(`[YM replyFeedback] ✗ both endpoints failed`, firstErr?.message, e2?.message);
        throw firstErr ?? e2;
      }
      return;
    }
    console.warn(`[YM replyFeedback] businessId is null — using old endpoint`);
    await yandexFetch(
      `/v2/campaigns/${campaignId}/feedback/updates/${feedbackId}/respond`,
      'POST', apiKey, { text }, signal,
    );
  },

  // ── Чаты с покупателями ───────────────────────────────────────────────────
  // ⚠ API-ключ должен иметь право «Общение с покупателями» (communication).
  // Chat API v2 работает через businessId (не campaignId) — сначала находим
  // businessId магазина через GET /v2/campaigns/{campaignId} (см. getBusinessId выше).

  /** Определить businessId магазина или бросить ошибку (для чатов он обязателен). */
  async getBusinessIdOrThrow(apiKey: string, campaignId: number): Promise<number> {
    const businessId = await this.getBusinessId(apiKey, campaignId);
    if (!businessId) throw new Error(`Не удалось определить businessId для campaign ${campaignId}`);
    return businessId;
  },

  /** POST /v2/businesses/{businessId}/chats — список чатов. */
  async getChats(apiKey: string, campaignId: number, signal?: AbortSignal): Promise<YandexChat[]> {
    const businessId = await this.getBusinessIdOrThrow(apiKey, campaignId);
    const resp = await yandexFetch<any>(
      `/v2/businesses/${businessId}/chats`,
      'POST', apiKey, { pageToken: '', limit: 50 }, signal, 2,
    );
    const chats: any[] = resp?.result?.chats ?? resp?.chats ?? [];
    return chats.map((c: any): YandexChat => ({
      chatId: String(c.chatId ?? c.id),
      topic: c.context?.customer?.name ?? c.topic ?? c.type ?? '',
      orderId: c.context?.orderId != null ? String(c.context.orderId) : (c.orderId != null ? String(c.orderId) : undefined),
      lastMessageText: c.lastMessage?.text ?? c.lastMessageText ?? '',
      lastMessageTime: c.lastMessage?.createdAt ?? c.updatedAt ?? c.createdAt ?? '',
      unreadCount: c.unreadMessageCount ?? c.unreadCount ?? 0,
    }));
  },

  /** POST /v2/businesses/{businessId}/chats/history — история сообщений чата. */
  async getChatHistory(apiKey: string, campaignId: number, chatId: string, signal?: AbortSignal, limit = 100): Promise<YandexChatMessage[]> {
    const businessId = await this.getBusinessIdOrThrow(apiKey, campaignId);
    const numericChatId = Number(chatId) || chatId;
    const resp = await yandexFetch<any>(
      `/v2/businesses/${businessId}/chats/history?chatId=${numericChatId}`,
      'POST', apiKey, { chatId: numericChatId, pageToken: '', limit }, signal, 2,
    );
    const messages: any[] = resp?.result?.messages ?? resp?.messages ?? [];
    return messages.map((m: any): YandexChatMessage => {
      // sender: 'PARTNER' (мы) | 'USER'/'CUSTOMER' (покупатель) | 'MARKET'/'SUPPORT' (системные/поддержка).
      const senderType = String(m.author?.type ?? m.sender ?? '').toUpperCase();
      const attachments: { name: string; url: string }[] = Array.isArray(m.payload)
        ? m.payload.map((p: any) => ({ name: p.name ?? '', url: p.url ?? '' })).filter((a: any) => a.url)
        : [];
      return {
        messageId: String(m.messageId ?? m.id ?? ''),
        text: m.message ?? m.text ?? '',
        attachments,
        fromSeller: senderType === 'PARTNER' || senderType === 'BUSINESS' || senderType === 'SELLER',
        isSystem: senderType === 'MARKET',
        senderLabel: senderType === 'SUPPORT' ? 'Поддержка Маркетплейса' : undefined,
        createdAt: m.createdAt ?? m.created_at ?? '',
      };
    }).reverse(); // от старых к новым
  },

  /** POST /v2/businesses/{businessId}/chats/message — отправить сообщение. */
  async sendChatMessage(apiKey: string, campaignId: number, chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    const businessId = await this.getBusinessIdOrThrow(apiKey, campaignId);
    const numericChatId = Number(chatId) || chatId;
    await yandexFetch<any>(
      `/v2/businesses/${businessId}/chats/message?chatId=${numericChatId}`,
      'POST', apiKey, { message: { text } }, signal, 1,
    );
  },

  /**
   * PUT /v2/campaigns/{campaignId}/offers/stocks — обновление остатков ЯМ.
   */
  async updateStocks(
    apiKey: string,
    campaignId: number,
    skus: Array<{ sku: string; warehouseId: number; items: Array<{ count: number; type: string; updatedAt: string }> }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${PROXY}/v2/campaigns/${campaignId}/offers/stocks`, {
      method: 'PUT',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ skus }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`YM stocks update ${res.status}: ${text.slice(0, 200)}`);
    }
  },

  /**
   * POST /v2/businesses/{businessId}/offer-mappings/create — создание товаров.
   */
  async createOffers(
    apiKey: string,
    businessId: number,
    offers: Array<{
      offerId: string;
      name: string;
      categoryId: number;
      pictures?: string[];
      vendor?: string;
      description?: string;
      barcodes?: string[];
      weightDimensions?: { length: number; width: number; height: number; weight: number };
    }>,
    signal?: AbortSignal,
  ): Promise<void> {
    await yandexFetch(
      `/v2/businesses/${businessId}/offer-mappings/create`,
      'POST', apiKey,
      { offerMappings: offers.map(o => ({ offer: o })) },
      signal,
    );
  },

  /**
   * POST /v2/businesses/{businessId}/offers/delete — удаление товаров.
   */
  async deleteOffers(
    apiKey: string,
    businessId: number,
    offerIds: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await yandexFetch(
      `/v2/businesses/${businessId}/offers/delete`,
      'POST', apiKey, { offerIds }, signal,
    );
  },

  /**
   * GET /v2/category/tree — дерево категорий ЯМ.
   */
  async getCategoryTree(apiKey: string, signal?: AbortSignal): Promise<any[]> {
    const resp = await yandexFetch<any>('/v2/category/tree', 'GET', apiKey, undefined, signal);
    return resp.result?.categories ?? [];
  },

  /**
   * GET /v2/category/{categoryId}/parameters — параметры категории.
   */
  async getCategoryParameters(
    apiKey: string,
    categoryId: number,
    signal?: AbortSignal,
  ): Promise<any[]> {
    const resp = await yandexFetch<any>(
      `/v2/category/${categoryId}/parameters`,
      'GET', apiKey, undefined, signal,
    );
    return resp.result?.parameters ?? [];
  },

  /**
   * POST /v2/businesses/{businessId}/offer-mappings/suggestions — автоподбор категории.
   */
  async suggestCategory(
    apiKey: string,
    businessId: number,
    offerName: string,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const resp = await yandexFetch<any>(
      `/v2/businesses/${businessId}/offer-mappings/suggestions`,
      'POST', apiKey, { offers: [{ name: offerName }] }, signal,
    );
    const suggestions = resp.result?.offers?.[0]?.categoryId;
    return suggestions ?? null;
  },

  /**
   * POST /v2/campaigns/{campaignId}/stats/skus — статистика по товарам (клики, показы).
   */
  async getSkuStats(
    apiKey: string,
    campaignId: number,
    dateFrom: string, // YYYY-MM-DD
    dateTo: string,
    signal?: AbortSignal,
  ): Promise<any[]> {
    const resp = await yandexFetch<any>(
      `/v2/campaigns/${campaignId}/stats/skus`,
      'POST', apiKey,
      { dateFrom, dateTo, metrics: ['CLICKS', 'SHOWS', 'ORDERS', 'CTR'] },
      signal,
    );
    return resp.result?.shopSkus ?? [];
  },

  /**
   * POST /v2/campaigns/{campaignId}/shipments — создание поставки FBY.
   */
  async createShipment(
    apiKey: string,
    campaignId: number,
    shipment: {
      externalId?: string;
      planIntervalFrom: string; // YYYY-MM-DD
      planIntervalTo: string;
    },
    signal?: AbortSignal,
  ): Promise<{ id: number }> {
    const resp = await yandexFetch<any>(
      `/v2/campaigns/${campaignId}/shipments`,
      'POST', apiKey, shipment, signal,
    );
    return { id: resp.result?.id ?? 0 };
  },

  /**
   * PUT /v2/campaigns/{campaignId}/shipments/{shipmentId}/confirm — подтверждение поставки.
   */
  async confirmShipment(
    apiKey: string,
    campaignId: number,
    shipmentId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${PROXY}/v2/campaigns/${campaignId}/shipments/${shipmentId}/confirm`, {
      method: 'PUT',
      headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`YM shipment confirm ${res.status}: ${text.slice(0, 200)}`);
    }
  },

  /**
   * POST /v2/campaigns/{campaignId}/orders/{orderId}/return — оформление возврата.
   */
  async processReturn(
    apiKey: string,
    campaignId: number,
    orderId: number,
    returnItems: Array<{ itemId: number; count: number; reasonType: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    await yandexFetch(
      `/v2/campaigns/${campaignId}/orders/${orderId}/return`,
      'POST', apiKey, { returnItems }, signal,
    );
  },
};

export interface YandexChat {
  chatId: string;
  topic: string;
  orderId?: string;
  lastMessageText: string;
  lastMessageTime: string;
  unreadCount: number;
}

export interface YandexChatMessage {
  messageId: string;
  text: string;
  attachments?: { name: string; url: string }[];
  fromSeller: boolean;
  isSystem?: boolean;
  senderLabel?: string;
  createdAt: string;
};

/**
 * Cursor-based пагинатор для заказов Яндекс Маркета.
 * ЯМ API ограничивает диапазон дат до ~30 дней —
 * разбиваем запрос на чанки по 30 дней.
 */
export async function fetchAllYandexOrders(
  store: YandexStore,
  fromDate: string,       // DD-MM-YYYY
  toDate: string,         // DD-MM-YYYY
  signal?: AbortSignal,
  maxPages = 200,
): Promise<YandexOrder[]> {
  // Парсим DD-MM-YYYY → Date
  const parseDate = (s: string): Date => {
    const [d, m, y] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const fmtDate = (d: Date): string =>
    `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

  const start = parseDate(fromDate);
  const end   = parseDate(toDate);
  const CHUNK_DAYS = 29; // ЯМ лимит ~30 дней

  const all: YandexOrder[] = [];
  let chunkStart = new Date(start);

  while (chunkStart < end) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_DAYS * 86400_000, end.getTime()));
    const cFrom = fmtDate(chunkStart);
    const cTo   = fmtDate(chunkEnd);

    let token = '';
    for (let i = 0; i < maxPages; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { orders, nextPageToken } = await yandexApi.getOrders(store, cFrom, cTo, token, signal);
      all.push(...orders);
      if (!nextPageToken || nextPageToken === token) break;
      token = nextPageToken;
    }

    // Следующий чанк начинается со следующего дня
    chunkStart = new Date(chunkEnd.getTime() + 86400_000);
  }
  return all;
}

/**
 * Получить все товары магазина с остатками. Объединяет offer-mappings и stocks.
 */
export async function fetchAllYandexProducts(
  store: YandexStore,
  signal?: AbortSignal,
  maxPages = 200,
): Promise<YandexProduct[]> {
  if (!store.campaign_id) {
    throw new Error('У магазина не задан campaign_id');
  }
  // Если business_id не сохранён — пробуем получить его на лету
  if (!store.business_id) {
    const bid = await yandexApi.getBusinessId(store.api_key, store.campaign_id);
    if (!bid) throw new Error('Не удалось определить business_id магазина. Проверьте API-ключ или пересохраните магазин.');
    store = { ...store, business_id: bid };
  }
  // 1) Все товары
  const all: any[] = [];
  let token = '';
  for (let i = 0; i < maxPages; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { offers, nextPageToken } = await yandexApi.getOfferMappings(store.api_key, store.business_id!, token, signal);
    all.push(...offers);
    if (!nextPageToken || nextPageToken === token) break;
    token = nextPageToken;
  }

  // 2) Все остатки — собираем в Map offer_id → суммарные количества + Set складов кампании
  const stocksMap = new Map<string, { total: number; available: number }>();
  // offerIdsInCampaign: set of offer IDs that appear in THIS campaign's stock API
  // Used to filter out cross-campaign contamination from the business-level offer list.
  const offerIdsInCampaign = new Set<string>();
  let stockToken = '';
  for (let i = 0; i < maxPages; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let chunk: { warehouses: any[]; nextPageToken: string };
    try {
      chunk = await yandexApi.getStocks(store.api_key, store.campaign_id!, stockToken, signal);
    } catch {
      break; // если у тарифа нет доступа — просто без остатков
    }
    for (const wh of chunk.warehouses) {
      for (const offer of wh.offers ?? []) {
        offerIdsInCampaign.add(offer.offerId);
        const cur = stocksMap.get(offer.offerId) ?? { total: 0, available: 0 };
        for (const s of offer.stocks ?? []) {
          const cnt = Number(s.count) || 0;
          // FIT = «готов к продаже» (FBS/DBS). Именно это значение показывает Яндекс.Маркет
          // в личном кабинете. AVAILABLE не используется в FBS-ответе, поэтому не суммируем
          // его — иначе при появлении в ответе API остатки задвоятся.
          if (s.type === 'FIT') {
            cur.total += cnt;
            cur.available += cnt;
          }
        }
        stocksMap.set(offer.offerId, cur);
      }
    }
    if (!chunk.nextPageToken || chunk.nextPageToken === stockToken) break;
    stockToken = chunk.nextPageToken;
  }

  // Если stocks API вернул данные — оставляем только офферы этой кампании.
  // Это убирает офферы из других кампаний (напр. FBY-офферы из BOCOSA попадают
  // в BOCOSA FBS через business-level offer-mappings, но имеют нулевой FBS-сток).
  const filteredAll = offerIdsInCampaign.size > 0
    ? all.filter(raw => offerIdsInCampaign.has((raw.offer ?? raw).offerId ?? raw.offerId ?? ''))
    : all;

  // 3) Маппинг в YandexProduct
  const now = new Date().toISOString();
  const products: YandexProduct[] = filteredAll.map((raw: any): YandexProduct => {
    const offer = raw.offer ?? raw;
    const offerId = offer.offerId ?? raw.offerId ?? '';
    const stocks = stocksMap.get(offerId);
    const wd = offer.weightDimensions ?? offer.weight_dimensions ?? {};
    const dims = fromYm({ length: wd.length, width: wd.width, height: wd.height, weight: wd.weight });
    return {
      store_id: store.id,
      offer_id: offerId,
      name: offer.name ?? '',
      vendor: offer.vendor ?? '',
      vendor_code: offer.vendorCode ?? '',
      pictures: Array.isArray(offer.pictures) ? offer.pictures : [],
      basic_price: offer.basicPrice?.value != null ? Number(offer.basicPrice.value) : null,
      basic_currency: offer.basicPrice?.currencyId ?? 'RUR',
      market_sku: raw.mapping?.marketSku ?? null,
      market_model_id: raw.mapping?.marketModelId ?? null,
      category_id: raw.mapping?.marketCategoryId ?? offer.marketCategoryId ?? null,
      category_name: offer.category ?? '',
      archived: !!offer.archived,
      stock_total: stocks?.total ?? 0,
      stock_available: stocks?.available ?? 0,
      synced_at: now,
      description: offer.description ?? '',
      vat: offer.tax?.vatType ?? offer.vatType ?? '',
      barcode: Array.isArray(offer.barcodes) ? (offer.barcodes[0] ?? '') : '',
      weight_kg: dims.weight_g  != null ? +(dims.weight_g  / 1000).toFixed(3) : null,
      length_cm: dims.length_mm != null ? +(dims.length_mm / 10).toFixed(1)   : null,
      width_cm:  dims.width_mm  != null ? +(dims.width_mm  / 10).toFixed(1)   : null,
      height_cm: dims.height_mm != null ? +(dims.height_mm / 10).toFixed(1)   : null,
    };
  });

  // 4) Витринные цены (/offer-prices) — цена покупателя, которую показывает Яндекс.Маркет
  if (store.campaign_id) {
    try {
      const offerPriceMap = await yandexApi.getOfferPrices(store.api_key, String(store.campaign_id));
      for (const p of products) {
        const entry = offerPriceMap.get(p.offer_id);
        if (entry && entry.price > 0) p.offer_price = entry.price;
      }
    } catch { /* опционально */ }
  }

  return products;
}

/** Получить склады кампании Яндекс.Маркет (FBS). */
export async function fetchYandexWarehouses(
  store: YandexStore,
): Promise<{ warehouseId: number; name: string }[]> {
  if (!store.campaign_id) return [];
  try {
    const res = await fetch(`/yandex-api/v2/campaigns/${store.campaign_id}/warehouses`, {
      method: 'GET',
      headers: { 'Api-Key': store.api_key, 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.result?.warehouses ?? []).map((w: any) => ({
      warehouseId: w.id ?? w.warehouseId,
      name: w.name ?? '',
    }));
  } catch { return []; }
}

/**
 * Получить FBS-склады из ответа stocks API (последний резерв, если /warehouses вернул пусто).
 * Возвращает уникальные warehouseId, встреченные в ответе getStocks для данной кампании.
 */
export async function fetchYandexFbsWarehousesFromStocks(
  store: YandexStore,
): Promise<{ warehouseId: number; name: string }[]> {
  if (!store.campaign_id || !store.api_key) return [];
  try {
    const chunk = await yandexApi.getStocks(store.api_key, store.campaign_id, '', undefined);
    const seen = new Map<number, string>();
    for (const wh of chunk.warehouses) {
      const id = Number(wh.warehouseId);
      if (id && !seen.has(id)) seen.set(id, wh.name ?? `Склад #${id}`);
    }
    return [...seen.entries()].map(([warehouseId, name]) => ({ warehouseId, name }));
  } catch { return []; }
}

/** Обновить FBS-остатки на складе Яндекс.Маркет. */
export async function updateYandexFbsStock(
  store: YandexStore,
  items: { offerId: string; warehouseId: number; count: number }[],
): Promise<void> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const skus = items.map(i => ({
    sku: i.offerId,
    warehouseStocks: [{ warehouseId: i.warehouseId, count: i.count, type: 'FIT' }],
  }));
  const res = await fetch(`/yandex-api/v2/campaigns/${store.campaign_id}/offers/stocks`, {
    method: 'PUT',
    headers: {
      'Api-Key': store.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ skus }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex stocks ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ── Analytics (Аналитика) ──────────────────────────────────────────────────

/**
 * Статистика по товарам Яндекс.Маркет.
 * POST /v2/campaigns/{campaignId}/stats/skus
 */
export async function getYandexSkuStats(
  store: YandexStore,
  params: {
    dateFrom: string;
    dateTo: string;
    offerIds?: string[];
  },
): Promise<any[]> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(`/yandex-api/v2/campaigns/${store.campaign_id}/stats/skus`, {
    method: 'POST',
    headers: {
      'Api-Key': store.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      shopSkus: params.offerIds?.map(id => ({ shopSku: id })),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex stats ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.result?.shopSkus ?? data?.shopSkus ?? [];
}

/**
 * Общая статистика магазина.
 * GET /v2/campaigns/{campaignId}/stats/main
 */
export async function getYandexShopStats(
  store: YandexStore,
  dateFrom: string,
  dateTo: string,
): Promise<any> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(
    `/yandex-api/v2/campaigns/${store.campaign_id}/stats/main?dateFrom=${dateFrom}&dateTo=${dateTo}`,
    {
      method: 'GET',
      headers: {
        'Api-Key': store.api_key,
        'Accept': 'application/json',
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex shop stats ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.result ?? data;
}

// ── Shipments (Поставки FBY) ───────────────────────────────────────────────

/**
 * Создать отгрузку (поставку) Яндекс.Маркет.
 * POST /v2/campaigns/{campaignId}/shipments
 */
export async function createYandexShipment(
  store: YandexStore,
  orderIds: number[],
): Promise<{ shipmentId: number }> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(`/yandex-api/v2/campaigns/${store.campaign_id}/shipments`, {
    method: 'POST',
    headers: {
      'Api-Key': store.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ orderIds }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex shipment ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { shipmentId: data?.result?.id ?? data?.id ?? 0 };
}

/**
 * Подтвердить отгрузку.
 * POST /v2/campaigns/{campaignId}/shipments/{shipmentId}/confirm
 */
export async function confirmYandexShipment(
  store: YandexStore,
  shipmentId: number,
): Promise<void> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(
    `/yandex-api/v2/campaigns/${store.campaign_id}/shipments/${shipmentId}/confirm`,
    {
      method: 'POST',
      headers: {
        'Api-Key': store.api_key,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex shipment confirm ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Получить этикетки для отгрузки (PDF).
 * GET /v2/campaigns/{campaignId}/shipments/{shipmentId}/documents/labels
 */
export async function getYandexShipmentLabels(
  store: YandexStore,
  shipmentId: number,
): Promise<Blob> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(
    `/yandex-api/v2/campaigns/${store.campaign_id}/shipments/${shipmentId}/documents/labels`,
    {
      method: 'GET',
      headers: {
        'Api-Key': store.api_key,
        'Accept': 'application/pdf',
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex labels ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.blob();
}

/**
 * Список текущих отгрузок ЯМ FBY.
 * GET /v2/campaigns/{campaignId}/shipments
 * Возвращает 404 если кампания не FBY — обработка в SupplyManagementModule.
 */
export async function getYandexShipments(
  store: YandexStore,
  params: { dateFrom?: string; dateTo?: string; status?: string; limit?: number } = {},
): Promise<any[]> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const q = new URLSearchParams();
  if (params.dateFrom) q.set('dateFrom', params.dateFrom);
  if (params.dateTo)   q.set('dateTo',   params.dateTo);
  if (params.status)   q.set('status',   params.status);
  if (params.limit)    q.set('limit',    String(params.limit));
  const res = await fetch(
    `/yandex-api/v2/campaigns/${store.campaign_id}/shipments?${q}`,
    { headers: { 'Api-Key': store.api_key, 'Accept': 'application/json' } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex shipments ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.result?.shipments ?? data?.shipments ?? [];
}

/**
 * Доступные слоты приёмки ЯМ (следующие N дней).
 * Реализовано как генерация календаря: ЯМ FBY принимает планируемый интервал,
 * мы предлагаем ближайшие 14 рабочих дней как возможные окна.
 */
export function getYandexAvailableSlots(daysAhead = 14): Array<{ date: string; label: string }> {
  const slots: Array<{ date: string; label: string }> = [];
  const now = new Date();
  const weekdays = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  for (let i = 1; slots.length < daysAhead; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    if (d.getDay() !== 0 && d.getDay() !== 6) { // без выходных
      const dateStr = d.toISOString().slice(0, 10);
      const label = `${weekdays[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      slots.push({ date: dateStr, label });
    }
  }
  return slots;
}

// ── Returns (Возвраты) ─────────────────────────────────────────────────────

/**
 * Получить возвраты Яндекс.Маркет.
 * POST /v2/campaigns/{campaignId}/orders/returns
 */
export async function getYandexReturns(
  store: YandexStore,
  params: {
    dateFrom?: string;
    dateTo?: string;
    status?: string[];
  } = {},
): Promise<any[]> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(`/yandex-api/v2/campaigns/${store.campaign_id}/orders/returns`, {
    method: 'POST',
    headers: {
      'Api-Key': store.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      statuses: params.status,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex returns ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.result?.returns ?? data?.returns ?? [];
}

/**
 * Обработать возврат.
 * POST /v2/campaigns/{campaignId}/orders/{orderId}/return/{returnId}/decision
 */
export async function processYandexReturn(
  store: YandexStore,
  orderId: number,
  returnId: number,
  decision: 'REFUND_MONEY' | 'REFUND_WITH_BONUSES' | 'UNREDEEMED',
): Promise<void> {
  if (!store.campaign_id) throw new Error('campaign_id не задан');
  const res = await fetch(
    `/yandex-api/v2/campaigns/${store.campaign_id}/orders/${orderId}/return/${returnId}/decision`,
    {
      method: 'POST',
      headers: {
        'Api-Key': store.api_key,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex return decision ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ── Promotions (Акции и продвижение) ───────────────────────────────────────

/**
 * Получить список доступных акций Яндекс.Маркет.
 * GET /v2/businesses/{businessId}/promos
 */
export async function getYandexPromos(
  apiKey: string,
  businessId: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const resp = await yandexFetch<any>(
    `/v2/businesses/${businessId}/promos`,
    'POST', apiKey,
    { limit: 500, offset: 0 },
    signal,
  );
  return resp?.result?.promos ?? resp?.promos ?? [];
}

// ── Advertising: промо-офферы ───────────────────────────────────────────────

/**
 * POST /v2/businesses/{businessId}/promos/offers — офферы участвующие в акции.
 */
export async function getYandexPromoOffers(
  apiKey: string,
  businessId: number,
  promoId: string,
  signal?: AbortSignal,
): Promise<any[]> {
  const all: any[] = [];
  const limit = 200;
  let offset = 0;
  while (true) {
    const resp = await yandexFetch<any>(
      `/v2/businesses/${businessId}/promos/offers`,
      'POST', apiKey,
      { promoId, limit, offset },
      signal,
    );
    const items: any[] = resp?.result?.offers ?? resp?.offers ?? [];
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * POST /v2/businesses/{businessId}/promos/offers/update — добавить офферы в акцию.
 */
export async function updateYandexPromoOffers(
  apiKey: string,
  businessId: number,
  promoId: string,
  offers: Array<{ offerId: string; promoPrice: number }>,
): Promise<void> {
  await yandexFetch(
    `/v2/businesses/${businessId}/promos/offers/update`,
    'POST', apiKey, { promoId, offers },
  );
}

/**
 * POST /v2/businesses/{businessId}/promos/offers/delete — убрать офферы из акции.
 */
export async function removeYandexPromoOffers(
  apiKey: string,
  businessId: number,
  promoId: string,
  offerIds: string[],
): Promise<void> {
  await yandexFetch(
    `/v2/businesses/${businessId}/promos/offers/delete`,
    'POST', apiKey, { promoId, deleteAllOffers: false, offerIds },
  );
}

// ── Advertising: буст-ставки ───────────────────────────────────────────────

/**
 * POST /v2/campaigns/{campaignId}/bids — текущие ставки буст-продвижения.
 * ЯМ API использует POST для получения списка ставок (GET возвращает 405).
 */
export async function getYandexCampaignBids(
  apiKey: string,
  campaignId: number,
  signal?: AbortSignal,
): Promise<any[]> {
  try {
    const resp = await yandexFetch<any>(
      `/v2/campaigns/${campaignId}/bids`,
      'POST', apiKey, {}, signal,
    );
    return resp?.result?.items ?? resp?.items ?? resp?.bids ?? [];
  } catch { return []; }
}

/**
 * PUT /v2/campaigns/{campaignId}/bids — установить ставки буст-продвижения.
 */
export async function updateYandexCampaignBids(
  apiKey: string,
  campaignId: number,
  bids: Array<{ offerId: string; bid: number }>,
): Promise<void> {
  await yandexFetch(
    `/v2/campaigns/${campaignId}/bids`,
    'PUT', apiKey, { bids },
  );
}

/**
 * GET /v2/campaigns/{campaignId}/bids/recommended — рекомендованные ставки.
 * Endpoint может вернуть 404 если у кампании нет товаров для буста — возвращаем [].
 */
export async function getYandexRecommendedBids(
  apiKey: string,
  campaignId: number,
  signal?: AbortSignal,
): Promise<any[]> {
  try {
    const resp = await yandexFetch<any>(
      `/v2/campaigns/${campaignId}/bids/recommendations`,
      'POST', apiKey, {}, signal,
    );
    return resp?.result?.items ?? resp?.items ?? [];
  } catch { return []; }
}

/**
 * POST /stats/skus — статистика показов/кликов по SKU через Performance API.
 */
export async function getYandexSkuPerfStats(
  apiKey: string,
  campaignId: number,
  dateFrom: string,
  dateTo: string,
  signal?: AbortSignal,
): Promise<any[]> {
  try {
    const resp = await yandexFetch<any>(
      '/stats/skus',
      'POST', apiKey,
      { campaignIds: [campaignId], dateFrom, dateTo },
      signal,
    );
    return resp?.result?.items ?? resp?.items ?? [];
  } catch { return []; }
}
