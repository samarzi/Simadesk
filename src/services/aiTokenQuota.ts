/**
 * Учёт расхода AI-ассистента Сима и совместимость со старым хранением квот.
 *
 * По каждому запросу сохраняются реальные токены и стоимость (её отдаёт OpenRouter,
 * иначе стоимость оценивается по прайсу выбранной модели).
 *
 * Суточная блокировка ИИ снята. Старые функции расчёта квоты оставлены для
 * совместимости с сохранёнными пользовательскими настройками и историческими пакетами.
 */

/** Цена базовой модели (Claude Haiku 4.5), $ за токен. */
export const BASE_MODEL_ID = 'anthropic/claude-haiku-4.5';
const BASE_PROMPT_USD = 1 / 1_000_000;
const BASE_COMPLETION_USD = 5 / 1_000_000;
/**
 * Средняя цена токена базовой модели для запроса Симы: ~97% токенов — вход
 * (системный промпт + контекст страницы), ~3% — ответ.
 */
export const BASE_USD_PER_TOKEN = 0.97 * BASE_PROMPT_USD + 0.03 * BASE_COMPLETION_USD;

export interface AiBoostPackage {
  key: string;
  label: string;
  multiplier: number;   // relative to FREE_DAILY_TOKENS
  priceRub: number;     // monthly price
  /** Токенов в день в пересчёте на базовую модель. */
  tokensPerDay: number;
  badge: string;
}

/** Историческая базовая величина квоты, в токенах базовой модели. */
export const FREE_DAILY_TOKENS = 50_000;

/** Базовые (дефолтные) пакеты — цены могут быть переопределены через platform_settings. */
export const AI_BOOST_PACKAGES: AiBoostPackage[] = [
  {
    key: 'ai_x5',
    label: 'Буст ×5',
    multiplier: 5,
    priceRub: 290,
    tokensPerDay: FREE_DAILY_TOKENS * 5,
    badge: '×5',
  },
  {
    key: 'ai_x10',
    label: 'Буст ×10',
    multiplier: 10,
    priceRub: 490,
    tokensPerDay: FREE_DAILY_TOKENS * 10,
    badge: '×10',
  },
  {
    key: 'ai_x20',
    label: 'Буст ×20',
    multiplier: 20,
    priceRub: 890,
    tokensPerDay: FREE_DAILY_TOKENS * 20,
    badge: '×20',
  },
];

// ── Динамические цены (загружаются из Supabase platform_settings) ─────────────

let _priceOverrides: Record<string, number> | null = null;

/** Применить цены из platform_settings (вызывается при загрузке BillingModule). */
export function setAiBoostPriceOverrides(prices: Record<string, number>): void {
  _priceOverrides = prices;
}

/** Возвращает пакеты с актуальными ценами (с учётом переопределений). */
export function getAiBoostPackages(): AiBoostPackage[] {
  if (!_priceOverrides) return AI_BOOST_PACKAGES;
  return AI_BOOST_PACKAGES.map(pkg => ({
    ...pkg,
    priceRub: _priceOverrides![pkg.key] ?? pkg.priceRub,
  }));
}

// ── Стоимость запроса ─────────────────────────────────────────────────────────

interface ModelPrice { prompt: number; completion: number }

/** Прайс модели из кеша списка моделей OpenRouter (его заполняет пикер моделей). */
function lookupModelPrice(model: string): ModelPrice | null {
  try {
    const raw = localStorage.getItem('sd_or_models_v2');
    if (!raw) return null;
    const list = (JSON.parse(raw)?.data ?? []) as Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    // «claude-haiku-4-5» и «claude-haiku-4.5» — одна и та же модель
    const alt = model.replace(/(\d)-(\d)/g, '$1.$2');
    const m = list.find(x => x.id === model) ?? list.find(x => x.id === alt);
    if (!m?.pricing) return null;
    const prompt = Number(m.pricing.prompt);
    const completion = Number(m.pricing.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return { prompt, completion };
  } catch {
    return null;
  }
}

/** Стоимость запроса в $, если OpenRouter её не вернул. */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = lookupModelPrice(model) ?? { prompt: BASE_PROMPT_USD, completion: BASE_COMPLETION_USD };
  return promptTokens * price.prompt + completionTokens * price.completion;
}

/** Во сколько раз модель расходует лимит быстрее базовой (для подсказок в UI). */
export function modelLimitMultiplier(model: string): number | null {
  const price = lookupModelPrice(model);
  if (!price) return null;
  return (0.97 * price.prompt + 0.03 * price.completion) / BASE_USD_PER_TOKEN;
}

