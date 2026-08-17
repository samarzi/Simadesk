import { dbFetch } from './dbClient';
import { authService } from './authService';

const API_URL = import.meta.env.VITE_API_URL as string;
const YK_PAY_URL = `${API_URL}/functions/v1/yookassa-pay`;

export type PlanKey = 'free' | 'starter' | 'business' | 'pro' | 'max';

export interface Plan {
  key: PlanKey;
  label: string;
  priceRub: number;
  revenueMin: number;
  revenueMax: number | null;
  description: string;
}

export const PLANS: Plan[] = [
  { key: 'free',     label: 'Бесплатно', priceRub: 0,    revenueMin: 0,         revenueMax: 100_000,   description: 'до 100 000 ₽/мес' },
  { key: 'starter',  label: 'Старт',     priceRub: 990,  revenueMin: 100_000,   revenueMax: 500_000,   description: '100 000 — 500 000 ₽/мес' },
  { key: 'business', label: 'Бизнес',    priceRub: 2490, revenueMin: 500_000,   revenueMax: 2_000_000, description: '500 000 — 2 000 000 ₽/мес' },
  { key: 'pro',      label: 'Про',       priceRub: 4990, revenueMin: 2_000_000, revenueMax: 10_000_000, description: '2 000 000 — 10 000 000 ₽/мес' },
  { key: 'max',      label: 'Макс',      priceRub: 9990, revenueMin: 10_000_000, revenueMax: null,      description: 'от 10 000 000 ₽/мес' },
];

export function getPlanByRevenue(revenueRub: number): Plan {
  let result = PLANS[0];
  for (const p of PLANS) {
    if (revenueRub >= p.revenueMin) result = p;
  }
  return result;
}

export interface UserTrial {
  user_id: string;
  started_at: string;
  ends_at: string;
}

export interface UserSubscription {
  id: string;
  company_id: string;
  plan_key: PlanKey;
  monthly_revenue: number;
  price_rub: number;
  status: 'active' | 'cancelled' | 'expired';
  current_period_start: string | null;
  current_period_end: string | null;
  promo_code: string | null;
  promo_discount_rub: number;
}

class BillingService {
  private _trial: UserTrial | null = null;
  private _trialLoaded = false;

  async ensureTrial(): Promise<UserTrial | null> {
    if (this._trialLoaded) return this._trial;
    const user = authService.getUser();
    if (!user) return null;
    try {
      const res = await dbFetch<UserTrial>('/rpc/ensure_user_trial', {
        method: 'POST',
        body: JSON.stringify({ p_user_id: user.id }),
      });
      this._trial = res ?? null;
      this._trialLoaded = true;
      return this._trial;
    } catch {
      return null;
    }
  }

  isTrialActive(trial: UserTrial | null): boolean {
    if (!trial) return false;
    return new Date(trial.ends_at) > new Date();
  }

  trialDaysLeft(trial: UserTrial | null): number {
    if (!trial) return 0;
    const ms = new Date(trial.ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }

  async getSubscription(companyId: string): Promise<UserSubscription | null> {
    try {
      const res = await dbFetch<UserSubscription[]>(
        `/user_subscriptions?company_id=eq.${companyId}&select=*`,
      );
      return res?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async getMonthlyRevenue(companyId: string): Promise<number> {
    try {
      const res = await dbFetch<number>('/rpc/get_company_monthly_revenue', {
        method: 'POST',
        body: JSON.stringify({ p_company_id: companyId }),
      });
      return typeof res === 'number' ? res : 0;
    } catch {
      return 0;
    }
  }

  async checkPromoCode(code: string, companyId: string): Promise<{
    ok: boolean; error?: string;
    code?: string; discount_rub?: number; discount_percent?: number;
    description?: string; valid_until?: string | null;
    duration_months?: number | null;
    apply_from?: string; apply_to?: string | null; deferred?: boolean;
  }> {
    try {
      const res = await dbFetch<any>(
        '/rpc/check_promo_code',
        { method: 'POST', body: JSON.stringify({ p_code: code, p_company_id: companyId }) },
      );
      return res ?? { ok: false, error: 'Ошибка' };
    } catch (e: unknown) {
      return { ok: false, error: (e instanceof Error ? e.message : String(e)) ?? 'Ошибка' };
    }
  }

  async applyPromoCode(code: string, companyId: string): Promise<{
    ok: boolean; error?: string;
    discount_rub?: number; discount_percent?: number;
    description?: string; duration_months?: number | null;
    apply_from?: string; apply_to?: string | null; deferred?: boolean;
  }> {
    try {
      const res = await dbFetch<any>(
        '/rpc/apply_promo_code',
        { method: 'POST', body: JSON.stringify({ p_code: code, p_company_id: companyId }) },
      );
      return res ?? { ok: false, error: 'Ошибка' };
    } catch (e: unknown) {
      return { ok: false, error: (e instanceof Error ? e.message : String(e)) ?? 'Ошибка' };
    }
  }

  async createPayment(companyId: string, planKey: string, priceRub: number): Promise<{ payment_id: string; confirmation_url: string } | { error: string }> {
    const user = authService.getUser();
    if (!user) return { error: 'Не авторизован' };
    const token = authService.getAccessToken() ?? '';
    const returnUrl = `${window.location.origin}/?billing_payment=1`;
    try {
      const res = await fetch(YK_PAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ company_id: companyId, plan_key: planKey, price_rub: priceRub, return_url: returnUrl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) return { error: data.error ?? 'Ошибка создания платежа' };
      return data;
    } catch (e: unknown) {
      return { error: (e instanceof Error ? e.message : String(e)) ?? 'Ошибка' };
    }
  }

  async checkPayment(paymentId: string): Promise<{ status: string; paid: boolean } | null> {
    try {
      const res = await fetch(`${YK_PAY_URL}/status?payment_id=${paymentId}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  formatRevenue(rub: number): string {
    if (rub >= 1_000_000) return `${(rub / 1_000_000).toFixed(1).replace('.0', '')} млн ₽`;
    if (rub >= 1_000) return `${Math.round(rub / 1_000)} тыс ₽`;
    return `${rub} ₽`;
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}

export const billingService = new BillingService();
