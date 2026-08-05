import './styles/main.css';
import './styles/ozon.css';
import './styles/auth.css';
import './styles/products-hub.css';
import './styles/storefront.css';
import './styles/assistant.css';
import './styles/admin.css';

// Apply saved theme immediately (before DOMContentLoaded to avoid flash)
if (localStorage.getItem('simadesk_theme') === 'light') {
  document.documentElement.classList.add('light');
}
import './utils/metricTip';
import { initHelpModal } from './services/helpModal';
import { App } from './App';
import { apiService } from './services/api';
import { authService } from './services/authService';
import { AuthModule } from './modules/AuthModule';
import { CompanyModule } from './modules/CompanyModule';
import { OzonModule } from './modules/OzonModule';
import { OzonOrdersModule } from './modules/OzonOrdersModule';
import { YandexModule } from './modules/YandexModule';
import { YandexOrdersModule } from './modules/YandexOrdersModule';
import { WbModule } from './modules/WbModule';
import { WbOrdersModule } from './modules/WbOrdersModule';
import { AllOrdersModule } from './modules/AllOrdersModule';
import { MarketplacesDashboard } from './modules/MarketplacesDashboard';
import { AnalyticsModule } from './modules/analytics/AnalyticsModule';
import { SettingsHubModule } from './modules/SettingsHubModule';
import { MyAnalysisModule } from './modules/MyAnalysisModule';
import { ReviewsModule } from './modules/ReviewsModule';
import { ChatsModule } from './modules/ChatsModule';
import { SeoModule } from './modules/SeoModule';
import { RepricerModule } from './modules/RepricerModule';
import { LogsModule } from './modules/LogsModule';
import { AutomationModule } from './modules/AutomationModule';
import { TaskManagerModule } from './modules/TaskManagerModule';
import { ProfileModule } from './modules/ProfileModule';
import { SettingsModule } from './modules/SettingsModule';
import { StockModule } from './modules/StockModule';
import { ProducersModule } from './modules/ProducersModule';
import { ProductsHubModule } from './modules/ProductsHubModule';
import { SimaStoreModule } from './modules/SimaStoreModule';
import { DocsModule } from './modules/DocsModule';
import { NotificationsModule } from './modules/NotificationsModule';
import { AdminModule } from './modules/AdminModule';
import { BillingModule } from './modules/BillingModule';
import { assistantModule } from './modules/AssistantModule';
import { SupplyManagementModule } from './modules/SupplyManagementModule';
import { AdvertisingModule } from './modules/AdvertisingModule';
import { MarketplaceAnalyticsModule } from './modules/MarketplaceAnalyticsModule';
import { ContentManagementModule } from './modules/ContentManagementModule';
import { ReturnsManagementModule } from './modules/ReturnsManagementModule';
import { AdvancedAnalyticsModule } from './modules/AdvancedAnalyticsModule';
import { StocksUpdateModule } from './modules/StocksUpdateModule';
import { ProductCreatorModule } from './modules/ProductCreatorModule';
import { orderSyncService } from './services/orderSyncService';
import { companyService } from './services/companyService';
import { renderPublicStorefront } from './pages/storefrontPage';
import { debug } from '@/utils/debug';

