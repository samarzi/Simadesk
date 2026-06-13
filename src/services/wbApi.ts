/**
 * API клиент Wildberries.
 * Авторизация: HTTP заголовок `Authorization: <jwt-token>` (без "Bearer").
 *
 * Запросы идут через Supabase Edge Function (wb-proxy) — Deno Deploy IP,
 * который WB не блокирует (в отличие от Netlify datacenter IP).
 */

import { WbStore, WbProduct, WbOrder, WbOrderItem, WbOrderStatus } from '@/types/wb';
import { wbDb } from './wbDb';

const SUPA_URL  = import.meta.env.VITE_SUPA_URL as string;
const SUPA_KEY  = import.meta.env.VITE_SUPA_KEY as string;
const WB_PROXY  = `${SUPA_URL}/functions/v1/wb-proxy`;

// 429 не входит в RETRYABLE — не нужно ретраить rate limit
const RETRYABLE = new Set([500, 502, 503, 504]);

// После 429 блокируем запросы к ЭТОМУ конкретному WB-хосту (у каждого свой rate-limit бакет:
// stats-api, buyer-chat-api, feedbacks-api, content-api и т.д. — независимы друг от друга).
// Кулдаун хранится в localStorage по префиксу пути, чтобы пережить reload.
const WB_COOLDOWN_KEY = 'wb_cooldown_until_v2';
const WB_COOLDOWN_MS = 10 * 60_000; // 10 минут — WB блокирует агрессивно

/** Префикс пути вида "/wb-stats/..." → "wb-stats". */
function prefixOf(path: string): string {
  return path.replace(/^\//, '').split('/')[0] || 'default';
}

function readCooldowns(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(WB_COOLDOWN_KEY) || '{}') || {}; } catch { return {}; }
}
function writeCooldowns(map: Record<string, number>): void {
  try { localStorage.setItem(WB_COOLDOWN_KEY, JSON.stringify(map)); } catch {}
}
let wbCooldowns: Record<string, number> = readCooldowns();

// Все известные WB хосты — при 429 на любом из них блокируем все,
// т.к. WB rate-limit привязан к API-ключу, а не к отдельному хосту.

function setCooldown(prefix: string): void {
  wbCooldowns[prefix] = Date.now() + WB_COOLDOWN_MS;
  writeCooldowns(wbCooldowns);
}

// Кэш отзывов WB на 5 минут — защита от повторных кликов «Обновить»
const wbFeedbackCache = new Map<string, { ts: number; feedbacks: WbFeedback[]; countUnanswered: number }>();

/** Активен ли cooldown после WB 429 для данного хоста (по префиксу пути). */
export function isWbCoolingDown(prefix = 'wb-stats'): boolean {
  // Перечитываем из localStorage чтобы поймать состояние из других вкладок/предыдущих сессий
  const stored = readCooldowns();
  if ((stored[prefix] || 0) > (wbCooldowns[prefix] || 0)) wbCooldowns[prefix] = stored[prefix];
  return Date.now() < (wbCooldowns[prefix] || 0);
}

/** Сколько секунд до конца cooldown для данного хоста (0 если не активен). */
export function wbCooldownRemaining(prefix = 'wb-stats'): number {
  const r = (wbCooldowns[prefix] || 0) - Date.now();
  return r > 0 ? Math.ceil(r / 1000) : 0;
}

/** Сбросить блокировку WB (после ручного подтверждения пользователя). */
export function clearWbCooldown(): void {
  wbCooldowns = {};
  try { localStorage.removeItem(WB_COOLDOWN_KEY); } catch {}
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

async function wbFetch<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal,
  retries = 5,
): Promise<T> {
  // Быстрый фейл если мы в кулдауне после 429 (для этого конкретного хоста)
  const prefix = prefixOf(path);
  if (isWbCoolingDown(prefix)) {
    throw new Error(`WB API rate limited — подождите ещё ${wbCooldownRemaining(prefix)} сек.`);
  }

  let lastErr: Error = new Error('unknown');

  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (attempt > 0) {
      const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 32000);
      await sleep(delay, signal);
    }

    let res: Response;
    try {
      res = await fetch(WB_PROXY + path, {
        method,
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'apikey': SUPA_KEY,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      try { return text ? JSON.parse(text) : ({} as T); }
      catch { return text as any; }
    }

    const text = await res.text();

    if (res.status === 429) {
      setCooldown(prefix); // persistent cooldown в localStorage на 10 минут (только для этого хоста)
      lastErr = new Error(`WB 429: rate-limited на 10 мин`);
      throw lastErr;
    }

    console.error(`[WB API] ${method} ${path} → ${res.status}:`, text.slice(0, 300));
    lastErr = new Error(`WB ${res.status} (${path}): ${text.slice(0, 200)}`);
    if (!RETRYABLE.has(res.status)) throw lastErr;
  }
  throw lastErr;
}

