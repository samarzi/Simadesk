import {
  adminService, AdminStats, AdminUser, AdminCompany, AdminCompanyWithApi, PromoCode, PromoRedemption,
  PlanConfig, AnalyticsData, SiteContent,
} from '@/services/adminService';
import { authService } from '@/services/authService';
import { showToast } from '@/utils/toast';
import {
  RoadmapTask, Quadrant, RoadmapStatus,
  roadmapDb,
  QUADRANT_LABELS, STATUS_LABELS, QUADRANT_COLORS,
} from '@/services/roadmapDb';
import { debug } from '@/utils/debug';
import { supportChatService, supportErrorText, AdminSupportChat, SupportAttachment } from '@/services/supportChatService';
import { reportAiUsage } from '@/services/aiUsage';

type AdminTab = 'overview' | 'analytics' | 'users' | 'companies' | 'subscriptions' | 'promos' | 'support' | 'settings' | 'pages' | 'roadmap';

/** Section metadata: label + human description shown in the header. */
const TAB_META: Record<AdminTab, { title: string; desc: string; group: string }> = {
  overview:      { title: 'Дашборд',      desc: 'Ключевые показатели платформы в реальном времени',        group: 'Обзор' },
  analytics:     { title: 'Аналитика',    desc: 'Динамика роста пользователей, компаний и выручки',        group: 'Обзор' },
  users:         { title: 'Пользователи', desc: 'Все зарегистрированные аккаунты, бан и пробный период',    group: 'Управление' },
  companies:     { title: 'Компании',     desc: 'Организации на платформе, их оборот и подписки',           group: 'Управление' },
  subscriptions: { title: 'Подписки',     desc: 'Назначение тарифов и продление пробного периода',          group: 'Управление' },
  promos:        { title: 'Промокоды',    desc: 'Создание кодов и статистика их использования',             group: 'Маркетинг' },
  support:       { title: 'Поддержка',    desc: 'Обращения пользователей и ответы на них',                  group: 'Поддержка' },
  settings:      { title: 'Настройки',    desc: 'Тарифная шкала, права администраторов и документы',        group: 'Система' },
  pages:         { title: 'Редактор сайта', desc: 'Политика конфиденциальности, реквизиты и страницы',       group: 'Система' },
  roadmap:       { title: 'Дорожная карта', desc: 'Задачи разработки: добавление, редактирование, приоритеты', group: 'Разработка' },
};

const PLAN_COLORS: Record<string, string> = {
  free: '#6b7280', starter: '#3b82f6', business: '#6366f1', pro: '#8b5cf6', max: '#f59e0b',
};

/* ── Picker state ── */
interface PickerState {
  userId: string; userName: string;
  companyId: string; companyName: string;
}

export class AdminModule {
  private el: HTMLElement;
  private tab: AdminTab = 'overview';
  private stats: AdminStats | null = null;
  private users: AdminUser[] = [];
  private usersTotal = 0;
  private userSearch = '';
  private companies: AdminCompany[] = [];
  private companiesTotal = 0;
  private companySearch = '';
  private promos: PromoCode[] = [];
  private plans: PlanConfig[] = [];
  private analytics: AnalyticsData | null = null;
  private loading = false;

  /* current admin identity (for the sidebar chip) */
  private role: string = 'admin';

  /* site editor */
  private siteContent: SiteContent[] = [];

  /* promo redemption drill-down */
  private promoRedemptions: PromoRedemption[] = [];
  private activePromo: PromoCode | null = null;
  private loadingRedemptions = false;

  /* picker state for subscriptions tab */
  private picker: PickerState = { userId: '', userName: '', companyId: '', companyName: '' };
  private _pickerCleanups: Array<() => void> = [];

  /* companies-with-api list for subscriptions tab */
  private apiCompanies: AdminCompanyWithApi[] = [];

  /* live support chat */
  private liveChats: AdminSupportChat[] = [];
  private activeLiveChat: AdminSupportChat | null = null;
  private liveChatPollTimer: ReturnType<typeof setInterval> | null = null;
  private liveChatLastMsgTime: string | null = null;
  private liveAttachFiles: SupportAttachment[] = [];
  private liveChatFilter: 'open' | 'all' = 'open';
  private liveChatReasonFilter: string | null = null;
  private supError: string | null = null;   // причина, по которой список чатов не загрузился

  /* support AI auto-reply */
  private supAiEnabled: boolean = localStorage.getItem('sd_sup_ai_enabled') === '1';
  private supAiModel: string = localStorage.getItem('sd_sup_ai_model') || 'anthropic/claude-haiku-4-5';
  private supNeedsAttention: Set<string> = new Set();  // chat IDs flagged for human
  private supAiProcessing: Set<string> = new Set();    // currently calling AI
  private supAiHandled: Map<string, string> = new Map(); // chatId → last AI reply time
  private apiSearch = '';
  private apiFilter: 'all' | 'active' | 'trial' | 'expired' = 'all';
  private inlineEdit: string | null = null; // company_id being edited inline

  /* roadmap tab */
  private roadmapTasks: RoadmapTask[] = [];
  private roadmapFilter: Quadrant | 'all' = 'all';
  private roadmapFormOpen = false;
  private roadmapEditing: RoadmapTask | null = null;
  private roadmapForm: { title: string; description: string; quadrant: Quadrant; status: RoadmapStatus } = { title: '', description: '', quadrant: 'important_not_urgent', status: 'todo' };

  constructor(el: HTMLElement) { this.el = el; }

  show(): void {
    this.el.style.display = 'flex';
    this.tab = 'overview';
    this.activeLiveChat = null;
    this.activePromo = null;
    this.render();
    // Load the admin's own role for the sidebar identity chip
    adminService.checkAdmin().then(r => { if (r.role) { this.role = r.role; this.render(); } });
    this.loadTab();
  }

  hide(): void { this.el.style.display = 'none'; this.stopLiveChatPolling(); }

  private async loadTab(): Promise<void> {
    this.loading = true;
    this.activeLiveChat = null;
    this.activePromo = null;
    this.render();
    try {
      switch (this.tab) {
        case 'overview':  this.stats = await adminService.getStats(); break;
        case 'users': {   const r = await adminService.getUsers(this.userSearch); this.users = r.users; this.usersTotal = r.total; break; }
        case 'companies': { const r = await adminService.getCompanies(this.companySearch); this.companies = r.companies; this.companiesTotal = r.total; break; }
        case 'promos':    this.promos = await adminService.getPromos(); break;
        case 'support': {
          // Ошибку списка чатов показываем в самой вкладке, а не роняем весь loadTab:
          // иначе админ видит пустой экран и не понимает, что RPC недоступен.
          try {
            this.liveChats = await supportChatService.adminGetChats(this.liveChatFilter);
            this.supError = null;
          } catch (e) {
            this.liveChats = [];
            this.supError = supportErrorText(e);
          }
          this.startLiveChatPolling();
          break;
        }
        case 'subscriptions': {
          const [plans, apiCos] = await Promise.all([
            adminService.getPlanConfigs(),
            adminService.getCompaniesWithApi(this.apiSearch),
          ]);
          this.plans = plans;
          this.apiCompanies = apiCos;
          break;
        }
        case 'settings':  this.plans = await adminService.getPlanConfigs(); break;
        case 'pages':     this.siteContent = await adminService.getSiteContent(); break;
        case 'analytics': this.analytics = await adminService.getAnalytics(); break;
        case 'roadmap':   this.roadmapTasks = await roadmapDb.getTasks(); break;
      }
    } catch (e: unknown) {
      debug.warn('[Admin] loadTab error:', e);
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка загрузки данных', 'error');
    }
    this.loading = false;
    this.render();
  }

  private setTab(tab: AdminTab): void { this.tab = tab; this.loadTab(); }

  // ── RENDER SHELL ─────────────────────────────────────────────────────────────
  private render(): void {
    this._pickerCleanups.forEach(fn => fn());
    this._pickerCleanups = [];
    this.el.innerHTML = `
      <div class="adm-shell">
        ${this.renderSidebar()}
        <div class="adm-body">
          ${this.renderHeader()}
          <div class="adm-content">
            ${this.loading ? this.renderSkeleton() : this.renderTabContent()}
          </div>
        </div>
      </div>`;
    this.bindEvents();
  }

  private renderSidebar(): string {
    const nav: { id: AdminTab; icon: string; badge?: number }[] = [
      { id: 'overview',      icon: 'grid' },
      { id: 'analytics',     icon: 'chart' },
      { id: 'users',         icon: 'users',  badge: this.usersTotal || undefined },
      { id: 'companies',     icon: 'build',  badge: this.companiesTotal || undefined },
      { id: 'subscriptions', icon: 'credit' },
      { id: 'promos',        icon: 'tag' },
      { id: 'support',       icon: 'chat',   badge: this.stats?.open_tickets || undefined },
      { id: 'settings',      icon: 'cog' },
      { id: 'pages',         icon: 'doc' },
      { id: 'roadmap',       icon: 'check' },
    ];
    // Group nav items by their section
    const groups: string[] = [];
    let lastGroup = '';
    for (const n of nav) {
      const meta = TAB_META[n.id];
      if (meta.group !== lastGroup) {
        groups.push(`<div class="adm-nav-group">${meta.group}</div>`);
        lastGroup = meta.group;
      }
      groups.push(`
        <button class="adm-nav-item ${this.tab === n.id ? 'active' : ''}" data-tab="${n.id}">
          ${this.ico(n.icon)}<span>${meta.title}</span>
          ${n.badge ? `<span class="adm-nav-badge">${n.badge}</span>` : ''}
        </button>`);
    }

    const u = authService.getUser();
    const name = u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : 'Администратор';
    const avatar = u?.photo_url
      ? `<img src="${this.esc(u.photo_url)}" class="adm-avatar-img" alt="">`
      : `<div class="adm-avatar-placeholder" style="width:32px;height:32px;font-size:12px">${(u?.first_name?.[0] ?? 'A').toUpperCase()}</div>`;

    return `
      <aside class="adm-sidebar">
        <div class="adm-sidebar-logo">
          <div class="adm-logo-icon">⚡</div>
          <div><div class="adm-logo-title">SimaDesk</div><div class="adm-logo-sub">Admin Panel</div></div>
        </div>
        <nav class="adm-nav">${groups.join('')}</nav>
        <div class="adm-sidebar-footer">
          <div class="adm-identity">
            <div class="adm-avatar" style="width:32px;height:32px">${avatar}</div>
            <div class="adm-identity-body">
              <div class="adm-identity-name">${this.esc(name)}</div>
              <div class="adm-identity-role" style="color:${this.roleColor(this.role)}">${this.roleLabel(this.role)}</div>
            </div>
          </div>
          <button class="adm-back-btn" id="adm-back">${this.ico('arrow-left')}<span>Выйти из панели</span></button>
        </div>
      </aside>`;
  }

  private renderHeader(): string {
    const meta = TAB_META[this.tab];
    return `
      <div class="adm-header">
        <div class="adm-header-text">
          <div class="adm-breadcrumb">${meta.group} <span class="adm-breadcrumb-sep">/</span> ${meta.title}</div>
          <h1 class="adm-title">${meta.title}</h1>
          <div class="adm-subtitle">${meta.desc}</div>
        </div>
      </div>`;
  }

  private roleLabel(role: string): string {
    const map: Record<string, string> = {
      superadmin: 'Создатель', admin: 'Администратор', support: 'Поддержка', billing: 'Биллинг',
    };
    return map[role] ?? role;
  }

  private renderTabContent(): string {
    switch (this.tab) {
      case 'overview':      return this.renderOverview();
      case 'analytics':     return this.renderAnalytics();
      case 'users':         return this.renderUsers();
      case 'companies':     return this.renderCompanies();
      case 'subscriptions': return this.renderSubscriptions();
      case 'promos':        return this.renderPromos();
      case 'support':       return this.renderSupport();
      case 'settings':      return this.renderSettings();
      case 'pages':         return this.renderPages();
      case 'roadmap':       return this.renderRoadmap();
    }
  }

  // ── OVERVIEW ─────────────────────────────────────────────────────────────────
  private renderOverview(): string {
    const s = this.stats;
    if (!s) return '<div class="adm-empty">Не удалось загрузить статистику</div>';
    const kpis = [
      { label: 'Пользователи',      value: s.total_users,    icon: 'users',  color: '#6366f1', sub: `+${s.new_users_7d} за 7 дней` },
      { label: 'Компании',          value: s.total_companies, icon: 'build',  color: '#3b82f6', sub: `всего активных` },
      { label: 'Активных подписок', value: s.active_subs,    icon: 'credit', color: '#22c55e', sub: `${s.trial_users} на пробном` },
      { label: 'MRR',               value: null,             icon: 'ruble',  color: '#f59e0b', sub: `+${s.new_users_30d} пользователей/мес`, money: s.mrr },
    ];
    return `
      <div class="adm-kpi-grid">
        ${kpis.map(k => `
          <div class="adm-kpi-card">
            <div class="adm-kpi-icon" style="background:${k.color}22;color:${k.color}">${this.ico(k.icon)}</div>
            <div class="adm-kpi-body">
              <div class="adm-kpi-value">${k.money != null ? adminService.fmtMoney(k.money) : k.value!.toLocaleString('ru')}</div>
              <div class="adm-kpi-label">${k.label}</div>
              <div class="adm-kpi-sub">${k.sub}</div>
            </div>
          </div>`).join('')}
      </div>
      <div class="adm-row-2">
        <div class="adm-card">
          <div class="adm-card-title">Активность платформы</div>
          <div class="adm-stat-list">
            ${this.srow('Новых за 7 дней',    s.new_users_7d,  '#6366f1')}
            ${this.srow('Новых за 30 дней',   s.new_users_30d, '#3b82f6')}
            ${this.srow('На пробном периоде', s.trial_users,   '#f59e0b')}
            ${this.srow('Заблокировано',      s.banned_users,  '#ef4444')}
            ${this.srow('Открытых тикетов',   s.open_tickets,  '#f59e0b')}
          </div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Быстрые действия</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
            <button class="adm-quick-btn" data-tab="users">${this.ico('users')} Управление пользователями</button>
            <button class="adm-quick-btn" data-tab="companies">${this.ico('build')} Управление компаниями</button>
            <button class="adm-quick-btn" data-tab="support">${this.ico('chat')} Обращения в поддержку${s.open_tickets > 0 ? ` <span class="adm-nav-badge" style="background:#f59e0b">${s.open_tickets}</span>` : ''}</button>
            <button class="adm-quick-btn" data-tab="settings">${this.ico('cog')} Настроить тарифы</button>
          </div>
        </div>
      </div>`;
  }

  private srow(label: string, value: number, color: string): string {
    return `<div class="adm-stat-row">
      <div class="adm-stat-dot" style="background:${color}"></div>
      <span class="adm-stat-label">${label}</span>
      <span class="adm-stat-val" style="color:${color}">${value.toLocaleString('ru')}</span>
    </div>`;
  }

