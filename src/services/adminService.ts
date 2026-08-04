import { dbFetch } from './dbClient';

export interface AdminRole { is_admin: boolean; role?: 'superadmin' | 'admin' | 'support' | 'billing' }

export interface AdminUser {
  id: string;
  first_name: string;
  last_name: string | null;
  telegram_username: string | null;
  photo_url: string | null;
  created_at: string;
  last_login_at: string | null;
  banned_until: string | null;
  trial_ends_at: string | null;
  trial_days_left: number;
  admin_role: string | null;
  company_count: number;
  companies: Array<{ company_id: string; role: string; name: string }> | null;
  subscription: { plan_key: string; price_rub: number; status: string } | null;
}

export interface SiteContent {
  key: string;
  title: string;
  content: string;
  updated_at: string;
}

export interface AdminCompany {
  id: string;
  name: string;
  legal_name: string | null;
  type: string | null;
  inn: string | null;
  color: string;
  logo_url: string | null;
  created_at: string;
  owner_first_name: string | null;
  owner_last_name: string | null;
  owner_username: string | null;
  owner_id: string | null;
  member_count: number;
  monthly_revenue: number;
  subscription: { plan_key: string; price_rub: number; status: string } | null;
}

export interface AdminStats {
  total_users: number;
  new_users_7d: number;
  new_users_30d: number;
  total_companies: number;
  active_subs: number;
  trial_users: number;
  mrr: number;
  banned_users: number;
  open_tickets: number;
}

export interface PromoCode {
  id: string;
  code: string;
  discount_rub: number;
  discount_percent: number;
  description: string | null;
  valid_until: string | null;
  max_uses: number | null;
  use_count: number;
  is_active: boolean;
  created_at: string;
  duration_months: number | null;
  max_companies: number | null;
  redemption_count?: number;
  last_used_at?: string | null;
}

export interface PromoRedemption {
  id: string;
  code: string;
  discount_rub: number;
  discount_percent: number;
  redeemed_at: string;
  user_id: string | null;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  telegram_username: string | null;
  photo_url: string | null;
  company_name: string | null;
}

export interface SupportTicket {
  id: string;
  subject: string;
  message: string;
  status: 'open' | 'answered' | 'closed';
  admin_reply: string | null;
  created_at: string;
  replied_at: string | null;
  first_name: string;
  last_name: string | null;
  telegram_username: string | null;
  photo_url: string | null;
  company_name: string | null;
}

export interface MyTicket {
  id: string;
  subject: string;
  message: string;
  status: 'open' | 'answered' | 'closed';
  admin_reply: string | null;
  created_at: string;
  replied_at: string | null;
}

export interface PlanConfig {
  key: string;
  label: string;
  price_rub: number;
  revenue_min: number;
  revenue_max: number | null;
}

export interface AnalyticsData {
  users_by_day: Array<{ date: string; count: number }>;
  companies_by_day: Array<{ date: string; count: number }>;
  revenue_by_company: Array<{ name: string; revenue: number }>;
  plans_dist: Array<{ plan: string; count: number }>;
  admins: Array<{ user_id: string; role: string; created_at: string; first_name: string; last_name: string | null; telegram_username: string | null }>;
  total_users: number;
  total_companies: number;
  total_revenue: number;
}

export interface UserPickerItem {
  id: string;
  first_name: string;
  last_name: string | null;
  telegram_username: string | null;
  photo_url: string | null;
  company_count: number;
}

export interface CompanyPickerItem {
  id: string;
  name: string;
  logo_url: string | null;
  color: string;
  owner_first_name: string | null;
  owner_last_name: string | null;
  member_count: number;
}

export interface AdminCompanyWithApi {
  id: string;
  name: string;
  color: string;
  logo_url: string | null;
  created_at: string;
  owner_id: string | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  owner_username: string | null;
  member_count: number;
  has_ozon: boolean;
  has_wb: boolean;
  has_yandex: boolean;
  monthly_revenue: number;
  owner_trial_ends_at: string | null;
  subscription: {
    id: string;
    plan_key: string;
    price_rub: number;
    status: string;
    current_period_start: string | null;
    current_period_end: string | null;
  } | null;
}

class AdminService {
  private _role: AdminRole | null = null;

  async checkAdmin(): Promise<AdminRole> {
    if (this._role) return this._role;
    try {
      const res = await dbFetch<AdminRole>('/rpc/is_platform_admin', { method: 'POST', body: '{}' });
      this._role = res ?? { is_admin: false };
    } catch { this._role = { is_admin: false }; }
    return this._role;
  }

  clearCache() { this._role = null; }

  async getStats(): Promise<AdminStats | null> {
    try { return await dbFetch<AdminStats>('/rpc/admin_get_stats', { method: 'POST', body: '{}' }); }
    catch { return null; }
  }

