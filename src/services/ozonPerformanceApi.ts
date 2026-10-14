/**
 * Ozon Performance API — расходы на рекламу для аналитики.
 *
 * Рекламный кабинет авторизуется отдельно от Seller API: OAuth client_credentials
 * по client_id / client_secret, которые выдаются в performance.ozon.ru →
 * Настройки → API. Ключи Seller API (Client-Id / Api-Key) здесь не работают.
 *
 * Используем:
 *   POST /api/client/token                       — токен на 30 минут
 *   GET  /api/client/campaign                    — кампании и их тип
 *   GET  /api/client/campaign/{id}/objects       — SKU в кампании
 *   GET  /api/client/statistics/expense/json     — расход по дням: деньги и бонусы
 *   GET  /api/client/statistics/daily/json       — показы, клики, заказы по дням
 */

const PERF_PROXY = '/ozon-perf';

export interface PerfCredentials {
  storeId: string;
  clientId: string;
  clientSecret: string;
}

export interface PerfCampaign {
  id: string;
  title: string;
  state: string;
  advObjectType: string;
  paymentType: string;
  placement: string[];
  strategy: string;
}

/** Расход одной кампании за период. */
export interface PerfCampaignSpend {
  campaignId: string;
  title: string;
  /** Группа для отчёта: «Поиск», «Поиск и рекомендации», «Оплата за заказ»… */
  group: string;
  /** Стратегия управления ставками, если Ozon её отдаёт. */
  strategy: string;
  /** Списано деньгами — влияет на прибыль. */
  money: number;
  /** Списано бонусами Ozon — справочно, денег не стоит. */
  bonus: number;
  views: number;
  clicks: number;
  orders: number;
  ordersMoney: number;
  /** SKU товаров в кампании (для распределения расхода по товарам). */
  skus: string[];
}

export interface PerfSpendResult {
  campaigns: PerfCampaignSpend[];
  /** Расход по дням, YYYY-MM-DD → деньги. */
  byDay: Record<string, number>;
}

/** Число из ответа Ozon: строки бывают вида «1 234,56». */
export function parsePerfNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const n = Number(v.replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const PLACEMENT_LABEL: Record<string, string> = {
  PLACEMENT_SEARCH_AND_CATEGORY: 'Поиск',
  PLACEMENT_TOP_PROMOTION: 'Поиск и рекомендации',
  PLACEMENT_PDP: 'Карточка товара',
  PLACEMENT_INVALID: 'Другое',
};

/** Человекочитаемая группа кампании для отчёта. */
export function campaignGroup(c: Pick<PerfCampaign, 'advObjectType' | 'placement' | 'paymentType'>): string {
  const type = (c.advObjectType || '').toUpperCase();
  if (type === 'SEARCH_PROMO') return 'Оплата за заказ';
  if (type === 'BANNER') return 'Баннеры';
  if (type === 'VIDEO_BANNER') return 'Видеобаннеры';
  if (type === 'BRAND_SHELF') return 'Брендовая полка';
  const places = (c.placement || []).map(p => PLACEMENT_LABEL[p] ?? p).filter(Boolean);
  if (places.length > 1) return 'Поиск и рекомендации';
  if (places.length === 1) return places[0];
  return type === 'SKU' ? 'Трафареты (оплата за клик)' : (type || 'Прочая реклама');
}

const STRATEGY_LABEL: Record<string, string> = {
  TARGET_BIDS: 'Целевые ставки',
  MAX_CLICKS: 'Максимум кликов',
  MAX_VIEWS: 'Максимум показов',
  TOP_MAX_CLICKS: 'Максимум кликов',
  NO_AUTO_STRATEGY: 'Ручные ставки',
};

export function strategyLabel(raw: string): string {
  if (!raw) return '';
  return STRATEGY_LABEL[raw.toUpperCase()] ?? raw;
}

function normalizeCampaign(raw: any): PerfCampaign {
  const placement = Array.isArray(raw?.placement) ? raw.placement.map(String)
    : raw?.placement ? [String(raw.placement)] : [];
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? raw?.name ?? `Кампания ${raw?.id ?? ''}`),
    state: String(raw?.state ?? ''),
    advObjectType: String(raw?.advObjectType ?? ''),
    paymentType: String(raw?.PaymentType ?? raw?.paymentType ?? ''),
    placement,
    strategy: String(raw?.productAutopilotStrategy ?? raw?.autopilot?.strategy ?? raw?.strategy ?? ''),
  };
}

/**
 * Свести расход по кампаниям. Чистая функция — покрыта тестами.
 * expenseRows: строки /statistics/expense/json; dailyRows: /statistics/daily/json.
 */