  // ── ANALYTICS ─────────────────────────────────────────────────────────────────
  private renderAnalytics(): string {
    const a = this.analytics;
    if (!a) return '<div class="adm-empty">Не удалось загрузить аналитику. Попробуйте обновить страницу.</div>';

    const newUsers30 = a.users_by_day.reduce((s, d) => s + d.count, 0);
    const newComp30  = a.companies_by_day.reduce((s, d) => s + d.count, 0);
    const activeSubs = a.plans_dist.reduce((s, d) => s + d.count, 0);
    // Growth %: new in 30d relative to prior base
    const priorBase = Math.max(1, a.total_users - newUsers30);
    const growthPct = Math.round((newUsers30 / priorBase) * 100);

    const summary = [
      { label: 'Всего пользователей', value: a.total_users.toLocaleString('ru'), trend: `+${newUsers30} за 30д`, up: newUsers30 > 0, color: '#6366f1', icon: 'users' },
      { label: 'Компаний',            value: a.total_companies.toLocaleString('ru'), trend: `+${newComp30} за 30д`, up: newComp30 > 0, color: '#3b82f6', icon: 'build' },
      { label: 'Активных подписок',   value: activeSubs.toLocaleString('ru'), trend: `${a.plans_dist.length} тарифов`, up: activeSubs > 0, color: '#8b5cf6', icon: 'credit' },
      { label: 'Оборот клиентов / 30д', money: a.total_revenue, trend: `рост ${growthPct}%`, up: growthPct > 0, color: '#22c55e', icon: 'ruble' },
    ];

    return `
      <div class="adm-anl-summary">
        ${summary.map(k => `
          <div class="adm-anl-stat">
            <div class="adm-anl-stat-icon" style="background:${k.color}1a;color:${k.color}">${this.ico(k.icon)}</div>
            <div class="adm-anl-stat-val">${k.money != null ? adminService.fmtMoney(k.money) : k.value}</div>
            <div class="adm-anl-stat-label">${k.label}</div>
            <div class="adm-anl-stat-trend ${k.up ? 'up' : ''}">${k.up ? '↑ ' : ''}${k.trend}</div>
          </div>`).join('')}
      </div>

      <div class="adm-analytics-grid">
        <div class="adm-card adm-card-wide">
          <div class="adm-chart-head">
            <div>
              <div class="adm-card-title">Рост пользователей</div>
              <div class="adm-card-desc">Накопительно за последние 30 дней · +${newUsers30} новых</div>
            </div>
            <div class="adm-chart-legend"><span class="adm-dot" style="background:#6366f1"></span> Всего аккаунтов</div>
          </div>
          <div class="adm-chart-wrap">${this.areaChart(a.users_by_day, a.total_users, '#6366f1')}</div>
        </div>

        <div class="adm-card adm-card-wide">
          <div class="adm-chart-head">
            <div>
              <div class="adm-card-title">Ежедневная активность</div>
              <div class="adm-card-desc">Новые регистрации и компании по дням</div>
            </div>
            <div class="adm-chart-legend">
              <span class="adm-dot" style="background:#6366f1"></span> Пользователи
              <span class="adm-dot" style="background:#3b82f6;margin-left:12px"></span> Компании
            </div>
          </div>
          <div class="adm-chart-wrap">${this.groupedBars(a.users_by_day, a.companies_by_day)}</div>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Топ компаний по обороту</div>
          <div class="adm-card-desc">За последние 30 дней</div>
          ${a.revenue_by_company.length === 0
            ? '<div class="adm-chart-empty">Нет данных об обороте</div>'
            : `<div class="adm-chart-wrap">${this.renderHBarChart(a.revenue_by_company, '#22c55e')}</div>`}
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Распределение по тарифам</div>
          <div class="adm-card-desc">Активные подписки</div>
          ${a.plans_dist.length === 0
            ? '<div class="adm-chart-empty">Нет активных подписок</div>'
            : `<div class="adm-donut-wrap">${this.renderDonut(a.plans_dist)}</div>`}
        </div>

        <div class="adm-card adm-card-wide">
          <div class="adm-card-title">Администраторы платформы</div>
          <div class="adm-card-desc">Пользователи с доступом к этой панели</div>
          <div class="adm-table-wrap" style="margin-top:12px">
            <table class="adm-table">
              <thead><tr><th>Пользователь</th><th>Роль</th><th>Добавлен</th><th style="width:50px"></th></tr></thead>
              <tbody>
                ${a.admins.length === 0
                  ? `<tr><td colspan="4" class="adm-empty-cell">Нет данных</td></tr>`
                  : a.admins.map(ad => `
                    <tr class="adm-tr">
                      <td>
                        <div class="adm-user-name">${this.esc(ad.first_name)} ${this.esc(ad.last_name ?? '')}</div>
                        <div class="adm-user-sub">${ad.telegram_username ? '@' + this.esc(ad.telegram_username) : ''}</div>
                      </td>
                      <td><span class="adm-badge" style="background:${this.roleColor(ad.role)}22;color:${this.roleColor(ad.role)}">${this.roleLabel(ad.role)}</span></td>
                      <td class="adm-td-muted">${adminService.fmtDate(ad.created_at)}</td>
                      <td>
                        <button class="adm-action-btn red" data-action="revoke-role" data-uid="${ad.user_id}" title="Отозвать права">
                          ${this.ico('block')}
                        </button>
                      </td>
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  /** Cumulative area chart with gridlines + Y axis. Data is per-day counts; we render the running total up to `finalTotal`. */
  private areaChart(data: Array<{ date: string; count: number }>, finalTotal: number, color: string): string {
    if (!data || data.length === 0) return '<div class="adm-chart-empty">Нет данных за период</div>';
    const W = 640; const H = 180; const padL = 40; const padR = 12; const padT = 12; const padB = 22;
    const iw = W - padL - padR; const ih = H - padT - padB;

    // Build cumulative series ending at finalTotal
    const sum30 = data.reduce((s, d) => s + d.count, 0);
    let running = Math.max(0, finalTotal - sum30);
    const pts = data.map(d => { running += d.count; return { date: d.date, val: running }; });
    const maxV = Math.max(...pts.map(p => p.val), 1);
    const minV = Math.max(0, finalTotal - sum30);
    const range = Math.max(1, maxV - minV);

    const x = (i: number) => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
    const y = (v: number) => padT + ih - ((v - minV) / range) * ih;

    // Gridlines (4 rows) + Y labels
    const grid: string[] = [];
    for (let g = 0; g <= 4; g++) {
      const gy = padT + (ih / 4) * g;
      const gv = Math.round(maxV - (range / 4) * g);
      grid.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--border)" stroke-width="1" opacity=".5"/>`);
      grid.push(`<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--text3)">${gv >= 1000 ? (gv/1000).toFixed(0)+'k' : gv}</text>`);
    }

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.val).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${x(pts.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${x(0).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

    // X labels (~6 evenly spaced)
    const step = Math.max(1, Math.floor(pts.length / 6));
    const xlabels = pts.map((p, i) => {
      if (i % step !== 0 && i !== pts.length - 1) return '';
      const ds = p.date ? new Date(p.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
      return `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--text3)">${ds}</text>`;
    }).join('');

    const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.val).toFixed(1)}" r="2.5" fill="${color}"><title>${new Date(p.date).toLocaleDateString('ru-RU')}: ${p.val}</title></circle>`).join('');

    return `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" preserveAspectRatio="none">
        <defs>
          <linearGradient id="anlGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity=".35"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid.join('')}
        <path d="${areaPath}" fill="url(#anlGrad)"/>
        <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}${xlabels}
      </svg>`;
  }

  /** Two-series grouped bar chart (users vs companies) with gridlines. */
  private groupedBars(users: Array<{ date: string; count: number }>, comps: Array<{ date: string; count: number }>): string {
    const n = Math.max(users.length, comps.length);
    if (n === 0) return '<div class="adm-chart-empty">Нет данных за период</div>';
    const W = 640; const H = 160; const padL = 30; const padR = 8; const padT = 10; const padB = 22;
    const iw = W - padL - padR; const ih = H - padT - padB;
    const slot = iw / n;
    const bw = Math.max(2, Math.min(10, slot / 2 - 1));
    const max = Math.max(1, ...users.map(d => d.count), ...comps.map(d => d.count));

    const grid: string[] = [];
    for (let g = 0; g <= 3; g++) {
      const gy = padT + (ih / 3) * g;
      const gv = Math.round(max - (max / 3) * g);
      grid.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--border)" stroke-width="1" opacity=".5"/>`);
      grid.push(`<text x="${padL - 5}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--text3)">${gv}</text>`);
    }

    const bars: string[] = [];
    for (let i = 0; i < n; i++) {
      const ux = padL + slot * i + slot / 2 - bw - 1;
      const cx = padL + slot * i + slot / 2 + 1;
      const uc = users[i]?.count ?? 0;
      const cc = comps[i]?.count ?? 0;
      const uh = (uc / max) * ih; const ch = (cc / max) * ih;
      const ds = users[i]?.date ? new Date(users[i].date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
      if (uc > 0) bars.push(`<rect x="${ux.toFixed(1)}" y="${(padT + ih - uh).toFixed(1)}" width="${bw.toFixed(1)}" height="${uh.toFixed(1)}" rx="2" fill="#6366f1"><title>${ds}: ${uc} польз.</title></rect>`);
      if (cc > 0) bars.push(`<rect x="${cx.toFixed(1)}" y="${(padT + ih - ch).toFixed(1)}" width="${bw.toFixed(1)}" height="${ch.toFixed(1)}" rx="2" fill="#3b82f6"><title>${ds}: ${cc} комп.</title></rect>`);
    }

    const step = Math.max(1, Math.floor(n / 6));
    const xlabels: string[] = [];
    for (let i = 0; i < n; i += step) {
      const ds = users[i]?.date ? new Date(users[i].date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
      xlabels.push(`<text x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--text3)">${ds}</text>`);
    }

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${grid.join('')}${bars.join('')}${xlabels.join('')}</svg>`;
  }

  private renderHBarChart(data: Array<{ name: string; revenue: number }>, color: string): string {
    if (!data || data.length === 0) return '<div class="adm-chart-empty">Нет данных</div>';
    const max = Math.max(...data.map(d => d.revenue), 1);
    const rowH = 30; const H = data.length * rowH; const W = 480; const labelW = 130;
    const rows = data.map((d, i) => {
      const barW = Math.round(((d.revenue) / max) * (W - labelW - 70));
      const y = i * rowH + 5;
      return `
        <text x="0" y="${y + 16}" font-size="11" fill="var(--text2)" dominant-baseline="middle">
          ${this.esc(d.name.length > 17 ? d.name.slice(0, 16) + '…' : d.name)}
        </text>
        <rect x="${labelW}" y="${y + 5}" width="${W - labelW - 70}" height="16" rx="4" fill="var(--bg3)"/>
        <rect x="${labelW}" y="${y + 5}" width="${barW}" height="16" rx="4" fill="${color}"/>
        <text x="${W - 64}" y="${y + 16}" font-size="10" font-weight="600" fill="var(--text2)" dominant-baseline="middle">
          ${adminService.fmt(d.revenue)}
        </text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:260px;margin-top:12px">${rows.join('')}</svg>`;
  }

  private renderDonut(data: Array<{ plan: string; count: number }>): string {
    const COLORS: Record<string, string> = { free: '#6b7280', starter: '#3b82f6', business: '#6366f1', pro: '#8b5cf6', max: '#f59e0b' };
    const LABELS: Record<string, string> = { free: 'Бесплатно', starter: 'Старт', business: 'Бизнес', pro: 'Про', max: 'Макс' };
    const total = data.reduce((s, d) => s + d.count, 0);
    if (total === 0) return '<div class="adm-chart-empty">Нет данных</div>';
    const cx = 80; const cy = 80; const r = 62; const ri = 42;
    let startAngle = -Math.PI / 2;
    const slices = data.map(d => {
      const angle = (d.count / total) * 2 * Math.PI;
      const endAngle = startAngle + angle;
      const x1 = cx + r * Math.cos(startAngle); const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);   const y2 = cy + r * Math.sin(endAngle);
      const xi1 = cx + ri * Math.cos(startAngle); const yi1 = cy + ri * Math.sin(startAngle);
      const xi2 = cx + ri * Math.cos(endAngle);   const yi2 = cy + ri * Math.sin(endAngle);
      const large = angle > Math.PI ? 1 : 0;
      const path = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${xi2},${yi2} A${ri},${ri} 0 ${large} 0 ${xi1},${yi1} Z`;
      const col = COLORS[d.plan] ?? '#6b7280';
      const pct = Math.round((d.count / total) * 100);
      const slice = `<path d="${path}" fill="${col}"><title>${LABELS[d.plan] ?? d.plan}: ${d.count} (${pct}%)</title></path>`;
      startAngle = endAngle;
      return { slice, d, col, pct };
    });
    const legend = slices.map((s) => `
      <div class="adm-donut-legend-row">
        <div style="width:10px;height:10px;border-radius:3px;background:${s.col};flex-shrink:0"></div>
        <span style="color:var(--text2)">${LABELS[s.d.plan] ?? s.d.plan}</span>
        <span style="color:var(--text3);margin-left:auto">${s.pct}%</span>
        <span style="color:var(--text);font-weight:600;min-width:24px;text-align:right">${s.d.count}</span>
      </div>`).join('');
    return `
      <div class="adm-donut-flex">
        <svg viewBox="0 0 160 160" style="width:150px;height:150px;flex-shrink:0">
          ${slices.map(s => s.slice).join('')}
          <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text)">${total}</text>
          <text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="9" fill="var(--text3)">подписок</text>
        </svg>
        <div class="adm-donut-legend">${legend}</div>
      </div>`;
  }

  private roleColor(role: string): string {
    const map: Record<string, string> = { superadmin: '#ef4444', admin: '#6366f1', support: '#3b82f6', billing: '#f59e0b' };
    return map[role] ?? '#6b7280';
  }

  // ── USERS ─────────────────────────────────────────────────────────────────────
  private renderUsers(): string {
    return `
      <div class="adm-toolbar">
        <div class="adm-search-wrap">${this.ico('search')}<input class="adm-search" id="adm-user-search" placeholder="Имя, @username…" value="${this.esc(this.userSearch)}"></div>
        <div class="adm-toolbar-info">${this.usersTotal.toLocaleString('ru')} пользователей</div>
      </div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Пользователь</th><th>Зарегистрирован</th><th>Последний вход</th><th>Компании</th><th>Тариф</th><th>Статус</th><th>Триал</th><th style="width:70px"></th></tr></thead>
          <tbody>${this.users.length === 0
            ? `<tr><td colspan="7" class="adm-empty-cell">Нет пользователей</td></tr>`
            : this.users.map(u => this.renderUserRow(u)).join('')}</tbody>
        </table>
      </div>`;
  }

  private renderUserRow(u: AdminUser): string {
    const isBanned = u.banned_until && new Date(u.banned_until) > new Date();
    const trialActive = u.trial_ends_at && new Date(u.trial_ends_at) > new Date();
    const daysLeft = u.trial_days_left ?? 0;
    const isSuperadmin = u.admin_role === 'superadmin';
    const avatar = u.photo_url
      ? `<img src="${this.esc(u.photo_url)}" class="adm-avatar-img" alt="">`
      : `<div class="adm-avatar-placeholder">${(u.first_name?.[0] ?? '?').toUpperCase()}</div>`;

    let planBadge: string;
    if (u.subscription?.status === 'active') {
      const col = PLAN_COLORS[u.subscription.plan_key] ?? '#6366f1';
      planBadge = `<span class="adm-badge" style="background:${col}22;color:${col}">${u.subscription.plan_key}</span>`;
    } else if (trialActive) {
      planBadge = '<span class="adm-badge purple">Пробный</span>';
    } else {
      planBadge = '<span class="adm-badge grey">—</span>';
    }

    const trialCell = trialActive
      ? `<div class="adm-trial-row">
           <span class="adm-trial-days ${daysLeft <= 3 ? 'warn' : ''}">${daysLeft} дн.</span>
           <div class="adm-trial-edit">
             <input class="adm-trial-input" type="number" min="1" max="365" value="${daysLeft}" data-uid="${u.id}" title="Новое кол-во дней">
             <button class="adm-trial-save-btn" data-action="set-trial-days" data-uid="${u.id}" title="Сохранить">✓</button>
           </div>
         </div>`
      : `<button class="adm-action-btn" data-action="extend-trial" data-uid="${u.id}" title="Выдать пробный">${this.ico('clock')}</button>`;

    return `
      <tr class="adm-tr">
        <td>
          <div class="adm-user-cell">
            <div class="adm-avatar">${avatar}</div>
            <div>
              <div class="adm-user-name">${this.esc(u.first_name)} ${this.esc(u.last_name ?? '')}${u.admin_role ? ` <span class="adm-badge" style="background:${this.roleColor(u.admin_role)}22;color:${this.roleColor(u.admin_role)};font-size:10px;padding:1px 6px">${this.roleLabel(u.admin_role)}</span>` : ''}</div>
              <div class="adm-user-sub">${u.telegram_username ? '@' + this.esc(u.telegram_username) : ''}</div>
            </div>
          </div>
        </td>
        <td class="adm-td-muted">${adminService.fmtDate(u.created_at)}</td>
        <td class="adm-td-muted">${adminService.fmtDate(u.last_login_at)}</td>
        <td class="adm-td-center">${u.company_count}</td>
        <td>${planBadge}</td>
        <td>${isBanned
          ? `<span class="adm-badge red" title="Заблокирован до ${adminService.fmtDate(u.banned_until)}">Бан</span>`
          : trialActive
            ? `<span class="adm-badge yellow">Пробный</span>`
            : u.subscription?.status === 'active'
              ? `<span class="adm-badge green">Активен</span>`
              : `<span class="adm-badge grey">Без подписки</span>`
        }</td>
        <td>${trialCell}</td>
        <td>
          <div class="adm-actions">
            <button class="adm-action-btn ${isBanned ? 'green' : 'red'}" data-action="${isBanned ? 'unban' : 'ban'}" data-uid="${u.id}" title="${isBanned ? 'Разбанить' : 'Заблокировать'}">
              ${isBanned ? this.ico('check') : this.ico('block')}
            </button>
            ${!isSuperadmin ? `<button class="adm-action-btn red" data-action="delete-user" data-uid="${u.id}" data-uname="${this.esc(u.first_name + ' ' + (u.last_name ?? ''))}" title="Удалить пользователя">${this.ico('trash')}</button>` : ''}
          </div>
        </td>
      </tr>`;
  }

  // ── COMPANIES ─────────────────────────────────────────────────────────────────
  private renderCompanies(): string {
    return `
      <div class="adm-toolbar">
        <div class="adm-search-wrap">${this.ico('search')}<input class="adm-search" id="adm-company-search" placeholder="Название компании…" value="${this.esc(this.companySearch)}"></div>
        <div class="adm-toolbar-info">${this.companiesTotal.toLocaleString('ru')} компаний</div>
      </div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Компания</th><th>Владелец</th><th>Создана</th><th>Участников</th><th>Оборот / 30д</th><th>Тариф</th><th style="width:50px"></th></tr></thead>
          <tbody>${this.companies.length === 0
            ? `<tr><td colspan="7" class="adm-empty-cell">Нет компаний</td></tr>`
            : this.companies.map(c => this.renderCompanyRow(c)).join('')}</tbody>
        </table>
      </div>`;
  }

  private renderCompanyRow(c: AdminCompany): string {
    const logo = c.logo_url
      ? `<img src="${this.esc(c.logo_url)}" class="adm-company-logo" alt="">`
      : `<div class="adm-company-logo-placeholder" style="background:${c.color ?? '#6366f1'}">${(c.name?.[0] ?? '?').toUpperCase()}</div>`;
    const sub = c.subscription;
    const planBadge = sub
      ? `<span class="adm-badge" style="background:${PLAN_COLORS[sub.plan_key] ?? '#6366f1'}22;color:${PLAN_COLORS[sub.plan_key] ?? '#6366f1'}">${sub.plan_key}</span>`
      : `<span class="adm-badge grey">—</span>`;

    return `
      <tr class="adm-tr">
        <td>
          <div class="adm-user-cell">${logo}
            <div>
              <div class="adm-user-name">${this.esc(c.name)}</div>
              <div class="adm-user-sub">${c.inn ? 'ИНН ' + c.inn : ''}</div>
            </div>
          </div>
        </td>
        <td class="adm-td-muted">${c.owner_first_name ? this.esc(c.owner_first_name + ' ' + (c.owner_last_name ?? '')) : '—'}${c.owner_username ? `<br><span style="font-size:11px">@${this.esc(c.owner_username)}</span>` : ''}</td>
        <td class="adm-td-muted">${adminService.fmtDate(c.created_at)}</td>
        <td class="adm-td-center">${c.member_count}</td>
        <td class="adm-td-muted" style="font-weight:${c.monthly_revenue > 0 ? '600' : '400'};color:${c.monthly_revenue > 0 ? 'var(--text)' : 'var(--text3)'}">
          ${c.monthly_revenue > 0 ? adminService.fmtMoney(c.monthly_revenue) : '—'}
        </td>
        <td>${planBadge}</td>
        <td>
          <button class="adm-action-btn red" data-action="delete-company" data-cid="${c.id}" data-cname="${this.esc(c.name)}" title="Удалить компанию">${this.ico('trash')}</button>
        </td>
      </tr>`;
  }

  // ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────────
  private renderSubscriptions(): string {
    const now = Date.now();

    const filterBtns = (['all', 'active', 'trial', 'expired'] as const).map(f => {
      const labels: Record<string, string> = { all: 'Все', active: 'Активные', trial: 'Пробный', expired: 'Без подписки' };
      return `<button class="adm-filter-btn ${this.apiFilter === f ? 'active' : ''}" data-api-filter="${f}">${labels[f]}</button>`;
    }).join('');

    const visible = this.apiCompanies.filter(c => {
      const sub = c.subscription;
      const hasActiveSub = sub?.status === 'active' && sub.current_period_end && new Date(sub.current_period_end).getTime() > now;
      const hasTrial = !!c.owner_trial_ends_at && new Date(c.owner_trial_ends_at).getTime() > now;
      if (this.apiFilter === 'active') return hasActiveSub;
      if (this.apiFilter === 'trial') return !hasActiveSub && hasTrial;
      if (this.apiFilter === 'expired') return !hasActiveSub && !hasTrial;
      return true;
    });

    const rows = visible.map(c => this.renderApiCompanyRow(c, now)).join('');

    return `
      <div class="adm-subs-layout">
        <!-- ── Company list with API keys ── -->
        <div class="adm-subs-main">
          <div class="adm-toolbar" style="gap:8px;flex-wrap:wrap">
            <div class="adm-search-wrap">${this.ico('search')}<input class="adm-search" id="adm-api-search" placeholder="Компания или владелец…" value="${this.esc(this.apiSearch)}"></div>
            <div class="adm-filter-btns">${filterBtns}</div>
            <div class="adm-toolbar-info">${visible.length} из ${this.apiCompanies.length} компаний</div>
          </div>
          <div class="adm-table-wrap">
            <table class="adm-table adm-subs-table">
              <thead>
                <tr>
                  <th>Компания</th>
                  <th>Владелец</th>
                  <th>API</th>
                  <th>Статус доступа</th>
                  <th>Подписка до</th>
                  <th style="width:120px">Действия</th>
                </tr>
              </thead>
              <tbody>
                ${rows || `<tr><td colspan="6" class="adm-empty-cell">Нет компаний с подключёнными API</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── Manual assignment cards ── -->
        <div class="adm-subs-sidebar">
          <div class="adm-card">
            <div class="adm-card-title">Назначить подписку</div>
            <div class="adm-card-desc">Пользователь и компания — подписка создаётся или обновляется.</div>
            <div class="adm-form">
              <div class="adm-form-row">
                <label class="adm-label">Пользователь</label>
                ${this.renderPicker('user', this.picker.userId, this.picker.userName, 'Найти пользователя…')}
              </div>
              <div class="adm-form-row">
                <label class="adm-label">Компания</label>
                ${this.renderPicker('company', this.picker.companyId, this.picker.companyName, 'Найти компанию…')}
              </div>
              <div class="adm-form-row-2">
                <div>
                  <label class="adm-label">Тариф</label>
                  <select class="adm-input" id="sub-plan">
                    ${this.plans.map(p => `<option value="${p.key}">${p.label} — ${p.price_rub === 0 ? 'Бесплатно' : p.price_rub.toLocaleString('ru') + ' ₽'}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="adm-label">Месяцев</label>
                  <input class="adm-input" id="sub-months" type="number" min="1" max="24" value="1">
                </div>
              </div>
              <button class="adm-btn-primary" id="sub-save">Назначить подписку</button>
            </div>
          </div>

          <div class="adm-card" style="margin-top:16px">
            <div class="adm-card-title">Продлить пробный период</div>
            <div class="adm-form">
              <div class="adm-form-row">
                <label class="adm-label">Пользователь</label>
                ${this.renderPicker('trial-user', '', '', 'Найти пользователя…')}
              </div>
              <div class="adm-form-row">
                <label class="adm-label">Дней</label>
                <input class="adm-input" id="trial-days" type="number" min="1" max="365" value="14">
              </div>
              <button class="adm-btn-primary" id="trial-save">Продлить</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  private renderApiCompanyRow(c: AdminCompanyWithApi, now: number): string {
    const sub = c.subscription;
    const hasActiveSub = sub?.status === 'active' && sub.current_period_end && new Date(sub.current_period_end).getTime() > now;
    const hasTrial = !!c.owner_trial_ends_at && new Date(c.owner_trial_ends_at).getTime() > now;

    // Status badge
    let statusBadge: string;
    let endDateStr = '—';
    if (hasActiveSub) {
      const daysLeft = Math.ceil((new Date(sub!.current_period_end!).getTime() - now) / 86_400_000);
      const urgency = daysLeft <= 7 ? 'style="color:#ef4444"' : daysLeft <= 14 ? 'style="color:#f59e0b"' : '';
      endDateStr = `<span ${urgency}>${adminService.fmtDate(sub!.current_period_end)}</span>`;
      statusBadge = `<span class="adm-badge green">${PLAN_COLORS[sub!.plan_key] ? sub!.plan_key : 'active'} · ${daysLeft}д</span>`;
    } else if (hasTrial) {
      const trialDays = Math.ceil((new Date(c.owner_trial_ends_at!).getTime() - now) / 86_400_000);
      endDateStr = `<span style="color:#6366f1">${adminService.fmtDate(c.owner_trial_ends_at)}</span>`;
      statusBadge = `<span class="adm-badge" style="background:#6366f122;color:#6366f1">Пробный · ${trialDays}д</span>`;
    } else {
      statusBadge = `<span class="adm-badge grey">Нет доступа</span>`;
    }

    // API icons
    const apiIcons = [
      c.has_wb     ? `<span class="adm-api-tag wb">WB</span>` : '',
      c.has_ozon   ? `<span class="adm-api-tag oz">OZ</span>` : '',
      c.has_yandex ? `<span class="adm-api-tag ya">YA</span>` : '',
    ].filter(Boolean).join('');

    // Logo
    const logo = c.logo_url
      ? `<img src="${this.esc(c.logo_url)}" class="adm-company-logo" alt="">`
      : `<div class="adm-company-logo-placeholder" style="background:${c.color ?? '#6366f1'}">${(c.name?.[0] ?? '?').toUpperCase()}</div>`;

    // Inline edit row
    const isEditing = this.inlineEdit === c.id;
    const currentEnd = sub?.current_period_end ?? c.owner_trial_ends_at ?? null;
    // Default date for picker: current end date, or 30 days from now if none
    const defaultEndDate = currentEnd
      ? new Date(currentEnd).toISOString().slice(0, 10)
      : new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    const editRow = isEditing ? `
      <tr class="adm-inline-edit-row">
        <td colspan="6">
          <div class="adm-inline-edit" style="flex-direction:column;align-items:flex-start;gap:12px">
            ${currentEnd ? `<div style="font-size:12px;color:var(--text2)">Текущая дата окончания: <b>${adminService.fmtDate(currentEnd)}</b></div>` : ''}
            <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
              <div>
                <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:4px">Установить дату окончания</div>
                <input class="adm-input" id="inline-date-${c.id}" type="date" value="${defaultEndDate}" style="width:160px">
              </div>
              <div style="display:flex;flex-direction:column;align-items:center;color:var(--text3);font-size:11px;font-weight:600;padding-bottom:8px">или</div>
              <div>
                <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:4px">Добавить / убрать дни</div>
                <input class="adm-input adm-inline-days" id="inline-days-${c.id}" type="number" min="-3650" max="3650" value="0" style="width:90px" placeholder="0">
              </div>
              <div style="display:flex;gap:6px;padding-bottom:2px">
                <button class="adm-btn-primary adm-btn-sm" data-action="confirm-extend" data-cid="${c.id}">Применить</button>
                <button class="adm-action-btn" data-action="cancel-extend">Отмена</button>
              </div>
            </div>
          </div>
        </td>
      </tr>` : '';

    return `
      <tr class="adm-tr">
        <td>
          <div class="adm-user-cell">${logo}
            <div>
              <div class="adm-user-name">${this.esc(c.name)}</div>
              ${c.monthly_revenue > 0 ? `<div class="adm-user-sub">${adminService.fmtMoney(c.monthly_revenue)}/мес</div>` : ''}
            </div>
          </div>
        </td>
        <td class="adm-td-muted">
          ${c.owner_first_name ? this.esc(`${c.owner_first_name} ${c.owner_last_name ?? ''}`.trim()) : '—'}
          ${c.owner_username ? `<br><span style="font-size:11px;color:var(--text3)">@${this.esc(c.owner_username)}</span>` : ''}
        </td>
        <td>${apiIcons || '—'}</td>
        <td>${statusBadge}</td>
        <td class="adm-td-muted" style="font-size:12px">${endDateStr}</td>
        <td>
          <div class="adm-actions">
            <button class="adm-btn-sm adm-btn-outline" data-action="quick-extend" data-cid="${c.id}" title="+30 дней">+30д</button>
            <button class="adm-action-btn" data-action="edit-extend" data-cid="${c.id}" title="Задать количество дней">${this.ico('cog')}</button>
          </div>
        </td>
      </tr>
      ${editRow}`;
  }

  private renderPicker(kind: string, selectedId: string, selectedName: string, placeholder: string): string {
    return `
      <div class="adm-picker" data-picker="${kind}">
        <div class="adm-picker-input-wrap">
          ${this.ico('search')}
          <input class="adm-picker-input" placeholder="${placeholder}" value="${this.esc(selectedName)}" autocomplete="off">
          ${selectedId ? `<input type="hidden" class="adm-picker-value" value="${selectedId}">` : '<input type="hidden" class="adm-picker-value" value="">'}
          ${selectedId ? `<button class="adm-picker-clear" type="button">✕</button>` : ''}
        </div>
        <div class="adm-picker-dropdown" style="display:none"></div>
      </div>`;
  }

  // ── PROMOS ────────────────────────────────────────────────────────────────────
  private renderPromos(): string {
    if (this.activePromo) return this.renderPromoDetail(this.activePromo);

    const totalRedemptions = this.promos.reduce((s, p) => s + (p.redemption_count ?? p.use_count ?? 0), 0);
    const activeCount = this.promos.filter(p => p.is_active).length;

    return `
      <div class="adm-promos-layout">
        <div class="adm-card">
          <div class="adm-card-title">Создать промокод</div>
          <div class="adm-card-desc">Скидка применяется к подписке компании</div>
          <div class="adm-form">
            <div class="adm-form-row">
              <label class="adm-label">Код</label>
              <input class="adm-input adm-uppercase" id="promo-code" placeholder="SIMADESK2025">
            </div>
            <div class="adm-form-row-2">
              <div><label class="adm-label">Скидка (₽)</label><input class="adm-input" id="promo-rub" type="number" min="0" value="0"></div>
              <div><label class="adm-label">Скидка (%)</label><input class="adm-input" id="promo-pct" type="number" min="0" max="100" value="0"></div>
            </div>
            <div class="adm-form-row">
              <label class="adm-label">Описание</label>
              <input class="adm-input" id="promo-desc" placeholder="Промо для партнёров">
            </div>
            <div class="adm-form-row-2">
              <div><label class="adm-label">Действует до</label><input class="adm-input" id="promo-until" type="date"></div>
              <div><label class="adm-label">Макс. использований</label><input class="adm-input" id="promo-maxuses" type="number" min="1" placeholder="∞"></div>
            </div>
            <div class="adm-form-row-2">
              <div>
                <label class="adm-label">Срок скидки (мес.)</label>
                <input class="adm-input" id="promo-duration" type="number" min="1" placeholder="∞ бессрочно">
                <div class="adm-label" style="font-size:11px;margin-top:3px;opacity:.5">Пусто = скидка навсегда</div>
              </div>
              <div>
                <label class="adm-label">Лимит компаний</label>
                <input class="adm-input" id="promo-maxcos" type="number" min="1" placeholder="∞">
                <div class="adm-label" style="font-size:11px;margin-top:3px;opacity:.5">Пусто = без ограничений</div>
              </div>
            </div>
            <button class="adm-btn-primary" id="promo-create">Создать промокод</button>
          </div>
        </div>

        <div class="adm-promos-right">
          <div class="adm-promo-stats">
            <div class="adm-promo-stat"><div class="adm-promo-stat-val">${this.promos.length}</div><div class="adm-promo-stat-label">всего кодов</div></div>
            <div class="adm-promo-stat"><div class="adm-promo-stat-val" style="color:#22c55e">${activeCount}</div><div class="adm-promo-stat-label">активных</div></div>
            <div class="adm-promo-stat"><div class="adm-promo-stat-val" style="color:#6366f1">${totalRedemptions}</div><div class="adm-promo-stat-label">использований</div></div>
          </div>

          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>Код</th><th>Скидка</th><th>Срок скидки</th><th>Компании</th><th>Использований</th><th>Статус</th><th style="width:80px"></th></tr></thead>
              <tbody>${this.promos.length === 0
                ? `<tr><td colspan="7" class="adm-empty-cell">Промокодов пока нет — создайте первый слева</td></tr>`
                : this.promos.map(p => {
                    const used = p.redemption_count ?? p.use_count ?? 0;
                    const limit = p.max_uses;
                    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                    const expired = p.valid_until && new Date(p.valid_until) < new Date();
                    const durationLabel = p.duration_months ? `${p.duration_months} мес.` : '<span style="color:#22c55e">навсегда</span>';
                    const cosLabel = p.max_companies ? String(p.max_companies) : '∞';
                    return `
                    <tr class="adm-tr adm-tr-clickable" data-action="open-promo" data-promo-id="${p.id}">
                      <td>
                        <code class="adm-code">${this.esc(p.code)}</code>
                        ${p.description ? `<div class="adm-user-sub" style="margin-top:3px">${this.esc(p.description)}</div>` : ''}
                      </td>
                      <td style="color:#22c55e;font-weight:600;white-space:nowrap">
                        ${p.discount_rub ? `−${p.discount_rub} ₽` : ''}${p.discount_rub && p.discount_percent ? ' · ' : ''}${p.discount_percent ? `−${p.discount_percent}%` : ''}${!p.discount_rub && !p.discount_percent ? '—' : ''}
                      </td>
                      <td class="adm-td-muted">${durationLabel}</td>
                      <td class="adm-td-muted">${cosLabel}</td>
                      <td>
                        <div style="display:flex;align-items:center;gap:8px">
                          <span style="font-weight:600">${used}${limit ? `<span style="color:var(--text3);font-weight:400"> / ${limit}</span>` : ''}</span>
                          ${limit ? `<div class="adm-mini-bar"><div class="adm-mini-bar-fill" style="width:${pct}%"></div></div>` : ''}
                        </div>
                      </td>
                      <td><span class="adm-badge ${expired ? 'grey' : (p.is_active ? 'green' : 'grey')}">${expired ? 'Истёк' : (p.is_active ? 'Активен' : 'Откл.')}</span></td>
                      <td>
                        <div class="adm-actions">
                          <button class="adm-action-btn" data-action="open-promo" data-promo-id="${p.id}" title="Кто использовал">${this.ico('users')}</button>
                          <button class="adm-action-btn ${p.is_active ? 'red' : 'green'}" data-action="toggle-promo" data-promo-id="${p.id}" data-active="${p.is_active}" title="${p.is_active ? 'Отключить' : 'Включить'}">
                            ${p.is_active ? this.ico('block') : this.ico('check')}
                          </button>
                          <button class="adm-action-btn red" data-action="delete-promo" data-promo-id="${p.id}" data-promo-code="${this.esc(p.code)}" title="Удалить промокод">${this.ico('trash')}</button>
                        </div>
                      </td>
                    </tr>`;
                  }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  private renderPromoDetail(p: PromoCode): string {
    const used = p.redemption_count ?? p.use_count ?? 0;
    const rows = this.loadingRedemptions
      ? `<tr><td colspan="3" class="adm-empty-cell">Загрузка…</td></tr>`
      : this.promoRedemptions.length === 0
        ? `<tr><td colspan="3" class="adm-empty-cell">Этот промокод ещё никто не использовал</td></tr>`
        : this.promoRedemptions.map(r => {
            const av = r.photo_url
              ? `<img src="${this.esc(r.photo_url)}" class="adm-avatar-img" alt="">`
              : `<div class="adm-avatar-placeholder" style="width:30px;height:30px;font-size:12px">${(r.first_name?.[0] ?? '?').toUpperCase()}</div>`;
            return `
              <tr class="adm-tr">
                <td>
                  <div class="adm-user-cell">
                    <div class="adm-avatar" style="width:30px;height:30px">${av}</div>
                    <div>
                      <div class="adm-user-name">${this.esc((r.first_name ?? '') + ' ' + (r.last_name ?? '')) || 'Удалённый пользователь'}</div>
                      <div class="adm-user-sub">${r.telegram_username ? '@' + this.esc(r.telegram_username) : ''}</div>
                    </div>
                  </div>
                </td>
                <td class="adm-td-muted">${r.company_name ? this.esc(r.company_name) : '—'}</td>
                <td class="adm-td-muted">${adminService.fmtDate(r.redeemed_at)}</td>
              </tr>`;
          }).join('');

    return `
      <button class="adm-back-inline" id="promo-back">${this.ico('arrow-left')} Назад к промокодам</button>
      <div class="adm-promo-detail-head">
        <div>
          <code class="adm-code" style="font-size:15px;padding:4px 12px">${this.esc(p.code)}</code>
          ${p.description ? `<div class="adm-card-desc" style="margin-top:8px;margin-bottom:0">${this.esc(p.description)}</div>` : ''}
        </div>
        <div class="adm-promo-detail-meta">
          <div><span class="adm-promo-meta-val" style="color:#22c55e">${p.discount_rub ? p.discount_rub + ' ₽' : ''}${p.discount_percent ? (p.discount_rub ? ' + ' : '') + p.discount_percent + '%' : ''}</span><span class="adm-promo-meta-label">скидка</span></div>
          <div><span class="adm-promo-meta-val">${p.duration_months ? p.duration_months + ' мес.' : '<span style="color:#22c55e">навсегда</span>'}</span><span class="adm-promo-meta-label">срок скидки</span></div>
          <div><span class="adm-promo-meta-val">${used}${p.max_uses ? ' / ' + p.max_uses : ''}</span><span class="adm-promo-meta-label">использований</span></div>
          <div><span class="adm-promo-meta-val">${p.max_companies ? p.max_companies + ' комп.' : '∞'}</span><span class="adm-promo-meta-label">лимит компаний</span></div>
          <div><span class="adm-promo-meta-val">${adminService.fmtDate(p.valid_until) || '∞'}</span><span class="adm-promo-meta-label">действует до</span></div>
        </div>
      </div>
      <div class="adm-card-title" style="margin-bottom:8px">Кто использовал этот код</div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Пользователь</th><th>Компания</th><th>Когда применён</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── SUPPORT LIVE CHAT ────────────────────────────────────────────────────────
  private renderSupport(): string {
    const REASON_LABELS: Record<string, string> = {
      question: '❓ Вопрос', problem: '🚨 Проблема', billing: '💳 Оплата / тариф',
      recommendation: '💡 Предложение', feature: '🔧 Запрос функции', other: '💬 Другое',
    };
    const visibleChats = this.liveChatReasonFilter
      ? this.liveChats.filter(c => c.reason === this.liveChatReasonFilter)
      : this.liveChats;

    const chatList = visibleChats.map(c => {
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Пользователь';
      const isActive = this.activeLiveChat?.id === c.id;
      const preview = c.last_message ? this.esc(c.last_message.slice(0, 60)) : '—';
      const unreadBadge = c.unread_count > 0
        ? `<span class="adm-live-badge">${c.unread_count}</span>` : '';
      const attBadge = this.supNeedsAttention.has(c.id)
        ? `<span class="adm-live-attention" title="Нужен оператор">🔴</span>` : '';
      const aiBadge = this.supAiHandled.has(c.id) && !this.supNeedsAttention.has(c.id)
        ? `<span title="ИИ ответил" style="font-size:11px;opacity:0.6">🤖</span>` : '';
      const time = c.last_message_at ? supportChatService.fmtTime(c.last_message_at) : '';
      return `<div class="adm-live-chat-row${isActive ? ' active' : ''}" data-live-chat-id="${c.id}">
        <div class="adm-avatar-placeholder" style="width:36px;height:36px;font-size:14px;flex-shrink:0">${name[0].toUpperCase()}</div>
        <div class="adm-live-chat-row-body">
          <div class="adm-live-chat-row-head">
            <span class="adm-live-chat-name">${this.esc(name)}</span>
            ${attBadge}${aiBadge}${unreadBadge}
            <span class="adm-live-chat-time">${time}</span>
          </div>
          <div class="adm-live-chat-reason">${REASON_LABELS[c.reason] ?? c.reason}</div>
          <div class="adm-live-chat-preview">${preview}</div>
        </div>
      </div>`;
    }).join('');

    const noChats = visibleChats.length === 0
      ? `<div class="adm-live-empty">Нет чатов${this.liveChatReasonFilter ? ' по этой теме' : ''}</div>` : '';

    // Reason filter pills — only show reasons that exist in current chats
    const reasonsInUse = [...new Set(this.liveChats.map(c => c.reason))];
    const reasonPills = reasonsInUse.map(r =>
      `<button class="adm-filter-pill adm-reason-pill${this.liveChatReasonFilter === r ? ' active' : ''}" data-reason-filter="${r}" title="${REASON_LABELS[r] ?? r}">${REASON_LABELS[r]?.slice(0, 2) ?? r}</button>`
    ).join('');
    const clearPill = this.liveChatReasonFilter
      ? `<button class="adm-filter-pill adm-reason-pill active" data-reason-filter="" style="color:#ef4444;border-color:#ef444440">✕</button>` : '';

    const detail = this.activeLiveChat
      ? this.renderLiveChatDetail(this.activeLiveChat)
      : `<div class="adm-live-empty" style="flex:1">Выберите чат слева</div>`;

    const aiModels = [
      { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (быстрый, дешёвый)' },
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (умнее)' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'google/gemini-flash-1.5', label: 'Gemini Flash 1.5' },
    ];

    const errorBar = this.supError
      ? `<div class="adm-sup-error-bar">
           <span class="adm-sup-error-icon">⚠️</span>
           <div class="adm-sup-error-text">
             <b>Чаты не загрузились</b>
             <span>${this.esc(this.supError)}</span>
           </div>
           <button class="adm-btn-secondary" id="adm-sup-diag" style="padding:5px 12px;font-size:12px">Диагностика</button>
           <button class="adm-btn-secondary" id="adm-sup-retry" style="padding:5px 12px;font-size:12px">Повторить</button>
         </div>`
      : '';

    return `
    ${errorBar}
    <div class="adm-sup-ai-bar">
      <label class="adm-sup-ai-toggle" title="ИИ автоматически отвечает на очевидные вопросы. Если не уверен — помечает чат 🔴">
        <span class="adm-sup-ai-toggle-track${this.supAiEnabled ? ' on' : ''}" id="sup-ai-toggle-track">
          <span class="adm-sup-ai-toggle-thumb"></span>
        </span>
        <span class="adm-sup-ai-toggle-label">AI-автоответы</span>
      </label>
      <select class="adm-input adm-sup-ai-model-sel" id="sup-ai-model-sel" style="width:auto;padding:4px 8px;font-size:12px">
        ${aiModels.map(m => `<option value="${m.id}"${this.supAiModel === m.id ? ' selected' : ''}>${m.label}</option>`).join('')}
      </select>
      <span class="adm-sup-ai-hint">${this.supAiEnabled ? '🟢 Включено' : '⚫ Выключено'} · Нужна помощь: <b>${this.supNeedsAttention.size}</b></span>
    </div>
    <div class="adm-live-layout">
      <div class="adm-live-sidebar">
        <div class="adm-live-sidebar-head">
          <span>Чаты</span>
          <div style="display:flex;gap:4px">
            <button class="adm-filter-pill${this.liveChatFilter === 'open' ? ' active' : ''}" data-live-filter="open">Активные</button>
            <button class="adm-filter-pill${this.liveChatFilter === 'all' ? ' active' : ''}" data-live-filter="all">Все</button>
          </div>
        </div>
        ${reasonPills || clearPill ? `<div class="adm-live-reason-pills">${reasonPills}${clearPill}</div>` : ''}
        <div class="adm-live-chat-list">${chatList}${noChats}</div>
      </div>
      <div class="adm-live-detail" id="adm-live-detail">${detail}</div>
    </div>`;
  }

  private renderLiveChatDetail(c: AdminSupportChat): string {
    const REASON_LABELS: Record<string, string> = {
      question: '❓ Вопрос', problem: '🚨 Проблема', billing: '💳 Оплата / тариф',
      recommendation: '💡 Предложение', feature: '🔧 Запрос функции', other: '💬 Другое',
    };
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Пользователь';
    const msgs = (c.messages ?? []).map(m => {
      const isAdmin = m.sender_role === 'admin';
      const time = supportChatService.fmtTime(m.created_at);
      const attachHtml = (m.attachments ?? []).map(a =>
        a.kind === 'image'
          ? `<img src="${a.data}" alt="${a.name}" class="adm-live-msg-img">`
          : `<div class="adm-live-msg-file">📎 ${a.name}</div>`
      ).join('');
      return `<div class="adm-live-msg ${isAdmin ? 'admin' : 'user'}">
        <div class="adm-live-bubble">${m.content ? m.content.replace(/\n/g,'<br>') : ''}${attachHtml}</div>
        <div class="adm-live-msg-time">${isAdmin ? 'Поддержка · ' : name + ' · '}${time}</div>
      </div>`;
    }).join('');

    return `<div class="adm-live-detail-inner">
      <div class="adm-live-detail-head">
        <div class="adm-avatar-placeholder" style="width:38px;height:38px;font-size:15px;flex-shrink:0">${name[0].toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="adm-live-detail-name">${this.esc(name)}</div>
          <div class="adm-user-sub">${c.telegram_username ? '@' + this.esc(c.telegram_username) + ' · ' : ''}${c.company_name ? this.esc(c.company_name) + ' · ' : ''}${REASON_LABELS[c.reason] ?? c.reason}</div>
        </div>
        <button class="adm-btn-secondary" style="padding:5px 12px;font-size:12px;white-space:nowrap;color:#ef4444;border-color:#ef444455" id="adm-live-close-chat">Завершить диалог</button>
      </div>
      <div class="adm-live-messages" id="adm-live-messages">${msgs || '<div class="adm-live-empty" style="padding:30px">Сообщений пока нет</div>'}</div>
      <div id="adm-live-typing"></div>
      <div class="adm-live-attach-chips" id="adm-live-attach-chips"></div>
      <div class="adm-live-input-area">
        <button class="adm-live-attach-btn" id="adm-live-attach-btn" title="Прикрепить файл">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input type="file" id="adm-live-file-input" accept=".xlsx,.xls,.docx,.doc,.pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv" multiple style="display:none">
        <textarea class="adm-live-textarea" id="adm-live-textarea" placeholder="Напишите ответ…" rows="1"></textarea>
        <button class="adm-live-send-btn" id="adm-live-send-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
    </div>`;
  }

  private bindLiveChatEvents(): void {
    // Диагностика поддержки: права админа + реальные счётчики в базе
    this.el.querySelector('#adm-sup-retry')?.addEventListener('click', () => this.loadTab());
    this.el.querySelector('#adm-sup-diag')?.addEventListener('click', async () => {
      const st = await supportChatService.debugStatus();
      if (!st) {
        showToast('RPC support_debug_status недоступна — примените миграцию 20260730_support_chat_fix.sql', 'error');
        return;
      }
      const lines = [
        `Админ: ${st.is_admin ? 'да' : 'НЕТ — добавьте себя в platform_admins'}`,
        `Всего чатов: ${st.total_chats} (открытых: ${st.total_open_chats})`,
        `Всего сообщений: ${st.total_messages}`,
        `Чатов без профиля в users: ${st.orphan_chats}`,
      ];
      showToast(lines.join(' · '), st.is_admin ? 'success' : 'error');
      console.info('[Support] diagnostics', st);
    });

    // AI toggle
    const aiTrack = this.el.querySelector<HTMLElement>('#sup-ai-toggle-track');
    aiTrack?.addEventListener('click', () => {
      this.supAiEnabled = !this.supAiEnabled;
      localStorage.setItem('sd_sup_ai_enabled', this.supAiEnabled ? '1' : '0');
      aiTrack.classList.toggle('on', this.supAiEnabled);
      const hint = this.el.querySelector<HTMLElement>('.adm-sup-ai-hint');
      if (hint) hint.innerHTML = `${this.supAiEnabled ? '🟢 Включено' : '⚫ Выключено'} · Нужна помощь: <b>${this.supNeedsAttention.size}</b>`;
    });

    // AI model selector
    const modelSel = this.el.querySelector<HTMLSelectElement>('#sup-ai-model-sel');
    modelSel?.addEventListener('change', () => {
      this.supAiModel = modelSel.value;
      localStorage.setItem('sd_sup_ai_model', this.supAiModel);
    });

    // Status filter toggle
    this.el.querySelectorAll<HTMLElement>('[data-live-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.liveChatFilter = (btn.dataset.liveFilter as 'open' | 'all') ?? 'open';
        this.activeLiveChat = null;
        this.loadTab();
      });
    });

    // Reason filter pills (no reload — just filter in memory)
    this.el.querySelectorAll<HTMLElement>('[data-reason-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.liveChatReasonFilter = btn.dataset.reasonFilter || null;
        // Re-render just the sidebar without full reload
        const detail = this.el.querySelector<HTMLElement>('#adm-live-detail');
        if (detail) detail.innerHTML = this.activeLiveChat
          ? this.renderLiveChatDetail(this.activeLiveChat)
          : `<div class="adm-live-empty" style="flex:1">Выберите чат слева</div>`;
        // Full re-render of support section to update pills
        const host = this.el.querySelector<HTMLElement>('.adm-content-area');
        if (host) { host.innerHTML = this.renderSupport(); this.bindLiveChatEvents(); }
      });
    });

    // Select chat
    this.el.querySelectorAll<HTMLElement>('.adm-live-chat-row').forEach(row => {
      row.addEventListener('click', async () => {
        const id = row.dataset.liveChatId!;
        const chat = await supportChatService.adminGetChat(id);
        if (!chat) return;
        this.activeLiveChat = chat;
        this.liveChatLastMsgTime = chat.messages?.at(-1)?.created_at ?? null;
        this.liveAttachFiles = [];
        const detail = this.el.querySelector<HTMLElement>('#adm-live-detail');
        if (detail) {
          detail.innerHTML = this.renderLiveChatDetail(chat);
          this.bindLiveChatDetailEvents(detail);
          const msgs = detail.querySelector<HTMLElement>('#adm-live-messages');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }
        // Update active state in list
        this.el.querySelectorAll<HTMLElement>('.adm-live-chat-row').forEach(r =>
          r.classList.toggle('active', r.dataset.liveChatId === id));
        // Update unread count in sidebar
        const updChats = [...this.liveChats];
        const idx = updChats.findIndex(c => c.id === id);
        if (idx >= 0) { updChats[idx] = { ...updChats[idx], unread_count: 0 }; this.liveChats = updChats; }
      });
    });

    // Bind detail events if a chat is already active
    const detail = this.el.querySelector<HTMLElement>('#adm-live-detail');
    if (detail && this.activeLiveChat) this.bindLiveChatDetailEvents(detail);
  }