  async getUsers(search = '', limit = 50, offset = 0): Promise<{ total: number; users: AdminUser[] }> {
    try {
      let res = await dbFetch<{ total: number; users: AdminUser[] } | Array<{ total: number; users: AdminUser[] }>>('/rpc/admin_get_users', {
        method: 'POST',
        body: JSON.stringify({ p_search: search, p_limit: limit, p_offset: offset }),
      });
      if (Array.isArray(res)) res = res[0] ?? null;
      return (res as { total: number; users: AdminUser[] }) ?? { total: 0, users: [] };
    } catch { return { total: 0, users: [] }; }
  }

  async getCompanies(search = '', limit = 50, offset = 0): Promise<{ total: number; companies: AdminCompany[] }> {
    try {
      let res = await dbFetch<{ total: number; companies: AdminCompany[] } | Array<{ total: number; companies: AdminCompany[] }>>('/rpc/admin_get_companies', {
        method: 'POST',
        body: JSON.stringify({ p_search: search, p_limit: limit, p_offset: offset }),
      });
      if (Array.isArray(res)) res = res[0] ?? null;
      return (res as { total: number; companies: AdminCompany[] }) ?? { total: 0, companies: [] };
    } catch { return { total: 0, companies: [] }; }
  }

  async banUser(userId: string, until: Date | null): Promise<void> {
    await dbFetch('/rpc/admin_ban_user', {
      method: 'POST',
      body: JSON.stringify({ p_target_user_id: userId, p_until: until?.toISOString() ?? null }),
    });
  }

