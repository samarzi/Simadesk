/**
 * Typed declarations for module instances attached to `window` by main.ts.
 * Removes the need for `as any` casts and gives autocomplete on inline event handlers.
 */

import type { App } from '../App';
import type { OzonModule } from '../modules/OzonModule';
import type { YandexModule } from '../modules/YandexModule';
import type { WbModule } from '../modules/WbModule';
import type { OzonOrdersModule } from '../modules/OzonOrdersModule';
import type { YandexOrdersModule } from '../modules/YandexOrdersModule';
import type { WbOrdersModule } from '../modules/WbOrdersModule';
import type { AllOrdersModule } from '../modules/AllOrdersModule';
import type { MarketplacesDashboard } from '../modules/MarketplacesDashboard';
import type { AnalyticsModule } from '../modules/analytics/AnalyticsModule';
import type { SettingsHubModule } from '../modules/SettingsHubModule';
import type { ProfileModule } from '../modules/ProfileModule';
import type { SettingsModule } from '../modules/SettingsModule';
import type { RepricerModule } from '../modules/RepricerModule';
import type { MyAnalysisModule } from '../modules/MyAnalysisModule';
import type { ReviewsModule } from '../modules/ReviewsModule';
import type { ChatsModule } from '../modules/ChatsModule';
import type { LogsModule } from '../modules/LogsModule';
import type { AutomationModule } from '../modules/AutomationModule';
import type { TaskManagerModule } from '../modules/TaskManagerModule';
import type { StockModule } from '../modules/StockModule';
import type { ProducersModule } from '../modules/ProducersModule';
import type { ProductsHubModule } from '../modules/ProductsHubModule';
import type { SimaStoreModule } from '../modules/SimaStoreModule';
import type { DocsModule } from '../modules/DocsModule';
import type { NotificationsModule } from '../modules/NotificationsModule';
import type { AdminModule } from '../modules/AdminModule';
import type { BillingModule } from '../modules/BillingModule';
import type { CompanyModule } from '../modules/CompanyModule';
import type { SeoModule } from '../modules/SeoModule';
import type { AssistantModule } from '../modules/AssistantModule';
import type { SupplyManagementModule } from '../modules/SupplyManagementModule';
import type { AdvertisingModule } from '../modules/AdvertisingModule';
import type { MarketplaceAnalyticsModule } from '../modules/MarketplaceAnalyticsModule';
import type { ContentManagementModule } from '../modules/ContentManagementModule';
import type { ReturnsManagementModule } from '../modules/ReturnsManagementModule';
import type { AdvancedAnalyticsModule } from '../modules/AdvancedAnalyticsModule';
import type { StocksUpdateModule } from '../modules/StocksUpdateModule';
import type { ProductCreatorModule } from '../modules/ProductCreatorModule';

/** Module-level show/hide interface (every nav-routed module implements this). */
interface ShowHideModule {
  show(): void;
  hide(): void;
}

declare global {
  interface Window {
    // ── Core app ───────────────────────────────────────────────────────────
    app: App;
    companyModule: CompanyModule;

    // ── Marketplace API modules ────────────────────────────────────────────
    ozonModule: OzonModule & ShowHideModule;
    yandexModule: YandexModule & ShowHideModule;
    wbModule: WbModule & ShowHideModule;

    // ── Orders modules ─────────────────────────────────────────────────────
    allOrdersModule: AllOrdersModule & ShowHideModule;
    ozonOrdersModule: OzonOrdersModule & ShowHideModule;
    yandexOrdersModule: YandexOrdersModule & ShowHideModule;
    wbOrdersModule: WbOrdersModule & ShowHideModule;

    // ── Dashboard & analytics ──────────────────────────────────────────────
    marketplacesDashboard: MarketplacesDashboard & ShowHideModule;
    analyticsModule: AnalyticsModule & ShowHideModule;

    // ── Settings & profile ─────────────────────────────────────────────────
    settingsHub: SettingsHubModule & ShowHideModule;
    profileModule: ProfileModule & ShowHideModule;
    settingsModule: SettingsModule & ShowHideModule;

    // ── Tools & automation ─────────────────────────────────────────────────
    repricerModule: RepricerModule & ShowHideModule;
    myAnalysisModule: MyAnalysisModule & ShowHideModule;
    reviewsModule: ReviewsModule & ShowHideModule;
    chatsModule: ChatsModule & ShowHideModule;
    logsModule: LogsModule & ShowHideModule;
    automationModule: AutomationModule & ShowHideModule;
    taskManagerModule: TaskManagerModule & ShowHideModule;
    stockModule: StockModule & ShowHideModule;
    producersModule: ProducersModule & ShowHideModule;
    productsHubModule: ProductsHubModule & ShowHideModule;
    simaStoreModule: SimaStoreModule & ShowHideModule;
    docsModule: DocsModule & ShowHideModule;
    seoModule: SeoModule & ShowHideModule;
    assistantModule: AssistantModule;

    // ── System ────────────────────────────────────────────────────────────
    notificationsModule: NotificationsModule & ShowHideModule;
    adminModule: AdminModule & ShowHideModule;
    billingModule: BillingModule & ShowHideModule;
    supplyModule: SupplyManagementModule & ShowHideModule;
    advertisingModule: AdvertisingModule & ShowHideModule;
    returnsModule: ReturnsManagementModule & ShowHideModule;
    mpAnalyticsModule: MarketplaceAnalyticsModule & ShowHideModule;
    contentModule: ContentManagementModule & ShowHideModule;
    advAnalyticsModule: AdvancedAnalyticsModule & ShowHideModule;
    stocksUpdateModule: StocksUpdateModule & ShowHideModule;
    productCreatorModule: ProductCreatorModule & ShowHideModule;

    // ── Helpers injected by modules ────────────────────────────────────────
    /** Expands the dock to show sub-items for the given page (injected by dock init). */
    ensureDockExpandedForPage?: (page: string) => void;

    // ── Extension bridge ──────────────────────────────────────────────────
    __SIMADESK_EXTENSION_ID?: string;
    __showHelp?: () => void;
    __showMetricTip?: (key: string, el: HTMLElement) => void;
  }
}

export {};