  private bindLiveChatDetailEvents(detail: HTMLElement): void {
    const textarea = detail.querySelector<HTMLTextAreaElement>('#adm-live-textarea');
    const sendBtn  = detail.querySelector('#adm-live-send-btn');
    const closeBtn = detail.querySelector('#adm-live-close-chat');
    const attachBtn = detail.querySelector('#adm-live-attach-btn');
    const fileInput = detail.querySelector<HTMLInputElement>('#adm-live-file-input');

    const doSend = async () => {
      if (!this.activeLiveChat || !textarea) return;
      const text = textarea.value.trim();
      if (!text && this.liveAttachFiles.length === 0) return;
      textarea.value = '';
      textarea.style.height = '';
      const snap = [...this.liveAttachFiles];
      this.liveAttachFiles = [];
      this.renderLiveAttachChips(detail);
      try {
        await supportChatService.adminSendMessage(this.activeLiveChat.id, text, snap);
        const chat = await supportChatService.adminGetChat(this.activeLiveChat.id);
        if (chat) {
          this.activeLiveChat = chat;
          this.liveChatLastMsgTime = chat.messages?.at(-1)?.created_at ?? null;
          detail.innerHTML = this.renderLiveChatDetail(chat);
          this.bindLiveChatDetailEvents(detail);
          const msgs = detail.querySelector<HTMLElement>('#adm-live-messages');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }
      } catch { showToast('Ошибка отправки', 'error'); }
    };

    textarea?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    textarea?.addEventListener('input', () => {
      if (textarea) { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'; }
      if (textarea?.value.trim()) this.signalAdminTyping();
    });
    sendBtn?.addEventListener('click', doSend);

    closeBtn?.addEventListener('click', async () => {
      if (!this.activeLiveChat) return;
      if (!confirm(`Завершить диалог с пользователем? История переписки будет удалена.`)) return;
      try {
        await supportChatService.adminCloseChat(this.activeLiveChat.id);
        this.activeLiveChat = null;
        this.liveChats = this.liveChats.filter(c => c.id !== (this.activeLiveChat as AdminSupportChat | null)?.id);
        this.loadTab();
        showToast('Диалог завершён', 'success');
      } catch { showToast('Ошибка при закрытии', 'error'); }
    });

    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      const files = Array.from(fileInput?.files ?? []);
      files.forEach(file => {
        if (file.size > 5 * 1024 * 1024) { showToast('Файл слишком большой (макс 5 МБ)', 'error'); return; }
        const reader = new FileReader();
        if (file.type.startsWith('image/')) {
          reader.onload = e => {
            this.liveAttachFiles.push({ name: file.name, kind: 'image', data: e.target?.result as string, size: file.size });
            this.renderLiveAttachChips(detail);
          };
          reader.readAsDataURL(file);
        } else {
          reader.onload = e => {
            this.liveAttachFiles.push({ name: file.name, kind: 'text', data: e.target?.result as string, size: file.size });
            this.renderLiveAttachChips(detail);
          };
          reader.readAsText(file);
        }
      });
      if (fileInput) fileInput.value = '';
    });
  }

  private renderLiveAttachChips(detail: HTMLElement): void {
    const chips = detail.querySelector('#adm-live-attach-chips');
    if (!chips) return;
    chips.innerHTML = this.liveAttachFiles.map((f, i) =>
      `<div class="adm-live-attach-chip">${f.kind === 'image' ? '🖼' : '📎'} ${f.name}
        <button class="adm-live-chip-rm" data-idx="${i}">×</button>
      </div>`
    ).join('');
    chips.querySelectorAll<HTMLElement>('.adm-live-chip-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        this.liveAttachFiles.splice(+(btn.dataset.idx!), 1);
        this.renderLiveAttachChips(detail);
      });
    });
  }

  private startLiveChatPolling(): void {
    this.stopLiveChatPolling();
    this.liveChatPollTimer = setInterval(async () => {
      if (this.tab !== 'support') { this.stopLiveChatPolling(); return; }
      try {
        // Refresh chat list
        let chats: AdminSupportChat[];
        try {
          chats = await supportChatService.adminGetChats(this.liveChatFilter);
          // Ошибка была и ушла — перерисуем вкладку, чтобы убрать баннер
          // (render() сам перевешивает обработчики через bindEvents)
          if (this.supError) { this.supError = null; this.liveChats = chats; this.render(); return; }
        } catch (e) {
          const msg = supportErrorText(e);
          if (msg !== this.supError) { this.supError = msg; this.render(); }
          return;
        }
        this.liveChats = chats;
        // Update sidebar only (don't re-render whole tab — would lose detail view state)
        const list = this.el.querySelector<HTMLElement>('.adm-live-chat-list');
        if (list) {
          const REASON_LABELS: Record<string, string> = {
            question: '❓', problem: '🚨', billing: '💳', recommendation: '💡', feature: '🔧', other: '💬',
          };
          list.innerHTML = chats.length === 0
            ? `<div class="adm-live-empty">Нет активных чатов</div>`
            : chats.map(c => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Пользователь';
                const isActive = this.activeLiveChat?.id === c.id;
                const badge = c.unread_count > 0 && !isActive
                  ? `<span class="adm-live-badge">${c.unread_count}</span>` : '';
                const time = c.last_message_at ? supportChatService.fmtTime(c.last_message_at) : '';
                return `<div class="adm-live-chat-row${isActive ? ' active' : ''}" data-live-chat-id="${c.id}">
                  <div class="adm-avatar-placeholder" style="width:36px;height:36px;font-size:14px;flex-shrink:0">${name[0].toUpperCase()}</div>
                  <div class="adm-live-chat-row-body">
                    <div class="adm-live-chat-row-head">
                      <span class="adm-live-chat-name">${this.esc(name)}</span>${badge}
                      <span class="adm-live-chat-time">${time}</span>
                    </div>
                    <div class="adm-live-chat-reason">${REASON_LABELS[c.reason] ?? c.reason}</div>
                    <div class="adm-live-chat-preview">${c.last_message ? this.esc(c.last_message.slice(0, 60)) : '—'}</div>
                  </div>
                </div>`;
              }).join('');
          // Re-bind click events on list rows
          list.querySelectorAll<HTMLElement>('.adm-live-chat-row').forEach(row => {
            row.addEventListener('click', async () => {
              const id = row.dataset.liveChatId!;
              const chat = await supportChatService.adminGetChat(id);
              if (!chat) return;
              this.activeLiveChat = chat;
              this.liveChatLastMsgTime = chat.messages?.at(-1)?.created_at ?? null;
              this.liveAttachFiles = [];
              const detail = this.el.querySelector<HTMLElement>('#adm-live-detail');
              if (detail) {
                detail.innerHTML = this.renderLiveChatDetail(chat);
                this.bindLiveChatDetailEvents(detail);
                const msgs = detail.querySelector<HTMLElement>('#adm-live-messages');
                if (msgs) msgs.scrollTop = msgs.scrollHeight;
              }
              list.querySelectorAll<HTMLElement>('.adm-live-chat-row').forEach(r =>
                r.classList.toggle('active', r.dataset.liveChatId === id));
            });
          });
        }

        // AI auto-reply: check all open chats for unanswered user messages
        if (this.supAiEnabled) {
          for (const chat of chats) {
            if (this.supAiProcessing.has(chat.id)) continue;
            // Only trigger if last message is from user
            if (chat.last_message_role !== 'user') continue;
            // Don't re-trigger if AI already replied recently
            const lastAiTime = this.supAiHandled.get(chat.id);
            if (lastAiTime && chat.last_message_at && lastAiTime >= chat.last_message_at) continue;
            // Fetch full chat to get message history
            supportChatService.adminGetChat(chat.id).then(full => {
              if (!full?.messages?.length) return;
              const msgs = full.messages;
              const lastMsg = msgs.at(-1);
              if (!lastMsg || lastMsg.sender_role !== 'user') return;
              // Check for dissatisfaction after AI reply
              if (this.supAiHandled.has(chat.id) && this.DISSATISFACTION_PATTERNS.test(lastMsg.content)) {
                this.supNeedsAttention.add(chat.id);
                this.updateAttentionBadge(chat.id);
                return;
              }
              this.runSupAiReply(chat.id, msgs);
            }).catch(() => {});
          }
        }

        // Poll new messages if a chat is open
        if (this.activeLiveChat) {
          const res = await supportChatService.poll(this.activeLiveChat.id, this.liveChatLastMsgTime);
          const newMsgs = res?.messages ?? [];
          this.renderUserTyping(!!res?.peer_typing);
          if (newMsgs.length > 0) {
            this.liveChatLastMsgTime = newMsgs.at(-1)!.created_at;
            if (!this.activeLiveChat.messages) this.activeLiveChat.messages = [];
            this.activeLiveChat.messages = [...this.activeLiveChat.messages, ...newMsgs];
            const msgsEl = this.el.querySelector<HTMLElement>('#adm-live-messages');
            if (msgsEl) {
              const REASON_LABELS: Record<string, string> = {
                question: '❓', problem: '🚨', billing: '💳', recommendation: '💡', feature: '🔧', other: '💬',
              };
              const name = [this.activeLiveChat.first_name, this.activeLiveChat.last_name].filter(Boolean).join(' ') || 'Пользователь';
              void REASON_LABELS;
              const msgsHtml = this.activeLiveChat.messages.map(m => {
                const isAdmin = m.sender_role === 'admin';
                const time = supportChatService.fmtTime(m.created_at);
                const attachHtml = (m.attachments ?? []).map(a =>
                  a.kind === 'image'
                    ? `<img src="${a.data}" alt="${a.name}" class="adm-live-msg-img">`
                    : `<div class="adm-live-msg-file">📎 ${a.name}</div>`
                ).join('');
                return `<div class="adm-live-msg ${isAdmin ? 'admin' : 'user'}">
                  <div class="adm-live-bubble">${m.content ? m.content.replace(/\n/g,'<br>') : ''}${attachHtml}</div>
                  <div class="adm-live-msg-time">${isAdmin ? 'Поддержка · ' : name + ' · '}${time}</div>
                </div>`;
              }).join('');
              msgsEl.innerHTML = msgsHtml;
              msgsEl.scrollTop = msgsEl.scrollHeight;
            }
          }
        }
      } catch { /* silently ignore poll errors */ }
    }, 3000);
  }

  private stopLiveChatPolling(): void {
    if (this.liveChatPollTimer) { clearInterval(this.liveChatPollTimer); this.liveChatPollTimer = null; }
    this.renderUserTyping(false);
  }

  /** «Пользователь печатает…» под лентой в админской переписке. */
  private renderUserTyping(typing: boolean): void {
    const host = this.el.querySelector<HTMLElement>('#adm-live-typing');
    if (!host) return;
    if (!typing) { host.innerHTML = ''; return; }
    const name = [this.activeLiveChat?.first_name, this.activeLiveChat?.last_name]
      .filter(Boolean).join(' ') || 'Пользователь';
    host.innerHTML = `<div class="adm-live-typing">
      <span class="sd-sup-typing-dots"><i></i><i></i><i></i></span>
      <span>${name} печатает…</span>
    </div>`;
  }

  // ── Support AI auto-reply ────────────────────────────────────────────────────

  private readonly SIMADESK_KNOWLEDGE = `SimaDesk — система управления маркетплейсами. Разделы:
• Обзор (Дашборд) — сводка: выручка, заказы, остатки, задачи дня
• Товары — управление карточками товаров WB/Ozon/Яндекс, цены, SEO, массовое редактирование
• Остатки (Склад) — текущие остатки по складам, планирование поставок, риски обнуления
• Заказы — все заказы с маркетплейсов в одном месте, статусы, фильтры
• Аналитика — графики продаж, выручки, прибыли; сравнение периодов; ABC-анализ
• Репрайсер — автоматическое изменение цен по правилам (конкуренты, маржа, акции)
• Отзывы — мониторинг и быстрые ответы на отзывы покупателей
• Реклама — управление рекламными кампаниями и ставками
• Задачи — планировщик задач команды
• Настройки — подключение магазинов WB/Ozon/Яндекс, API-ключи, тарифы
• Редактор (Docs) — встроенный Excel/Word редактор для работы с файлами
• Сима (ИИ-помощник) — AI-менеджер маркетплейсов, открывается кнопкой Сима

Навигация: левое боковое меню, иконки разделов. Горячие клавиши: Alt+1…9.`;

  private readonly DISSATISFACTION_PATTERNS = /не (то|так|правильно|понял|понимаю|помогло)|нет[,.]?\s*(не|это)|это не|не об этом|другой вопрос|вы не поняли|всё равно не|по-прежнему|так и не|не решил|не работает|не помогает/i;

  /** Отметить «оператор печатает» — не чаще раза в 2.5 с. */
  private supTypingSentAt = 0;

  private signalAdminTyping(): void {
    const id = this.activeLiveChat?.id;
    if (!id) return;
    const now = Date.now();
    if (now - this.supTypingSentAt < 2500) return;
    this.supTypingSentAt = now;
    void supportChatService.setTyping(id);
  }

  private async runSupAiReply(chatId: string, messages: Array<{ sender_role: string; content: string }>): Promise<void> {
    const apiKey = sessionStorage.getItem('sd_ai_key') || '';
    if (!apiKey) return;

    this.supAiProcessing.add(chatId);
    // Пока модель думает, пользователь видит «Поддержка печатает…».
    // Отметка живёт 6 с, поэтому продлеваем её каждые 3 с.
    void supportChatService.setTyping(chatId);
    const typingKeepAlive = setInterval(() => { void supportChatService.setTyping(chatId); }, 3000);
    try {
      const history = messages.slice(-8).map(m => ({
        role: m.sender_role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
      }));

      const systemPrompt = `Ты — сотрудник поддержки SimaDesk. Отвечай на русском языке, кратко и по делу.

${this.SIMADESK_KNOWLEDGE}

Правила:
1. Если вопрос очевидный (про навигацию, где найти функцию, как что-то сделать в SimaDesk) — дай подробный ответ с указанием раздела.
2. Если вопрос неоднозначный, требует доступа к данным пользователя, или ты не уверен — НЕ придумывай ответ.
3. В конце ВСЕГДА добавь на отдельной строке: [УВЕРЕН:да] или [УВЕРЕН:нет]
4. Не добавляй лишних извинений и вводных фраз. Начинай сразу с ответа.`;

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': window.location.origin,
          'X-Title': 'SimaDesk Support AI',
        },
        body: JSON.stringify({
          model: this.supAiModel,
          messages: [{ role: 'system', content: systemPrompt }, ...history],
          max_tokens: 600,
          temperature: 0.3,
        }),
      });

      if (!res.ok) return;
      const data = await res.json();
      reportAiUsage('Поддержка AI', data);
      let reply: string = data?.choices?.[0]?.message?.content ?? '';
      if (!reply) return;

      const confidentMatch = reply.match(/\[УВЕРЕН:(да|нет)\]/i);
      const confident = confidentMatch?.[1]?.toLowerCase() === 'да';
      reply = reply.replace(/\[УВЕРЕН:(да|нет)\]/gi, '').trim();

      if (confident) {
        await supportChatService.adminSendMessage(chatId, reply);
        this.supAiHandled.set(chatId, new Date().toISOString());
        this.supNeedsAttention.delete(chatId);
      } else {
        this.supNeedsAttention.add(chatId);
        this.updateAttentionBadge(chatId);
      }
    } catch { /* ignore AI errors */ } finally {
      clearInterval(typingKeepAlive);
      void supportChatService.clearTyping(chatId);
      this.supAiProcessing.delete(chatId);
    }
  }

  private updateAttentionBadge(chatId: string): void {
    const row = this.el.querySelector<HTMLElement>(`.adm-live-chat-row[data-live-chat-id="${chatId}"]`);
    if (!row) return;
    if (!row.querySelector('.adm-live-attention')) {
      row.querySelector('.adm-live-chat-row-head')?.insertAdjacentHTML('afterbegin', '<span class="adm-live-attention" title="Нужен оператор">🔴</span>');
    }
  }

  // ── SETTINGS ──────────────────────────────────────────────────────────────────
  private renderSettings(): string {
    return `
      <div class="adm-settings-grid">
        <div class="adm-card adm-settings-plans">
          <div class="adm-card-title">Тарифная шкала</div>
          <div class="adm-card-desc">Редактируйте цены и пороги оборота — цены синхронизируются на сайте /info автоматически</div>
          <div class="adm-table-wrap" style="margin-top:12px">
            <table class="adm-table">
              <thead><tr><th>Тариф</th><th>Оборот от (₽)</th><th>Оборот до (₽)</th><th>Цена/мес (₽)</th><th></th></tr></thead>
              <tbody>
                ${this.plans.length === 0
                  ? `<tr><td colspan="5" class="adm-empty-cell">Загрузка…</td></tr>`
                  : this.plans.map(p => `
                    <tr class="adm-tr" data-plan-key="${p.key}">
                      <td><span class="adm-badge" style="background:${PLAN_COLORS[p.key] ?? '#6b7280'}22;color:${PLAN_COLORS[p.key] ?? '#6b7280'}">${p.label}</span></td>
                      <td><input class="adm-input adm-input-sm" id="plan-min-${p.key}" type="number" value="${p.revenue_min}" min="0"></td>
                      <td><input class="adm-input adm-input-sm" id="plan-max-${p.key}" type="number" value="${p.revenue_max ?? ''}" placeholder="∞"></td>
                      <td><input class="adm-input adm-input-sm" id="plan-price-${p.key}" type="number" value="${p.price_rub}" min="0"></td>
                      <td>
                        <button class="adm-btn-primary" style="padding:6px 14px;font-size:12px" data-action="save-plan" data-plan="${p.key}">
                          Сохранить
                        </button>
                      </td>
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Выдать права администратора</div>
          <div class="adm-form" style="margin-top:10px">
            <div class="adm-form-row">
              <label class="adm-label">Пользователь</label>
              ${this.renderPicker('grant-user', '', '', 'Найти пользователя…')}
            </div>
            <div class="adm-form-row">
              <label class="adm-label">Роль</label>
              <select class="adm-input" id="grant-admin-role">
                <option value="support">Support — просмотр</option>
                <option value="billing">Billing — тарифы и промокоды</option>
                <option value="admin">Admin — полный доступ</option>
              </select>
            </div>
            <button class="adm-btn-primary" id="grant-admin-btn">Выдать права</button>
          </div>
        </div>

        <div class="adm-card" id="adm-ai-settings-card">
          <div class="adm-card-title">🤖 Настройки AI-ассистента (Сима)</div>
          <div class="adm-card-desc">Подключается через OpenRouter. Модель применяется для всех пользователей платформы. Ключ хранится в базе данных.</div>
          <div class="adm-form" style="margin-top:12px">
            <div class="adm-form-row">
              <label class="adm-label">OpenRouter API Key</label>
              <input class="adm-input" id="ai-key-input" type="password" placeholder="sk-or-v1-…" autocomplete="off" value="${this.getCurrentAiKey()}">
            </div>
            <div class="adm-form-row">
              <label class="adm-label">Модель</label>
              <select class="adm-input" id="ai-model-select">
                ${this.renderModelOptions()}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
              <button class="adm-btn-primary" id="save-ai-config-btn">Сохранить</button>
              <span id="ai-config-status" style="font-size:11px;color:var(--text3)"></span>
            </div>
            <div style="margin-top:10px;padding:8px 12px;background:var(--bg3);border-radius:8px;font-size:11px;color:var(--text3);line-height:1.5">
              Рекомендуемые модели: <strong>anthropic/claude-haiku-4-5</strong> (быстрый/дешёвый), <strong>anthropic/claude-sonnet-5</strong> (умный), <strong>deepseek/deepseek-chat</strong> (экономичный).<br>
              Ключ OpenRouter: <a href="https://openrouter.ai/keys" target="_blank" style="color:var(--accent)">openrouter.ai/keys</a>
            </div>
          </div>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Быстрые ссылки</div>
          <div class="adm-links" style="margin-top:10px">
            <a href="/legal.html"   target="_blank" class="adm-link-row">${this.ico('doc')}<span>Реквизиты</span>${this.ico('ext')}</a>
            <a href="/privacy.html" target="_blank" class="adm-link-row">${this.ico('doc')}<span>Политика конфиденциальности</span>${this.ico('ext')}</a>
            <a href="/offer.html"   target="_blank" class="adm-link-row">${this.ico('doc')}<span>Публичная оферта</span>${this.ico('ext')}</a>
            <a href="/info"         target="_blank" class="adm-link-row">${this.ico('credit')}<span>Страница тарифов /info</span>${this.ico('ext')}</a>
          </div>
          <div style="margin-top:12px;padding:10px 12px;background:var(--bg3);border-radius:8px;font-size:12px;color:var(--text3)">
            Для редактирования юридических страниц перейдите в раздел <button class="adm-inline-link" data-tab="pages">Редактор сайта</button>
          </div>
        </div>
      </div>`;
  }

  // ── PAGES EDITOR ─────────────────────────────────────────────────────────────
  private renderPages(): string {
    const pageKeys = ['privacy_policy', 'legal_requisites', 'offer'];
    const pageTitles: Record<string, string> = {
      privacy_policy:   'Политика конфиденциальности',
      legal_requisites: 'Реквизиты и правовая информация',
      offer:            'Публичная оферта',
    };
    const pageLinks: Record<string, string> = {
      privacy_policy:   '/privacy.html',
      legal_requisites: '/legal.html',
      offer:            '/offer.html',
    };

    const editors = pageKeys.map(key => {
      const sc = this.siteContent.find(c => c.key === key);
      const title = sc?.title ?? pageTitles[key] ?? key;
      const content = sc?.content ?? '';
      const updatedAt = sc?.updated_at ? `Изменено: ${adminService.fmtDate(sc.updated_at)}` : 'Ещё не редактировалось';
      return `
        <div class="adm-card">
          <div class="adm-page-editor-head">
            <div>
              <div class="adm-card-title">${this.esc(title)}</div>
              <div class="adm-card-desc">${updatedAt}</div>
            </div>
            <a href="${pageLinks[key] ?? '#'}" target="_blank" class="adm-btn-secondary" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;font-size:12px">${this.ico('ext')} Открыть</a>
          </div>
          <div class="adm-form" style="margin-top:10px">
            <div class="adm-form-row">
              <label class="adm-label">Заголовок страницы</label>
              <input class="adm-input" id="page-title-${key}" value="${this.esc(title)}">
            </div>
            <div class="adm-form-row">
              <label class="adm-label">Содержимое (HTML или текст)</label>
              <textarea class="adm-input adm-textarea" id="page-content-${key}" rows="10" style="font-family:monospace;font-size:12px">${this.esc(content)}</textarea>
            </div>
            <button class="adm-btn-primary" data-action="save-page" data-page-key="${key}">Сохранить страницу</button>
          </div>
        </div>`;
    });

    return `
      <div class="adm-pages-note">
        ${this.ico('doc')}
        <span>Содержимое страниц хранится в базе данных и подгружается динамически на соответствующих страницах сайта.</span>
      </div>
      <div class="adm-pages-grid">
        ${editors.join('')}
      </div>`;
  }

  private renderSkeleton(): string {
    return `
      <div class="adm-skeleton-grid">${Array(4).fill('<div class="adm-skeleton adm-skeleton-card"></div>').join('')}</div>
      <div class="adm-skeleton adm-skeleton-table"></div>`;
  }

  // ── EVENTS ────────────────────────────────────────────────────────────────────
  private bindEvents(): void {
    // Tab nav
    this.el.querySelectorAll<HTMLElement>('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab as AdminTab));
    });

    document.getElementById('adm-back')?.addEventListener('click', () => window.app?.navigateTo?.('profile'));

    // User search
    const uSearch = document.getElementById('adm-user-search') as HTMLInputElement | null;
    if (uSearch) {
      let t: ReturnType<typeof setTimeout>;
      uSearch.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { this.userSearch = uSearch.value; this.loadTab(); }, 350); });
    }

    // Company search
    const cSearch = document.getElementById('adm-company-search') as HTMLInputElement | null;
    if (cSearch) {
      let t: ReturnType<typeof setTimeout>;
      cSearch.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { this.companySearch = cSearch.value; this.loadTab(); }, 350); });
    }

    // API companies search (subscriptions tab)
    const aSearch = document.getElementById('adm-api-search') as HTMLInputElement | null;
    if (aSearch) {
      let t: ReturnType<typeof setTimeout>;
      aSearch.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { this.apiSearch = aSearch.value; this.loadTab(); }, 350); });
    }

    // API filter buttons
    this.el.querySelectorAll<HTMLElement>('[data-api-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.apiFilter = btn.dataset.apiFilter as typeof this.apiFilter;
        this.render(); this.bindEvents();
      });
    });

    // Generic data-action buttons
    this.el.querySelectorAll<HTMLElement>('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.handleAction(btn); });
    });

    // Live support chat events
    if (this.tab === 'support') this.bindLiveChatEvents();

    // Promo detail back
    document.getElementById('promo-back')?.addEventListener('click', () => { this.activePromo = null; this.render(); this.bindEvents(); });

    // Subscription forms
    document.getElementById('sub-save')?.addEventListener('click', () => this.handleSetSubscription());
    document.getElementById('trial-save')?.addEventListener('click', () => this.handleExtendTrial());

    // Roadmap filter pills
    this.el.querySelectorAll<HTMLElement>('[data-action="roadmap-filter"]').forEach(btn => {
      btn.addEventListener('click', () => this.handleRoadmapFilter(btn.dataset.filter ?? 'all'));
    });

    // Promo
    document.getElementById('promo-create')?.addEventListener('click', () => this.handleCreatePromo());
    (document.getElementById('promo-code') as HTMLInputElement | null)?.addEventListener('input', (e) => {
      (e.target as HTMLInputElement).value = (e.target as HTMLInputElement).value.toUpperCase();
    });

    // Grant admin
    document.getElementById('grant-admin-btn')?.addEventListener('click', () => this.handleGrantAdmin());

    // AI config
    document.getElementById('save-ai-config-btn')?.addEventListener('click', () => this.handleSaveAiConfig());

    // Inline tab links (e.g. "Редактор сайта" link in settings)
    this.el.querySelectorAll<HTMLElement>('.adm-inline-link[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab as AdminTab));
    });

    // Pickers
    this.el.querySelectorAll<HTMLElement>('.adm-picker').forEach(picker => this.bindPickerEvents(picker));
  }

  // ── PICKER ────────────────────────────────────────────────────────────────────
  private bindPickerEvents(picker: HTMLElement): void {
    const kind = picker.dataset.picker ?? '';
    const input = picker.querySelector<HTMLInputElement>('.adm-picker-input');
    const hidden = picker.querySelector<HTMLInputElement>('.adm-picker-value');
    const dropdown = picker.querySelector<HTMLElement>('.adm-picker-dropdown');
    const clearBtn = picker.querySelector<HTMLElement>('.adm-picker-clear');
    if (!input || !hidden || !dropdown) return;

    clearBtn?.addEventListener('click', () => {
      hidden.value = ''; input.value = '';
      if (kind === 'user' || kind === 'company') {
        this.picker = kind === 'user'
          ? { ...this.picker, userId: '', userName: '' }
          : { ...this.picker, companyId: '', companyName: '' };
      }
      clearBtn.remove();
    });

    let t: ReturnType<typeof setTimeout>;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => this.fetchPickerResults(kind, input.value, dropdown, hidden, input), 250);
    });

    input.addEventListener('focus', () => {
      if (!input.value) this.fetchPickerResults(kind, '', dropdown, hidden, input);
    });

    const closeOnOutside = (e: MouseEvent) => {
      if (!picker.contains(e.target as Node)) dropdown.style.display = 'none';
    };
    document.addEventListener('click', closeOnOutside);
    this._pickerCleanups.push(() => document.removeEventListener('click', closeOnOutside));
  }

  private async fetchPickerResults(
    kind: string, q: string,
    dropdown: HTMLElement, hidden: HTMLInputElement, input: HTMLInputElement,
  ): Promise<void> {
    const isUser = kind === 'user' || kind === 'trial-user' || kind === 'grant-user';
    let html = '';

    if (isUser) {
      const items = await adminService.searchUsers(q);
      if (items.length === 0) { dropdown.innerHTML = '<div class="adm-picker-empty">Не найдено</div>'; }
      else {
        html = items.map(u => `
          <div class="adm-picker-item" data-id="${u.id}" data-name="${this.esc(u.first_name + ' ' + (u.last_name ?? ''))}">
            <div class="adm-avatar" style="width:28px;height:28px;flex-shrink:0">
              ${u.photo_url ? `<img src="${this.esc(u.photo_url)}" class="adm-avatar-img" alt="">` : `<div class="adm-avatar-placeholder" style="width:28px;height:28px;font-size:11px">${(u.first_name?.[0] ?? '?').toUpperCase()}</div>`}
            </div>
            <div>
              <div style="font-size:13px;font-weight:500">${this.esc(u.first_name)} ${this.esc(u.last_name ?? '')}</div>
              <div style="font-size:11px;color:var(--text3)">${u.telegram_username ? '@' + this.esc(u.telegram_username) : ''} · ${u.company_count} компаний</div>
            </div>
          </div>`).join('');
      }
    } else {
      const items = await adminService.searchCompanies(q);
      if (items.length === 0) { dropdown.innerHTML = '<div class="adm-picker-empty">Не найдено</div>'; }
      else {
        html = items.map(c => `
          <div class="adm-picker-item" data-id="${c.id}" data-name="${this.esc(c.name)}">
            <div class="adm-company-logo-placeholder" style="width:28px;height:28px;border-radius:6px;font-size:11px;background:${c.color ?? '#6366f1'};flex-shrink:0">${(c.name?.[0] ?? '?').toUpperCase()}</div>
            <div>
              <div style="font-size:13px;font-weight:500">${this.esc(c.name)}</div>
              <div style="font-size:11px;color:var(--text3)">${c.owner_first_name ? this.esc(c.owner_first_name) + ' · ' : ''}${c.member_count} участников</div>
            </div>
          </div>`).join('');
      }
    }

    dropdown.innerHTML = html;
    dropdown.style.display = 'block';

    dropdown.querySelectorAll<HTMLElement>('.adm-picker-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id ?? '';
        const name = item.dataset.name ?? '';
        hidden.value = id;
        input.value = name;
        dropdown.style.display = 'none';

        if (kind === 'user')    this.picker = { ...this.picker, userId: id, userName: name };
        if (kind === 'company') this.picker = { ...this.picker, companyId: id, companyName: name };
      });
    });
  }

  // ── ACTION HANDLERS ───────────────────────────────────────────────────────────
  private async handleAction(btn: HTMLElement): Promise<void> {
    const action   = btn.dataset.action;
    const uid      = btn.dataset.uid;
    const promoId  = btn.dataset.promoId;
    const cid      = btn.dataset.cid;
    const cname    = btn.dataset.cname;
    const planKey  = btn.dataset.plan;

    if (action === 'revoke-role' && uid) { await this.handleRevokeRole(uid); return; }

    if (action === 'delete-user' && uid) {
      const uname = btn.dataset.uname ?? uid;
      const msg = `Полностью удалить пользователя «${uname}»?\n\nВсе данные (членство в компаниях, подписки, обращения) будут удалены. Если пользователь имеет права администратора — они будут отозваны.\n\nЭто действие нельзя отменить.`;
      if (!confirm(msg)) return;
      try {
        await adminService.deleteUser(uid);
        showToast(`Пользователь «${uname}» удалён`, 'success');
        this.loadTab();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'неизвестная ошибка'), 'error'); }
      return;
    }

    if (action === 'ban' && uid) {
      if (!confirm('Заблокировать пользователя на 30 дней?')) return;
      const until = new Date(); until.setDate(until.getDate() + 30);
      await adminService.banUser(uid, until);
      showToast('Пользователь заблокирован', 'success');
      this.loadTab();
    }
    if (action === 'unban' && uid) {
      await adminService.banUser(uid, null);
      showToast('Блокировка снята', 'success');
      this.loadTab();
    }
    if (action === 'extend-trial' && uid) {
      const days = parseInt(prompt('Продлить пробный период на сколько дней?', '14') ?? '0', 10);
      if (!days || isNaN(days)) return;
      await adminService.extendTrial(uid, days);
      showToast(`Пробный период продлён на ${days} дней`, 'success');
      this.loadTab();
    }
    if (action === 'toggle-promo' && promoId) {
      const active = btn.dataset.active === 'true';
      await adminService.togglePromo(promoId, !active);
      showToast(active ? 'Промокод отключён' : 'Промокод включён', 'success');
      this.loadTab();
    }
    if (action === 'delete-promo' && promoId) {
      const code = btn.dataset.promoCode ?? promoId;
      if (!confirm(`Удалить промокод «${code}»?\n\nВсе записи об использовании будут удалены. Это действие нельзя отменить.`)) return;
      try {
        await adminService.deletePromo(promoId);
        showToast(`Промокод «${code}» удалён`, 'success');
        this.loadTab();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? ''), 'error'); }
    }
    if (action === 'set-trial-days' && uid) {
      const input = btn.closest('td')?.querySelector('.adm-trial-input') as HTMLInputElement | null;
      const days = parseInt(input?.value ?? '0', 10);
      if (!days || isNaN(days) || days < 1) { showToast('Введите корректное число дней', 'error'); return; }
      try {
        await adminService.extendTrial(uid, days);
        showToast(`Триал установлен: ${days} дн.`, 'success');
        this.loadTab();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? ''), 'error'); }
    }
    if (action === 'delete-company' && cid) {
      if (!confirm(`Удалить компанию «${cname}»?\n\nЭто действие нельзя отменить. Все данные компании будут удалены.`)) return;
      try {
        await adminService.deleteCompany(cid);
        showToast(`Компания «${cname}» удалена`, 'success');
        this.loadTab();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'неизвестная ошибка'), 'error'); }
    }

    // Quick +30 days to subscription
    if (action === 'quick-extend' && cid) {
      const co = this.apiCompanies.find(c => c.id === cid);
      const label = co ? `«${co.name}»` : '';
      try {
        await adminService.extendSubscription(cid, 30);
        showToast(`Подписка ${label} продлена на 30 дней`, 'success');
        this.apiCompanies = await adminService.getCompaniesWithApi(this.apiSearch);
        this.render(); this.bindEvents();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? e.message : String(e)) ?? ''), 'error'); }
    }

    // Open inline day-editor
    if (action === 'edit-extend' && cid) {
      this.inlineEdit = this.inlineEdit === cid ? null : cid;
      this.render(); this.bindEvents();
    }

    // Cancel inline editor
    if (action === 'cancel-extend') {
      this.inlineEdit = null;
      this.render(); this.bindEvents();
    }

    // Confirm inline extension — date input takes priority over days offset
    if (action === 'confirm-extend' && cid) {
      const dateInput = document.getElementById(`inline-date-${cid}`) as HTMLInputElement | null;
      const daysInput = document.getElementById(`inline-days-${cid}`) as HTMLInputElement | null;
      const co = this.apiCompanies.find(c => c.id === cid);

      let endDateISO: string | null = null;
      let toastMsg = '';

      const daysVal = parseInt(daysInput?.value ?? '0', 10);
      const dateVal = dateInput?.value ?? '';

      if (daysVal !== 0 && !isNaN(daysVal)) {
        // Relative: compute new end from current end (or now) ± days
        const currentEnd = co?.subscription?.current_period_end ?? co?.owner_trial_ends_at ?? null;
        const base = currentEnd ? new Date(currentEnd).getTime() : Date.now();
        endDateISO = new Date(base + daysVal * 86_400_000).toISOString();
        toastMsg = `Подписка «${co?.name ?? ''}» ${daysVal > 0 ? `продлена на ${daysVal} дн.` : `сокращена на ${Math.abs(daysVal)} дн.`}`;
      } else if (dateVal) {
        // Absolute date
        endDateISO = new Date(dateVal + 'T23:59:59').toISOString();
        toastMsg = `Дата окончания подписки «${co?.name ?? ''}» установлена на ${new Date(dateVal).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`;
      } else {
        showToast('Укажите дату или количество дней', 'error');
        return;
      }

      try {
        await adminService.setSubscriptionEnd(cid, endDateISO);
        showToast(toastMsg, 'success');
        this.inlineEdit = null;
        this.apiCompanies = await adminService.getCompaniesWithApi(this.apiSearch);
        this.render(); this.bindEvents();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? e.message : String(e)) ?? ''), 'error'); }
    }
    if (action === 'save-plan' && planKey) {
      const price = parseInt((document.getElementById(`plan-price-${planKey}`) as HTMLInputElement)?.value ?? '0', 10);
      const min   = parseInt((document.getElementById(`plan-min-${planKey}`) as HTMLInputElement)?.value ?? '0', 10);
      const maxEl = (document.getElementById(`plan-max-${planKey}`) as HTMLInputElement)?.value;
      const max   = maxEl ? parseInt(maxEl, 10) : null;
      try {
        await adminService.updatePlan(planKey, price, min, max);
        showToast('Тариф обновлён', 'success');
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? ''), 'error'); }
    }
    if (action === 'save-page') {
      const key = btn.dataset.pageKey ?? '';
      if (!key) return;
      const title   = (document.getElementById(`page-title-${key}`) as HTMLInputElement)?.value?.trim() ?? '';
      const content = (document.getElementById(`page-content-${key}`) as HTMLTextAreaElement)?.value ?? '';
      try {
        await adminService.saveSiteContent(key, title, content);
        showToast('Страница сохранена', 'success');
        this.siteContent = await adminService.getSiteContent();
        this.render();
      } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? ''), 'error'); }
      return;
    }

    if (action === 'open-promo') {
      const id = btn.closest<HTMLElement>('[data-promo-id]')?.dataset.promoId ?? promoId;
      const p = this.promos.find(p => p.id === id);
      if (p) { await this.openPromo(p); }
    }

    // Roadmap actions
    if (action === 'roadmap-new')     { this.handleRoadmapNew(); return; }
    if (action === 'roadmap-cancel')  { this.handleRoadmapCancel(); return; }
    if (action === 'roadmap-save')    { await this.handleRoadmapSave(); return; }
    if (action === 'roadmap-edit')    { this.handleRoadmapEdit(btn.dataset.taskId ?? ''); return; }
    if (action === 'roadmap-delete')  { await this.handleRoadmapDelete(btn.dataset.taskId ?? ''); return; }
    if (action === 'roadmap-dedup')   { await this.handleRoadmapDedup(); return; }
  }

  private async openPromo(p: PromoCode): Promise<void> {
    this.activePromo = p;
    this.loadingRedemptions = true;
    this.promoRedemptions = [];
    this.render();
    this.promoRedemptions = await adminService.getPromoRedemptions(p.id);
    this.loadingRedemptions = false;
    // Only re-render if still viewing this promo
    if (this.activePromo?.id === p.id) this.render();
  }


  private async handleSetSubscription(): Promise<void> {
    const uid      = this.picker.userId;
    const cid      = this.picker.companyId;
    const planEl   = document.getElementById('sub-plan') as HTMLSelectElement;
    const months   = parseInt((document.getElementById('sub-months') as HTMLInputElement)?.value ?? '1', 10);
    if (!uid) { showToast('Выберите пользователя', 'error'); return; }
    if (!cid) { showToast('Выберите компанию', 'error'); return; }
    const plan = this.plans.find(p => p.key === planEl.value) ?? this.plans[0];
    if (!plan) { showToast('Выберите тариф', 'error'); return; }
    try {
      await adminService.setSubscription(uid, cid, plan.key, plan.price_rub, months);
      showToast(`Подписка «${plan.label}» назначена`, 'success');
      this.picker = { userId: '', userName: '', companyId: '', companyName: '' };
    } catch (e: unknown) { showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? ''), 'error'); }
  }

  private async handleExtendTrial(): Promise<void> {
    const trialPicker = this.el.querySelector<HTMLElement>('[data-picker="trial-user"]');
    const uid   = trialPicker?.querySelector<HTMLInputElement>('.adm-picker-value')?.value ?? '';
    const days  = parseInt((document.getElementById('trial-days') as HTMLInputElement)?.value ?? '14', 10);
    if (!uid) { showToast('Выберите пользователя', 'error'); return; }
    await adminService.extendTrial(uid, days);
    showToast(`Пробный период продлён на ${days} дней`, 'success');
  }

  private async handleCreatePromo(): Promise<void> {
    const code     = (document.getElementById('promo-code') as HTMLInputElement)?.value?.trim().toUpperCase();
    const rub      = parseInt((document.getElementById('promo-rub') as HTMLInputElement)?.value ?? '0', 10);
    const pct      = parseInt((document.getElementById('promo-pct') as HTMLInputElement)?.value ?? '0', 10);
    const desc     = (document.getElementById('promo-desc') as HTMLInputElement)?.value?.trim() ?? '';
    const until    = (document.getElementById('promo-until') as HTMLInputElement)?.value || null;
    const maxU     = parseInt((document.getElementById('promo-maxuses') as HTMLInputElement)?.value ?? '', 10);
    const durM     = parseInt((document.getElementById('promo-duration') as HTMLInputElement)?.value ?? '', 10);
    const maxCos   = parseInt((document.getElementById('promo-maxcos') as HTMLInputElement)?.value ?? '', 10);
    if (!code) { showToast('Введите код промокода', 'error'); return; }
    const result = await adminService.createPromo(
      code, rub, pct, desc, until,
      isNaN(maxU) ? null : maxU,
      isNaN(durM) ? null : durM,
      isNaN(maxCos) ? null : maxCos,
    );
    if (result) { showToast('Промокод создан: ' + result.code, 'success'); this.loadTab(); }
    else showToast('Ошибка создания промокода', 'error');
  }

  private async handleGrantAdmin(): Promise<void> {
    const grantPicker = this.el.querySelector<HTMLElement>('[data-picker="grant-user"]');
    const uid  = grantPicker?.querySelector<HTMLInputElement>('.adm-picker-value')?.value ?? '';
    const name = grantPicker?.querySelector<HTMLInputElement>('.adm-picker-input')?.value ?? '';
    const role = (document.getElementById('grant-admin-role') as HTMLSelectElement)?.value ?? 'admin';
    if (!uid) { showToast('Выберите пользователя', 'error'); return; }
    try {
      await adminService.grantRole(uid, role);
      showToast(`${name || uid} теперь ${role}`, 'success');
      this.loadTab();
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка: только суперадмин может назначать роли', 'error');
    }
  }

  private async handleRevokeRole(uid: string): Promise<void> {
    if (!uid) return;
    if (!confirm('Отозвать права администратора у этого пользователя?')) return;
    try {
      await adminService.revokeRole(uid);
      showToast('Права отозваны', 'success');
      this.loadTab();
    } catch (e: unknown) {
      showToast((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка при отзыве прав', 'error');
    }
  }

  // ── UTILS ─────────────────────────────────────────────────────────────────────
  private esc(s: string | null | undefined): string {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── AI ASSISTANT CONFIG ───────────────────────────────────────────────────────

  private getCurrentAiKey(): string {
    return (window as any).sdAssistantModule?.aiKey || sessionStorage.getItem('sd_ai_key') || '';
  }

  private renderModelOptions(): string {
    const current = localStorage.getItem('sd_ai_model') || 'anthropic/claude-haiku-4-5';
    const models = [
      { id: 'anthropic/claude-haiku-4-5',    label: 'Claude Haiku 4.5 — быстрый / дешёвый' },
      { id: 'anthropic/claude-sonnet-5',     label: 'Claude Sonnet 5 — умный / точный' },
      { id: 'anthropic/claude-opus-4-8',     label: 'Claude Opus 4.8 — максимальный' },
      { id: 'deepseek/deepseek-chat',        label: 'DeepSeek Chat — экономичный' },
      { id: 'google/gemini-2.5-flash',       label: 'Gemini 2.5 Flash — быстрый' },
      { id: 'openai/gpt-4o-mini',            label: 'GPT-4o Mini — дешёвый' },
      { id: 'openai/gpt-4o',                 label: 'GPT-4o — мощный' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B — бесплатный' },
    ];
    return models.map(m => `<option value="${m.id}"${m.id === current ? ' selected' : ''}>${m.label}</option>`).join('');
  }

  private async handleSaveAiConfig(): Promise<void> {
    const key   = (document.getElementById('ai-key-input') as HTMLInputElement)?.value.trim() ?? '';
    const model = (document.getElementById('ai-model-select') as HTMLSelectElement)?.value ?? '';
    const status = document.getElementById('ai-config-status');

    if (!key) { if (status) { status.textContent = '⚠ Введите API-ключ'; status.style.color = '#f59e0b'; } return; }
    if (!model) { if (status) { status.textContent = '⚠ Выберите модель'; status.style.color = '#f59e0b'; } return; }

    if (status) { status.textContent = 'Сохраняю…'; status.style.color = 'var(--text3)'; }

    try {
      // Save to site_content via admin RPC
      await adminService.saveSiteContent('ai_openrouter_key', 'AI OpenRouter Key', key);
      await adminService.saveSiteContent('ai_model', 'AI Model', model);

      // Cache model (not sensitive) locally; key goes to session storage only
      sessionStorage.setItem('sd_ai_key', key);
      localStorage.setItem('sd_ai_model', model);

      // Notify the running assistant module
      window.dispatchEvent(new CustomEvent('sd_ai_config_updated'));
      (window as any).sdAssistantModule?.updateConfig(key, model);

      if (status) { status.textContent = '✓ Сохранено'; status.style.color = '#22c55e'; }
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    } catch (err: unknown) {
      if (status) { status.textContent = `Ошибка: ${(err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) ?? 'неизвестно'}`; status.style.color = '#ef4444'; }
    }
  }

  // ── ROADMAP ──────────────────────────────────────────────────────────────────
  private renderRoadmap(): string {
    const quadrants: Quadrant[] = ['urgent_important', 'important_not_urgent', 'urgent_not_important', 'not_urgent_not_important'];
    const statuses: RoadmapStatus[] = ['todo', 'in_progress', 'done'];

    const filtered = this.roadmapFilter === 'all'
      ? this.roadmapTasks
      : this.roadmapTasks.filter(t => t.quadrant === this.roadmapFilter);

    // Detect duplicates (same title, case-insensitive)
    const titleCount = new Map<string, number>();
    for (const t of this.roadmapTasks) {
      const key = t.title.trim().toLowerCase();
      titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
    }
    const dupCount = [...titleCount.values()].filter(n => n > 1).length;

    const STATUS_META: Record<RoadmapStatus, { label: string; color: string; bg: string; border: string }> = {
      todo:        { label: 'К выполнению', color: '#6b7280', bg: 'rgba(107,114,128,.08)', border: '#6b728033' },
      in_progress: { label: 'В работе',     color: '#3b82f6', bg: 'rgba(59,130,246,.08)',  border: '#3b82f633' },
      done:        { label: 'Готово',        color: '#22c55e', bg: 'rgba(34,197,94,.08)',   border: '#22c55e33' },
    };

    const renderCard = (t: RoadmapTask) => {
      const qColor = QUADRANT_COLORS[t.quadrant];
      const isDup  = (titleCount.get(t.title.trim().toLowerCase()) ?? 0) > 1;
      return `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:13px 14px;display:flex;flex-direction:column;gap:9px;transition:box-shadow .15s"
           onmouseenter="this.style.boxShadow='0 2px 10px rgba(0,0,0,.12)'" onmouseleave="this.style.boxShadow=''">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="width:7px;height:7px;border-radius:50%;background:${qColor};flex-shrink:0"></span>
          <span style="font-size:10px;color:${qColor};font-weight:700;text-transform:uppercase;letter-spacing:.4px">${QUADRANT_LABELS[t.quadrant]}</span>
          ${isDup ? `<span style="margin-left:auto;font-size:10px;font-weight:700;color:#ef4444;background:rgba(239,68,68,.1);padding:1px 7px;border-radius:20px">дубликат</span>` : ''}
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text);line-height:1.4">${this.esc(t.title)}</div>
        ${t.description ? `<div style="font-size:12px;color:var(--text2);line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${this.esc(t.description)}</div>` : ''}
        <div style="display:flex;gap:6px;padding-top:8px;border-top:1px solid var(--border)">
          <button class="adm-btn-sm" data-action="roadmap-edit" data-task-id="${t.id}" style="flex:1;justify-content:center">Редактировать</button>
          <button class="adm-btn-sm" data-action="roadmap-delete" data-task-id="${t.id}" style="color:#ef4444;padding:4px 8px">✕</button>
        </div>
      </div>`;
    };

    const kanban = statuses.map(status => {
      const cards = filtered.filter(t => t.status === status);
      const m = STATUS_META[status];
      return `
      <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:2px solid ${m.color}">
          <div style="width:9px;height:9px;border-radius:50%;background:${m.color}"></div>
          <span style="font-size:13px;font-weight:700;color:var(--text)">${m.label}</span>
          <span style="font-size:11px;font-weight:800;color:${m.color};background:${m.bg};border:1px solid ${m.border};padding:1px 9px;border-radius:20px;margin-left:auto">${cards.length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${cards.length
            ? cards.map(renderCard).join('')
            : `<div style="background:var(--bg2);border:1px dashed var(--border);border-radius:10px;padding:22px 14px;text-align:center;color:var(--text3);font-size:12px">Нет задач</div>`}
        </div>
      </div>`;
    }).join('');

    const dupBanner = dupCount > 0 ? `
      <div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:10px;padding:11px 16px;display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <span style="font-size:14px">⚠️</span>
        <span style="font-size:13px;color:var(--text);flex:1">Обнаружено <b>${dupCount}</b> групп задач с одинаковым названием — вероятно, дубликаты.</span>
        <button class="adm-btn-sm" data-action="roadmap-dedup" style="color:#ef4444;white-space:nowrap">Удалить дубликаты</button>
      </div>` : '';

    const filterBtns: Array<{ key: string; label: string; color?: string }> = [
      { key: 'all', label: 'Все' },
      ...quadrants.map(q => ({ key: q, label: QUADRANT_LABELS[q], color: QUADRANT_COLORS[q] })),
    ];

    const form = this.roadmapFormOpen ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px">
        <div style="font-weight:700;font-size:14px;margin-bottom:16px;display:flex;align-items:center;gap:8px">
          <span>${this.roadmapEditing ? '✏️ Редактировать задачу' : '➕ Новая задача'}</span>
        </div>
        <div style="display:grid;gap:14px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px">Заголовок *</label>
            <input id="rm-title" type="text" value="${this.esc(this.roadmapForm.title)}"
              placeholder="Что нужно сделать?"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;outline:none" />
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px">Описание</label>
            <textarea id="rm-desc" rows="3" placeholder="Подробности, ссылки, контекст…"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;resize:vertical;font-family:inherit">${this.esc(this.roadmapForm.description)}</textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px">Приоритет (квадрант)</label>
              <select id="rm-quadrant"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box">
                ${quadrants.map(q => `<option value="${q}" ${this.roadmapForm.quadrant === q ? 'selected' : ''}>${QUADRANT_LABELS[q]}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px">Статус</label>
              <select id="rm-status"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box">
                ${(Object.keys(STATUS_LABELS) as RoadmapStatus[]).map(s => `<option value="${s}" ${this.roadmapForm.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;padding-top:4px">
            <button class="adm-btn-sm" data-action="roadmap-cancel" style="padding:8px 16px">Отмена</button>
            <button class="adm-btn-sm" data-action="roadmap-save" style="background:var(--accent);color:#0a0a0a;font-weight:700;padding:8px 20px;border-color:var(--accent)">
              ${this.roadmapEditing ? 'Сохранить изменения' : 'Создать задачу'}
            </button>
          </div>
        </div>
      </div>` : '';

    const totalAll   = this.roadmapTasks.length;
    const totalShown = filtered.length;

    return `
      <div>
        ${dupBanner}
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
          <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
            ${filterBtns.map(f => `
              <button class="adm-pill ${this.roadmapFilter === f.key ? 'active' : ''}" data-action="roadmap-filter" data-filter="${f.key}">
                ${f.color ? `<span style="width:7px;height:7px;border-radius:50%;background:${f.color};display:inline-block;flex-shrink:0"></span>` : ''}
                ${f.label}
              </button>`).join('')}
            <span style="font-size:11px;color:var(--text3);margin-left:4px">${totalShown !== totalAll ? `${totalShown} / ` : ''}${totalAll} задач</span>
          </div>
          <button class="adm-btn-sm" data-action="roadmap-new" style="background:var(--accent);color:#0a0a0a;font-weight:700;padding:7px 16px;border-color:var(--accent)">
            + Новая задача
          </button>
        </div>
        ${form}
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-items:start">
          ${kanban}
        </div>
      </div>`;
  }

  private handleRoadmapFilter(key: string): void {
    this.roadmapFilter = key as Quadrant | 'all';
    this.render(); this.bindEvents();
  }

  private handleRoadmapNew(): void {
    this.roadmapFormOpen = true;
    this.roadmapEditing = null;
    this.roadmapForm = { title: '', description: '', quadrant: 'important_not_urgent', status: 'todo' };
    this.render(); this.bindEvents();
    (document.getElementById('rm-title') as HTMLInputElement)?.focus();
  }

  private handleRoadmapEdit(id: string): void {
    const t = this.roadmapTasks.find(x => x.id === id);
    if (!t) return;
    this.roadmapFormOpen = true;
    this.roadmapEditing = t;
    this.roadmapForm = { title: t.title, description: t.description, quadrant: t.quadrant, status: t.status };
    this.render(); this.bindEvents();
    (document.getElementById('rm-title') as HTMLInputElement)?.focus();
  }

  private handleRoadmapCancel(): void {
    this.roadmapFormOpen = false;
    this.roadmapEditing = null;
    this.render(); this.bindEvents();
  }

  private async handleRoadmapSave(): Promise<void> {
    const title = (document.getElementById('rm-title') as HTMLInputElement)?.value?.trim();
    const description = (document.getElementById('rm-desc') as HTMLTextAreaElement)?.value?.trim() ?? '';
    const quadrant = (document.getElementById('rm-quadrant') as HTMLSelectElement)?.value as Quadrant;
    const status = (document.getElementById('rm-status') as HTMLSelectElement)?.value as RoadmapStatus;
    if (!title) { showToast('Введите заголовок', 'error'); return; }

    try {
      if (this.roadmapEditing) {
        await roadmapDb.updateTask(this.roadmapEditing.id, { title, description, quadrant, status });
        showToast('Задача обновлена', 'success');
      } else {
        const maxOrder = this.roadmapTasks.reduce((m, t) => Math.max(m, t.sort_order), 0);
        await roadmapDb.createTask({ title, description, quadrant, status, sort_order: maxOrder + 1 });
        showToast('Задача создана', 'success');
      }
      this.roadmapFormOpen = false;
      this.roadmapEditing = null;
      this.loadTab();
    } catch (e: unknown) {
      showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'неизвестная'), 'error');
    }
  }

  private async handleRoadmapDelete(id: string): Promise<void> {
    if (!confirm('Удалить задачу?')) return;
    try {
      await roadmapDb.deleteTask(id);
      showToast('Задача удалена', 'success');
      this.loadTab();
    } catch (e: unknown) {
      showToast('Ошибка: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'неизвестная'), 'error');
    }
  }

  private async handleRoadmapDedup(): Promise<void> {
    const seen = new Map<string, string>(); // normalized title → first id
    const toDelete: string[] = [];
    for (const t of this.roadmapTasks) {
      const key = t.title.trim().toLowerCase();
      if (seen.has(key)) {
        toDelete.push(t.id);
      } else {
        seen.set(key, t.id);
      }
    }
    if (!toDelete.length) { showToast('Дубликатов не найдено', 'info'); return; }
    if (!confirm(`Удалить ${toDelete.length} дубликат(ов)? Останется по одной задаче каждого названия.`)) return;
    try {
      await Promise.all(toDelete.map(id => roadmapDb.deleteTask(id)));
      showToast(`Удалено ${toDelete.length} дубликатов`, 'success');
      this.loadTab();
    } catch (e: unknown) {
      showToast('Ошибка: ' + ((e instanceof Error ? e.message : String(e)) ?? 'неизвестная'), 'error');
    }
  }

  private ico(name: string): string {
    const M: Record<string, string> = {
      grid:        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
      users:       `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      build:       `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
      credit:      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
      tag:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
      chat:        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
      cog:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>`,
      chart:       `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
      search:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
      clock:       `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
      block:       `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
      check:       `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
      trash:       `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
      ruble:       `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h8a4 4 0 0 1 0 8H6zm0 8h10M6 16h10M6 20h4"/></svg>`,
      doc:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
      ext:         `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
      'arrow-left':`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`,
      'arrow-right':`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`,
    };
    return M[name] ?? '';
  }
}
