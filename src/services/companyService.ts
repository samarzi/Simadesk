/**
 * Company Service — CRUD for companies + active company state.
 *
 * Responsibilities:
 *  - Load user's companies from Supabase
 *  - Create / update / delete companies
 *  - Track which company is currently active (persisted in localStorage)
 *  - Provide company_id for all insert operations across the app
 */

import { supaFetch } from './supabaseClient';
import { authService } from './authService';
import { cookies } from '@/utils/cookies';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  /** Удобное рабочее название (не юридическое) */
  name: string;
  /** Юридическое название (ООО Ромашка / ИП Иванов и т.д.) */
  legal_name?: string | null;
  type?: 'ip' | 'ooo' | 'self_employed' | 'individual' | null;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  legal_address?: string | null;
  bank_account?: string | null;
  bik?: string | null;
  bank_name?: string | null;
  corr_account?: string | null;
  email?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  color: string;
  created_at: string;
  created_by?: string | null;
  /** Populated from company_members JOIN (role of current user) */
  role?: 'owner' | 'admin' | 'manager' | 'viewer';
}

export type CompanyRole = 'owner' | 'admin' | 'manager' | 'viewer';

const ACTIVE_KEY = 'active_company_id';

// ── Service class ─────────────────────────────────────────────────────────────

class CompanyService {
  private _companies: Company[] = [];
  private _activeId: string | null = null;
  private _listeners: Array<() => void> = [];

  constructor() {
    this._activeId = localStorage.getItem(ACTIVE_KEY) || cookies.get(ACTIVE_KEY);
  }

  // ── Change listeners ──────────────────────────────────────────────────────

