/**
 * CompanyModule — company picker, creation form, sidebar switcher.
 *
 * Three responsibilities:
 * 1. After login: if user has no companies → show creation form
 *    if user has companies → if 1 → auto-select; if many → show picker
 * 2. Sidebar company switcher (top-left corner)
 * 3. "Add company" flow from the switcher dropdown
 */

import { companyService, Company } from '@/services/companyService';
import { authService } from '@/services/authService';
import { showToast } from '@/utils/toast';
import { userProfileModule } from '@/modules/UserProfileModule';
import { I } from '@/utils/icons';

const COMPANY_GRADIENTS = [
  'linear-gradient(135deg,#005bff 0%,#4b3fff 100%)',
  'linear-gradient(135deg,#7c3aed 0%,#c026d3 100%)',
  'linear-gradient(135deg,#059669 0%,#0ea5e9 100%)',
  'linear-gradient(135deg,#ef4444 0%,#f97316 100%)',
  'linear-gradient(135deg,#f59e0b 0%,#f97316 100%)',
  'linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%)',
  'linear-gradient(135deg,#06b6d4 0%,#10b981 100%)',
  'linear-gradient(135deg,#6366f1 0%,#ec4899 100%)',
  'linear-gradient(135deg,#14b8a6 0%,#6366f1 100%)',
  'linear-gradient(135deg,#84cc16 0%,#22d3ee 100%)',
  'linear-gradient(135deg,#f97316 0%,#eab308 100%)',
  'linear-gradient(135deg,#1e293b 0%,#475569 100%)',
];
// Keep alias for code that references COMPANY_COLORS
const COMPANY_COLORS = COMPANY_GRADIENTS;

// ── Role labels ───────────────────────────────────────────────────────────────
const ROLE_LABELS: Record<string, string> = {
  owner:   'Владелец',
  admin:   'Администратор',
  manager: 'Менеджер',
  viewer:  'Наблюдатель',
};

// ── Company gate screen ───────────────────────────────────────────────────────
export class CompanyModule {
  private gateEl: HTMLElement;    // .company-gate overlay
  private switcherEl: HTMLElement; // .company-switcher in sidebar
  private onReady: () => void;    // called when company is selected and app can start
  private selectedColor = COMPANY_COLORS[0];
  private settingsOverlay: HTMLElement;
  /** AbortController для удаления всех listeners switcher-а перед каждым перерендером */
  private switcherAbort: AbortController | null = null;

  constructor(
    gateEl: HTMLElement,
    switcherEl: HTMLElement,
    onReady: () => void,
  ) {
    this.gateEl = gateEl;
    this.switcherEl = switcherEl;
    this.onReady = onReady;

    // Settings modal overlay (created once, reused)
    this.settingsOverlay = document.createElement('div');
    this.settingsOverlay.className = 'profile-overlay hidden';
    this.settingsOverlay.id = 'company-settings-overlay';
    document.body.appendChild(this.settingsOverlay);
  }

  private get bgHtml(): string {
    return `<div class="auth-bg"><div class="auth-orb auth-orb-1"></div><div class="auth-orb auth-orb-2"></div><div class="auth-orb auth-orb-3"></div></div>`;
  }

  // ── Entry point after login ───────────────────────────────────────────────

  async boot(): Promise<void> {
    // Show loading state while fetching companies
    this.gateEl.classList.remove('hidden');
    this.gateEl.innerHTML = `${this.bgHtml}
      <div class="company-picker-card" style="align-items:center;gap:20px;padding:40px 24px">
        <div style="color:var(--text2);font-size:13px">Загружаем рабочие пространства...</div>
      </div>
      <div class="spinner"></div>
    `;

    try {
      const companies = await companyService.load();

      if (companies.length === 0) {
        // Check for pending invite link — if present, join via it instead of showing create form
        const pendingToken = sessionStorage.getItem('pending_invite');
        if (pendingToken) {
          await this.claimInviteAndBoot(pendingToken);
          return;
        }
        // Новый пользователь без приглашения — обязательно создать компанию
        this.showCreate(false);
      } else {
        // Автовыбор: companyService.load() уже восстановил активный из localStorage
        // или установил первый. Просто доверяем ему и сразу в приложение.
        const activeId = companyService.getActiveId();
        if (activeId) companyService.setActive(activeId);
        this.hidGate();
        this.renderSwitcher();
        this.onReady();
      }
    } catch (err) {
      console.error('[CompanyModule.boot] ERROR:', err);
      // Show error with details so we can debug
      this.gateEl.innerHTML = `${this.bgHtml}
        <div class="company-picker-card" style="gap:16px;padding:32px 24px">
          <div style="font-size:16px;font-weight:700;color:var(--text)">Ошибка загрузки</div>
          <div style="font-size:12px;color:var(--text2);word-break:break-all;max-width:340px">
            ${String(err).replace(/</g,'&lt;')}
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button onclick="window.companyModule?.boot()" style="padding:8px 16px;background:var(--accent);color:#000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
              Повторить
            </button>
            <button onclick="window.companyModule?.showCreatePublic()" style="padding:8px 16px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:8px;font-size:13px;cursor:pointer">
              Создать компанию
            </button>
          </div>
        </div>
      `;
    }
  }

