import { boxes } from '../stores/appStore';
import type { AppPage } from '../types';
import type { App } from '../App';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { wbDb } from '@/services/wbDb';

/** Разделы, доступные ДО подключения хотя бы одного магазина МП. Всё остальное
 *  без магазина бессмысленно (пустой каталог/заказы/аналитика и т.п.). */
const ALLOWED_WITHOUT_STORE = new Set<AppPage>([
  'marketplaces', 'ozon', 'yandex', 'wb', 'settings', 'settings-hub', 'profile',
]);

/** dock-item id → закрашивать серым и блокировать клик, пока нет ни одного магазина. */
const LOCKABLE_NAV_IDS = [
  'nav-home', 'nav-tasks', 'nav-products',
  'nav-catalog', 'nav-orders', 'nav-stock', 'nav-producers',
  'nav-analytics', 'nav-repricer', 'nav-reviews', 'nav-chats',
  'dock-more-btn', 'nav-sku-audit', 'nav-automation', 'nav-logs',
  'nav-simastore',
];

/** Есть ли хотя бы один подключённый магазин (Ozon/WB/ЯМ) у текущей компании. */
export async function hasAnyStoreConnected(): Promise<boolean> {
  const [oz, ym, wb] = await Promise.all([
    ozonDb.getStores().catch(() => []),
    yandexDb.getStores().catch(() => []),
    wbDb.getStores().catch(() => []),
  ]);
  return oz.length + ym.length + wb.length > 0;
}

/**
 * Красит недоступные (без магазина) пункты дока серым и блокирует клики по ним.
 * Вызывается при каждой навигации, а также сразу после подключения/отключения
 * магазина (OzonModule/YandexModule/WbModule, MarketplacesDashboard), чтобы
 * иконки разблокировались без ожидания следующего перехода.
 */
export async function refreshNavLockState(): Promise<boolean> {
  const hasStore = await hasAnyStoreConnected();
  for (const id of LOCKABLE_NAV_IDS) {
    document.getElementById(id)?.classList.toggle('dock-locked', !hasStore);
  }
  return hasStore;
}

export class NavigationModule {
  constructor(private app: App) {}

  /**
   * Получить артикулы товаров активной группы.
   * Используется в SettingsHub для импорта/экспорта шаблонов.
   * Если активной группы нет — возвращает пустой массив.
   */
  getActiveGroupOffers(): Array<{ offer_id: string; name: string; box_name: string }> {
    const out: Array<{ offer_id: string; name: string; box_name: string }> = [];
    const allBoxes = boxes.get();
    const targetBoxes = this.app.activeBoxId
      ? allBoxes.filter(b => b.id === this.app.activeBoxId)
      : allBoxes;
    for (const box of targetBoxes) {
      const prods = this.app.cache.get(box.id) ?? [];
      for (const p of prods) {
        const offer = String(p.data?.['Артикул*'] ?? '').trim();
        if (!offer) continue;
        const name = String(p.data?.['Название товара'] ?? p.data?.['Название'] ?? '').trim();
        out.push({ offer_id: offer, name, box_name: box.name });
      }
    }
    return out;
  }

  /** Имя активной группы (для UI шаблона). */
  getActiveGroupName(): string | null {
    if (!this.app.activeBoxId) return null;
    const b = boxes.get().find(b => b.id === this.app.activeBoxId);
    return b?.name ?? null;
  }

  toggleMarketplaces() {
    const navGroupMarketplaces = document.getElementById('nav-group-marketplaces');
    const navMarketplaces = document.getElementById('nav-marketplaces');
    if (navGroupMarketplaces && navMarketplaces) {
      const isHidden = navGroupMarketplaces.style.display === 'none';
      navGroupMarketplaces.style.display = isHidden ? '' : 'none';
      navMarketplaces.classList.toggle('active', isHidden);
    }
  }

  toggleOrders() {
    const navGroupOrders = document.getElementById('nav-group-orders');
    const navOrders = document.getElementById('nav-orders');
    if (navGroupOrders && navOrders) {
      const isHidden = navGroupOrders.style.display === 'none';
      navGroupOrders.style.display = isHidden ? '' : 'none';
      navOrders.classList.toggle('active', isHidden);
    }
  }