// ── Global error reporting ────────────────────────────────────────────────────
// Catches unhandled JS errors and promise rejections; writes them to error_log.
// Fire-and-forget — never throws, never blocks UI.
function reportError(message: string, source?: string, stack?: string): void {
  // Skip cross-origin noise and extension errors
  if (!message || message === 'Script error.' || source?.includes('chrome-extension')) return;
  try {
    const token = localStorage.getItem('access_token');
    if (!token) return;
    const companyId = companyService.getActiveId();
    fetch('/rest/v1/error_log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
        'Authorization': `Bearer ${token}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        company_id: companyId ?? null,
        message: String(message).slice(0, 500),
        source: source?.slice(0, 200),
        stack: stack?.slice(0, 2000),
        url: window.location.pathname,
      }),
    }).catch(() => {/* ignore */});
  } catch { /* ignore */ }
}

// One-time migration: remove AI key from localStorage (moved to sessionStorage)
try { localStorage.removeItem('sd_ai_key'); } catch { /* ignore */ }

window.onerror = (msg, source, _line, _col, error) => {
  reportError(String(msg), source, error?.stack);
};

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? 'unhandledrejection');
  const stack = e.reason instanceof Error ? e.reason.stack : undefined;
  reportError(msg, undefined, stack);
});

// Экспортируем функцию получения per-company ключа dock-конфига (используется в inline-скрипте)
(window as any).getDockStorageKey = () => {
  const cid = companyService.getActiveId();
  return cid ? `dock_nav_config_${cid}` : 'dock_nav_config';
};

// ── Helper: register a section module ─────────────────────────────────────────
const init = <T>(id: string, factory: (el: HTMLElement) => T, key: string): void => {
  const el = document.getElementById(id);
  if (el) (window as any)[key] = factory(el);
};

// ── Bootstrap the full app (called after auth + company are selected) ─────────
function bootApp(): void {
  initHelpModal();
  const app = new App();
  window.app = app;

  apiService.onLoadingChange((isLoading) => {
    document.getElementById('global-progress')?.classList.toggle('on', isLoading);
  });

  app.init();

  init('ozon-content',           (el) => { const m = new OzonModule(el); m.init(); return m; }, 'ozonModule');
  init('yandex-content',         (el) => new YandexModule(el),         'yandexModule');
  init('wb-content',             (el) => new WbModule(el),             'wbModule');
  init('orders-ozon-section',    (el) => new OzonOrdersModule(el),     'ozonOrdersModule');
  init('orders-yandex-section',  (el) => new YandexOrdersModule(el),   'yandexOrdersModule');
  init('orders-wb-section',      (el) => new WbOrdersModule(el),       'wbOrdersModule');
  init('orders-section',         (el) => new AllOrdersModule(el),      'allOrdersModule');
  init('marketplaces-dashboard', (el) => new MarketplacesDashboard(el), 'marketplacesDashboard');
  init('analytics-section',      (el) => new AnalyticsModule(el),       'analyticsModule');
  init('settings-hub-section',   (el) => new SettingsHubModule(el),     'settingsHub');
  init('sku-audit-section',      (el) => new MyAnalysisModule(el),      'myAnalysisModule');
  init('reviews-section',         (el) => new ReviewsModule(el),          'reviewsModule');
  init('chats-section',          (el) => new ChatsModule(el),           'chatsModule');
  init('seo-section',            (el) => new SeoModule(el),             'seoModule');
  init('repricer-section',       (el) => new RepricerModule(el),        'repricerModule');
  init('logs-section',           (el) => new LogsModule(el),            'logsModule');
  init('automation-section',     (el) => new AutomationModule(el),      'automationModule');
  init('tasks-section',          (el) => new TaskManagerModule(el),     'taskManagerModule');
  init('profile-section',        (el) => new ProfileModule(el),         'profileModule');
  init('settings-section',       (el) => new SettingsModule(el),        'settingsModule');
  init('stock-section',          (el) => new StockModule(el),           'stockModule');
init('producers-section',      (el) => new ProducersModule(el),       'producersModule');
  init('products-hub-section',   (el) => new ProductsHubModule(el),     'productsHubModule');
  init('docs-section',           (el) => new DocsModule(el),            'docsModule');
  init('notifications-section',  (el) => new NotificationsModule(el),   'notificationsModule');
  init('admin-section',          (el) => new AdminModule(el),           'adminModule');
  init('billing-section',        (el) => new BillingModule(el),         'billingModule');
  init('supply-section',         (_el) => new SupplyManagementModule('supply-section'), 'supplyModule');
  init('advertising-section',    (_el) => new AdvertisingModule('advertising-section'), 'advertisingModule');
  init('mp-analytics-section',   (_el) => new MarketplaceAnalyticsModule('mp-analytics-section'), 'mpAnalyticsModule');
  init('content-section',        (_el) => new ContentManagementModule('content-section'), 'contentModule');
  init('returns-section',        (_el) => new ReturnsManagementModule('returns-section'), 'returnsModule');
  init('adv-analytics-section',  (_el) => new AdvancedAnalyticsModule('adv-analytics-section'), 'advAnalyticsModule');
  init('stocks-update-section',  (el) => new StocksUpdateModule(el),     'stocksUpdateModule');
  init('product-creator-section',(el) => new ProductCreatorModule(el),   'productCreatorModule');
  // SimaStore — передаём companyId при инициализации
  const _simaStoreEl = document.getElementById('simastore-section');
  if (_simaStoreEl) {
    const _sm = new SimaStoreModule();
    _sm.init('simastore-section', companyService.getActiveId() ?? '');
    (window as any).simaStoreModule = _sm;
  }

  // Кросс-страничные действия ассистента (напр. «создай Excel» из любого раздела)
  import('./services/aiPageCapabilities').then(m => m.installGlobalAiActions()).catch(() => {/* ignore */});

  // Reload AI config after auth (key from Supabase site_content)
  assistantModule.init().catch(() => {/* ignore */});

  // Apply dock autohide setting on boot
  if (localStorage.getItem('settings_dock_autohide') === 'on') {
    document.getElementById('app-dock')?.classList.add('dock-autohide');
  }

  // Запускаем фоновую синхронизацию заказов (не блокирует UI)
  orderSyncService.init().catch(e => debug.warn('[boot] orderSyncService:', e));

  // Применяем per-company конфиг dock после того как company стала известна
  (window as any).applyDockNavConfig?.();

  // Stamp the initial history entry with SPA state so Back/Forward always have a page
  if (!history.state?.sdPage && window.app) {
    const curPage = window.app.currentPage || 'home';
    const hashPath = curPage === 'home' ? '/' : `/#/${curPage}`;
    history.replaceState({ sdPage: curPage }, '', hashPath);
  }

  // Handle browser Back/Forward within the SPA — prevents going back to /slug
  window.addEventListener('popstate', (e) => {
    const page = e.state?.sdPage
      ?? (location.hash.startsWith('#/') ? location.hash.slice(2).split('?')[0] : undefined);
    if (page && window.app) {
      window.app.navigateTo(page);
    } else if (window.app) {
      const curPage = window.app.currentPage || 'home';
      history.replaceState({ sdPage: curPage }, '', curPage === 'home' ? '/' : `/#/${curPage}`);
    }
  });
}

// ── Early assistant init (pre-auth, so button works before login) ──────────────
// Check readyState to handle both fresh load and HMR hot update cases
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => assistantModule.init());
} else {
  assistantModule.init();
}