export function aggregatePerfSpend(
  campaigns: PerfCampaign[],
  expenseRows: any[],
  dailyRows: any[],
  skusByCampaign: Record<string, string[]> = {},
): PerfSpendResult {
  const byId = new Map<string, PerfCampaignSpend>();
  const meta = new Map(campaigns.map(c => [c.id, c]));
  const get = (id: string, title?: string): PerfCampaignSpend => {
    let cur = byId.get(id);
    if (!cur) {
      const c = meta.get(id);
      cur = {
        campaignId: id,
        title: c?.title ?? title ?? `Кампания ${id}`,
        group: c ? campaignGroup(c) : 'Прочая реклама',
        strategy: strategyLabel(c?.strategy ?? ''),
        money: 0, bonus: 0, views: 0, clicks: 0, orders: 0, ordersMoney: 0,
        skus: skusByCampaign[id] ?? [],
      };
      byId.set(id, cur);
    }
    return cur;
  };
  const byDay: Record<string, number> = {};

  for (const r of expenseRows) {
    const id = String(r?.id ?? r?.campaignId ?? '');
    if (!id) continue;
    const cur = get(id, r?.title);
    const total = parsePerfNumber(r?.moneySpent);
    const bonus = parsePerfNumber(r?.bonusSpent);
    // moneySpent — весь расход; бонусы — его часть, оплаченная не деньгами.
    const money = Math.max(0, total - bonus);
    cur.money += money;
    cur.bonus += bonus;
    const day = String(r?.date ?? '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] ?? 0) + money;
  }
  const hadExpense = expenseRows.length > 0;
  for (const r of dailyRows) {
    const id = String(r?.id ?? r?.campaignId ?? '');
    if (!id) continue;
    const cur = get(id, r?.title);
    cur.views += parsePerfNumber(r?.views);
    cur.clicks += parsePerfNumber(r?.clicks);
    cur.orders += parsePerfNumber(r?.orders);
    cur.ordersMoney += parsePerfNumber(r?.ordersMoney);
    // Если отчёт по расходам недоступен — берём расход из дневной статистики.
    if (!hadExpense) {
      const money = parsePerfNumber(r?.moneySpent);
      cur.money += money;
      const day = String(r?.date ?? '').slice(0, 10);
      if (day) byDay[day] = (byDay[day] ?? 0) + money;
    }
  }
  return {
    campaigns: [...byId.values()].filter(c => c.money + c.bonus + c.clicks + c.views > 0)
      .sort((a, b) => (b.money + b.bonus) - (a.money + a.bonus)),
    byDay,
  };
}

// ── Сеть ────────────────────────────────────────────────────────────────────

const tokens = new Map<string, { token: string; until: number }>();

async function getToken(cred: PerfCredentials, signal?: AbortSignal): Promise<string> {
  const cached = tokens.get(cred.clientId);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${PERF_PROXY}/api/client/token`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: cred.clientId, client_secret: cred.clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(res.status === 401 || res.status === 400
      ? 'Ozon Performance: неверные client_id / client_secret рекламного кабинета'
      : `Ozon Performance: токен не получен (${res.status}) ${text.slice(0, 120)}`);
  }
  const data = await res.json();
  const token = String(data?.access_token ?? '');
  if (!token) throw new Error('Ozon Performance: пустой токен');
  tokens.set(cred.clientId, { token, until: Date.now() + (Number(data?.expires_in) || 1800) * 1000 });
  return token;
}

async function perfGet<T>(cred: PerfCredentials, path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await getToken(cred, signal);
    const res = await fetch(`${PERF_PROXY}${path}`, {
      signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.ok) return res.json() as Promise<T>;
    if (res.status === 401) { tokens.delete(cred.clientId); continue; }
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Ozon Performance ${res.status} (${path.split('?')[0]}): ${text.slice(0, 150)}`);
  }
  throw new Error(`Ozon Performance: не удалось получить ${path.split('?')[0]}`);
}

const ymd = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

export const ozonPerformanceApi = {
  /** Проверить ключи: получить токен и список кампаний. */
  async check(cred: PerfCredentials): Promise<number> {
    tokens.delete(cred.clientId);
    const r = await perfGet<any>(cred, '/api/client/campaign');
    return (r?.list ?? []).length;
  },

  async campaigns(cred: PerfCredentials, signal?: AbortSignal): Promise<PerfCampaign[]> {
    const r = await perfGet<any>(cred, '/api/client/campaign', signal);
    return (r?.list ?? []).map(normalizeCampaign).filter((c: PerfCampaign) => c.id);
  },

  /** Расход на рекламу за период (границы — московские сутки). */
  async spend(cred: PerfCredentials, from: Date, to: Date, signal?: AbortSignal): Promise<PerfSpendResult> {
    const campaigns = await this.campaigns(cred, signal);
    const range = `dateFrom=${ymd(from)}&dateTo=${ymd(to)}`;
    const [expense, daily] = await Promise.all([
      perfGet<any>(cred, `/api/client/statistics/expense/json?${range}`, signal).catch(() => ({ rows: [] })),
      campaigns.length
        ? perfGet<any>(cred, `/api/client/statistics/daily/json?${campaigns.map(c => `campaignIds=${encodeURIComponent(c.id)}`).join('&')}&${range}`, signal)
            .catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
    ]);
    const expenseRows: any[] = expense?.rows ?? [];
    const dailyRows: any[] = daily?.rows ?? [];
    // SKU нужны только кампаниям, которые реально тратили.
    const spentIds = new Set([...expenseRows, ...dailyRows]
      .filter(r => parsePerfNumber(r?.moneySpent) > 0).map(r => String(r?.id ?? '')));
    const skusByCampaign: Record<string, string[]> = {};
    for (const c of campaigns) {
      if (!spentIds.has(c.id) || c.advObjectType.toUpperCase() !== 'SKU') continue;
      try {
        const obj = await perfGet<any>(cred, `/api/client/campaign/${encodeURIComponent(c.id)}/objects`, signal);
        skusByCampaign[c.id] = (obj?.list ?? []).map((o: any) => String(o?.id ?? '')).filter(Boolean);
      } catch { /* без SKU расход распределится по всем товарам */ }
    }
    return aggregatePerfSpend(campaigns, expenseRows, dailyRows, skusByCampaign);
  },
};
