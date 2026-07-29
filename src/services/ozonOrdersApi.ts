import { debug } from '@/utils/debug';
import { OzonStore, OzonPosting, OzonPostingProduct, OzonReturn, DeliveryScheme } from '@/types/ozon';

const PROXY = '/ozon-api';
type Creds = Pick<OzonStore, 'client_id' | 'api_key'>;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

// Statuses worth retrying (rate-limit, server overload)
const RETRYABLE = new Set([429, 500, 502, 503]);

/**
 * Универсальный парсер цены товара из ответа Ozon API.
 * Ozon API v4 может возвращать цену как:
 *   - строку "1234.56"
 *   - число 1234.56
 *   - объект { price: "1234.56", currency_code: "RUB" }
 *   - объект { value: ..., currency: ... }
 */
function parsePriceField(price: any): { price: string; currency_code?: string } {
  if (price == null) return { price: '0' };
  if (typeof price === 'string') return { price };
  if (typeof price === 'number') return { price: String(price) };
  if (typeof price === 'object') {
    const value = price.price ?? price.value ?? price.amount ?? price.total ?? price.final_price ?? '0';
    const currency = price.currency_code ?? price.currency ?? undefined;
    return { price: String(value), currency_code: currency };
  }
  return { price: '0' };
}

/**
 * Internal POST helper for Ozon Orders API with exponential backoff retry.
 * Backoff: min(2^(n-1) * 1000, 32000) ms, up to 5 attempts.
 * Retries only for statuses: 429, 500, 502, 503.
 * Accepts AbortSignal and propagates AbortError immediately.
 */
