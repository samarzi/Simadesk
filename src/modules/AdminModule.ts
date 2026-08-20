/**
 * Админ-панель SimaDesk (v5).
 *
 * Полный пересмотр структуры под реальные задачи управления платформой:
 * плоское меню из 10 разделов (без групп, без сворачивания, без командной
 * палитры — просто клик по пункту), с явным разделением того, что раньше
 * было смешано:
 *  • Дашборд — сводные показатели и графики роста
 *  • Пользователи / Компании — управление аккаунтами
 *  • Тарифы — тарифная шкала и цены пакетов AI (было частью «Настроек»)
 *  • Подписки — назначение/продление доступа по компаниям
 *  • Промокоды — скидочные коды
 *  • Бухгалтерия — новый раздел: доход платформы (MRR, ARPU), доход по
 *    тарифам, ближайшие продления, эффект промокодов. Считается только из
 *    реальных данных (активные подписки, их фактическая цена), без выдумок —
 *    отдельной таблицы платежей ЮKassa в БД нет, есть только последний
 *    статус подписки на компанию.
 *  • Поддержка — живой чат с AI-автоответами
 *  • Настройки — права администраторов, AI-ассистент, аккаунты проверяющих,
 *    страницы сайта
 *  • Дорожная карта — внутренний трекер задач разработки
 * Серверная логика (RPC, поддержка, AI-автоответы) не менялась.
 */

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
import { AI_BOOST_PACKAGES, setAiBoostPriceOverrides } from '@/services/aiTokenQuota';
import { icon } from './admin/icons';
import { areaChart, groupedBars, hBars, donut } from './admin/charts';

type AdminTab =
  | 'overview' | 'users' | 'companies' | 'plans' | 'subscriptions'
  | 'promos' | 'accounting' | 'support' | 'settings' | 'roadmap' | 'news' | 'brain'
  | 'notifications';

interface TabMeta { title: string; desc: string; icon: string }

const TABS: AdminTab[] = [
  'overview', 'users', 'companies', 'plans', 'subscriptions',
  'promos', 'accounting', 'support', 'notifications', 'settings', 'roadmap', 'news', 'brain',
];

const TAB_META: Record<AdminTab, TabMeta> = {
  overview:      { title: 'Дашборд',       icon: 'dashboard', desc: 'Ключевые показатели и динамика роста платформы' },
  users:         { title: 'Пользователи',  icon: 'users',     desc: 'Все зарегистрированные аккаунты, блокировки и пробный период' },
  companies:     { title: 'Компании',      icon: 'building',  desc: 'Организации на платформе, их оборот и подписки' },
  plans:         { title: 'Тарифы',        icon: 'card',      desc: 'Тарифная шкала и цены пакетов AI-токенов' },
  subscriptions: { title: 'Подписки',      icon: 'calendar',  desc: 'Назначение тарифов и продление доступа по компаниям' },
  promos:        { title: 'Промокоды',     icon: 'tag',       desc: 'Создание скидочных кодов и статистика их использования' },
  accounting:    { title: 'Бухгалтерия',   icon: 'ruble',     desc: 'Доход платформы, ближайшие продления, эффект промокодов' },
  support:       { title: 'Поддержка',     icon: 'chat',      desc: 'Обращения пользователей, живой чат и AI-автоответы' },
  settings:      { title: 'Настройки',     icon: 'settings',  desc: 'Права администраторов, AI-ассистент и страницы сайта' },
  roadmap:       { title: 'Дорожная карта', icon: 'roadmap',  desc: 'Задачи разработки: приоритеты, статусы и дедупликация' },
  news:          { title: 'Новости МП',    icon: 'news',      desc: 'Telegram-каналы для сбора новостей маркетплейсов' },
  brain:         { title: 'Мозг Симы',    icon: 'brain',     desc: 'База знаний о маркетплейсах, которую Сима использует в ответах' },
  notifications: { title: 'Уведомления',  icon: 'bell',      desc: 'Отправка уведомлений пользователям — системные, подарки токенов, алерты' },
};

const PLAN_COLORS: Record<string, string> = {
  free: '#64748b', starter: '#3b82f6', business: '#6366f1', pro: '#8b5cf6', max: '#f59e0b',
};
const PLAN_LABELS: Record<string, string> = {
  free: 'Бесплатно', starter: 'Старт', business: 'Бизнес', pro: 'Про', max: 'Макс',
};

const ROLE_META: Record<string, { label: string; color: string }> = {
  superadmin: { label: 'Создатель',      color: '#ef4444' },
  admin:      { label: 'Администратор',  color: '#6366f1' },
  support:    { label: 'Поддержка',      color: '#3b82f6' },
  billing:    { label: 'Биллинг',        color: '#f59e0b' },
};

const REASON_META: Record<string, { label: string; icon: string; color: string }> = {
  question:       { label: 'Вопрос',          icon: 'help',   color: '#3b82f6' },
  problem:        { label: 'Проблема',        icon: 'warn',   color: '#ef4444' },
  billing:        { label: 'Оплата / тариф',  icon: 'card',   color: '#f59e0b' },
  recommendation: { label: 'Предложение',     icon: 'bulb',   color: '#8b5cf6' },
  feature:        { label: 'Запрос функции',  icon: 'wrench', color: '#10b981' },
  other:          { label: 'Другое',          icon: 'chat',   color: '#64748b' },
};

const C = { indigo: '#6366f1', blue: '#3b82f6', violet: '#8b5cf6', amber: '#f59e0b', emerald: '#10b981', rose: '#ef4444' };

const LS_TAB = 'sd_adm_tab';

interface PickerState { userId: string; userName: string; companyId: string; companyName: string }

export class AdminModule {
  private el: HTMLElement;
  private tab: AdminTab = 'overview';
  private loading = false;
  private role = 'admin';

  /* дашборд */
  private stats: AdminStats | null = null;
  private analytics: AnalyticsData | null = null;

  /* пользователи */
  private users: AdminUser[] = [];
  private usersTotal = 0;
  private userSearch = '';

  /* компании */
  private companies: AdminCompany[] = [];
  private companiesTotal = 0;
  private companySearch = '';

  /* тарифы */
  private plans: PlanConfig[] = [];
  private aiBoostPrices: Record<string, number> = {};

  /* подписки */
  private apiCompanies: AdminCompanyWithApi[] = [];
  private apiSearch = '';
  private apiFilter: 'all' | 'active' | 'trial' | 'expired' = 'all';
  private inlineEdit: string | null = null;
  private picker: PickerState = { userId: '', userName: '', companyId: '', companyName: '' };
  private _cleanups: Array<() => void> = [];

  /* промокоды */
  private promos: PromoCode[] = [];
  private promoRedemptions: PromoRedemption[] = [];
  private activePromo: PromoCode | null = null;
  private loadingRedemptions = false;

  /* настройки */
  private siteContent: SiteContent[] = [];
  private platformAdmins: AnalyticsData['admins'] = [];

  /* поддержка — живой чат */
  private liveChats: AdminSupportChat[] = [];
  private activeLiveChat: AdminSupportChat | null = null;
  private liveChatPollTimer: ReturnType<typeof setInterval> | null = null;
  private liveChatLastMsgTime: string | null = null;
  private liveAttachFiles: SupportAttachment[] = [];
  private liveChatFilter: 'open' | 'all' = 'open';
  private liveChatReasonFilter: string | null = null;
  private supError: string | null = null;

  private supAiEnabled: boolean = localStorage.getItem('sd_sup_ai_enabled') === '1';
  private supAiModel: string = localStorage.getItem('sd_sup_ai_model') || 'anthropic/claude-haiku-4-5';
  private supNeedsAttention: Set<string> = new Set();
  private supAiProcessing: Set<string> = new Set();
  private supAiHandled: Map<string, string> = new Map();
  private supAdminMode: 'ai' | 'manual' = 'ai';
  private supAiRespondingFor: string | null = null;
  private supBatchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // chatId → timestamp when greeting was sent (ms)
  private supGreeted: Map<string, number> = new Map();
  private supTypingSentAt = 0;

  /* дорожная карта */
  private roadmapTasks: RoadmapTask[] = [];
  private roadmapFilter: Quadrant | 'all' = 'all';
  private roadmapFormOpen = false;
  private roadmapEditing: RoadmapTask | null = null;
  private roadmapForm: { title: string; description: string; quadrant: Quadrant; status: RoadmapStatus } =
    { title: '', description: '', quadrant: 'important_not_urgent', status: 'todo' };

  /* новости МП */
  private newsChannels: Array<{ id: string; mp: string; channel_slug: string; label: string; enabled: boolean }> = [];
  private newsItems: Array<{ id: string; mp: string; title: string; summary: string; is_important: boolean; published_at: string; source_url?: string; attachments?: Array<{ id: string; file_url: string; file_type: string; file_name?: string }> }> = [];
  private newsLoading = false;
  private newsManualAdd = false;

  /* мозг Симы */
  private brainEntries: Array<{ id: string; mp: string; category: string; title: string; content: string; keywords: string[]; updated_at: string }> = [];
  private brainUpdating = false;
  private brainFilter = { mp: '', category: '' };
  private simaConfigEntries: Array<{ id: string; key: string; title: string; description?: string; value: string; is_active: boolean; updated_at: string }> = [];
  private simaConfigTab: 'memory' | 'files' = 'memory';

  /* уведомления */
  private adminNotifications: import('@/services/notificationsService').UserNotification[] = [];
  private notifSending = false;

  constructor(el: HTMLElement) { this.el = el; }

  // ── ЖИЗНЕННЫЙ ЦИКЛ ──────────────────────────────────────────────────────

  show(): void {
    this.el.style.display = 'block';
    const saved = localStorage.getItem(LS_TAB) as AdminTab | null;
    this.tab = saved && TABS.includes(saved) ? saved : 'overview';
    this.activeLiveChat = null;
    this.activePromo = null;
    this.render();
    adminService.checkAdmin().then(r => { if (r.role) { this.role = r.role; this.render(); } });
    this.loadTab();
  }

