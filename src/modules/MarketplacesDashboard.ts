/**
 * MarketplacesDashboard — обзор всех маркетплейсов и магазинов.
 * Показывает: кол-во магазинов, товаров, стоимость склада, последняя синхронизация.
 */

import { ozonDb } from '@/services/ozonDb';
import { I } from '@/utils/icons';
import { yandexDb } from '@/services/yandexDb';
import { wbDb } from '@/services/wbDb';
import { helpBtn } from '@/services/helpModal';
import { fetchAllOzonProducts } from '@/services/ozonApi';
import { fetchAllWbProducts } from '@/services/wbApi';
import { fetchAllYandexProducts } from '@/services/yandexApi';

interface SyncLogEntry {
  store: string;
  mp: string;
  status: 'pending' | 'syncing' | 'done' | 'error';
  stage?: string;
  created?: number;
  updated?: number;
  total?: number;
  error?: string;
}

interface MpStat {
  key: 'ozon' | 'yandex' | 'wb';
  name: string;
  color: string;
  page: string;
  ordersPage: string;
  storesCount: number;
  productsCount: number;
  activeCount: number;
  archivedCount: number;
  outOfStockCount: number;
  inventoryValue: number;
  lastSync: Date | null;
  stores: { id: string; name: string; products: number; created: string }[];
}