async function ozonOrdersPost<T>(
  endpoint: string,
  body: unknown,
  creds: Creds,
  signal?: AbortSignal,
  retries = 5,
): Promise<T> {
  let lastErr: Error = new Error('unknown');

  for (let attempt = 0; attempt < retries; attempt++) {
    // Check abort before each attempt
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (attempt > 0) {
      // Exponential backoff: min(2^(n-1) * 1000, 32000) ms
      // attempt=1 → 1000ms, attempt=2 → 2000ms, attempt=3 → 4000ms,
      // attempt=4 → 8000ms, attempt=5 → 16000ms (capped at 32000ms)
      const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 32000);
      await sleep(delay, signal);
    }

    let res: Response;
    try {
      res = await fetch(`${PROXY}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': creds.client_id,
          'Api-Key': creds.api_key,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err: unknown) {
      // Propagate AbortError immediately without retrying
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (res.ok) return res.json() as Promise<T>;

    const text = await res.text();
    console.error(`[OzonOrders] ${endpoint} → ${res.status}:`, text.slice(0, 300));
    lastErr = new Error(`OzonOrders ${res.status} (${endpoint}): ${text.slice(0, 150)}`);

    if (!RETRYABLE.has(res.status)) throw lastErr;
  }

  throw lastErr;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const ozonOrdersApi = {

  /**
   * Fetch a single page of FBO postings.
   * Endpoint: POST /v3/posting/fbo/list
   */
  async getFboPostings(
    creds: Creds,
    since: string,
    to: string,
    limit: number,
    offset: number,
    signal?: AbortSignal,
  ): Promise<OzonPosting[]> {
    const body = {
      dir: 'DESC',
      filter: { since, to },
      limit,
      offset,
      with: { analytics_data: false, financial_data: false },
    };
    const resp = await ozonOrdersPost<any>(
      '/v3/posting/fbo/list',
      body,
      creds,
      signal,
    );
    // Поддержка старого и нового формата ответа Ozon
    const postings: any[] = resp.result?.postings
      ?? resp.postings
      ?? (Array.isArray(resp.result) ? resp.result : [])
      ?? [];
    const apiHasNext: boolean = resp.has_next ?? resp.result?.has_next ?? false;
    const result = postings.map((p: any): OzonPosting => ({
      posting_number: p.posting_number,
      status: p.status,
      delivery_scheme: 'fbo',
      created_at: p.created_at ?? p.in_process_at ?? '',
      shipment_date: p.in_process_at ?? null,
      in_process_at: p.in_process_at ?? null,
      products: (p.products ?? []).map((pr: any) => {
        const { price, currency_code: priceCurr } = parsePriceField(pr.price);
        return {
          offer_id: pr.offer_id ?? '',
          name: pr.name ?? '',
          quantity: Number(pr.quantity) || 0,
          price,
          currency_code: pr.currency_code ?? priceCurr ?? 'RUB',
        };
      }),
      store_id: '',
      warehouse_id: p.delivery_method?.warehouse_id ?? null,
    }));

    // Ozon FBO API всегда отдаёт has_next=true даже за пределами диапазона дат.
    // Останавливаемся если:
    //  1. API вернул меньше записей чем limit (последняя страница)
    //  2. Дата самого старого заказа на странице вышла за границу since (прошли диапазон)
    let hasNext = apiHasNext && postings.length >= limit;
    if (hasNext && since && postings.length > 0) {
      const oldestDate = postings[postings.length - 1]?.created_at
        ?? postings[postings.length - 1]?.in_process_at ?? '';
      if (oldestDate && oldestDate < since) {
        hasNext = false;
        debug.log(`[Ozon API] FBO: oldest order ${oldestDate} < since ${since} → stop`);
      }
    }
    if (!hasNext) debug.log(`[Ozon API] FBO: loaded ${postings.length} (last page)`);
    (result as any).__hasNext = hasNext;
    return result;
  },

  /**
   * Fetch a single page of FBS / RealFBS / DBS postings.
   * Endpoint: POST /v4/posting/fbs/list
   *
   * @param scheme  — конкретная схема ('fbs' | 'rfbs' | 'dbs') ИЛИ null/undefined
   *                  для получения ВСЕХ схем сразу (без фильтра delivery_schema).
   *                  Используй null при загрузке общей вкладки FBS/DBS,
   *                  чтобы поймать заказы всех схем в один запрос.
   */
  async getFbsPostings(
    creds: Creds,
    since: string,
    to: string,
    scheme: 'fbs' | 'rfbs' | 'dbs' | null,
    limit: number,
    offsetOrCursor: number | string,    // число — offset (старое API), строка — cursor (v4)
    signal?: AbortSignal,
  ): Promise<OzonPosting[]> {
    const filter: Record<string, unknown> = {
      since,
      to,
      delivery_schema: scheme ? [scheme] : ['fbs', 'rfbs', 'dbs'],
    };

    // Ozon API v4 использует cursor-based pagination. offset игнорируется.
    // Если получили число (offset=0) — это первая страница, cursor="".
    // Если строка — это cursor из предыдущего ответа.
    const cursor = typeof offsetOrCursor === 'string' ? offsetOrCursor : '';

    const body: Record<string, unknown> = {
      dir: 'DESC',
      filter,
      limit,
      with: { analytics_data: false, financial_data: false, barcodes: false },
    };
    if (cursor) body.cursor = cursor;

    const resp = await ozonOrdersPost<any>(
      '/v4/posting/fbs/list',
      body,
      creds,
      signal,
    );
    const postings: any[] = resp.result?.postings ?? resp.postings ?? [];
    const hasNext: boolean = resp.has_next ?? resp.result?.has_next ?? false;
    const nextCursor: string = resp.cursor ?? resp.result?.cursor ?? '';

    const result = postings.map((p: any): OzonPosting => {
      const rawScheme = p.delivery_method?.scheme ?? p.delivery_schema ?? scheme ?? 'fbs';
      const deliveryScheme: DeliveryScheme =
        rawScheme === 'rfbs' ? 'rfbs' :
        rawScheme === 'dbs'  ? 'rfbs' :
        'fbs';

      return {
        posting_number: p.posting_number,
        status: p.status,
        delivery_scheme: deliveryScheme,
        created_at: p.created_at ?? p.in_process_at ?? p.shipment_date ?? '',
        in_process_at: p.in_process_at ?? null,
        shipment_date: p.shipment_date ?? null,
        delivering_date: p.delivering_date ?? null,
        products: (p.products ?? []).map((pr: any) => {
          const { price, currency_code: priceCurr } = parsePriceField(pr.price);
          return {
            offer_id: pr.offer_id ?? '',
            name: pr.name ?? '',
            quantity: Number(pr.quantity) || 0,
            price,
            currency_code: pr.currency_code ?? priceCurr ?? 'RUB',
          };
        }),
        store_id: '',
        warehouse_id: p.delivery_method?.warehouse_id ?? null,
        customer_address: p.customer?.address ?? p.addressee?.address ?? null,
        tracking_number: p.tracking_number ?? null,
      };
    });
    // Прикрепляем мета-инфо к результирующему массиву (после map, чтобы не потерялось)
    (result as any).__hasNext = hasNext;
    (result as any).__nextCursor = nextCursor;
    return result;
  },

  /**
   * Returns posting_numbers that are considered "new" (awaiting packaging).
   * Instead of calling the problematic unfulfilled/list endpoint,
   * we derive this from the already-loaded postings by status.
   */
  getUnfulfilledFbs(
    _creds: Creds,
    _signal?: AbortSignal,
  ): Promise<Set<string>> {
    // Intentionally returns empty set — "new" badge is now derived from
    // status === 'awaiting_packaging' directly in the render layer.
    return Promise.resolve(new Set<string>());
  },

  /**
   * Fetch a single page of RealFBS returns.
   * Endpoint: POST /v2/returns/rfbs/list
   */
  async getRfbsReturns(
    creds: Creds,
    limit: number,
    offset: number,
    signal?: AbortSignal,
  ): Promise<OzonReturn[]> {
    const resp = await ozonOrdersPost<any>(
      '/v2/returns/rfbs/list',
      { filter: {}, limit, offset },
      creds,
      signal,
    );
    // Поддерживаем оба формата: {result: [...]} (старый), {returns: [...]} (новый)
    const returns: any[] = Array.isArray(resp.result)
      ? resp.result
      : (resp.result?.returns ?? resp.returns ?? []);
    return returns.map((r: any): OzonReturn => ({
      id: r.id,
      status: r.status,
      posting_number: r.posting_number,
      created_at: r.created_at,
      products: (r.products ?? []).map((pr: any) => ({
        offer_id: pr.offer_id,
        name: pr.name ?? '',
        quantity: pr.quantity,
        price: pr.price ?? '0',
        currency_code: pr.currency_code ?? 'RUB',
      })),
      reason_name: r.reason?.name ?? r.reason_name,
    }));
  },

  /**
   * Fetch detailed FBO posting info.
   * Endpoint: POST /v2/posting/fbo/get
   */
  async getFboPostingDetail(
    creds: Creds,
    postingNumber: string,
    signal?: AbortSignal,
  ): Promise<OzonPosting> {
    const resp = await ozonOrdersPost<any>(
      '/v2/posting/fbo/get',
      {
        posting_number: postingNumber,
        with: { analytics_data: false, financial_data: false },
      },
      creds,
      signal,
    );
    // Поддержка обоих форматов ответа
    const p = resp.result ?? resp;
    return {
      posting_number: p.posting_number,
      status: p.status,
      delivery_scheme: 'fbo',
      created_at: p.created_at,
      shipment_date: p.in_process_at ?? null,
      in_process_at: p.in_process_at ?? null,
      products: (p.products ?? []).map((pr: any) => ({
        offer_id: pr.offer_id,
        name: pr.name,
        quantity: pr.quantity,
        price: pr.price,
        currency_code: pr.currency_code,
      })),
      store_id: '',
      warehouse_id: p.delivery_method?.warehouse_id ?? null,
      region: p.analytics_data?.region ?? null,
    };
  },

  /**
   * Fetch detailed FBS or RealFBS posting info.
   * Endpoint: POST /v3/posting/fbs/get
   */
  async getFbsPostingDetail(
    creds: Creds,
    postingNumber: string,
    signal?: AbortSignal,
  ): Promise<OzonPosting> {
    const resp = await ozonOrdersPost<any>(
      '/v3/posting/fbs/get',
      {
        posting_number: postingNumber,
        with: { analytics_data: false, financial_data: false, barcodes: false },
      },
      creds,
      signal,
    );
    const p = resp.result ?? resp;
    // Определяем схему по полю delivery_method.scheme или имени
    const rawScheme = (p.delivery_method?.scheme ?? '').toLowerCase();
    const scheme: DeliveryScheme =
      rawScheme === 'rfbs' || rawScheme === 'dbs' ||
      p.delivery_method?.name === 'Реальный FBS' ? 'rfbs' : 'fbs';
    return {
      posting_number: p.posting_number,
      status: p.status,
      delivery_scheme: scheme,
      created_at: p.created_at,
      shipment_date: p.shipment_date ?? null,
      delivering_date: p.delivering_date ?? null,
      in_process_at: p.in_process_at ?? null,
      products: (p.products ?? []).map((pr: any) => ({
        offer_id: pr.offer_id,
        name: pr.name,
        quantity: pr.quantity,
        price: pr.price,
        currency_code: pr.currency_code,
      })),
      store_id: '',
      warehouse_id: p.delivery_method?.warehouse_id ?? null,
      customer_address: p.customer?.address ?? null,
      tracking_number: p.tracking_number ?? null,
      region: p.analytics_data?.region ?? null,
    };
  },

  // ── FBS управление ─────────────────────────────────────────────

  /**
   * POST /v3/posting/fbs/ship — перевести заказ в статус "Отгружен".
   * @param packages — список упаковок, в каждой — товары с продуктами {product_id, quantity}.
   *   Минимальный вариант: одна упаковка со всеми товарами заказа.
   */
  async shipFbsPosting(
    creds: Creds,
    postingNumber: string,
    packages: Array<{ products: Array<{ product_id: number; quantity: number }> }>,
    signal?: AbortSignal,
  ): Promise<any> {
    return ozonOrdersPost('/v3/posting/fbs/ship', {
      posting_number: postingNumber,
      packages,
    }, creds, signal);
  },

  /**
   * POST /v2/posting/fbs/package-label — получить PDF-этикетку для отправлений.
   * Возвращает PDF Blob.
   */
  async getFbsPackageLabelPdf(
    creds: Creds,
    postingNumbers: string[],
    signal?: AbortSignal,
  ): Promise<Blob> {
    const res = await fetch(`${PROXY}/v2/posting/fbs/package-label`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': creds.client_id,
        'Api-Key': creds.api_key,
      },
      body: JSON.stringify({ posting_number: postingNumbers }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ozon ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.blob();
  },

  /**
   * POST /v2/posting/fbs/act/create — запросить создание акта приёма-передачи.
   * Возвращает id задания, далее нужно опросить get-pdf.
   */
  async createFbsAct(
    creds: Creds,
    deliveryMethodId: number,
    signal?: AbortSignal,
  ): Promise<{ id: number }> {
    const resp = await ozonOrdersPost<any>('/v2/posting/fbs/act/create', {
      delivery_method_id: deliveryMethodId,
    }, creds, signal);
    return { id: resp.result?.id ?? resp.id };
  },

  /**
   * POST /v2/posting/fbs/digital/act/get-pdf — получить PDF готового акта.
   */
  async getFbsActPdf(
    creds: Creds,
    actId: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const res = await fetch(`${PROXY}/v2/posting/fbs/digital/act/get-pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': creds.client_id,
        'Api-Key': creds.api_key,
      },
      body: JSON.stringify({ id: actId }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ozon ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.blob();
  },

  /**
   * POST /v2/posting/fbs/cancel-reason/list — список причин отмены.
   */
  async getFbsCancelReasons(
    creds: Creds,
    signal?: AbortSignal,
  ): Promise<Array<{ id: number; title: string }>> {
    const resp = await ozonOrdersPost<any>('/v2/posting/fbs/cancel-reason/list', {}, creds, signal);
    return resp.result ?? resp ?? [];
  },

  /**
   * POST /v2/posting/fbs/cancel — отменить отправление.
   */
  async cancelFbsPosting(
    creds: Creds,
    postingNumber: string,
    cancelReasonId: number,
    cancelReasonMessage?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    return ozonOrdersPost('/v2/posting/fbs/cancel', {
      posting_number: postingNumber,
      cancel_reason_id: cancelReasonId,
      cancel_reason_message: cancelReasonMessage ?? '',
    }, creds, signal);
  },
};

/**
 * Generic pagination helper.
 *
 * Calls `fetcher(limit, offset)` in a loop starting at offset=0, incrementing
 * by `limit` each iteration. Stops when the response contains fewer than
 * `limit` items (i.e. the last page has been reached).
 *
 * The optional `signal` is forwarded to every `fetcher` call so the caller
 * can abort mid-pagination via an AbortController.
 *
 * @param fetcher  Function that fetches one page given (limit, offset, signal).
 * @param limit    Page size — must be a positive integer.
 * @param signal   Optional AbortSignal to cancel the loop early.
 * @returns        All collected records across all pages.
 *
 * Validates: Requirements 4.2, 5.2, 6.1
 */
export async function fetchAllPages<T>(
  fetcher: (limit: number, offset: number | string, signal?: AbortSignal) => Promise<T[]>,
  limit: number,
  signal?: AbortSignal,
  maxPages = 200,
): Promise<T[]> {
  const all: T[] = [];
  let offset: number | string = 0;
  let prevFirstId: string | undefined;
  const seenIds = new Set<string>();

  for (let i = 0; i < maxPages; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const page = await fetcher(limit, offset, signal);
    if (page.length === 0) break;

    // Детекция зацикливания: проверяем первый posting_number страницы
    const firstId: string | undefined = (page[0] as any)?.posting_number
      ?? (page[0] as any)?.id
      ?? String(offset);
    if (prevFirstId !== undefined && firstId === prevFirstId) {
      console.warn(`[fetchAllPages] Duplicate page detected (id="${firstId}" at offset=${offset}) — Ozon API pagination bug, stopping`);
      break;
    }
    // Дополнительная проверка: если более 50% items уже видели → стоп
    const newItems = page.filter((item: any) => {
      const id = item?.posting_number ?? item?.id;
      return id == null || !seenIds.has(String(id));
    });
    if (page.length > 0 && newItems.length < page.length * 0.5) {
      console.warn(`[fetchAllPages] >50% duplicate items at offset=${offset} — stopping`);
      all.push(...newItems);
      break;
    }
    for (const item of page) {
      const id = (item as any)?.posting_number ?? (item as any)?.id;
      if (id != null) seenIds.add(String(id));
    }
    prevFirstId = firstId;

    all.push(...page);

    const hasNext = (page as any).__hasNext;
    if (hasNext === false) break;
    if (hasNext === undefined && page.length < limit) break;

    // Cursor-based pagination (FBS): используем курсор из ответа вместо числового offset
    const nextCursor: string = (page as any).__nextCursor ?? '';
    if (nextCursor) {
      offset = nextCursor;
    } else {
      offset = (typeof offset === 'number' ? offset : 0) + limit;
    }
  }

  return all;
}

/**
 * Cursor-based пагинатор для Ozon API v4 (/v4/posting/fbs/list).
 * Передаёт курсор из предыдущего ответа в следующий запрос.
 * Останавливается когда has_next=false, cursor пустой или совпадает с предыдущим.
 */
export async function fetchAllPagesByCursor<T>(
  fetcher: (limit: number, cursor: string, signal?: AbortSignal) => Promise<T[]>,
  limit: number,
  signal?: AbortSignal,
  maxPages = 500,
): Promise<T[]> {
  const all: T[] = [];
  let cursor = '';

  for (let i = 0; i < maxPages; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const page = await fetcher(limit, cursor, signal);
    all.push(...page);

    const hasNext = (page as any).__hasNext;
    const nextCursor = (page as any).__nextCursor as string | undefined;

    // Останавливаемся если: API сообщил has_next=false ИЛИ нет нового курсора
    // ИЛИ курсор не изменился (защита от бесконечного цикла) ИЛИ страница пустая
    if (hasNext === false) break;
    if (!nextCursor) break;
    if (nextCursor === cursor) break;
    if (page.length === 0) break;
    cursor = nextCursor;
  }

  return all;
}

/**
 * Calculate the total order amount: sum of (price * quantity) for each product.
 * Price is stored as a string in OzonPostingProduct (e.g. "1234.56").
 *
 * @param products - array of OzonPostingProduct
 * @returns total as a number (0 if products is empty or prices are non-numeric)
 */
export function calcPostingTotal(products: OzonPostingProduct[]): number {
  return products.reduce((sum, p) => {
    const price = parseFloat(p.price);
    if (!isFinite(price)) return sum;
    return sum + price * p.quantity;
  }, 0);
}

// Export internal function for testing purposes
export { ozonOrdersPost };