/** Отправка multipart/form-data запроса (для эндпоинтов, требующих FormData, напр. чат). */
async function wbFetchForm(path: string, apiKey: string, form: FormData, signal?: AbortSignal): Promise<any> {
  const res = await fetch(WB_PROXY + path, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Accept': 'application/json',
      'apikey': SUPA_KEY,
    },
    body: form,
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[WB API] POST ${path} → ${res.status}:`, text.slice(0, 300));
    throw new Error(`WB ${res.status} (${path}): ${text.slice(0, 200)}`);
  }
  try { return text ? JSON.parse(text) : {}; } catch { return text; }
}

// ── Маппинг статуса заказа WB ─────────────────────────────────────────────────

function mapOrderStatus(code: number | undefined): WbOrderStatus {
  switch (code) {
    case 0: return 'new';
    case 1: return 'confirm';
    case 2: return 'complete';
    case 3: return 'cancel';
    case 4: return 'arbitration';
    default: return 'unknown';
  }
}

// ── Публичный API ─────────────────────────────────────────────────────────────

export const wbApi = {
  /** GET /api/v1/seller-info — проверка токена и инфо о продавце. */
  async checkToken(apiKey: string, signal?: AbortSignal): Promise<any> {
    try {
      return await wbFetch('/wb-common/api/v1/seller-info', 'GET', apiKey, undefined, signal, 1);
    } catch (err: any) {
      if (err?.message?.includes('429')) {
        throw new Error('Wildberries ограничил частоту запросов. Подождите 1–2 минуты и попробуйте снова.');
      }
      throw err;
    }
  },

  /**
   * POST /content/v2/get/cards/list — список товаров (карточек).
   * Cursor-based: передаём updatedAt и nmID из последнего товара предыдущей страницы.
   */
  async getCards(
    apiKey: string,
    cursor: { updatedAt?: string; nmID?: number } | null,
    signal?: AbortSignal,
  ): Promise<{ cards: any[]; cursor: { updatedAt?: string; nmID?: number; total: number } }> {
    const body: any = {
      settings: {
        cursor: { limit: 100, ...(cursor ?? {}) },
        filter: { withPhoto: -1 },
      },
    };
    const resp = await wbFetch<any>(
      '/wb-content/content/v2/get/cards/list',
      'POST', apiKey, body, signal,
    );
    return {
      cards: resp.cards ?? [],
      cursor: resp.cursor ?? { total: 0 },
    };
  },

  /**
   * POST /api/v2/get/cards/list?locale=ru — обзор остатков по nmID.
   * Используем альтернативный эндпоинт остатков:
   * POST /api/v1/supplier/stocks  (statistics-api)
   */
  async getStocks(
    apiKey: string,
    dateFrom = '2019-01-01',
    signal?: AbortSignal,
  ): Promise<any[]> {
    const resp = await wbFetch<any[]>(
      `/wb-stats/api/v1/supplier/stocks?dateFrom=${dateFrom}`,
      'GET', apiKey, undefined, signal,
    );
    return Array.isArray(resp) ? resp : [];
  },

  /** GET /api/v3/warehouses — список FBS-складов продавца. */
  async getWarehouses(apiKey: string, signal?: AbortSignal): Promise<{ id: number; name: string }[]> {
    const resp = await wbFetch<any>('/wb-marketplace/api/v3/warehouses', 'GET', apiKey, undefined, signal, 3);
    return Array.isArray(resp) ? resp.map((w: any) => ({ id: w.id, name: w.name ?? '' })) : [];
  },

  /** Получить баркоды карточки по nm_id (нужны для обновления FBS остатков). */
  async getCardBarcodes(apiKey: string, nmId: number, signal?: AbortSignal): Promise<string[]> {
    const resp = await wbFetch<any>('/wb-content/content/v2/get/cards/list', 'POST', apiKey, {
      settings: { cursor: { limit: 1, nmID: nmId }, filter: { withPhoto: -1 } },
    }, signal, 3);
    const card = (resp.cards ?? [])[0];
    if (!card) return [];
    const barcodes: string[] = [];
    for (const size of card.sizes ?? []) {
      for (const sku of size.skus ?? []) { if (sku) barcodes.push(String(sku)); }
    }
    return barcodes;
  },

  /**
   * POST /content/v2/cards/update — обновить карточку (габариты и фото).
   * Сначала получаем текущую карточку, меняем только нужные поля, отправляем обратно.
   */
  async updateCard(
    apiKey: string,
    nmID: number,
    updates: {
      dimensions?: { length: number; width: number; height: number };
      photos?: string[];
    },
  ): Promise<void> {
    // Fetch current card
    const resp = await wbFetch<any>('/wb-content/content/v2/get/cards/list', 'POST', apiKey, {
      settings: { cursor: { limit: 1, nmID }, filter: { withPhoto: -1 } },
    });
    const card: any = (resp.cards ?? [])[0];
    if (!card) throw new Error(`WB card not found: nmID=${nmID}`);

    const updated: any = { ...card };
    if (updates.dimensions) {
      updated.dimensions = {
        ...(card.dimensions ?? {}),
        ...updates.dimensions,
      };
    }
    if (updates.photos) {
      updated.photos = updates.photos.map((url: string) => ({
        url, mediaType: 'image/jpeg',
      }));
    }

    await wbFetch<any>('/wb-content/content/v2/cards/update', 'POST', apiKey, [updated]);
  },

  /** PUT /api/v3/stocks/{warehouseId} — установить FBS-остатки (по баркодам). */
  async updateFbsStocks(
    apiKey: string,
    warehouseId: number,
    stocks: { sku: string; amount: number }[],
    signal?: AbortSignal,
  ): Promise<void> {
    await wbFetch<any>(`/wb-marketplace/api/v3/stocks/${warehouseId}`, 'PUT', apiKey, { stocks }, signal, 3);
  },

  /**
   * POST /api/v3/orders/{orderId}/cancel — отменить заказ (FBS).
   */
  async cancelOrder(
    apiKey: string,
    orderId: number | string,
    signal?: AbortSignal,
  ): Promise<any> {
    return wbFetch(
      `/wb-marketplace/api/v3/orders/${orderId}/cancel`,
      'POST', apiKey, {}, signal,
    );
  },

  /**
   * POST /api/v3/orders/{orderId}/confirm — подтвердить готовность к отгрузке (FBS).
   * Переводит заказ в "На сборке".
   */
  async confirmOrder(
    apiKey: string,
    orderId: number | string,
    signal?: AbortSignal,
  ): Promise<any> {
    return wbFetch(
      `/wb-marketplace/api/v3/orders/${orderId}/confirm`,
      'POST', apiKey, {}, signal,
    );
  },

  /**
   * POST /api/v3/orders/stickers — стикеры (этикетки) для нескольких заказов.
   * type=png (по умолчанию) или svg/pdf.
   */
  async getOrderStickers(
    apiKey: string,
    orderIds: number[],
    type: 'png' | 'svg' | 'pdf' = 'pdf',
    signal?: AbortSignal,
  ): Promise<Blob> {
    const res = await fetch(WB_PROXY + '/wb-marketplace/api/v3/orders/stickers?type=' + type + '&width=58&height=40', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'Accept': type === 'pdf' ? 'application/pdf' : 'application/json',
        'apikey': SUPA_KEY,
      },
      body: JSON.stringify({ orders: orderIds }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WB ${res.status}: ${text.slice(0, 200)}`);
    }
    // PDF возвращается как PDF, остальные — как JSON с base64 в data
    if (type === 'pdf') return res.blob();
    const data = await res.json();
    const item = data.stickers?.[0] ?? data.data?.[0];
    const base64 = item?.file ?? item?.data ?? '';
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type === 'png' ? 'image/png' : 'image/svg+xml' });
  },

  /**
   * GET /api/v1/supplier/orders?dateFrom=YYYY-MM-DDTHH:mm:ss
   * Возвращает все заказы (включая отменённые) с указанной даты.
   */
  async getOrders(
    apiKey: string,
    dateFrom: string,
    signal?: AbortSignal,
  ): Promise<any[]> {
    const resp = await wbFetch<any[]>(
      `/wb-stats/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}`,
      'GET', apiKey, undefined, signal,
    );
    return Array.isArray(resp) ? resp : [];
  },

  /**
   * GET /feedback/v1/feedbacks — отзывы продавца.
   * isAnswered: false = только без ответа, true = с ответом, undefined = все.
   */
  async getFeedbacks(
    apiKey: string,
    opts: { isAnswered?: boolean; take?: number; skip?: number } = {},
    _signal?: AbortSignal,
  ): Promise<{ feedbacks: WbFeedback[]; countUnanswered: number }> {
    const take = String(Math.min(opts.take ?? 100, 100)); // WB лимитирует — не больше 100
    const skip = String(opts.skip ?? 0);

    // 1) Сначала проверяем cooldown для wb-feedback (если этот хост уже вернул 429)
    if (isWbCoolingDown('wb-feedback')) {
      const sec = wbCooldownRemaining('wb-feedback');
      throw new Error(`WB feedbacks API в кулдауне ещё ${sec} сек. Попробуйте позже.`);
    }

    // 2) Кэш на 5 минут — защита от повторных кликов и повторных рендеров
    const cacheKey = `wb_fb_${apiKey.slice(-8)}_${opts.isAnswered}_${take}_${skip}`;
    const now = Date.now();
    const cached = wbFeedbackCache.get(cacheKey);
    if (cached && now - cached.ts < 5 * 60_000) {
      return { feedbacks: cached.feedbacks, countUnanswered: cached.countUnanswered };
    }

    const fetchOne = async (isAnswered: boolean): Promise<WbFeedback[]> => {
      const params = new URLSearchParams({ take, skip, isAnswered: String(isAnswered) });
      const res = await fetch(`/wb-feedback/api/v1/feedbacks?${params}`, {
        headers: { 'Authorization': apiKey, 'Accept': 'application/json' },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 429) {
          setCooldown('wb-feedback'); // persistent — переживёт reload страницы
          throw new Error('WB feedbacks API: лимит запросов исчерпан. Заблокировано на 10 минут.');
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error('WB отзывы: проверьте API-ключ магазина (нет доступа к /feedbacks).');
        }
        throw new Error(`WB ${res.status}: ${text || 'нет ответа'}`);
      }
      const resp = await res.json();
      return resp?.data?.feedbacks ?? resp?.feedbacks ?? [];
    };

    if (opts.isAnswered !== undefined) {
      const feedbacks = await fetchOne(opts.isAnswered);
      const result = { feedbacks, countUnanswered: feedbacks.filter(f => !f.answer).length };
      wbFeedbackCache.set(cacheKey, { ts: now, ...result });
      return result;
    }

    // Получаем ВСЕ: секвенциально с паузой 1.5 сек (с запасом к 1 RPS лимиту WB)
    let unanswered: WbFeedback[] = [];
    let answered: WbFeedback[] = [];
    let firstError: any = null;
    try {
      unanswered = await fetchOne(false);
    } catch (e) {
      firstError = e;
      // Если первый запрос дал 429 — cooldown для wb-feedback активен, второй смысла делать НЕТ
      if (isWbCoolingDown('wb-feedback')) throw e;
    }
    await new Promise(r => setTimeout(r, 1500));
    try {
      answered = await fetchOne(true);
    } catch (e) { if (!firstError) firstError = e; }
    if (unanswered.length === 0 && answered.length === 0 && firstError) throw firstError;

    const result = {
      feedbacks: [...unanswered, ...answered],
      countUnanswered: unanswered.length,
    };
    wbFeedbackCache.set(cacheKey, { ts: now, ...result });
    return result;
  },

  /**
   * WB Feedbacks API — ответить на отзыв.
   *   PATCH /api/v1/feedbacks
   *   { id: string (UUID отзыва), text: string }
   *
   * ⚠ Требует API-ключ со скоупом «Отзывы и вопросы».
   * Стандартный токен магазина НЕ работает — нужен отдельный.
   */
  async replyFeedback(
    apiKey: string,
    feedbackId: string,
    text: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch('/wb-feedback/api/v1/feedbacks', {
      method: 'PATCH',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: feedbackId, text }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error(`WB: нет доступа к API отзывов (${res.status}). Создайте новый токен в seller.wildberries.ru → Настройки → Доступ к API → включите категорию «Отзывы и вопросы».`);
      }
      if (res.status === 429) {
        throw new Error('WB: превышен лимит запросов. Повторите через минуту.');
      }
      throw new Error(`WB reply ${res.status}: ${t.slice(0, 200)}`);
    }
  },

  // ── Чат с покупателями ────────────────────────────────────────────────────
  // Документация: https://dev.wildberries.ru/openapi/user-communication (Buyer-Seller Chat API)
  // Хост: buyer-chat-api.wildberries.ru — проксируется через /wb-buyer-chat.
  // ⚠ Требует отдельный токен со скоупом «Вопросы и отзывы» (как и /wb-feedback).

  /** GET /api/v1/seller/chats — список чатов с покупателями. */
  async getChats(apiKey: string, signal?: AbortSignal): Promise<WbChat[]> {
    const resp = await wbFetch<any>('/wb-buyer-chat/api/v1/seller/chats', 'GET', apiKey, undefined, signal, 2);
    // WB отдаёт result как массив чатов напрямую, а не result.chats.
    const chats: any[] = Array.isArray(resp?.result) ? resp.result : (resp?.result?.chats ?? resp?.chats ?? []);
    return chats.map((c: any): WbChat => ({
      chatId: c.chatID ?? c.chatId ?? c.id,
      clientId: c.clientID ?? c.clientId ?? '',
      replySign: c.replySign ?? '',
      lastMessageText: c.lastMessage?.text ?? c.lastMessageText ?? '',
      lastMessageTime: c.lastMessage?.addTimestamp ?? c.lastMessageTime ?? '',
      unreadCount: c.unreadCount ?? 0,
    }));
  },

  /** GET /api/v1/seller/events — события (сообщения) по всем чатам, отфильтрованные по chatId. */
  async getChatMessages(apiKey: string, chatId: string, signal?: AbortSignal): Promise<WbChatMessage[]> {
    // /seller/events отдаёт события постранично (по всем чатам сразу) — листаем,
    // пока totalEvents не станет 0 или не упрёмся в лимит страниц.
    // ⚠ Без параметра next=0 WB отдаёт события только "с текущего момента" (для реалтайм-синхронизации),
    // поэтому старые чаты без недавней активности возвращали пустой список. next=0 запрашивает
    // события с самого начала, и далее листаем вперёд по курсору next из ответа.
    const allEvents: any[] = [];
    let nextCursor = 0;
    for (let page = 0; page < 6; page++) {
      const eventsResp = await wbFetch<any>(`/wb-buyer-chat/api/v1/seller/events?next=${nextCursor}`, 'GET', apiKey, undefined, signal, 2);
      // Формат ответа документирован нечётко — пробуем все варианты вложенности.
      const events: any[] = eventsResp?.result?.events ?? eventsResp?.events ?? (Array.isArray(eventsResp?.result) ? eventsResp.result : []);
      if (page === 0 && events.length === 0) {
        console.warn('[WB chat] /seller/events: пустой ответ, проверьте формат:', JSON.stringify(eventsResp).slice(0, 500));
      }
      allEvents.push(...events);
      const totalEvents = eventsResp?.result?.totalEvents ?? eventsResp?.totalEvents ?? events.length;
      const respNext = eventsResp?.result?.next ?? eventsResp?.next;
      if (!totalEvents || !events.length || respNext === undefined) break;
      nextCursor = respNext;
    }
    const filtered = allEvents.filter((m: any) => (m.chatID ?? m.chatId ?? m.chat_id ?? m.chat?.id) === chatId);
    if (allEvents.length > 0 && filtered.length === 0) {
      console.warn('[WB chat] events найдены, но ни один не совпал с chatId', chatId, '— пример события:', JSON.stringify(allEvents[0]).slice(0, 500));
    }
    return filtered
      .map((m: any) => ({
        messageId: String(m.id ?? m.messageId ?? ''),
        text: m.message?.text ?? m.text ?? '',
        sender: m.sender ?? (m.isClient ? 'client' : 'seller'),
        addTimestamp: Number(m.addTimestamp ?? 0),
      }))
      .sort((a, b) => a.addTimestamp - b.addTimestamp) // от старых к новым
      .map((m): WbChatMessage => ({
        messageId: m.messageId,
        text: m.text,
        sender: m.sender,
        createdAt: m.addTimestamp ? new Date(m.addTimestamp).toISOString() : '',
      }));
  },

  /** POST /api/v1/seller/message — отправить сообщение в чат (multipart/form-data, нужна replySign из чата). */
  async sendChatMessage(apiKey: string, replySign: string, text: string, signal?: AbortSignal): Promise<void> {
    if (!replySign) throw new Error('WB: нет replySign для этого чата — обновите список чатов.');
    const form = new FormData();
    form.append('replySign', replySign);
    form.append('message', text.slice(0, 1000));
    await wbFetchForm('/wb-buyer-chat/api/v1/seller/message', apiKey, form, signal);
  },

  /** POST /api/v1/seller/message — отправить файл (изображение) в чат, с опциональной подписью. */
  async sendChatFile(apiKey: string, replySign: string, file: File, text?: string, signal?: AbortSignal): Promise<void> {
    if (!replySign) throw new Error('WB: нет replySign для этого чата — обновите список чатов.');
    const form = new FormData();
    form.append('replySign', replySign);
    if (text) form.append('message', text.slice(0, 1000));
    form.append('file', file, file.name);
    await wbFetchForm('/wb-buyer-chat/api/v1/seller/message', apiKey, form, signal);
  },
};

