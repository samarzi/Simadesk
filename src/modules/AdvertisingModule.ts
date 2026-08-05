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

function fmt(n: number): string { return n.toLocaleString('ru-RU'); }

function statusChip(s: string): string {
  const map: Record<string, [string, string]> = {
    active:   ['Активна',     '#10b981'],
    paused:   ['Пауза',       '#f59e0b'],
    stopped:  ['Остановлена', '#ef4444'],
    inactive: ['Неактивна',   '#6b7280'],
  };
  const [text, color] = map[s] ?? [s, '#6b7280'];
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${color}22;color:${color}">${text}</span>`;
}

export class AdvertisingModule {
  private el: HTMLElement;
  private tab: Tab = 'wb';
  private storeId = '';
  private stores: Array<{ id: string; name: string }> = [];
  private campaigns: Campaign[] = [];
  private loading = false;
  private dateFrom: string;
  private dateTo: string;
  private eventsAC = new AbortController();

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden';
    const now = new Date();
    this.dateTo   = now.toISOString().slice(0, 10);
    this.dateFrom = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    this.buildShell();
    this.loadStores();
  }

  // ── Shell ───────────────────────────────────────────────────────────────────

  private buildShell(): void {
    this.el.innerHTML = `
      <div class="rpr" style="flex:1;min-height:0">

        <div class="rpr-header">
          <div class="rpr-header-left">
            <div class="rpr-logo-icon" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">
              ${I.chartBar()}
            </div>
            <span class="rpr-logo-text">Реклама</span>
            <div class="an2-tabs" id="ad-tabs">
              ${(['wb','ozon','yandex'] as Tab[]).map(t => `
                <button class="an2-tab ${t === this.tab ? 'active' : ''}" data-tab="${t}">
                  ${t === 'wb' ? 'Wildberries' : t === 'ozon' ? 'Ozon' : 'Яндекс.Маркет'}
                </button>`).join('')}
            </div>
          </div>
          <div class="rpr-header-actions">
            <select class="form-select" id="ad-store"
              style="min-width:180px;height:30px;font-size:12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:0 8px">
              <option value="">Загрузка...</option>
            </select>
            ${this.tab === 'wb' ? `
              <div class="an2-period-custom" id="ad-period">
                <input type="date" id="ad-from" value="${this.dateFrom}">
                <span style="color:var(--text3)">—</span>
                <input type="date" id="ad-to"   value="${this.dateTo}">
              </div>` : ''}
            ${this.tab === 'wb' ? `<button class="rpr-btn rpr-btn-green" id="ad-create">${I.plus()} Кампания</button>` : ''}
            <button class="rpr-btn rpr-btn-ghost" id="ad-load">${I.refresh()} Загрузить</button>
          </div>
        </div>

        <div id="ad-stats"></div>

        <div class="rpr-body" id="ad-body" style="overflow:auto">
          ${this.renderBody()}
        </div>

      </div>`;
    this.bindAll();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private renderBody(): string {
    if (this.loading) return this.renderSkeleton();
    if (!this.storeId) return this.renderEmpty('Выберите магазин для загрузки данных');
    if (!this.campaigns.length) return this.renderEmpty('Нет данных. Нажмите «Загрузить».');
    return this.tab === 'wb' ? this.renderWbTable() : this.renderPromoTable();
  }

  private renderSkeleton(): string {
    return `<div style="padding:20px;display:flex;flex-direction:column;gap:10px">
      ${Array(6).fill(`<div style="height:40px;border-radius:8px;background:var(--bg3)"></div>`).join('')}
    </div>`;
  }

  private renderEmpty(msg: string): string {
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;gap:10px;color:var(--text2)">
      <div style="font-size:36px;opacity:.3">${I.chartBar()}</div>
      <p style="margin:0;font-size:14px">${msg}</p>
    </div>`;
  }

  private renderStats(): string {
    if (!this.campaigns.length) return '';
    const budget  = this.campaigns.reduce((s, c) => s + c.budget,  0);
    const spent   = this.campaigns.reduce((s, c) => s + c.spent,   0);
    const revenue = this.campaigns.reduce((s, c) => s + c.revenue, 0);
    const orders  = this.campaigns.reduce((s, c) => s + c.orders,  0);
    const views   = this.campaigns.reduce((s, c) => s + c.views,   0);
    const clicks  = this.campaigns.reduce((s, c) => s + c.clicks,  0);
    const ctr     = views > 0 ? (clicks / views * 100).toFixed(2) : '0.00';
    const roi     = spent > 0 ? ((revenue - spent) / spent * 100) : 0;
    const roiStr  = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
    const roiColor = roi >= 0 ? '#10b981' : '#ef4444';

    const tiles = [
      ['Бюджет/д.',  fmt(budget) + ' ₽',   '#6366f1'],
      ['Потрачено',  fmt(spent) + ' ₽',    '#f59e0b'],
      ['Выручка',    fmt(revenue) + ' ₽',  '#10b981'],
      ['Заказы',     String(orders),        '#3b82f6'],
      ['CTR',        ctr + '%',             '#8b5cf6'],
      ['ROI',        roiStr,                roiColor],
    ];

    return `<div style="display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      ${tiles.map(([label, val, color]) => `
        <div style="flex:1;min-width:110px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:4px">${label}</div>
          <div style="font-size:17px;font-weight:800;color:${color};font-variant-numeric:tabular-nums">${val}</div>
        </div>`).join('')}
    </div>`;
  }

  private renderWbTable(): string {
    return `<table class="rpr-table" style="width:100%">
      <thead><tr>
        <th>Кампания</th>
        <th>Статус</th>
        <th>Тип</th>
        <th class="num">Бюджет/д.</th>
        <th class="num">Потрачено</th>
        <th class="num">Показы</th>
        <th class="num">Клики</th>
        <th class="num">Заказы</th>
        <th class="num">ROI</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${this.campaigns.map(c => {
          const roiColor = c.roi >= 0 ? '#10b981' : '#ef4444';
          return `<tr>
            <td style="font-weight:600;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</td>
            <td>${statusChip(c.status)}</td>
            <td style="color:var(--text2);font-size:12px">${esc(c.type)}</td>
            <td class="num">${c.budget ? fmt(c.budget) + ' ₽' : '—'}</td>
            <td class="num">${c.spent ? fmt(c.spent) + ' ₽' : '—'}</td>
            <td class="num">${fmt(c.views)}</td>
            <td class="num">${fmt(c.clicks)}</td>
            <td class="num">${c.orders}</td>
            <td class="num" style="font-weight:700;color:${roiColor}">${c.roi >= 0 ? '+' : ''}${c.roi.toFixed(1)}%</td>
            <td>
              ${c.status === 'active'
                ? `<button class="rpr-btn rpr-btn-ghost" style="padding:3px 8px;font-size:11px" data-action="pause"  data-id="${c.id}">⏸ Пауза</button>`
                : `<button class="rpr-btn rpr-btn-ghost" style="padding:3px 8px;font-size:11px" data-action="resume" data-id="${c.id}">▶ Запуск</button>`}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  private renderPromoTable(): string {
    const mpLabel = this.tab === 'ozon' ? 'Ozon' : 'Яндекс.Маркет';
    return `<table class="rpr-table" style="width:100%">
      <thead><tr>
        <th>ID</th>
        <th>Название ${mpLabel}</th>
        <th>Тип</th>
        <th>Статус</th>
      </tr></thead>
      <tbody>
        ${this.campaigns.map(c => `<tr>
          <td style="color:var(--text2);font-size:12px"><code>${esc(String(c.id))}</code></td>
          <td style="font-weight:600">${esc(c.name)}</td>
          <td style="color:var(--text2);font-size:12px">${esc(c.type)}</td>
          <td>${statusChip(c.status)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private bindAll(): void {
    this.eventsAC.abort();
    this.eventsAC = new AbortController();
    const { signal } = this.eventsAC;

    this.el.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      const tabVal = btn.dataset.tab as Tab | undefined;
      if (tabVal) {
        this.tab = tabVal;
        this.storeId = '';
        this.campaigns = [];
        this.buildShell();
        this.loadStores();
        return;
      }

      switch (btn.id) {
        case 'ad-load':   await this.loadCampaigns(); break;
        case 'ad-create': this.showCreateDialog(); break;
      }

      if (btn.dataset.action === 'pause')  await this.toggleCampaign(Number(btn.dataset.id), 11 as 11);
      if (btn.dataset.action === 'resume') await this.toggleCampaign(Number(btn.dataset.id), 9 as 9);
    }, { signal });

    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      if (t.id === 'ad-store') { this.storeId = t.value; this.flush(); }
      if (t.id === 'ad-from')  this.dateFrom = t.value;
      if (t.id === 'ad-to')    this.dateTo   = t.value;
    }, { signal });
  }

  private flush(): void {
    const body  = this.el.querySelector('#ad-body');
    const stats = this.el.querySelector('#ad-stats');
    if (body)  body.innerHTML  = this.renderBody();
    if (stats) stats.innerHTML = this.renderStats();
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  private async loadStores(): Promise<void> {
    const sel = this.el.querySelector('#ad-store') as HTMLSelectElement | null;
    if (!sel) return;
    this.stores = [];
    try {
      if (this.tab === 'wb')     this.stores = await wbDb.getStores();
      else if (this.tab === 'ozon') this.stores = await ozonDb.getStores();
      else                          this.stores = await yandexDb.getStores();
    } catch { /* ignore */ }

    if (!this.stores.length) {
      sel.innerHTML = '<option value="">Нет магазинов</option>';
      this.storeId = '';
      this.flush();
      return;
    }
    sel.innerHTML = '<option value="">— Магазин —</option>' +
      this.stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

    if (this.stores.length === 1) {
      this.storeId = this.stores[0].id;
      sel.value = this.storeId;
    }
    this.flush();
  }

  private async loadCampaigns(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    this.loading = true;
    this.flush();

    try {
      this.campaigns = [];
      const store = this.stores.find(s => s.id === this.storeId) as any;

      if (this.tab === 'wb') {
        const list = await getWbCampaigns(store.api_key);
        for (const c of list) {
          let stats: any = {};
          try {
            const data = await fetchWbAdStats(store.api_key, [c.advertId], this.dateFrom, this.dateTo);
            if (data.length) stats = data[0];
          } catch { /* ignore stats */ }
          const spent   = stats.sum ?? 0;
          const revenue = (stats.orders ?? 0) * (stats.avgPrice ?? 0);
          this.campaigns.push({
            id: c.advertId,
            name: c.name ?? `Кампания ${c.advertId}`,
            status: c.status === 9 ? 'active' : c.status === 11 ? 'paused' : 'stopped',
            type: c.type === 8 ? 'Авто' : c.type === 6 ? 'Поиск' : 'Каталог',
            budget: c.dailyBudget ?? 0,
            spent,
            clicks: stats.clicks ?? 0,
            views:  stats.views  ?? 0,
            orders: stats.orders ?? 0,
            revenue,
            roi: spent > 0 ? (revenue - spent) / spent * 100 : 0,
          });
        }

      } else if (this.tab === 'ozon') {
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

      showToast(`Загружено: ${this.campaigns.length}`, 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.flush();
    }
  }

  private async toggleCampaign(advertId: number, status: 7 | 4 | 8 | 9 | 11): Promise<void> {
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await updateWbCampaign(store.api_key, advertId, { status });
      showToast(status === 11 ? 'Кампания на паузе' : 'Кампания запущена', 'success');
      await this.loadCampaigns();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private showCreateDialog(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:24px;width:400px;max-width:90vw">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <h3 style="margin:0;font-size:16px;font-weight:800">Новая кампания WB</h3>
          <button id="ad-dlg-close" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px">✕</button>
        </div>
        <form id="ad-dlg-form" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px">Название</label>
            <input name="name" required placeholder="Название кампании"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
          </div>
          <div>
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px">Дневной бюджет (₽)</label>
            <input name="budget" type="number" min="100" required placeholder="500"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
          </div>
          <div>
            <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px">Тип кампании</label>
            <select name="type"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none">
              <option value="8">Автоматическая</option>
              <option value="6">Поиск</option>
              <option value="7">Каталог</option>
            </select>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
            <button type="button" id="ad-dlg-cancel" class="rpr-btn rpr-btn-ghost">Отмена</button>
            <button type="submit" class="rpr-btn rpr-btn-green">${I.plus()} Создать</button>
          </div>
        </form>
      </div>`;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#ad-dlg-close')?.addEventListener('click', close);
    overlay.querySelector('#ad-dlg-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    (overlay.querySelector('#ad-dlg-form') as HTMLFormElement).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      close();
      try {
        const store = this.stores.find(s => s.id === this.storeId) as any;
        await createWbAdCampaign(store.api_key, {
          name:        fd.get('name') as string,
          subjectId:   0,
          type:        Number(fd.get('type')),
          nms:         [],
          dailyBudget: Number(fd.get('budget')) * 100,
        });
        showToast('Кампания создана', 'success');
        await this.loadCampaigns();
      } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
    });
  }

  show(): void { this.el.style.display = 'flex'; }
  hide(): void { this.el.style.display = 'none'; }
}
