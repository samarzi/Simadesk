import { ozonApi } from '@/services/ozonApi';
import {
  getWbCampaigns,
  createWbAdCampaign,
  updateWbCampaign,
  fetchWbAdStats,
} from '@/services/wbApi';
import { getYandexPromos } from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'wb' | 'ozon' | 'yandex';

interface Campaign {
  id: string | number;
  name: string;
  status: string;
  type: string;
  budget: number;
  spent: number;
  clicks: number;
  views: number;
  orders: number;
  revenue: number;
  roi: number;
}

export class AdvertisingModule {
  private el: HTMLElement;
  private tab: Tab = 'wb';
  private storeId = '';
  private campaigns: Campaign[] = [];
  private loading = false;
  private dateFrom: string;
  private dateTo: string;

  constructor(container: HTMLElement) {
    this.el = container;
    const now = new Date();
    const past = new Date(now.getTime() - 30 * 86_400_000);
    this.dateTo = now.toISOString().slice(0, 10);
    this.dateFrom = past.toISOString().slice(0, 10);
    this.render();
    this.loadStores();
  }

  private render(): void {
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-primary)';
    this.el.innerHTML = `
      <div class="module-page">
        <div class="module-page__header">
          <div class="module-page__title">
            <h2>${I.chartBar} Реклама</h2>
            <p class="module-page__subtitle">Кампании и акции на маркетплейсах</p>
          </div>
          <div class="module-page__actions">
            ${this.tab === 'wb' ? `<button class="btn btn-success" id="ad-create">${I.plus} Создать кампанию</button>` : ''}
            <button class="btn btn-ghost" id="ad-refresh">${I.refresh} Загрузить</button>
          </div>
        </div>

        <div class="module-tabs">
          <button class="module-tab ${this.tab === 'wb' ? 'active' : ''}" data-tab="wb">
            <span class="mp-dot mp-wb"></span> Wildberries
          </button>
          <button class="module-tab ${this.tab === 'ozon' ? 'active' : ''}" data-tab="ozon">
            <span class="mp-dot mp-ozon"></span> Ozon
          </button>
          <button class="module-tab ${this.tab === 'yandex' ? 'active' : ''}" data-tab="yandex">
            <span class="mp-dot mp-yandex"></span> Яндекс.Маркет
          </button>
        </div>

        <div class="module-toolbar">
          <select class="form-select" id="ad-store" style="min-width:200px">
            <option value="">Загрузка магазинов...</option>
          </select>
          ${this.tab === 'wb' ? `
            <input type="date" class="form-input" id="ad-from" value="${this.dateFrom}" style="width:150px">
            <span style="color:var(--text-muted)">—</span>
            <input type="date" class="form-input" id="ad-to" value="${this.dateTo}" style="width:150px">
          ` : ''}
        </div>

        ${this.renderStats()}

        <div class="module-body" id="ad-body">
          ${this.loading ? this.renderSkeleton() : this.renderTable()}
        </div>
      </div>
    `;
    this.bindEvents();
  }

  private renderSkeleton(): string {
    return `<div class="skeleton-rows">${Array(5).fill('<div class="skeleton-row"></div>').join('')}</div>`;
  }

  private renderStats(): string {
    if (!this.campaigns.length) return '';

    const totalBudget  = this.campaigns.reduce((s, c) => s + c.budget, 0);
    const totalSpent   = this.campaigns.reduce((s, c) => s + c.spent, 0);
    const totalRevenue = this.campaigns.reduce((s, c) => s + c.revenue, 0);
    const totalOrders  = this.campaigns.reduce((s, c) => s + c.orders, 0);
    const totalViews   = this.campaigns.reduce((s, c) => s + c.views, 0);
    const totalClicks  = this.campaigns.reduce((s, c) => s + c.clicks, 0);
    const ctr          = totalViews > 0 ? (totalClicks / totalViews * 100).toFixed(2) : '0.00';
    const avgROI       = totalSpent > 0 ? ((totalRevenue - totalSpent) / totalSpent * 100).toFixed(1) : '0.0';

    return `
      <div class="stats-row">
        <div class="stat-tile"><div class="stat-tile__label">Бюджет</div><div class="stat-tile__value">${totalBudget.toLocaleString('ru-RU')} ₽</div></div>
        <div class="stat-tile"><div class="stat-tile__label">Потрачено</div><div class="stat-tile__value">${totalSpent.toLocaleString('ru-RU')} ₽</div></div>
        <div class="stat-tile"><div class="stat-tile__label">Выручка</div><div class="stat-tile__value">${totalRevenue.toLocaleString('ru-RU')} ₽</div></div>
        <div class="stat-tile"><div class="stat-tile__label">Заказы</div><div class="stat-tile__value">${totalOrders}</div></div>
        <div class="stat-tile"><div class="stat-tile__label">CTR</div><div class="stat-tile__value">${ctr}%</div></div>
        <div class="stat-tile"><div class="stat-tile__label">ROI</div><div class="stat-tile__value ${Number(avgROI) >= 0 ? 'text-success' : 'text-danger'}">${Number(avgROI) >= 0 ? '+' : ''}${avgROI}%</div></div>
      </div>
    `;
  }

  private renderTable(): string {
    if (!this.storeId) {
      return `<div class="empty-state"><div class="empty-state__icon">${I.chartBar}</div><p>Выберите магазин для загрузки данных</p></div>`;
    }
    if (this.campaigns.length === 0) {
      return `<div class="empty-state"><div class="empty-state__icon">${I.chartBar}</div><p>Нет данных. Нажмите «Загрузить».</p></div>`;
    }

    if (this.tab === 'wb') {
      return this.renderWbTable();
    }

    // Ozon promotions / Yandex promos — simplified view
    const rows = this.campaigns.map(c => `
      <tr>
        <td>${esc(String(c.id))}</td>
        <td>${esc(c.name)}</td>
        <td><span class="status-chip status-${c.status}">${esc(c.status)}</span></td>
        <td>${esc(c.type)}</td>
      </tr>
    `).join('');

    return `
      <table class="data-table">
        <thead><tr><th>ID</th><th>Название</th><th>Статус</th><th>Тип</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private renderWbTable(): string {
    const rows = this.campaigns.map(c => `
      <tr>
        <td>${esc(c.name)}</td>
        <td><span class="status-chip status-${c.status}">${this.wbStatusLabel(c.status)}</span></td>
        <td>${esc(c.type)}</td>
        <td>${c.budget > 0 ? c.budget.toLocaleString('ru-RU') + ' ₽' : '—'}</td>
        <td>${c.spent > 0 ? c.spent.toLocaleString('ru-RU') + ' ₽' : '—'}</td>
        <td>${c.views.toLocaleString('ru-RU')}</td>
        <td>${c.clicks.toLocaleString('ru-RU')}</td>
        <td>${c.orders}</td>
        <td class="${c.roi >= 0 ? 'text-success' : 'text-danger'}">${c.roi >= 0 ? '+' : ''}${c.roi.toFixed(1)}%</td>
        <td class="actions-cell">
          ${c.status === 'active'
            ? `<button class="btn btn-xs" data-action="pause" data-id="${c.id}">⏸</button>`
            : `<button class="btn btn-xs btn-success" data-action="resume" data-id="${c.id}">▶</button>`}
        </td>
      </tr>
    `).join('');

    return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Статус</th>
            <th>Тип</th>
            <th>Бюджет/д.</th>
            <th>Потрачено</th>
            <th>Показы</th>
            <th>Клики</th>
            <th>Заказы</th>
            <th>ROI</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private wbStatusLabel(s: string): string {
    const map: Record<string, string> = { active: 'Активна', paused: 'Пауза', stopped: 'Остановлена' };
    return map[s] ?? s;
  }

  private bindEvents(): void {
    this.el.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      const tabEl = btn.closest('[data-tab]') as HTMLElement | null;
      if (tabEl?.dataset.tab) {
        this.tab = tabEl.dataset.tab as Tab;
        this.storeId = '';
        this.campaigns = [];
        this.render();
        this.loadStores();
        return;
      }

      if (btn.id === 'ad-refresh') { await this.loadCampaigns(); return; }
      if (btn.id === 'ad-create')  { this.showCreateDialog(); return; }

      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'pause' && id)  { await this.toggleCampaign(Number(id), 11 as 11); return; }
      if (action === 'resume' && id) { await this.toggleCampaign(Number(id), 9 as 9); return; }
    });

    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      if (t.id === 'ad-store') {
        this.storeId = t.value;
        this.campaigns = [];
        this.refreshBody();
        return;
      }
      if (t.id === 'ad-from') { this.dateFrom = t.value; return; }
      if (t.id === 'ad-to')   { this.dateTo = t.value; return; }
    });
  }

  private refreshBody(): void {
    const body = this.el.querySelector('#ad-body');
    if (body) body.innerHTML = this.loading ? this.renderSkeleton() : this.renderTable();
    const statsEl = this.el.querySelector('.stats-row');
    if (statsEl) statsEl.outerHTML = this.renderStats();
  }

  private async loadStores(): Promise<void> {
    const sel = this.el.querySelector('#ad-store') as HTMLSelectElement;
    if (!sel) return;

    let stores: Array<{ id: string; name: string }> = [];
    try {
      if (this.tab === 'wb') stores = await wbDb.getStores();
      else if (this.tab === 'ozon') stores = await ozonDb.getStores();
      else stores = await yandexDb.getStores();
    } catch { /* ignore */ }

    if (stores.length === 0) {
      sel.innerHTML = '<option value="">Нет подключённых магазинов</option>';
      return;
    }

    sel.innerHTML = '<option value="">— Выберите магазин —</option>' +
      stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

    if (stores.length === 1) {
      sel.value = stores[0].id;
      this.storeId = stores[0].id;
    }
  }

  private async loadCampaigns(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    this.loading = true;
    this.refreshBody();

    try {
      this.campaigns = [];

      if (this.tab === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        const list = await getWbCampaigns(store.api_key);

        for (const c of list) {
          let stats: any = {};
          try {
            const data = await fetchWbAdStats(store.api_key, [c.advertId], this.dateFrom, this.dateTo);
            if (data.length > 0) stats = data[0];
          } catch { /* ignore stats error */ }

          const spent   = stats.sum ?? 0;
          const revenue = (stats.orders ?? 0) * (stats.avgPrice ?? 0);
          const roi     = spent > 0 ? (revenue - spent) / spent * 100 : 0;

          this.campaigns.push({
            id: c.advertId,
            name: c.name ?? `Кампания ${c.advertId}`,
            status: c.status === 9 ? 'active' : c.status === 11 ? 'paused' : 'stopped',
            type: c.type === 8 ? 'Авто' : c.type === 6 ? 'Поиск' : 'Каталог',
            budget: c.dailyBudget ?? 0,
            spent, clicks: stats.clicks ?? 0, views: stats.views ?? 0,
            orders: stats.orders ?? 0, revenue, roi,
          });
        }
      } else if (this.tab === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        const promos = await ozonApi.getPromotions({ client_id: store.client_id, api_key: store.api_key });
        for (const p of promos) {
          this.campaigns.push({
            id: p.action_id ?? p.id,
            name: p.title ?? p.name ?? 'Акция Ozon',
            status: p.is_active ? 'active' : 'inactive',
            type: p.action_type ?? 'promotion',
            budget: 0, spent: 0, clicks: 0, views: 0, orders: 0, revenue: 0, roi: 0,
          });
        }
      } else {
        const stores = await yandexDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        const businessId = store.business_id ? Number(store.business_id) : 0;
        const promos = await getYandexPromos(store, businessId);
        for (const p of promos) {
          this.campaigns.push({
            id: p.id,
            name: p.name ?? 'Акция Яндекс',
            status: p.status === 'ACTIVE' ? 'active' : 'inactive',
            type: 'promotion',
            budget: 0, spent: 0, clicks: 0, views: 0, orders: 0, revenue: 0, roi: 0,
          });
        }
      }

      showToast(`Загружено ${this.campaigns.length} кампаний`, 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.render();
      // restore store selection
      const sel = this.el.querySelector('#ad-store') as HTMLSelectElement | null;
      if (sel && this.storeId) {
        await this.loadStores();
        sel.value = this.storeId;
      }
    }
  }

  private async toggleCampaign(advertId: number, status: 7 | 4 | 8 | 9 | 11): Promise<void> {
    try {
      const stores = await wbDb.getStores();
      const store = stores.find(s => s.id === this.storeId)!;
      await updateWbCampaign(store.api_key, advertId, { status });
      showToast(status === 11 ? 'Кампания приостановлена' : 'Кампания запущена', 'success');
      await this.loadCampaigns();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private showCreateDialog(): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal__header">
          <h3>Новая рекламная кампания WB</h3>
          <button class="btn btn-ghost modal__close" id="ad-modal-close">${I.x}</button>
        </div>
        <div class="modal__body">
          <form id="ad-create-form" class="form-vertical">
            <div class="form-group">
              <label>Название</label>
              <input class="form-input" name="name" required placeholder="Название кампании">
            </div>
            <div class="form-group">
              <label>Дневной бюджет (₽)</label>
              <input class="form-input" type="number" name="budget" min="100" required placeholder="500">
            </div>
            <div class="form-group">
              <label>Тип кампании</label>
              <select class="form-select" name="type">
                <option value="8">Автоматическая</option>
                <option value="6">Поиск</option>
                <option value="7">Каталог</option>
              </select>
            </div>
          </form>
        </div>
        <div class="modal__footer">
          <button class="btn" id="ad-modal-cancel">Отмена</button>
          <button class="btn btn-success" id="ad-modal-submit">${I.plus} Создать</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#ad-modal-close')?.addEventListener('click', close);
    overlay.querySelector('#ad-modal-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#ad-modal-submit')?.addEventListener('click', async () => {
      const form = overlay.querySelector('#ad-create-form') as HTMLFormElement;
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const fd = new FormData(form);
      close();

      try {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === this.storeId)!;
        await createWbAdCampaign(store.api_key, {
          name: fd.get('name') as string,
          subjectId: 0,
          type: Number(fd.get('type')),
          nms: [],
          dailyBudget: Number(fd.get('budget')) * 100,
        });
        showToast('Кампания создана', 'success');
        await this.loadCampaigns();
      } catch (err: any) {
        showToast(`Ошибка: ${err.message}`, 'error');
      }
    });
  }

  show(): void { this.el.style.display = 'flex'; }
  hide(): void { this.el.style.display = 'none'; }
}