export class MarketplacesDashboard {
  private container: HTMLElement;
  private loading = false;
  private stats: MpStat[] = [];
  private syncing = false;
  private syncLog: SyncLogEntry[] = [];

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }
  hide(): void { this.container.style.display = 'none'; }

  async init(): Promise<void> {
    this.loading = true;
    this.render();
    await this.load();
    this.loading = false;
    this.render();
  }

  private async load(): Promise<void> {
    const [ozStores, ozProducts, ymStores, ymProducts, wbStores, wbProducts] = await Promise.all([
      ozonDb.getStores().catch(() => []),
      ozonDb.getProducts().catch(() => []),
      yandexDb.getStores().catch(() => []),
      yandexDb.getProducts().catch(() => []),
      wbDb.getStores().catch(() => []),
      wbDb.getProducts().catch(() => []),
    ]);

    // Ozon — берём из ozon_products
    const ozActive = ozProducts.filter(p => p.status === 'processed').length;
    const ozArchived = ozProducts.filter(p => p.status === 'archived').length;
    const ozOoS = ozProducts.filter(p => (p.stock_fbs ?? 0) === 0 && (p.stock_fbo ?? 0) === 0).length;
    const ozValue = ozProducts.reduce((s, p) =>
      s + (Number(p.price) || 0) * ((p.stock_fbs ?? 0) + (p.stock_fbo ?? 0)), 0);
    const ozLastSync = ozProducts.reduce<Date | null>((max, p) => {
      const d = p.synced_at ? new Date(p.synced_at) : null;
      return d && (!max || d > max) ? d : max;
    }, null);

    // Яндекс
    const ymActive = ymProducts.filter(p => !p.archived).length;
    const ymArchived = ymProducts.filter(p => p.archived).length;
    const ymOoS = ymProducts.filter(p => (p.stock_total ?? 0) === 0).length;
    const ymValue = ymProducts.reduce((s, p) => s + (p.basic_price ?? 0) * (p.stock_total ?? 0), 0);
    const ymLastSync = ymProducts.reduce<Date | null>((max, p) => {
      const d = p.synced_at ? new Date(p.synced_at) : null;
      return d && (!max || d > max) ? d : max;
    }, null);

    // WB
    const wbActive = wbProducts.length;
    const wbOoS = wbProducts.filter(p => (p.stock_total ?? 0) === 0).length;
    const wbValue = wbProducts.reduce((s, p) => s + (p.price ?? 0) * (p.stock_total ?? 0), 0);
    const wbLastSync = wbProducts.reduce<Date | null>((max, p) => {
      const d = p.synced_at ? new Date(p.synced_at) : null;
      return d && (!max || d > max) ? d : max;
    }, null);

    this.stats = [
      {
        key: 'ozon', name: 'Ozon', color: '#005bff',
        page: 'ozon', ordersPage: 'orders',
        storesCount: ozStores.length, productsCount: ozProducts.length,
        activeCount: ozActive, archivedCount: ozArchived, outOfStockCount: ozOoS,
        inventoryValue: ozValue, lastSync: ozLastSync,
        stores: ozStores.map(s => ({
          id: s.id, name: s.name,
          products: ozProducts.filter(p => p.store_id === s.id).length,
          created: s.created_at,
        })),
      },
      {
        key: 'yandex', name: 'Яндекс Маркет', color: '#fc3f1d',
        page: 'yandex', ordersPage: 'orders',
        storesCount: ymStores.length, productsCount: ymProducts.length,
        activeCount: ymActive, archivedCount: ymArchived, outOfStockCount: ymOoS,
        inventoryValue: ymValue, lastSync: ymLastSync,
        stores: ymStores.map(s => ({
          id: s.id, name: s.name,
          products: ymProducts.filter(p => p.store_id === s.id).length,
          created: s.created_at,
        })),
      },
      {
        key: 'wb', name: 'Wildberries', color: '#cb11ab',
        page: 'wb', ordersPage: 'orders',
        storesCount: wbStores.length, productsCount: wbProducts.length,
        activeCount: wbActive, archivedCount: 0, outOfStockCount: wbOoS,
        inventoryValue: wbValue, lastSync: wbLastSync,
        stores: wbStores.map(s => ({
          id: s.id, name: s.name,
          products: wbProducts.filter(p => p.store_id === s.id).length,
          created: s.created_at,
        })),
      },
    ];
  }

  /**
   * Синхронизация ВСЕХ магазинов всех маркетплейсов.
   * Синхронизирует именно таблицы ozon_products / wb_products / yandex_products
   * (те самые, из которых читает Репрайсер и Аналитика).
   */
  async syncAll(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncLog = [];

    try {
      const [ozStores, ymStores, wbStores] = await Promise.all([
        ozonDb.getStores().catch(() => []),
        yandexDb.getStores().catch(() => []),
        wbDb.getStores().catch(() => []),
      ]);

      for (const s of ozStores) this.syncLog.push({ store: s.name, mp: 'Ozon', status: 'pending' });
      for (const s of wbStores) this.syncLog.push({ store: s.name, mp: 'WB', status: 'pending' });
      for (const s of ymStores) this.syncLog.push({ store: s.name, mp: 'ЯМ', status: 'pending' });

      if (this.syncLog.length === 0) {
        this.syncing = false;
        this.render();
        return;
      }
      this.render();

      let idx = 0;

      // Ozon — загрузить товары через API и сохранить в ozon_products
      for (const store of ozStores) {
        const entry = this.syncLog[idx];
        entry.status = 'syncing';
        entry.stage = 'Загружаем товары...';
        this.render();
        try {
          const products = await fetchAllOzonProducts(store);
          entry.stage = `Сохраняем ${products.length} товаров...`;
          this.renderSyncPanel();
          // If API returned empty (rate-limit, 429) — keep existing data in DB
          if (products.length > 0) {
            await ozonDb.replaceStoreProducts(store.id, products);
          }
          entry.status = 'done';
          entry.total = products.length;
        } catch (e: any) {
          entry.status = 'error';
          entry.error = e?.message || String(e);
        }
        idx++;
        this.render();
      }

      // WB
      for (const store of wbStores) {
        const entry = this.syncLog[idx];
        entry.status = 'syncing';
        entry.stage = 'Загружаем карточки...';
        this.render();
        try {
          const products = await fetchAllWbProducts(store);
          entry.stage = `Сохраняем ${products.length} товаров...`;
          this.renderSyncPanel();
          // If API returned empty (rate-limit, 429) — keep existing data in DB
          if (products.length > 0) {
            await wbDb.replaceStoreProducts(store.id, products);
          }
          entry.status = 'done';
          entry.total = products.length;
        } catch (e: any) {
          entry.status = 'error';
          entry.error = e?.message || String(e);
        }
        idx++;
        this.render();
      }

      // Yandex
      for (const store of ymStores) {
        const entry = this.syncLog[idx];
        entry.status = 'syncing';
        entry.stage = 'Загружаем товары...';
        this.render();
        try {
          const products = await fetchAllYandexProducts(store);
          entry.stage = `Сохраняем ${products.length} товаров...`;
          this.renderSyncPanel();
          // If API returned empty (rate-limit, 429) — keep existing data in DB
          if (products.length > 0) {
            await yandexDb.replaceStoreProducts(store.id, products);
          }
          entry.status = 'done';
          entry.total = products.length;
        } catch (e: any) {
          entry.status = 'error';
          entry.error = e?.message || String(e);
        }
        idx++;
        this.render();
      }

      await this.load();
    } catch (e) {
      console.error('[MpDashboard] syncAll error:', e);
    }
    this.syncing = false;
    this.render();
  }

  /** Синхронизация одного маркетплейса */
  async syncMp(key: 'ozon' | 'yandex' | 'wb'): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncLog = [];

    try {
      if (key === 'ozon') {
        const stores = await ozonDb.getStores();
        for (const s of stores) this.syncLog.push({ store: s.name, mp: 'Ozon', status: 'pending' });
        this.render();
        for (let i = 0; i < stores.length; i++) {
          const entry = this.syncLog[i];
          entry.status = 'syncing'; entry.stage = 'Загружаем товары...'; this.render();
          try {
            const products = await fetchAllOzonProducts(stores[i]);
            entry.stage = `Сохраняем ${products.length} товаров...`; this.renderSyncPanel();
            if (products.length > 0) await ozonDb.replaceStoreProducts(stores[i].id, products);
            entry.status = 'done'; entry.total = products.length;
          } catch (e: any) { entry.status = 'error'; entry.error = e?.message || String(e); }
          this.render();
        }
      } else if (key === 'yandex') {
        const stores = await yandexDb.getStores();
        for (const s of stores) this.syncLog.push({ store: s.name, mp: 'ЯМ', status: 'pending' });
        this.render();
        for (let i = 0; i < stores.length; i++) {
          const entry = this.syncLog[i];
          entry.status = 'syncing'; entry.stage = 'Загружаем товары...'; this.render();
          try {
            const products = await fetchAllYandexProducts(stores[i]);
            entry.stage = `Сохраняем ${products.length} товаров...`; this.renderSyncPanel();
            if (products.length > 0) await yandexDb.replaceStoreProducts(stores[i].id, products);
            entry.status = 'done'; entry.total = products.length;
          } catch (e: any) { entry.status = 'error'; entry.error = e?.message || String(e); }
          this.render();
        }
      } else {
        const stores = await wbDb.getStores();
        for (const s of stores) this.syncLog.push({ store: s.name, mp: 'WB', status: 'pending' });
        this.render();
        for (let i = 0; i < stores.length; i++) {
          const entry = this.syncLog[i];
          entry.status = 'syncing'; entry.stage = 'Загружаем карточки...'; this.render();
          try {
            const products = await fetchAllWbProducts(stores[i]);
            entry.stage = `Сохраняем ${products.length} товаров...`; this.renderSyncPanel();
            if (products.length > 0) await wbDb.replaceStoreProducts(stores[i].id, products);
            entry.status = 'done'; entry.total = products.length;
          } catch (e: any) { entry.status = 'error'; entry.error = e?.message || String(e); }
          this.render();
        }
      }
      await this.load();
    } catch (e) { console.error('[MpDashboard] syncMp error:', e); }
    this.syncing = false;
    this.render();
  }

  /** Быстрый ре-рендер только панели прогресса (не перерисовывая всё) */
  private renderSyncPanel(): void {
    const panel = this.container.querySelector('#mpd-sync-panel');
    if (panel) panel.innerHTML = this.buildSyncPanelInner();
  }

  private buildSyncPanelInner(): string {
    const done = this.syncLog.filter(l => l.status === 'done').length;
    const errors = this.syncLog.filter(l => l.status === 'error').length;
    const total = this.syncLog.length;
    const current = this.syncLog.find(l => l.status === 'syncing');

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        ${this.syncing ? `<svg class="oz-spin" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" style="width:18px;height:18px;flex-shrink:0"><path d="M21 12a9 9 0 1 1-9-9" stroke-dasharray="40 20"/></svg>` : ''}
        <div style="font-size:13px;font-weight:700;color:var(--text)">
          ${this.syncing ? `Синхронизация: ${done}/${total}` : `Готово: ${done} из ${total}${errors ? `, ошибок: ${errors}` : ''}`}
        </div>
        ${current ? `<div style="font-size:11px;color:var(--text-2)">${this.esc(current.mp)}: ${this.esc(current.store)}${current.stage ? ` — ${current.stage}` : ''}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${this.syncLog.map(l => {
          const icon = l.status === 'done' ? I.checkCircle('', 14) : l.status === 'error' ? I.xCircle('', 14) : l.status === 'syncing' ? I.hourglass('', 14) : '';
          const detail = l.status === 'done'
            ? `<span style="color:var(--text-2);font-size:10px;margin-left:6px">${l.total ?? 0} товаров</span>`
            : l.status === 'error'
            ? `<span style="color:#ef4444;font-size:10px;margin-left:6px">${this.esc(l.error)}</span>`
            : l.status === 'syncing' && l.stage
            ? `<span style="color:var(--text-2);font-size:10px;margin-left:6px">${this.esc(l.stage)}</span>`
            : '';
          return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text);padding:3px 0">
            <span>${icon}</span>
            <span style="font-weight:600;min-width:40px">${this.esc(l.mp)}</span>
            <span>${this.esc(l.store)}</span>
            ${detail}
          </div>`;
        }).join('')}
      </div>
    `;
  }

  private fmtN(n: number): string { return n.toLocaleString('ru'); }
  private fmtMoney(n: number): string { return Math.round(n).toLocaleString('ru') + ' ₽'; }
  private fmtAgo(d: Date | null): string {
    if (!d) return 'никогда';
    const ms = Date.now() - d.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин назад`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ч назад`;
    return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  private esc(s: string | null | undefined): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  render(): void {
    if (this.loading) {
      this.container.innerHTML = `
        <div class="oz-wrap"><div class="ord-loader">
          <div class="ord-loader-spinner">
            <svg class="oz-spin" viewBox="0 0 40 40" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" style="width:48px;height:48px"><path d="M36 20A16 16 0 1 1 20 4" stroke-dasharray="60 30"/></svg>
          </div>
          <div class="ord-loader-title">Загружаем данные…</div>
        </div></div>`;
      return;
    }

    const totalStores   = this.stats.reduce((s, m) => s + m.storesCount, 0);
    const totalProducts = this.stats.reduce((s, m) => s + m.productsCount, 0);
    const totalActive   = this.stats.reduce((s, m) => s + m.activeCount, 0);
    const totalOoS      = this.stats.reduce((s, m) => s + m.outOfStockCount, 0);
    const totalValue    = this.stats.reduce((s, m) => s + m.inventoryValue, 0);

    // Sync progress bar %
    const syncDone  = this.syncLog.filter(l => l.status === 'done' || l.status === 'error').length;
    const syncTotal = this.syncLog.length;
    const syncPct   = syncTotal > 0 ? Math.round((syncDone / syncTotal) * 100) : 0;

    this.container.innerHTML = `
      <div class="oz-wrap">
        <!-- ── Topbar ── -->
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
              </svg>
              <div>
                <div class="oz-brand-name">API Маркет</div>
                <div style="font-size:10px;color:var(--text-2);font-weight:400;margin-top:1px">Управление подключениями</div>
              </div>
            </div>
          </div>
          <div class="oz-topbar-right">
            ${helpBtn('marketplaces')}
            <button class="btn" onclick="window.marketplacesDashboard.init()" ${this.syncing ? 'disabled' : ''} title="Обновить статистику">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M14 8A6 6 0 1 1 8.5 2.1M14 2v4h-4"/></svg>
              Обновить
            </button>
            <button onclick="window.marketplacesDashboard.syncAll()" ${this.syncing ? 'disabled' : ''}
              style="display:inline-flex;align-items:center;gap:7px;padding:7px 16px;border:none;background:var(--accent);color:#000;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;opacity:${this.syncing?'.7':'1'};transition:opacity .15s">
              ${this.syncing
                ? `<svg class="oz-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M14 8A6 6 0 1 1 8.5 2.1" stroke-dasharray="25 12"/></svg>Синхронизация…`
                : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px"><path d="M3 8a5 5 0 1 0 5-5M3 3v5h5"/></svg>Синхронизировать всё`}
            </button>
          </div>
        </div>

        <div style="flex:1;overflow:auto;padding:20px 24px 80px">
          <div style="max-width:1280px;margin:0 auto">

            <!-- ── Сводная строка ── -->
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
              ${[
                { val: this.fmtN(totalStores),   lbl: 'Магазинов',      sub: 'подключено', color: 'var(--text)' },
                { val: this.fmtN(totalProducts),  lbl: 'Товаров',        sub: `${this.fmtN(totalActive)} активных`, color: 'var(--text)' },
                { val: this.fmtN(totalOoS),       lbl: 'Нет в наличии',  sub: 'позиций', color: totalOoS > 0 ? '#ef4444' : '#16a34a' },
                { val: this.fmtMoney(totalValue), lbl: 'Склад',          sub: 'остатки × цена', color: 'var(--accent)' },
              ].map(c => `
                <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px 18px">
                  <div style="font-size:22px;font-weight:800;color:${c.color};letter-spacing:-.5px;line-height:1.1">${c.val}</div>
                  <div style="font-size:11px;font-weight:700;color:var(--text);margin-top:4px;text-transform:uppercase;letter-spacing:.4px">${c.lbl}</div>
                  <div style="font-size:11px;color:var(--text-2);margin-top:2px">${c.sub}</div>
                </div>
              `).join('')}
            </div>

            <!-- ── Панель синхронизации ── -->
            ${this.syncLog.length > 0 ? `
              <div id="mpd-sync-panel" style="margin-bottom:20px;background:var(--bg2);border:1px solid var(--border);border-radius:14px;overflow:hidden">
                <!-- Прогресс-бар -->
                <div style="height:3px;background:var(--border)">
                  <div style="height:100%;width:${syncPct}%;background:var(--accent);transition:width .4s ease;border-radius:3px"></div>
                </div>
                <div style="padding:14px 18px">
                  ${this.buildSyncPanelInner()}
                </div>
              </div>
            ` : ''}

            <!-- ── Карточки маркетплейсов ── -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px">
              ${this.stats.map(m => this.renderMpCard(m)).join('')}
            </div>

            <!-- ── Гистограмма ── -->
            ${totalProducts > 0 ? `
              <div style="margin-top:24px;background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px 20px">
                <div style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Распределение товаров</div>
                <div style="display:flex;height:6px;border-radius:6px;overflow:hidden;gap:2px;margin-bottom:12px">
                  ${this.stats.filter(m => m.productsCount > 0).map(m => {
                    const pct = (m.productsCount / totalProducts) * 100;
                    return `<div style="width:${pct}%;background:${m.color};border-radius:3px" title="${m.name}: ${this.fmtN(m.productsCount)} (${pct.toFixed(1)}%)"></div>`;
                  }).join('')}
                </div>
                <div style="display:flex;gap:20px;flex-wrap:wrap">
                  ${this.stats.filter(m => m.productsCount > 0).map(m => {
                    const pct = (m.productsCount / totalProducts) * 100;
                    return `<div style="display:flex;align-items:center;gap:6px;font-size:12px">
                      <span style="width:8px;height:8px;border-radius:50%;background:${m.color};flex-shrink:0"></span>
                      <span style="color:var(--text)">${m.name}</span>
                      <span style="color:var(--text-2)">${this.fmtN(m.productsCount)} (${pct.toFixed(1)}%)</span>
                    </div>`;
                  }).join('')}
                </div>
              </div>
            ` : ''}

          </div>
        </div>
      </div>
    `;
  }

  private renderMpCard(m: MpStat): string {
    const isEmpty = m.storesCount === 0;
    const syncEntry = this.syncLog.find(l => l.mp === (m.key === 'ozon' ? 'Ozon' : m.key === 'wb' ? 'WB' : 'ЯМ'));
    const isSyncing = syncEntry?.status === 'syncing';

    // MP-specific icons
    const mpIcon = m.key === 'ozon'
      ? `<svg viewBox="0 0 32 32" fill="none" style="width:20px;height:20px"><circle cx="16" cy="16" r="14" fill="white" opacity=".15"/><text x="16" y="21" text-anchor="middle" font-size="14" font-weight="800" fill="white" font-family="sans-serif">O</text></svg>`
      : m.key === 'wb'
      ? `<svg viewBox="0 0 32 32" fill="none" style="width:20px;height:20px"><circle cx="16" cy="16" r="14" fill="white" opacity=".15"/><text x="16" y="21" text-anchor="middle" font-size="11" font-weight="800" fill="white" font-family="sans-serif">WB</text></svg>`
      : `<svg viewBox="0 0 32 32" fill="none" style="width:20px;height:20px"><circle cx="16" cy="16" r="14" fill="white" opacity=".15"/><text x="16" y="21" text-anchor="middle" font-size="14" font-weight="800" fill="white" font-family="sans-serif">Я</text></svg>`;

    return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;overflow:hidden;display:flex;flex-direction:column">

        <!-- Header -->
        <div style="background:${m.color};padding:16px 18px;display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            ${mpIcon}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:800;color:#fff">${m.name}</div>
            <div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:1px">
              ${isEmpty ? 'Не подключено' : `Синхронизация: ${this.fmtAgo(m.lastSync)}`}
            </div>
          </div>
          ${!isEmpty ? `
            <div style="display:flex;align-items:center;gap:4px;background:rgba(255,255,255,.18);border-radius:20px;padding:3px 10px">
              <span style="width:6px;height:6px;border-radius:50%;background:#4ade80;flex-shrink:0"></span>
              <span style="font-size:10px;color:#fff;font-weight:600">${m.storesCount} маг.</span>
            </div>
          ` : ''}
        </div>

        <div style="padding:16px 18px;flex:1;display:flex;flex-direction:column;gap:0">

          ${isEmpty ? `
            <!-- Пустое состояние -->
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 0;gap:10px;text-align:center">
              <div style="width:48px;height:48px;border-radius:12px;background:rgba(128,128,128,.1);display:flex;align-items:center;justify-content:center;font-size:22px">${I.plug('',22)}</div>
              <div style="font-size:13px;font-weight:700;color:var(--text)">Не подключено</div>
              <div style="font-size:12px;color:var(--text-2);max-width:220px;line-height:1.4">Добавьте первый магазин ${m.name} чтобы начать работу</div>
              <button onclick="window.app.navigateTo('${m.page}')"
                style="margin-top:6px;padding:8px 20px;border:none;background:${m.color};color:#fff;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700">
                Подключить магазин
              </button>
            </div>
          ` : `
            <!-- Метрики -->
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px">
              ${[
                { v: this.fmtN(m.productsCount), l: 'Товаров', c: m.color },
                { v: this.fmtN(m.activeCount),   l: 'Активных', c: '#16a34a' },
                { v: this.fmtN(m.archivedCount), l: 'В архиве', c: '#94a3b8' },
                { v: this.fmtN(m.outOfStockCount), l: 'OoS', c: '#ef4444' },
              ].map(s => `
                <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 6px;text-align:center">
                  <div style="font-size:16px;font-weight:800;color:${s.c};letter-spacing:-.3px">${s.v}</div>
                  <div style="font-size:9px;color:var(--text-2);margin-top:2px;font-weight:600;text-transform:uppercase;letter-spacing:.3px">${s.l}</div>
                </div>
              `).join('')}
            </div>

            <!-- Стоимость склада -->
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
              <span style="font-size:11px;color:var(--text-2);font-weight:600">Стоимость склада</span>
              <span style="font-size:14px;font-weight:800;color:${m.color}">${this.fmtMoney(m.inventoryValue)}</span>
            </div>

            <!-- Магазины -->
            <div style="margin-bottom:14px">
              <div style="font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Магазины</div>
              ${m.stores.map(s => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                  <span style="width:6px;height:6px;border-radius:50%;background:${m.color};flex-shrink:0"></span>
                  <span style="flex:1;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(s.name)}</span>
                  <span style="font-size:11px;color:var(--text-2);white-space:nowrap">${this.fmtN(s.products)} тов.</span>
                </div>
              `).join('')}
            </div>

            <!-- Кнопки действий -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:auto">
              <button onclick="window.app.navigateTo('${m.page}')"
                style="padding:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:5px">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px;flex-shrink:0"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>
                Настройки
              </button>
              <button onclick="window.marketplacesDashboard.syncMp('${m.key}')" ${this.syncing ? 'disabled' : ''}
                style="padding:8px;border:1px solid ${m.color};background:${isSyncing ? m.color : 'transparent'};color:${isSyncing ? '#fff' : m.color};border-radius:8px;cursor:pointer;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px;opacity:${this.syncing && !isSyncing ? '.5' : '1'}">
                ${isSyncing
                  ? `<svg class="oz-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M14 8A6 6 0 1 1 8.5 2.1" stroke-dasharray="25 12"/></svg>Синхр.…`
                  : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:12px;height:12px"><path d="M3 8a5 5 0 1 0 5-5M3 3v5h5"/></svg>Синхр. товары`}
              </button>
            </div>
          `}
        </div>
      </div>
    `;
  }
}