export interface WbChat {
  chatId: string;
  clientId: string;
  replySign: string;
  lastMessageText: string;
  lastMessageTime: string;
  unreadCount: number;
}

export interface WbChatMessage {
  messageId: string;
  text: string;
  sender: string;   // 'client' | 'seller' | ...
  createdAt: string;
}

// ── SEO: поиск позиции товара в WB ──────────────────────────────────────────

const WB_SEARCH_BASE = '/wb-search';

/**
 * Ищет позицию nmId в результатах поиска WB по ключевому слову.
 * Возвращает позицию (1-based) или null если не найден в первых 300 результатах.
 */
export async function fetchWbSearchPosition(
  nmId: number,
  keyword: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const dest = '-1257786'; // Москва
  let position = 0;
  for (let page = 1; page <= 3; page++) {
    const url = `${WB_SEARCH_BASE}/exactmatch/ru/common/v7/search?query=${encodeURIComponent(keyword)}&resultset=catalog&limit=100&sort=popular&page=${page}&appType=1&curr=rub&lang=ru&dest=${dest}`;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch {
      return null; // CORS или сеть
    }
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const products: any[] = json?.data?.products ?? [];
    if (!products.length) break;
    for (const p of products) {
      position++;
      if (Number(p.id) === nmId) return position;
    }
    if (products.length < 100) break;
  }
  return null;
}

