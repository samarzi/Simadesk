/**
 * ProfileModule — Full-page profile:
 * - Company switching
 * - Team management
 * - Requisites editing/copying
 * - User info
 */

import { companyService, Company } from '@/services/companyService';
import { authService } from '@/services/authService';
import { showToast } from '@/utils/toast';
import { copyButton } from '@/utils/copyButton';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  manager: 'Менеджер',
  viewer: 'Наблюдатель',
};
const ROLE_COLORS: Record<string, string> = {
  owner: '#7c3aed',
  admin: '#005bff',
  manager: '#059669',
  viewer: '#6b7280',
};

export class ProfileModule {
  private el: HTMLElement;
  private activeTab: 'companies' | 'team' | 'requisites' = 'companies';
  private teamMembers: Array<any> = [];
  private pendingInvites: Array<any> = [];
  /** Incoming invitations sent TO current user */
  private myIncomingInvites: Array<any> = [];

  constructor(el: HTMLElement) {
    this.el = el;
  }

  show(): void {
    this.el.style.display = 'flex';
    this.activeTab = 'companies';
    this.render();
    this.refreshCompanies();
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  setTab(tab: 'companies' | 'team' | 'requisites'): void {
    this.activeTab = tab;
    if (tab === 'team') {
      const c = companyService.getActive();
      if (c) this.loadTeam(c.id);
    }
    this.render();
  }

  render(): void {
    const user = authService.getUser();
    const company = companyService.getActive();
    const companies = companyService.getAll();

    this.el.innerHTML = `
      <div class="profile-page">
        <div class="profile-page-header">
          <div class="profile-page-user">
            <div class="profile-page-avatar">
              ${user?.photo_url
                ? `<img src="${this.esc(user.photo_url)}" alt="">`
                : `<span>${(user?.first_name?.[0] ?? 'U').toUpperCase()}</span>`}
            </div>
            <div class="profile-page-user-info">
              <div class="profile-page-name">${this.esc(user?.first_name ?? '')} ${this.esc(user?.last_name ?? '')}</div>
              <div class="profile-page-username">${user?.username ? '@' + this.esc(user.username) : ''}</div>
            </div>
          </div>
          <button class="profile-page-logout" onclick="window.profileModule.logout()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
            Выйти
          </button>
        </div>

        <div class="profile-page-tabs">
          <button class="profile-page-tab ${this.activeTab === 'companies' ? 'active' : ''}" onclick="window.profileModule.setTab('companies')">Компании</button>
          <button class="profile-page-tab ${this.activeTab === 'team' ? 'active' : ''}" onclick="window.profileModule.setTab('team')">Команда</button>
          <button class="profile-page-tab ${this.activeTab === 'requisites' ? 'active' : ''}" onclick="window.profileModule.setTab('requisites')">Реквизиты</button>
        </div>

        <div class="profile-page-content">
          ${this.activeTab === 'companies' ? this.renderCompanies(companies, company) : ''}
          ${this.activeTab === 'team' ? this.renderTeam(company) : ''}
          ${this.activeTab === 'requisites' ? this.renderRequisites(company) : ''}
        </div>
        <div style="height:140px;flex-shrink:0"></div>
      </div>
    `;

    this.bindEvents();
  }

  private renderCompanies(companies: Company[], active: Company | null): string {
    const canEdit = (c: Company) => c.role === 'owner' || c.role === 'admin';

    const invitesHtml = this.myIncomingInvites.length === 0 ? '' : `
      <div class="profile-section-title" style="margin-top:20px">
        Входящие приглашения
        <span style="background:#6366f1;color:#fff;font-size:10px;padding:1px 7px;border-radius:20px;margin-left:6px;font-weight:700">${this.myIncomingInvites.length}</span>
      </div>
      ${this.myIncomingInvites.map(inv => `
        <div class="profile-company-card" style="border:1px solid rgba(99,102,241,0.3)">
          <div style="width:42px;height:42px;border-radius:11px;background:${inv.company?.color ?? 'linear-gradient(135deg,#6366f1,#8b5cf6)'};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:#fff;overflow:hidden;flex-shrink:0;font-family:system-ui,sans-serif;letter-spacing:-0.5px;text-shadow:0 1px 4px rgba(0,0,0,0.3)">
            ${inv.company?.logo_url
              ? `<img src="${this.esc(inv.company.logo_url)}" alt="" style="width:100%;height:100%;object-fit:cover">`
              : `${(inv.company?.name?.[0] ?? '?').toUpperCase()}`}
          </div>
          <div class="profile-company-info" style="flex:1">
            <div class="profile-company-name">${this.esc(inv.company?.name ?? 'Компания')}</div>
            <div class="profile-company-role" style="color:#6366f1">Приглашение · ${ROLE_LABELS[inv.role] ?? inv.role}</div>
          </div>
          <button class="profile-page-btn" style="padding:5px 12px;font-size:12px;margin-right:4px" data-accept-invite="${inv.id}" data-invite-company="${inv.company_id}" data-invite-role="${inv.role}">Принять</button>
          <button style="padding:5px 10px;font-size:12px;background:transparent;border:1px solid var(--border2);border-radius:8px;color:var(--text2);cursor:pointer" data-decline-invite="${inv.id}">✕</button>
        </div>
      `).join('')}
    `;

    // NOTE: no double-quotes inside — the string goes into style="..." attribute
    const logoStyle = 'width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:#fff;overflow:hidden;flex-shrink:0;font-family:system-ui,sans-serif;letter-spacing:-0.5px;text-shadow:0 1px 4px rgba(0,0,0,0.3)';

    return `
      <div class="profile-companies">
        ${invitesHtml}
        <div class="profile-section-title" style="${this.myIncomingInvites.length > 0 ? 'margin-top:20px' : ''}">Мои компании</div>
        ${companies.map(c => `
          <div class="profile-company-card ${c.id === active?.id ? 'active' : ''}" data-switch-company="${c.id}">
            <div style="${logoStyle};background:${c.color ?? 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)'}">
              ${c.logo_url
                ? `<img src="${this.esc(c.logo_url)}" alt="" style="width:100%;height:100%;object-fit:cover">`
                : `${(c.name?.[0] ?? '?').toUpperCase()}`}
            </div>
            <div class="profile-company-info">
              <div class="profile-company-name">${this.esc(c.name)}</div>
              <div class="profile-company-role">${ROLE_LABELS[c.role ?? 'owner'] ?? c.role}</div>
            </div>
            ${c.id === active?.id ? '<div class="profile-company-check">&#10003;</div>' : ''}
            ${canEdit(c) ? `
              <button class="profile-company-edit-btn" data-edit-company="${c.id}" title="Настройки компании"
                style="margin-left:4px;width:28px;height:28px;border-radius:7px;border:1px solid var(--border2);background:var(--bg3);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;color:var(--text2)">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                  <circle cx="8" cy="8" r="2"/>
                  <path d="M13 8a5 5 0 0 0-.1-1l1.5-1.2-1.4-2.4-1.8.5a5 5 0 0 0-1.8-1L8.9 1H7.1l-.5 1.8a5 5 0 0 0-1.8 1l-1.8-.5L1.6 5.8 3.1 7a5 5 0 0 0 0 2L1.6 10.2l1.4 2.4 1.8-.5a5 5 0 0 0 1.8 1l.5 1.8h1.8l.5-1.8a5 5 0 0 0 1.8-1l1.8.5 1.4-2.4L12.9 9c.1-.3.1-.7.1-1z"/>
                </svg>
              </button>
            ` : ''}
          </div>
        `).join('')}

        <button id="prof-add-company-btn"
          style="margin-top:10px;width:100%;padding:10px 14px;display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px dashed var(--border2);border-radius:12px;cursor:pointer;color:var(--text2);font-size:13px;transition:border-color .15s,color .15s">
          <span style="width:30px;height:30px;border-radius:8px;background:var(--bg2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;color:var(--text3)">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 1v12M1 7h12"/></svg>
          </span>
          Создать новую компанию
        </button>
      </div>
    `;
  }

  private renderTeam(company: Company | null): string {
    if (!company) return '<div style="padding:20px;color:var(--text3)">Нет активной компании</div>';
    const canManage = company.role === 'owner' || company.role === 'admin';

    const members = this.teamMembers.length === 0
      ? `<div style="padding:20px;color:var(--text3);text-align:center">Загрузка...</div>`
      : this.teamMembers.map(m => `
        <div class="profile-team-row">
          <div class="profile-team-avatar">
            ${m.photo_url
              ? `<img src="${this.esc(m.photo_url)}" alt="">`
              : `<span>${(m.first_name?.[0] ?? '?').toUpperCase()}</span>`}
          </div>
          <div class="profile-team-info">
            <div class="profile-team-name">${this.esc(m.first_name ?? '')}</div>
            <div class="profile-team-tg">${m.telegram_username ? '@' + this.esc(m.telegram_username) : ''}</div>
          </div>
          <div class="profile-team-badge" style="--badge-color:${ROLE_COLORS[m.role]}">${ROLE_LABELS[m.role] ?? m.role}</div>
          ${canManage && m.role !== 'owner' ? `
            <select class="profile-team-role-select" onchange="window.profileModule.changeMemberRole('${this.esc(m.id)}', this.value)">
              <option value="admin"   ${m.role === 'admin'   ? 'selected' : ''}>Администратор</option>
              <option value="manager" ${m.role === 'manager' ? 'selected' : ''}>Менеджер</option>
              <option value="viewer"  ${m.role === 'viewer'  ? 'selected' : ''}>Наблюдатель</option>
            </select>
            <button class="profile-team-remove" onclick="window.profileModule.removeMember('${this.esc(m.id)}')">&#10005;</button>
          ` : ''}
        </div>
      `).join('');

    const pending = this.pendingInvites.length === 0 ? '' : `
      <div class="profile-section-title" style="margin-top:20px">Ожидают входа</div>
      ${this.pendingInvites.map(inv => `
        <div class="profile-team-row" style="opacity:.7">
          <div class="profile-team-avatar"><span>@</span></div>
          <div class="profile-team-info">
            <div class="profile-team-name">@${this.esc(inv.telegram_username)}</div>
            <div class="profile-team-tg">Ещё не вошёл</div>
          </div>
          <div class="profile-team-badge" style="--badge-color:${ROLE_COLORS[inv.role]}">${ROLE_LABELS[inv.role] ?? inv.role}</div>
          ${canManage ? `<button class="profile-team-remove" onclick="window.profileModule.cancelInvite('${this.esc(inv.id)}')">&#10005;</button>` : ''}
        </div>
      `).join('')}
    `;

    const inviteForm = canManage ? `
      <div class="profile-invite-form">
        <div class="profile-section-title">Пригласить участника</div>
        <div class="profile-invite-row">
          <input id="prof-invite-username" class="profile-page-input" placeholder="@username" style="flex:1">
          <select id="prof-invite-role" class="profile-page-input" style="width:150px">
            <option value="admin">Администратор</option>
            <option value="manager" selected>Менеджер</option>
            <option value="viewer">Наблюдатель</option>
          </select>
          <button class="profile-page-btn" onclick="window.profileModule.inviteMember()">Добавить</button>
        </div>
        <div class="profile-invite-hint">Пользователь увидит компанию при входе через Telegram</div>
      </div>
    ` : '';

    return `
      <div class="profile-team">
        <div class="profile-section-title">Участники (${this.teamMembers.length})</div>
        ${members}
        ${pending}
        ${inviteForm}
      </div>
    `;
  }

  private renderRequisites(company: Company | null): string {
    if (!company) return '<div style="padding:20px;color:var(--text3)">Нет активной компании</div>';
    const user = authService.getUser();
    const isOwner = company.role === 'owner' || (!!user && company.created_by === user.id);
    const ro = !isOwner;
    const v = (x: any) => this.esc(String(x ?? ''));

    return `
      <div class="profile-requisites">
        <div class="profile-req-banner ${isOwner ? 'owner' : ''}">
          ${isOwner ? 'Вы владелец — редактирование доступно' : 'Только просмотр и копирование'}
          <button class="profile-req-copy-btn" onclick="window.profileModule.copyRequisites()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Копировать все
          </button>
        </div>

        <div class="profile-req-grid">
          <div class="profile-req-field full">
            <label>Юридическое название</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-legal_name" value="${v(company.legal_name)}" placeholder='ООО "Ромашка"' style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.legal_name ? copyButton(company.legal_name, 'Копировать название') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>Тип</label>
            <select id="prof-req-type" ${ro ? 'disabled' : ''}>
              <option value="">—</option>
              <option value="ip"            ${company.type === 'ip' ? 'selected' : ''}>ИП</option>
              <option value="ooo"           ${company.type === 'ooo' ? 'selected' : ''}>ООО</option>
              <option value="self_employed" ${company.type === 'self_employed' ? 'selected' : ''}>Самозанятый</option>
              <option value="individual"    ${company.type === 'individual' ? 'selected' : ''}>Физлицо</option>
            </select>
          </div>
          <div class="profile-req-field">
            <label>ИНН</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-inn" value="${v(company.inn)}" placeholder="123456789012" style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.inn ? copyButton(company.inn, 'Копировать ИНН') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>КПП</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-kpp" value="${v(company.kpp)}" placeholder="123456789" style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.kpp ? copyButton(company.kpp, 'Копировать КПП') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>ОГРН/ОГРНИП</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-ogrn" value="${v(company.ogrn)}" placeholder="1234567890123" style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.ogrn ? copyButton(company.ogrn, 'Копировать ОГРН') : ''}
            </div>
          </div>
          <div class="profile-req-field full">
            <label>Юр. адрес</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-legal_address" value="${v(company.legal_address)}" placeholder="Москва, ..." style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.legal_address ? copyButton(company.legal_address, 'Копировать адрес') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>Телефон</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-phone" value="${v(company.phone)}" placeholder="+7 (000) 000-00-00" style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.phone ? copyButton(company.phone, 'Копировать телефон') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>Email</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-email" value="${v(company.email)}" placeholder="mail@example.com" style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.email ? copyButton(company.email, 'Копировать email') : ''}
            </div>
          </div>

          <div class="profile-req-divider">Банковские реквизиты</div>
          <div class="profile-req-field">
            <label>Расчётный счёт</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-bank_account" value="${v(company.bank_account)}" placeholder="40702..." style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.bank_account ? copyButton(company.bank_account, 'Копировать счёт') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>БИК</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-bik" value="${v(company.bik)}" placeholder="044525..." style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.bik ? copyButton(company.bik, 'Копировать БИК') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>Банк</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-bank_name" value="${v(company.bank_name)}" placeholder="ПАО Сбербанк" style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.bank_name ? copyButton(company.bank_name, 'Копировать название банка') : ''}
            </div>
          </div>
          <div class="profile-req-field">
            <label>Корр. счёт</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input id="prof-req-corr_account" value="${v(company.corr_account)}" placeholder="301..." style="flex:1;min-width:0" ${ro ? 'readonly' : ''}>
              ${company.corr_account ? copyButton(company.corr_account, 'Копировать корр. счёт') : ''}
            </div>
          </div>
        </div>

        ${isOwner ? `<button class="profile-page-btn save" onclick="window.profileModule.saveRequisites()" style="margin-top:16px;width:100%">Сохранить реквизиты</button>` : ''}
      </div>
    `;
  }

  private bindEvents(): void {
    // Switch company
    this.el.querySelectorAll<HTMLElement>('[data-switch-company]').forEach(card => {
      card.addEventListener('click', (e) => {
        // Don't switch if clicking the edit button inside
        if ((e.target as Element).closest('[data-edit-company]')) return;
        const id = card.dataset.switchCompany!;
        const currentId = companyService.getActiveId?.() ?? companyService.getActive()?.id;
        if (id === currentId) return;
        companyService.setActive(id);
        showToast(`Переключено на «${companyService.getActive()?.name}»`, 'success');
        localStorage.setItem('last_page', 'home');
        location.reload();
      });
    });

    // Create new company
    document.getElementById('prof-add-company-btn')?.addEventListener('click', () => {
      window.companyModule?.showCreate?.(true);
    });

    // Edit company settings
    this.el.querySelectorAll<HTMLElement>('[data-edit-company]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.editCompany!;
        const company = companyService.getAll().find(c => c.id === id);
        if (company) window.companyModule?.openSettings(company);
      });
    });

    // Accept invitation
    this.el.querySelectorAll<HTMLElement>('[data-accept-invite]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const inviteId = btn.dataset.acceptInvite!;
        const companyId = btn.dataset.inviteCompany!;
        const role = btn.dataset.inviteRole as any;
        this.acceptInvite(inviteId, companyId, role);
      });
    });

    // Decline invitation
    this.el.querySelectorAll<HTMLElement>('[data-decline-invite]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const inviteId = btn.dataset.declineInvite!;
        this.declineInvite(inviteId);
      });
    });
  }

  // ── Team actions ─────
  private async loadTeam(companyId: string): Promise<void> {
    try {
      const members = await companyService.getMembers(companyId);
      this.teamMembers = (members ?? []).map((m: any) => ({
        id: m.id,
        user_id: m.user_id,
        role: m.role,
        first_name: m.users?.first_name ?? '—',
        telegram_username: m.users?.telegram_username ?? m.users?.username ?? null,
        photo_url: m.users?.photo_url ?? null,
      }));
      const invites = await companyService.getPendingInvitations?.(companyId);
      this.pendingInvites = invites ?? [];
    } catch (e) {
      console.warn('[ProfileModule] loadTeam error:', e);
    }
    this.render();
  }

  async changeMemberRole(memberId: string, role: string): Promise<void> {
    try {
      await companyService.updateMemberRole(memberId, role as any);
      showToast('Роль обновлена', 'success');
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  async removeMember(memberId: string): Promise<void> {
    if (!confirm('Удалить участника из компании?')) return;
    try {
      await companyService.removeMember(memberId);
      showToast('Участник удалён', 'success');
      const c = companyService.getActive();
      if (c) this.loadTeam(c.id);
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  async cancelInvite(inviteId: string): Promise<void> {
    try {
      await companyService.cancelPendingInvitation(inviteId);
      showToast('Приглашение отменено', 'success');
      const c = companyService.getActive();
      if (c) this.loadTeam(c.id);
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  async inviteMember(): Promise<void> {
    const company = companyService.getActive();
    if (!company) return;
    const usernameEl = document.getElementById('prof-invite-username') as HTMLInputElement | null;
    const roleEl = document.getElementById('prof-invite-role') as HTMLSelectElement | null;
    const username = usernameEl?.value?.trim() ?? '';
    const role = (roleEl?.value ?? 'manager') as any;
    if (!username) { showToast('Введите username', 'error'); return; }
    try {
      await companyService.inviteByUsername(company.id, username, role);
      if (usernameEl) usernameEl.value = '';
      showToast('Приглашение добавлено', 'success');
      this.loadTeam(company.id);
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  // ── Requisites ─────
  async saveRequisites(): Promise<void> {
    const company = companyService.getActive();
    if (!company) return;
    const get = (key: string) => (document.getElementById(`prof-req-${key}`) as HTMLInputElement | HTMLSelectElement | null)?.value?.trim() ?? '';
    const updates: any = {
      legal_name: get('legal_name') || null,
      type: get('type') || null,
      inn: get('inn') || null,
      kpp: get('kpp') || null,
      ogrn: get('ogrn') || null,
      legal_address: get('legal_address') || null,
      phone: get('phone') || null,
      email: get('email') || null,
      bank_account: get('bank_account') || null,
      bik: get('bik') || null,
      bank_name: get('bank_name') || null,
      corr_account: get('corr_account') || null,
    };
    try {
      await companyService.update(company.id, updates);
      showToast('Реквизиты сохранены', 'success');
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  copyRequisites(): void {
    const company = companyService.getActive();
    if (!company) return;
    const labels: Array<[string, any]> = [
      ['Название', company.name],
      ['Юр. название', company.legal_name],
      ['Тип', ({ ip: 'ИП', ooo: 'ООО', self_employed: 'Самозанятый', individual: 'Физлицо' } as any)[company.type ?? '']],
      ['ИНН', company.inn],
      ['КПП', company.kpp],
      ['ОГРН', company.ogrn],
      ['Юр. адрес', company.legal_address],
      ['Телефон', company.phone],
      ['Email', company.email],
      ['Р/счёт', company.bank_account],
      ['БИК', company.bik],
      ['Банк', company.bank_name],
      ['Корр. счёт', company.corr_account],
    ];
    const text = labels.filter(([_, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
    if (!text) { showToast('Реквизиты не заполнены', 'info'); return; }
    navigator.clipboard.writeText(text).then(
      () => showToast('Реквизиты скопированы', 'success'),
      () => showToast('Не удалось скопировать', 'error'),
    );
  }

  // ── Refresh + invitations ─────
  private async refreshCompanies(): Promise<void> {
    try {
      await companyService.load();
      this.myIncomingInvites = await companyService.getMyPendingInvitations();
    } catch (e) {
      console.warn('[ProfileModule] refreshCompanies:', e);
      this.myIncomingInvites = [];
    }
    if (this.activeTab === 'companies') this.render();
  }

  async acceptInvite(inviteId: string, companyId: string, role: any): Promise<void> {
    try {
      await companyService.acceptInvitation(inviteId, companyId, role);
      showToast('Вы вступили в компанию', 'success');
      this.myIncomingInvites = this.myIncomingInvites.filter(i => i.id !== inviteId);
      this.render();
      // Update switcher
      window.companyModule?.renderSwitcher?.();
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка принятия', 'error');
    }
  }

  async declineInvite(inviteId: string): Promise<void> {
    try {
      await companyService.declineInvitation(inviteId);
      showToast('Приглашение отклонено', 'info');
      this.myIncomingInvites = this.myIncomingInvites.filter(i => i.id !== inviteId);
      this.render();
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  logout(): void {
    if (!confirm('Выйти из аккаунта?')) return;
    authService.clearSession();
    location.reload();
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
