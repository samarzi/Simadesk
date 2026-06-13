import './styles/main.css';
import './styles/ozon.css';
import './styles/auth.css';
import './styles/catalog-mp.css';

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
import { SkuAuditModule } from './modules/SkuAuditModule';
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
import { CatalogMpModule } from './modules/CatalogMpModule';

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
  init('sku-audit-section',      (el) => new SkuAuditModule(el),        'skuAuditModule');
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
  init('catalog-section',        (el) => new CatalogMpModule(el),       'catalogMpModule');

  // Apply dock autohide setting on boot
  if (localStorage.getItem('settings_dock_autohide') === 'on') {
    document.getElementById('app-dock')?.classList.add('dock-autohide');
  }
}

// ── Auth gate ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const authGateEl    = document.getElementById('auth-gate')!;
  const companyGateEl = document.getElementById('company-gate')!;
  const switcherEl    = document.getElementById('company-switcher')!;
  const mainAppEl     = document.querySelector<HTMLElement>('.app')!;

  // Company module wired up at top-level (available before auth completes)
  const companyModule = new CompanyModule(
    companyGateEl,
    switcherEl,
    () => {
      // Company selected → show the main app
      mainAppEl.style.display = '';
      bootApp();
    },
  );
  window.companyModule = companyModule;

  // Auth module: shown when not logged in
  const authModule = new AuthModule(authGateEl, async () => {
    // Logged in → check companies
    mainAppEl.style.display = 'none';
    await companyModule.boot();
  });

  // ── Decision tree ───────────────────────────────────────────────────────────
  if (!authService.isLoggedIn()) {
    // Not logged in → show login screen
    mainAppEl.style.display = 'none';
    authModule.show();
    return;
  }

  // Token may be expired → try refresh silently
  const token = await authService.getValidToken();
  if (!token) {
    // Refresh failed → show login
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
    skuAuditModule: import('./modules/SkuAuditModule').SkuAuditModule;
    reviewsModule: import('./modules/ReviewsModule').ReviewsModule;
    chatsModule: import('./modules/ChatsModule').ChatsModule;
    seoModule: import('./modules/SeoModule').SeoModule;
    repricerModule: import('./modules/RepricerModule').RepricerModule;
    logsModule: import('./modules/LogsModule').LogsModule;
    automationModule: import('./modules/AutomationModule').AutomationModule;
    profileModule: import('./modules/ProfileModule').ProfileModule;
    settingsModule: import('./modules/SettingsModule').SettingsModule;
    stockModule: import('./modules/StockModule').StockModule;
    catalogMpModule: import('./modules/CatalogMpModule').CatalogMpModule;
  }
}