  /** Скрыть все маркетплейс/orders секции. */
  private hideAllMarketplaceSections(): void {
    const ids = [
      'ozon-content', 'yandex-content', 'wb-content',
      'orders-section', 'orders-ozon-section', 'orders-yandex-section', 'orders-wb-section',
      'marketplaces-dashboard', 'analytics-section', 'settings-hub-section',
      'profile-section', 'settings-section',
      'repricer-section',
      'sku-audit-section', 'reviews-section', 'chats-section', 'logs-section', 'automation-section',
      'catalog-section', 'producers-section', 'products-hub-section',
      'simastore-section',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const w = window;
    w.ozonModule?.hide();
    w.yandexModule?.hide();
    w.wbModule?.hide();
    w.ozonOrdersModule?.hide();
    w.yandexOrdersModule?.hide();
    w.wbOrdersModule?.hide();
    w.allOrdersModule?.hide();
    w.marketplacesDashboard?.hide();
    w.analyticsModule?.hide();
    w.settingsHub?.hide();
    w.profileModule?.hide();
    w.settingsModule?.hide();
    w.seoModule?.hide();
    w.repricerModule?.hide();
    w.skuAuditModule?.hide();
    w.reviewsModule?.hide();
    w.chatsModule?.hide();
    w.logsModule?.hide();
    w.automationModule?.hide();
    w.taskManagerModule?.hide();
    w.stockModule?.hide();
    w.catalogMpModule?.hide();
    w.producersModule?.hide();
    w.productsHubModule?.hide();
    w.simaStoreModule?.hide();
  }

  /** Сбросить active-классы у всех nav/dock элементов. */
  private resetNavActive(): void {
    // Dock items
    const dock = document.getElementById('app-dock');
    if (dock) {
      dock.querySelectorAll('.dock-item.active').forEach(el => el.classList.remove('active'));
    }
    // Legacy nav elements
    const ids = [
      'nav-home','nav-products','nav-analytics','nav-settings-hub','nav-settings','nav-orders','nav-marketplaces',
      'nav-ozon','nav-yandex','nav-wb',
      'nav-orders-ozon','nav-orders-yandex','nav-orders-wb',
      'nav-repricer',
      'nav-sku-audit','nav-reviews','nav-chats','nav-logs','nav-automation','nav-tasks','nav-stock','nav-catalog','nav-producers','nav-products-hub',
      'nav-simastore',
    ];
    for (const id of ids) {
      document.getElementById(id)?.classList.remove('active');
    }
  }

  async navigateTo(
    page: AppPage,
    { loadAll = false }: { loadAll?: boolean } = {},
  ): Promise<void> {
    // Без подключённого магазина большинство разделов бессмысленны (пустые данные) —
    // до первого подключения пускаем только на API Маркет/Настройки/Профиль.
    // refreshNavLockState заодно красит недоступные иконки дока серым.
    const hasStore = await refreshNavLockState();
    if (!ALLOWED_WITHOUT_STORE.has(page) && !hasStore) {
      if (page !== 'marketplaces') {
        this.app.toast('Сначала подключи магазин в разделе «API Маркет»', 'info');
        return this.navigateTo('marketplaces');
      }
    }

    this.app.currentPage = page;
    localStorage.setItem('last_page', page);

    const topbarEl             = document.querySelector<HTMLElement>('.topbar');
    const content              = document.querySelector<HTMLElement>('.content');
    const sideboxes            = document.getElementById('sidebar-boxes-section');
    const w = window;

    const isModulePage =
      page === 'marketplaces' || page === 'ozon' || page === 'yandex' || page === 'wb' ||
      page === 'orders' || page === 'orders-ozon' || page === 'orders-yandex' || page === 'orders-wb' ||
      page === 'analytics' || page === 'settings-hub' || page === 'settings' || page === 'profile' ||
      page === 'repricer' ||
      page === 'sku-audit' || page === 'reviews' || page === 'chats' || page === 'logs' || page === 'automation' ||
      page === 'tasks' || page === 'stock' || page === 'catalog' || page === 'producers' || page === 'products-hub' ||
      page === 'simastore';

    const groupsBar = document.getElementById('groups-bar');

    if (isModulePage) {
      this.hideAllMarketplaceSections();
      this.resetNavActive();
      if (content) content.style.display = 'none';
      if (topbarEl) topbarEl.style.display = 'none';
      if (sideboxes) sideboxes.style.display = 'none';
      if (groupsBar) groupsBar.style.display = 'none';

      // Highlight dock item for marketplace sub-pages
      const isMarketplacesPage = page === 'marketplaces' || page === 'ozon' || page === 'yandex' || page === 'wb';
      const isOrdersPage = page.startsWith('orders');
      if (isMarketplacesPage) document.getElementById('nav-marketplaces')?.classList.add('active');
      if (isOrdersPage) document.getElementById('nav-orders')?.classList.add('active');

      switch (page) {
        case 'analytics':
          document.getElementById('nav-analytics')?.classList.add('active');
          w.analyticsModule?.show();
          break;
        case 'settings-hub':
          // Legacy — redirect to profile
          document.getElementById('nav-settings')?.classList.add('active');
          w.profileModule?.show();
          break;
        case 'profile':
          w.profileModule?.show();
          break;
        case 'settings':
          document.getElementById('nav-settings')?.classList.add('active');
          w.settingsModule?.show();
          break;
        case 'marketplaces':
          w.marketplacesDashboard?.show();
          break;
        case 'ozon':
          document.getElementById('nav-ozon')?.classList.add('active');
          w.ozonModule?.show();
          break;
        case 'yandex':
          document.getElementById('nav-yandex')?.classList.add('active');
          w.yandexModule?.show();
          break;
        case 'wb':
          document.getElementById('nav-wb')?.classList.add('active');
          w.wbModule?.show();
          break;
        case 'orders':
          w.allOrdersModule?.show();
          break;
        case 'orders-ozon':
          document.getElementById('nav-orders-ozon')?.classList.add('active');
          w.ozonOrdersModule?.show();
          break;
        case 'orders-yandex':
          document.getElementById('nav-orders-yandex')?.classList.add('active');
          w.yandexOrdersModule?.show();
          break;
        case 'orders-wb':
          document.getElementById('nav-orders-wb')?.classList.add('active');
          w.wbOrdersModule?.show();
          break;
        case 'repricer':
          document.getElementById('nav-repricer')?.classList.add('active');
          w.repricerModule?.show();
          break;
        case 'sku-audit':
          document.getElementById('nav-sku-audit')?.classList.add('active');
          w.skuAuditModule?.show();
          break;
        case 'reviews':
          document.getElementById('nav-reviews')?.classList.add('active');
          w.reviewsModule?.show();
          break;
        case 'chats':
          document.getElementById('nav-chats')?.classList.add('active');
          w.chatsModule?.show();
          break;
        case 'logs':
          document.getElementById('nav-logs')?.classList.add('active');
          w.logsModule?.show();
          break;
        case 'automation':
          document.getElementById('nav-automation')?.classList.add('active');
          w.automationModule?.show();
          break;
        case 'tasks':
          document.getElementById('nav-tasks')?.classList.add('active');
          w.taskManagerModule?.show();
          break;
        case 'stock':
          document.getElementById('nav-stock')?.classList.add('active');
          w.stockModule?.show();
          break;
        case 'catalog':
          document.getElementById('nav-catalog')?.classList.add('active');
          w.catalogMpModule?.show();
          break;
        case 'producers':
          document.getElementById('nav-producers')?.classList.add('active');
          w.producersModule?.show();
          break;
        case 'products-hub':
          document.getElementById('nav-products')?.classList.add('active');
          w.productsHubModule?.show();
          break;
        case 'simastore':
          document.getElementById('nav-simastore')?.classList.add('active');
          w.simaStoreModule?.show();
          break;
      }
      return;
    }

    // ── home / products: показываем стандартный layout ─────────────────────
    this.hideAllMarketplaceSections();
    if (topbarEl) topbarEl.style.display = '';

    this.resetNavActive();
    document.getElementById('nav-home')?.classList.toggle('active', page === 'home');
    document.getElementById('nav-products')?.classList.toggle('active', page === 'products');
    window.ensureDockExpandedForPage?.(page);

    const sb = document.getElementById('sidebar-boxes-section');
    const filterPanel = document.getElementById('filter-panel');
    const tableHeader = document.querySelector<HTMLElement>('.table-header');
    const tb = document.querySelector<HTMLElement>('.topbar');
    const cnt = document.querySelector<HTMLElement>('.content');

    if (page === 'home') {
      if (sb) sb.style.display = 'none';
      if (filterPanel) filterPanel.style.display = 'none';
      if (tableHeader) tableHeader.style.display = 'none';
      if (tb) tb.style.display = 'none';
      if (cnt) cnt.style.display = '';
      if (groupsBar) groupsBar.style.display = 'none';
      this.app.renderDashboard();
      this.app.updateResultStat();
    } else {
      if (sb) sb.style.display = 'none';
      if (filterPanel) filterPanel.style.display = '';
      if (tableHeader) tableHeader.style.display = '';
      if (tb) tb.style.display = '';
      if (cnt) cnt.style.display = '';
      if (groupsBar) groupsBar.style.display = 'flex';
      this.app.renderBoxes();
      if (loadAll) {
        // Coming from nav button: reset box selection and show ALL products
        this.app.activeBoxId = null;
        this.app.searchQ = '';
        const inp = document.getElementById('search-inp') as HTMLInputElement;
        if (inp) inp.value = '';
        const addBtn = document.getElementById('add-product-btn');
        if (addBtn) addBtn.style.display = 'none';
        this.app.renderBoxes();
        this.app.loadAllProducts();
      }
      // When called from selectBox/setView, those methods handle loading themselves
    }
  }
}