// ── Auth gate ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // ── Public SimaStore route: /s/:slug — no auth required ───────────────────
  const _pathMatch = window.location.pathname.match(/^\/([a-z0-9][a-z0-9-]{1,48}[a-z0-9])$/);
  if (_pathMatch) {
    // Hide all app chrome — only show the public storefront
    document.querySelector<HTMLElement>('.app')!.style.display = 'none';
    document.getElementById('auth-gate')!.style.display = 'none';
    document.getElementById('company-gate')!.style.display = 'none';
    await renderPublicStorefront(_pathMatch[1]);
    return;
  }

  // Capture ?invite=TOKEN from URL before anything else, then clean the URL
  const _urlParams = new URLSearchParams(window.location.search);
  const _inviteToken = _urlParams.get('invite');
  if (_inviteToken) {
    sessionStorage.setItem('pending_invite', _inviteToken);
    window.history.replaceState({}, '', window.location.pathname);
  }

  const authGateEl    = document.getElementById('auth-gate')!;
  const companyGateEl = document.getElementById('company-gate')!;
  const switcherEl    = document.getElementById('company-switcher')!;
  const mainAppEl     = document.querySelector<HTMLElement>('.app')!;

  // After login+company-boot: claim any pending invite link
  async function claimPendingInvite(): Promise<void> {
    const token = sessionStorage.getItem('pending_invite');
    if (!token) return;
    sessionStorage.removeItem('pending_invite');
    try {
      const result = await companyService.claimInviteLink(token);
      if (result?.success) {
        window.app?.toast?.('Вы вступили в компанию!', 'success');
        // Reload company list so the new company appears
        await companyModule.boot();
      } else if (result?.error) {
        const msgs: Record<string, string> = {
          invalid_link: 'Ссылка недействительна или была отозвана',
          link_expired: 'Срок действия ссылки истёк',
          link_exhausted: 'Лимит использований ссылки исчерпан',
        };
        window.app?.toast?.(msgs[result.error] ?? 'Не удалось применить ссылку-приглашение', 'error');
      }
    } catch (e) {
      debug.warn('[invite] claim failed', e);
    }
  }

  // Company module wired up at top-level (available before auth completes)
  const companyModule = new CompanyModule(
    companyGateEl,
    switcherEl,
    () => {
      // Company selected → show the main app
      mainAppEl.style.display = '';
      bootApp();
      // Claim invite after app boots (so toast is visible)
      setTimeout(claimPendingInvite, 300);
      // Process pending Yandex account link (came back from Yandex OAuth while logged in)
      const _pendingYaLink = sessionStorage.getItem('pending_ya_link');
      if (_pendingYaLink) {
        sessionStorage.removeItem('pending_ya_link');
        // Small delay so all modules (profileModule) are ready
        setTimeout(() => authModule.startYandexLink(_pendingYaLink), 400);
      }
    },
  );
  window.companyModule = companyModule;

  // Auth module: shown when not logged in
  const authModule = new AuthModule(authGateEl, async () => {
    // Logged in → check companies
    mainAppEl.style.display = 'none';
    await companyModule.boot();
  });

  // ── Yandex OAuth callback — читаем ДО проверки авторизации ──────────────────
  // Яндекс возвращает #access_token=... в hash, независимо от состояния сессии.
  const _yaHashParams = new URLSearchParams(window.location.hash.slice(1));
  const _yandexOAuthToken = _yaHashParams.get('access_token');
  if (_yandexOAuthToken) {
    // Очищаем hash немедленно чтобы не мешал дальнейшей логике
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (authService.isLoggedIn()) {
      // Пользователь уже залогинен → это привязка, сохраняем токен до буta приложения
      sessionStorage.setItem('pending_ya_link', _yandexOAuthToken);
    } else {
      // Не залогинен → вход через Яндекс (обычный flow через authModule)
      sessionStorage.setItem('pending_ya_login', _yandexOAuthToken);
    }
  }

  // ── Decision tree ───────────────────────────────────────────────────────────
  if (!authService.isLoggedIn()) {
    mainAppEl.style.display = 'none';
    // Если есть pending login-токен — сразу логинимся без показа экрана
    const _yaLogin = sessionStorage.getItem('pending_ya_login');
    if (_yaLogin) {
      sessionStorage.removeItem('pending_ya_login');
      authModule.show(_yaLogin);
    } else {
      authModule.show();
    }
    return;
  }

  // Token may be expired → try refresh silently
  const token = await authService.getValidToken();
  if (!token) {
    // Refresh failed → show login (but preserve pending link token for after re-login)
    mainAppEl.style.display = 'none';
    authModule.show();
    return;
  }

  // Logged in and token valid → go to company selection / auto-select
  mainAppEl.style.display = 'none';
  await companyModule.boot();
});