  // ── Claim invite link on first boot (new user with no companies) ─────────

  private async claimInviteAndBoot(token: string): Promise<void> {
    this.gateEl.innerHTML = `${this.bgHtml}
      <div class="company-picker-card" style="align-items:center;gap:20px;padding:40px 24px">
        <div style="color:var(--text2);font-size:13px">Присоединяемся к компании…</div>
      </div>
      <div class="spinner"></div>
    `;

    try {
      const result = await companyService.claimInviteLink(token);
      sessionStorage.removeItem('pending_invite');

      if (result?.success) {
        // Reload companies — should now include the joined one
        const updated = await companyService.load();
        if (updated.length > 0) {
          const activeId = companyService.getActiveId();
          if (activeId) companyService.setActive(activeId);
          this.hidGate();
          this.renderSwitcher();
          showToast('Вы вступили в компанию!', 'success');
          this.onReady();
          return;
        }
      } else {
        const msgs: Record<string, string> = {
          invalid_link: 'Ссылка недействительна или была отозвана',
          link_expired: 'Срок действия ссылки истёк',
          link_exhausted: 'Лимит использований ссылки исчерпан',
        };
        showToast(msgs[result?.error ?? ''] ?? 'Не удалось применить ссылку-приглашение', 'error');
      }
    } catch (e) {
      console.warn('[CompanyModule] claimInvite failed', e);
      sessionStorage.removeItem('pending_invite');
    }

    // Fallback: invite failed — show company creation
    this.showCreate(false);
  }

  // Public wrapper for error screen button
  showCreatePublic(): void { this.showCreate(false); }

  // ── PICKER: choose from existing companies ───────────────────────────────