  hide(): void {
    this.el.style.display = 'none';
    this.stopLiveChatPolling();
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];
  }

  private setTab(tab: AdminTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    localStorage.setItem(LS_TAB, tab);
    this.inlineEdit = null;
    this.loadTab();
  }

  private async loadTab(): Promise<void> {
    this.loading = true;
    this.activeLiveChat = null;
    this.activePromo = null;
    if (this.tab !== 'support') this.stopLiveChatPolling();
    this.render();
    try {
      switch (this.tab) {
        case 'overview': {
          const [stats, analytics] = await Promise.all([adminService.getStats(), adminService.getAnalytics()]);
          this.stats = stats; this.analytics = analytics; break;
        }
        case 'users': {
          const r = await adminService.getUsers(this.userSearch);
          this.users = r.users; this.usersTotal = r.total; break;
        }
        case 'companies': {
          const r = await adminService.getCompanies(this.companySearch);
          this.companies = r.companies; this.companiesTotal = r.total; break;
        }
        case 'plans': {
          const [plans, prices] = await Promise.all([adminService.getPlanConfigs(), adminService.getAiBoostPrices()]);
          this.plans = plans; this.aiBoostPrices = prices; break;
        }
        case 'subscriptions': {
          const [plans, apiCos] = await Promise.all([
            adminService.getPlanConfigs(),
            adminService.getCompaniesWithApi(this.apiSearch),
          ]);
          this.plans = plans; this.apiCompanies = apiCos; break;
        }
        case 'promos': this.promos = await adminService.getPromos(); break;
        case 'accounting': {
          const [stats, apiCos, promos] = await Promise.all([
            adminService.getStats(),
            adminService.getCompaniesWithApi(''),
            adminService.getPromos(),
          ]);
          this.stats = stats; this.apiCompanies = apiCos; this.promos = promos; break;
        }
        case 'support': {
          // Ошибку списка чатов показываем внутри вкладки, а не роняем весь loadTab —
          // иначе админ видит пустой экран и не понимает, что RPC недоступна.
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
        case 'settings': {
          const [content, analytics] = await Promise.all([adminService.getSiteContent(), adminService.getAnalytics()]);
          this.siteContent = content;
          this.platformAdmins = analytics?.admins ?? [];
          break;
        }
        case 'roadmap': this.roadmapTasks = await roadmapDb.getTasks(); break;
        case 'news': await this.loadNewsData(); break;
        case 'brain': await this.loadBrainData(); break;
        case 'notifications': {
          const { adminFetchAllNotifications } = await import('@/services/notificationsService');
          this.adminNotifications = await adminFetchAllNotifications();
          break;
        }
      }
    } catch (e: unknown) {
      debug.warn('[Admin] loadTab error:', e);
      showToast(this.errText(e, 'Ошибка загрузки данных'), 'error');
    }
    this.loading = false;
    this.render();
  }

  // ── ОБОЛОЧКА ────────────────────────────────────────────────────────────

  private render(): void {
    this._cleanups.forEach(fn => fn());
    this._cleanups = [];
    const flush = this.tab === 'support' && !this.loading;
    this.el.innerHTML = `
      <div class="ap">
        ${this.renderSidebar()}
        <div class="ap-main">
          ${this.renderTopbar()}
          <div class="ap-content${flush ? ' is-flush' : ''}" id="ap-content">
            ${this.loading ? this.renderSkeleton() : this.renderTabContent()}
          </div>
        </div>
      </div>`;
    this.bindEvents();
  }

  private renderSidebar(): string {
    const openTickets = this.stats?.open_tickets ?? 0;
    const items = TABS.map(id => {
      const m = TAB_META[id];
      const badge = id === 'support' && openTickets > 0 ? `<span class="ap-nav-badge">${openTickets}</span>` : '';
      return `
        <button class="ap-nav-item${this.tab === id ? ' active' : ''}" data-tab="${id}">
          ${icon(m.icon, 17)}<span>${m.title}</span>${badge}
        </button>`;
    }).join('');

    const u = authService.getUser();
    const name = u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || 'Администратор' : 'Администратор';
    const rm = ROLE_META[this.role] ?? { label: this.role, color: '#64748b' };

    return `
      <aside class="ap-rail">
        <div class="ap-brand">
          <div class="ap-brand-mark">${icon('shield', 18, 2)}</div>
          <div class="ap-brand-text">
            <div class="ap-brand-title">SimaDesk</div>
            <div class="ap-brand-sub">Админ-панель</div>
          </div>
        </div>
        <nav class="ap-nav">${items}</nav>
        <div class="ap-rail-foot">
          <div class="ap-identity">
            ${this.avatar(u?.photo_url ?? null, u?.first_name ?? 'A', 'sm')}
            <div class="ap-identity-body">
              <div class="ap-identity-name">${this.esc(name)}</div>
              <div class="ap-identity-role" style="color:${rm.color}">${rm.label}</div>
            </div>
          </div>
          <button class="ap-foot-btn" id="ap-exit">${icon('logout', 15)}<span>Выйти из панели</span></button>
        </div>
      </aside>`;
  }

  private renderTopbar(): string {
    const m = TAB_META[this.tab];
    return `
      <header class="ap-topbar">
        <div class="ap-topbar-text">
          <h1>${m.title}</h1>
          <div class="ap-topbar-desc">${m.desc}</div>
        </div>
        <button class="ap-btn" id="ap-refresh" title="Обновить данные раздела">${icon('refresh', 15)}<span>Обновить</span></button>
      </header>`;
  }

  private renderTabContent(): string {
    switch (this.tab) {
      case 'overview':      return this.renderOverview();
      case 'users':         return this.renderUsers();
      case 'companies':     return this.renderCompanies();
      case 'plans':         return this.renderPlans();
      case 'subscriptions': return this.renderSubscriptions();
      case 'promos':        return this.renderPromos();
      case 'accounting':    return this.renderAccounting();
      case 'support':       return this.renderSupport();
      case 'settings':      return this.renderSettings();
      case 'roadmap':       return this.renderRoadmap();
      case 'news':          return this.renderNews();
      case 'brain':         return this.renderBrain();
      case 'notifications': return this.renderNotifications();
    }
  }

  private renderSkeleton(): string {
    return `
      <div class="ap-skel-kpis">${Array(4).fill('<div class="ap-skel ap-skel-kpi"></div>').join('')}</div>
      <div class="ap-skel ap-skel-block"></div>`;
  }

  // ── ДАШБОРД ─────────────────────────────────────────────────────────────

  private renderOverview(): string {
    if (!this.stats && !this.analytics) {
      return this.emptyState('alert', 'Данные недоступны', 'Не удалось загрузить сводку. Нажмите «Обновить».');
    }

    const s = this.stats;
    const kpiSection = s ? `
      <div class="ap-kpis">
        ${[
          { label: 'Пользователи',      value: s.total_users.toLocaleString('ru'),     icon: 'users',    color: C.indigo,  sub: `+${s.new_users_7d} за 7 дней` },
          { label: 'Компании',          value: s.total_companies.toLocaleString('ru'), icon: 'building', color: C.blue,    sub: 'всего активных' },
          { label: 'Активных подписок', value: s.active_subs.toLocaleString('ru'),     icon: 'card',     color: C.emerald, sub: `${s.trial_users} на пробном` },
          { label: 'MRR',               value: adminService.fmtMoney(s.mrr),           icon: 'ruble',    color: C.amber,   sub: `+${s.new_users_30d} пользователей/мес` },
        ].map(k => `
          <div class="ap-kpi" style="--kpi-color:${k.color}">
            <div class="ap-kpi-top">
              <div class="ap-kpi-icon">${icon(k.icon, 16)}</div>
              <div class="ap-kpi-label">${k.label}</div>
            </div>
            <div class="ap-kpi-value">${k.value}</div>
            <div class="ap-kpi-sub">${k.sub}</div>
          </div>`).join('')}
        <div class="ap-kpi" style="--kpi-color:${C.emerald}">
          <div class="ap-kpi-top">
            <div class="ap-kpi-icon">${icon('zap', 16)}</div>
            <div class="ap-kpi-label">Баланс OpenRouter</div>
          </div>
          <div class="ap-kpi-value" data-or-balance style="font-size:18px">${icon('zap', 15)} …</div>
          <div class="ap-kpi-sub">AI API · текущий остаток</div>
        </div>
      </div>
      <div class="ap-grid-2">
        <div class="ap-card">
          <div class="ap-card-title">Активность платформы</div>
          <div style="margin-top:8px">
            ${this.statRow('Новых за 7 дней',    s.new_users_7d,  C.indigo)}
            ${this.statRow('Новых за 30 дней',   s.new_users_30d, C.blue)}
            ${this.statRow('На пробном периоде', s.trial_users,   C.amber)}
            ${this.statRow('Заблокировано',      s.banned_users,  C.rose)}
            ${this.statRow('Открытых обращений', s.open_tickets,  C.violet)}
          </div>
        </div>
        <div class="ap-card">
          <div class="ap-card-title">Быстрые действия</div>
          <button class="ap-quick" data-tab="users">${icon('users', 16)}<span>Пользователи</span></button>
          <button class="ap-quick" data-tab="companies">${icon('building', 16)}<span>Компании</span></button>
          <button class="ap-quick" data-tab="subscriptions">${icon('calendar', 16)}<span>Продлить подписку</span></button>
          <button class="ap-quick" data-tab="accounting">${icon('ruble', 16)}<span>Бухгалтерия и доход</span></button>
          <button class="ap-quick" data-tab="support">${icon('chat', 16)}<span>Обращения в поддержку</span>${s.open_tickets > 0 ? `<span class="ap-nav-badge">${s.open_tickets}</span>` : ''}</button>
        </div>
      </div>` : `<div class="ap-banner error">${icon('warn', 18)}<div class="ap-banner-body">Не удалось загрузить статистику.</div></div>`;

    const a = this.analytics;
    const chartsSection = a ? this.renderDashboardCharts(a) : `<div class="ap-banner error" style="margin-top:16px">${icon('warn', 18)}<div class="ap-banner-body">Не удалось загрузить графики.</div></div>`;

    return kpiSection + chartsSection;
  }

  private statRow(label: string, value: number, color: string): string {
    return `<div class="ap-stat-row">
      <span class="ap-dot" style="background:${color}"></span>
      <span class="ap-stat-label">${label}</span>
      <span class="ap-stat-val" style="color:${color}">${value.toLocaleString('ru')}</span>
    </div>`;
  }

  private renderDashboardCharts(a: AnalyticsData): string {
    const newUsers30 = a.users_by_day.reduce((s, d) => s + d.count, 0);

    return `
      <div class="ap-section-title">Динамика за 30 дней</div>
      <div class="ap-charts">
        <div class="ap-card ap-span-2">
          <div class="ap-chart-head">
            <div>
              <div class="ap-card-title">Рост пользователей</div>
              <div class="ap-card-desc">Накопительно · +${newUsers30} новых</div>
            </div>
          </div>
          <div class="ap-chart">${areaChart(a.users_by_day, a.total_users, C.indigo, 'apGradUsers')}</div>
        </div>

        <div class="ap-card ap-span-2">
          <div class="ap-chart-head">
            <div>
              <div class="ap-card-title">Ежедневная активность</div>
              <div class="ap-card-desc">Новые регистрации и компании по дням</div>
            </div>
            <div class="ap-legend">
              <i style="background:${C.indigo}"></i> Пользователи
              <i style="background:${C.blue};margin-left:8px"></i> Компании
            </div>
          </div>
          <div class="ap-chart">${groupedBars(a.users_by_day, a.companies_by_day, C.indigo, C.blue)}</div>
        </div>

        <div class="ap-card">
          <div class="ap-card-title">Топ клиентов по обороту</div>
          <div class="ap-card-desc">Оборот продавцов на маркетплейсах (не доход SimaDesk)</div>
          <div class="ap-chart">${hBars(a.revenue_by_company, C.emerald, n => adminService.fmt(n))}</div>
        </div>

        <div class="ap-card">
          <div class="ap-card-title">Распределение по тарифам</div>
          ${donut(a.plans_dist, PLAN_COLORS, PLAN_LABELS)}
        </div>
      </div>`;
  }

  // ── ПОЛЬЗОВАТЕЛИ ────────────────────────────────────────────────────────

  private renderUsers(): string {
    return `
      <div class="ap-toolbar">
        <div class="ap-search">${icon('search', 15)}<input id="ap-user-search" placeholder="Имя, фамилия или @username…" value="${this.esc(this.userSearch)}"></div>
        <div class="ap-toolbar-info">${this.usersTotal.toLocaleString('ru')} пользователей</div>
      </div>
      <div class="ap-table-wrap">
        <table class="ap-table">
          <thead><tr>
            <th>Пользователь</th><th>Регистрация</th><th>Последний вход</th>
            <th class="ap-td-center">Компании</th><th>Тариф</th><th>Статус</th><th>Пробный период</th><th style="width:76px"></th>
          </tr></thead>
          <tbody>${this.users.length === 0
            ? `<tr><td colspan="8" class="ap-empty-cell">${this.userSearch ? 'Никто не найден по этому запросу' : 'Нет пользователей'}</td></tr>`
            : this.users.map(u => this.renderUserRow(u)).join('')}</tbody>
        </table>
      </div>`;
  }

  private renderUserRow(u: AdminUser): string {
    const isBanned = !!u.banned_until && new Date(u.banned_until) > new Date();
    const trialActive = !!u.trial_ends_at && new Date(u.trial_ends_at) > new Date();
    const daysLeft = u.trial_days_left ?? 0;
    const isSuperadmin = u.admin_role === 'superadmin';

    let planBadge: string;
    if (u.subscription?.status === 'active') {
      const col = PLAN_COLORS[u.subscription.plan_key] ?? C.indigo;
      planBadge = `<span class="ap-badge" style="background:color-mix(in srgb, ${col} 16%, transparent);color:${col}">${PLAN_LABELS[u.subscription.plan_key] ?? u.subscription.plan_key}</span>`;
    } else if (trialActive) planBadge = '<span class="ap-badge violet">Пробный</span>';
    else planBadge = '<span class="ap-badge grey">—</span>';

    const status = isBanned
      ? `<span class="ap-badge red" title="Заблокирован до ${adminService.fmtDate(u.banned_until)}">Бан</span>`
      : trialActive ? `<span class="ap-badge amber">Пробный</span>`
      : u.subscription?.status === 'active' ? `<span class="ap-badge green">Активен</span>`
      : `<span class="ap-badge grey">Без подписки</span>`;

    const trialCell = trialActive
      ? `<div style="display:flex;align-items:center;gap:6px">
           <input class="ap-input ap-input-sm ap-trial-input" type="number" min="1" max="365" value="${daysLeft}" data-uid="${u.id}" style="width:66px" title="Количество дней">
           <button class="ap-icon-btn sm ok" data-action="set-trial-days" data-uid="${u.id}" title="Сохранить количество дней">${icon('check', 14)}</button>
         </div>`
      : `<button class="ap-btn ap-btn-sm" data-action="extend-trial" data-uid="${u.id}">Выдать</button>`;

    const roleBadge = u.admin_role
      ? (() => { const rm = ROLE_META[u.admin_role!] ?? { label: u.admin_role!, color: '#64748b' };
          return `<span class="ap-badge" style="background:color-mix(in srgb, ${rm.color} 16%, transparent);color:${rm.color};font-size:10px;padding:1px 7px">${rm.label}</span>`; })()
      : '';

    return `
      <tr class="ap-tr">
        <td>
          <div class="ap-ident">
            ${this.avatar(u.photo_url, u.first_name)}
            <div class="ap-ident-body">
              <div class="ap-ident-name">${this.esc(u.first_name)} ${this.esc(u.last_name ?? '')}${roleBadge}</div>
              <div class="ap-ident-sub">${u.telegram_username ? '@' + this.esc(u.telegram_username) : '—'}</div>
            </div>
          </div>
        </td>
        <td class="ap-td-muted">${adminService.fmtDate(u.created_at)}</td>
        <td class="ap-td-muted">${adminService.fmtDate(u.last_login_at)}</td>
        <td class="ap-td-center">${u.company_count}</td>
        <td>${planBadge}</td>
        <td>${status}</td>
        <td>${trialCell}</td>
        <td>
          <div class="ap-row-actions">
            <button class="ap-icon-btn sm ${isBanned ? 'ok' : 'danger'}" data-action="${isBanned ? 'unban' : 'ban'}" data-uid="${u.id}" title="${isBanned ? 'Снять блокировку' : 'Заблокировать на 30 дней'}">
              ${isBanned ? icon('check', 14) : icon('ban', 14)}
            </button>
            ${!isSuperadmin ? `<button class="ap-icon-btn sm danger" data-action="delete-user" data-uid="${u.id}" data-uname="${this.esc(u.first_name + ' ' + (u.last_name ?? ''))}" title="Удалить пользователя">${icon('trash', 14)}</button>` : ''}
          </div>
        </td>
      </tr>`;
  }

  // ── КОМПАНИИ ────────────────────────────────────────────────────────────

  private renderCompanies(): string {
    return `
      <div class="ap-toolbar">
        <div class="ap-search">${icon('search', 15)}<input id="ap-company-search" placeholder="Название компании или ИНН…" value="${this.esc(this.companySearch)}"></div>
        <div class="ap-toolbar-info">${this.companiesTotal.toLocaleString('ru')} компаний</div>
      </div>
      <div class="ap-table-wrap">
        <table class="ap-table">
          <thead><tr>
            <th>Компания</th><th>Владелец</th><th>Создана</th>
            <th class="ap-td-center">Участников</th><th>Оборот / 30 дн.</th><th>Тариф</th><th style="width:52px"></th>
          </tr></thead>
          <tbody>${this.companies.length === 0
            ? `<tr><td colspan="7" class="ap-empty-cell">${this.companySearch ? 'Ничего не найдено' : 'Нет компаний'}</td></tr>`
            : this.companies.map(c => this.renderCompanyRow(c)).join('')}</tbody>
        </table>
      </div>`;
  }

  private renderCompanyRow(c: AdminCompany): string {
    const sub = c.subscription;
    const col = sub ? (PLAN_COLORS[sub.plan_key] ?? C.indigo) : null;
    const planBadge = sub && col
      ? `<span class="ap-badge" style="background:color-mix(in srgb, ${col} 16%, transparent);color:${col}">${PLAN_LABELS[sub.plan_key] ?? sub.plan_key}</span>`
      : `<span class="ap-badge grey">—</span>`;
    return `
      <tr class="ap-tr">
        <td>
          <div class="ap-ident">
            ${this.companyLogo(c.logo_url, c.name, c.color)}
            <div class="ap-ident-body">
              <div class="ap-ident-name">${this.esc(c.name)}</div>
              <div class="ap-ident-sub">${c.inn ? 'ИНН ' + this.esc(c.inn) : '—'}</div>
            </div>
          </div>
        </td>
        <td class="ap-td-muted">
          ${c.owner_first_name ? this.esc(`${c.owner_first_name} ${c.owner_last_name ?? ''}`.trim()) : '—'}
          ${c.owner_username ? `<div class="ap-ident-sub">@${this.esc(c.owner_username)}</div>` : ''}
        </td>
        <td class="ap-td-muted">${adminService.fmtDate(c.created_at)}</td>
        <td class="ap-td-center">${c.member_count}</td>
        <td style="font-weight:${c.monthly_revenue > 0 ? 650 : 400};color:${c.monthly_revenue > 0 ? 'var(--text)' : 'var(--text3)'}">
          ${c.monthly_revenue > 0 ? adminService.fmtMoney(c.monthly_revenue) : '—'}
        </td>
        <td>${planBadge}</td>
        <td><button class="ap-icon-btn sm danger" data-action="delete-company" data-cid="${c.id}" data-cname="${this.esc(c.name)}" title="Удалить компанию">${icon('trash', 14)}</button></td>
      </tr>`;
  }

  // ── ТАРИФЫ ──────────────────────────────────────────────────────────────

  private renderPlans(): string {
    return `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="ap-card">
          <div class="ap-card-title">Тарифная шкала</div>
          <div class="ap-card-desc">Цены и пороги оборота. Изменения синхронизируются на странице /info автоматически.</div>
          <div class="ap-table-wrap" style="margin-top:14px">
            <table class="ap-table">
              <thead><tr><th>Тариф</th><th>Оборот от, ₽</th><th>Оборот до, ₽</th><th>Цена/мес, ₽</th><th style="width:120px"></th></tr></thead>
              <tbody>${this.plans.length === 0
                ? `<tr><td colspan="5" class="ap-empty-cell">Загрузка…</td></tr>`
                : this.plans.map(p => {
                    const col = PLAN_COLORS[p.key] ?? '#64748b';
                    return `<tr class="ap-tr">
                      <td><span class="ap-badge" style="background:color-mix(in srgb, ${col} 16%, transparent);color:${col}">${this.esc(p.label)}</span></td>
                      <td><input class="ap-input ap-input-sm" id="plan-min-${p.key}" type="number" value="${p.revenue_min}" min="0"></td>
                      <td><input class="ap-input ap-input-sm" id="plan-max-${p.key}" type="number" value="${p.revenue_max ?? ''}" placeholder="без предела"></td>
                      <td><input class="ap-input ap-input-sm" id="plan-price-${p.key}" type="number" value="${p.price_rub}" min="0"></td>
                      <td><button class="ap-btn ap-btn-primary ap-btn-sm" data-action="save-plan" data-plan="${p.key}">Сохранить</button></td>
                    </tr>`;
                  }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="ap-card">
          <div class="ap-card-title">Цены пакетов AI-токенов</div>
          <div class="ap-card-desc">Сохраняются в Supabase и сразу отображаются на странице «Тариф и оплата».</div>
          <div class="ap-table-wrap" style="margin-top:14px">
            <table class="ap-table">
              <thead><tr><th>Пакет</th><th>Токенов/день</th><th>Цена/мес, ₽</th><th style="width:110px"></th></tr></thead>
              <tbody>${AI_BOOST_PACKAGES.map(pkg => {
                const price = this.aiBoostPrices[pkg.key] ?? pkg.priceRub;
                const dayK = Math.round(pkg.tokensPerDay / 1000);
                return `<tr class="ap-tr">
                  <td><span class="ap-badge violet">${this.esc(pkg.label)}</span></td>
                  <td class="ap-td-muted">${dayK.toLocaleString('ru')}К</td>
                  <td><input class="ap-input ap-input-sm" id="ai-boost-price-${pkg.key}" type="number" value="${price}" min="0" style="width:100px"></td>
                  <td><button class="ap-btn ap-btn-primary ap-btn-sm" data-action="save-ai-boost-price" data-pkg="${pkg.key}">Сохранить</button></td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </div>

        <div class="ap-link-row" style="max-width:340px">
          ${icon('external', 15)}
          <a href="/info" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;flex:1">Открыть страницу тарифов /info</a>
        </div>
      </div>`;
  }

  // ── ПОДПИСКИ ────────────────────────────────────────────────────────────

  private renderSubscriptions(): string {
    const now = Date.now();
    const labels: Record<string, string> = { all: 'Все', active: 'Активные', trial: 'Пробный', expired: 'Без доступа' };
    const filterBtns = (['all', 'active', 'trial', 'expired'] as const)
      .map(f => `<button class="${this.apiFilter === f ? 'active' : ''}" data-api-filter="${f}">${labels[f]}</button>`).join('');

    const visible = this.apiCompanies.filter(c => {
      const sub = c.subscription;
      const hasActive = sub?.status === 'active' && !!sub.current_period_end && new Date(sub.current_period_end).getTime() > now;
      const hasTrial = !!c.owner_trial_ends_at && new Date(c.owner_trial_ends_at).getTime() > now;
      if (this.apiFilter === 'active') return hasActive;
      if (this.apiFilter === 'trial') return !hasActive && hasTrial;
      if (this.apiFilter === 'expired') return !hasActive && !hasTrial;
      return true;
    });

    return `
      <div class="ap-subs">
        <div>
          <div class="ap-toolbar">
            <div class="ap-search">${icon('search', 15)}<input id="ap-api-search" placeholder="Компания или владелец…" value="${this.esc(this.apiSearch)}"></div>
            <div class="ap-segment">${filterBtns}</div>
            <div class="ap-toolbar-info">${visible.length} из ${this.apiCompanies.length}</div>
          </div>
          <div class="ap-table-wrap">
            <table class="ap-table">
              <thead><tr>
                <th>Компания</th><th>Владелец</th><th>API</th><th>Статус доступа</th><th>Действует до</th><th style="width:104px"></th>
              </tr></thead>
              <tbody>${visible.length === 0
                ? `<tr><td colspan="6" class="ap-empty-cell">Нет компаний по выбранному фильтру</td></tr>`
                : visible.map(c => this.renderApiCompanyRow(c, now)).join('')}</tbody>
            </table>
          </div>
        </div>

        <div class="ap-subs-forms">
          <div class="ap-card">
            <div class="ap-card-title">Назначить подписку</div>
            <div class="ap-card-desc">Выберите пользователя и компанию — подписка будет создана или обновлена.</div>
            <div class="ap-form">
              <div class="ap-field">
                <label class="ap-label">Пользователь</label>
                ${this.renderPicker('user', this.picker.userId, this.picker.userName, 'Найти пользователя…')}
              </div>
              <div class="ap-field">
                <label class="ap-label">Компания</label>
                ${this.renderPicker('company', this.picker.companyId, this.picker.companyName, 'Найти компанию…')}
              </div>
              <div class="ap-form-2">
                <div class="ap-field">
                  <label class="ap-label">Тариф</label>
                  <select class="ap-select" id="sub-plan">
                    ${this.plans.map(p => `<option value="${p.key}">${p.label} — ${p.price_rub === 0 ? 'Бесплатно' : p.price_rub.toLocaleString('ru') + ' ₽'}</option>`).join('')}
                  </select>
                </div>
                <div class="ap-field">
                  <label class="ap-label">Месяцев</label>
                  <input class="ap-input" id="sub-months" type="number" min="1" max="24" value="1">
                </div>
              </div>
              <button class="ap-btn ap-btn-primary" id="sub-save">Назначить подписку</button>
            </div>
          </div>

          <div class="ap-card">
            <div class="ap-card-title">Продлить пробный период</div>
            <div class="ap-form">
              <div class="ap-field">
                <label class="ap-label">Пользователь</label>
                ${this.renderPicker('trial-user', '', '', 'Найти пользователя…')}
              </div>
              <div class="ap-field">
                <label class="ap-label">Количество дней</label>
                <input class="ap-input" id="trial-days" type="number" min="1" max="365" value="14">
              </div>
              <button class="ap-btn ap-btn-primary" id="trial-save">Продлить</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  private renderApiCompanyRow(c: AdminCompanyWithApi, now: number): string {
    const sub = c.subscription;
    const hasActive = sub?.status === 'active' && !!sub.current_period_end && new Date(sub.current_period_end).getTime() > now;
    const hasTrial = !!c.owner_trial_ends_at && new Date(c.owner_trial_ends_at).getTime() > now;

    let statusBadge: string;
    let endCell = '—';
    if (hasActive) {
      const daysLeft = Math.ceil((new Date(sub!.current_period_end!).getTime() - now) / 86_400_000);
      const col = daysLeft <= 7 ? C.rose : daysLeft <= 14 ? C.amber : 'var(--text2)';
      endCell = `<span style="color:${col}">${adminService.fmtDate(sub!.current_period_end)}</span>`;
      statusBadge = `<span class="ap-badge green">${PLAN_LABELS[sub!.plan_key] ?? sub!.plan_key} · ${daysLeft} дн.</span>`;
    } else if (hasTrial) {
      const trialDays = Math.ceil((new Date(c.owner_trial_ends_at!).getTime() - now) / 86_400_000);
      endCell = `<span style="color:${C.indigo}">${adminService.fmtDate(c.owner_trial_ends_at)}</span>`;
      statusBadge = `<span class="ap-badge violet">Пробный · ${trialDays} дн.</span>`;
    } else {
      statusBadge = `<span class="ap-badge grey">Нет доступа</span>`;
    }

    const apis = [
      c.has_wb ? '<span class="ap-api-tag wb">WB</span>' : '',
      c.has_ozon ? '<span class="ap-api-tag oz">OZON</span>' : '',
      c.has_yandex ? '<span class="ap-api-tag ya">ЯМ</span>' : '',
    ].filter(Boolean).join('');

    const isEditing = this.inlineEdit === c.id;
    const currentEnd = sub?.current_period_end ?? c.owner_trial_ends_at ?? null;
    const defaultEnd = currentEnd
      ? new Date(currentEnd).toISOString().slice(0, 10)
      : new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    const editRow = isEditing ? `
      <tr class="ap-inline-edit">
        <td colspan="6">
          ${currentEnd ? `<div class="ap-hint" style="margin-bottom:10px">Текущая дата окончания: <b style="color:var(--text)">${adminService.fmtDate(currentEnd)}</b></div>` : ''}
          <div class="ap-inline-box">
            <div class="ap-field" style="width:170px">
              <label class="ap-label">Установить дату окончания</label>
              <input class="ap-input" id="inline-date-${c.id}" type="date" value="${defaultEnd}">
            </div>
            <div class="ap-inline-or">или</div>
            <div class="ap-field" style="width:120px">
              <label class="ap-label">Добавить / убрать дни</label>
              <input class="ap-input" id="inline-days-${c.id}" type="number" min="-3650" max="3650" value="0" placeholder="0">
            </div>
            <div style="display:flex;gap:6px;padding-bottom:1px">
              <button class="ap-btn ap-btn-primary" data-action="confirm-extend" data-cid="${c.id}">Применить</button>
              <button class="ap-btn" data-action="cancel-extend">Отмена</button>
            </div>
          </div>
        </td>
      </tr>` : '';

    return `
      <tr class="ap-tr">
        <td>
          <div class="ap-ident">
            ${this.companyLogo(c.logo_url, c.name, c.color)}
            <div class="ap-ident-body">
              <div class="ap-ident-name">${this.esc(c.name)}</div>
              ${c.monthly_revenue > 0 ? `<div class="ap-ident-sub">${adminService.fmtMoney(c.monthly_revenue)}/мес</div>` : ''}
            </div>
          </div>
        </td>
        <td class="ap-td-muted">
          ${c.owner_first_name ? this.esc(`${c.owner_first_name} ${c.owner_last_name ?? ''}`.trim()) : '—'}
          ${c.owner_username ? `<div class="ap-ident-sub">@${this.esc(c.owner_username)}</div>` : ''}
        </td>
        <td>${apis || '<span style="color:var(--text3)">—</span>'}</td>
        <td>${statusBadge}</td>
        <td class="ap-td-muted">${endCell}</td>
        <td>
          <div class="ap-row-actions">
            <button class="ap-btn ap-btn-sm" data-action="quick-extend" data-cid="${c.id}" title="Продлить на 30 дней">+30 дн.</button>
            <button class="ap-icon-btn sm" data-action="edit-extend" data-cid="${c.id}" title="Задать дату или количество дней">${icon('calendar', 14)}</button>
          </div>
        </td>
      </tr>
      ${editRow}`;
  }

  private renderPicker(kind: string, selectedId: string, selectedName: string, placeholder: string): string {
    return `
      <div class="ap-picker" data-picker="${kind}">
        <div class="ap-picker-input-wrap">
          ${icon('search', 15)}
          <input class="ap-picker-input" placeholder="${placeholder}" value="${this.esc(selectedName)}" autocomplete="off">
          <input type="hidden" class="ap-picker-value" value="${this.esc(selectedId)}">
          ${selectedId ? `<button class="ap-picker-clear" type="button" title="Очистить">${icon('close', 14)}</button>` : ''}
        </div>
        <div class="ap-picker-dropdown" style="display:none"></div>
      </div>`;
  }

  // ── ПРОМОКОДЫ ───────────────────────────────────────────────────────────

  private renderPromos(): string {
    if (this.activePromo) return this.renderPromoDetail(this.activePromo);

    const totalRedemptions = this.promos.reduce((s, p) => s + (p.redemption_count ?? p.use_count ?? 0), 0);
    const activeCount = this.promos.filter(p => p.is_active).length;

    return `
      <div class="ap-promos">
        <div>
          <div class="ap-promo-stats">
            <div class="ap-promo-stat"><div class="ap-promo-stat-val">${this.promos.length}</div><div class="ap-promo-stat-label">всего кодов</div></div>
            <div class="ap-promo-stat"><div class="ap-promo-stat-val" style="color:${C.emerald}">${activeCount}</div><div class="ap-promo-stat-label">активных</div></div>
            <div class="ap-promo-stat"><div class="ap-promo-stat-val" style="color:${C.indigo}">${totalRedemptions}</div><div class="ap-promo-stat-label">использований</div></div>
          </div>
          <div class="ap-table-wrap">
            <table class="ap-table">
              <thead><tr><th>Код</th><th>Скидка</th><th>Ограничения</th><th>Использований</th><th>Статус</th><th style="width:96px"></th></tr></thead>
              <tbody>${this.promos.length === 0
                ? `<tr><td colspan="6" class="ap-empty-cell">Промокодов пока нет — создайте первый справа</td></tr>`
                : this.promos.map(p => this.renderPromoRow(p)).join('')}</tbody>
            </table>
          </div>
        </div>

        <div class="ap-card">
          <div class="ap-card-title">Создать промокод</div>
          <div class="ap-card-desc">Скидка применяется к подписке компании</div>
          <div class="ap-form">
            <div class="ap-field">
              <label class="ap-label">Код</label>
              <input class="ap-input ap-uppercase" id="promo-code" placeholder="SIMADESK2025">
            </div>
            <div class="ap-form-2">
              <div class="ap-field"><label class="ap-label">Скидка, ₽</label><input class="ap-input" id="promo-rub" type="number" min="0" value="0"></div>
              <div class="ap-field"><label class="ap-label">Скидка, %</label><input class="ap-input" id="promo-pct" type="number" min="0" max="100" value="0"></div>
            </div>
            <div class="ap-field">
              <label class="ap-label">Описание</label>
              <input class="ap-input" id="promo-desc" placeholder="Промо для партнёров">
            </div>
            <div class="ap-form-2">
              <div class="ap-field"><label class="ap-label">Действует до</label><input class="ap-input" id="promo-until" type="date"></div>
              <div class="ap-field"><label class="ap-label">Макс. использований</label><input class="ap-input" id="promo-maxuses" type="number" min="1" placeholder="без лимита"></div>
            </div>
            <div class="ap-form-2">
              <div class="ap-field">
                <label class="ap-label">Срок скидки, мес.</label>
                <input class="ap-input" id="promo-duration" type="number" min="1" placeholder="бессрочно">
                <div class="ap-hint">Пусто — скидка навсегда</div>
              </div>
              <div class="ap-field">
                <label class="ap-label">Лимит компаний</label>
                <input class="ap-input" id="promo-maxcos" type="number" min="1" placeholder="без лимита">
                <div class="ap-hint">Пусто — без ограничений</div>
              </div>
            </div>
            <button class="ap-btn ap-btn-primary" id="promo-create">Создать промокод</button>
          </div>
        </div>
      </div>`;
  }

  private renderPromoRow(p: PromoCode): string {
    const used = p.redemption_count ?? p.use_count ?? 0;
    const limit = p.max_uses;
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const expired = !!p.valid_until && new Date(p.valid_until) < new Date();
    const discount = [
      p.discount_rub ? `−${p.discount_rub} ₽` : '',
      p.discount_percent ? `−${p.discount_percent}%` : '',
    ].filter(Boolean).join(' · ') || '—';

    return `
      <tr class="ap-tr ap-tr-click" data-action="open-promo" data-promo-id="${p.id}">
        <td>
          <code class="ap-code">${this.esc(p.code)}</code>
          ${p.description ? `<div class="ap-ident-sub" style="margin-top:4px">${this.esc(p.description)}</div>` : ''}
        </td>
        <td style="color:${C.emerald};font-weight:650;white-space:nowrap">${discount}</td>
        <td class="ap-td-muted" style="white-space:nowrap">
          ${p.duration_months ? `${p.duration_months} мес.` : `<span style="color:${C.emerald}">навсегда</span>`}
          <div class="ap-ident-sub">${p.max_companies ? `до ${p.max_companies} комп.` : 'компании без лимита'}</div>
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:9px">
            <span style="font-weight:650">${used}${limit ? `<span style="color:var(--text3);font-weight:400"> / ${limit}</span>` : ''}</span>
            ${limit ? `<div class="ap-minibar"><i style="width:${pct}%"></i></div>` : ''}
          </div>
        </td>
        <td><span class="ap-badge ${expired || !p.is_active ? 'grey' : 'green'}">${expired ? 'Истёк' : (p.is_active ? 'Активен' : 'Отключён')}</span></td>
        <td>
          <div class="ap-row-actions">
            <button class="ap-icon-btn sm" data-action="open-promo" data-promo-id="${p.id}" title="Кто использовал">${icon('users', 14)}</button>
            <button class="ap-icon-btn sm ${p.is_active ? 'danger' : 'ok'}" data-action="toggle-promo" data-promo-id="${p.id}" data-active="${p.is_active}" title="${p.is_active ? 'Отключить' : 'Включить'}">
              ${p.is_active ? icon('ban', 14) : icon('check', 14)}
            </button>
            <button class="ap-icon-btn sm danger" data-action="delete-promo" data-promo-id="${p.id}" data-promo-code="${this.esc(p.code)}" title="Удалить промокод">${icon('trash', 14)}</button>
          </div>
        </td>
      </tr>`;
  }

  private renderPromoDetail(p: PromoCode): string {
    const used = p.redemption_count ?? p.use_count ?? 0;
    const rows = this.loadingRedemptions
      ? `<tr><td colspan="3" class="ap-empty-cell">Загрузка…</td></tr>`
      : this.promoRedemptions.length === 0
        ? `<tr><td colspan="3" class="ap-empty-cell">Этот промокод ещё никто не использовал</td></tr>`
        : this.promoRedemptions.map(r => `
            <tr class="ap-tr">
              <td>
                <div class="ap-ident">
                  ${this.avatar(r.photo_url, r.first_name ?? '?', 'sm')}
                  <div class="ap-ident-body">
                    <div class="ap-ident-name">${this.esc(`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()) || 'Удалённый пользователь'}</div>
                    <div class="ap-ident-sub">${r.telegram_username ? '@' + this.esc(r.telegram_username) : ''}</div>
                  </div>
                </div>
              </td>
              <td class="ap-td-muted">${r.company_name ? this.esc(r.company_name) : '—'}</td>
              <td class="ap-td-muted">${adminService.fmtDate(r.redeemed_at)}</td>
            </tr>`).join('');

    const meta = [
      { val: [p.discount_rub ? `${p.discount_rub} ₽` : '', p.discount_percent ? `${p.discount_percent}%` : ''].filter(Boolean).join(' + ') || '—', label: 'скидка', color: C.emerald },
      { val: p.duration_months ? `${p.duration_months} мес.` : 'навсегда', label: 'срок скидки' },
      { val: `${used}${p.max_uses ? ' / ' + p.max_uses : ''}`, label: 'использований' },
      { val: p.max_companies ? `${p.max_companies} комп.` : 'без лимита', label: 'лимит компаний' },
      { val: adminService.fmtDate(p.valid_until), label: 'действует до' },
    ];

    return `
      <button class="ap-btn ap-btn-ghost" id="promo-back" style="margin-bottom:14px">${icon('back', 15)} Назад к промокодам</button>
      <div class="ap-promo-head">
        <div>
          <code class="ap-code" style="font-size:14px;padding:5px 13px">${this.esc(p.code)}</code>
          ${p.description ? `<div class="ap-card-desc" style="margin-top:9px">${this.esc(p.description)}</div>` : ''}
        </div>
        <div class="ap-promo-meta">
          ${meta.map(m => `<div>
            <span class="ap-promo-meta-val"${m.color ? ` style="color:${m.color}"` : ''}>${m.val}</span>
            <span class="ap-promo-meta-label">${m.label}</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="ap-section-title">Кто использовал этот код</div>
      <div class="ap-table-wrap">
        <table class="ap-table">
          <thead><tr><th>Пользователь</th><th>Компания</th><th>Когда применён</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── БУХГАЛТЕРИЯ ─────────────────────────────────────────────────────────
  //
  // Считается только из того, что реально есть в БД: активные подписки
  // (company → plan_key, price_rub, current_period_end) и промокоды.
  // Отдельной таблицы платежей ЮKassa на платформе нет — есть только
  // последний статус подписки на компанию, поэтому историю транзакций
  // показать нельзя, но денежную картину «сейчас» и «что дальше» — можно.

  private renderAccounting(): string {
    if (!this.stats) {
      return this.emptyState('alert', 'Данные недоступны', 'Не удалось загрузить показатели. Нажмите «Обновить».');
    }

    const now = Date.now();
    const active = this.apiCompanies.filter(c => {
      const sub = c.subscription;
      return sub?.status === 'active' && !!sub.current_period_end && new Date(sub.current_period_end).getTime() > now;
    });

    const mrr = this.stats.mrr;
    const arpu = this.stats.active_subs > 0 ? Math.round(mrr / this.stats.active_subs) : 0;
    const upcoming30 = active.filter(c => {
      const days = Math.ceil((new Date(c.subscription!.current_period_end!).getTime() - now) / 86_400_000);
      return days <= 30;
    });
    const upcoming30Sum = upcoming30.reduce((s, c) => s + (c.subscription!.price_rub || 0), 0);

    // Доход по тарифам — сумма фактической цены подписки (не прайс-листа, чтобы учесть скидки).
    const byPlan = new Map<string, number>();
    for (const c of active) {
      const key = c.subscription!.plan_key;
      byPlan.set(key, (byPlan.get(key) ?? 0) + (c.subscription!.price_rub || 0));
    }
    const revenueByPlan = [...byPlan.entries()]
      .map(([key, revenue]) => ({ name: PLAN_LABELS[key] ?? key, revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    // Эффект промокодов — только то, что можно посчитать честно: рублёвые скидки × использования.
    // Процентные скидки без суммы заказа в рубли не переводим, показываем отдельным счётчиком.
    const rubDiscountTotal = this.promos.reduce((s, p) => {
      const uses = p.redemption_count ?? p.use_count ?? 0;
      return s + (p.discount_rub ? p.discount_rub * uses : 0);
    }, 0);
    const pctRedemptions = this.promos.reduce((s, p) => {
      const uses = p.redemption_count ?? p.use_count ?? 0;
      return s + (p.discount_percent ? uses : 0);
    }, 0);
    const activePromoCount = this.promos.filter(p => p.is_active).length;

    const ledger = [...active].sort((a, b) =>
      new Date(a.subscription!.current_period_end!).getTime() - new Date(b.subscription!.current_period_end!).getTime());

    return `
      <div class="ap-kpis">
        ${[
          { label: 'MRR',                    value: adminService.fmtMoney(mrr),          icon: 'ruble',    color: C.emerald, sub: `${this.stats.active_subs} плательщиков` },
          { label: 'Средний чек (ARPU)',      value: adminService.fmtMoney(arpu),         icon: 'trend',    color: C.indigo,  sub: 'доход / активные подписки' },
          { label: 'К продлению за 30 дней',  value: adminService.fmtMoney(upcoming30Sum), icon: 'calendar', color: C.amber,   sub: `${upcoming30.length} компаний` },
          { label: 'Скидки по промокодам',    value: adminService.fmtMoney(rubDiscountTotal), icon: 'tag',  color: C.violet,  sub: `${activePromoCount} кодов активно` },
        ].map(k => `
          <div class="ap-kpi" style="--kpi-color:${k.color}">
            <div class="ap-kpi-top">
              <div class="ap-kpi-icon">${icon(k.icon, 16)}</div>
              <div class="ap-kpi-label">${k.label}</div>
            </div>
            <div class="ap-kpi-value">${k.value}</div>
            <div class="ap-kpi-sub">${k.sub}</div>
          </div>`).join('')}
      </div>

      <div class="ap-grid-2">
        <div class="ap-card">
          <div class="ap-card-title">Доход по тарифам</div>
          <div class="ap-card-desc">Фактическая сумма активных подписок по каждому тарифу</div>
          <div class="ap-chart">${revenueByPlan.length ? hBars(revenueByPlan, C.emerald, n => adminService.fmt(n)) : '<div class="ap-chart-empty">Нет активных подписок</div>'}</div>
        </div>
        <div class="ap-card">
          <div class="ap-card-title">Эффект промокодов</div>
          <div class="ap-card-desc">Только рублёвые скидки переводятся в сумму — процентные без суммы заказа честно посчитать нельзя</div>
          <div style="margin-top:8px">
            ${this.statRow('Выдано скидок, ₽ (сумма)', rubDiscountTotal, C.emerald)}
            ${this.statRow('Активаций по % скидкам', pctRedemptions, C.indigo)}
            ${this.statRow('Активных кодов', activePromoCount, C.violet)}
            ${this.statRow('Всего кодов', this.promos.length, C.blue)}
          </div>
        </div>
      </div>

      <div class="ap-section-title">Активные подписки — по сроку продления</div>
      <div class="ap-table-wrap">
        <table class="ap-table">
          <thead><tr>
            <th>Компания</th><th>Владелец</th><th>API</th><th>Тариф · дней осталось</th><th>Действует до</th><th style="width:104px"></th>
          </tr></thead>
          <tbody>${ledger.length === 0
            ? `<tr><td colspan="6" class="ap-empty-cell">Нет активных платящих компаний</td></tr>`
            : ledger.map(c => this.renderApiCompanyRow(c, now)).join('')}</tbody>
        </table>
      </div>`;
  }

  // ── ПОДДЕРЖКА ───────────────────────────────────────────────────────────

  private renderSupport(): string {
    const visibleChats = this.liveChatReasonFilter
      ? this.liveChats.filter(c => c.reason === this.liveChatReasonFilter)
      : this.liveChats;

    const chatList = visibleChats.map(c => this.renderChatRow(c)).join('')
      || `<div class="ap-empty" style="padding:36px 20px">${icon('inbox', 30, 1.5)}<div class="ap-empty-title">Нет чатов${this.liveChatReasonFilter ? ' по этой теме' : ''}</div></div>`;

    const reasonsInUse = [...new Set(this.liveChats.map(c => c.reason))];
    const reasonPills = reasonsInUse.map(r => {
      const rm = REASON_META[r] ?? { label: r, icon: 'chat', color: '#64748b' };
      return `<button class="ap-pill${this.liveChatReasonFilter === r ? ' active' : ''}" data-reason-filter="${r}" title="${rm.label}">${icon(rm.icon, 12)} ${rm.label}</button>`;
    }).join('');
    const clearPill = this.liveChatReasonFilter
      ? `<button class="ap-pill" data-reason-filter="" style="color:${C.rose}">${icon('close', 12)} Сбросить</button>` : '';

    const aiModels = [
      { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 — быстрый, дешёвый' },
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 — умнее' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'google/gemini-flash-1.5', label: 'Gemini Flash 1.5' },
    ];

    const errorBar = this.supError ? `
      <div class="ap-banner error" style="margin:14px 26px 0">
        ${icon('warn', 18)}
        <div class="ap-banner-body"><b>Чаты не загрузились</b><span>${this.esc(this.supError)}</span></div>
        <button class="ap-btn ap-btn-sm" id="ap-sup-diag">Диагностика</button>
        <button class="ap-btn ap-btn-sm" id="ap-sup-retry">${icon('refresh', 13)} Повторить</button>
      </div>` : '';

    const detail = this.activeLiveChat
      ? this.renderChatDetail(this.activeLiveChat)
      : `<div class="ap-sup-placeholder">
          <div class="ap-sup-placeholder-icon">${icon('chat', 28, 1.5)}</div>
          <div class="ap-sup-placeholder-title">Выберите обращение</div>
          <div class="ap-sup-placeholder-desc">AI-автоответы отвечают на очевидные вопросы сами<br>и помечают спорные для оператора.</div>
          <div class="ap-sup-placeholder-stats">
            <div class="ap-sup-pstat"><b>${this.liveChats.length}</b><span>чатов</span></div>
            <div class="ap-sup-pstat"><b>${this.supNeedsAttention.size}</b><span>нужен оператор</span></div>
          </div>
        </div>`;

    return `
      ${errorBar}
      <div class="ap-sup-bar">
        <label class="ap-switch" title="ИИ автоматически отвечает на очевидные вопросы. Если не уверен — помечает чат для оператора.">
          <span class="ap-switch-track${this.supAiEnabled ? ' on' : ''}" id="sup-ai-toggle-track"><span class="ap-switch-thumb"></span></span>
          <span class="ap-switch-label">AI-автоответы</span>
        </label>
        <div class="ap-sup-bar-sep"></div>
        <select class="ap-select ap-sup-model-sel" id="sup-ai-model-sel">
          ${aiModels.map(m => `<option value="${m.id}"${this.supAiModel === m.id ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
        <div class="ap-sup-bar-sep"></div>
        <span class="ap-sup-hint" id="ap-sup-hint">
          <span class="ap-dot" style="background:${this.supAiEnabled ? C.emerald : 'var(--text3)'}"></span>
          ${this.supAiEnabled ? 'Включено' : 'Выключено'} · нужен оператор: <b style="color:var(--text)">${this.supNeedsAttention.size}</b>
        </span>
        <span class="ap-sup-balance" data-or-balance title="Баланс OpenRouter">${icon('zap', 13)} …</span>
      </div>

      <div class="ap-sup">
        <div class="ap-sup-list">
          <div class="ap-sup-list-head">
            Обращения
            <div class="ap-segment">
              <button class="${this.liveChatFilter === 'open' ? 'active' : ''}" data-live-filter="open">Активные</button>
              <button class="${this.liveChatFilter === 'all' ? 'active' : ''}" data-live-filter="all">Все</button>
            </div>
          </div>
          ${reasonPills || clearPill ? `<div class="ap-sup-pills">${reasonPills}${clearPill}</div>` : ''}
          <div class="ap-sup-rows" id="ap-sup-rows">${chatList}</div>
        </div>
        <div class="ap-sup-detail" id="ap-sup-detail">${detail}</div>
      </div>`;
  }

  private renderChatRow(c: AdminSupportChat): string {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Пользователь';
    const isActive = this.activeLiveChat?.id === c.id;
    const rm = REASON_META[c.reason] ?? { label: c.reason, icon: 'chat', color: '#64748b' };
    const needsOp = this.supNeedsAttention.has(c.id);
    const aiDone  = this.supAiHandled.has(c.id) && !needsOp;
    const unread  = c.unread_count > 0 && !isActive;
    const preview = c.last_message
      ? this.esc(c.last_message.replace(/^\[?🤖\s*АВТОКОНТЕКСТ:[^\]\n]*\]?\n?/i, '').trim().slice(0, 65)) || '—'
      : '—';
    return `
      <div class="ap-sup-row${isActive ? ' active' : ''}${needsOp ? ' needs-op' : ''}" data-live-chat-id="${c.id}">
        <div class="ap-sup-row-accent" style="background:${rm.color}"></div>
        ${this.avatar(null, name)}
        <div class="ap-sup-row-body">
          <div class="ap-sup-row-head">
            <span class="ap-sup-name">${this.esc(name)}</span>
            ${needsOp ? `<span class="ap-sup-flag" title="Нужен оператор">${icon('alert', 12)}</span>` : ''}
            ${aiDone  ? `<span class="ap-sup-ai-mark" title="Ответил AI">${icon('bot', 12)}</span>` : ''}
            ${unread  ? `<span class="ap-sup-unread">${c.unread_count}</span>` : ''}
            <span class="ap-sup-time">${c.last_message_at ? supportChatService.fmtTime(c.last_message_at) : ''}</span>
          </div>
          <div class="ap-sup-reason" style="color:${rm.color}">${icon(rm.icon, 11)} ${rm.label}</div>
          <div class="ap-sup-preview">${preview}</div>
        </div>
      </div>`;
  }

  private renderChatDetail(c: AdminSupportChat): string {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Пользователь';
    const rm = REASON_META[c.reason] ?? { label: c.reason, icon: 'chat', color: '#64748b' };
    const isAi = this.supAdminMode === 'ai';
    const meta = [
      c.telegram_username ? `@${this.esc(c.telegram_username)}` : '',
      c.company_name ? this.esc(c.company_name) : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="ap-sup-detail-inner">
        <div class="ap-sup-detail-head">
          ${this.avatar(null, name, 'lg')}
          <div class="ap-sup-detail-info">
            <div class="ap-sup-detail-name">${this.esc(name)}</div>
            ${meta ? `<div class="ap-sup-detail-meta">${meta}</div>` : ''}
            <div class="ap-sup-detail-reason" style="--rc:${rm.color}">
              ${icon(rm.icon, 12)} ${rm.label}
            </div>
          </div>
          <button class="ap-btn ap-btn-danger ap-btn-sm" id="ap-live-close-chat">${icon('close', 13)} Завершить</button>
        </div>
        <div class="ap-sup-msgs" id="ap-live-messages">${this.renderMessages(c, name)}</div>
        <div id="ap-live-typing"></div>
        <div class="ap-chips" id="ap-live-chips"></div>
        <div class="ap-mode-bar${isAi ? '' : ' manual'}" id="ap-live-mode-bar">
          <span class="ap-mode-label" id="ap-live-mode-label">${isAi ? icon('bot', 14) + ' AI-ассистент отвечает' : icon('edit', 14) + ' Ручной режим'}</span>
          <button class="ap-btn ap-btn-sm${isAi ? '' : ' ap-btn-primary'}" id="ap-live-mode-toggle">${isAi ? 'Взять управление' : 'Передать AI'}</button>
        </div>
        <div class="ap-composer">
          <button class="ap-composer-btn" id="ap-live-attach-btn" title="Прикрепить файл">${icon('paperclip', 16)}</button>
          <input type="file" id="ap-live-file-input" accept=".xlsx,.xls,.docx,.doc,.pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv" multiple style="display:none">
          <textarea id="ap-live-textarea" rows="1" placeholder="${isAi ? 'AI отвечает — нажмите «Взять управление»' : 'Напишите ответ и нажмите Enter…'}"${isAi ? ' disabled' : ''}></textarea>
          <button class="ap-composer-btn send" id="ap-live-send-btn"${isAi ? ' disabled' : ''} title="Отправить (Enter)">${icon('send', 16)}</button>
        </div>
      </div>`;
  }

  private parseAutoCtx(content: string): { ctx: Record<string, string> | null; text: string } {
    const m = content?.match(/^\[?🤖\s*АВТОКОНТЕКСТ:\s*([^\]\n]*)\]?\n?/i);
    if (!m) return { ctx: null, text: content ?? '' };
    const text = content.slice(m[0].length).trim();
    const ctx: Record<string, string> = {};
    m[1].split(',').forEach(pair => {
      const [k, v] = pair.trim().split('=');
      if (k?.trim() && v?.trim()) ctx[k.trim()] = v.trim();
    });
    return { ctx: Object.keys(ctx).length ? ctx : null, text };
  }

  private renderAutoCtxBadge(ctx: Record<string, string>): string {
    const SECTION: Record<string, string> = {
      home: 'Главная', analytics: 'Аналитика', orders: 'Заказы',
      products: 'Товары', 'products-hub': 'Товары', stock: 'Склад',
      settings: 'Настройки', repricer: 'Репрайсер', tasks: 'Задачи',
      billing: 'Тариф', simastore: 'Витрина', docs: 'Редактор',
    };
    const theme   = ctx['тема'];
    const section = ctx['раздел'];
    const parts: string[] = [];
    if (theme)   parts.push(`${theme === 'тёмная' ? '🌙' : '☀️'} ${theme}`);
    if (section) parts.push(`📍 ${SECTION[section] ?? section}`);
    return parts.length
      ? `<div class="ap-ctx-badge">${parts.join('&nbsp;·&nbsp;')}</div>`
      : '';
  }

  private renderMessages(c: AdminSupportChat, name: string): string {
    const msgs = c.messages ?? [];
    if (!msgs.length) return `<div class="ap-sup-empty-msgs">${icon('chat', 28, 1.4)}<div>Сообщений пока нет</div></div>`;
    return msgs.map(m => {
      const isAdmin = m.sender_role === 'admin';
      const { ctx, text: cleanText } = this.parseAutoCtx(m.content ?? '');
      const ctxBadge = !isAdmin && ctx ? this.renderAutoCtxBadge(ctx) : '';
      const attach = (m.attachments ?? []).map(a =>
        a.kind === 'image'
          ? `<img src="${a.data}" alt="${this.esc(a.name)}" class="ap-msg-img">`
          : `<div class="ap-msg-file">${icon('paperclip', 13)} ${this.esc(a.name)}</div>`,
      ).join('');
      const timeStr = supportChatService.fmtTime(m.created_at);
      const copyBtn = cleanText ? `<button class="ap-msg-copy" data-copy="${this.esc(cleanText).replace(/"/g, '&quot;')}" title="Копировать"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : '';
      return `<div class="ap-msg ${isAdmin ? 'admin' : 'user'}">
        ${ctxBadge}
        <div class="ap-bubble">${cleanText ? this.esc(cleanText).replace(/\n/g, '<br>') : ''}${attach}${copyBtn}</div>
        <div class="ap-msg-time">${isAdmin ? icon('shield', 10) + ' Поддержка' : this.esc(name)} · ${timeStr}</div>
      </div>`;
    }).join('');
  }

  private bindSupportEvents(): void {
    this.el.querySelector('#ap-sup-retry')?.addEventListener('click', () => this.loadTab());
    this.el.querySelector('#ap-sup-diag')?.addEventListener('click', async () => {
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

    void this.refreshOrBalance();

    const track = this.el.querySelector<HTMLElement>('#sup-ai-toggle-track');
    track?.addEventListener('click', () => {
      this.supAiEnabled = !this.supAiEnabled;
      localStorage.setItem('sd_sup_ai_enabled', this.supAiEnabled ? '1' : '0');
      track.classList.toggle('on', this.supAiEnabled);
      this.updateSupHint();
    });

    const modelSel = this.el.querySelector<HTMLSelectElement>('#sup-ai-model-sel');
    modelSel?.addEventListener('change', () => {
      this.supAiModel = modelSel.value;
      localStorage.setItem('sd_sup_ai_model', this.supAiModel);
    });

    this.el.querySelectorAll<HTMLElement>('[data-live-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.liveChatFilter = (btn.dataset.liveFilter as 'open' | 'all') ?? 'open';
        this.activeLiveChat = null;
        this.loadTab();
      });
    });

    this.el.querySelectorAll<HTMLElement>('[data-reason-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.liveChatReasonFilter = btn.dataset.reasonFilter || null;
        const host = this.el.querySelector<HTMLElement>('#ap-content');
        if (host) { host.innerHTML = this.renderSupport(); this.bindSupportEvents(); }
      });
    });

    this.bindChatRows();

    const detail = this.el.querySelector<HTMLElement>('#ap-sup-detail');
    if (detail && this.activeLiveChat) this.bindChatDetailEvents(detail);
  }

  private updateSupHint(): void {
    const hint = this.el.querySelector<HTMLElement>('#ap-sup-hint');
    if (!hint) return;
    hint.innerHTML = `<span class="ap-dot" style="background:${this.supAiEnabled ? C.emerald : 'var(--text3)'}"></span>`
      + `${this.supAiEnabled ? 'Включено' : 'Выключено'} · нужен оператор: <b style="color:var(--text)">${this.supNeedsAttention.size}</b>`;
  }

  private bindChatRows(): void {
    this.el.querySelectorAll<HTMLElement>('.ap-sup-row').forEach(row => {
      row.addEventListener('click', () => this.openChat(row.dataset.liveChatId!));
    });
  }

  private async openChat(id: string): Promise<void> {
    const chat = await supportChatService.adminGetChat(id);
    if (!chat) return;
    this.activeLiveChat = chat;
    this.liveChatLastMsgTime = chat.messages?.at(-1)?.created_at ?? null;
    this.liveAttachFiles = [];
    const detail = this.el.querySelector<HTMLElement>('#ap-sup-detail');
    if (detail) {
      detail.innerHTML = this.renderChatDetail(chat);
      this.bindChatDetailEvents(detail);
      const msgs = detail.querySelector<HTMLElement>('#ap-live-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
    this.el.querySelectorAll<HTMLElement>('.ap-sup-row').forEach(r =>
      r.classList.toggle('active', r.dataset.liveChatId === id));
    const idx = this.liveChats.findIndex(c => c.id === id);
    if (idx >= 0) {
      const upd = [...this.liveChats];
      upd[idx] = { ...upd[idx], unread_count: 0 };
      this.liveChats = upd;
    }
  }

  private applyAdminMode(detail: HTMLElement): void {
    const textarea = detail.querySelector<HTMLTextAreaElement>('#ap-live-textarea');
    const sendBtn = detail.querySelector<HTMLButtonElement>('#ap-live-send-btn');
    const label = detail.querySelector<HTMLElement>('#ap-live-mode-label');
    const toggle = detail.querySelector<HTMLButtonElement>('#ap-live-mode-toggle');
    const isAi = this.supAdminMode === 'ai';
    const responding = this.supAiRespondingFor === this.activeLiveChat?.id;
    if (label) {
      label.innerHTML = responding
        ? `${icon('sparkle', 14)} AI формирует ответ…`
        : isAi ? `${icon('bot', 14)} AI-ассистент отвечает` : `${icon('edit', 14)} Ручное управление`;
    }
    if (toggle) toggle.textContent = isAi ? 'Взять управление' : 'Передать AI';
    if (textarea) {
      textarea.disabled = isAi;
      textarea.placeholder = isAi ? 'Отвечает AI — нажмите «Взять управление»' : 'Напишите ответ…';
    }
    if (sendBtn) sendBtn.disabled = isAi;
    detail.querySelector('#ap-live-mode-bar')?.classList.toggle('responding', responding);
  }

  private bindChatDetailEvents(detail: HTMLElement): void {
    const textarea = detail.querySelector<HTMLTextAreaElement>('#ap-live-textarea');
    const sendBtn = detail.querySelector('#ap-live-send-btn');
    const closeBtn = detail.querySelector('#ap-live-close-chat');
    const attachBtn = detail.querySelector('#ap-live-attach-btn');
    const fileInput = detail.querySelector<HTMLInputElement>('#ap-live-file-input');

    detail.querySelector('#ap-live-mode-toggle')?.addEventListener('click', () => {
      if (!this.activeLiveChat) return;
      this.supAdminMode = this.supAdminMode === 'ai' ? 'manual' : 'ai';
      if (this.supAdminMode === 'manual') {
        const timer = this.supBatchTimers.get(this.activeLiveChat.id);
        if (timer) { clearTimeout(timer); this.supBatchTimers.delete(this.activeLiveChat.id); }
      }
      this.applyAdminMode(detail);
    });

    this.applyAdminMode(detail);

    const doSend = async () => {
      if (!this.activeLiveChat || !textarea) return;
      if (this.supAdminMode === 'ai') return;
      const text = textarea.value.trim();
      if (!text && this.liveAttachFiles.length === 0) return;
      textarea.value = '';
      textarea.style.height = '';
      const snap = [...this.liveAttachFiles];
      this.liveAttachFiles = [];
      this.renderAttachChips(detail);
      try {
        await supportChatService.adminSendMessage(this.activeLiveChat.id, text, snap);
        const chat = await supportChatService.adminGetChat(this.activeLiveChat.id);
        if (chat) {
          this.activeLiveChat = chat;
          this.liveChatLastMsgTime = chat.messages?.at(-1)?.created_at ?? null;
          detail.innerHTML = this.renderChatDetail(chat);
          this.bindChatDetailEvents(detail);
          const msgs = detail.querySelector<HTMLElement>('#ap-live-messages');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }
      } catch { showToast('Ошибка отправки', 'error'); }
    };

    textarea?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    textarea?.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 130) + 'px';
      if (textarea.value.trim()) this.signalAdminTyping();
    });
    sendBtn?.addEventListener('click', doSend);

    detail.querySelector<HTMLElement>('#ap-live-messages')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.ap-msg-copy');
      if (!btn) return;
      const text = btn.dataset.copy ?? '';
      navigator.clipboard.writeText(text).catch(() => {});
      btn.classList.add('copied');
      btn.title = 'Скопировано!';
      showToast('Скопировано', 'success');
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Копировать'; }, 1500);
    });

    closeBtn?.addEventListener('click', async () => {
      const chat = this.activeLiveChat;
      if (!chat) return;
      if (!confirm('Завершить диалог с пользователем? История переписки будет удалена.')) return;
      try {
        await supportChatService.adminCloseChat(chat.id);
        this.activeLiveChat = null;
        this.liveChats = this.liveChats.filter(c => c.id !== chat.id);
        this.loadTab();
        showToast('Диалог завершён', 'success');
      } catch { showToast('Ошибка при закрытии', 'error'); }
    });

    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      const files = Array.from(fileInput.files ?? []);
      files.forEach(file => {
        if (file.size > 5 * 1024 * 1024) { showToast('Файл слишком большой (макс. 5 МБ)', 'error'); return; }
        const reader = new FileReader();
        const kind = file.type.startsWith('image/') ? 'image' : 'text';
        reader.onload = e => {
          this.liveAttachFiles.push({ name: file.name, kind, data: e.target?.result as string, size: file.size });
          this.renderAttachChips(detail);
        };
        if (kind === 'image') reader.readAsDataURL(file); else reader.readAsText(file);
      });
      fileInput.value = '';
    });
  }

  private renderAttachChips(detail: HTMLElement): void {
    const chips = detail.querySelector('#ap-live-chips');
    if (!chips) return;
    chips.innerHTML = this.liveAttachFiles.map((f, i) =>
      `<div class="ap-chip">${icon(f.kind === 'image' ? 'image' : 'paperclip', 13)} ${this.esc(f.name)}
        <button data-idx="${i}" title="Убрать">${icon('close', 13)}</button>
      </div>`).join('');
    chips.querySelectorAll<HTMLElement>('button[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.liveAttachFiles.splice(Number(btn.dataset.idx), 1);
        this.renderAttachChips(detail);
      });
    });
  }

  private startLiveChatPolling(): void {
    this.stopLiveChatPolling();
    this.liveChatPollTimer = setInterval(async () => {
      if (this.tab !== 'support') { this.stopLiveChatPolling(); return; }
      try {
        let chats: AdminSupportChat[];
        try {
          chats = await supportChatService.adminGetChats(this.liveChatFilter);
          // Ошибка была и ушла — перерисуем вкладку, чтобы убрать баннер.
          if (this.supError) { this.supError = null; this.liveChats = chats; this.render(); return; }
        } catch (e) {
          const msg = supportErrorText(e);
          if (msg !== this.supError) { this.supError = msg; this.render(); }
          return;
        }
        this.liveChats = chats;

        // Обновляем только список — иначе потеряется состояние открытого чата.
        const list = this.el.querySelector<HTMLElement>('#ap-sup-rows');
        if (list) {
          const visible = this.liveChatReasonFilter ? chats.filter(c => c.reason === this.liveChatReasonFilter) : chats;
          list.innerHTML = visible.length
            ? visible.map(c => this.renderChatRow(c)).join('')
            : `<div class="ap-empty" style="padding:36px 20px">${icon('inbox', 30, 1.5)}<div class="ap-empty-title">Нет активных чатов</div></div>`;
          this.bindChatRows();
        }

        if (this.supAiEnabled) {
          for (const chat of chats) {
            if (this.supAiProcessing.has(chat.id)) continue;
            if (this.supGreeted.has(chat.id)) continue;
            if (chat.last_message_role !== 'user') continue;
            const lastAiTime = this.supAiHandled.get(chat.id);
            if (lastAiTime && chat.last_message_at && lastAiTime >= chat.last_message_at) continue;
            this.startAiFlow(chat.id);
          }
        }

        if (this.activeLiveChat) {
          const res = await supportChatService.poll(this.activeLiveChat.id, this.liveChatLastMsgTime);
          const newMsgs = res?.messages ?? [];
          this.renderUserTyping(!!res?.peer_typing);
          if (newMsgs.length > 0) {
            this.liveChatLastMsgTime = newMsgs.at(-1)!.created_at;
            this.activeLiveChat.messages = [...(this.activeLiveChat.messages ?? []), ...newMsgs];
            const msgsEl = this.el.querySelector<HTMLElement>('#ap-live-messages');
            if (msgsEl) {
              const name = [this.activeLiveChat.first_name, this.activeLiveChat.last_name].filter(Boolean).join(' ') || 'Пользователь';
              msgsEl.innerHTML = this.renderMessages(this.activeLiveChat, name);
              msgsEl.scrollTop = msgsEl.scrollHeight;
            }
          }
        }
      } catch { /* тихо игнорируем ошибки опроса */ }
    }, 3000);
  }

  private stopLiveChatPolling(): void {
    if (this.liveChatPollTimer) { clearInterval(this.liveChatPollTimer); this.liveChatPollTimer = null; }
    this.renderUserTyping(false);
  }

  /**
   * Новый AI-флоу:
   *  3 с  → отправить приветствие + запустить AI параллельно
   *  ≥5 с после приветствия → отправить ответ AI (ждём если ещё не готов)
   */
  private startAiFlow(chatId: string): void {
    if (this.supAiProcessing.has(chatId)) return;
    if (this.supGreeted.has(chatId)) return;         // уже в процессе для этого чата
    if (this.supBatchTimers.has(chatId)) return;     // таймер уже тикает — не сбрасываем

    const handle = setTimeout(async () => {
      this.supBatchTimers.delete(chatId);
      if (!this.supAiEnabled) return;
      if (this.supAdminMode === 'manual' && this.activeLiveChat?.id === chatId) return;
      if (this.supAiProcessing.has(chatId)) return;

      try {
        const full = await supportChatService.adminGetChat(chatId);
        if (!full?.messages?.length) return;
        const msgs = full.messages;
        const lastMsg = msgs.at(-1);
        if (!lastMsg || lastMsg.sender_role !== 'user') return;

        // Если повторное недовольство после AI-ответа → сразу оператору
        if (this.supAiHandled.has(chatId) && this.DISSATISFACTION_PATTERNS.test(lastMsg.content)) {
          await this.sendBridgeMessage(chatId, 'Передаю ваш вопрос оператору — он свяжется с вами в ближайшее время 🙏');
          this.supNeedsAttention.add(chatId);
          this.updateAttentionBadge(chatId);
          return;
        }

        // Серверный AI (edge function) мог уже ответить — проверяем недавние admin-сообщения
        const cutoffMs = Date.now() - 120_000;
        const recentAdmin = msgs.some(
          m => m.sender_role !== 'user' && new Date(m.created_at).getTime() > cutoffMs,
        );
        if (recentAdmin) return; // Edge function уже обработал

        // 1. Приветствие
        const greetingText = 'Здравствуйте! Уже разбираемся с вашим вопросом, ответим совсем скоро 👋';
        await supportChatService.adminSendMessage(chatId, greetingText);
        const greetedAt = Date.now();
        this.supGreeted.set(chatId, greetedAt);

        // 2. AI готовит ответ параллельно, затем ждём минимум 5 с с момента приветствия
        this.runSupAiReply(chatId, msgs, greetedAt);
      } catch { /* ignore */ }
    }, 3_000);

    this.supBatchTimers.set(chatId, handle);
  }

  private async sendBridgeMessage(chatId: string, text: string): Promise<void> {
    try { await supportChatService.adminSendMessage(chatId, text); } catch { /* ignore */ }
  }


  private renderUserTyping(typing: boolean): void {
    const host = this.el.querySelector<HTMLElement>('#ap-live-typing');
    if (!host) return;
    if (!typing) { host.innerHTML = ''; return; }
    const name = [this.activeLiveChat?.first_name, this.activeLiveChat?.last_name].filter(Boolean).join(' ') || 'Пользователь';
    host.innerHTML = `<div class="ap-typing">
      <span class="sd-sup-typing-dots"><i></i><i></i><i></i></span>
      <span>${this.esc(name)} печатает…</span>
    </div>`;
  }

  // ── AI-автоответы поддержки ─────────────────────────────────────────────

  private readonly SIMADESK_KNOWLEDGE = `SimaDesk — платформа управления маркетплейсами (WB, Ozon, Яндекс Маркет).

РАЗДЕЛЫ И ЧТО ГДЕ НАХОДИТСЯ:
• Главная (home) — дашборд: выручка дня, новые заказы, остатки в зоне риска, просроченные задачи
• Аналитика (analytics) — графики выручки/прибыли/заказов, сравнение периодов, ABC-анализ товаров
• Репрайсер (repricer) — автоправила цен: следить за конкурентами, целевая маржа, мин/макс цена
• Заказы (orders) — все заказы со всех МП: статусы, фильтры, дедлайны FBS (красный = срочно)
• Товары / Products Hub (products-hub) — карточки товаров, цены, описания, SEO, фото, массовое редактирование
• Остатки / Склад (stock) — остатки FBO/FBS, метрика «Дней до OOS», настройка порогов алертов
• Производители (producers) — база поставщиков, контакты, условия, прайсы
• Задачи (tasks) — планировщик операционных задач: создать → кнопка «+» или попросить Симу
• Витрина / SimaStore (simastore) — собственный магазин, URL /s/slug, синхронизация товаров
• Настройки (settings) — подключение МП, API-ключи, смена пароля, тема, тарифы, команда, расширение браузера
• Расширение браузера — ЕСТЬ в SimaDesk. Установить: Настройки → раздел «Расширение браузера». Там кнопка скачивания/установки.
• Редактор (docs) — встроенный Excel и Word, импорт/экспорт .xlsx/.docx
• Сима (AI-помощник) — открывается кнопкой «Сима» в правом нижнем углу

КАК ПОДКЛЮЧИТЬ МАРКЕТПЛЕЙС:
• WB: Настройки → Маркетплейсы → Wildberries → API-ключ из ЛК WB (Профиль → Настройки → Токены)
• Ozon: Настройки → Маркетплейсы → Ozon → Client ID + API Key из ЛК Ozon
• Яндекс: Настройки → Маркетплейсы → Яндекс Маркет → OAuth-токен

ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ:
Q: Как переключить тему? → Настройки → переключатель темы. Или Сима сделает это кнопкой.
Q: Данные не обновляются? → Проверь API-ключ в Настройки → Маркетплейсы. Синхронизация каждые 30 мин.
Q: Где посмотреть остатки? → Раздел «Остатки (Склад)» → колонка «Дней до OOS»
Q: Не работает AI Сима? → Настройки → AI → проверить OpenRouter API-ключ и баланс на openrouter.ai
Q: Как добавить сотрудника? → Настройки → Команда → «Пригласить пользователя»
Q: Как изменить тариф? → Настройки → Подписка
Q: Где скачать / установить расширение для браузера? → Настройки → раздел «Расширение браузера». Расширение существует и доступно для установки прямо из настроек.

АВТОДЕЙСТВИЯ (только если проблема актуальна по контексту [🤖 АВТОКОНТЕКСТ:...]):
Если пользователь сообщает о проблеме интерфейса и её можно решить кнопкой — добавь в конец ответа ОДИН JSON:
{"support_action":"toggle_theme_off","label":"Переключить на тёмную тему"} — если жалуется на светлую тему и тема=светлая
{"support_action":"toggle_theme_on","label":"Переключить на светлую тему"} — если хочет светлую тему и тема=тёмная
{"support_action":"reload_page","label":"Перезагрузить страницу"} — если данные не обновляются
{"support_action":"navigate_to","page":"settings","label":"Открыть Настройки → Расширение"} — если пользователь спрашивает про расширение браузера или как его найти/установить
ВАЖНО: предлагай кнопку ТОЛЬКО если контекст [🤖 АВТОКОНТЕКСТ:...] подтверждает актуальность проблемы.
Кнопка будет показана пользователю — при нажатии действие выполнится автоматически в его браузере.

Навигация: левое меню, иконки разделов.`;

  private readonly DISSATISFACTION_PATTERNS = /не (то|так|правильно|понял|понимаю|помогло)|нет[,.]?\s*(не|это)|это не|не об этом|другой вопрос|вы не поняли|всё равно не|по-прежнему|так и не|не решил|не работает|не помогает/i;

  private signalAdminTyping(): void {
    const id = this.activeLiveChat?.id;
    if (!id) return;
    const now = Date.now();
    if (now - this.supTypingSentAt < 2500) return;
    this.supTypingSentAt = now;
    void supportChatService.setTyping(id);
  }

  private async ensureAiKey(): Promise<string> {
    let key = sessionStorage.getItem('sd_ai_key') || '';
    if (!key) {
      try {
        const content = await adminService.getSiteContent();
        const entry = content.find(c => c.key === 'ai_openrouter_key');
        if (entry?.content) { key = entry.content; sessionStorage.setItem('sd_ai_key', key); }
      } catch { /* ignore */ }
    }
    return key;
  }

  private async runSupAiReply(
    chatId: string,
    messages: Array<{ sender_role: string; content: string }>,
    greetedAt: number,
  ): Promise<void> {
    const apiKey = await this.ensureAiKey();
    if (!apiKey) return;

    this.supAiProcessing.add(chatId);
    this.supAiRespondingFor = chatId;
    const detail0 = this.el.querySelector<HTMLElement>('#ap-sup-detail');
    if (detail0 && this.activeLiveChat?.id === chatId) this.applyAdminMode(detail0);

    // Показываем «печатает» пока AI думает
    void supportChatService.setTyping(chatId);
    const typingKeepAlive = setInterval(() => { void supportChatService.setTyping(chatId); }, 3000);

    try {
      const history = messages.slice(-8).map(m => ({
        role: m.sender_role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
      }));

      const systemPrompt = `Ты — сотрудник поддержки SimaDesk. Отвечай на русском языке, кратко и по делу.
Приветствие клиенту уже отправлено — НЕ здоровайся снова, начинай сразу с ответа на вопрос.

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

      const confident = reply.match(/\[УВЕРЕН:(да|нет)\]/i)?.[1]?.toLowerCase() === 'да';
      reply = reply.replace(/\[УВЕРЕН:(да|нет)\]/gi, '').trim();

      // Ждём минимум 5 секунд с момента отправки приветствия
      const MIN_DELAY_MS = 5_000;
      const elapsed = Date.now() - greetedAt;
      if (elapsed < MIN_DELAY_MS) {
        await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
      }

      if (confident) {
        await supportChatService.adminSendMessage(chatId, reply);
        this.supAiHandled.set(chatId, new Date().toISOString());
        this.supNeedsAttention.delete(chatId);
      } else {
        // Мостовое сообщение → ручной режим
        await this.sendBridgeMessage(
          chatId,
          'Этот вопрос требует участия оператора. Я передал обращение — специалист ответит в ближайшее время 🙏',
        );
        this.supNeedsAttention.add(chatId);
        this.updateAttentionBadge(chatId);
      }
    } catch { /* ignore AI errors */ } finally {
      clearInterval(typingKeepAlive);
      void supportChatService.clearTyping(chatId);
      this.supAiProcessing.delete(chatId);
      this.supGreeted.delete(chatId);   // сбросить: при следующем сообщении флоу стартует заново
      if (this.supAiRespondingFor === chatId) {
        this.supAiRespondingFor = null;
        const detail = this.el.querySelector<HTMLElement>('#ap-sup-detail');
        if (detail && this.activeLiveChat?.id === chatId) this.applyAdminMode(detail);
      }
    }
  }

  private updateAttentionBadge(chatId: string): void {
    this.updateSupHint();
    const row = this.el.querySelector<HTMLElement>(`.ap-sup-row[data-live-chat-id="${chatId}"]`);
    if (!row || row.querySelector('.ap-sup-flag')) return;
    row.querySelector('.ap-sup-row-head')
      ?.insertAdjacentHTML('afterbegin', `<span class="ap-sup-flag" title="Нужен оператор">${icon('alert', 13)}</span>`);
  }

  private async refreshOrBalance(): Promise<void> {
    const apiKey = await this.ensureAiKey();
    const els = Array.from(this.el.querySelectorAll<HTMLElement>('[data-or-balance]'));
    if (!els.length) return;

    const setAll = (html: string, color = '', title = '') => {
      els.forEach(el => {
        el.innerHTML = html;
        if (color) el.style.color = color;
        if (title) el.title = title;
      });
    };

    if (!apiKey) { setAll(`${icon('zap', 13)} нет ключа`, C.rose); return; }
    setAll(`${icon('zap', 13)} …`);

    try {
      let balance = 0, credits = 0, used = 0;

      // Try /api/v1/credits (newer endpoint)
      const r1 = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (r1.ok) {
        const d = (await r1.json())?.data ?? {};
        credits = d.total_credits ?? d.grant_total ?? d.limit ?? 0;
        used    = d.total_usage  ?? d.usage          ?? 0;
        balance = d.limit_remaining !== undefined ? d.limit_remaining : credits - used;
      } else {
        // Fallback: /api/v1/auth/key
        const r2 = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r2.ok) { setAll(`${icon('zap', 13)} —`, 'var(--text3)'); return; }
        const d = (await r2.json())?.data ?? {};
        credits = d.limit ?? 0;
        used    = d.usage ?? 0;
        balance = d.limit_remaining !== undefined ? d.limit_remaining : credits - used;
      }

      const color = balance < 1 ? C.rose : balance < 5 ? C.amber : C.emerald;
      const title = `Баланс OpenRouter: $${balance.toFixed(4)}\nЛимит: $${credits.toFixed(2)} · Использовано: $${used.toFixed(4)}`;
      setAll(`${icon('zap', 13)} $${balance.toFixed(2)}`, color, title);
    } catch { setAll(`${icon('zap', 13)} —`, 'var(--text3)'); }
  }

  // ── НАСТРОЙКИ ───────────────────────────────────────────────────────────

  private renderSettings(): string {
    const pages: Array<{ key: string; title: string; link: string }> = [
      { key: 'privacy_policy',   title: 'Политика конфиденциальности',      link: '/privacy.html' },
      { key: 'legal_requisites', title: 'Реквизиты и правовая информация',  link: '/legal.html' },
      { key: 'offer',            title: 'Публичная оферта',                 link: '/offer.html' },
    ];
    const pageEditors = pages.map(p => {
      const sc = this.siteContent.find(c => c.key === p.key);
      const title = sc?.title ?? p.title;
      const content = sc?.content ?? '';
      const updated = sc?.updated_at ? `Изменено: ${adminService.fmtDate(sc.updated_at)}` : 'Ещё не редактировалось';
      return `
        <div class="ap-card">
          <div class="ap-card-head">
            <div>
              <div class="ap-card-title">${this.esc(title)}</div>
              <div class="ap-card-desc">${updated}</div>
            </div>
            <a href="${p.link}" target="_blank" rel="noopener" class="ap-btn ap-btn-sm">${icon('external', 13)} Открыть</a>
          </div>
          <div class="ap-form">
            <div class="ap-field">
              <label class="ap-label">Заголовок страницы</label>
              <input class="ap-input" id="page-title-${p.key}" value="${this.esc(title)}">
            </div>
            <div class="ap-field">
              <label class="ap-label">Содержимое (HTML или текст)</label>
              <textarea class="ap-textarea" id="page-content-${p.key}" rows="10" style="font-family:'DM Mono',ui-monospace,monospace;font-size:12px">${this.esc(content)}</textarea>
            </div>
            <button class="ap-btn ap-btn-primary" data-action="save-page" data-page-key="${p.key}">Сохранить страницу</button>
          </div>
        </div>`;
    }).join('');

    const adminsTable = `
      <div class="ap-table-wrap" style="margin-top:14px">
        <table class="ap-table">
          <thead><tr><th>Пользователь</th><th>Роль</th><th>Добавлен</th><th style="width:56px"></th></tr></thead>
          <tbody>${this.platformAdmins.length === 0
            ? `<tr><td colspan="4" class="ap-empty-cell">Нет данных</td></tr>`
            : this.platformAdmins.map(ad => {
                const rm = ROLE_META[ad.role] ?? { label: ad.role, color: '#64748b' };
                return `<tr class="ap-tr">
                  <td>
                    <div class="ap-ident-name">${this.esc(ad.first_name)} ${this.esc(ad.last_name ?? '')}</div>
                    <div class="ap-ident-sub">${ad.telegram_username ? '@' + this.esc(ad.telegram_username) : ''}</div>
                  </td>
                  <td><span class="ap-badge" style="background:color-mix(in srgb, ${rm.color} 16%, transparent);color:${rm.color}">${rm.label}</span></td>
                  <td class="ap-td-muted">${adminService.fmtDate(ad.created_at)}</td>
                  <td><button class="ap-icon-btn sm danger" data-action="revoke-role" data-uid="${ad.user_id}" title="Отозвать права">${icon('ban', 14)}</button></td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>`;

    return `
      <div class="ap-settings">
        <div class="ap-card ap-wide">
          <div class="ap-card-title">Права администратора</div>
          <div class="ap-card-desc">Выдача и отзыв доступа к этой панели</div>
          <div class="ap-form">
            <div class="ap-field">
              <label class="ap-label">Пользователь</label>
              ${this.renderPicker('grant-user', '', '', 'Найти пользователя…')}
            </div>
            <div class="ap-field">
              <label class="ap-label">Роль</label>
              <select class="ap-select" id="grant-admin-role">
                <option value="support">Support — просмотр</option>
                <option value="billing">Billing — тарифы и промокоды</option>
                <option value="admin">Admin — полный доступ</option>
              </select>
            </div>
            <button class="ap-btn ap-btn-primary" id="grant-admin-btn">Выдать права</button>
          </div>
          ${adminsTable}
        </div>

        <div class="ap-card">
          <div class="ap-card-title">AI-ассистент «Сима»</div>
          <div class="ap-card-desc">Подключается через OpenRouter. Ключ хранится в базе. Модель каждый пользователь выбирает сам в настройках Симы.</div>
          <div class="ap-form">
            <div class="ap-field">
              <label class="ap-label">OpenRouter API Key</label>
              <input class="ap-input" id="ai-key-input" type="password" placeholder="sk-or-v1-…" autocomplete="off" value="${this.esc(this.getCurrentAiKey())}">
            </div>
            <div style="display:flex;gap:10px;align-items:center">
              <button class="ap-btn ap-btn-primary" id="save-ai-config-btn">Сохранить</button>
              <span class="ap-status-msg" id="ai-config-status"></span>
            </div>
            <div class="ap-or-balance-card">
              <div class="ap-or-balance-label">${icon('zap', 14)} Баланс OpenRouter</div>
              <div class="ap-or-balance-value" data-or-balance>${icon('zap', 14)} …</div>
              <a href="https://openrouter.ai/credits" target="_blank" rel="noopener" class="ap-or-balance-link">Пополнить →</a>
            </div>
            <div class="ap-note">
              Рекомендуемые модели: <b>anthropic/claude-haiku-4-5</b> (быстрая и дешёвая),
              <b>anthropic/claude-sonnet-5</b> (умная), <b>deepseek/deepseek-chat</b> (экономичная).<br>
              Ключ: <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>
            </div>
          </div>
        </div>

        <div class="ap-card">
          <div class="ap-card-title">Вход разработчиков и проверяющих</div>
          <div class="ap-card-desc">Email/password-аккаунты для входа без Telegram и Яндекса. Смена без знания старого пароля.</div>
          <div id="ap-reviewer-accounts" style="margin-top:14px">
            <button class="ap-btn" id="load-reviewer-accounts-btn">Загрузить аккаунты</button>
          </div>
          <div id="ap-reviewer-form" style="display:none">
            <div class="ap-form">
              <div class="ap-field">
                <label class="ap-label">Аккаунт</label>
                <select class="ap-select" id="reviewer-account-select"></select>
              </div>
              <div class="ap-field">
                <label class="ap-label">Новый email <span class="ap-optional">(необязательно)</span></label>
                <input class="ap-input" id="reviewer-new-email" type="email" placeholder="Оставьте пустым — не менять">
              </div>
              <div class="ap-field">
                <label class="ap-label">Новый пароль <span class="ap-optional">(необязательно)</span></label>
                <input class="ap-input" id="reviewer-new-password" type="text" placeholder="Оставьте пустым — не менять" autocomplete="new-password">
              </div>
              <div style="display:flex;gap:10px;align-items:center">
                <button class="ap-btn ap-btn-primary" id="reviewer-save-btn">Сохранить</button>
                <span class="ap-status-msg" id="reviewer-save-status"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="ap-card">
          <div class="ap-card-title">Быстрые ссылки</div>
          <div class="ap-form" style="gap:8px">
            <a href="/legal.html"   target="_blank" rel="noopener" class="ap-link-row">${icon('page', 15)}<span>Реквизиты</span>${icon('external', 14)}</a>
            <a href="/privacy.html" target="_blank" rel="noopener" class="ap-link-row">${icon('page', 15)}<span>Политика конфиденциальности</span>${icon('external', 14)}</a>
            <a href="/offer.html"   target="_blank" rel="noopener" class="ap-link-row">${icon('page', 15)}<span>Публичная оферта</span>${icon('external', 14)}</a>
            <a href="/info"         target="_blank" rel="noopener" class="ap-link-row">${icon('card', 15)}<span>Страница тарифов /info</span>${icon('external', 14)}</a>
          </div>
        </div>

        <div class="ap-settings-divider">Страницы сайта</div>
        ${pageEditors}
      </div>`;
  }

  // ── ДОРОЖНАЯ КАРТА ──────────────────────────────────────────────────────

  private renderRoadmap(): string {
    const quadrants: Quadrant[] = ['urgent_important', 'important_not_urgent', 'urgent_not_important', 'not_urgent_not_important'];
    const statuses: RoadmapStatus[] = ['todo', 'in_progress', 'done'];
    const STATUS_COLOR: Record<RoadmapStatus, string> = { todo: '#64748b', in_progress: C.blue, done: C.emerald };

    const filtered = this.roadmapFilter === 'all'
      ? this.roadmapTasks
      : this.roadmapTasks.filter(t => t.quadrant === this.roadmapFilter);

    const titleCount = new Map<string, number>();
    for (const t of this.roadmapTasks) {
      const key = t.title.trim().toLowerCase();
      titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
    }
    const dupCount = [...titleCount.values()].filter(n => n > 1).length;

    const card = (t: RoadmapTask) => {
      const qColor = QUADRANT_COLORS[t.quadrant];
      const isDup = (titleCount.get(t.title.trim().toLowerCase()) ?? 0) > 1;
      return `
        <div class="ap-task">
          <div class="ap-task-top">
            <span class="ap-dot" style="background:${qColor}"></span>
            <span class="ap-task-quad" style="color:${qColor}">${QUADRANT_LABELS[t.quadrant]}</span>
            ${isDup ? `<span class="ap-badge red" style="margin-left:auto">дубликат</span>` : ''}
          </div>
          <div class="ap-task-title">${this.esc(t.title)}</div>
          ${t.description ? `<div class="ap-task-desc">${this.esc(t.description)}</div>` : ''}
          <div class="ap-task-foot">
            <button class="ap-btn ap-btn-sm" data-action="roadmap-edit" data-task-id="${t.id}">Изменить</button>
            <button class="ap-icon-btn sm danger" data-action="roadmap-delete" data-task-id="${t.id}" title="Удалить задачу">${icon('trash', 13)}</button>
          </div>
        </div>`;
    };

    const kanban = statuses.map(status => {
      const cards = filtered.filter(t => t.status === status);
      return `
        <div class="ap-kanban-col" style="--kan-color:${STATUS_COLOR[status]}">
          <div class="ap-kanban-head">
            <span class="ap-dot" style="background:${STATUS_COLOR[status]}"></span>
            <span class="ap-kanban-title">${STATUS_LABELS[status]}</span>
            <span class="ap-kanban-count">${cards.length}</span>
          </div>
          ${cards.length ? cards.map(card).join('') : `<div class="ap-kanban-empty">Нет задач</div>`}
        </div>`;
    }).join('');

    const dupBanner = dupCount > 0 ? `
      <div class="ap-banner warn">
        ${icon('warn', 18)}
        <div class="ap-banner-body">Обнаружено <b style="display:inline">${dupCount}</b> групп задач с одинаковым названием — вероятно, дубликаты.</div>
        <button class="ap-btn ap-btn-danger ap-btn-sm" data-action="roadmap-dedup">Удалить дубликаты</button>
      </div>` : '';

    const filters: Array<{ key: string; label: string; color?: string }> = [
      { key: 'all', label: 'Все' },
      ...quadrants.map(q => ({ key: q, label: QUADRANT_LABELS[q], color: QUADRANT_COLORS[q] })),
    ];

    const form = this.roadmapFormOpen ? `
      <div class="ap-card" style="margin-bottom:16px">
        <div class="ap-card-title">${this.roadmapEditing ? 'Редактировать задачу' : 'Новая задача'}</div>
        <div class="ap-form">
          <div class="ap-field">
            <label class="ap-label">Заголовок *</label>
            <input class="ap-input" id="rm-title" value="${this.esc(this.roadmapForm.title)}" placeholder="Что нужно сделать?">
          </div>
          <div class="ap-field">
            <label class="ap-label">Описание</label>
            <textarea class="ap-textarea" id="rm-desc" rows="3" placeholder="Подробности, ссылки, контекст…">${this.esc(this.roadmapForm.description)}</textarea>
          </div>
          <div class="ap-form-2">
            <div class="ap-field">
              <label class="ap-label">Приоритет (квадрант)</label>
              <select class="ap-select" id="rm-quadrant">
                ${quadrants.map(q => `<option value="${q}"${this.roadmapForm.quadrant === q ? ' selected' : ''}>${QUADRANT_LABELS[q]}</option>`).join('')}
              </select>
            </div>
            <div class="ap-field">
              <label class="ap-label">Статус</label>
              <select class="ap-select" id="rm-status">
                ${(Object.keys(STATUS_LABELS) as RoadmapStatus[]).map(s => `<option value="${s}"${this.roadmapForm.status === s ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="ap-btn" data-action="roadmap-cancel">Отмена</button>
            <button class="ap-btn ap-btn-primary" data-action="roadmap-save">${this.roadmapEditing ? 'Сохранить изменения' : 'Создать задачу'}</button>
          </div>
        </div>
      </div>` : '';

    return `
      ${dupBanner}
      <div class="ap-toolbar">
        <div class="ap-segment">
          ${filters.map(f => `<button class="${this.roadmapFilter === f.key ? 'active' : ''}" data-action="roadmap-filter" data-filter="${f.key}">
            ${f.color ? `<span class="ap-dot" style="background:${f.color}"></span>` : ''}${f.label}
          </button>`).join('')}
        </div>
        <div class="ap-toolbar-info">${filtered.length !== this.roadmapTasks.length ? `${filtered.length} / ` : ''}${this.roadmapTasks.length} задач</div>
        <button class="ap-btn ap-btn-primary" data-action="roadmap-new">${icon('plus', 15)} Новая задача</button>
      </div>
      ${form}
      <div class="ap-kanban">${kanban}</div>`;
  }

  // ── СОБЫТИЯ ─────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.el.querySelectorAll<HTMLElement>('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab as AdminTab));
    });

    this.el.querySelector('#ap-exit')?.addEventListener('click', () => window.app?.navigateTo?.('profile'));
    this.el.querySelector('#ap-refresh')?.addEventListener('click', () => this.loadTab());
    this.el.querySelector('#ap-refresh-empty')?.addEventListener('click', () => this.loadTab());

    this.debouncedSearch('#ap-user-search', v => { this.userSearch = v; this.loadTab(); });
    this.debouncedSearch('#ap-company-search', v => { this.companySearch = v; this.loadTab(); });
    this.debouncedSearch('#ap-api-search', v => { this.apiSearch = v; this.loadTab(); });

    this.el.querySelectorAll<HTMLElement>('[data-api-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.apiFilter = btn.dataset.apiFilter as typeof this.apiFilter;
        this.render();
      });
    });

    this.el.querySelectorAll<HTMLElement>('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.handleAction(btn); });
    });

    if (this.tab === 'support' && !this.loading) this.bindSupportEvents();
    if (['overview', 'settings'].includes(this.tab) && !this.loading) void this.refreshOrBalance();

    this.el.querySelector('#promo-back')?.addEventListener('click', () => { this.activePromo = null; this.render(); });
    this.el.querySelector('#sub-save')?.addEventListener('click', () => this.handleSetSubscription());
    this.el.querySelector('#trial-save')?.addEventListener('click', () => this.handleExtendTrial());
    this.el.querySelector('#promo-create')?.addEventListener('click', () => this.handleCreatePromo());
    this.el.querySelector('#grant-admin-btn')?.addEventListener('click', () => this.handleGrantAdmin());
    this.el.querySelector('#save-ai-config-btn')?.addEventListener('click', () => this.handleSaveAiConfig());
    this.el.querySelector('#load-reviewer-accounts-btn')?.addEventListener('click', () => this.loadReviewerAccounts());
    this.el.querySelector('#reviewer-save-btn')?.addEventListener('click', () => this.handleReviewerSave());

    this.el.querySelector<HTMLInputElement>('#promo-code')?.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      t.value = t.value.toUpperCase();
    });

    this.el.querySelectorAll<HTMLElement>('.ap-picker').forEach(p => this.bindPickerEvents(p));

    if (this.tab === 'news' && !this.loading) this.bindNewsEvents();
    if (this.tab === 'brain' && !this.loading) this.bindBrainEvents();
    if (this.tab === 'notifications' && !this.loading) this.bindNotificationsEvents();
  }

  private debouncedSearch(sel: string, cb: (value: string) => void): void {
    const input = this.el.querySelector<HTMLInputElement>(sel);
    if (!input) return;
    let t: ReturnType<typeof setTimeout>;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => cb(input.value), 350);
    });
  }

  // ── ПИКЕР ───────────────────────────────────────────────────────────────

  private bindPickerEvents(picker: HTMLElement): void {
    const kind = picker.dataset.picker ?? '';
    const input = picker.querySelector<HTMLInputElement>('.ap-picker-input');
    const hidden = picker.querySelector<HTMLInputElement>('.ap-picker-value');
    const dropdown = picker.querySelector<HTMLElement>('.ap-picker-dropdown');
    const clearBtn = picker.querySelector<HTMLElement>('.ap-picker-clear');
    if (!input || !hidden || !dropdown) return;

    clearBtn?.addEventListener('click', () => {
      hidden.value = ''; input.value = '';
      if (kind === 'user') this.picker = { ...this.picker, userId: '', userName: '' };
      if (kind === 'company') this.picker = { ...this.picker, companyId: '', companyName: '' };
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
    this._cleanups.push(() => document.removeEventListener('click', closeOnOutside));
  }

  private async fetchPickerResults(
    kind: string, q: string,
    dropdown: HTMLElement, hidden: HTMLInputElement, input: HTMLInputElement,
  ): Promise<void> {
    const isUser = kind === 'user' || kind === 'trial-user' || kind === 'grant-user';
    let html = '';

    if (isUser) {
      const items = await adminService.searchUsers(q);
      html = items.length === 0
        ? '<div class="ap-picker-empty">Не найдено</div>'
        : items.map(u => `
          <div class="ap-picker-item" data-id="${u.id}" data-name="${this.esc(`${u.first_name} ${u.last_name ?? ''}`.trim())}">
            ${this.avatar(u.photo_url, u.first_name, 'sm')}
            <div style="min-width:0">
              <div class="ap-picker-item-name">${this.esc(u.first_name)} ${this.esc(u.last_name ?? '')}</div>
              <div class="ap-picker-item-sub">${u.telegram_username ? '@' + this.esc(u.telegram_username) + ' · ' : ''}${u.company_count} компаний</div>
            </div>
          </div>`).join('');
    } else {
      const items = await adminService.searchCompanies(q);
      html = items.length === 0
        ? '<div class="ap-picker-empty">Не найдено</div>'
        : items.map(c => `
          <div class="ap-picker-item" data-id="${c.id}" data-name="${this.esc(c.name)}">
            <div class="ap-logo" style="width:28px;height:28px;font-size:11px;background:${this.esc(c.color ?? C.indigo)}">${this.esc((c.name?.[0] ?? '?').toUpperCase())}</div>
            <div style="min-width:0">
              <div class="ap-picker-item-name">${this.esc(c.name)}</div>
              <div class="ap-picker-item-sub">${c.owner_first_name ? this.esc(c.owner_first_name) + ' · ' : ''}${c.member_count} участников</div>
            </div>
          </div>`).join('');
    }

    dropdown.innerHTML = html;
    dropdown.style.display = 'block';

    dropdown.querySelectorAll<HTMLElement>('.ap-picker-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id ?? '';
        const name = item.dataset.name ?? '';
        hidden.value = id;
        input.value = name;
        dropdown.style.display = 'none';
        if (kind === 'user') this.picker = { ...this.picker, userId: id, userName: name };
        if (kind === 'company') this.picker = { ...this.picker, companyId: id, companyName: name };
      });
    });
  }

  // ── ОБРАБОТЧИКИ ДЕЙСТВИЙ ────────────────────────────────────────────────

  private async handleAction(btn: HTMLElement): Promise<void> {
    const action = btn.dataset.action;
    const uid = btn.dataset.uid;
    const promoId = btn.dataset.promoId;
    const cid = btn.dataset.cid;
    const cname = btn.dataset.cname;
    const planKey = btn.dataset.plan;

    switch (action) {
      case 'revoke-role':
        if (uid) await this.handleRevokeRole(uid);
        return;

      case 'delete-user': {
        if (!uid) return;
        const uname = btn.dataset.uname ?? uid;
        const msg = `Полностью удалить пользователя «${uname}»?\n\nВсе данные (членство в компаниях, подписки, обращения) будут удалены. Права администратора, если есть, будут отозваны.\n\nЭто действие нельзя отменить.`;
        if (!confirm(msg)) return;
        try {
          await adminService.deleteUser(uid);
          showToast(`Пользователь «${uname}» удалён`, 'success');
          this.loadTab();
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'ban': {
        if (!uid) return;
        if (!confirm('Заблокировать пользователя на 30 дней?')) return;
        const until = new Date(); until.setDate(until.getDate() + 30);
        await adminService.banUser(uid, until);
        showToast('Пользователь заблокирован', 'success');
        this.loadTab();
        return;
      }

      case 'unban':
        if (!uid) return;
        await adminService.banUser(uid, null);
        showToast('Блокировка снята', 'success');
        this.loadTab();
        return;

      case 'extend-trial': {
        if (!uid) return;
        const days = parseInt(prompt('Продлить пробный период на сколько дней?', '14') ?? '0', 10);
        if (!days || isNaN(days)) return;
        await adminService.extendTrial(uid, days);
        showToast(`Пробный период продлён на ${days} дн.`, 'success');
        this.loadTab();
        return;
      }

      case 'set-trial-days': {
        if (!uid) return;
        const input = btn.closest('td')?.querySelector<HTMLInputElement>('.ap-trial-input');
        const days = parseInt(input?.value ?? '0', 10);
        if (!days || isNaN(days) || days < 1) { showToast('Введите корректное число дней', 'error'); return; }
        try {
          await adminService.extendTrial(uid, days);
          showToast(`Пробный период: ${days} дн.`, 'success');
          this.loadTab();
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'delete-company': {
        if (!cid) return;
        if (!confirm(`Удалить компанию «${cname}»?\n\nВсе данные компании будут удалены. Это действие нельзя отменить.`)) return;
        try {
          await adminService.deleteCompany(cid);
          showToast(`Компания «${cname}» удалена`, 'success');
          this.loadTab();
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'toggle-promo': {
        if (!promoId) return;
        const active = btn.dataset.active === 'true';
        await adminService.togglePromo(promoId, !active);
        showToast(active ? 'Промокод отключён' : 'Промокод включён', 'success');
        this.loadTab();
        return;
      }

      case 'delete-promo': {
        if (!promoId) return;
        const code = btn.dataset.promoCode ?? promoId;
        if (!confirm(`Удалить промокод «${code}»?\n\nВсе записи об использовании будут удалены. Это действие нельзя отменить.`)) return;
        try {
          await adminService.deletePromo(promoId);
          showToast(`Промокод «${code}» удалён`, 'success');
          this.loadTab();
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'open-promo': {
        const id = btn.closest<HTMLElement>('[data-promo-id]')?.dataset.promoId ?? promoId;
        const p = this.promos.find(x => x.id === id);
        if (p) await this.openPromo(p);
        return;
      }

      case 'quick-extend': {
        if (!cid) return;
        const co = this.apiCompanies.find(c => c.id === cid);
        try {
          await adminService.extendSubscription(cid, 30);
          showToast(`Подписка ${co ? `«${co.name}» ` : ''}продлена на 30 дней`, 'success');
          this.loadTab();
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'edit-extend':
        if (!cid) return;
        this.inlineEdit = this.inlineEdit === cid ? null : cid;
        this.render();
        return;

      case 'cancel-extend':
        this.inlineEdit = null;
        this.render();
        return;

      case 'confirm-extend': {
        if (!cid) return;
        await this.handleConfirmExtend(cid);
        return;
      }

      case 'save-plan': {
        if (!planKey) return;
        const price = parseInt(this.val(`#plan-price-${planKey}`) || '0', 10);
        const min = parseInt(this.val(`#plan-min-${planKey}`) || '0', 10);
        const maxRaw = this.val(`#plan-max-${planKey}`);
        const max = maxRaw ? parseInt(maxRaw, 10) : null;
        try {
          await adminService.updatePlan(planKey, price, min, max);
          showToast('Тариф обновлён', 'success');
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'save-ai-boost-price': {
        const pkgKey = btn.dataset.pkg ?? '';
        if (!pkgKey) return;
        const price = parseInt(this.val(`#ai-boost-price-${pkgKey}`) || '0', 10);
        if (isNaN(price) || price < 0) { showToast('Некорректная цена', 'error'); return; }
        try {
          const current = await adminService.getAiBoostPrices();
          const updated = { ...current, [pkgKey]: price };
          await adminService.updateAiBoostPrices(updated);
          this.aiBoostPrices = updated;
          setAiBoostPriceOverrides(updated);
          showToast('Цена пакета обновлена', 'success');
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'save-page': {
        const key = btn.dataset.pageKey ?? '';
        if (!key) return;
        const title = this.val(`#page-title-${key}`).trim();
        const content = this.val(`#page-content-${key}`);
        try {
          await adminService.saveSiteContent(key, title, content);
          showToast('Страница сохранена', 'success');
          this.siteContent = await adminService.getSiteContent();
          this.render();
        } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
        return;
      }

      case 'roadmap-filter':
        this.roadmapFilter = (btn.dataset.filter ?? 'all') as Quadrant | 'all';
        this.render();
        return;
      case 'roadmap-new':    this.handleRoadmapNew(); return;
      case 'roadmap-cancel': this.handleRoadmapCancel(); return;
      case 'roadmap-save':   await this.handleRoadmapSave(); return;
      case 'roadmap-edit':   this.handleRoadmapEdit(btn.dataset.taskId ?? ''); return;
      case 'roadmap-delete': await this.handleRoadmapDelete(btn.dataset.taskId ?? ''); return;
      case 'roadmap-dedup':  await this.handleRoadmapDedup(); return;
    }
  }

  /** Продление/сокращение подписки: относительные дни имеют приоритет над датой. */
  private async handleConfirmExtend(cid: string): Promise<void> {
    const dateVal = this.val(`#inline-date-${cid}`);
    const daysVal = parseInt(this.val(`#inline-days-${cid}`) || '0', 10);
    const co = this.apiCompanies.find(c => c.id === cid);

    let endDateISO: string;
    let toastMsg: string;

    if (daysVal !== 0 && !isNaN(daysVal)) {
      const currentEnd = co?.subscription?.current_period_end ?? co?.owner_trial_ends_at ?? null;
      const base = currentEnd ? new Date(currentEnd).getTime() : Date.now();
      endDateISO = new Date(base + daysVal * 86_400_000).toISOString();
      toastMsg = `Подписка «${co?.name ?? ''}» ${daysVal > 0 ? `продлена на ${daysVal} дн.` : `сокращена на ${Math.abs(daysVal)} дн.`}`;
    } else if (dateVal) {
      endDateISO = new Date(dateVal + 'T23:59:59').toISOString();
      toastMsg = `Дата окончания подписки «${co?.name ?? ''}» — ${new Date(dateVal).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    } else {
      showToast('Укажите дату или количество дней', 'error');
      return;
    }

    try {
      await adminService.setSubscriptionEnd(cid, endDateISO);
      showToast(toastMsg, 'success');
      this.inlineEdit = null;
      this.loadTab();
    } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
  }

  private async openPromo(p: PromoCode): Promise<void> {
    this.activePromo = p;
    this.loadingRedemptions = true;
    this.promoRedemptions = [];
    this.render();
    this.promoRedemptions = await adminService.getPromoRedemptions(p.id);
    this.loadingRedemptions = false;
    if (this.activePromo?.id === p.id) this.render();
  }

  private async handleSetSubscription(): Promise<void> {
    const uid = this.picker.userId;
    const cid = this.picker.companyId;
    const months = parseInt(this.val('#sub-months') || '1', 10);
    if (!uid) { showToast('Выберите пользователя', 'error'); return; }
    if (!cid) { showToast('Выберите компанию', 'error'); return; }
    const plan = this.plans.find(p => p.key === this.val('#sub-plan')) ?? this.plans[0];
    if (!plan) { showToast('Выберите тариф', 'error'); return; }
    try {
      await adminService.setSubscription(uid, cid, plan.key, plan.price_rub, months);
      showToast(`Подписка «${plan.label}» назначена`, 'success');
      this.picker = { userId: '', userName: '', companyId: '', companyName: '' };
      this.loadTab();
    } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
  }

  private async handleExtendTrial(): Promise<void> {
    const uid = this.el.querySelector<HTMLElement>('[data-picker="trial-user"]')
      ?.querySelector<HTMLInputElement>('.ap-picker-value')?.value ?? '';
    const days = parseInt(this.val('#trial-days') || '14', 10);
    if (!uid) { showToast('Выберите пользователя', 'error'); return; }
    try {
      await adminService.extendTrial(uid, days);
      showToast(`Пробный период продлён на ${days} дн.`, 'success');
    } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
  }

  private async handleCreatePromo(): Promise<void> {
    const code = this.val('#promo-code').trim().toUpperCase();
    const rub = parseInt(this.val('#promo-rub') || '0', 10);
    const pct = parseInt(this.val('#promo-pct') || '0', 10);
    const desc = this.val('#promo-desc').trim();
    const until = this.val('#promo-until') || null;
    const maxU = parseInt(this.val('#promo-maxuses'), 10);
    const durM = parseInt(this.val('#promo-duration'), 10);
    const maxCos = parseInt(this.val('#promo-maxcos'), 10);
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
    const picker = this.el.querySelector<HTMLElement>('[data-picker="grant-user"]');
    const uid = picker?.querySelector<HTMLInputElement>('.ap-picker-value')?.value ?? '';
    const name = picker?.querySelector<HTMLInputElement>('.ap-picker-input')?.value ?? '';
    const role = this.val('#grant-admin-role') || 'admin';
    if (!uid) { showToast('Выберите пользователя', 'error'); return; }
    try {
      await adminService.grantRole(uid, role);
      showToast(`${name || uid} — роль «${ROLE_META[role]?.label ?? role}»`, 'success');
      this.loadTab();
    } catch (e) {
      showToast(this.errText(e, 'Только суперадмин может назначать роли'), 'error');
    }
  }

  private async handleRevokeRole(uid: string): Promise<void> {
    if (!uid) return;
    if (!confirm('Отозвать права администратора у этого пользователя?')) return;
    try {
      await adminService.revokeRole(uid);
      showToast('Права отозваны', 'success');
      this.loadTab();
    } catch (e) { showToast(this.errText(e, 'Ошибка при отзыве прав'), 'error'); }
  }

  // ── КОНФИГУРАЦИЯ AI ─────────────────────────────────────────────────────

  private getCurrentAiKey(): string {
    return (window as any).sdAssistantModule?.aiKey || sessionStorage.getItem('sd_ai_key') || '';
  }

  private async handleSaveAiConfig(): Promise<void> {
    const key = this.val('#ai-key-input').trim();
    const status = this.el.querySelector<HTMLElement>('#ai-config-status');
    const setStatus = (text: string, color: string) => { if (status) { status.textContent = text; status.style.color = color; } };

    if (!key) { setStatus('Введите API-ключ', C.amber); return; }
    setStatus('Сохраняю…', 'var(--text3)');

    try {
      await adminService.saveSiteContent('ai_openrouter_key', 'AI OpenRouter Key', key);

      sessionStorage.setItem('sd_ai_key', key);

      window.dispatchEvent(new CustomEvent('sd_ai_config_updated'));
      (window as any).sdAssistantModule?.updateConfig(key);

      setStatus('Сохранено', C.emerald);
      setTimeout(() => setStatus('', 'var(--text3)'), 3000);
    } catch (e) { setStatus('Ошибка: ' + this.errText(e), C.rose); }
  }

  // ── АККАУНТЫ ПРОВЕРЯЮЩИХ ────────────────────────────────────────────────

  private async loadReviewerAccounts(): Promise<void> {
    const btn = this.el.querySelector<HTMLButtonElement>('#load-reviewer-accounts-btn');
    if (btn) { btn.textContent = 'Загрузка…'; btn.disabled = true; }
    try {
      const apiUrl = import.meta.env.VITE_API_URL as string;
      const token = localStorage.getItem('access_token') ?? '';
      const res = await fetch(`${apiUrl}/functions/v1/admin-update-reviewer`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': import.meta.env.VITE_API_KEY as string },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Ошибка сервера');
      const { users } = await res.json() as { users: Array<{ id: string; email: string; created_at: string }> };

      const select = this.el.querySelector<HTMLSelectElement>('#reviewer-account-select');
      if (select) select.innerHTML = users.map(u => `<option value="${u.id}">${this.esc(u.email)}</option>`).join('');

      const accountsDiv = this.el.querySelector<HTMLElement>('#ap-reviewer-accounts');
      if (accountsDiv) accountsDiv.style.display = 'none';
      const form = this.el.querySelector<HTMLElement>('#ap-reviewer-form');
      if (form) form.style.display = 'block';
    } catch (e) {
      if (btn) { btn.textContent = `Ошибка: ${this.errText(e)}`; btn.disabled = false; }
    }
  }

  private async handleReviewerSave(): Promise<void> {
    const select = this.el.querySelector<HTMLSelectElement>('#reviewer-account-select');
    const emailEl = this.el.querySelector<HTMLInputElement>('#reviewer-new-email');
    const passEl = this.el.querySelector<HTMLInputElement>('#reviewer-new-password');
    const statusEl = this.el.querySelector<HTMLElement>('#reviewer-save-status');
    const btn = this.el.querySelector<HTMLButtonElement>('#reviewer-save-btn');
    const setStatus = (text: string, color: string) => { if (statusEl) { statusEl.textContent = text; statusEl.style.color = color; } };

    const userId = select?.value;
    const newEmail = emailEl?.value.trim() ?? '';
    const newPass = passEl?.value ?? '';

    if (!userId) return;
    if (!newEmail && !newPass) { setStatus('Введите новый email или пароль', C.amber); return; }

    // Защита от случайного нажатия — подтверждение с перечнем изменений.
    const emailHint = select!.options[select!.selectedIndex]?.text ?? userId;
    const changes: string[] = [];
    if (newEmail) changes.push(`email → ${newEmail}`);
    if (newPass) changes.push('пароль → (новый)');
    if (!confirm(`Изменить данные аккаунта «${emailHint}»?\n\n${changes.join('\n')}\n\nИзменения вступят в силу немедленно.`)) return;

    if (btn) btn.disabled = true;
    setStatus('Сохраняю…', 'var(--text3)');

    try {
      const apiUrl = import.meta.env.VITE_API_URL as string;
      const token = localStorage.getItem('access_token') ?? '';
      const body: Record<string, string> = { user_id: userId };
      if (newEmail) body.email = newEmail;
      if (newPass) body.password = newPass;

      const res = await fetch(`${apiUrl}/functions/v1/admin-update-reviewer`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': import.meta.env.VITE_API_KEY as string,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Ошибка сервера');

      if (emailEl) emailEl.value = '';
      if (passEl) passEl.value = '';
      setStatus('Сохранено', C.emerald);
      setTimeout(() => setStatus('', 'var(--text3)'), 3000);
      if (newEmail && select) {
        const opt = select.options[select.selectedIndex];
        if (opt) opt.text = newEmail;
      }
    } catch (e) {
      setStatus('Ошибка: ' + this.errText(e), C.rose);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── ДОРОЖНАЯ КАРТА: ДЕЙСТВИЯ ────────────────────────────────────────────

  private handleRoadmapNew(): void {
    this.roadmapFormOpen = true;
    this.roadmapEditing = null;
    this.roadmapForm = { title: '', description: '', quadrant: 'important_not_urgent', status: 'todo' };
    this.render();
    this.el.querySelector<HTMLInputElement>('#rm-title')?.focus();
  }

  private handleRoadmapEdit(id: string): void {
    const t = this.roadmapTasks.find(x => x.id === id);
    if (!t) return;
    this.roadmapFormOpen = true;
    this.roadmapEditing = t;
    this.roadmapForm = { title: t.title, description: t.description, quadrant: t.quadrant, status: t.status };
    this.render();
    this.el.querySelector<HTMLInputElement>('#rm-title')?.focus();
  }

  private handleRoadmapCancel(): void {
    this.roadmapFormOpen = false;
    this.roadmapEditing = null;
    this.render();
  }

  private async handleRoadmapSave(): Promise<void> {
    const title = this.val('#rm-title').trim();
    const description = this.val('#rm-desc').trim();
    const quadrant = this.val('#rm-quadrant') as Quadrant;
    const status = this.val('#rm-status') as RoadmapStatus;
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
    } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
  }

  private async handleRoadmapDelete(id: string): Promise<void> {
    if (!id) return;
    if (!confirm('Удалить задачу?')) return;
    try {
      await roadmapDb.deleteTask(id);
      showToast('Задача удалена', 'success');
      this.loadTab();
    } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
  }

  private async handleRoadmapDedup(): Promise<void> {
    const seen = new Set<string>();
    const toDelete: string[] = [];
    for (const t of this.roadmapTasks) {
      const key = t.title.trim().toLowerCase();
      if (seen.has(key)) toDelete.push(t.id); else seen.add(key);
    }
    if (!toDelete.length) { showToast('Дубликатов не найдено', 'info'); return; }
    if (!confirm(`Удалить ${toDelete.length} дубликат(ов)? Останется по одной задаче каждого названия.`)) return;
    try {
      await Promise.all(toDelete.map(id => roadmapDb.deleteTask(id)));
      showToast(`Удалено дубликатов: ${toDelete.length}`, 'success');
      this.loadTab();
    } catch (e) { showToast('Ошибка: ' + this.errText(e), 'error'); }
  }

  // ── УТИЛИТЫ ─────────────────────────────────────────────────────────────

  private esc(s: string | null | undefined): string {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private errText(e: unknown, fallback = 'неизвестная ошибка'): string {
    if (e instanceof Error && e.message) return e.message;
    const s = String(e ?? '');
    return s && s !== '[object Object]' ? s : fallback;
  }

  /** Значение поля внутри панели по CSS-селектору. */
  private val(sel: string): string {
    const el = this.el.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(sel);
    return el?.value ?? '';
  }

  private avatar(photo: string | null, name: string, size: '' | 'sm' | 'lg' = ''): string {
    const cls = `ap-avatar${size ? ' ' + size : ''}`;
    return photo
      ? `<div class="${cls}"><img src="${this.esc(photo)}" alt=""></div>`
      : `<div class="${cls}">${this.esc((name?.[0] ?? '?').toUpperCase())}</div>`;
  }

  private companyLogo(logo: string | null, name: string, color?: string | null): string {
    return logo
      ? `<div class="ap-logo"><img src="${this.esc(logo)}" alt=""></div>`
      : `<div class="ap-logo" style="background:${this.esc(color ?? C.indigo)}">${this.esc((name?.[0] ?? '?').toUpperCase())}</div>`;
  }

  private emptyState(ico: string, title: string, desc: string): string {
    return `<div class="ap-empty">
      ${icon(ico, 34, 1.4)}
      <div class="ap-empty-title">${title}</div>
      <div class="ap-empty-desc">${desc}</div>
      <button class="ap-btn" id="ap-refresh-empty">${icon('refresh', 14)} Обновить</button>
    </div>`;
  }

  // ── НОВОСТИ МП ──────────────────────────────────────────────────────────────

  private async loadNewsData(): Promise<void> {
    const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
    const [chRes, newsRes, attRes] = await Promise.all([
      fetch(`${REST_URL}/mp_news_channels?select=*&order=mp.asc,created_at.asc`, { headers: getAuthHeaders() }),
      fetch(`${REST_URL}/mp_news?select=*&order=published_at.desc&limit=30`, { headers: getAuthHeaders() }),
      fetch(`${REST_URL}/mp_news_attachments?select=*&order=created_at.asc`, { headers: getAuthHeaders() }),
    ]);
    this.newsChannels = chRes.ok ? await chRes.json() : [];
    const items: typeof this.newsItems = newsRes.ok ? await newsRes.json() : [];
    const atts: Array<{ id: string; news_id: string; file_url: string; file_type: string; file_name?: string }> = attRes.ok ? await attRes.json() : [];
    this.newsItems = items.map(n => ({
      ...n,
      attachments: atts.filter(a => a.news_id === n.id),
    }));
  }

  private async _uploadNewsAttachment(file: File, newsId: string): Promise<string> {
    const apiUrl = import.meta.env.VITE_API_URL as string;
    const apiKey = import.meta.env.VITE_API_KEY as string;
    const token = localStorage.getItem('access_token');
    const rawExt = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const safeExt = ['jpg','jpeg','png','webp','gif','mp4','mov','webm'].includes(rawExt) ? rawExt : 'bin';
    const path = `${newsId}/${Date.now()}.${safeExt}`;
    const res = await fetch(`${apiUrl}/storage/v1/object/mp-news-media/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token ?? apiKey}`,
        'apikey': apiKey,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { message?: string }).message || `Upload failed ${res.status}`);
    }
    return `${apiUrl}/storage/v1/object/public/mp-news-media/${path}`;
  }

  private renderNews(): string {
    const MP_OPTIONS = [
      { v: 'wb',      l: 'Wildberries' },
      { v: 'ozon',    l: 'Ozon' },
      { v: 'yandex',  l: 'Яндекс Маркет' },
      { v: 'general', l: 'Общее / другое' },
    ];
    const MP_COLORS: Record<string, string> = {
      wb: '#cb11ab', ozon: '#005bff', yandex: '#ffd700', general: '#6366f1',
    };
    const mpSelectOpts = MP_OPTIONS.map(o => `<option value="${o.v}">${o.l}</option>`).join('');

    const channelRows = this.newsChannels.length
      ? this.newsChannels.map(ch => {
          const color = MP_COLORS[ch.mp] ?? '#6366f1';
          const mpLabel = MP_OPTIONS.find(o => o.v === ch.mp)?.l ?? ch.mp;
          return `<tr data-channel-id="${this.esc(ch.id)}">
            <td><span class="ap-news-mp-badge" style="background:${color}40;color:${color}">${this.esc(mpLabel)}</span></td>
            <td><code class="ap-news-slug">@${this.esc(ch.channel_slug)}</code></td>
            <td>${this.esc(ch.label ?? '—')}</td>
            <td>
              <label class="ap-news-toggle">
                <input type="checkbox" class="news-ch-enabled" data-id="${this.esc(ch.id)}" ${ch.enabled ? 'checked' : ''}>
                <span class="ap-news-toggle-track"></span>
              </label>
            </td>
            <td>
              <button class="ap-btn-icon news-ch-delete" data-id="${this.esc(ch.id)}" title="Удалить канал">${icon('trash', 14)}</button>
            </td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="ap-news-empty-row">Каналов пока нет — добавьте первый ниже</td></tr>`;

    const newsRows = this.newsItems.length
      ? this.newsItems.map(n => {
          const color = MP_COLORS[n.mp] ?? '#6366f1';
          const mpLabel = MP_OPTIONS.find(o => o.v === n.mp)?.l ?? n.mp;
          const date = new Date(n.published_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          const imp = n.is_important ? `<span class="ap-news-imp-badge">⚠ важно</span>` : '';
          const atts = n.attachments ?? [];
          const attThumb = atts.slice(0, 3).map(a => {
            if (a.file_type === 'video') {
              return `<span class="ap-news-att-video" title="${this.esc(a.file_name ?? 'видео')}">▶</span>`;
            }
            return `<img class="ap-news-att-thumb" src="${this.esc(a.file_url)}" alt="" loading="lazy">`;
          }).join('');
          const attExtra = atts.length > 3 ? `<span class="ap-news-att-more">+${atts.length - 3}</span>` : '';
          return `<tr data-news-id="${this.esc(n.id)}">
            <td><span class="ap-news-mp-badge" style="background:${color}40;color:${color}">${this.esc(mpLabel)}</span></td>
            <td class="ap-news-title-cell">${this.esc(n.title)} ${imp}</td>
            <td class="ap-news-sum-cell">${this.esc(n.summary)}</td>
            <td class="ap-news-att-cell">${attThumb}${attExtra}${atts.length === 0 ? '<span class="ap-news-att-none">—</span>' : ''}</td>
            <td class="ap-news-date-cell" style="white-space:nowrap">${date}</td>
            <td>${n.source_url ? `<a class="ap-news-src-link" href="${this.esc(n.source_url)}" target="_blank" rel="noopener">→</a>` : '—'}</td>
            <td class="ap-news-actions-cell">
              <button class="ap-btn-icon news-item-edit" data-id="${this.esc(n.id)}" title="Редактировать">${icon('edit', 13)}</button>
              <button class="ap-btn-icon news-item-delete" data-id="${this.esc(n.id)}" title="Удалить">${icon('trash', 13)}</button>
            </td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="7" class="ap-news-empty-row">Новостей ещё нет — запустите первый сбор или добавьте вручную</td></tr>`;

    const manualForm = this.newsManualAdd ? `
      <tr id="news-manual-row">
        <td colspan="7" style="padding:0">
          <div class="ap-news-manual-form">
            <div class="ap-news-manual-row">
              <select class="ap-input ap-news-manual-mp" id="news-manual-mp">${mpSelectOpts}</select>
              <input class="ap-input" id="news-manual-title" placeholder="Заголовок" style="flex:2">
              <label class="ap-news-manual-imp"><input type="checkbox" id="news-manual-imp"> Важно</label>
            </div>
            <div class="ap-news-manual-row">
              <textarea class="ap-input" id="news-manual-summary" placeholder="Краткое содержание (1–2 предложения)" rows="2" style="flex:1;resize:vertical"></textarea>
            </div>
            <div class="ap-news-manual-row">
              <input class="ap-input" id="news-manual-url" placeholder="Ссылка на источник (необязательно)" style="flex:1">
            </div>
            <div class="ap-news-manual-row ap-news-att-row">
              <label class="ap-news-att-label">
                ${icon('plus', 13)} Вложения (фото/видео)
                <input type="file" id="news-manual-files" multiple accept="image/*,video/*" style="display:none">
              </label>
              <div id="news-manual-files-preview" class="ap-news-files-preview"></div>
              <div style="display:flex;gap:8px;flex-shrink:0;margin-left:auto">
                <button class="ap-btn ap-btn-primary" id="news-manual-save">${icon('check', 14)} Сохранить</button>
                <button class="ap-btn" id="news-manual-cancel">Отмена</button>
              </div>
            </div>
          </div>
        </td>
      </tr>` : '';

    return `
      <div class="ap-news-wrap">

        <div class="ap-section-card">
          <div class="ap-section-hdr">
            <div>
              <div class="ap-section-title">Источники новостей (Telegram)</div>
              <div class="ap-section-sub">Каналы в формате <code>@channelname</code>. Если VPS в России — нужен прокси (<code>TG_PROXY_URL</code> в .env).</div>
            </div>
            <div class="ap-news-fetch-wrap">
              <button class="ap-btn ap-btn-primary" id="news-run-fetch" ${this.newsLoading ? 'disabled' : ''}>
                ${this.newsLoading ? icon('refresh', 14) + ' Идёт сбор…' : icon('refresh', 14) + ' Запустить сбор сейчас'}
              </button>
            </div>
          </div>

          <table class="ap-news-table">
            <thead>
              <tr>
                <th>МП</th><th>Канал</th><th>Название</th><th>Активен</th><th></th>
              </tr>
            </thead>
            <tbody id="news-ch-tbody">${channelRows}</tbody>
          </table>

          <div class="ap-news-add-form" id="news-add-form">
            <div class="ap-news-add-title">${icon('plus', 14)} Добавить канал</div>
            <div class="ap-news-add-row">
              <select class="ap-input ap-news-mp-sel" id="news-add-mp">
                ${mpSelectOpts}
              </select>
              <input class="ap-input ap-news-slug-inp" id="news-add-slug" placeholder="channelname (без @)" autocomplete="off">
              <input class="ap-input ap-news-label-inp" id="news-add-label" placeholder="Название (необязательно)">
              <button class="ap-btn ap-btn-primary" id="news-add-btn">${icon('plus', 14)} Добавить</button>
            </div>
            <div class="ap-news-add-hint">
              Telegram-канал, например <code>wbmarketplacenews</code>. Для работы с российского VPS настрой <code>TG_PROXY_URL</code> в .env.
            </div>
          </div>
        </div>

        <div class="ap-section-card">
          <div class="ap-section-hdr">
            <div>
              <div class="ap-section-title">Новости</div>
              <div class="ap-section-sub">Собранные и добавленные вручную</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="ap-btn ap-btn-primary" id="news-manual-add-btn">${icon('plus', 14)} Добавить вручную</button>
              <button class="ap-btn" id="news-clear-btn">${icon('trash', 14)} Очистить все</button>
            </div>
          </div>
          <table class="ap-news-table ap-news-items-table">
            <thead>
              <tr><th>МП</th><th>Заголовок</th><th>Краткое содержание</th><th>Вложения</th><th>Дата</th><th>Источник</th><th style="width:60px"></th></tr>
            </thead>
            <tbody id="news-items-tbody">
              ${manualForm}
              ${newsRows}
            </tbody>
          </table>
        </div>

      </div>`;
  }

  private bindNewsEvents(): void {
    const el = this.el;

    // Добавить канал
    el.querySelector('#news-add-btn')?.addEventListener('click', async () => {
      const mp    = (el.querySelector<HTMLSelectElement>('#news-add-mp'))?.value ?? '';
      const slug  = (el.querySelector<HTMLInputElement>('#news-add-slug'))?.value.trim().replace(/^@/, '') ?? '';
      const label = (el.querySelector<HTMLInputElement>('#news-add-label'))?.value.trim() ?? '';
      if (!slug) { showToast('Введите @username канала', 'error'); return; }

      const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
      const res = await fetch(`${REST_URL}/mp_news_channels`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Prefer': 'return=representation' },
        body: JSON.stringify({ mp, channel_slug: slug, label: label || null, enabled: true }),
      });
      if (!res.ok) { showToast('Ошибка добавления: ' + (await res.text()), 'error'); return; }
      showToast(`Канал @${slug} добавлен`, 'success');
      await this.loadNewsData();
      this.render();
    });

    // Включить/выключить канал
    el.querySelectorAll<HTMLInputElement>('.news-ch-enabled').forEach(inp => {
      inp.addEventListener('change', async () => {
        const id = inp.dataset.id!;
        const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
        await fetch(`${REST_URL}/mp_news_channels?id=eq.${id}`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify({ enabled: inp.checked }),
        });
        showToast(inp.checked ? 'Канал включён' : 'Канал отключён', 'success');
      });
    });

    // Удалить канал
    el.querySelectorAll<HTMLButtonElement>('.news-ch-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!;
        if (!confirm('Удалить этот канал?')) return;
        const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
        await fetch(`${REST_URL}/mp_news_channels?id=eq.${id}`, { method: 'DELETE', headers: getAuthHeaders() });
        showToast('Канал удалён', 'success');
        await this.loadNewsData();
        this.render();
      });
    });

    // Запустить сбор новостей
    el.querySelector('#news-run-fetch')?.addEventListener('click', async () => {
      this.newsLoading = true;
      this.render();
      try {
        const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
        const base = REST_URL.replace('/rest/v1', '');
        const res = await fetch(`${base}/functions/v1/telegram-auth/mp-news-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        });
        const text = await res.text();
        let data: any = {};
        try { data = JSON.parse(text); } catch { /* ignore */ }
        if (!res.ok) {
          showToast(`Ошибка ${res.status}: ${(data.error ?? text.slice(0, 120)) || 'пустой ответ'}`, 'error');
        } else if (data.ok) {
          showToast(`Сбор завершён. Сохранено: ${data.saved?.length ?? 0} новостей`, 'success');
        } else {
          showToast('Ошибка: ' + ((data.error ?? text.slice(0, 120)) || 'пустой ответ'), 'error');
        }
        await this.loadNewsData();
      } catch (e: any) {
        showToast('Ошибка запуска: ' + e.message, 'error');
      }
      this.newsLoading = false;
      this.render();
    });

    // Очистить все новости
    el.querySelector('#news-clear-btn')?.addEventListener('click', async () => {
      if (!confirm('Удалить все собранные новости?')) return;
      const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
      await fetch(`${REST_URL}/mp_news?published_at=gte.2000-01-01`, { method: 'DELETE', headers: getAuthHeaders() });
      showToast('Новости очищены', 'success');
      await this.loadNewsData();
      this.render();
    });

    // Удалить отдельную новость
    el.querySelectorAll<HTMLButtonElement>('.news-item-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!;
        if (!confirm('Удалить эту новость?')) return;
        const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
        const res = await fetch(`${REST_URL}/mp_news?id=eq.${id}`, { method: 'DELETE', headers: getAuthHeaders() });
        if (res.ok || res.status === 204) {
          this.newsItems = this.newsItems.filter(n => n.id !== id);
          const row = el.querySelector<HTMLTableRowElement>(`tr[data-news-id="${id}"]`);
          row?.remove();
          showToast('Новость удалена', 'success');
        } else {
          showToast('Ошибка удаления', 'error');
        }
      });
    });

    // Редактировать новость — inline
    el.querySelectorAll<HTMLButtonElement>('.news-item-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const item = this.newsItems.find(n => n.id === id);
        if (!item) return;
        const row = el.querySelector<HTMLTableRowElement>(`tr[data-news-id="${id}"]`);
        if (!row) return;
        const MP_OPTIONS = [
          { v: 'wb', l: 'Wildberries' }, { v: 'ozon', l: 'Ozon' },
          { v: 'yandex', l: 'Яндекс Маркет' }, { v: 'general', l: 'Общее / другое' },
        ];
        const mpOpts = MP_OPTIONS.map(o => `<option value="${o.v}" ${o.v === item.mp ? 'selected' : ''}>${o.l}</option>`).join('');
        const existingAtts = (item.attachments ?? []);
        const existingAttHtml = existingAtts.map(a => `
          <span class="ap-news-file-chip ap-news-file-chip--existing">
            ${a.file_type === 'video' ? '▶' : '🖼'} ${this.esc((a.file_name ?? a.file_url.split('/').pop() ?? '').slice(0, 20))}
            <button class="ap-news-att-del" data-att-id="${this.esc(a.id)}" data-news-id="${this.esc(id)}" title="Удалить">×</button>
          </span>`).join('');

        row.innerHTML = `<td colspan="7" style="padding:0">
          <div class="ap-news-manual-form ap-news-edit-form">
            <div class="ap-news-manual-row">
              <select class="ap-input ap-news-manual-mp" id="news-edit-mp-${id}">${mpOpts}</select>
              <input class="ap-input" id="news-edit-title-${id}" value="${this.esc(item.title)}" placeholder="Заголовок" style="flex:2">
              <label class="ap-news-manual-imp"><input type="checkbox" id="news-edit-imp-${id}" ${item.is_important ? 'checked' : ''}> Важно</label>
            </div>
            <div class="ap-news-manual-row">
              <textarea class="ap-input" id="news-edit-sum-${id}" rows="2" style="flex:1;resize:vertical">${this.esc(item.summary)}</textarea>
            </div>
            <div class="ap-news-manual-row">
              <input class="ap-input" id="news-edit-url-${id}" value="${this.esc(item.source_url ?? '')}" placeholder="Ссылка на источник" style="flex:1">
            </div>
            <div class="ap-news-manual-row ap-news-att-row">
              <label class="ap-news-att-label">
                ${icon('plus', 13)} Добавить вложения
                <input type="file" id="news-edit-files-${id}" multiple accept="image/*,video/*" style="display:none">
              </label>
              <div class="ap-news-files-preview" id="news-edit-files-preview-${id}">
                ${existingAttHtml}
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0;margin-left:auto">
                <button class="ap-btn ap-btn-primary news-edit-save" data-id="${id}">${icon('check', 14)} Сохранить</button>
                <button class="ap-btn news-edit-cancel" data-id="${id}">Отмена</button>
              </div>
            </div>
          </div>
        </td>`;

        row.querySelector<HTMLButtonElement>('.news-edit-cancel')?.addEventListener('click', () => {
          this.render();
        });

        // Файл-пикер при редактировании (label нативно открывает input — JS-click не нужен)
        row.querySelector<HTMLInputElement>(`#news-edit-files-${id}`)?.addEventListener('change', (e) => {
          const files = Array.from((e.target as HTMLInputElement).files ?? []);
          const preview = row.querySelector(`#news-edit-files-preview-${id}`)!;
          const chips = files.map(f => {
            const isVid = f.type.startsWith('video/');
            return `<span class="ap-news-file-chip">${isVid ? '▶' : '🖼'} ${this.esc(f.name.slice(0, 20))}</span>`;
          }).join('');
          // Append after existing att chips
          const existing = preview.querySelectorAll('.ap-news-file-chip--existing');
          const lastExisting = existing[existing.length - 1];
          if (lastExisting) {
            lastExisting.insertAdjacentHTML('afterend', chips);
          } else {
            preview.insertAdjacentHTML('beforeend', chips);
          }
        });

        // Удалить существующее вложение
        row.querySelectorAll<HTMLButtonElement>('.ap-news-att-del').forEach(delBtn => {
          delBtn.addEventListener('click', async () => {
            const attId = delBtn.dataset.attId!;
            const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
            await fetch(`${REST_URL}/mp_news_attachments?id=eq.${attId}`, { method: 'DELETE', headers: getAuthHeaders() });
            delBtn.closest('.ap-news-file-chip')?.remove();
            const newsItem = this.newsItems.find(n => n.id === id);
            if (newsItem?.attachments) {
              newsItem.attachments = newsItem.attachments.filter(a => a.id !== attId);
            }
          });
        });

        row.querySelector<HTMLButtonElement>('.news-edit-save')?.addEventListener('click', async () => {
          const mp    = (row.querySelector<HTMLSelectElement>(`#news-edit-mp-${id}`))?.value ?? item.mp;
          const title = (row.querySelector<HTMLInputElement>(`#news-edit-title-${id}`))?.value.trim() ?? '';
          const summary = (row.querySelector<HTMLTextAreaElement>(`#news-edit-sum-${id}`))?.value.trim() ?? '';
          const is_important = (row.querySelector<HTMLInputElement>(`#news-edit-imp-${id}`))?.checked ?? false;
          const source_url = (row.querySelector<HTMLInputElement>(`#news-edit-url-${id}`))?.value.trim() || null;
          const files = Array.from((row.querySelector<HTMLInputElement>(`#news-edit-files-${id}`))?.files ?? []);
          if (!title || !summary) { showToast('Заголовок и содержание обязательны', 'error'); return; }
          const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
          const res = await fetch(`${REST_URL}/mp_news?id=eq.${id}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ mp, title, summary, is_important, source_url }),
          });
          if (!res.ok) { showToast('Ошибка сохранения', 'error'); return; }
          // Загружаем новые вложения
          for (const file of files) {
            try {
              const fileUrl = await this._uploadNewsAttachment(file, id);
              const isVideo = file.type.startsWith('video/');
              await fetch(`${REST_URL}/mp_news_attachments`, {
                method: 'POST',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ news_id: id, file_url: fileUrl, file_type: isVideo ? 'video' : 'image', file_name: file.name }),
              });
            } catch (e: any) {
              showToast('Ошибка загрузки файла: ' + e.message, 'error');
            }
          }
          showToast('Новость обновлена', 'success');
          const { clearNewsCache } = await import('@/services/mpNewsService');
          clearNewsCache();
          await this.loadNewsData();
          this.render();
        });
      });
    });

    // Добавить вручную — показать/скрыть форму
    el.querySelector('#news-manual-add-btn')?.addEventListener('click', () => {
      this.newsManualAdd = !this.newsManualAdd;
      this.render();
    });

    // Отмена ручного добавления
    el.querySelector('#news-manual-cancel')?.addEventListener('click', () => {
      this.newsManualAdd = false;
      this.render();
    });

    // Файл-пикер для ручного добавления: показываем превью выбранных файлов
    // (label нативно открывает input — JS-click не нужен, иначе диалог открывается дважды)
    el.querySelector<HTMLInputElement>('#news-manual-files')?.addEventListener('change', (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      const preview = el.querySelector('#news-manual-files-preview')!;
      preview.innerHTML = files.map(f => {
        const isVid = f.type.startsWith('video/');
        return `<span class="ap-news-file-chip">${isVid ? '▶' : '🖼'} ${this.esc(f.name.slice(0, 20))}</span>`;
      }).join('');
    });

    // Сохранить ручную новость
    el.querySelector('#news-manual-save')?.addEventListener('click', async () => {
      const mp      = (el.querySelector<HTMLSelectElement>('#news-manual-mp'))?.value ?? 'general';
      const title   = (el.querySelector<HTMLInputElement>('#news-manual-title'))?.value.trim() ?? '';
      const summary = (el.querySelector<HTMLTextAreaElement>('#news-manual-summary'))?.value.trim() ?? '';
      const imp     = (el.querySelector<HTMLInputElement>('#news-manual-imp'))?.checked ?? false;
      const url     = (el.querySelector<HTMLInputElement>('#news-manual-url'))?.value.trim() || null;
      const files   = Array.from((el.querySelector<HTMLInputElement>('#news-manual-files'))?.files ?? []);
      if (!title || !summary) { showToast('Заголовок и содержание обязательны', 'error'); return; }
      const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
      const res = await fetch(`${REST_URL}/mp_news`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ mp, title, summary, is_important: imp, source_url: url, published_at: new Date().toISOString() }),
      });
      if (!res.ok) { showToast('Ошибка сохранения: ' + (await res.text()), 'error'); return; }
      const [saved] = await res.json() as [{ id: string }];
      // Загружаем вложения
      if (files.length > 0 && saved?.id) {
        for (const file of files) {
          try {
            const fileUrl = await this._uploadNewsAttachment(file, saved.id);
            const isVideo = file.type.startsWith('video/');
            await fetch(`${REST_URL}/mp_news_attachments`, {
              method: 'POST',
              headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ news_id: saved.id, file_url: fileUrl, file_type: isVideo ? 'video' : 'image', file_name: file.name }),
            });
          } catch (e: any) {
            showToast('Ошибка загрузки файла: ' + e.message, 'error');
          }
        }
      }
      showToast('Новость добавлена', 'success');
      this.newsManualAdd = false;
      // Сбрасываем кэш, чтобы новость появилась на Главной
      const { clearNewsCache } = await import('@/services/mpNewsService');
      clearNewsCache();
      await this.loadNewsData();
      this.render();
    });
  }

  // ── МОЗГ СИМЫ ──────────────────────────────────────────────────────────────

  private async loadBrainData(): Promise<void> {
    const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
    const [memRes, cfgRes] = await Promise.all([
      fetch(`${REST_URL}/sima_memory?select=*&order=updated_at.desc`, { headers: getAuthHeaders() }),
      fetch(`${REST_URL}/sima_config?select=*&order=key.asc`, { headers: getAuthHeaders() }),
    ]);
    this.brainEntries = memRes.ok ? await memRes.json() : [];
    this.simaConfigEntries = cfgRes.ok ? await cfgRes.json() : [];
  }

  private renderBrain(): string {
    const MP_OPTIONS = [
      { v: '', l: 'Все МП' }, { v: 'wb', l: 'Wildberries' }, { v: 'ozon', l: 'Ozon' },
      { v: 'yandex', l: 'Яндекс Маркет' }, { v: 'general', l: 'Общее' },
    ];
    const CAT_OPTIONS = [
      { v: '', l: 'Все категории' }, { v: 'fees', l: 'Комиссии' }, { v: 'logistics', l: 'Логистика' },
      { v: 'requirements', l: 'Требования' }, { v: 'promotions', l: 'Акции' },
      { v: 'tech', l: 'Технические' }, { v: 'payments', l: 'Выплаты' }, { v: 'other', l: 'Прочее' },
    ];
    const CAT_LABELS: Record<string, string> = { fees: 'Комиссии', logistics: 'Логистика', requirements: 'Требования', promotions: 'Акции', tech: 'Технические', payments: 'Выплаты', other: 'Прочее' };
    const MP_COLORS: Record<string, string> = { wb: '#cb11ab', ozon: '#005bff', yandex: '#ffd700', general: '#6366f1' };

    const filtered = this.brainEntries.filter(e =>
      (!this.brainFilter.mp || e.mp === this.brainFilter.mp) &&
      (!this.brainFilter.category || e.category === this.brainFilter.category)
    );

    const byMp: Record<string, number> = {};
    for (const e of this.brainEntries) byMp[e.mp] = (byMp[e.mp] ?? 0) + 1;

    const statsBadges = Object.entries(byMp).map(([mp, cnt]) => {
      const color = MP_COLORS[mp] ?? '#6366f1';
      const label = MP_OPTIONS.find(o => o.v === mp)?.l ?? mp;
      return `<span class="ap-brain-stat-badge" style="background:${color}20;color:${color}">${label}: ${cnt}</span>`;
    }).join('');

    const lastUpdated = this.brainEntries[0]?.updated_at
      ? new Date(this.brainEntries[0].updated_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : 'никогда';

    const rows = filtered.length
      ? filtered.map(e => {
          const color = MP_COLORS[e.mp] ?? '#6366f1';
          const mpLabel = MP_OPTIONS.find(o => o.v === e.mp)?.l ?? e.mp;
          const catLabel = CAT_LABELS[e.category] ?? e.category;
          const date = new Date(e.updated_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short' });
          const kw = e.keywords.slice(0, 5).join(', ');
          return `<tr data-brain-id="${this.esc(e.id)}">
            <td><span class="ap-news-mp-badge" style="background:${color}20;color:${color}">${this.esc(mpLabel)}</span></td>
            <td><span class="ap-brain-cat-badge">${this.esc(catLabel)}</span></td>
            <td class="ap-brain-title-cell"><strong>${this.esc(e.title)}</strong></td>
            <td class="ap-brain-kw-cell">${this.esc(kw)}</td>
            <td class="ap-brain-date-cell">${date}</td>
            <td class="ap-news-actions-cell">
              <button class="ap-btn-icon brain-entry-view" data-id="${this.esc(e.id)}" title="Просмотр/редактировать">${icon('edit', 13)}</button>
              <button class="ap-btn-icon brain-entry-delete" data-id="${this.esc(e.id)}" title="Удалить">${icon('trash', 13)}</button>
            </td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="6" class="ap-news-empty-row">
          ${this.brainEntries.length ? 'Нет записей по выбранному фильтру' : 'Мозг пуст — нажмите «Обновить мозг» чтобы Сима изучила новости'}
        </td></tr>`;

    const configHtml = this.renderSimaConfigFiles();

    return `
      <div class="ap-brain-wrap">

        <div class="ap-brain-tabs">
          <button class="ap-brain-tab ${this.simaConfigTab === 'memory' ? 'active' : ''}" data-brain-tab="memory">
            ${icon('brain', 14)} Память Симы
          </button>
          <button class="ap-brain-tab ${this.simaConfigTab === 'files' ? 'active' : ''}" data-brain-tab="files">
            ${icon('edit', 14)} Файлы Симы (промты и правила)
          </button>
        </div>

        <div id="brain-tab-memory" ${this.simaConfigTab !== 'memory' ? 'style="display:none"' : ''}>

        <div class="ap-section-card">
          <div class="ap-section-hdr">
            <div>
              <div class="ap-section-title">Память Симы</div>
              <div class="ap-section-sub">Структурированные знания о маркетплейсах. Сима использует их для точных ответов без поиска по всем файлам.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <select class="ap-input ap-brain-filter-mp" id="brain-filter-mp" style="width:140px">
                ${MP_OPTIONS.map(o => `<option value="${o.v}" ${this.brainFilter.mp === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
              </select>
              <select class="ap-input ap-brain-filter-cat" id="brain-filter-cat" style="width:160px">
                ${CAT_OPTIONS.map(o => `<option value="${o.v}" ${this.brainFilter.category === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
              </select>
              <button class="ap-btn ap-btn-primary" id="brain-update-btn" ${this.brainUpdating ? 'disabled' : ''}>
                ${this.brainUpdating ? icon('refresh', 14) + ' Обновляю…' : icon('refresh', 14) + ' Обновить мозг'}
              </button>
              <button class="ap-btn ap-btn-primary" id="brain-add-btn">${icon('plus', 14)} Добавить</button>
            </div>
          </div>

          <div class="ap-brain-stats">
            <span class="ap-brain-stat-info">${icon('brain', 14)} Всего записей: <strong>${this.brainEntries.length}</strong></span>
            <span class="ap-brain-stat-info">Обновлено: <strong>${lastUpdated}</strong></span>
            ${statsBadges}
          </div>
        </div>

        <div class="ap-section-card">
          <table class="ap-news-table ap-brain-table">
            <thead><tr><th>МП</th><th>Категория</th><th>Тема</th><th>Ключевые слова</th><th>Обновлено</th><th style="width:60px"></th></tr></thead>
            <tbody id="brain-tbody">${rows}</tbody>
          </table>
        </div>

        <!-- Модал просмотра/редактирования -->
        <div class="ap-brain-modal" id="brain-modal" style="display:none">
          <div class="ap-brain-modal-inner">
            <div class="ap-brain-modal-hdr">
              <span id="brain-modal-title">Запись памяти</span>
              <button class="ap-btn-icon" id="brain-modal-close">${icon('close', 16)}</button>
            </div>
            <div class="ap-brain-modal-body">
              <div class="ap-brain-modal-row">
                <div style="flex:0 0 140px">
                  <label class="ap-label">МП</label>
                  <select class="ap-input" id="brain-modal-mp">
                    ${MP_OPTIONS.filter(o => o.v).map(o => `<option value="${o.v}">${o.l}</option>`).join('')}
                  </select>
                </div>
                <div style="flex:0 0 180px">
                  <label class="ap-label">Категория</label>
                  <select class="ap-input" id="brain-modal-cat">
                    ${CAT_OPTIONS.filter(o => o.v).map(o => `<option value="${o.v}">${o.l}</option>`).join('')}
                  </select>
                </div>
                <div style="flex:1">
                  <label class="ap-label">Тема (заголовок)</label>
                  <input class="ap-input" id="brain-modal-title-inp" placeholder="Краткое название темы">
                </div>
              </div>
              <div>
                <label class="ap-label">Содержание (Markdown)</label>
                <textarea class="ap-input ap-brain-content-area" id="brain-modal-content" rows="10" placeholder="Актуальное знание о теме. Конкретные цифры, даты, правила."></textarea>
              </div>
              <div>
                <label class="ap-label">Ключевые слова (через запятую)</label>
                <input class="ap-input" id="brain-modal-kw" placeholder="комиссия, тариф, хранение">
              </div>
            </div>
            <div class="ap-brain-modal-footer">
              <button class="ap-btn" id="brain-modal-cancel">Отмена</button>
              <button class="ap-btn ap-btn-primary" id="brain-modal-save">${icon('check', 14)} Сохранить</button>
            </div>
          </div>
        </div>

        </div><!-- /brain-tab-memory -->

        <div id="brain-tab-files" ${this.simaConfigTab !== 'files' ? 'style="display:none"' : ''}>
          ${configHtml}
        </div>

      </div>`;
  }

  private renderSimaConfigFiles(): string {
    const entry = this.simaConfigEntries.find(e => e.key === 'system_prompt_override');
    const savedValue = entry?.value ?? '';
    const savedDate = entry?.updated_at
      ? new Date(entry.updated_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    const isEmpty = !savedValue.trim();

    const OPENROUTER_MODELS = [
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
      { id: 'anthropic/claude-3-haiku', label: 'Claude 3 Haiku (быстрый)' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (быстрый)' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'google/gemini-pro-1.5', label: 'Gemini Pro 1.5' },
    ];
    const selectedModel = localStorage.getItem('sd_prompt_editor_model') ?? OPENROUTER_MODELS[0].id;
    const modelOptions = OPENROUTER_MODELS.map(m =>
      `<option value="${this.esc(m.id)}" ${selectedModel === m.id ? 'selected' : ''}>${this.esc(m.label)}</option>`
    ).join('');

    return `
      <div class="ap-sima-cfg-wrap">
        <div class="ap-section-card" style="margin-bottom:16px">
          <div class="ap-section-hdr">
            <div>
              <div class="ap-section-title">Файлы Симы</div>
              <div class="ap-section-sub">Промт и правила поведения Симы. Изменения применяются при следующем запросе.</div>
            </div>
          </div>
        </div>

        <div class="ap-section-card ap-sima-cfg-card" id="sima-prompt-card">
          <div class="ap-sima-cfg-hdr">
            <div>
              <div class="ap-sima-cfg-title">⚠️ Полный системный промт</div>
              <div class="ap-sima-cfg-desc">Полностью заменяет встроенный промт. Оставь пустым чтобы использовать дефолтный.</div>
            </div>
            <div class="ap-sima-cfg-meta">
              ${isEmpty
                ? '<span class="ap-sima-cfg-empty-badge">не задано — используется дефолт</span>'
                : `<span class="ap-sima-cfg-date">сохранено ${savedDate}</span>`}
              <button class="ap-btn ap-btn-sm" id="sima-cfg-load-default">${icon('download', 14)} Загрузить дефолт</button>
            </div>
          </div>

          <div id="sima-diff-stats" class="ap-sima-diff-stats" style="display:none">
            <span id="sima-diff-added" class="ap-sima-diff-added"></span>
            <span id="sima-diff-removed" class="ap-sima-diff-removed"></span>
            <button class="ap-btn ap-btn-sm" id="sima-diff-toggle">Показать изменения</button>
          </div>

          <div class="ap-sima-editor-wrap">
            <textarea
              class="ap-input ap-sima-cfg-textarea"
              id="sima-cfg-system_prompt_override"
              rows="30"
              placeholder="Оставьте пустым для дефолтного промта"
            >${this.esc(savedValue)}</textarea>
            <div id="sima-diff-view" class="ap-sima-diff-view" style="display:none"></div>
          </div>

          <div class="ap-sima-cfg-footer">
            <button class="ap-btn ap-btn-primary" id="sima-prompt-save">${icon('check', 14)} Сохранить</button>
            ${!isEmpty ? `<button class="ap-btn" id="sima-prompt-reset">Сбросить к дефолту</button>` : ''}
          </div>
        </div>

        <div class="ap-section-card ap-sima-cfg-card">
          <div class="ap-sima-cfg-hdr">
            <div>
              <div class="ap-sima-cfg-title">💬 Дополнить промт через ИИ</div>
              <div class="ap-sima-cfg-desc">Опишите что нужно изменить или добавить — ИИ профессионально встроит это в промт.</div>
            </div>
            <div>
              <select class="ap-input ap-sima-ai-model-select" id="sima-ai-model">${modelOptions}</select>
            </div>
          </div>
          <textarea
            class="ap-input ap-sima-cfg-textarea"
            id="sima-ai-input"
            rows="5"
            placeholder="Например: Добавь правило что Сима всегда отвечает на русском языке и не обсуждает конкурентов..."
          ></textarea>
          <div class="ap-sima-cfg-footer">
            <button class="ap-btn ap-btn-primary" id="sima-ai-submit">${icon('sparkle', 14)} Отправить ИИ</button>
            <span id="sima-ai-status" class="ap-sima-ai-status"></span>
          </div>
        </div>
      </div>`;
  }

  private openBrainModal(entry?: typeof this.brainEntries[0]): void {
    const el = this.el;
    const modal = el.querySelector<HTMLElement>('#brain-modal')!;
    modal.style.display = 'flex';
    modal.dataset.editId = entry?.id ?? '';
    (el.querySelector<HTMLElement>('#brain-modal-title'))!.textContent = entry ? 'Редактировать запись' : 'Новая запись';
    (el.querySelector<HTMLSelectElement>('#brain-modal-mp'))!.value = entry?.mp ?? 'general';
    (el.querySelector<HTMLSelectElement>('#brain-modal-cat'))!.value = entry?.category ?? 'other';
    (el.querySelector<HTMLInputElement>('#brain-modal-title-inp'))!.value = entry?.title ?? '';
    (el.querySelector<HTMLTextAreaElement>('#brain-modal-content'))!.value = entry?.content ?? '';
    (el.querySelector<HTMLInputElement>('#brain-modal-kw'))!.value = (entry?.keywords ?? []).join(', ');
  }

  private closeBrainModal(): void {
    const modal = this.el.querySelector<HTMLElement>('#brain-modal');
    if (modal) modal.style.display = 'none';
  }

  private bindBrainEvents(): void {
    const el = this.el;

    // Переключатель вкладок Мозга
    el.querySelectorAll<HTMLButtonElement>('[data-brain-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.simaConfigTab = btn.dataset.brainTab as 'memory' | 'files';
        this.render();
      });
    });

    // ── Файлы Симы (sima_config) ─────────────────────────────────────────────

    const ta = el.querySelector<HTMLTextAreaElement>('#sima-cfg-system_prompt_override');
    const savedValue = this.simaConfigEntries.find(e => e.key === 'system_prompt_override')?.value ?? '';
    let diffViewVisible = false;

    function computeDiff(original: string, updated: string): Array<{ type: 'same' | 'added' | 'removed'; text: string }> {
      const aLines = original.split('\n');
      const bLines = updated.split('\n');
      const m = aLines.length, n = bLines.length;
      // LCS dp
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] = aLines[i - 1] === bLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      const result: Array<{ type: 'same' | 'added' | 'removed'; text: string }> = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
          result.unshift({ type: 'same', text: aLines[i - 1] }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
          result.unshift({ type: 'added', text: bLines[j - 1] }); j--;
        } else {
          result.unshift({ type: 'removed', text: aLines[i - 1] }); i--;
        }
      }
      return result;
    }

    function updateDiffStats() {
      if (!ta) return;
      const current = ta.value;
      const statsEl = el.querySelector<HTMLElement>('#sima-diff-stats');
      if (!statsEl) return;
      if (current === savedValue) {
        statsEl.style.display = 'none';
        return;
      }
      const diff = computeDiff(savedValue, current);
      const added = diff.filter(d => d.type === 'added').length;
      const removed = diff.filter(d => d.type === 'removed').length;
      const addedEl = el.querySelector<HTMLElement>('#sima-diff-added');
      const removedEl = el.querySelector<HTMLElement>('#sima-diff-removed');
      if (addedEl) addedEl.textContent = added > 0 ? `+${added} строк` : '';
      if (removedEl) removedEl.textContent = removed > 0 ? `-${removed} строк` : '';
      statsEl.style.display = 'flex';
    }

    function renderDiffView() {
      if (!ta) return;
      const diffView = el.querySelector<HTMLElement>('#sima-diff-view');
      if (!diffView) return;
      const diff = computeDiff(savedValue, ta.value);
      diffView.innerHTML = diff.map(d => {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (d.type === 'added') return `<div class="ap-diff-line ap-diff-added">+ ${esc(d.text) || '&nbsp;'}</div>`;
        if (d.type === 'removed') return `<div class="ap-diff-line ap-diff-removed">- ${esc(d.text) || '&nbsp;'}</div>`;
        return `<div class="ap-diff-line">&nbsp;&nbsp;${esc(d.text) || '&nbsp;'}</div>`;
      }).join('');
    }

    ta?.addEventListener('input', updateDiffStats);

    // Загрузить дефолтный промт
    el.querySelector('#sima-cfg-load-default')?.addEventListener('click', async () => {
      const { getDefaultSystemPrompt } = await import('@/modules/AssistantModule').catch(() => ({ getDefaultSystemPrompt: undefined }));
      if (ta && getDefaultSystemPrompt) {
        ta.value = getDefaultSystemPrompt();
        updateDiffStats();
      } else if (ta) {
        showToast('Не удалось загрузить дефолтный промт', 'error');
      }
    });

    // Показать/скрыть diff view
    el.querySelector('#sima-diff-toggle')?.addEventListener('click', () => {
      const diffView = el.querySelector<HTMLElement>('#sima-diff-view');
      const toggleBtn = el.querySelector<HTMLButtonElement>('#sima-diff-toggle');
      if (!diffView) return;
      diffViewVisible = !diffViewVisible;
      if (diffViewVisible) {
        renderDiffView();
        diffView.style.display = 'block';
        if (ta) ta.style.display = 'none';
        if (toggleBtn) toggleBtn.textContent = 'Редактировать';
      } else {
        diffView.style.display = 'none';
        if (ta) ta.style.display = '';
        if (toggleBtn) toggleBtn.textContent = 'Показать изменения';
      }
    });

    // Сохранить промт
    el.querySelector('#sima-prompt-save')?.addEventListener('click', async () => {
      if (!ta) return;
      const value = ta.value;
      const entry = this.simaConfigEntries.find(e => e.key === 'system_prompt_override');
      if (!entry) return;
      const btn = el.querySelector<HTMLButtonElement>('#sima-prompt-save');
      if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }
      const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
      const res = await fetch(`${REST_URL}/sima_config?id=eq.${entry.id}`, {
        method: 'PATCH',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ value, is_active: true }),
      });
      if (res.ok) {
        const [updated] = await res.json();
        const idx = this.simaConfigEntries.findIndex(e => e.key === 'system_prompt_override');
        if (idx !== -1) this.simaConfigEntries[idx] = updated;
        const { clearSimaConfigCache } = await import('@/services/simaConfigService');
        clearSimaConfigCache();
        showToast('Сохранено', 'success');
        this.render();
      } else {
        showToast('Ошибка сохранения', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
      }
    });

    // Сбросить к дефолту
    el.querySelector('#sima-prompt-reset')?.addEventListener('click', async () => {
      if (!confirm('Сбросить к встроенному дефолту? Текущий промт будет удалён.')) return;
      const entry = this.simaConfigEntries.find(e => e.key === 'system_prompt_override');
      if (!entry) return;
      const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
      const res = await fetch(`${REST_URL}/sima_config?id=eq.${entry.id}`, {
        method: 'PATCH',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ value: '' }),
      });
      if (res.ok) {
        const [updated] = await res.json();
        const idx = this.simaConfigEntries.findIndex(e => e.key === 'system_prompt_override');
        if (idx !== -1) this.simaConfigEntries[idx] = updated;
        const { clearSimaConfigCache } = await import('@/services/simaConfigService');
        clearSimaConfigCache();
        showToast('Сброшено к дефолту', 'success');
        this.render();
      }
    });

    // Сохранить выбор модели
    el.querySelector('#sima-ai-model')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      localStorage.setItem('sd_prompt_editor_model', sel.value);
    });

    // ИИ-дополнение промта
    el.querySelector('#sima-ai-submit')?.addEventListener('click', async () => {
      const aiInput = el.querySelector<HTMLTextAreaElement>('#sima-ai-input');
      const statusEl = el.querySelector<HTMLElement>('#sima-ai-status');
      const submitBtn = el.querySelector<HTMLButtonElement>('#sima-ai-submit');
      if (!aiInput || !ta) return;
      const instruction = aiInput.value.trim();
      if (!instruction) { showToast('Введите что нужно добавить или изменить', 'error'); return; }
      const currentPrompt = ta.value.trim();
      if (!currentPrompt) { showToast('Сначала загрузите дефолтный промт или введите его вручную', 'error'); return; }
      const aiKey = sessionStorage.getItem('sd_ai_key') || '';
      if (!aiKey) { showToast('Нет OpenRouter ключа — настройте в разделе Настройки → AI', 'error'); return; }
      const model = (el.querySelector<HTMLSelectElement>('#sima-ai-model'))?.value
        ?? localStorage.getItem('sd_prompt_editor_model')
        ?? 'anthropic/claude-3.5-sonnet';

      if (submitBtn) { submitBtn.disabled = true; }
      if (statusEl) { statusEl.textContent = '⏳ ИИ обрабатывает…'; }

      try {
        const systemMsg = `Ты редактор системных промтов для AI-ассистента.
Твоя задача: получить текущий системный промт и инструкцию по изменению, затем вернуть ТОЛЬКО полный обновлённый промт — без объяснений, без markdown-обёрток, без комментариев.
Встраивай изменения профессионально: соблюдай стиль, структуру и тон оригинала.`;
        const userMsg = `ТЕКУЩИЙ СИСТЕМНЫЙ ПРОМТ:\n${currentPrompt}\n\n---\nИНСТРУКЦИЯ ПО ИЗМЕНЕНИЮ:\n${instruction}\n\n---\nВерни полный обновлённый промт:`;

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${aiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': location.origin,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemMsg },
              { role: 'user', content: userMsg },
            ],
            max_tokens: 4096,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(err);
        }
        const data = await res.json();
        const newPrompt = data.choices?.[0]?.message?.content?.trim() ?? '';
        if (!newPrompt) throw new Error('Пустой ответ от ИИ');

        ta.value = newPrompt;
        aiInput.value = '';
        updateDiffStats();
        // Показываем diff автоматически
        const diffView = el.querySelector<HTMLElement>('#sima-diff-view');
        const toggleBtn = el.querySelector<HTMLButtonElement>('#sima-diff-toggle');
        if (diffView && !diffViewVisible) {
          diffViewVisible = true;
          renderDiffView();
          diffView.style.display = 'block';
          ta.style.display = 'none';
          if (toggleBtn) toggleBtn.textContent = 'Редактировать';
        } else if (diffView && diffViewVisible) {
          renderDiffView();
        }
        if (statusEl) statusEl.textContent = '✅ Готово — проверьте изменения и сохраните';
        showToast('ИИ обновил промт — проверьте изменения', 'success');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (statusEl) statusEl.textContent = '';
        showToast(`Ошибка ИИ: ${msg.slice(0, 120)}`, 'error');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // Фильтры
    el.querySelector('#brain-filter-mp')?.addEventListener('change', (e) => {
      this.brainFilter.mp = (e.target as HTMLSelectElement).value;
      this.render();
    });
    el.querySelector('#brain-filter-cat')?.addEventListener('change', (e) => {
      this.brainFilter.category = (e.target as HTMLSelectElement).value;
      this.render();
    });

    // Кнопка "Обновить мозг"
    el.querySelector('#brain-update-btn')?.addEventListener('click', async () => {
      const days = parseInt(prompt('За сколько дней обновить мозг из новостей? (7, 30, 90)', '30') ?? '30');
      if (!days || isNaN(days)) return;
      this.brainUpdating = true;
      this.render();
      try {
        const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
        const base = REST_URL.replace('/rest/v1', '');
        const res = await fetch(`${base}/functions/v1/telegram-auth/sima-brain-update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ since_days: days }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
          showToast(`Мозг обновлён: ${data.updated} записей из ${data.total_news} новостей`, 'success');
          await this.loadBrainData();
        } else {
          showToast('Ошибка: ' + (data.error ?? 'неизвестно'), 'error');
        }
      } catch (e: any) {
        showToast('Ошибка: ' + e.message, 'error');
      }
      this.brainUpdating = false;
      this.render();
    });

    // Добавить вручную
    el.querySelector('#brain-add-btn')?.addEventListener('click', () => {
      this.openBrainModal();
    });

    // Просмотр/редактирование записи
    el.querySelectorAll<HTMLButtonElement>('.brain-entry-view').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const entry = this.brainEntries.find(e => e.id === id);
        if (entry) this.openBrainModal(entry);
      });
    });

    // Удаление записи
    el.querySelectorAll<HTMLButtonElement>('.brain-entry-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!;
        const entry = this.brainEntries.find(e => e.id === id);
        if (!confirm(`Удалить запись «${entry?.title ?? id}»?`)) return;
        const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
        const res = await fetch(`${REST_URL}/sima_memory?id=eq.${id}`, { method: 'DELETE', headers: getAuthHeaders() });
        if (res.ok || res.status === 204) {
          this.brainEntries = this.brainEntries.filter(e => e.id !== id);
          el.querySelector<HTMLTableRowElement>(`tr[data-brain-id="${id}"]`)?.remove();
          showToast('Запись удалена', 'success');
        } else {
          showToast('Ошибка удаления', 'error');
        }
      });
    });

    // Закрыть модал
    el.querySelector('#brain-modal-close')?.addEventListener('click', () => this.closeBrainModal());
    el.querySelector('#brain-modal-cancel')?.addEventListener('click', () => this.closeBrainModal());
    el.querySelector('#brain-modal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'brain-modal') this.closeBrainModal();
    });

    // Сохранить из модала
    el.querySelector('#brain-modal-save')?.addEventListener('click', async () => {
      const modal = el.querySelector<HTMLElement>('#brain-modal')!;
      const editId = modal.dataset.editId || '';
      const mp       = (el.querySelector<HTMLSelectElement>('#brain-modal-mp'))!.value;
      const category = (el.querySelector<HTMLSelectElement>('#brain-modal-cat'))!.value;
      const title    = (el.querySelector<HTMLInputElement>('#brain-modal-title-inp'))!.value.trim();
      const content  = (el.querySelector<HTMLTextAreaElement>('#brain-modal-content'))!.value.trim();
      const kwRaw    = (el.querySelector<HTMLInputElement>('#brain-modal-kw'))!.value;
      const keywords = kwRaw.split(',').map(k => k.trim()).filter(Boolean);
      if (!title || !content) { showToast('Заголовок и содержание обязательны', 'error'); return; }

      const { REST_URL, getAuthHeaders } = await import('@/services/dbClient');
      const payload = { mp, category, title, content, keywords, updated_at: new Date().toISOString() };

      let res: Response;
      if (editId) {
        res = await fetch(`${REST_URL}/sima_memory?id=eq.${editId}`, {
          method: 'PATCH',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`${REST_URL}/sima_memory`, {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify(payload),
        });
      }

      if (res.ok) {
        showToast(editId ? 'Запись обновлена' : 'Запись добавлена', 'success');
        this.closeBrainModal();
        await this.loadBrainData();
        this.render();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast('Ошибка: ' + (err.message ?? res.status), 'error');
      }
    });
  }

  // ── УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────────────────

  private renderNotifications(): string {
    const notifs = this.adminNotifications;
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const typeOptions = [
      { v: 'info',        l: '📌 Информация' },
      { v: 'success',     l: '✅ Успех' },
      { v: 'warning',     l: '⚠️ Предупреждение' },
      { v: 'error',       l: '❌ Ошибка' },
      { v: 'token_gift',  l: '🎁 Подарок токенов' },
      { v: 'store_alert', l: '📦 Алерт магазина' },
      { v: 'system',      l: '⚙️ Системное' },
    ].map(o => `<option value="${o.v}">${o.l}</option>`).join('');

    const iconFor = (type: string) => ({
      info: '📌', success: '✅', warning: '⚠️', error: '❌',
      token_gift: '🎁', store_alert: '📦', system: '⚙️',
    }[type] ?? '🔔');

    const colorFor = (type: string) => ({
      info: '#3b82f6', success: '#10b981', warning: '#f59e0b', error: '#ef4444',
      token_gift: '#8b5cf6', store_alert: '#f97316', system: '#64748b',
    }[type] ?? '#64748b');

    const fmtTime = (iso: string) => {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      if (diff < 60_000) return 'только что';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    };

    const rows = notifs.length
      ? notifs.map(n => `
        <div class="ap-notif-row" data-id="${n.id}">
          <div class="ap-notif-icon" style="color:${colorFor(n.type)}">${iconFor(n.type)}</div>
          <div class="ap-notif-info">
            <div class="ap-notif-title">${esc(n.title)}</div>
            ${n.body ? `<div class="ap-notif-body">${esc(n.body)}</div>` : ''}
            <div class="ap-notif-meta">
              ${n.user_id ? `<span class="ap-notif-badge ap-notif-personal">Личное</span>` : `<span class="ap-notif-badge ap-notif-broadcast">Всем</span>`}
              <span class="ap-notif-time">${fmtTime(n.created_at)}</span>
            </div>
          </div>
          <button class="ap-notif-del" data-id="${n.id}" title="Удалить">${icon('trash', 14)}</button>
        </div>`).join('')
      : `<div class="ap-notif-empty">Уведомлений пока нет</div>`;

    return `
      <div class="ap-notif-wrap">
        <div class="ap-notif-send-card">
          <div class="ap-notif-send-title">${icon('send', 15)} Отправить уведомление</div>
          <div class="ap-notif-send-form">
            <div class="ap-notif-field-row">
              <label class="ap-label">Кому</label>
              <div class="ap-notif-target-row">
                <select class="ap-select" id="notif-target-mode">
                  <option value="broadcast">Всем пользователям</option>
                  <option value="user">Конкретному пользователю</option>
                </select>
                <div id="notif-user-picker-wrap" style="display:none">
                  ${this.renderPicker('user', '', '', 'Найти пользователя…')}
                </div>
              </div>
            </div>
            <div class="ap-notif-field-row">
              <label class="ap-label">Тип</label>
              <select class="ap-select" id="notif-type">${typeOptions}</select>
            </div>
            <div class="ap-notif-field-row">
              <label class="ap-label">Заголовок</label>
              <input class="ap-input" id="notif-title" placeholder="Заголовок уведомления…" maxlength="120">
            </div>
            <div class="ap-notif-field-row">
              <label class="ap-label">Текст (необязательно)</label>
              <textarea class="ap-input ap-notif-textarea" id="notif-body" placeholder="Дополнительный текст…" rows="3"></textarea>
            </div>
            <div class="ap-notif-send-actions">
              <button class="ap-btn ap-btn-primary" id="notif-send-btn" ${this.notifSending ? 'disabled' : ''}>
                ${this.notifSending ? 'Отправка…' : `${icon('send', 14)} Отправить`}
              </button>
            </div>
          </div>
        </div>

        <div class="ap-notif-list-card">
          <div class="ap-notif-list-hdr">
            <span class="ap-notif-list-title">Отправленные (${notifs.length})</span>
            <button class="ap-btn" id="notif-refresh">${icon('refresh', 14)}<span>Обновить</span></button>
          </div>
          <div class="ap-notif-list">${rows}</div>
        </div>
      </div>`;
  }

  private bindNotificationsEvents(): void {
    const targetSel = this.el.querySelector<HTMLSelectElement>('#notif-target-mode');
    const pickerWrap = this.el.querySelector<HTMLElement>('#notif-user-picker-wrap');
    targetSel?.addEventListener('change', () => {
      if (pickerWrap) pickerWrap.style.display = targetSel.value === 'user' ? 'block' : 'none';
    });

    this.el.querySelector('#notif-send-btn')?.addEventListener('click', async () => {
      const title = (this.el.querySelector<HTMLInputElement>('#notif-title'))?.value.trim();
      const body  = (this.el.querySelector<HTMLTextAreaElement>('#notif-body'))?.value.trim() || undefined;
      const type  = (this.el.querySelector<HTMLSelectElement>('#notif-type'))?.value || 'info';
      const mode  = (this.el.querySelector<HTMLSelectElement>('#notif-target-mode'))?.value;
      const userId = mode === 'user'
        ? (this.el.querySelector<HTMLInputElement>('[name="user_id_hidden"]'))?.value || null
        : null;

      if (!title) { showToast('Введите заголовок', 'error'); return; }

      this.notifSending = true;
      this.render();
      try {
        const { adminSendNotification } = await import('@/services/notificationsService');
        await adminSendNotification({ user_id: userId, type: type as any, title, body });
        showToast('Уведомление отправлено', 'success');
        const { adminFetchAllNotifications } = await import('@/services/notificationsService');
        this.adminNotifications = await adminFetchAllNotifications();
      } catch (e) {
        showToast(this.errText(e, 'Ошибка отправки'), 'error');
      }
      this.notifSending = false;
      this.render();
    });

    this.el.querySelector('#notif-refresh')?.addEventListener('click', async () => {
      try {
        const { adminFetchAllNotifications } = await import('@/services/notificationsService');
        this.adminNotifications = await adminFetchAllNotifications();
        this.render();
      } catch (e) { showToast('Ошибка обновления', 'error'); }
    });

    this.el.querySelectorAll<HTMLElement>('.ap-notif-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id!;
        try {
          const { adminDeleteNotif } = await import('@/services/notificationsService');
          await adminDeleteNotif(id);
          this.adminNotifications = this.adminNotifications.filter(n => n.id !== id);
          this.render();
          showToast('Удалено', 'success');
        } catch (e) { showToast('Ошибка удаления', 'error'); }
      });
    });
  }
}
