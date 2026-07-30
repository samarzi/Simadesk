import { billingService, PLANS, UserSubscription, UserTrial } from '@/services/billingService';
import { adminService } from '@/services/adminService';
import { companyService } from '@/services/companyService';
import { showToast } from '@/utils/toast';
import { hasAnyStoreConnected } from './NavigationModule';
import { AI_BOOST_PACKAGES, getActiveBoostPackage, setActiveBoostPackage, getQuotaInfo, FREE_DAILY_TOKENS } from '@/services/aiTokenQuota';

export class BillingModule {
  private el: HTMLElement;
  private sub: UserSubscription | null = null;
  private trial: UserTrial | null = null;
  private revenue = 0;
  private loading = true;
  private isAdmin = false;
  private adminRole = '';
  private previewAsUser = false;
  private hasConnectedStores = false;
  private isOwner = false;

  constructor(el: HTMLElement) { this.el = el; }

  async show(): Promise<void> {
    this.el.style.display = 'flex';
    this.loading = true;
    this.render();
    await this.checkReturnFromPayment();

    const company = companyService.getActive();
    const [adminInfo, trial, sub, rev, hasStore] = await Promise.all([
      adminService.checkAdmin(),
      billingService.ensureTrial(),
      company ? billingService.getSubscription(company.id) : Promise.resolve(null),
      company ? billingService.getMonthlyRevenue(company.id) : Promise.resolve(0),
      hasAnyStoreConnected(),
    ]);

    this.isAdmin = adminInfo.is_admin;
    this.adminRole = adminInfo.role ?? '';
    this.isOwner = (company?.role === 'owner') || adminInfo.is_admin;
    this.trial = trial;
    this.sub = sub;
    this.revenue = rev ?? 0;
    this.hasConnectedStores = hasStore;
    this.loading = false;
    this.render();
  }

  private async checkReturnFromPayment(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('billing_payment')) return;
    // Clean URL
    const url = new URL(window.location.href);
    url.searchParams.delete('billing_payment');
    window.history.replaceState({}, '', url.toString());

    const paymentId = localStorage.getItem('yk_payment_id');
    if (!paymentId) return;
    localStorage.removeItem('yk_payment_id');
    localStorage.removeItem('yk_plan_key');