declare global {
  interface Window {
    app: App;
    companyModule: CompanyModule;
    ozonModule: import('./modules/OzonModule').OzonModule;
    ozonOrdersModule: import('./modules/OzonOrdersModule').OzonOrdersModule;
    yandexModule: import('./modules/YandexModule').YandexModule;
    yandexOrdersModule: import('./modules/YandexOrdersModule').YandexOrdersModule;
    wbModule: import('./modules/WbModule').WbModule;
    wbOrdersModule: import('./modules/WbOrdersModule').WbOrdersModule;
    allOrdersModule: import('./modules/AllOrdersModule').AllOrdersModule;
    marketplacesDashboard: import('./modules/MarketplacesDashboard').MarketplacesDashboard;
    analyticsModule: import('./modules/analytics/AnalyticsModule').AnalyticsModule;
    settingsHub: import('./modules/SettingsHubModule').SettingsHubModule;
    myAnalysisModule: import('./modules/MyAnalysisModule').MyAnalysisModule;
    reviewsModule: import('./modules/ReviewsModule').ReviewsModule;
    chatsModule: import('./modules/ChatsModule').ChatsModule;
    seoModule: import('./modules/SeoModule').SeoModule;
    repricerModule: import('./modules/RepricerModule').RepricerModule;
    logsModule: import('./modules/LogsModule').LogsModule;
    automationModule: import('./modules/AutomationModule').AutomationModule;
    profileModule: import('./modules/ProfileModule').ProfileModule;
    settingsModule: import('./modules/SettingsModule').SettingsModule;
    stockModule: import('./modules/StockModule').StockModule;
producersModule: import('./modules/ProducersModule').ProducersModule;
    productsHubModule: import('./modules/ProductsHubModule').ProductsHubModule;
    simaStoreModule: SimaStoreModule;
    docsModule: import('./modules/DocsModule').DocsModule;
    notificationsModule: import('./modules/NotificationsModule').NotificationsModule;
    taskManagerModule: import('./modules/TaskManagerModule').TaskManagerModule;
    adminModule: import('./modules/AdminModule').AdminModule;
    billingModule: import('./modules/BillingModule').BillingModule;
    ensureDockExpandedForPage?: (page: string) => void;
    __showMetricTip?: (id: string) => void;
    __SIMADESK_EXTENSION_ID?: string;
  }
}
