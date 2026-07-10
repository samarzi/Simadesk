/**
 * ProfileModule — Full-page profile:
 * - Company switching
 * - Team management
 * - Requisites editing/copying
 * - User info
 */

import { companyService, Company } from '@/services/companyService';
import { authService, LinkedAccounts } from '@/services/authService';
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
  private activeTab: 'companies' | 'team' | 'requisites' | 'account' = 'companies';
  private linkedAccounts: LinkedAccounts = {
    telegram_id: null, yandex_id: null, telegram_username: null,
    yandex_login: null, profile_source: null,
    telegram_first_name: null, telegram_last_name: null, telegram_photo_url: null,
    yandex_first_name: null, yandex_last_name: null, yandex_photo_url: null,
  };
  private pendingSource: 'telegram' | 'yandex' | null = null;
  private teamMembers: Array<any> = [];
  private pendingInvites: Array<any> = [];
  private inviteLinks: Array<{ id: string; token: string; role: string; use_count: number; is_active: boolean }> = [];
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

  setTab(tab: 'companies' | 'team' | 'requisites' | 'account'): void {
    this.activeTab = tab;
    if (tab === 'team') {
      const c = companyService.getActive();
      if (c) this.loadTeam(c.id);
    }
    if (tab === 'account') {
      this.loadLinkedAccounts();
    }
    this.render();
  }

  showAccountTab(): void {
    this.show();
    this.setTab('account');
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
          <button class="profile-page-tab ${this.activeTab === 'account' ? 'active' : ''}" onclick="window.profileModule.setTab('account')">Аккаунт</button>
        </div>

        <div class="profile-page-content">
          ${this.activeTab === 'companies' ? this.renderCompanies(companies, company) : ''}
          ${this.activeTab === 'team' ? this.renderTeam(company) : ''}
          ${this.activeTab === 'requisites' ? this.renderRequisites(company) : ''}
          ${this.activeTab === 'account' ? this.renderAccount() : ''}
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

    const linkBadge = `<span title="Вступил по ссылке-приглашению" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:2px 7px;border-radius:20px;background:#00897b22;color:#00897b;font-weight:600;vertical-align:middle">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="10" height="10"><path d="M8 3.5 10.5 1 13 3.5M10.5 1v8M6 10.5 3.5 13 1 10.5M3.5 13V5"/></svg>
      по ссылке
    </span>`;

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
            <div class="profile-team-name">${this.esc(m.first_name ?? '')} ${m.joined_via_link_id ? linkBadge : ''}</div>
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
        <div class="profile-section-title">Пригласить по username</div>
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

    const activeLink = this.inviteLinks[0] ?? null;
    const inviteLinkBlock = canManage ? `
      <div style="margin-top:20px;padding:16px;background:var(--bg3);border-radius:14px;border:1.5px solid var(--border2)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <div style="width:34px;height:34px;border-radius:9px;background:#005bff18;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg viewBox="0 0 20 20" fill="none" stroke="#005bff" stroke-width="1.6" stroke-linecap="round" width="18" height="18"><path d="M13 7l2.5-2.5a2.121 2.121 0 0 1 3 3L16 10M7 13l-2.5 2.5a2.121 2.121 0 0 1-3-3L4 10M8 12l4-4"/></svg>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--text)">Ссылка-приглашение</div>
            <div style="font-size:11px;color:var(--text3)">Отправь — и человек сразу попадёт в компанию</div>
          </div>
        </div>
        ${activeLink ? `
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
            <input id="prof-invite-link-url" readonly
              value="${this.esc(companyService.buildInviteUrl(activeLink.token))}"
              style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border2);background:var(--bg2);color:var(--text);font-size:12px;font-family:monospace;min-width:0;cursor:text;outline:none"
              onclick="this.select()">
            <button onclick="window.profileModule.copyInviteLink()"
              style="flex-shrink:0;display:flex;align-items:center;gap:5px;padding:8px 14px;border-radius:8px;background:#005bff;color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="13" height="13"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>
              Скопировать
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;font-size:11px;color:var(--text3);flex-wrap:wrap">
            <span>Роль: <strong style="color:var(--text)">${ROLE_LABELS[activeLink.role] ?? activeLink.role}</strong></span>
            <span style="color:var(--border2)">·</span>
            <span>Использований: <strong style="color:var(--text)">${activeLink.use_count}</strong></span>
            <button onclick="window.profileModule.revokeInviteLink('${this.esc(activeLink.id)}')"
              style="margin-left:auto;font-size:11px;color:#ef4444;background:none;border:none;cursor:pointer;padding:0">
              Отозвать
            </button>
          </div>
        ` : `
          <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <div>
              <div style="font-size:11px;color:var(--text3);margin-bottom:4px">Роль для новых участников</div>
              <select id="prof-link-role" class="profile-page-input" style="min-width:160px">
                <option value="admin">Администратор</option>
                <option value="manager" selected>Менеджер</option>
                <option value="viewer">Наблюдатель</option>
              </select>
            </div>
            <button onclick="window.profileModule.createInviteLink()"
              style="display:flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;background:#005bff;color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="13" height="13"><path d="M8 3v10M3 8h10"/></svg>
              Создать ссылку
            </button>
          </div>
        `}
      </div>
    ` : '';

    return `
      <div class="profile-team">
        <div class="profile-section-title">Участники (${this.teamMembers.length})</div>
        ${members}
        ${pending}
        ${inviteForm}
        ${inviteLinkBlock}
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

  private async loadLinkedAccounts(): Promise<void> {
    this.linkedAccounts = await authService.fetchLinkedAccounts();
    this.pendingSource = (this.linkedAccounts.profile_source as 'telegram' | 'yandex' | null) ?? null;
    if (this.activeTab === 'account') this.render();
  }

  private renderAccount(): string {
    const {
      telegram_id, yandex_id, telegram_username, yandex_login,
      profile_source,
      telegram_first_name, telegram_last_name, telegram_photo_url,
      yandex_first_name, yandex_last_name, yandex_photo_url,
    } = this.linkedAccounts;

    const YANDEX_CLIENT_ID = (import.meta.env.VITE_YANDEX_CLIENT_ID as string | undefined) ?? '';
    const tgLinked = !!telegram_id;
    const yaLinked = !!yandex_id;
    const bothLinked = tgLinked && yaLinked;

    // ── Login methods ─────────────────────────────────────────────────────────
    const recommendation = !bothLinked ? `
      <div style="margin-bottom:16px;padding:12px 14px;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.2);border-radius:12px;display:flex;gap:10px;align-items:flex-start">
        <div style="font-size:18px;flex-shrink:0">💡</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.5">
          ${!tgLinked
            ? 'Привяжи Telegram для резервного входа. Telegram может быть заблокирован в РФ, поэтому важно иметь оба способа.'
            : 'Привяжи Яндекс ID — это позволит входить без VPN, если Telegram заблокирован в твоей сети.'}
        </div>
      </div>
    ` : '';

    const yaLinkUrl = YANDEX_CLIENT_ID
      ? `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_CLIENT_ID}&redirect_uri=${encodeURIComponent(window.location.origin + '/')}`
      : '';

    const tgRow = `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg3);border:1px solid ${tgLinked ? 'rgba(34,197,94,.2)' : 'var(--border2)'};border-radius:12px;margin-bottom:8px">
        <div style="width:36px;height:36px;border-radius:9px;background:rgba(42,171,238,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="#2AABEE"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.833.94z"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text)">Telegram</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">
            ${tgLinked
              ? `${telegram_first_name ?? ''} ${telegram_last_name ?? ''}`.trim() + (telegram_username ? ` · @${this.esc(telegram_username)}` : '')
              : 'Не привязан'}
          </div>
        </div>
        <div style="font-size:11px;padding:2px 9px;border-radius:20px;${tgLinked ? 'background:rgba(34,197,94,.1);color:#22c55e;font-weight:600' : 'background:var(--bg4);color:var(--text3)'}">
          ${tgLinked ? 'Привязан ⚠️ VPN' : 'Нет'}
        </div>
      </div>
    `;

    const yaRow = `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg3);border:1px solid ${yaLinked ? 'rgba(34,197,94,.2)' : 'var(--border2)'};border-radius:12px;margin-bottom:${bothLinked ? '20px' : '8px'}">
        <div style="width:36px;height:36px;border-radius:9px;background:rgba(252,63,29,.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M2.04 12c0-5.523 4.476-10 10-10 5.522 0 10 4.477 10 10s-4.478 10-10 10c-5.524 0-10-4.477-10-10z" fill="#FC3F1D"/><path d="M13.32 7.666h-.924c-1.694 0-2.585.858-2.585 2.123 0 1.43.616 2.1 1.881 2.959l1.045.704-3.003 4.548H7.49l2.695-4.07c-1.55-1.111-2.42-2.19-2.42-4.025 0-2.288 1.595-3.805 4.355-3.805h2.97v11.9H13.32V7.666z" fill="#fff"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text)">Яндекс ID</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">
            ${yaLinked
              ? `${yandex_first_name ?? ''} ${yandex_last_name ?? ''}`.trim() + (yandex_login ? ` · ${this.esc(yandex_login)}` : '')
              : 'Не привязан — войди через Яндекс без VPN'}
          </div>
        </div>
        <div style="flex-shrink:0">
          ${yaLinked
            ? `<span style="font-size:11px;padding:2px 9px;border-radius:20px;background:rgba(34,197,94,.1);color:#22c55e;font-weight:600">Привязан ✓</span>`
            : (yaLinkUrl
                ? `<a href="${yaLinkUrl}" style="font-size:12px;padding:6px 12px;border-radius:8px;background:#FC3F1D;color:#fff;text-decoration:none;font-weight:600;white-space:nowrap">Привязать</a>`
                : '')}
        </div>
      </div>
    `;

    // ── Profile source selector (only when both linked) ───────────────────────
    const currentSource = this.pendingSource ?? (tgLinked ? 'telegram' : 'yandex');

    const tgPreviewName = [telegram_first_name, telegram_last_name].filter(Boolean).join(' ') || '—';
    const tgPreviewHandle = telegram_username ? `@${telegram_username}` : '';
    const yaPreviewName = [yandex_first_name, yandex_last_name].filter(Boolean).join(' ') || '—';
    const yaPreviewHandle = yandex_login ? yandex_login : '';

    const sourceSelector = bothLinked ? `
      <div class="profile-section-title" style="margin-bottom:12px">Данные профиля</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.5">
        Выбери, откуда отображать имя и фото во всём приложении. ID пользователя не меняется.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <button id="source-tg-btn" style="padding:14px;border-radius:12px;border:2px solid ${currentSource === 'telegram' ? '#2AABEE' : 'var(--border2)'};background:${currentSource === 'telegram' ? 'rgba(42,171,238,.06)' : 'var(--bg3)'};cursor:pointer;text-align:left;transition:border-color .15s,background .15s">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#2AABEE"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.833.94z"/></svg>
            <span style="font-size:12px;font-weight:600;color:var(--text)">Telegram</span>
            ${currentSource === 'telegram' ? '<span style="margin-left:auto;font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(42,171,238,.15);color:#2AABEE;font-weight:600">Активен</span>' : ''}
          </div>
          ${telegram_photo_url ? `<img src="${this.esc(telegram_photo_url)}" style="width:36px;height:36px;border-radius:50%;margin-bottom:6px;display:block">` : '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg4);margin-bottom:6px"></div>'}
          <div style="font-size:12px;font-weight:600;color:var(--text)">${this.esc(tgPreviewName)}</div>
          <div style="font-size:11px;color:var(--text3)">${this.esc(tgPreviewHandle)}</div>
        </button>
        <button id="source-ya-btn" style="padding:14px;border-radius:12px;border:2px solid ${currentSource === 'yandex' ? '#FC3F1D' : 'var(--border2)'};background:${currentSource === 'yandex' ? 'rgba(252,63,29,.05)' : 'var(--bg3)'};cursor:pointer;text-align:left;transition:border-color .15s,background .15s">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M2.04 12c0-5.523 4.476-10 10-10 5.522 0 10 4.477 10 10s-4.478 10-10 10c-5.524 0-10-4.477-10-10z" fill="#FC3F1D"/><path d="M13.32 7.666h-.924c-1.694 0-2.585.858-2.585 2.123 0 1.43.616 2.1 1.881 2.959l1.045.704-3.003 4.548H7.49l2.695-4.07c-1.55-1.111-2.42-2.19-2.42-4.025 0-2.288 1.595-3.805 4.355-3.805h2.97v11.9H13.32V7.666z" fill="#fff"/></svg>
            <span style="font-size:12px;font-weight:600;color:var(--text)">Яндекс</span>
            ${currentSource === 'yandex' ? '<span style="margin-left:auto;font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(252,63,29,.12);color:#FC3F1D;font-weight:600">Активен</span>' : ''}
          </div>
          ${yandex_photo_url ? `<img src="${this.esc(yandex_photo_url)}" style="width:36px;height:36px;border-radius:50%;margin-bottom:6px;display:block">` : '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg4);margin-bottom:6px"></div>'}
          <div style="font-size:12px;font-weight:600;color:var(--text)">${this.esc(yaPreviewName)}</div>
          <div style="font-size:11px;color:var(--text3)">${this.esc(yaPreviewHandle)}</div>
        </button>
      </div>
      <button id="save-profile-source-btn" style="width:100%;padding:10px;border-radius:10px;border:none;background:var(--accent);color:#0a0a0a;font-size:13px;font-weight:700;cursor:pointer;opacity:${currentSource !== profile_source ? '1' : '0.5'};transition:opacity .2s">
        Применить выбранный источник
      </button>
    ` : '';

    return `
      <div style="padding-bottom:40px">
        <div class="profile-section-title" style="margin-bottom:14px">Способы входа</div>
        ${recommendation}
        ${tgRow}
        ${yaRow}
        ${sourceSelector}
        ${bothLinked && !sourceSelector.includes('source-tg-btn') ? '' : ''}
      </div>
    `;
  }

  private bindAccountEvents(): void {
    document.getElementById('source-tg-btn')?.addEventListener('click', () => {
      this.pendingSource = 'telegram';
      this.render();
      this.bindEvents();
    });
    document.getElementById('source-ya-btn')?.addEventListener('click', () => {
      this.pendingSource = 'yandex';
      this.render();
      this.bindEvents();
    });
    document.getElementById('save-profile-source-btn')?.addEventListener('click', async () => {
      if (!this.pendingSource) return;
      const btn = document.getElementById('save-profile-source-btn') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Сохраняем...';
      try {
        await authService.setProfileSource(this.pendingSource, this.linkedAccounts);
        this.linkedAccounts.profile_source = this.pendingSource;
        showToast('Данные профиля обновлены', 'success');
        this.render();
        this.bindEvents();
      } catch {
        showToast('Не удалось сохранить', 'error');
        btn.disabled = false;
        btn.textContent = 'Применить выбранный источник';
      }
    });
  }

  private bindEvents(): void {
    if (this.activeTab === 'account') this.bindAccountEvents();

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
    const [membersRes, invitesRes, linksRes] = await Promise.allSettled([
      companyService.getMembers(companyId),
      companyService.getPendingInvitations?.(companyId),
      companyService.getInviteLinks(companyId),
    ]);

    if (membersRes.status === 'fulfilled') {
      this.teamMembers = (membersRes.value ?? []).map((m: any) => ({
        id: m.id,
        user_id: m.user_id,
        role: m.role,
        joined_via_link_id: m.joined_via_link_id ?? null,
        first_name: m.users?.first_name ?? '—',
        telegram_username: m.users?.telegram_username ?? m.users?.username ?? null,
        photo_url: m.users?.photo_url ?? null,
      }));
    }
    if (invitesRes.status === 'fulfilled') {
      this.pendingInvites = invitesRes.value ?? [];
    }
    if (linksRes.status === 'fulfilled') {
      this.inviteLinks = linksRes.value ?? [];
    } else {
      console.warn('[ProfileModule] getInviteLinks error:', linksRes.reason);
      showToast('Ошибка загрузки ссылок: ' + (linksRes.reason?.message ?? linksRes.reason), 'error');
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

  async createInviteLink(): Promise<void> {
    const company = companyService.getActive();
    if (!company) return;
    const roleEl = document.getElementById('prof-link-role') as HTMLSelectElement | null;
    const role = (roleEl?.value ?? 'manager') as any;
    try {
      await companyService.createInviteLink(company.id, role);
      showToast('Ссылка создана', 'success');
      this.loadTeam(company.id);
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  async revokeInviteLink(linkId: string): Promise<void> {
    if (!confirm('Отозвать ссылку? Старая ссылка перестанет работать.')) return;
    try {
      await companyService.deactivateInviteLink(linkId);
      showToast('Ссылка отозвана', 'success');
      const c = companyService.getActive();
      if (c) this.loadTeam(c.id);
    } catch (e: any) {
      showToast(e?.message ?? 'Ошибка', 'error');
    }
  }

  copyInviteLink(): void {
    const input = document.getElementById('prof-invite-link-url') as HTMLInputElement | null;
    const url = input?.value;
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => showToast('Ссылка скопирована', 'success'),
      () => { input?.select(); showToast('Скопируй вручную (Ctrl+C)', 'info'); },
    );
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