  private showPicker(companies: Company[]): void {
    this.gateEl.classList.remove('hidden');
    this.gateEl.innerHTML = `${this.bgHtml}
      <div class="company-picker-card">
        <div class="cp-head">
          <div class="cp-title">Выберите компанию</div>
          <div class="cp-sub">Вы состоите в нескольких рабочих пространствах</div>
        </div>
        <div class="cp-list">
          ${companies.map(c => this.renderPickerItem(c)).join('')}
        </div>
        <button class="cp-new-btn" id="cp-new-btn">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M7 1v12M1 7h12"/>
          </svg>
          Создать новую компанию
        </button>
      </div>
    `;

    // Click handlers
    this.gateEl.querySelectorAll<HTMLElement>('.cp-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id!;
        companyService.setActive(id);
        this.hidGate();
        this.renderSwitcher();
        this.onReady();
      });
    });

    document.getElementById('cp-new-btn')?.addEventListener('click', () => {
      this.showCreate(true);
    });
  }

  private renderPickerItem(c: Company): string {
    const letter = c.name.charAt(0).toUpperCase();
    return `
      <div class="cp-item" data-id="${c.id}">
        <div class="cp-item-avatar" style="background:${c.color};overflow:hidden;padding:0">
          ${c.logo_url
            ? `<img src="${this.esc(c.logo_url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.parentElement.textContent='${letter}'">`
            : letter}
        </div>
        <div class="cp-item-info">
          <div class="cp-item-name">${this.esc(c.name)}</div>
          <div class="cp-item-role">${ROLE_LABELS[c.role ?? 'owner'] ?? c.role}</div>
        </div>
        <svg class="cp-item-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M6 4l4 4-4 4"/>
        </svg>
      </div>
    `;
  }

  // ── CREATE: company creation form ─────────────────────────────────────────

  showCreate(showBackBtn: boolean): void {
    this.selectedColor = COMPANY_COLORS[0];
    this.gateEl.classList.remove('hidden');
    this.renderCreateStep1(showBackBtn);
  }

  private renderCreateStep1(showBackBtn: boolean): void {
    this.gateEl.innerHTML = `${this.bgHtml}
      <div class="company-create-card">
        <div class="cc-head">
          <div class="cc-title">Создайте рабочее пространство</div>
          <div class="cc-sub">
            Рабочий стол для управления вашими магазинами на маркетплейсах
          </div>
        </div>
        <div class="cc-body">
          <div class="cc-steps">
            <div class="cc-step-dot active"></div>
            <div class="cc-step-dot"></div>
          </div>

          <div class="cc-field">
            <label class="cc-label" for="cc-name">
              Название <span class="req">*</span>
            </label>
            <input
              class="cc-input" id="cc-name"
              placeholder='Например: "Мой WB магазин" или "Бренд Ромашка"'
              maxlength="80" autocomplete="off"
            >
            <div style="margin-top:5px;font-size:11px;color:var(--text3);line-height:1.5">
              Любое удобное название — не юридическое. Юридические данные (ООО/ИП, ИНН, реквизиты) заполните на следующем шаге при необходимости.
            </div>
          </div>

          <div class="cc-section-title">Цвет метки</div>
          <div class="cc-colors" id="cc-colors">
            ${COMPANY_GRADIENTS.map((grad, i) => `
              <button
                class="cc-color-btn ${i === 0 ? 'selected' : ''}"
                data-color="${grad}"
                style="background:${grad};box-shadow:0 2px 6px rgba(0,0,0,0.2)"
                title="Цвет ${i + 1}"
              ></button>
            `).join('')}
          </div>
        </div>

        <div class="cc-foot" style="flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px;width:100%">
            ${showBackBtn ? `
              <button class="cc-btn cc-btn-back" id="cc-back-btn" style="flex:1">Отмена</button>
            ` : ''}
            <button class="cc-btn cc-btn-next" id="cc-create-quick-btn" disabled style="flex:2">
              Создать →
            </button>
          </div>
          <button class="cc-btn" id="cc-next-btn" disabled style="background:transparent;border:1px solid var(--border2);color:var(--text2)">
            Добавить реквизиты юр. лица (необязательно)
          </button>
          <button id="cc-logout-btn" style="background:none;border:none;color:var(--text3);font-size:12px;cursor:pointer;padding:4px 0;text-decoration:underline;margin-top:4px">
            Выйти из аккаунта
          </button>
        </div>
      </div>
    `;

    this.bindStep1Events(showBackBtn);
  }

  private bindStep1Events(showBackBtn: boolean): void {
    const nameInput    = document.getElementById('cc-name') as HTMLInputElement;
    const createBtn    = document.getElementById('cc-create-quick-btn') as HTMLButtonElement;
    const nextBtn      = document.getElementById('cc-next-btn') as HTMLButtonElement;

    const updateBtns = (): void => {
      const ok = !!nameInput.value.trim();
      createBtn.disabled = !ok;
      nextBtn.disabled   = !ok;
    };

    nameInput.addEventListener('input', updateBtns);
    nameInput.focus();

    // Color picker
    this.gateEl.querySelectorAll<HTMLButtonElement>('.cc-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedColor = btn.dataset.color!;
        this.gateEl.querySelectorAll('.cc-color-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    // Cancel button — just close the gate, no picker
    if (showBackBtn) {
      document.getElementById('cc-back-btn')?.addEventListener('click', () => {
        this.hidGate();
      });
    }

    // Quick create (no requisites)
    createBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) return;
      this.submitCreate(name, '');
    });

    // Next: go to step 2 (requisites)
    nextBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) return;
      this.renderCreateStep2(name, showBackBtn);
    });

    // Logout
    document.getElementById('cc-logout-btn')?.addEventListener('click', () => {
      authService.clearSession();
      location.reload();
    });
  }

  private renderCreateStep2(name: string, showBackBtn: boolean): void {
    this.gateEl.innerHTML = `${this.bgHtml}
      <div class="company-create-card">
        <div class="cc-head">
          <div class="cc-title">
            Юридические данные
            <span style="font-size:12px;font-weight:400;color:var(--text2);margin-left:6px">необязательно</span>
          </div>
          <div class="cc-sub">
            Нужны для выгрузки документов и счётов. Можно заполнить позже в настройках компании.
          </div>
        </div>
        <div class="cc-body">
          <div class="cc-steps">
            <div class="cc-step-dot active"></div>
            <div class="cc-step-dot active"></div>
          </div>

          <div class="cc-field">
            <label class="cc-label" for="cc-legal-name">Юридическое название</label>
            <input class="cc-input" id="cc-legal-name" placeholder='Например: "ИП Иванов Иван Иванович" или "ООО Ромашка"'>
          </div>

          <div class="cc-field">
            <label class="cc-label" for="cc-type">Форма собственности</label>
            <select class="cc-select" id="cc-type">
              <option value="">— не указано —</option>
              <option value="ip">ИП</option>
              <option value="ooo">ООО</option>
              <option value="self_employed">Самозанятый</option>
              <option value="individual">Физическое лицо</option>
            </select>
          </div>

          <div class="cc-row">
            <div class="cc-field">
              <label class="cc-label" for="cc-inn">ИНН</label>
              <input class="cc-input" id="cc-inn" placeholder="123456789012" maxlength="12">
            </div>
            <div class="cc-field" id="cc-kpp-wrap" style="display:none">
              <label class="cc-label" for="cc-kpp">КПП</label>
              <input class="cc-input" id="cc-kpp" placeholder="770101001" maxlength="9">
            </div>
          </div>

          <div class="cc-row">
            <div class="cc-field">
              <label class="cc-label" for="cc-ogrn">ОГРН / ОГРНИП</label>
              <input class="cc-input" id="cc-ogrn" placeholder="1027700000000" maxlength="15">
            </div>
            <div class="cc-field">
              <label class="cc-label" for="cc-phone">Телефон</label>
              <input class="cc-input" id="cc-phone" placeholder="+7 999 000-00-00" type="tel">
            </div>
          </div>

          <div class="cc-field">
            <label class="cc-label" for="cc-legal-address">Юридический адрес</label>
            <input class="cc-input" id="cc-legal-address" placeholder="г. Москва, ул. Ленина, 1">
          </div>

          <div class="cc-section-title">Банковские реквизиты</div>

          <div class="cc-field">
            <label class="cc-label" for="cc-bank-account">Расчётный счёт</label>
            <input class="cc-input" id="cc-bank-account" placeholder="40702810000000000000" maxlength="20">
          </div>

          <div class="cc-row">
            <div class="cc-field">
              <label class="cc-label" for="cc-bik">БИК банка</label>
              <input class="cc-input" id="cc-bik" placeholder="044525225" maxlength="9">
            </div>
            <div class="cc-field">
              <label class="cc-label" for="cc-corr-account">Корр. счёт</label>
              <input class="cc-input" id="cc-corr-account" placeholder="30101810400000000225" maxlength="20">
            </div>
          </div>

          <div class="cc-row">
            <div class="cc-field">
              <label class="cc-label" for="cc-bank-name">Название банка</label>
              <input class="cc-input" id="cc-bank-name" placeholder="ПАО Сбербанк">
            </div>
            <div class="cc-field">
              <label class="cc-label" for="cc-email">Email для документов</label>
              <input class="cc-input" id="cc-email" placeholder="info@company.ru" type="email">
            </div>
          </div>
        </div>

        <div class="cc-foot" style="flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px;width:100%">
            <button class="cc-btn cc-btn-back" id="cc-back2-btn" style="flex:1">← Назад</button>
            <button class="cc-btn cc-btn-next" id="cc-create-btn" style="flex:2">
              Сохранить и создать
            </button>
          </div>
          <button class="cc-btn" id="cc-skip-btn" style="background:transparent;border:none;color:var(--text3);font-size:12px">
            Пропустить, создать без реквизитов
          </button>
        </div>
      </div>
    `;

    // Show/hide КПП based on type
    const typeSelect = document.getElementById('cc-type') as HTMLSelectElement;
    typeSelect.addEventListener('change', () => {
      const kppWrap = document.getElementById('cc-kpp-wrap')!;
      kppWrap.style.display = typeSelect.value === 'ooo' ? '' : 'none';
    });

    document.getElementById('cc-back2-btn')?.addEventListener('click', () => {
      this.renderCreateStep1(showBackBtn);
    });

    document.getElementById('cc-skip-btn')?.addEventListener('click', () => {
      this.submitCreate(name, '');
    });

    document.getElementById('cc-create-btn')?.addEventListener('click', () => {
      const type = (document.getElementById('cc-type') as HTMLSelectElement).value;
      this.submitCreate(name, type);
    });
  }

  private async submitCreate(name: string, type: string): Promise<void> {
    // Disable whichever submit button is visible
    const btn = (document.getElementById('cc-create-btn') ?? document.getElementById('cc-create-quick-btn')) as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Создаём...'; }

    const g = (id: string): string =>
      (document.getElementById(id) as HTMLInputElement)?.value?.trim() || '';

    try {
      await companyService.create({
        name,
        legal_name: g('cc-legal-name') || undefined,
        type: (type || undefined) as Company['type'],
        inn: g('cc-inn') || undefined,
        kpp: g('cc-kpp') || undefined,
        ogrn: g('cc-ogrn') || undefined,
        legal_address: g('cc-legal-address') || undefined,
        bank_account: g('cc-bank-account') || undefined,
        bik: g('cc-bik') || undefined,
        bank_name: g('cc-bank-name') || undefined,
        corr_account: g('cc-corr-account') || undefined,
        phone: g('cc-phone') || undefined,
        email: g('cc-email') || undefined,
        color: this.selectedColor,
      });

      this.hidGate();
      this.renderSwitcher();
      showToast(`Компания создана ${I.partyPopper('', 16)}`, 'success');
      this.onReady();
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err instanceof Error ? err.message : String(err)) : 'Ошибка создания';
      showToast(msg, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Создать'; }
    }
  }

  // ── SWITCHER: sidebar company switcher ───────────────────────────────────

  renderSwitcher(): void {
    const company = companyService.getActive();
    const user = authService.getUser();

    if (!company) {
      this.switcherEl.innerHTML = `
        <div class="cs-company">
          <div class="cs-avatar" style="background:#333">?</div>
          <div class="cs-info">
            <div class="cs-name">Нет компании</div>
            <div class="cs-sub">SimaDesk</div>
          </div>
        </div>
      `;
      this.updateDockProfile(null, user);
      return;
    }

    const letter = company.name.charAt(0).toUpperCase();
    const companies = companyService.getAll();

    this.switcherEl.innerHTML = `
      <div class="cs-company">
        <div class="cs-avatar" style="background:${company.color};overflow:hidden;padding:0">
          ${company.logo_url
            ? `<img src="${this.esc(company.logo_url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.parentElement.textContent='${letter}'">`
            : letter}
        </div>
        <div class="cs-info">
          <div class="cs-name">${this.esc(company.name)}</div>
          <div class="cs-sub">SimaDesk</div>
        </div>
      </div>
      <svg class="cs-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 6l4 4 4-4"/>
      </svg>
      <div class="cs-dropdown" id="cs-dropdown">
        <div style="padding:6px 12px 4px;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;">
          Компании
        </div>
        ${companies.map(c => `
          <div class="cs-drop-item ${c.id === company.id ? 'active-company' : ''}" data-company-id="${c.id}">
            <div class="cs-drop-avatar" style="background:${c.color};overflow:hidden;padding:0">
              ${c.logo_url
                ? `<img src="${this.esc(c.logo_url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.parentElement.textContent='${c.name.charAt(0).toUpperCase()}'">`
                : c.name.charAt(0).toUpperCase()}
            </div>
            <div class="cs-drop-name">${this.esc(c.name)}</div>
            ${c.id === company.id ? `<div class="cs-drop-check">✓</div>` : ''}
          </div>
        `).join('')}
        <div class="cs-drop-divider"></div>
        <div class="cs-drop-action" id="cs-add-company">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M7 1v12M1 7h12"/>
          </svg>
          Добавить компанию
        </div>
        <div class="cs-drop-action" id="cs-settings-company">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="8" cy="8" r="2"/>
            <path d="M13 8a5 5 0 0 0-.1-1l1.5-1.2-1.4-2.4-1.8.5a5 5 0 0 0-1.8-1L8.9 1H7.1l-.5 1.8a5 5 0 0 0-1.8 1l-1.8-.5L1.6 5.8 3.1 7a5 5 0 0 0 0 2L1.6 10.2l1.4 2.4 1.8-.5a5 5 0 0 0 1.8 1l.5 1.8h1.8l.5-1.8a5 5 0 0 0 1.8-1l1.8.5 1.4-2.4L12.9 9c.1-.3.1-.7.1-1z"/>
          </svg>
          Настройки компании
        </div>
        <div class="cs-drop-divider"></div>
        <div class="cs-drop-action" id="cs-profile">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="6" r="3"/>
            <path d="M2 14c0-3 2.7-5 6-5s6 2 6 5"/>
          </svg>
          ${user ? this.esc(user.first_name) : 'Профиль'}
        </div>
        <div class="cs-drop-action logout" id="cs-logout">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 3h3v10h-3M7 5l-4 3 4 3M3 8h8"/>
          </svg>
          Выйти
        </div>
      </div>
    `;

    this.bindSwitcherEvents();
    // ── Update dock profile ──
    this.updateDockProfile(company, user);
  }

  private updateDockProfile(company: any, user: any): void {
    const avatarEl = document.getElementById('dock-profile-avatar');
    const nameEl = document.getElementById('dock-company-name');
    if (avatarEl) {
      // Show company logo (not user photo)
      if (company?.logo_url) {
        avatarEl.innerHTML = `<img src="${this.esc(company.logo_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
      } else {
        const letter = (company?.name || user?.first_name || 'S').charAt(0).toUpperCase();
        avatarEl.innerHTML = '';
        avatarEl.textContent = letter;
        if (company?.color) avatarEl.style.background = company.color;
      }
    }
    if (nameEl && company) {
      nameEl.textContent = company.name;
      // Only fade names > 10 characters
      nameEl.classList.toggle('fade-name', (company.name?.length ?? 0) > 10);
    }
  }

  private bindSwitcherEvents(): void {
    // ── Сбрасываем ВСЕ предыдущие listeners одним вызовом ────────────────────
    // Без этого каждый renderSwitcher() добавляет ещё один toggleDropdown(),
    // из-за чего один клик = открыть + сразу закрыть → кнопки "не реагируют".
    this.switcherAbort?.abort();
    this.switcherAbort = new AbortController();
    const sig = { signal: this.switcherAbort.signal };

    // Toggle dropdown при клике на сам switcher
    this.switcherEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    }, sig);

    // Company items — event delegation (единый listener вместо N штук)
    this.switcherEl.addEventListener('click', (e) => {
      const item = (e.target as Element).closest<HTMLElement>('[data-company-id]');
      if (!item) return;
      e.stopPropagation();
      const id = item.dataset.companyId!;
      if (id === companyService.getActiveId()) { this.closeDropdown(); return; }
      companyService.setActive(id);
      this.closeDropdown();
      this.renderSwitcher();
      window.app?.init?.();
      (window as any).applyDockNavConfig?.();
      showToast(`Переключено на «${companyService.getActive()?.name}»`, 'success');
    }, sig);

    // Add company
    document.getElementById('cs-add-company')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdown();
      this.showCreate(true);
    }, sig);

    // Company settings
    document.getElementById('cs-settings-company')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdown();
      const company = companyService.getActive();
      if (company) this.openSettings(company);
    }, sig);

    // Profile
    document.getElementById('cs-profile')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdown();
      userProfileModule.open();
    }, sig);

    // Logout
    document.getElementById('cs-logout')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdown();
      this.logout();
    }, sig);

    // Закрыть при клике вне switcher
    document.addEventListener('click', (e: MouseEvent) => {
      if (!this.switcherEl.contains(e.target as Node)) {
        this.closeDropdown();
      }
    }, sig);
  }

  private toggleDropdown(): void {
    const dropdown = this.switcherEl.querySelector<HTMLElement>('#cs-dropdown');
    const open = dropdown?.classList.contains('open');
    if (open) {
      this.closeDropdown();
    } else {
      dropdown?.classList.add('open');
      this.switcherEl.classList.add('open');
    }
  }

  private closeDropdown(): void {
    this.switcherEl.querySelector('#cs-dropdown')?.classList.remove('open');
    this.switcherEl.classList.remove('open');
  }

  // ── Company Settings Modal ────────────────────────────────────────────────

  openSettings(company: Company): void {
    this.renderSettingsModal(company, false);
    this.settingsOverlay.classList.remove('hidden');
  }


  private renderSettingsModal(company: Company, showDeleteConfirm: boolean): void {
    const user = authService.getUser();
    // Only creator (created_by) can delete — not just any owner/admin
    const isCreator = !!user && (company.created_by === user.id);

    this.settingsOverlay.innerHTML = `
      <div class="profile-card" style="max-width:480px">
        <div class="profile-head">
          <div class="profile-title">Настройки компании</div>
          <button class="profile-close" id="cs-modal-close">✕</button>
        </div>

        <!-- Логотип -->
        <div style="padding:16px 20px 0">
          <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.6px">Логотип</div>
          <div style="display:flex;align-items:center;gap:16px">
            <div id="cs-logo-preview" style="width:64px;height:64px;border-radius:14px;background:${company.color};display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#fff;overflow:hidden;flex-shrink:0;border:2px solid var(--border2);font-family:system-ui,sans-serif;letter-spacing:-1px;text-shadow:0 1px 4px rgba(0,0,0,0.25)">
              ${company.logo_url
                ? `<img src="${this.esc(company.logo_url)}" style="width:100%;height:100%;object-fit:cover">`
                : `<span>${this.esc(company.name.charAt(0).toUpperCase())}</span>`}
            </div>
            <div style="flex:1">
              <div style="display:flex;gap:8px;margin-bottom:6px">
                <label class="btn" style="cursor:pointer;font-size:12px;padding:6px 12px">
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:11px;height:11px"><path d="M7 1v8M3 5l4 4 4-4M1 11v2h12v-2"/></svg>
                  Загрузить
                  <input type="file" id="cs-logo-file" accept="image/*" style="display:none" onchange="window.companyModule._onLogoFile(this)">
                </label>
                ${company.logo_url ? `<button class="btn" id="cs-logo-remove" style="font-size:12px;padding:6px 10px;color:var(--red)">✕ Убрать</button>` : ''}
              </div>
              <div style="font-size:11px;color:var(--text3)">PNG, JPG до 2 МБ.</div>
            </div>
          </div>
        </div>

        <div class="profile-fields" style="margin-top:12px">
          <!-- Название -->
          <div class="profile-field-edit">
            <label class="profile-field-label" for="cs-edit-name">Название компании</label>
            <input class="profile-input" id="cs-edit-name" value="${this.esc(company.name)}" maxlength="80" style="margin-top:5px">
          </div>

          <!-- Градиент -->
          <div class="profile-field-edit">
            <div class="profile-field-label" style="margin-bottom:8px">Цвет метки</div>
            <div style="display:flex;gap:7px;flex-wrap:wrap" id="cs-edit-colors">
              ${COMPANY_GRADIENTS.map(grad => {
                const isSelected = grad === company.color;
                return `<button data-color="${this.esc(grad)}"
                  style="width:30px;height:30px;border-radius:8px;background:${grad};border:2px solid ${isSelected ? '#fff' : 'transparent'};cursor:pointer;outline:${isSelected ? '2px solid var(--accent)' : 'none'};outline-offset:1px;transition:all .15s;box-shadow:0 2px 6px rgba(0,0,0,0.2)"
                  onclick="window.companyModule._selectColor(this.dataset.color)"></button>`;
              }).join('')}
            </div>
          </div>

          <!-- Сохранить -->
          <button class="profile-save-btn" id="cs-save-btn" style="width:100%;padding:10px">
            Сохранить изменения
          </button>

          ${isCreator ? `
            ${showDeleteConfirm ? `
              <div style="padding:14px;background:color-mix(in srgb,#ef4444 8%,var(--bg));border:1px solid color-mix(in srgb,#ef4444 30%,transparent);border-radius:10px">
                <div style="font-size:13px;font-weight:700;color:var(--red);margin-bottom:8px">${I.alertTriangle('', 14)} Удаление компании</div>
                <div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5">
                  Это действие <b>необратимо</b>. Введите <b>подтверждаю</b>:
                </div>
                <div style="display:flex;gap:8px">
                  <input class="profile-input" id="cs-delete-confirm-input" placeholder="подтверждаю" autocomplete="off"
                    oninput="window.companyModule._onConfirmInput(this)">
                  <button class="btn btn-danger" id="cs-confirm-delete-btn" disabled
                    style="white-space:nowrap;padding:8px 14px;font-size:12px"
                    onclick="window.companyModule._executeDelete('${company.id}')">Удалить</button>
                </div>
                <button style="margin-top:8px;background:none;border:none;color:var(--text3);font-size:12px;cursor:pointer" onclick="window.companyModule._cancelDelete()">← Отмена</button>
              </div>
            ` : `
              <div style="padding:12px;background:var(--bg3);border:1px solid var(--border);border-radius:10px">
                <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.6px">${I.alertTriangle('', 11)} Опасная зона</div>
                <button class="btn btn-danger" id="cs-delete-company-btn" style="font-size:12px;padding:7px 14px">
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:11px;height:11px"><path d="M2 4h10M5 4V2h4v2M4 4l1 9h4l1-9"/></svg>
                  Удалить компанию «${this.esc(company.name)}»
                </button>
              </div>
            `}
          ` : ''}
        </div>
      </div>
    `;

    // Track selected color
    let currentColor = company.color;
    let currentLogoUrl = company.logo_url ?? null;

    (window as any).companyModule = (window as any).companyModule ?? this;
    (window as any).companyModule._selectColor = (color: string) => {
      currentColor = color;
      // Update preview background
      const preview = document.getElementById('cs-logo-preview');
      if (preview && !currentLogoUrl) preview.style.background = color;
      this.settingsOverlay.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(btn => {
        const isSelected = btn.dataset.color === color;
        btn.style.borderColor = isSelected ? '#fff' : 'transparent';
        btn.style.outline = isSelected ? '2px solid var(--accent)' : 'none';
      });
    };

    (window as any).companyModule._onLogoFile = async (input: HTMLInputElement) => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { showToast('Файл слишком большой (max 2 МБ)', 'error'); return; }
      const dataUrl = await this.resizeImage(file, 200);
      currentLogoUrl = dataUrl;
      const preview = document.getElementById('cs-logo-preview');
      if (preview) preview.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover">`;
    };

    (window as any).companyModule._onConfirmInput = (input: HTMLInputElement) => {
      const btn = document.getElementById('cs-confirm-delete-btn') as HTMLButtonElement | null;
      if (btn) btn.disabled = input.value.trim() !== 'подтверждаю';
    };

    (window as any).companyModule._cancelDelete = () => {
      this.renderSettingsModal(company, false);
    };

    (window as any).companyModule._executeDelete = async (id: string) => {
      const btn = document.getElementById('cs-confirm-delete-btn') as HTMLButtonElement | null;
      if (btn) { btn.disabled = true; btn.textContent = 'Удаляем...'; }
      try {
        await companyService.delete(id);
        this.settingsOverlay.classList.add('hidden');
        showToast('Компания удалена', 'success');
        const remaining = companyService.getAll();
        if (remaining.length === 0) {
          this.showCreate(false);
        } else if (remaining.length === 1) {
          companyService.setActive(remaining[0].id);
          this.renderSwitcher();
          window.app?.init?.();
        } else {
          this.showPicker(remaining);
        }
      } catch (err: unknown) {
        showToast((err instanceof Error ? err.message : String(err)) ?? 'Ошибка удаления', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Удалить'; }
      }
    };

    // Logo remove
    document.getElementById('cs-logo-remove')?.addEventListener('click', () => {
      currentLogoUrl = null;
      const preview = document.getElementById('cs-logo-preview');
      if (preview) preview.innerHTML = `<span>${this.esc(company.name.charAt(0).toUpperCase())}</span>`;
    });

    // Save
    document.getElementById('cs-save-btn')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('cs-edit-name') as HTMLInputElement;
      const name = nameInput.value.trim();
      if (!name) { showToast('Введите название', 'error'); return; }
      const btn = document.getElementById('cs-save-btn') as HTMLButtonElement;
      btn.disabled = true; btn.textContent = 'Сохраняем...';
      try {
        await companyService.update(company.id, {
          name,
          color: currentColor,
          logo_url: currentLogoUrl,
        });
        this.settingsOverlay.classList.add('hidden');
        this.renderSwitcher();
        showToast('Настройки сохранены ✓', 'success');
      } catch (err: unknown) {
        showToast((err instanceof Error ? err.message : String(err)) ?? 'Ошибка сохранения', 'error');
        btn.disabled = false; btn.textContent = 'Сохранить изменения';
      }
    });

    // Delete trigger
    document.getElementById('cs-delete-company-btn')?.addEventListener('click', () => {
      this.renderSettingsModal(company, true);
      setTimeout(() => document.getElementById('cs-delete-confirm-input')?.focus(), 50);
    });

    // Close
    document.getElementById('cs-modal-close')?.addEventListener('click', () => {
      this.settingsOverlay.classList.add('hidden');
    });
    this.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === this.settingsOverlay) this.settingsOverlay.classList.add('hidden');
    }, { once: true });
  }

  // ── Tab handlers ─────────────────────────────────────────────────────────
  async saveRequisites(companyId: string): Promise<void> {
    const get = (key: string) => (document.getElementById(`cs-req-${key}`) as HTMLInputElement | HTMLSelectElement | null)?.value?.trim() ?? '';
    const updates: any = {
      legal_name:    get('legal_name')    || null,
      type:          get('type')          || null,
      inn:           get('inn')           || null,
      kpp:           get('kpp')           || null,
      ogrn:          get('ogrn')          || null,
      legal_address: get('legal_address') || null,
      phone:         get('phone')         || null,
      email:         get('email')         || null,
      bank_account:  get('bank_account')  || null,
      bik:           get('bik')           || null,
      bank_name:     get('bank_name')     || null,
      corr_account:  get('corr_account')  || null,
    };
    const btn = document.getElementById('cs-req-save') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Сохраняем...'; }
    try {
      await companyService.update(companyId, updates);
      showToast('Реквизиты сохранены ✓', 'success');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить реквизиты'; }
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка сохранения', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить реквизиты'; }
    }
  }

  copyRequisites(): void {
    const company = companyService.getActive();
    if (!company) return;
    const labels: Array<[string, any]> = [
      ['Название', company.name],
      ['Юр. название', company.legal_name],
      ['Тип', ({ ip:'ИП', ooo:'ООО', self_employed:'Самозанятый', individual:'Физлицо' } as any)[company.type ?? '']],
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
    const text = labels
      .filter(([_, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    if (!text) { showToast('Реквизиты не заполнены', 'info'); return; }
    navigator.clipboard.writeText(text).then(
      () => showToast('Реквизиты скопированы ✓', 'success'),
      () => showToast('Не удалось скопировать', 'error'),
    );
  }

  async inviteMember(companyId: string): Promise<void> {
    const usernameEl = document.getElementById('cs-invite-username') as HTMLInputElement | null;
    const roleEl     = document.getElementById('cs-invite-role') as HTMLSelectElement | null;
    const username = usernameEl?.value?.trim() ?? '';
    const role     = (roleEl?.value ?? 'manager') as any;
    if (!username) { showToast('Введите username', 'error'); return; }
    try {
      await companyService.inviteByUsername(companyId, username, role);
      if (usernameEl) usernameEl.value = '';
      showToast('Приглашение добавлено ✓', 'success');
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка', 'error');
    }
  }

  async removeMember(memberId: string): Promise<void> {
    if (!confirm('Удалить участника из компании?')) return;
    try {
      await companyService.removeMember(memberId);
      showToast('Участник удалён', 'success');
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка', 'error');
    }
  }

  async changeMemberRole(memberId: string, role: string): Promise<void> {
    try {
      await companyService.updateMemberRole(memberId, role as any);
      showToast('Роль обновлена', 'success');
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка', 'error');
    }
  }

  async cancelInvite(inviteId: string): Promise<void> {
    try {
      await companyService.cancelPendingInvitation(inviteId);
      showToast('Приглашение отменено', 'success');
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка', 'error');
    }
  }

  private async resizeImage(file: File, maxSize: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
          const canvas = document.createElement('canvas');
          canvas.width  = Math.round(img.width  * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = e.target!.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  private logout(): void {
    if (!confirm('Выйти из аккаунта?')) return;
    authService.clearSession();
    // Reload page — AuthModule will show login screen
    location.reload();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  hidGate(): void {
    this.gateEl.classList.add('hidden');
  }

  private esc(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