  onChange(fn: () => void): () => void {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

  private notify(): void {
    this._listeners.forEach(fn => fn());
  }

  // ── Active company ────────────────────────────────────────────────────────

  getActiveId(): string | null {
    return this._activeId;
  }

  getActive(): Company | null {
    return this._companies.find(c => c.id === this._activeId) ?? null;
  }

  setActive(companyId: string): void {
    this._activeId = companyId;
    localStorage.setItem(ACTIVE_KEY, companyId);
    cookies.set(ACTIVE_KEY, companyId);
    this.notify();
  }

  getAll(): Company[] {
    return this._companies;
  }

  // ── Load companies for current user ──────────────────────────────────────

  async load(): Promise<Company[]> {
    // Use the my_companies view which already filters by current user
    const rows = await supaFetch<(Company & { role: CompanyRole; joined_at: string })[]>(
      'my_companies?select=*&order=created_at.asc',
    );
    this._companies = rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type ?? null,
      inn: r.inn ?? null,
      kpp: r.kpp ?? null,
      ogrn: r.ogrn ?? null,
      legal_address: r.legal_address ?? null,
      bank_account: r.bank_account ?? null,
      bik: r.bik ?? null,
      bank_name: r.bank_name ?? null,
      corr_account: r.corr_account ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      logo_url: r.logo_url ?? null,
      color: r.color ?? '#005bff',
      created_at: r.created_at,
      created_by: (r as any).created_by ?? null,
      role: r.role,
    }));

    // Auto-select: restore saved or pick first
    if (this._activeId && !this._companies.find(c => c.id === this._activeId)) {
      this._activeId = null;
    }
    if (!this._activeId && this._companies.length > 0) {
      this._activeId = this._companies[0].id;
      localStorage.setItem(ACTIVE_KEY, this._activeId);
    }

    this.notify();
    return this._companies;
  }

  // ── Create company ────────────────────────────────────────────────────────

  async create(data: {
    name: string;
    legal_name?: string;
    type?: Company['type'];
    inn?: string;
    kpp?: string;
    ogrn?: string;
    legal_address?: string;
    bank_account?: string;
    bik?: string;
    bank_name?: string;
    corr_account?: string;
    email?: string;
    phone?: string;
    color?: string;
  }): Promise<Company> {
    const payload = {
      name: data.name.trim(),
      legal_name: data.legal_name?.trim() || null,
      type: data.type ?? null,
      inn: data.inn?.trim() || null,
      kpp: data.kpp?.trim() || null,
      ogrn: data.ogrn?.trim() || null,
      legal_address: data.legal_address?.trim() || null,
      bank_account: data.bank_account?.trim() || null,
      bik: data.bik?.trim() || null,
      bank_name: data.bank_name?.trim() || null,
      corr_account: data.corr_account?.trim() || null,
      email: data.email?.trim() || null,
      phone: data.phone?.trim() || null,
      color: data.color || '#005bff',
      created_by: authService.getUser()?.id ?? null,
    };

    const result = await supaFetch<Company[]>('companies', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const company: Company = Array.isArray(result) ? result[0] : result as unknown as Company;

    // Add owner membership (the DB trigger might handle this,
    // but we do it explicitly to be safe)
    try {
      await supaFetch('company_members', {
        method: 'POST',
        body: JSON.stringify({
          company_id: company.id,
          user_id: authService.getUser()?.id,
          role: 'owner',
        }),
      });
    } catch (e) {
      // Ignore duplicate key if trigger already inserted it
      console.warn('[companyService] member insert:', e);
    }

    company.role = 'owner';
    this._companies.push(company);
    this.setActive(company.id);
    return company;
  }

  // ── Update company ────────────────────────────────────────────────────────

  async update(id: string, updates: Partial<Omit<Company, 'id' | 'created_at' | 'created_by' | 'role'>>): Promise<void> {
    await supaFetch(`companies?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    const idx = this._companies.findIndex(c => c.id === id);
    if (idx !== -1) {
      this._companies[idx] = { ...this._companies[idx], ...updates };
      this.notify();
    }
  }

  // ── Delete company (owner only) ───────────────────────────────────────────

  async delete(id: string): Promise<void> {
    await supaFetch(`companies?id=eq.${id}`, { method: 'DELETE' });
    this._companies = this._companies.filter(c => c.id !== id);
    if (this._activeId === id) {
      this._activeId = this._companies[0]?.id ?? null;
      if (this._activeId) {
        localStorage.setItem(ACTIVE_KEY, this._activeId);
        cookies.set(ACTIVE_KEY, this._activeId);
      } else {
        localStorage.removeItem(ACTIVE_KEY);
        cookies.remove(ACTIVE_KEY);
      }
    }
    this.notify();
  }

  // ── Members ───────────────────────────────────────────────────────────────

  async getMembers(companyId: string): Promise<Array<{
    id: string;
    user_id: string;
    role: CompanyRole;
    joined_at: string;
    first_name: string;
    telegram_username: string | null;
    photo_url: string | null;
  }>> {
    return supaFetch(
      `company_members?company_id=eq.${companyId}&select=id,user_id,role,joined_at,users(first_name,telegram_username,photo_url)`,
    );
  }

  async removeMember(memberId: string): Promise<void> {
    await supaFetch(`company_members?id=eq.${memberId}`, { method: 'DELETE' });
  }

  async updateMemberRole(memberId: string, role: CompanyRole): Promise<void> {
    await supaFetch(`company_members?id=eq.${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  }

  // ── Invitation by token ───────────────────────────────────────────────────

  async createInvite(companyId: string, role: 'admin' | 'manager' | 'viewer'): Promise<string> {
    const result = await supaFetch<Array<{ token: string }>>('company_invitations', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, role }),
    });
    return (Array.isArray(result) ? result[0] : result as any).token;
  }

  getInviteUrl(token: string): string {
    return `${location.origin}/join?token=${token}`;
  }

  // ── Invitation by Telegram username ───────────────────────────────────────

  async inviteByUsername(companyId: string, telegramUsername: string, role: CompanyRole): Promise<void> {
    const username = telegramUsername.replace(/^@/, '').toLowerCase().trim();
    if (!username) throw new Error('Пустой username');
    await supaFetch('company_invitations', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        telegram_username: username,
        role,
        invited_by: authService.getUser()?.id ?? null,
      }),
    });
  }

  async getPendingInvitations(companyId: string): Promise<Array<{
    id: string;
    telegram_username: string;
    role: CompanyRole;
    created_at: string;
  }>> {
    // Все ещё неиспользованные приглашения этой компании (с username или с токеном)
    const rows = await supaFetch<any[]>(
      `company_invitations?company_id=eq.${companyId}&used_at=is.null&select=id,telegram_username,role,created_at,token&order=created_at.desc`,
    );
    return (rows ?? []).map((r: any) => ({
      id: r.id,
      telegram_username: r.telegram_username ?? `(по ссылке-токену)`,
      role: r.role,
      created_at: r.created_at,
    }));
  }

  async cancelPendingInvitation(id: string): Promise<void> {
    await supaFetch(`company_invitations?id=eq.${id}`, { method: 'DELETE' });
  }

  // ── My incoming invitations (for the current user to accept/decline) ──────

  async getMyPendingInvitations(): Promise<Array<{
    id: string;
    company_id: string;
    role: CompanyRole;
    created_at: string;
    company: { name: string; color: string; logo_url?: string | null } | null;
  }>> {
    const user = authService.getUser();
    const username = (user?.username ?? '').replace(/^@/, '').toLowerCase().trim();
    if (!username) return [];
    try {
      const rows = await supaFetch<any[]>(
        `company_invitations?telegram_username=eq.${encodeURIComponent(username)}&used_at=is.null&select=id,company_id,role,created_at,companies(name,color,logo_url)&order=created_at.desc`,
      );
      return (rows ?? []).map((r: any) => ({
        id: r.id,
        company_id: r.company_id,
        role: r.role,
        created_at: r.created_at,
        company: r.companies ?? null,
      }));
    } catch {
      return [];
    }
  }

  async acceptInvitation(inviteId: string, companyId: string, role: CompanyRole): Promise<void> {
    const user = authService.getUser();
    if (!user) throw new Error('Не авторизован');
    // Insert into company_members (ignore duplicate)
    try {
      await supaFetch('company_members', {
        method: 'POST',
        body: JSON.stringify({ company_id: companyId, user_id: user.id, role }),
      });
    } catch (e) {
      console.warn('[companyService] acceptInvitation member insert:', e);
    }
    // Mark invitation as used
    await supaFetch(`company_invitations?id=eq.${inviteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    });
    // Reload companies list so new company appears immediately
    await this.load();
  }

  async declineInvitation(inviteId: string): Promise<void> {
    await supaFetch(`company_invitations?id=eq.${inviteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    });
  }
}

export const companyService = new CompanyService();
