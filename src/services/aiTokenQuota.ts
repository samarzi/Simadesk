/**
 * Ежедневные лимиты токенов на AI-ассистента Сима.
 *
 * Экономика:
 *  - Модель Claude Haiku 4.5: ~$0.80/1M input + $4/1M output ≈ $1.76/1M blended
 *  - По курсу 90 ₽/$ → ~0.158 ₽ за 1 000 токенов
 *  - Бесплатно: 250 ₽/мес → 50 000 токенов/день (≈40–50 запросов)
 *  - Пакеты продаются с маржой ~2.5×
 */

export interface AiBoostPackage {
  key: string;
  label: string;
  multiplier: number;   // relative to FREE_DAILY_TOKENS
  priceRub: number;     // monthly price
  tokensPerDay: number;
  badge: string;
}

/** Базовый ежедневный лимит (FREE). */
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

// ── Хранение в localStorage ────────────────────────────────────────────────────

function todayKey(): string {
  return 'sd_ai_daily_' + new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Токены, израсходованные сегодня. */
export function getDailyTokensUsed(): number {
  return Number(localStorage.getItem(todayKey()) ?? 0);
}

/** Записать расход токенов (прибавить к дневному счётчику). */
export function recordDailyTokens(count: number): void {
  if (count <= 0) return;
  const key = todayKey();
  const cur = Number(localStorage.getItem(key) ?? 0);
  localStorage.setItem(key, String(cur + count));
  // Чистим счётчики старше 3 дней, чтобы не засорять localStorage
  cleanOldKeys();
}

function cleanOldKeys(): void {
  const today = todayKey();
  Object.keys(localStorage)
    .filter(k => k.startsWith('sd_ai_daily_') && k !== today)
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

/** Ежедневный лимит токенов для текущего пользователя. */
export function getDailyLimit(): number {
  const boost = getActiveBoostPackage();
  if (boost) return boost.tokensPerDay;
  return FREE_DAILY_TOKENS;
}

/** Остаток токенов на сегодня. */
export function getDailyRemaining(): number {
  return Math.max(0, getDailyLimit() - getDailyTokensUsed());
}

/** Информация о квоте для отображения. */
export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  pct: number;         // 0–100
  exhausted: boolean;
  boostPackage: AiBoostPackage | null;
}

export function getQuotaInfo(): QuotaInfo {
  const limit = getDailyLimit();
  const used  = getDailyTokensUsed();
  const remaining = Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
    pct: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100,
    exhausted: remaining === 0,
    boostPackage: getActiveBoostPackage(),
  };
}

/** Можно ли сделать ещё один запрос (есть хоть что-то в запасе). */
export function hasQuota(): boolean {
  return getDailyRemaining() > 0;
}