// ── Prices: обновление цен WB ────────────────────────────────────────────────

// Кэш цен WB на 2 минуты — discounts-prices-api имеет жёсткий rate-limit,
// а синхронизация может запускаться несколько раз подряд (refreshMpBox + runMpSync).
const wbPricesCache = new Map<string, { ts: number; map: Map<number, { price: number; discount: number; priceWithDisc: number }> }>();
const WB_PRICES_CACHE_MS = 2 * 60_000;

/**
 * Получает текущие цены и скидки для товаров WB.
 * GET https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter (через wb-proxy)
 * Возвращает Map<nmID, { price, discount, priceWithDisc }> — priceWithDisc = цена покупателя.
 */
export async function fetchWbCurrentPrices(
  apiKey: string,
  nmIds?: number[],
): Promise<Map<number, { price: number; discount: number; priceWithDisc: number }>> {
  const cacheKey = `${apiKey}:${nmIds?.join(',') ?? ''}`;
  const cached = wbPricesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WB_PRICES_CACHE_MS) return cached.map;

  const result = new Map<number, { price: number; discount: number; priceWithDisc: number }>();
  const LIMIT = 1000;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (nmIds && nmIds.length > 0) params.set('filterNmID', nmIds.join(','));

    const data = await wbFetch<any>(`/wb-prices/api/v2/list/goods/filter?${params}`, 'GET', apiKey, undefined, undefined, 2);
    const items: any[] = data?.data?.listGoods ?? [];
    for (const item of items) {
      const nmID = Number(item.nmID);
      const price = Number(item.sizes?.[0]?.price ?? item.price ?? 0);
      const discount = Number(item.discount ?? 0);
      const priceWithDisc = Number(item.sizes?.[0]?.discountedPrice ?? item.priceWithDisc ?? 0)
        || Math.ceil(price * (1 - discount / 100));
      if (nmID > 0 && price > 0) result.set(nmID, { price, discount, priceWithDisc });
    }

    if (items.length < LIMIT) break;
    offset += LIMIT;
  }

  wbPricesCache.set(cacheKey, { ts: Date.now(), map: result });
  return result;
}

