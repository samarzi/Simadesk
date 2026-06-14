/**
 * WbOrdersModule — заказы Wildberries.
 */

import { debug } from '@/utils/debug';
import { WbStore, WbProduct, WbOrder, WbOrderStatus } from '@/types/wb';
import { wbDb } from '@/services/wbDb';
import { fetchAllWbOrders, wbApi, isWbCoolingDown, wbCooldownRemaining } from '@/services/wbApi';
import { I } from '@/utils/icons';

const STATUS_LABELS: Record<WbOrderStatus, string> = {
  new:         'Новый',
  confirm:     'На сборке',
  complete:    'В доставке',
  cancel:      'Отменён',
  arbitration: 'Арбитраж',
  unknown:     'Неизвестно',
};
const STATUS_CSS: Record<WbOrderStatus, string> = {
  new:         'ord-s-new',
  confirm:     'ord-s-ready',
  complete:    'ord-s-delivering',
  cancel:      'ord-s-cancelled',
  arbitration: 'ord-s-arbitration',
  unknown:     'ord-s-cancelled',
};

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('ru', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return d; }
}

export class WbOrdersModule {
  private container: HTMLElement;
  private stores: WbStore[] = [];
  private orders: WbOrder[] = [];
  private products: WbProduct[] = [];
  private period = '7';
  private loading = false;
  private abortController: AbortController | null = null;
  private lastError = '';

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }
  hide(): void { this.container.style.display = 'none'; }

  async init(): Promise<void> {
    this.render();
    [this.stores, this.products] = await Promise.all([
      wbDb.getStores(),
      wbDb.getProducts().catch(() => [] as WbProduct[]),
    ]);
    if (this.stores.length === 0) { this.renderEmpty(); return; }
    this.render();
    this.loadOrders();
  }

  private getProductImage(vendorCode: string): string | null {
    const p = this.products.find(p => p.vendor_code === vendorCode);
    return p?.pictures?.[0] ?? null;
  }
  private getProductName(vendorCode: string): string | null {
    const p = this.products.find(p => p.vendor_code === vendorCode);
    return p?.title ?? null;
  }

  private getDateFrom(): string {
    const now = new Date();
    let days = 7;
    if (this.period === '30') days = 30;
    else if (this.period === '90') days = 90;
    const from = new Date(now.getTime() - days * 86_400_000);
    return from.toISOString().slice(0, 19);
  }

  private async loadOrders(): Promise<void> {
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;

    this.loading = true;
    this.lastError = isWbCoolingDown() ? `WB rate-limit — подождите ещё ${wbCooldownRemaining()} сек.` : '';
    this.render();
    if (isWbCoolingDown()) { this.loading = false; this.render(); return; }
    const dateFrom = this.getDateFrom();
    const all: WbOrder[] = [];
    await Promise.all(this.stores.map(async store => {
      try {
        const orders = await fetchAllWbOrders(store, dateFrom, signal);
        all.push(...orders);
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.error(`[WB Orders] ${store.name}:`, err);
      }
    }));
    if (this.abortController !== ac) return;
    this.orders = all.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    this.loading = false; this.render();
  }

  setPeriod(p: string): void {
    if (this.period === p) return;
    this.period = p; this.orders = []; this.render(); this.loadOrders();
  }

  refresh(): void { this.orders = []; this.loadOrders(); }

  private renderEmpty(): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" fill="#cb11ab"/>
                <text x="12" y="17" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="Arial">WB</text>
              </svg>
              <span class="oz-brand-name">Заказы — Wildberries</span>
            </div>
          </div>
        </div>
        <div class="oz-empty" style="margin-top:60px">
          <div class="oz-empty-title">Нет подключённых магазинов WB</div>
          <div class="oz-empty-sub">Добавь магазин в разделе <b>Маркетплейсы → Wildberries</b></div>
        </div>
      </div>`;
  }

  render(): void {
    if (!this.stores.length) { this.renderEmpty(); return; }
    const totalSum = this.orders.reduce((s, o) => s + o.total, 0);
    const cnt = (st: WbOrderStatus) => this.orders.filter(o => o.status === st).length;
    const sumOf = (sts: WbOrderStatus[]) =>
      this.orders.filter(o => sts.includes(o.status)).reduce((s, o) => s + o.total, 0);

    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" fill="#cb11ab"/>
                <text x="12" y="17" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="Arial">WB</text>
              </svg>
              <span class="oz-brand-name">Заказы — Wildberries</span>
            </div>
          </div>
          <div class="oz-topbar-right">
            <button class="btn btn-primary" onclick="window.wbOrdersModule.refresh()" ${this.loading ? 'disabled' : ''}>
              ${this.loading ? 'Загрузка…' : 'Обновить'}
            </button>
          </div>
        </div>

        <div class="oz-filter-bar">
          <div class="oz-filter-group">
            <span class="oz-filter-label">Период</span>
            <div class="oz-filter-pills">
              ${['7','30','90'].map(p => `
                <button class="oz-fpill ${this.period === p ? 'active' : ''}"
                  onclick="window.wbOrdersModule.setPeriod('${p}')">${p} дней</button>
              `).join('')}
            </div>
          </div>
          <span class="oz-filter-count">${this.orders.length} заказов · ${Math.round(totalSum).toLocaleString('ru')} ₽</span>
        </div>

        ${this.orders.length > 0 ? `
          <div class="ord-stats-bar">
            ${[
              { label: 'Всего',     count: this.orders.length, sum: totalSum,             cls: '' },
              { label: 'Новых',     count: cnt('new'),         sum: sumOf(['new']),       cls: 'ord-stat-new' },
              { label: 'На сборке', count: cnt('confirm'),     sum: sumOf(['confirm']),   cls: 'ord-stat-ready' },
              { label: 'Доставка',  count: cnt('complete'),    sum: sumOf(['complete']),  cls: 'ord-stat-del' },
              { label: 'Отменено',  count: cnt('cancel'),      sum: sumOf(['cancel']),    cls: 'ord-stat-cancel' },
            ].map(s => `
              <div class="ord-stat ${s.cls}">
                <span class="ord-stat-val">${s.count.toLocaleString('ru')}</span>
                <span class="ord-stat-lbl">${s.label}</span>
                <span class="ord-stat-sum">${Math.round(s.sum).toLocaleString('ru')} ₽</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="oz-body" style="flex:1;overflow:auto;padding-bottom:90px">${this.renderContent()}</div>
      </div>
    `;
  }

  private renderContent(): string {
    if (this.loading && !this.orders.length) {
      return `
        <div class="ord-loader">
          <div class="ord-loader-spinner">
            <svg class="oz-spin" viewBox="0 0 40 40" fill="none" stroke="#cb11ab" stroke-width="3" stroke-linecap="round" style="width:48px;height:48px">
              <path d="M36 20A16 16 0 1 1 20 4" stroke-dasharray="60 30"/>
            </svg>
          </div>
          <div class="ord-loader-title">Загружаем заказы WB</div>
          <div class="ord-loader-sub">Период: ${this.period} дней</div>
          <div class="ord-loader-bar"><div class="ord-loader-bar-fill" style="background:linear-gradient(90deg,transparent,#cb11ab,transparent)"></div></div>
        </div>`;
    }
    if (this.lastError) return `<div class="oz-empty"><div class="oz-empty-title" style="color:#ef4444">${this.esc(this.lastError)}</div></div>`;
    if (!this.orders.length) return `<div class="oz-empty"><div class="oz-empty-title">Заказов нет</div></div>`;

    const rows = this.orders.map(o => {
      const storeName = this.stores.find(s => s.id === o.store_id)?.name ?? '—';
      const first = o.items[0];
      // Стек миниатюр
      const thumbsHtml = o.items.slice(0, 3).map((it, i) => {
        const img = this.getProductImage(it.vendor_code);
        const offset = i * 16;
        const cell = img
          ? `<img src="${this.esc(img)}" loading="lazy" style="width:36px;height:36px;border-radius:6px;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display='none'">`
          : `<div style="width:36px;height:36px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px">${I.package('',14)}</div>`;
        return `<div style="position:absolute;left:${offset}px;top:0;z-index:${10 - i}">${cell}</div>`;
      }).join('');
      const thumbsCount = Math.min(o.items.length, 3);
      const thumbsCell = `<div style="position:relative;width:${36 + (thumbsCount - 1) * 16}px;height:36px">${thumbsHtml}</div>`;
      return `
        <tr class="oz-row" onclick="window.wbOrdersModule.openOrderModal(${o.id})">
          <td onclick="event.stopPropagation()" style="padding:8px 10px">
            <span class="oz-sku-chip" onclick="window.wbOrdersModule.copyText('${o.id}', this)">
              <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
              <span class="oz-sku-chip-text">${o.id}</span>
            </span>
            <div class="oz-muted" style="font-size:11px;margin-top:3px">${this.esc(storeName)}</div>
          </td>
          <td><span class="oz-badge ${STATUS_CSS[o.status]}">${STATUS_LABELS[o.status]}</span></td>
          <td class="oz-muted">${fmtDateTime(o.created_at)}</td>
          <td style="padding:6px 8px">${thumbsCell}</td>
          <td>${first ? `<div class="ord-product-line"><span class="oz-sku-chip" onclick="event.stopPropagation();window.wbOrdersModule.copyText('${this.esc(first.vendor_code)}', this)">${this.esc(first.vendor_code)}</span> <span class="ord-qty">× ${first.count}</span></div>${first.name ? `<div class="oz-muted" style="font-size:11px;margin-top:2px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(first.name)}</div>` : ''}` : '—'}</td>
          <td class="oz-prc" style="text-align:right;white-space:nowrap;font-weight:700">${Math.round(o.total).toLocaleString('ru')} ₽</td>
          <td class="oz-muted">${this.esc(o.delivery_address ?? o.warehouse_name ?? '—')}</td>
        </tr>`;
    }).join('');

    return `
      <div class="oz-table-wrap">
        <table class="oz-table">
          <thead><tr>
            <th>Заказ</th><th>Статус</th><th>Создан</th>
            <th style="width:60px"></th><th>Состав</th>
            <th style="text-align:right">Сумма</th><th>Регион</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Модалка предпросмотра ──────────────────────────────────────

  openOrderModal(orderId: number): void {
    const o = this.orders.find(x => x.id === orderId);
    if (!o) return;
    let modal = document.getElementById('wbo-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'wbo-modal';
      modal.className = 'ozo-modal-backdrop';
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    modal.innerHTML = this.modalShell(String(o.id), this.renderModalSubtitle(o), this.renderModalBody(o));
    this.bindModalClose(modal);
  }

  private renderModalSubtitle(o: WbOrder): string {
    const storeName = this.stores.find(s => s.id === o.store_id)?.name ?? '—';
    const isNew = o.status === 'new';
    return `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        <span class="oz-badge ${STATUS_CSS[o.status]}">${STATUS_LABELS[o.status]}</span>
        <span class="ozo-pill" style="display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#cb11ab"></span>
          ${this.esc(storeName)}
        </span>
        ${isNew ? '<span class="ord-new-badge">Новый</span>' : ''}
      </div>`;
  }

  private renderModalBody(o: WbOrder): string {
    const currency = o.currency_code || 'RUB';
    const totalNum = o.total;
    const ICONS = {
      calendar: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6h12M5 1.5v3M11 1.5v3" stroke-linecap="round"/></svg>',
      box:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l6 3v7l-6 3-6-3v-7l6-3z"/></svg>',
      pin:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14s5-4.5 5-9a5 5 0 0 0-10 0c0 4.5 5 9 5 9z"/><circle cx="8" cy="5" r="2"/></svg>',
    };
    const infoCard = (icon: string, label: string, val: string | null | undefined) => {
      if (!val || val === '—') return '';
      return `<div class="ozo-info-card">
        <div class="ozo-info-card-ic">${icon}</div>
        <div style="min-width:0;flex:1">
          <div class="ozo-info-card-lbl">${label}</div>
          <div class="ozo-info-card-val">${val}</div>
        </div>
      </div>`;
    };
    const infoBlock = `
      <div class="ozo-info-grid">
        ${infoCard(ICONS.calendar, 'Создан', o.created_at ? fmtDateTime(o.created_at) : null)}
        ${infoCard(ICONS.box,      'Склад',  o.warehouse_name ? this.esc(o.warehouse_name) : null)}
        ${infoCard(ICONS.pin,      'Регион', o.delivery_address ? this.esc(o.delivery_address) : null)}
        ${o.is_zero_order ? infoCard(ICONS.box, 'Маркер', '<span class="oz-badge ord-s-cancelled">Нулевой заказ</span>') : ''}
      </div>`;
    const productsBlock = `
      <div class="ozo-section-head">
        <div class="ozo-section-title">Состав заказа</div>
        <div class="ozo-section-meta">${o.items.length} поз.</div>
      </div>
      <div class="ozo-products-list">
        ${o.items.map(it => {
          const lineTotal = it.price * it.count;
          const imgUrl = this.getProductImage(it.vendor_code);
          const name = it.name || this.getProductName(it.vendor_code) || 'Без названия';
          const thumb = imgUrl
            ? `<a href="${this.esc(imgUrl)}" target="_blank" rel="noopener" class="ozo-prod-thumb">
                <img src="${this.esc(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='${I.package('',14)}'">
              </a>`
            : `<div class="ozo-prod-thumb ozo-prod-thumb-empty">${I.package('',14)}</div>`;
          return `<div class="ozo-prod-card">
            ${thumb}
            <div class="ozo-prod-info">
              <div class="ozo-prod-name" title="${this.esc(name)}">${this.esc(name)}</div>
              <div class="ozo-prod-sku">
                <span class="oz-sku-chip" onclick="window.wbOrdersModule.copyText('${this.esc(it.vendor_code)}', this)">
                  <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
                  <span class="oz-sku-chip-text">${this.esc(it.vendor_code)}</span>
                </span>
                ${it.nm_id ? `<div class="oz-muted" style="font-size:10px;margin-top:3px">nm: ${it.nm_id}</div>` : ''}
              </div>
            </div>
            <div class="ozo-prod-price">
              <div class="ozo-prod-unit">${it.price.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency} × ${it.count}</div>
              <div class="ozo-prod-line">${lineTotal.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="ozo-modal-total">
        <span class="ozo-modal-total-lbl">Итого по заказу</span>
        <span class="ozo-modal-total-val">${totalNum.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency}</span>
      </div>`;

    const canCancel = o.status !== 'cancel' && o.status !== 'complete';
    const actionsBlock = `
      <div class="ozo-actions-block">
        <div class="ozo-actions-title">Действия с заказом</div>
        <div class="ozo-actions-row">
          ${o.status === 'new' ? `<button class="btn btn-primary" onclick="window.wbOrdersModule.confirmOrder(${o.id})">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M3 8l3 3 7-7"/></svg>
            Принять в работу
          </button>` : ''}
          <button class="btn" onclick="window.wbOrdersModule.downloadSticker(${o.id})">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M3 2h10v12H3zM5 6h6M5 9h6M5 12h4"/></svg>
            Стикер PDF
          </button>
          ${canCancel ? `<button class="btn btn-danger" onclick="window.wbOrdersModule.cancelOrder(${o.id})" style="margin-left:auto">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M2 2l10 10M12 2L2 12"/></svg>
            Отменить
          </button>` : ''}
        </div>
        <div class="ozo-actions-hint">WB-стикер — этикетка нового формата для маркировки FBS-отправлений (58×40 мм).</div>
      </div>`;

    return `<div class="ozo-modal-content">${infoBlock}${productsBlock}${actionsBlock}</div>`;
  }

  private findStoreFor(orderId: number): WbStore | null {
    const o = this.orders.find(x => x.id === orderId);
    if (!o) return null;
    return this.stores.find(s => s.id === o.store_id) ?? null;
  }

  async confirmOrder(orderId: number): Promise<void> {
    if (!confirm(`Принять заказ ${orderId} в работу?`)) return;
    const store = this.findStoreFor(orderId);
    if (!store) return;
    try {
      await wbApi.confirmOrder(store.api_key, orderId);
      alert('✓ Заказ принят');
      this.refresh();
    } catch (err: any) {
      alert(`Ошибка: ${err?.message ?? err}`);
    }
  }

  async cancelOrder(orderId: number): Promise<void> {
    if (!confirm(`Отменить заказ ${orderId}?`)) return;
    const store = this.findStoreFor(orderId);
    if (!store) return;
    try {
      await wbApi.cancelOrder(store.api_key, orderId);
      alert('✓ Заказ отменён');
      this.refresh();
    } catch (err: any) {
      alert(`Ошибка: ${err?.message ?? err}`);
    }
  }

  async downloadSticker(orderId: number): Promise<void> {
    const store = this.findStoreFor(orderId);
    if (!store) return;
    try {
      const blob = await wbApi.getOrderStickers(store.api_key, [orderId], 'pdf');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `wb-sticker-${orderId}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err: any) {
      alert(`Не удалось получить стикер: ${err?.message ?? err}\n\nДля FBS-стикеров нужен токен с правами «Маркетплейс».`);
    }
  }

  private modalShell(title: string, subtitle: string, body: string): string {
    return `
      <div class="ozo-modal">
        <div class="ozo-modal-head">
          <div style="min-width:0;flex:1">
            <div class="ozo-modal-title ozo-modal-title-copy"
              title="Скопировать номер" onclick="window.wbOrdersModule.copyText('${this.esc(title)}', this)">
              ${this.esc(title)}
              <svg class="ozo-modal-title-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
            </div>
            ${subtitle ? `<div class="ozo-modal-sub">${subtitle}</div>` : ''}
          </div>
          <button id="wbo-modal-close" class="ozo-modal-close" title="Закрыть (Esc)">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M2 2l10 10M12 2L2 12"/></svg>
          </button>
        </div>
        <div class="ozo-modal-body">${body}</div>
      </div>`;
  }

  private bindModalClose(modal: HTMLElement): void {
    modal.onclick = (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('#wbo-modal-close')) {
        modal.style.display = 'none';
        document.removeEventListener('keydown', escHandler);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') {
        modal.style.display = 'none';
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  copyText(s: string, el?: HTMLElement): void {
    navigator.clipboard?.writeText(String(s)).catch((e) => debug.warn('[WbOrdersModule] swallowed error', e));
    if (el) {
      el.classList.add('oz-sku-chip-copied');
      setTimeout(() => el.classList.remove('oz-sku-chip-copied'), 1200);
    }
  }

  private esc(s: string | null | undefined): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
