/**
 * YandexOrdersModule — заказы Яндекс Маркета (только Я.М.).
 * Минимальная функциональность: загрузка, фильтр периода, таблица.
 */

import { debug } from '@/utils/debug';
import { YandexStore, YandexOrder, YandexOrderStatus, YandexProduct } from '@/types/yandex';
import { yandexDb } from '@/services/yandexDb';
import { fetchAllYandexOrders, yandexApi } from '@/services/yandexApi';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { showToast } from '@/utils/toast';

const STATUS_LABELS: Record<string, string> = {
  PROCESSING:           'В обработке',
  DELIVERY:             'Доставляется',
  PICKUP:               'В пункте выдачи',
  DELIVERED:            'Доставлен',
  CANCELLED:            'Отменён',
  PARTIALLY_DELIVERED:  'Частично доставлен',
  PARTIALLY_RETURNED:   'Частично возвращён',
  RESERVED:             'Зарезервирован',
  RETURNED:             'Возвращён',
  UNPAID:               'Не оплачен',
};

const STATUS_CSS: Record<string, string> = {
  PROCESSING:           'ord-s-new',
  DELIVERY:             'ord-s-delivering',
  PICKUP:               'ord-s-ready',
  DELIVERED:            'ord-s-delivered',
  CANCELLED:            'ord-s-cancelled',
  PARTIALLY_DELIVERED:  'ord-s-delivered',
  PARTIALLY_RETURNED:   'ord-s-cancelled',
  RESERVED:             'ord-s-new',
  RETURNED:             'ord-s-cancelled',
  UNPAID:               'ord-s-cancelled',
};

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    // Яндекс отдаёт "DD-MM-YYYY HH:MM:SS" в московском времени без timezone.
    // new Date() не парсит этот формат корректно → разбираем вручную как локальное время.
    const m = d.match(/^(\d{2})[.\-](\d{2})[.\-](\d{4})(?:[\sT](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const [, dd, mm, yyyy, h = '0', mi = '0'] = m;
      return new Date(+yyyy, +mm - 1, +dd, +h, +mi).toLocaleString('ru', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    }
    return new Date(d).toLocaleString('ru', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return d; }
}

function ymDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  // Яндекс Маркет принимает формат DD-MM-YYYY (по legacy API)
  return `${day}-${m}-${y}`;
}

export class YandexOrdersModule {
  private container: HTMLElement;
  private stores: YandexStore[] = [];
  private orders: YandexOrder[] = [];
  private products: YandexProduct[] = [];
  private detailsCache: Map<string, any> = new Map();
  private loading = false;
  private period = '7';
  private abortController: AbortController | null = null;
  private lastError = '';

  constructor(container: HTMLElement) {
    this.container = container;
  }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  async init(): Promise<void> {
    this.render();
    [this.stores, this.products] = await Promise.all([
      yandexDb.getStores(),
      yandexDb.getProducts().catch(() => [] as YandexProduct[]),
    ]);
    if (this.stores.length === 0) {
      this.renderEmpty();
      return;
    }
    this.render();
    this.loadOrders();
  }

  private getProductImage(offerId: string): string | null {
    const p = this.products.find(p => p.offer_id === offerId);
    return p?.pictures?.[0] ?? null;
  }
  private getProductName(offerId: string): string | null {
    const p = this.products.find(p => p.offer_id === offerId);
    return p?.name ?? null;
  }

  private getPeriodRange(): { from: string; to: string } {
    const now = new Date();
    let days = 7;
    if (this.period === '30') days = 30;
    else if (this.period === '90') days = 90;
    const from = new Date(now.getTime() - days * 86_400_000);
    const to = new Date(now.getTime() + 86_400_000); // +1 день: Яндекс API обрабатывает toDate как исключительную границу
    return { from: ymDateOnly(from), to: ymDateOnly(to) };
  }

  private async loadOrders(): Promise<void> {
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;

    this.loading = true;
    this.lastError = '';
    this.render();

    const { from, to } = this.getPeriodRange();
    debug.log(`[Yandex Orders] Период ${from} → ${to}, магазинов: ${this.stores.length}`);

    try {
      const all: YandexOrder[] = [];
      await Promise.all(this.stores.map(async store => {
        try {
          const orders = await fetchAllYandexOrders(store, from, to, signal);
          all.push(...orders);
          debug.log(`[Yandex Orders] ${store.name}: ${orders.length} заказов`);
        } catch (err: unknown) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            debug.warn(`[Yandex Orders] ${store.name}:`, (err instanceof Error ? err.message : String(err)));
          }
        }
      }));
      if (this.abortController !== ac) return;
      this.orders = all.sort((a, b) => (b.creation_date ?? '').localeCompare(a.creation_date ?? ''));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.lastError = (err instanceof Error ? err.message : String(err)) ?? String(err);
    }

    if (this.abortController !== ac) return;
    this.loading = false;
    this.render();
  }

  setPeriod(p: string): void {
    if (this.period === p) return;
    this.period = p;
    this.orders = [];
    this.render();
    this.loadOrders();
  }

  refresh(): void {
    this.orders = [];
    this.loadOrders();
  }

  private renderEmpty(): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" fill="#fc3f1d"/>
                <text x="12" y="17" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Arial">Я</text>
              </svg>
              <span class="oz-brand-name">Заказы — Яндекс Маркет</span>
            </div>
          </div>
        </div>
        <div class="oz-empty" style="margin-top:60px">
          <div class="oz-empty-title">Нет подключённых магазинов</div>
          <div class="oz-empty-sub">Добавь магазин в разделе <b>Маркетплейсы → Яндекс Маркет</b></div>
        </div>
      </div>
    `;
  }

  render(): void {
    if (!this.stores.length) { this.renderEmpty(); return; }

    const totalSum = this.orders.reduce((s, o) => s + o.total, 0);
    const cnt = (st: YandexOrderStatus) => this.orders.filter(o => o.status === st).length;
    const sumOf = (sts: YandexOrderStatus[]) =>
      this.orders.filter(o => sts.includes(o.status)).reduce((s, o) => s + o.total, 0);

    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" fill="#fc3f1d"/>
                <text x="12" y="17" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Arial">Я</text>
              </svg>
              <span class="oz-brand-name">Заказы — Яндекс Маркет</span>
            </div>
          </div>
          <div class="oz-topbar-right">
            <button class="btn btn-primary" onclick="window.yandexOrdersModule.refresh()" ${this.loading ? 'disabled' : ''}>
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
                  onclick="window.yandexOrdersModule.setPeriod('${p}')">${p} дней</button>
              `).join('')}
            </div>
          </div>
          <span class="oz-filter-count">${this.orders.length} заказов · ${Math.round(totalSum).toLocaleString('ru')} ₽</span>
        </div>

        ${this.orders.length > 0 ? `
          <div class="ord-stats-bar">
            ${[
              { label: 'Всего',      count: this.orders.length, sum: totalSum, cls: '' },
              { label: 'Обработка',  count: cnt('PROCESSING'),  sum: sumOf(['PROCESSING','RESERVED']), cls: 'ord-stat-new' },
              { label: 'Доставка',   count: cnt('DELIVERY') + cnt('PICKUP'), sum: sumOf(['DELIVERY','PICKUP']), cls: 'ord-stat-del' },
              { label: 'Доставлено', count: cnt('DELIVERED'),   sum: sumOf(['DELIVERED','PARTIALLY_DELIVERED']), cls: 'ord-stat-ok' },
              { label: 'Отменено',   count: cnt('CANCELLED'),   sum: sumOf(['CANCELLED','RETURNED','PARTIALLY_RETURNED']), cls: 'ord-stat-cancel' },
            ].map(s => `
              <div class="ord-stat ${s.cls}">
                <span class="ord-stat-val">${s.count.toLocaleString('ru')}</span>
                <span class="ord-stat-lbl">${s.label}</span>
                <span class="ord-stat-sum">${Math.round(s.sum).toLocaleString('ru')} ₽</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="oz-body" style="flex:1;overflow:auto;padding-bottom:90px">
          ${this.renderContent()}
        </div>
      </div>
    `;
  }

  private renderContent(): string {
    if (this.loading && !this.orders.length) {
      return `
        <div class="ord-loader">
          <div class="ord-loader-spinner">
            <svg class="oz-spin" viewBox="0 0 40 40" fill="none" stroke="#fc3f1d" stroke-width="3" stroke-linecap="round" style="width:48px;height:48px">
              <path d="M36 20A16 16 0 1 1 20 4" stroke-dasharray="60 30"/>
            </svg>
          </div>
          <div class="ord-loader-title">Загружаем заказы Я.Маркета</div>
          <div class="ord-loader-sub">Период: ${this.period} дней</div>
          <div class="ord-loader-bar"><div class="ord-loader-bar-fill"></div></div>
        </div>`;
    }
    if (this.lastError) {
      return `<div class="oz-empty"><div class="oz-empty-title" style="color:#ef4444">Ошибка: ${this.esc(this.lastError)}</div></div>`;
    }
    if (!this.orders.length) {
      return `<div class="oz-empty"><div class="oz-empty-title">Заказов нет</div></div>`;
    }

    const rows = this.orders.map(o => {
      const storeName = this.stores.find(s => s.id === o.store_id)?.name ?? '—';
      const first = o.items[0];
      const more = o.items.length - 1;
      // Стек миниатюр (до 3 товаров)
      const thumbsHtml = o.items.slice(0, 3).map((it, i) => {
        const img = this.getProductImage(it.offer_id);
        const offset = i * 16;
        const cell = img
          ? `<img src="${this.esc(img)}" loading="lazy" style="width:36px;height:36px;border-radius:6px;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display='none'">`
          : `<div style="width:36px;height:36px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px">${I.package('',16)}</div>`;
        return `<div style="position:absolute;left:${offset}px;top:0;z-index:${10 - i}">${cell}</div>`;
      }).join('');
      const thumbsCount = Math.min(o.items.length, 3);
      const thumbsCell = `<div style="position:relative;width:${36 + (thumbsCount - 1) * 16}px;height:36px">${thumbsHtml}</div>`;
      return `
        <tr class="oz-row" onclick="window.yandexOrdersModule.openOrderModal(${o.id})">
          <td onclick="event.stopPropagation()" style="padding:8px 10px"><span class="oz-sku-chip" onclick="window.yandexOrdersModule.copyText('${o.id}', this)">
            <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
            <span class="oz-sku-chip-text">${o.id}</span></span>
            <div class="oz-muted" style="font-size:11px;margin-top:3px;display:flex;align-items:center;gap:4px">${this.esc(storeName)}${copyButton(storeName, 'Копировать название магазина')}</div>
          </td>
          <td><span class="oz-badge ${STATUS_CSS[o.status] ?? 'ord-s-cancelled'}">${STATUS_LABELS[o.status] ?? o.status}</span></td>
          <td class="oz-muted">${fmtDateTime(o.creation_date)}</td>
          <td style="padding:6px 8px">${thumbsCell}</td>
          <td>${first ? `<div class="ord-product-line"><span class="oz-sku-chip" onclick="event.stopPropagation();window.yandexOrdersModule.copyText('${this.esc(first.offer_id)}', this)">${this.esc(first.offer_id)}</span> <span class="ord-qty">× ${first.count}</span></div>${more > 0 ? `<span class="ord-more">+${more} ещё</span>` : ''}` : '—'}</td>
          <td class="oz-prc" style="text-align:right;white-space:nowrap;font-weight:700">${Math.round(o.total).toLocaleString('ru')} ₽</td>
          <td class="oz-muted">${this.esc(o.delivery_region ?? '—')}</td>
        </tr>`;
    }).join('');

    return `
      <div class="oz-table-wrap">
        <table class="oz-table">
          <thead><tr>
            <th>Заказ</th>
            <th>Статус</th>
            <th>Создан</th>
            <th style="width:60px"></th>
            <th>Состав</th>
            <th style="text-align:right">Сумма</th>
            <th>Регион</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // ── Модалка предпросмотра заказа ────────────────────────────────

  async openOrderModal(orderId: number): Promise<void> {
    let modal = document.getElementById('ymo-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ymo-modal';
      modal.className = 'ozo-modal-backdrop';
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    modal.innerHTML = this.modalShell(String(orderId), '', this.renderModalLoader());
    this.bindModalClose(modal);

    // 1) Базовая инфа из уже загруженного списка
    const localOrder = this.orders.find(o => o.id === orderId);
    if (localOrder) this.fillModal(modal, localOrder, null);

    // 2) Полные детали через API
    const store = this.stores.find(s => s.id === localOrder?.store_id) ?? this.stores[0];
    if (!store) {
      this.fillModalError(modal, 'Магазин не найден');
      return;
    }
    const cacheKey = `${store.id}:${orderId}`;
    const cached = this.detailsCache.get(cacheKey);
    if (cached) { this.fillModal(modal, localOrder ?? null, cached); return; }

    try {
      const detail = await yandexApi.getOrderDetail(store, orderId);
      this.detailsCache.set(cacheKey, detail);
      if (modal.style.display !== 'none') this.fillModal(modal, localOrder ?? null, detail);
    } catch (err: unknown) {
      // Если детали не получили — оставляем то, что было
      if (!localOrder) this.fillModalError(modal, (err instanceof Error ? err.message : String(err)) ?? String(err));
      debug.warn('[YM] order detail failed:', err);
    }
  }

  private renderModalLoader(): string {
    return `
      <div class="ord-loader">
        <div class="ord-loader-title">Загружаем детали заказа</div>
        <div class="ord-loader-bar"><div class="ord-loader-bar-fill"></div></div>
      </div>`;
  }

  private modalShell(title: string, subtitle: string, body: string): string {
    const titleClickable = title !== 'Ошибка' && title.length > 0;
    return `
      <div class="ozo-modal">
        <div class="ozo-modal-head">
          <div style="min-width:0;flex:1">
            <div class="ozo-modal-title ${titleClickable ? 'ozo-modal-title-copy' : ''}"
              ${titleClickable ? `title="Скопировать номер" onclick="window.yandexOrdersModule.copyText('${this.esc(title)}', this)"` : ''}>
              ${this.esc(title)}
              ${titleClickable ? `<svg class="ozo-modal-title-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>` : ''}
            </div>
            ${subtitle ? `<div class="ozo-modal-sub">${subtitle}</div>` : ''}
          </div>
          <button id="ymo-modal-close" class="ozo-modal-close" title="Закрыть (Esc)">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M2 2l10 10M12 2L2 12"/></svg>
          </button>
        </div>
        <div class="ozo-modal-body">${body}</div>
      </div>`;
  }

  private bindModalClose(modal: HTMLElement): void {
    modal.onclick = (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('#ymo-modal-close')) {
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

  private fillModalError(modal: HTMLElement, msg: string): void {
    const body = `<div class="ozo-modal-error">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="width:20px;height:20px;flex-shrink:0">
        <circle cx="10" cy="10" r="8.5"/>
        <path d="M10 6v4M10 13.5v.5" stroke-linecap="round"/>
      </svg>
      ${this.esc(msg)}
    </div>`;
    modal.innerHTML = this.modalShell('Ошибка', '', body);
    this.bindModalClose(modal);
  }

  private fillModal(modal: HTMLElement, base: YandexOrder | null, detail: any): void {
    // Если есть detail — берём детали из API; иначе из base
    const d = detail ?? {};
    const id = String(d.id ?? base?.id ?? '');
    const status = (d.status ?? base?.status) as YandexOrderStatus;
    const substatus = d.substatus ?? base?.substatus ?? '';
    const creation_date = d.creationDate ?? base?.creation_date ?? '';
    const delivery = d.delivery ?? {};
    const buyer = d.buyer ?? {};
    const items = (d.items ?? []).length > 0 ? d.items : (base?.items ?? []).map(it => ({
      offerId: it.offer_id, offerName: it.name, count: it.count, price: it.price, currency: it.currency_code,
    }));
    const storeName = this.stores.find(s => s.id === base?.store_id)?.name ?? '—';
    const totalNum = items.reduce((s: number, it: any) => s + (Number(it.price) || 0) * (Number(it.count) || 0), 0);
    const currency = items[0]?.currency ?? base?.currency_code ?? 'RUB';
    const isNew = status === 'PROCESSING';

    const subtitle = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        <span class="oz-badge ${STATUS_CSS[status] ?? 'ord-s-cancelled'}">${STATUS_LABELS[status] ?? status}</span>
        ${substatus ? `<span class="ozo-pill">${this.esc(substatus)}</span>` : ''}
        <span class="ozo-pill" style="display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fc3f1d"></span>
          ${this.esc(storeName)}
          ${copyButton(storeName, 'Копировать название магазина')}
        </span>
        ${isNew ? '<span class="ord-new-badge">Новый</span>' : ''}
      </div>`;

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

    const ICONS = {
      calendar: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6h12M5 1.5v3M11 1.5v3" stroke-linecap="round"/></svg>',
      truck:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 4h8v7h-8zM9.5 7h3.5l1.5 2v2h-5zM4 13a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM12 13a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      box:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l6 3v7l-6 3-6-3v-7l6-3zM2 4.5l6 3 6-3M8 7.5v8" stroke-linejoin="round"/></svg>',
      pin:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14s5-4.5 5-9a5 5 0 0 0-10 0c0 4.5 5 9 5 9z"/><circle cx="8" cy="5" r="2"/></svg>',
      hash:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 6h10M3 10h10M6 2l-2 12M12 2l-2 12"/></svg>',
      clock:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l2.5 1.5" stroke-linecap="round"/></svg>',
      user:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3 3-5 6-5s6 2 6 5"/></svg>',
    };

    // Адрес
    const addressParts = [
      delivery.address?.country,
      delivery.address?.postcode,
      delivery.address?.city ?? delivery.region?.name,
      delivery.address?.street,
      delivery.address?.house ? `д. ${delivery.address.house}` : null,
      delivery.address?.block ? `корп. ${delivery.address.block}` : null,
      delivery.address?.apartment ? `кв. ${delivery.address.apartment}` : null,
    ].filter(Boolean);
    const fullAddress = addressParts.length > 0 ? this.esc(addressParts.join(', ')) : (base?.delivery_region ? this.esc(base.delivery_region) : null);

    // Дата доставки / отгрузки
    const deliveryDate = delivery.dates?.fromDate ?? delivery.deliveryDate ?? base?.delivery_date;
    const shipmentDate = delivery.shipments?.[0]?.shipmentDate;
    const deliveryType = delivery.type ?? base?.delivery_type;

    const infoBlock = `
      <div class="ozo-info-grid">
        ${infoCard(ICONS.calendar, 'Создан',           creation_date ? fmtDateTime(creation_date) : null)}
        ${infoCard(ICONS.truck,    'Отгрузка',         shipmentDate ? fmtDateTime(shipmentDate) : null)}
        ${infoCard(ICONS.truck,    'Доставка',         deliveryDate ? fmtDateTime(deliveryDate) : null)}
        ${infoCard(ICONS.box,      'Способ',           deliveryType ? this.esc(deliveryType) : null)}
        ${infoCard(ICONS.hash,     'Трек',             delivery.tracks?.[0]?.trackCode ? this.esc(delivery.tracks[0].trackCode) : null)}
        ${infoCard(ICONS.user,     'Получатель',       buyer.firstName || buyer.lastName ? this.esc(`${buyer.lastName ?? ''} ${buyer.firstName ?? ''}`.trim()) : null)}
        ${infoCard(ICONS.pin,      'Регион',           delivery.region?.name ? this.esc(delivery.region.name) : null)}
        ${infoCard(ICONS.pin,      'Адрес доставки',   fullAddress)}
        ${infoCard(ICONS.box,      'Доход маркетплейс',d.fake !== undefined ? (d.fake ? 'Тестовый' : 'Реальный') : null)}
      </div>`;

    const productsBlock = `
      <div class="ozo-section-head">
        <div class="ozo-section-title">Состав заказа</div>
        <div class="ozo-section-meta">${items.length} позиц${items.length === 1 ? 'ия' : items.length < 5 ? 'ии' : 'ий'} · ${items.reduce((s: number, it: any) => s + (Number(it.count) || 0), 0)} шт.</div>
      </div>
      <div class="ozo-products-list">
        ${items.map((it: any) => {
          const offerId = it.offerId ?? it.shopSku ?? '';
          const name = it.offerName ?? it.name ?? this.getProductName(offerId) ?? 'Без названия';
          const price = Number(it.price) || 0;
          const count = Number(it.count) || 0;
          const lineTotal = price * count;
          const imgUrl = this.getProductImage(offerId);
          const thumb = imgUrl
            ? `<a href="${this.esc(imgUrl)}" target="_blank" rel="noopener" class="ozo-prod-thumb">
                <img src="${this.esc(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='${I.package('',16)}'">
              </a>`
            : `<div class="ozo-prod-thumb ozo-prod-thumb-empty">${I.package('',16)}</div>`;
          return `<div class="ozo-prod-card">
            ${thumb}
            <div class="ozo-prod-info">
              <div style="display:flex;align-items:flex-start;gap:4px">
                <div class="ozo-prod-name" style="min-width:0" title="${this.esc(name)}">${this.esc(name)}</div>
                ${copyButton(name, 'Копировать название')}
              </div>
              <div class="ozo-prod-sku">
                <span class="oz-sku-chip" onclick="window.yandexOrdersModule.copyText('${this.esc(offerId)}', this)">
                  <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
                  <span class="oz-sku-chip-text">${this.esc(offerId)}</span>
                </span>
              </div>
            </div>
            <div class="ozo-prod-price">
              <div class="ozo-prod-unit">${price.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency} × ${count}</div>
              <div class="ozo-prod-line">${lineTotal.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="ozo-modal-total">
        <span class="ozo-modal-total-lbl">Итого по заказу</span>
        <span class="ozo-modal-total-val">${totalNum.toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}</span>
      </div>`;

    // Действия для активных заказов
    const canShip = status === 'PROCESSING';
    const canLabel = status === 'PROCESSING' || status === 'DELIVERY';
    const canCancel = status !== 'CANCELLED' && status !== 'DELIVERED';
    const actionsBlock = `
      <div class="ozo-actions-block">
        <div class="ozo-actions-title">Действия с заказом</div>
        <div class="ozo-actions-row">
          ${canShip ? `<button class="btn btn-primary" onclick="window.yandexOrdersModule.shipOrder('${id}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M1 5h10v6H1zM11 7h3l1 1v3h-4zM4 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM13 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>
            Готов к отгрузке
          </button>` : ''}
          ${canLabel ? `<button class="btn" onclick="window.yandexOrdersModule.downloadLabel('${id}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M3 2h10v12H3zM5 6h6M5 9h6M5 12h4"/></svg>
            Этикетка PDF
          </button>` : ''}
          ${canCancel ? `<button class="btn btn-danger" onclick="window.yandexOrdersModule.cancelOrder('${id}')" style="margin-left:auto">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M2 2l10 10M12 2L2 12"/></svg>
            Отменить заказ
          </button>` : ''}
        </div>
      </div>`;

    const body = `<div class="ozo-modal-content">${infoBlock}${productsBlock}${actionsBlock}</div>`;
    modal.innerHTML = this.modalShell(id, subtitle, body);
    this.bindModalClose(modal);
  }

  private findStoreFor(orderId: number | string): YandexStore | null {
    const o = this.orders.find(x => String(x.id) === String(orderId));
    if (!o) return null;
    return this.stores.find(s => s.id === o.store_id) ?? null;
  }

  async shipOrder(orderId: string): Promise<void> {
    if (!confirm(`Перевести заказ ${orderId} в статус "Готов к отгрузке"?`)) return;
    const store = this.findStoreFor(orderId);
    if (!store) return;
    try {
      // YM workflow: PROCESSING/STARTED → PROCESSING/READY_TO_SHIP → курьер/ПВЗ забирает → DELIVERY/* (авто)
      // Прямой переход в DELIVERY вручную не разрешён.
      await yandexApi.setOrderStatus(store, orderId, 'PROCESSING', 'READY_TO_SHIP');
      showToast('✓ Заказ помечен готовым к отгрузке', 'success');
      this.refresh();
    } catch (err: unknown) {
      showToast(`Ошибка: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async downloadLabel(orderId: string): Promise<void> {
    const store = this.findStoreFor(orderId);
    if (!store) return;
    try {
      const blob = await yandexApi.getOrderLabelPdf(store, orderId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `ym-label-${orderId}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err: unknown) {
      showToast(`Не удалось получить этикетку: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!confirm(`Отменить заказ ${orderId}?`)) return;
    const store = this.findStoreFor(orderId);
    if (!store) return;
    try {
      await yandexApi.setOrderStatus(store, orderId, 'CANCELLED', 'SHOP_FAILED');
      showToast('✓ Заказ отменён', 'success');
      this.refresh();
    } catch (err: unknown) {
      showToast(`Ошибка отмены: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  copyText(s: string, el?: HTMLElement): void {
    navigator.clipboard?.writeText(String(s)).catch((e) => debug.warn('[YandexOrdersModule] swallowed error', e));
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