/**
 * Устанавливает новые цены/скидки для nmId.
 * POST https://discounts-prices-api.wildberries.ru/api/v2/upload/task (через wb-proxy)
 */
export async function updateWbPrices(
  apiKey: string,
  items: { nmID: number; price: number; discount?: number }[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await wbFetch('/wb-prices/api/v2/upload/task', 'POST', apiKey, { data: items }, signal, 1);
  } catch (err: any) {
    // WB возвращает 400 когда цена уже установлена — не ошибка
    if (err?.message?.includes('already set')) return;
    throw err;
  }
}

/**
 * Реальная цена покупателя WB включая СПП (скидка постоянного покупателя).
 * Seller API возвращает priceWithDisc = price*(1-discount%), но не учитывает СПП.
 * Публичный card.wb.ru/cards/v2/detail возвращает salePriceU — итоговую цену с СПП.
 * Значение в копейках * 100 (т.е. делим на 100 чтобы получить рубли).
 */
export async function fetchWbActualBuyerPrice(nmID: number): Promise<number | null> {
  try {
    const url = `/wb-card/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nmID}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const product = data?.data?.products?.[0];
    if (!product) return null;
    // salePriceU — цена с СПП и скидками в единицах (руб * 100)
    const raw = product.sizes?.[0]?.price?.total ?? product.salePriceU ?? 0;
    return raw > 0 ? Math.round(raw / 100) : null;
  } catch { return null; }
}

export interface WbFeedback {
  id: string;
  createdDate: string;
  productValuation: number;     // оценка 1–5
  text: string;
  userName?: string;
  answer?: { text: string } | null;
  productDetails?: { nmId: number; productName: string; imtId: number };
  photoLinks?: Array<{ fullSize: string; miniSize: string }>;
  video?: { uri?: string; thumbnailLink?: string } | null;
  pros?: string;
  cons?: string;
  matchingSize?: string;
  bables?: any[];
  isAbleSupplierFeedbackValuation?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Получить все карточки + остатки и смаппить в WbProduct[]. */
export async function fetchAllWbProducts(
  store: WbStore,
  signal?: AbortSignal,
  maxPages = 200,
): Promise<WbProduct[]> {
  const cards: any[] = [];
  let cardsOk = false;
  try {
    let cursor: { updatedAt?: string; nmID?: number } | null = null;
    for (let i = 0; i < maxPages; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { cards: pageCards, cursor: newCursor } = await wbApi.getCards(store.api_key, cursor, signal);
      cards.push(...pageCards);
      if (pageCards.length < 100) break;
      cursor = { updatedAt: newCursor.updatedAt, nmID: newCursor.nmID };
    }
    cardsOk = true;
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    console.warn('[WB Cards] fetch failed, falling back to DB:', err?.message);
  }

  // Если карточки недоступны (rate-limit) — не трогаем БД, UI подгрузит из БД через load()
  if (!cardsOk) return [];

  // Остатки в Map по nmId
  const stocksMap = new Map<number, number>();
  try {
    const stocks = await wbApi.getStocks(store.api_key, '2019-01-01', signal);
    for (const s of stocks) {
      const nm = Number(s.nmId);
      if (!isFinite(nm)) continue;
      stocksMap.set(nm, (stocksMap.get(nm) ?? 0) + (Number(s.quantity) || 0));
    }
  } catch { /* остатки опциональны */ }

  // Цены и скидки — отдельный API (discounts-prices), в cards/list их нет
  let pricesMap = new Map<number, { price: number; discount: number; priceWithDisc: number }>();
  try {
    pricesMap = await fetchWbCurrentPrices(store.api_key);
  } catch (err) { console.error('[WB Prices] fetch failed:', err); /* цены опциональны */ }

  // Если discounts-prices или stocks API недоступны (rate-limit/ошибка) — берём
  // ранее сохранённые price/discount/stock_total из БД, чтобы синк не затирал
  // их нулями/устаревшими данными из cards/list.
  let existingMap = new Map<number, { price: number | null; discount: number | null; stock_total: number | null }>();
  if (pricesMap.size === 0 || stocksMap.size === 0) {
    try {
      const existing = await wbDb.getStoreProducts(store.id);
      for (const p of existing) existingMap.set(p.nm_id, { price: p.price ?? null, discount: p.discount ?? null, stock_total: p.stock_total ?? null });
    } catch { /* нет сохранённых данных — ок */ }
  }

  const now = new Date().toISOString();
  return cards.map((c: any): WbProduct => {
    const pictures = (c.photos ?? []).map((ph: any) =>
      typeof ph === 'string' ? ph : (ph.big ?? ph.tm ?? ph.c246x328 ?? Object.values(ph)[0] ?? '')
    ).filter(Boolean);
    const firstSize = c.sizes?.[0];
    const priceInfo = pricesMap.get(Number(c.nmID));
    const existing = existingMap.get(Number(c.nmID));
    const price = priceInfo?.price ?? existing?.price ?? (firstSize?.price != null ? Number(firstSize.price) : null);
    const discount = priceInfo?.discount ?? existing?.discount ?? c.discount ?? null;
    const stockTotal = stocksMap.size > 0 ? (stocksMap.get(c.nmID) ?? 0) : (existing?.stock_total ?? 0);

    // Габариты упаковки: WB отдаёт dimensions.{length,width,height} в см
    const dims = c.dimensions ?? {};
    const length_cm = dims.length != null ? Number(dims.length) : null;
    const width_cm  = dims.width  != null ? Number(dims.width)  : null;
    const height_cm = dims.height != null ? Number(dims.height) : null;

    // Вес с упаковкой (брутто) — приоритетно из dimensions.weightBrutto (как Ozon weight / ЯМ weightDimensions.weight).
    // Фоллбэк — characteristics по имени, содержащему "вес" (если weightBrutto не заполнен на карточке).
    let weight_kg: number | null = dims.weightBrutto != null ? Number(dims.weightBrutto) : null;
    if (weight_kg == null || !isFinite(weight_kg) || weight_kg <= 0) {
      weight_kg = null;
      const chars: any[] = c.characteristics ?? [];
      for (const ch of chars) {
        const name = (ch.name || '').toLowerCase();
        if (name.includes('вес')) {
          const raw = Array.isArray(ch.value) ? ch.value[0] : ch.value;
          const v = parseFloat(String(raw ?? ''));
          if (isFinite(v) && v > 0) { weight_kg = v; break; }
        }
      }
    }

    return {
      store_id: store.id,
      nm_id: c.nmID,
      imt_id: c.imtID,
      vendor_code: c.vendorCode ?? '',
      brand: c.brand ?? '',
      title: c.title ?? '',
      subject: c.subjectName ?? c.subject ?? '',
      pictures,
      price,
      discount,
      stock_total: stockTotal,
      weight_kg,
      length_cm,
      width_cm,
      height_cm,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      synced_at: now,
    };
  });
}

/** Получить заказы WB за период (от даты), смаппить. */
export async function fetchAllWbOrders(
  store: WbStore,
  dateFrom: string,           // ISO 8601, например 2026-05-06T00:00:00
  signal?: AbortSignal,
): Promise<WbOrder[]> {
  const raw = await wbApi.getOrders(store.api_key, dateFrom, signal);
  return raw.map((r: any): WbOrder => {
    const price = Number(r.priceWithDisc ?? r.totalPrice ?? r.finishedPrice ?? 0) || 0;
    const items: WbOrderItem[] = [{
      nm_id: r.nmId ?? r.nmID ?? 0,
      vendor_code: r.supplierArticle ?? '',
      name: r.subject ?? r.barcode ?? '',
      count: 1,
      price,
      currency_code: 'RUB',
    }];
    return {
      // gNumber — числовой ID группы заказов (stable). srid — UUID отправления, хранится отдельно
      // для сопоставления с posting_number в финотчёте (Number(srid) = NaN, отсюда был баг).
      id: Number(r.gNumber ?? Math.random() * 1e9),
      srid: r.srid ?? undefined,
      status: r.isCancel ? 'cancel' : mapOrderStatus(r.orderStatus),
      status_raw: r.orderStatus,
      created_at: r.date ?? r.lastChangeDate ?? '',
      warehouse_name: r.warehouseName ?? null,
      delivery_address: r.regionName ? `${r.regionName}${r.oblastOkrugName ? ', ' + r.oblastOkrugName : ''}` : null,
      items,
      total: price,
      currency_code: 'RUB',
      store_id: store.id,
      is_zero_order: !!r.priceWithDisc && r.priceWithDisc === 0,
    };
  });
}