// ── Хранение в localStorage ────────────────────────────────────────────────────

const TOKENS_PREFIX = 'sd_ai_daily_';
const COST_PREFIX = 'sd_ai_cost_';

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Реальные токены, израсходованные сегодня. */
export function getDailyTokensUsed(): number {
  return Number(localStorage.getItem(TOKENS_PREFIX + today()) ?? 0) || 0;
}

/** Реальная стоимость запросов за сегодня, $. */
export function getDailyCostUsed(): number {
  const raw = localStorage.getItem(COST_PREFIX + today());
  if (raw !== null) return Number(raw) || 0;
  // Расход, записанный до перехода на учёт стоимости, — по цене базовой модели
  return getDailyTokensUsed() * BASE_USD_PER_TOKEN;
}

export interface AiSpend {
  prompt: number;
  completion: number;
  total: number;
  /** Стоимость от OpenRouter, $. */
  cost?: number;
}

/**
 * Записать расход запроса: токены и стоимость.
 * Возвращает стоимость, которая ушла в лимит, $.
 */
export function recordAiSpend(usage: AiSpend, model: string): number {
  const tokens = usage.total || usage.prompt + usage.completion;
  const cost = usage.cost !== undefined && usage.cost > 0
    ? usage.cost
    : estimateCostUsd(model, usage.prompt, usage.completion);
  if (tokens <= 0 && cost <= 0) return 0;
  const costBefore = getDailyCostUsed();
  const d = today();
  localStorage.setItem(TOKENS_PREFIX + d, String(getDailyTokensUsed() + Math.max(0, tokens)));
  localStorage.setItem(COST_PREFIX + d, String(costBefore + Math.max(0, cost)));
  cleanOldKeys();
  return cost;
}

function cleanOldKeys(): void {
  const d = today();
  Object.keys(localStorage)
    .filter(k => (k.startsWith(TOKENS_PREFIX) || k.startsWith(COST_PREFIX)) && !k.endsWith(d))
    .forEach(k => localStorage.removeItem(k));
}

// ── Активный пакет ────────────────────────────────────────────────────────────

/** Ключ активного пакета (sd_ai_boost_package = 'ai_x5' | 'ai_x10' | 'ai_x20' | null) */
export function getActiveBoostPackage(): AiBoostPackage | null {
  const key = localStorage.getItem('sd_ai_boost_package');
  return AI_BOOST_PACKAGES.find(p => p.key === key) ?? null;
}

export function setActiveBoostPackage(key: string | null): void {
  if (key) localStorage.setItem('sd_ai_boost_package', key);
  else localStorage.removeItem('sd_ai_boost_package');
}

// ── Лимиты ────────────────────────────────────────────────────────────────────

/** Дневной лимит в токенах базовой модели. */
export function getDailyLimit(): number {
  const boost = getActiveBoostPackage();
  if (boost) return boost.tokensPerDay;
  return FREE_DAILY_TOKENS;
}

/** Дневной бюджет, $. */
export function getDailyBudgetUsd(): number {
  return getDailyLimit() * BASE_USD_PER_TOKEN;
}

/** Информация о квоте для отображения. */
export interface QuotaInfo {
  /** Реальные токены за сегодня (любых моделей). */
  tokens: number;
  /** Реальная стоимость за сегодня, $. */
  costUsd: number;
  /** Дневной бюджет, $. */
  budgetUsd: number;
  /** Лимит в токенах базовой модели. */
  limit: number;
  /** Сколько ещё токенов базовой модели можно потратить сегодня. */
  remaining: number;
  pct: number;         // 0–100, доля израсходованного бюджета
  exhausted: boolean;
  boostPackage: AiBoostPackage | null;
}

export function getQuotaInfo(): QuotaInfo {
  const limit = getDailyLimit();
  const budgetUsd = limit * BASE_USD_PER_TOKEN;
  const costUsd = getDailyCostUsed();
  const remainingUsd = Math.max(0, budgetUsd - costUsd);
  return {
    tokens: getDailyTokensUsed(),
    costUsd,
    budgetUsd,
    limit,
    remaining: Math.floor(remainingUsd / BASE_USD_PER_TOKEN),
    pct: budgetUsd > 0 ? Math.min(100, Math.round((costUsd / budgetUsd) * 100)) : 100,
    exhausted: remainingUsd <= 0,
    boostPackage: getActiveBoostPackage(),
  };
}

/** Legacy-проверка квоты; запросы больше не блокируются по дневному остатку. */
export function hasQuota(): boolean {
  return true;
}