    showToast('Проверяем статус платежа…', 'info');
    // Poll up to 5 times
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const status = await billingService.checkPayment(paymentId);
      if (status?.status === 'succeeded' || status?.paid) {
        showToast('Оплата прошла успешно! Подписка активирована.', 'success');
        return;
      }
      if (status?.status === 'canceled') {
        showToast('Платёж отменён', 'error');
        return;
      }
    }
    showToast('Платёж обрабатывается. Обновите страницу через минуту.', 'info');
  }

  hide(): void { this.el.style.display = 'none'; }

  private render(): void {
    this.el.innerHTML = `
      <div class="bill-shell">
        <div class="bill-header">
          <button class="bill-back" id="bill-back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="bill-header-title">Тариф и оплата</div>
          <a href="/info" target="_blank" class="bill-header-link">
            Подробнее о тарифах
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>
        <div class="bill-body">
          ${this.loading ? this.renderSkeleton() : this.renderContent()}
        </div>
      </div>`;
    this.bindEvents();
  }

  private renderContent(): string {
    if (this.isAdmin && !this.previewAsUser) return this.renderAdmin();

    // Non-owner team members: show read-only subscription status only
    if (!this.isOwner) return this.renderMemberView();

    const previewBanner = this.isAdmin ? `
      <div class="bill-preview-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Режим просмотра — так видят обычные пользователи
        <button class="bill-preview-exit" id="bill-preview-exit">Выйти из режима просмотра</button>
      </div>` : '';
    return `
      ${previewBanner}
      ${this.renderRevenueCard()}
      ${this.renderStatus()}
      ${this.renderRevenueTable()}
      ${this.renderPromoBlock()}
      ${this.renderAiBoostPackages()}
    `;
  }

  private renderMemberView(): string {
    const sub = this.sub;
    const trial = this.trial;
    const trialActive = billingService.isTrialActive(trial);
    const company = companyService.getActive();

    let statusHtml: string;
    if (sub && sub.status === 'active' && sub.current_period_end) {
      const plan = PLANS.find(p => p.key === sub.plan_key) ?? PLANS[0];
      const daysToEnd = Math.max(0, Math.ceil((new Date(sub.current_period_end).getTime() - Date.now()) / 86_400_000));
      statusHtml = `
        <div class="bill-status-card active">
          <div class="bill-status-top">
            <div class="bill-status-dot active"></div>
            <span class="bill-status-label">Подписка активна</span>
            <span class="bill-status-until">до ${billingService.formatDate(sub.current_period_end)}</span>
          </div>
          <div class="bill-plan-row">
            <div class="bill-plan-name">${plan.label}</div>
            <div class="bill-plan-revenue">${plan.description}</div>
          </div>
          <div class="bill-days-left">
            <div class="bill-days-bar"><div class="bill-days-fill" style="width:${Math.min(100, Math.round((daysToEnd / 30) * 100))}%"></div></div>
            <span class="bill-days-text">Осталось ${daysToEnd} ${daysToEnd === 1 ? 'день' : daysToEnd < 5 ? 'дня' : 'дней'}</span>
          </div>
        </div>`;
    } else if (trialActive) {
      const daysLeft = billingService.trialDaysLeft(trial);
      statusHtml = `
        <div class="bill-status-card trial">
          <div class="bill-status-top">
            <div class="bill-status-dot trial"></div>
            <span class="bill-status-label">Пробный период</span>
            <span class="bill-status-until">до ${billingService.formatDate(trial!.ends_at)}</span>
          </div>
          <div class="bill-plan-revenue">Осталось ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}</div>
        </div>`;
    } else {
      statusHtml = `
        <div class="bill-status-card inactive">
          <div class="bill-status-top">
            <div class="bill-status-dot inactive"></div>
            <span class="bill-status-label">Нет активной подписки</span>
          </div>
        </div>`;
    }

    return `
      <div class="bill-section">
        ${statusHtml}
      </div>
      <div class="bill-section">
        <div class="bill-member-note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Управлять подпиской может только владелец компании${company ? ` «${this.esc(company.name)}»` : ''}.
          Обратитесь к владельцу для изменения тарифа.
        </div>
      </div>`;
  }

  private renderRevenueCard(): string {
    const plan = PLANS.find(p => this.revenue >= p.revenueMin && (p.revenueMax === null || this.revenue < p.revenueMax)) ?? PLANS[0];
    const dots: Record<string, string> = { free: '#22c55e', starter: '#6366f1', business: '#8b5cf6', pro: '#f59e0b', max: '#ef4444' };
    const color = dots[plan.key] ?? '#6b7280';
    return `
      <div class="bill-section">
        <div class="bill-rev-card">
          <div class="bill-rev-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
            Ваш оборот за последние 30 дней
          </div>
          <div class="bill-rev-value">${this.revenue > 0 ? billingService.formatRevenue(this.revenue) : '—'}</div>
          ${this.revenue > 0 ? `
          <div class="bill-rev-plan-row">
            <div class="bill-rev-dot" style="background:${color}"></div>
            <span class="bill-rev-plan-name">${plan.label}</span>
            <span class="bill-rev-plan-price">${plan.priceRub === 0 ? 'Бесплатно' : `${plan.priceRub.toLocaleString('ru')} ₽/мес`}</span>
          </div>
          <div class="bill-rev-hint">Тариф пересчитывается автоматически каждый месяц на основе оборота</div>
          ` : this.hasConnectedStores ? `
          <div class="bill-rev-hint">Данные синхронизируются. Оборот появится после загрузки заказов.</div>
          ` : ''}
        </div>
      </div>`;
  }

  private renderAdmin(): string {
    const roleLabels: Record<string, string> = {
      superadmin: 'Создатель', admin: 'Администратор',
      support: 'Поддержка', billing: 'Биллинг',
    };
    return `
      <div class="bill-admin-card">
        <div class="bill-admin-glow"></div>
        <div class="bill-admin-icon">⚡</div>
        <div class="bill-admin-title">Административный доступ</div>
        <div class="bill-admin-role">${roleLabels[this.adminRole] ?? this.adminRole}</div>
        <div class="bill-admin-desc">
          Как администратор платформы вы имеете полный и бесплатный доступ ко всем функциям SimaDesk без каких-либо ограничений.
        </div>
        <div class="bill-admin-badges">
          <div class="bill-admin-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Все функции
          </div>
          <div class="bill-admin-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Безлимитный доступ
          </div>
          <div class="bill-admin-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Бесплатно навсегда
          </div>
        </div>
        <button class="bill-preview-user-btn" id="bill-preview-user">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Посмотреть как пользователь
        </button>
      </div>`;
  }

  private renderStatus(): string {
    const sub = this.sub;
    const trial = this.trial;
    const trialActive = billingService.isTrialActive(trial);
    const daysLeft = billingService.trialDaysLeft(trial);

    if (sub && sub.status === 'active' && sub.current_period_end) {
      const plan = PLANS.find(p => p.key === sub.plan_key) ?? PLANS[0];
      const basePrice = sub.price_rub > 0 ? sub.price_rub : plan.priceRub;
      const discount = sub.promo_discount_rub ?? 0;
      const effectivePrice = Math.max(0, basePrice - discount);
      const endDate = billingService.formatDate(sub.current_period_end);
      const daysToEnd = Math.max(0, Math.ceil((new Date(sub.current_period_end).getTime() - Date.now()) / 86_400_000));
      return `
        <div class="bill-section">
          <div class="bill-status-card active">
            <div class="bill-status-top">
              <div class="bill-status-dot active"></div>
              <span class="bill-status-label">Подписка активна</span>
              <span class="bill-status-until">до ${endDate}</span>
            </div>
            <div class="bill-plan-row">
              <div>
                <div class="bill-plan-name">${plan.label}</div>
                <div class="bill-plan-revenue">${plan.description}</div>
              </div>
              <div class="bill-plan-price">
                ${effectivePrice === 0
                  ? '<span style="color:var(--green)">Бесплатно</span>'
                  : discount > 0
                    ? `<span class="bill-price-old">${basePrice.toLocaleString('ru')}</span> <span>${effectivePrice.toLocaleString('ru')}</span><span class="bill-plan-period"> ₽/мес</span>`
                    : `<span>${basePrice.toLocaleString('ru')}</span><span class="bill-plan-period"> ₽/мес</span>`}
              </div>
            </div>
            <div class="bill-days-left">
              <div class="bill-days-bar">
                <div class="bill-days-fill" style="width:${Math.min(100, Math.round((daysToEnd / 30) * 100))}%"></div>
              </div>
              <span class="bill-days-text">Осталось ${daysToEnd} ${daysToEnd === 1 ? 'день' : daysToEnd < 5 ? 'дня' : 'дней'}</span>
            </div>
            ${sub.promo_code ? `
              <div class="bill-promo-applied">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                Промокод <strong>${this.esc(sub.promo_code)}</strong>${discount > 0 ? ` · −${discount.toLocaleString('ru')} ₽` : ''}
              </div>` : ''}
          </div>
        </div>`;
    }

    if (trialActive) {
      const total = 14;
      const elapsed = total - daysLeft;
      const pct = Math.round((elapsed / total) * 100);
      const currentPlan = PLANS.find(p => this.revenue >= p.revenueMin && (p.revenueMax === null || this.revenue < p.revenueMax)) ?? PLANS[0];
      return `
        <div class="bill-section">
          <div class="bill-status-card trial">
            <div class="bill-status-top">
              <div class="bill-status-dot trial"></div>
              <span class="bill-status-label">Пробный период</span>
              <span class="bill-status-until">до ${billingService.formatDate(trial!.ends_at)}</span>
            </div>
            <div class="bill-trial-bar-wrap">
              <div class="bill-trial-bar">
                <div class="bill-trial-fill" style="width:${pct}%"></div>
              </div>
              <div class="bill-trial-meta">
                <span>${elapsed} из ${total} дней</span>
                <span style="color:var(--accent);font-weight:600">Осталось ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}</span>
              </div>
            </div>
          </div>
          ${this.revenue > 0 ? `
            <div class="bill-after-trial">
              <div class="bill-after-label">Ваш тариф после пробного периода</div>
              <div class="bill-after-row">
                <div>
                  <div class="bill-plan-name">${currentPlan.label}</div>
                  <div class="bill-plan-revenue">${currentPlan.description}</div>
                </div>
                <div class="bill-plan-price">
                  ${currentPlan.priceRub === 0
                    ? '<span style="color:var(--green)">Бесплатно</span>'
                    : `<span>${currentPlan.priceRub.toLocaleString('ru')}</span><span class="bill-plan-period"> ₽/мес</span>`}
                </div>
              </div>
              <div class="bill-revenue-hint">Оборот за 30 дней: <strong>${billingService.formatRevenue(this.revenue)}</strong></div>
              ${currentPlan.priceRub > 0 ? `
                <button class="bill-pay-btn" id="bill-pay-btn" style="margin-top:14px">
                  Оплатить ${currentPlan.priceRub.toLocaleString('ru')} ₽/мес
                </button>
                <div class="bill-trial-carry-note">Оставшиеся дни пробного периода добавятся к подписке</div>
              ` : ''}
            </div>` : this.hasConnectedStores ? `
            <div class="bill-rev-hint" style="margin-top:12px">Данные синхронизируются. Оборот появится после загрузки заказов.</div>
            ` : `
            <button class="bill-connect-mp-btn" id="bill-connect-mp-trial">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
              Подключить маркетплейс
            </button>`}
        </div>`;
    }

    // No sub, no trial
    const plan = PLANS.find(p => this.revenue >= p.revenueMin && (p.revenueMax === null || this.revenue < p.revenueMax)) ?? PLANS[0];
    return `
      <div class="bill-section">
        <div class="bill-status-card inactive">
          <div class="bill-status-top">
            <div class="bill-status-dot inactive"></div>
            <span class="bill-status-label">Нет активной подписки</span>
          </div>
          ${this.revenue > 0 ? `
            <div class="bill-after-row" style="margin-top:14px">
              <div>
                <div class="bill-plan-name">${plan.label}</div>
                <div class="bill-plan-revenue">${plan.description}</div>
              </div>
              <div class="bill-plan-price">
                ${plan.priceRub === 0
                  ? '<span style="color:var(--green)">Бесплатно</span>'
                  : `<span>${plan.priceRub.toLocaleString('ru')}</span><span class="bill-plan-period"> ₽/мес</span>`}
              </div>
            </div>
            <div class="bill-revenue-hint">Оборот: <strong>${billingService.formatRevenue(this.revenue)}</strong></div>
            ${plan.priceRub > 0 ? `
              <button class="bill-pay-btn" id="bill-pay-btn">
                Оплатить ${plan.priceRub.toLocaleString('ru')} ₽/мес
              </button>` : `
              <div class="bill-free-note">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                Ваш оборот в бесплатной зоне — оплата не требуется
              </div>`}` : this.hasConnectedStores ? `
          <div class="bill-rev-hint" style="margin-top:12px">Данные синхронизируются. Оборот появится после загрузки заказов.</div>
          ` : `
          <button class="bill-connect-mp-btn" id="bill-connect-mp-nosub" style="margin-top:12px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
            Подключить маркетплейс
          </button>`}
        </div>
      </div>`;
  }

  private renderRevenueTable(): string {
    const rows = PLANS.map(p => {
      const isCurrent = this.revenue >= p.revenueMin && (p.revenueMax === null || this.revenue < p.revenueMax);
      const isActive = this.sub?.plan_key === p.key && this.sub?.status === 'active';
      const dots: Record<string, string> = { free: '#22c55e', starter: '#6366f1', business: '#8b5cf6', pro: '#f59e0b', max: '#ef4444' };
      return `
        <div class="bill-table-row ${isCurrent ? 'current' : ''}">
          <div class="bill-table-range">
            <div class="bill-table-dot" style="background:${dots[p.key] ?? '#6b7280'}"></div>
            <span>${p.description}</span>
            ${isCurrent ? '<span class="bill-table-you">← вы здесь</span>' : ''}
          </div>
          <div class="bill-table-price">
            ${p.priceRub === 0 ? '<span style="color:var(--green);font-weight:700">Бесплатно</span>' : `<strong>${p.priceRub.toLocaleString('ru')} ₽</strong><span class="bill-table-period">/мес</span>`}
          </div>
          <div class="bill-table-status">
            ${isActive ? '<span class="bill-table-badge active">Активен</span>' : ''}
          </div>
        </div>`;
    });
    return `
      <div class="bill-section">
        <div class="bill-section-title">Шкала тарифов</div>
        <div class="bill-section-sub">Тариф определяется автоматически по обороту за 30 дней. Все функции доступны на любом уровне.</div>
        <div class="bill-table">
          <div class="bill-table-head">
            <div>Оборот за 30 дней</div>
            <div>Цена</div>
            <div></div>
          </div>
          ${rows.join('')}
        </div>
      </div>`;
  }

  private renderPromoBlock(): string {
    const company = companyService.getActive();
    if (!company) return '';
    return `
      <div class="bill-section">
        <div class="bill-section-title">Промокод</div>
        <div class="bill-section-sub">Один код — одна компания.</div>
        <div class="bill-promo-row" id="bill-promo-row">
          <input class="bill-promo-input" id="bill-promo" type="text" placeholder="SIMADESK2025" autocomplete="off" spellcheck="false">
          <button class="bill-promo-btn" id="bill-promo-check">Проверить</button>
        </div>
        <div class="bill-promo-result" id="bill-promo-result" style="display:none"></div>
        <div class="bill-promo-preview" id="bill-promo-preview" style="display:none"></div>
      </div>`;
  }

  private renderAiBoostPackages(): string {
    const q = getQuotaInfo();
    const active = getActiveBoostPackage();
    const freeDayK = Math.round(FREE_DAILY_TOKENS / 1000);
    const usedPct = q.pct;
    const warn = usedPct >= 70;

    const cards = AI_BOOST_PACKAGES.map(pkg => {
      const isActive = active?.key === pkg.key;
      const dayK = Math.round(pkg.tokensPerDay / 1000);
      return `
        <div class="bill-ai-pkg${isActive ? ' active' : ''}" data-pkg="${pkg.key}">
          <div class="bill-ai-pkg-badge">${pkg.badge}</div>
          <div class="bill-ai-pkg-name">${pkg.label}</div>
          <div class="bill-ai-pkg-tokens">${dayK.toLocaleString('ru')}К токенов/день</div>
          <div class="bill-ai-pkg-price">${pkg.priceRub.toLocaleString('ru')} ₽/мес</div>
          <button class="bill-ai-pkg-btn${isActive ? ' active' : ''}" data-pkg-key="${pkg.key}">
            ${isActive ? '✓ Активен' : 'Подключить'}
          </button>
        </div>`;
    }).join('');

    return `
      <div class="bill-section">
        <div class="bill-section-title">Пакеты AI-токенов (Сима)</div>
        <div class="bill-section-sub">
          Ежедневный лимит обновляется каждые сутки в 00:00.
          ${warn ? `<span style="color:#f59e0b">Использовано ${usedPct}% дневного лимита</span>` : ''}
        </div>
        <div class="bill-ai-quota-row">
          <span class="bill-ai-quota-lbl">Сегодня: ${Math.round(q.used/1000)}К / ${Math.round(q.limit/1000)}К токенов</span>
          <div class="bill-ai-quota-track">
            <div class="bill-ai-quota-fill" style="width:${usedPct}%"></div>
          </div>
        </div>
        <div class="bill-ai-free-note">
          🎁 Бесплатно: <b>${freeDayK}К токенов/день</b> (≈40–50 ответов Симы) — включено в любой тариф
        </div>
        <div class="bill-ai-pkgs">${cards}</div>
        ${active ? `<div class="bill-ai-deactivate"><button class="bill-link-btn" id="bill-ai-deactivate">Отключить пакет</button></div>` : ''}
        <div class="bill-ai-note">
          💡 Пакет AI-токенов — отдельная услуга к основному тарифу SimaDesk. После выбора пакета обратитесь в поддержку для оформления оплаты.
        </div>
      </div>`;
  }

  private renderSkeleton(): string {
    return `
      <div class="bill-section">
        <div class="bill-skeleton" style="height:120px;border-radius:16px"></div>
      </div>
      <div class="bill-section">
        <div class="bill-skeleton" style="height:200px;border-radius:16px"></div>
      </div>`;
  }

  private bindEvents(): void {
    document.getElementById('bill-back')?.addEventListener('click', () => {
      this.previewAsUser = false;
      this.hide();
      window.app?.navigateTo?.('profile');
    });

    document.getElementById('bill-preview-user')?.addEventListener('click', () => {
      this.previewAsUser = true;
      this.render();
      this.bindEvents();
    });

    document.getElementById('bill-preview-exit')?.addEventListener('click', () => {
      this.previewAsUser = false;
      this.render();
      this.bindEvents();
    });

    document.getElementById('bill-pay-btn')?.addEventListener('click', async () => {
      const company = companyService.getActive();
      if (!company) return;
      const plan = PLANS.find(p => this.revenue >= p.revenueMin && (p.revenueMax === null || this.revenue < p.revenueMax)) ?? PLANS[0];
      if (!plan || plan.priceRub === 0) return;
      const btn = document.getElementById('bill-pay-btn') as HTMLButtonElement | null;
      if (btn) { btn.disabled = true; btn.textContent = 'Создаём платёж…'; }
      const res = await billingService.createPayment(company.id, plan.key, plan.priceRub);
      if ('error' in res) {
        showToast(res.error, 'error');
        if (btn) { btn.disabled = false; btn.textContent = `Оплатить ${plan.priceRub.toLocaleString('ru')} ₽/мес`; }
        return;
      }
      const confirmUrl = res.confirmation_url;
      if (!confirmUrl?.startsWith('https://')) { showToast('Некорректный URL оплаты', 'error'); return; }
      localStorage.setItem('yk_payment_id', res.payment_id);
      localStorage.setItem('yk_plan_key', plan.key);
      window.location.href = confirmUrl;
    });

    const goToMarketplaces = () => {
      this.hide();
      window.app?.navigateTo?.('marketplaces');
    };
    document.getElementById('bill-connect-mp')?.addEventListener('click', goToMarketplaces);
    document.getElementById('bill-connect-mp-trial')?.addEventListener('click', goToMarketplaces);
    document.getElementById('bill-connect-mp-nosub')?.addEventListener('click', goToMarketplaces);

    const promoInput = document.getElementById('bill-promo') as HTMLInputElement | null;
    promoInput?.addEventListener('input', () => {
      promoInput.value = promoInput.value.toUpperCase();
      // Reset preview when user types again
      const preview = document.getElementById('bill-promo-preview');
      const result = document.getElementById('bill-promo-result');
      if (preview) preview.style.display = 'none';
      if (result) result.style.display = 'none';
    });
    promoInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.checkPromo();
    });
    document.getElementById('bill-promo-check')?.addEventListener('click', () => this.checkPromo());

    // AI boost package buttons
    this.el.querySelectorAll<HTMLButtonElement>('.bill-ai-pkg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.pkgKey;
        if (!key) return;
        const current = getActiveBoostPackage();
        if (current?.key === key) return;
        setActiveBoostPackage(key);
        const pkg = AI_BOOST_PACKAGES.find(p => p.key === key);
        showToast(
          `Пакет ${pkg?.label ?? key} выбран! Для оплаты обратитесь в поддержку через Сима → Поддержка.`,
          'success',
        );
        this.render();
        this.bindEvents();
      });
    });

    document.getElementById('bill-ai-deactivate')?.addEventListener('click', () => {
      setActiveBoostPackage(null);
      showToast('Пакет AI-токенов отключён — применён бесплатный лимит', 'info');
      this.render();
      this.bindEvents();
    });
  }

  async checkPromo(): Promise<void> {
    const company = companyService.getActive();
    if (!company) return;
    const input = document.getElementById('bill-promo') as HTMLInputElement | null;
    const code = input?.value?.trim().toUpperCase();
    const resultEl = document.getElementById('bill-promo-result');
    const previewEl = document.getElementById('bill-promo-preview');
    const checkBtn = document.getElementById('bill-promo-check') as HTMLButtonElement | null;
    if (!code || !resultEl || !previewEl) return;

    resultEl.style.display = 'none';
    previewEl.style.display = 'none';
    if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '…'; }

    const res = await billingService.checkPromoCode(code, company.id);

    if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = 'Проверить'; }

    if (!res.ok) {
      resultEl.style.display = 'block';
      resultEl.className = 'bill-promo-result err';
      resultEl.textContent = res.error ?? 'Промокод не найден';
      return;
    }

    // Show preview panel
    const discountLine = res.discount_rub
      ? `<span class="bpp-highlight">−${res.discount_rub.toLocaleString('ru')} ₽</span> скидка`
      : res.discount_percent
        ? `<span class="bpp-highlight">−${res.discount_percent}%</span> скидка`
        : '';

    const durationLine = res.duration_months
      ? `<div class="bpp-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Срок действия: <strong>${res.duration_months} ${res.duration_months === 1 ? 'месяц' : res.duration_months < 5 ? 'месяца' : 'месяцев'}</strong></div>`
      : '';

    const validUntilLine = res.valid_until
      ? `<div class="bpp-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Промокод действует до: <strong>${billingService.formatDate(res.valid_until)}</strong></div>`
      : '';

    const applyFromDate = res.apply_from ? billingService.formatDate(res.apply_from) : '';
    const applyToDate = res.apply_to ? billingService.formatDate(res.apply_to) : '';

    const activationLine = res.deferred
      ? `<div class="bpp-row bpp-deferred"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10"/><polyline points="12 6 12 12 16 14"/><path d="M20 20l-2-2m0 0l-2-2m2 2l2-2m-2 2l-2 2"/></svg>Активируется после истечения текущей подписки<br><span class="bpp-dates">с ${applyFromDate}${applyToDate ? ` по ${applyToDate}` : ''}</span></div>`
      : applyToDate
        ? `<div class="bpp-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>Активируется сразу — <span class="bpp-dates">с ${applyFromDate} по ${applyToDate}</span></div>`
        : `<div class="bpp-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>Активируется сразу</div>`;

    previewEl.innerHTML = `
      <div class="bpp-card">
        <div class="bpp-header">
          <div class="bpp-tag-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          </div>
          <div class="bpp-code">${this.esc(res.code ?? code)}</div>
          ${discountLine ? `<div class="bpp-discount">${discountLine}</div>` : ''}
        </div>
        ${res.description ? `<div class="bpp-desc">${this.esc(res.description)}</div>` : ''}
        <div class="bpp-details">
          ${durationLine}
          ${validUntilLine}
          ${activationLine}
        </div>
        <div class="bpp-actions">
          <button class="bpp-cancel" id="bpp-cancel">Назад</button>
          <button class="bpp-confirm" id="bpp-confirm">Применить промокод</button>
        </div>
      </div>`;
    previewEl.style.display = 'block';

    document.getElementById('bpp-cancel')?.addEventListener('click', () => {
      previewEl.style.display = 'none';
    });
    document.getElementById('bpp-confirm')?.addEventListener('click', () => this.applyPromo(code, previewEl, resultEl));
  }

  async applyPromo(code: string, previewEl: HTMLElement, resultEl: HTMLElement): Promise<void> {
    const company = companyService.getActive();
    if (!company) return;
    const confirmBtn = document.getElementById('bpp-confirm') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('bpp-cancel') as HTMLButtonElement | null;
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Применяем…'; }
    if (cancelBtn) { cancelBtn.disabled = true; }

    const res = await billingService.applyPromoCode(code, company.id);

    previewEl.style.display = 'none';
    resultEl.style.display = 'block';

    if (res.ok) {
      resultEl.className = 'bill-promo-result ok';
      const parts: string[] = ['✓ Промокод применён'];
      if (res.discount_rub) parts.push(`−${res.discount_rub.toLocaleString('ru')} ₽`);
      if (res.description) parts.push(res.description);
      if (res.deferred) parts.push('активируется после текущей подписки');
      resultEl.textContent = parts.join(' · ');
      const input = document.getElementById('bill-promo') as HTMLInputElement | null;
      if (input) input.value = '';
      // Refresh subscription data
      const [sub] = await Promise.all([billingService.getSubscription(company.id)]);
      this.sub = sub;
      this.render();
    } else {
      resultEl.className = 'bill-promo-result err';
      resultEl.textContent = res.error ?? 'Ошибка применения промокода';
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Применить промокод'; }
      if (cancelBtn) { cancelBtn.disabled = false; }
    }
  }

  private esc(s: string | null | undefined): string {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