  async setSubscription(userId: string, companyId: string, planKey: string, priceRub: number, months = 1): Promise<void> {
    await dbFetch('/rpc/admin_set_subscription', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId, p_company_id: companyId, p_plan_key: planKey, p_price_rub: priceRub, p_months: months }),
    });
  }

  async extendTrial(userId: string, days: number): Promise<void> {
    await dbFetch('/rpc/admin_extend_trial', {
      method: 'POST',
      body: JSON.stringify({ p_target_user_id: userId, p_days: days }),
    });
  }

  async deleteCompany(companyId: string): Promise<void> {
    await dbFetch('/rpc/admin_delete_company', {
      method: 'POST',
      body: JSON.stringify({ p_company_id: companyId }),
    });
  }

  async searchUsers(q = ''): Promise<UserPickerItem[]> {
    try {
      const res = await dbFetch<UserPickerItem[]>('/rpc/admin_search_users', {
        method: 'POST',
        body: JSON.stringify({ p_q: q, p_limit: 20 }),
      });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async searchCompanies(q = ''): Promise<CompanyPickerItem[]> {
    try {
      const res = await dbFetch<CompanyPickerItem[]>('/rpc/admin_search_companies', {
        method: 'POST',
        body: JSON.stringify({ p_q: q, p_limit: 20 }),
      });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async getPromos(): Promise<PromoCode[]> {
    try {
      const res = await dbFetch<PromoCode[]>('/rpc/admin_get_promos', { method: 'POST', body: '{}' });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async createPromo(code: string, discountRub: number, discountPercent: number, description: string, validUntil: string | null, maxUses: number | null, durationMonths: number | null = null, maxCompanies: number | null = null): Promise<PromoCode | null> {
    try {
      return await dbFetch<PromoCode>('/rpc/admin_create_promo', {
        method: 'POST',
        body: JSON.stringify({ p_code: code, p_discount_rub: discountRub, p_discount_percent: discountPercent, p_description: description, p_valid_until: validUntil, p_max_uses: maxUses, p_duration_months: durationMonths, p_max_companies: maxCompanies }),
      });
    } catch { return null; }
  }

  async togglePromo(id: string, active: boolean): Promise<void> {
    await dbFetch('/rpc/admin_toggle_promo', {
      method: 'POST',
      body: JSON.stringify({ p_promo_id: id, p_active: active }),
    });
  }

  async deletePromo(id: string): Promise<void> {
    await dbFetch('/rpc/admin_delete_promo', {
      method: 'POST',
      body: JSON.stringify({ p_promo_id: id }),
    });
  }

  async getPromoRedemptions(promoId?: string): Promise<PromoRedemption[]> {
    try {
      const res = await dbFetch<PromoRedemption[]>('/rpc/admin_get_promo_redemptions', {
        method: 'POST',
        body: JSON.stringify({ p_promo_id: promoId ?? null, p_limit: 100 }),
      });
      return Array.isArray(res) ? res : [];
    } catch (e) { console.error('[AdminService] getPromoRedemptions error:', e); return []; }
  }

  async getTickets(status = '', limit = 50, offset = 0): Promise<{ total: number; tickets: SupportTicket[] }> {
    try {
      const res = await dbFetch<{ total: number; tickets: SupportTicket[] }>('/rpc/admin_get_tickets', {
        method: 'POST',
        body: JSON.stringify({ p_status: status, p_limit: limit, p_offset: offset }),
      });
      return res ?? { total: 0, tickets: [] };
    } catch { return { total: 0, tickets: [] }; }
  }

  async replyTicket(ticketId: string, reply: string, status = 'answered'): Promise<void> {
    await dbFetch('/rpc/admin_reply_ticket', {
      method: 'POST',
      body: JSON.stringify({ p_ticket_id: ticketId, p_reply: reply, p_status: status }),
    });
  }

  async createTicket(message: string, subject = 'Обращение в поддержку', companyId?: string): Promise<string | null> {
    try {
      const res = await dbFetch<string>('/rpc/create_support_ticket', {
        method: 'POST',
        body: JSON.stringify({ p_message: message, p_subject: subject, p_company_id: companyId ?? null }),
      });
      return res ?? null;
    } catch { return null; }
  }

  async getMyTickets(): Promise<MyTicket[]> {
    try {
      const res = await dbFetch<MyTicket[]>('/rpc/get_my_tickets', { method: 'POST', body: '{}' });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async getAnalytics(): Promise<AnalyticsData | null> {
    try {
      const res = await dbFetch<AnalyticsData | AnalyticsData[]>('/rpc/admin_get_analytics', { method: 'POST', body: '{}' });
      // PostgREST may wrap scalar JSON in an array
      return Array.isArray(res) ? (res[0] ?? null) : res;
    } catch (e) {
      console.error('[AdminService] getAnalytics error:', e);
      return null;
    }
  }

  async grantRole(targetUserId: string, role: string): Promise<void> {
    await dbFetch('/rpc/admin_grant_role', {
      method: 'POST',
      body: JSON.stringify({ p_target_user_id: targetUserId, p_role: role }),
    });
  }

  async revokeRole(targetUserId: string): Promise<void> {
    await dbFetch('/rpc/admin_revoke_role', {
      method: 'POST',
      body: JSON.stringify({ p_target_user_id: targetUserId }),
    });
  }

  async getPlanConfigs(): Promise<PlanConfig[]> {
    try {
      const res = await dbFetch<PlanConfig[]>('/rpc/get_plan_configs', { method: 'POST', body: '{}' });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async updatePlan(key: string, priceRub: number, revenueMin?: number, revenueMax?: number | null): Promise<void> {
    await dbFetch('/rpc/admin_update_plan', {
      method: 'POST',
      body: JSON.stringify({
        p_key: key, p_price_rub: priceRub,
        p_revenue_min: revenueMin ?? null,
        p_revenue_max: revenueMax !== undefined ? revenueMax : undefined,
      }),
    });
  }

  /** Load AI boost package price overrides from platform_settings. */
  async getAiBoostPrices(): Promise<Record<string, number>> {
    try {
      const res = await dbFetch<Array<{ value: Record<string, number> }>>(
        'platform_settings?key=eq.ai_boost_prices&select=value',
      );
      return res?.[0]?.value ?? {};
    } catch { return {}; }
  }

  /** Overwrite AI boost prices (platform admin only). */
  async updateAiBoostPrices(prices: Record<string, number>): Promise<void> {
    await dbFetch(
      'platform_settings',
      {
        method: 'POST',
        body: JSON.stringify({ key: 'ai_boost_prices', value: prices, updated_at: new Date().toISOString() }),
      },
      { 'Prefer': 'resolution=merge-duplicates' },
    );
  }

  async deleteUser(userId: string): Promise<void> {
    await dbFetch('/rpc/admin_delete_user', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId }),
    });
  }

  async getCompaniesWithApi(search = ''): Promise<AdminCompanyWithApi[]> {
    try {
      const res = await dbFetch<AdminCompanyWithApi[]>('/rpc/admin_get_companies_with_api', {
        method: 'POST',
        body: JSON.stringify({ p_search: search, p_limit: 200 }),
      });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async extendSubscription(companyId: string, days: number): Promise<void> {
    await dbFetch('/rpc/admin_extend_subscription', {
      method: 'POST',
      body: JSON.stringify({ p_company_id: companyId, p_days: days }),
    });
  }

  async setSubscriptionEnd(companyId: string, endDate: string): Promise<void> {
    await dbFetch('/rpc/admin_set_subscription_end', {
      method: 'POST',
      body: JSON.stringify({ p_company_id: companyId, p_end_date: endDate }),
    });
  }

  async getSiteContent(): Promise<SiteContent[]> {
    try {
      const res = await dbFetch<SiteContent[]>('/rpc/get_site_content', { method: 'POST', body: '{}' });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async saveSiteContent(key: string, title: string, content: string): Promise<void> {
    await dbFetch('/rpc/admin_save_site_content', {
      method: 'POST',
      body: JSON.stringify({ p_key: key, p_title: title, p_content: content }),
    });
  }

  fmt(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + ' млн';
    if (n >= 1_000) return Math.round(n / 1_000) + ' тыс';
    return String(n);
  }

  fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  fmtMoney(rub: number): string {
    if (!rub) return '—';
    return rub.toLocaleString('ru-RU') + ' ₽';
  }
}

export const adminService = new AdminService();
