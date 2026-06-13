/**
 * AllOrdersModule v2 — единый список заказов со всех маркетплейсов.
 *
 * Поддержка схем:
 *   Ozon:   FBO (фулфилмент Ozon), FBS (отгрузка продавцом), RFBS/DBS (доставка продавцом)
 *   Yandex: FBY (фулфилмент ЯМ), FBS (отгрузка продавцом), DBS
 *   WB:     FBS (все заказы — продавец собирает, WB доставляет)
 *
 * Действия (только для FBS/DBS — где продавец управляет отправкой):
 *   Ozon FBS/RFBS: Отгрузить, Этикетка PDF, Отменить
 *   Yandex FBS:    Готов к отгрузке, Этикетка PDF, Отменить
 *   WB FBS:        Подтвердить, Стикер PDF, Отменить
 */

import { debug } from '@/utils/debug';
import { OzonPosting, OzonStore, DeliveryScheme } from '@/types/ozon';
import { YandexOrder, YandexStore } from '@/types/yandex';
import { WbOrder, WbStore } from '@/types/wb';
import { ozonDb } from '@/services/ozonDb';
import { ozonOrdersApi, fetchAllPagesByCursor, fetchAllPages } from '@/services/ozonOrdersApi';
import { yandexDb } from '@/services/yandexDb';
import { yandexApi, fetchAllYandexOrders } from '@/services/yandexApi';
import { wbDb } from '@/services/wbDb';
import { wbApi, fetchAllWbOrders, isWbCoolingDown } from '@/services/wbApi';
import { helpBtn } from '@/services/helpModal';

type Marketplace = 'ozon' | 'yandex' | 'wb';
type Scheme = 'FBO' | 'FBS' | 'DBS' | 'FBY' | 'WB' | '';

interface UnifiedOrder {
  marketplace: Marketplace;
  id: string;
  status: string;
  statusLabel: string;
  statusCss: string;
  scheme: Scheme;
  created_at: string;
  storeName: string;
  storeId: string;
  storeColor: string;
  total: number;
  currency: string;
  itemsCount: number;
  firstOfferId: string;
  firstName: string;
  /** Can seller perform actions (ship/label/cancel)? */
  canAct: boolean;
  raw: OzonPosting | YandexOrder | WbOrder;
}

// ── Status labels & CSS ────────────────────────────────────────────────────

const OZON_STATUS_LABELS: Record<string, string> = {
  awaiting_packaging: 'Ожидает сборки',
  awaiting_deliver:   'Готов к отгрузке',
  delivering:         'Доставляется',
  delivered:          'Доставлен',
  cancelled:          'Отменён',
  arbitration:        'Арбитраж',
  sent_by_seller:     'У перевозчика',
  not_accepted:       'Не принят',
};

const OZON_STATUS_CSS: Record<string, string> = {
  awaiting_packaging: 'ord-s-new',
  awaiting_deliver:   'ord-s-ready',
  delivering:         'ord-s-delivering',
  sent_by_seller:     'ord-s-delivering',
  delivered:          'ord-s-delivered',
  cancelled:          'ord-s-cancelled',
  not_accepted:       'ord-s-cancelled',
  arbitration:        'ord-s-arbitration',
};

const YM_STATUS_LABELS: Record<string, string> = {
  PROCESSING:           'В обработке',
  DELIVERY:             'Доставляется',
  PICKUP:               'В пункте выдачи',
  DELIVERED:            'Доставлен',
  CANCELLED:            'Отменён',
  PARTIALLY_DELIVERED:  'Частично доставлен',
  PARTIALLY_RETURNED:   'Частично возвращён',
  RETURNED:             'Возвращён',
  UNPAID:               'Не оплачен',
  RESERVED:             'Зарезервирован',
};

const YM_STATUS_CSS: Record<string, string> = {
  PROCESSING:           'ord-s-new',
  DELIVERY:             'ord-s-delivering',
  PICKUP:               'ord-s-ready',
  DELIVERED:            'ord-s-delivered',
  CANCELLED:            'ord-s-cancelled',
  RESERVED:             'ord-s-new',
  RETURNED:             'ord-s-cancelled',
  PARTIALLY_DELIVERED:  'ord-s-delivered',
  PARTIALLY_RETURNED:   'ord-s-cancelled',
  UNPAID:               'ord-s-cancelled',
};

const WB_STATUS_LABELS: Record<string, string> = {
  new:         'Новый',
  confirm:     'На сборке',
  complete:    'В доставке',
  cancel:      'Отменён',
  arbitration: 'Арбитраж',
  unknown:     'Неизвестно',
};
const WB_STATUS_CSS: Record<string, string> = {
  new:         'ord-s-new',
  confirm:     'ord-s-ready',
  complete:    'ord-s-delivering',
  cancel:      'ord-s-cancelled',
  arbitration: 'ord-s-arbitration',
  unknown:     'ord-s-cancelled',
};

// Scheme badge colors
const SCHEME_CSS: Record<Scheme, string> = {
  FBO: 'background:rgba(96,165,250,0.15);color:#60a5fa',
  FBS: 'background:rgba(74,222,128,0.15);color:#4ade80',
  DBS: 'background:rgba(251,146,60,0.15);color:#fb923c',
  FBY: 'background:rgba(96,165,250,0.15);color:#60a5fa',
  WB:  'background:rgba(203,17,171,0.15);color:#cb11ab',
  '':  '',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function parseDateTs(d: string | null | undefined): number {
  if (!d) return 0;
  const iso = Date.parse(d);
  if (!isNaN(iso)) return iso;
  const m = d.match(/^(\d{2})-(\d{2})-(\d{4})(?:[\sT](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, dd, mm, yyyy, h='0', mi='0', s='0'] = m;
    return Date.UTC(+yyyy, +mm - 1, +dd, +h, +mi, +s);
  }
  return 0;
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  const ts = parseDateTs(d);
  if (!ts) return String(d);
  return new Date(ts).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function calcOzonTotal(p: OzonPosting): number {
  return p.products.reduce((s, pr) => {
    const price = parseFloat(pr.price);
    return isFinite(price) ? s + price * pr.quantity : s;
  }, 0);
}

function ymDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${day}-${m}-${y}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function detectYandexScheme(store: YandexStore): Scheme {
  const pt = ((store as any).placement_type ?? '').toUpperCase();
  if (pt === 'FBY') return 'FBY';
  if (pt === 'DBS') return 'DBS';
  return 'FBS'; // Default — most common for Yandex
}

function ozonSchemeToLabel(s: DeliveryScheme): Scheme {
  if (s === 'fbo') return 'FBO';
  if (s === 'rfbs') return 'DBS';
  return 'FBS';
}

// ── Module ────────────────────────────────────────────────────────────────

export class AllOrdersModule {
  private container: HTMLElement;
  private ozonStores: OzonStore[] = [];
  private yandexStores: YandexStore[] = [];
  private wbStores: WbStore[] = [];
  private orders: UnifiedOrder[] = [];
  private loading = false;
  private period = '7';
  private filterMps: Set<Marketplace> = new Set();
  private filterScheme: Scheme | '' = '';
  private filterStatus = '';
  private search = '';
  private abortController: AbortController | null = null;
  private actionLoading = false; // prevent double-clicks on action buttons

  private ozonColors = ['#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
  private ymColors   = ['#fc3f1d', '#fb923c', '#ef4444', '#dc2626'];
  private wbColors   = ['#cb11ab', '#9333ea', '#a855f7', '#c026d3'];

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
    try {
      [this.ozonStores, this.yandexStores, this.wbStores] = await Promise.all([
        ozonDb.getStores(),
        yandexDb.getStores(),
        wbDb.getStores(),
      ]);
      this._ensureProductCache().catch((e) => debug.warn('[AllOrdersModule] swallowed error', e));
    } catch (err) {
      console.error('[AllOrders] init err:', err);
    }
    if (!this.ozonStores.length && !this.yandexStores.length && !this.wbStores.length) {
      this.renderEmpty();
      return;
    }
    this.render();
    this.loadAll();
  }

  private getPeriod(): { since: string; to: string; ymFrom: string; ymTo: string; wbFrom: string } {
    const now = new Date();
    let days = 7;
    if (this.period === '30') days = 30;
    else if (this.period === '90') days = 90;
    const from = new Date(now.getTime() - days * 86_400_000);
    return {
      since: from.toISOString(),
      to:    now.toISOString(),
      ymFrom: ymDateOnly(from),
      ymTo:   ymDateOnly(now),
      wbFrom: from.toISOString().slice(0, 19),
    };
  }

  private async loadAll(): Promise<void> {
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;
    const { since, to, ymFrom, ymTo, wbFrom } = this.getPeriod();

    this.loading = true;
    this.render();

    const unified: UnifiedOrder[] = [];

    // ── Ozon: FBS + FBO ─────────────────────────────────────────
    const ozonPromises = this.ozonStores.map(async (store, idx) => {
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const color = this.ozonColors[idx % this.ozonColors.length];
      const seen = new Set<string>();

      // FBS/RFBS/DBS orders (cursor-based v4)
      try {
        const fbsPostings = await fetchAllPagesByCursor(
          (lim, cursor, sig) => ozonOrdersApi.getFbsPostings(creds, since, to, null, lim, cursor, sig),
          50, signal,
        );
        for (const p of fbsPostings) {
          if (seen.has(p.posting_number)) continue;
          seen.add(p.posting_number);
          p.store_id = store.id;
          const scheme = ozonSchemeToLabel(p.delivery_scheme);
          const canAct = scheme !== 'FBO' && ['awaiting_packaging', 'awaiting_deliver'].includes(p.status);
          unified.push(this.toUnified(p, 'ozon', store.name, store.id, color, scheme, canAct));
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.error(`[AllOrders] Ozon FBS ${store.name}:`, err.message);
      }

      // FBO orders (offset-based v3)
      try {
        const fboPostings = await fetchAllPages(
          (lim, offset, sig) => ozonOrdersApi.getFboPostings(creds, since, to, lim, offset as number, sig),
          50, signal,
        );
        for (const p of fboPostings) {
          if (seen.has(p.posting_number)) continue;
          seen.add(p.posting_number);
          p.store_id = store.id;
          unified.push(this.toUnified(p, 'ozon', store.name, store.id, color, 'FBO', false));
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.error(`[AllOrders] Ozon FBO ${store.name}:`, err.message);
      }
    });

    // ── Yandex ──────────────────────────────────────────────────
    const yandexPromises = this.yandexStores.map(async (store, idx) => {
      const color = this.ymColors[idx % this.ymColors.length];
      const scheme = detectYandexScheme(store);
      try {
        const orders = await fetchAllYandexOrders(store, ymFrom, ymTo, signal);
        for (const o of orders) {
          const canAct = scheme !== 'FBY' && ['PROCESSING', 'DELIVERY'].includes(o.status);
          const first = o.items[0];
          unified.push({
            marketplace: 'yandex',
            id: String(o.id),
            status: o.status,
            statusLabel: YM_STATUS_LABELS[o.status] ?? o.status,
            statusCss: YM_STATUS_CSS[o.status] ?? 'ord-s-cancelled',
            scheme,
            created_at: o.creation_date,
            storeName: store.name,
            storeId: store.id,
            storeColor: color,
            total: o.total,
            currency: o.currency_code === 'RUR' ? 'RUB' : o.currency_code,
            itemsCount: o.items.reduce((s, i) => s + i.count, 0),
            firstOfferId: first?.offer_id ?? '',
            firstName: first?.name ?? '',
            canAct,
            raw: o,
          });
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.error(`[AllOrders] Yandex ${store.name}:`, err.message);
      }
    });

    // ── WB ──────────────────────────────────────────────────────
    const wbPromises = this.wbStores.map(async (store, idx) => {
      const color = this.wbColors[idx % this.wbColors.length];
      if (isWbCoolingDown()) return; // WB rate-limited — пропускаем, Ozon/YM грузятся независимо
      try {
        const orders = await fetchAllWbOrders(store, wbFrom, signal);
        for (const o of orders) {
          const first = o.items[0];
          const canAct = ['new', 'confirm'].includes(o.status);
          unified.push({
            marketplace: 'wb',
            id: String(o.id),
            status: o.status,
            statusLabel: WB_STATUS_LABELS[o.status] ?? o.status,
            statusCss: WB_STATUS_CSS[o.status] ?? 'ord-s-cancelled',
            scheme: 'FBS',
            created_at: o.created_at,
            storeName: store.name,
            storeId: store.id,
            storeColor: color,
            total: o.total,
            currency: o.currency_code,
            itemsCount: o.items.reduce((s, i) => s + i.count, 0),
            firstOfferId: first?.vendor_code ?? '',
            firstName: first?.name ?? '',
            canAct,
            raw: o,
          });
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.error(`[AllOrders] WB ${store.name}:`, err.message);
      }
    });

    await Promise.all([...ozonPromises, ...yandexPromises, ...wbPromises]);

    if (this.abortController !== ac) return;

    this.orders = unified.sort((a, b) => parseDateTs(b.created_at) - parseDateTs(a.created_at));
    this.loading = false;
    this.render();
  }

  private toUnified(p: OzonPosting, mp: Marketplace, storeName: string, storeId: string, color: string, scheme: Scheme, canAct: boolean): UnifiedOrder {
    const total = calcOzonTotal(p);
    const first = p.products[0];
    return {
      marketplace: mp,
      id: p.posting_number,
      status: p.status,
      statusLabel: OZON_STATUS_LABELS[p.status] ?? p.status,
      statusCss: OZON_STATUS_CSS[p.status] ?? 'ord-s-cancelled',
      scheme,
      created_at: p.created_at,
      storeName,
      storeId,
      storeColor: color,
      total,
      currency: first?.currency_code ?? 'RUB',
      itemsCount: p.products.reduce((s, pr) => s + pr.quantity, 0),
      firstOfferId: first?.offer_id ?? '',
      firstName: first?.name ?? '',
      canAct,
      raw: p,
    };
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  setPeriod(p: string): void {
    if (this.period === p) return;
    this.period = p;
    this.orders = [];
    this.render();
    this.loadAll();
  }

  setMarketplace(mp: string): void {
    if (!mp) { this.filterMps.clear(); }
    else {
      const m = mp as Marketplace;
      if (this.filterMps.has(m)) this.filterMps.delete(m);
      else this.filterMps.add(m);
    }
    this.render();
  }

  setSchemeFilter(s: string): void {
    this.filterScheme = (this.filterScheme === s ? '' : s) as Scheme;
    this.render();
  }

  setStatusFilter(s: string): void {
    this.filterStatus = s;
    this.render();
  }

  setSearch(q: string): void {
    this.search = q;
    this.render();
  }

  refresh(): void {
    this.orders = [];
    this.loadAll();
  }

  copyText(s: string, el?: HTMLElement): void {
    navigator.clipboard?.writeText(String(s)).catch((e) => debug.warn('[AllOrdersModule] swallowed error', e));
    if (el) {
      el.classList.add('oz-sku-chip-copied');
      setTimeout(() => el.classList.remove('oz-sku-chip-copied'), 1200);
    }
  }

  private getFiltered(): UnifiedOrder[] {
    let list = this.orders;
    if (this.filterMps.size > 0) list = list.filter(o => this.filterMps.has(o.marketplace));
    if (this.filterScheme) list = list.filter(o => o.scheme === this.filterScheme);
    if (this.filterStatus)      list = list.filter(o => o.status === this.filterStatus);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(o =>
        o.id.toLowerCase().includes(q) ||
        o.firstOfferId.toLowerCase().includes(q) ||
        o.firstName.toLowerCase().includes(q),
      );
    }
    return list;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  /** Ozon FBS: Ship posting (auto-pack all products in one package) */
  async ozonShip(postingNumber: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    const store = this.ozonStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    const creds = { client_id: store.client_id, api_key: store.api_key };
    this.actionLoading = true;
    this.updateActionBar('Отгрузка…');
    try {
      // Need product_id for each product — fetch detail first
      const detail = await ozonOrdersApi.getFbsPostingDetail(creds, postingNumber);
      const products = detail.products.map(pr => ({
        product_id: (pr as any).product_id || 0,
        quantity: pr.quantity,
      }));
      await ozonOrdersApi.shipFbsPosting(creds, postingNumber, [{ products }]);
      alert('Заказ отгружен!');
      this.refresh();
    } catch (e: any) {
      alert('Ошибка отгрузки: ' + (e.message || e));
    }
    this.actionLoading = false;
  }

  /** Ozon FBS: Download label PDF */
  async ozonLabel(postingNumber: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    const store = this.ozonStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    const creds = { client_id: store.client_id, api_key: store.api_key };
    this.actionLoading = true;
    this.updateActionBar('Загрузка этикетки…');
    try {
      const blob = await ozonOrdersApi.getFbsPackageLabelPdf(creds, [postingNumber]);
      downloadBlob(blob, `ozon-label-${postingNumber}.pdf`);
    } catch (e: any) {
      alert('Ошибка загрузки этикетки: ' + (e.message || e));
    }
    this.actionLoading = false;
    this.updateActionBar('');
  }

  /** Ozon FBS: Cancel posting */
  async ozonCancel(postingNumber: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    if (!confirm('Отменить заказ ' + postingNumber + '?')) return;
    const store = this.ozonStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    const creds = { client_id: store.client_id, api_key: store.api_key };
    this.actionLoading = true;
    this.updateActionBar('Отмена…');
    try {
      // 352 = "Товар закончился" — generic reason
      await ozonOrdersApi.cancelFbsPosting(creds, postingNumber, 352, 'Отменено через SimaDesk');
      alert('Заказ отменён');
      this.refresh();
    } catch (e: any) {
      alert('Ошибка отмены: ' + (e.message || e));
    }
    this.actionLoading = false;
  }

  /** Yandex: Mark as ready to ship */
  async yandexShip(orderId: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    const store = this.yandexStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    this.actionLoading = true;
    this.updateActionBar('Отправка…');
    try {
      await yandexApi.setOrderStatus(store, orderId, 'PROCESSING', 'READY_TO_SHIP');
      alert('Заказ готов к отгрузке!');
      this.refresh();
    } catch (e: any) {
      alert('Ошибка: ' + (e.message || e));
    }
    this.actionLoading = false;
  }

  /** Yandex: Download label PDF */
  async yandexLabel(orderId: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    const store = this.yandexStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    this.actionLoading = true;
    this.updateActionBar('Загрузка этикетки…');
    try {
      const blob = await yandexApi.getOrderLabelPdf(store, orderId);
      downloadBlob(blob, `ym-label-${orderId}.pdf`);
    } catch (e: any) {
      alert('Ошибка загрузки этикетки: ' + (e.message || e));
    }
    this.actionLoading = false;
    this.updateActionBar('');
  }

  /** Yandex: Cancel order */
  async yandexCancel(orderId: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    if (!confirm('Отменить заказ ' + orderId + '?')) return;
    const store = this.yandexStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    this.actionLoading = true;
    this.updateActionBar('Отмена…');
    try {
      await yandexApi.setOrderStatus(store, orderId, 'CANCELLED', 'SHOP_FAILED');
      alert('Заказ отменён');
      this.refresh();
    } catch (e: any) {
      alert('Ошибка отмены: ' + (e.message || e));
    }
    this.actionLoading = false;
  }

  /** WB: Confirm order (ready to ship) */
  async wbConfirm(orderId: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    const store = this.wbStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    this.actionLoading = true;
    this.updateActionBar('Подтверждение…');
    try {
      await wbApi.confirmOrder(store.api_key, parseInt(orderId));
      alert('Заказ подтверждён!');
      this.refresh();
    } catch (e: any) {
      alert('Ошибка: ' + (e.message || e));
    }
    this.actionLoading = false;
  }

  /** WB: Download sticker PDF */
  async wbSticker(orderId: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    const store = this.wbStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    this.actionLoading = true;
    this.updateActionBar('Загрузка стикера…');
    try {
      const blob = await wbApi.getOrderStickers(store.api_key, [parseInt(orderId)], 'pdf');
      downloadBlob(blob, `wb-sticker-${orderId}.pdf`);
    } catch (e: any) {
      alert('Ошибка загрузки стикера: ' + (e.message || e));
    }
    this.actionLoading = false;
    this.updateActionBar('');
  }

  /** WB: Cancel order */
  async wbCancel(orderId: string, storeId: string): Promise<void> {
    if (this.actionLoading) return;
    if (!confirm('Отменить заказ ' + orderId + '?')) return;
    const store = this.wbStores.find(s => s.id === storeId);
    if (!store) return alert('Магазин не найден');
    this.actionLoading = true;
    this.updateActionBar('Отмена…');
    try {
      await wbApi.cancelOrder(store.api_key, parseInt(orderId));
      alert('Заказ отменён');
      this.refresh();
    } catch (e: any) {
      alert('Ошибка отмены: ' + (e.message || e));
    }
    this.actionLoading = false;
  }

  private updateActionBar(text: string): void {
    const el = document.getElementById('aoo-action-status');
    if (el) el.textContent = text;
  }

  // ── Modal ────────────────────────────────────────────────────────────────

  openDetail(marketplace: string, id: string): void {
    const o = this.orders.find(x => x.marketplace === marketplace && x.id === id);
    if (!o) return;
    let modal = document.getElementById('aoo-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'aoo-modal';
      modal.className = 'ozo-modal-backdrop';
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    modal.innerHTML = this.buildOrderModalHtml(o);
    this.bindModalClose(modal);
  }

  private bindModalClose(modal: HTMLElement): void {
    modal.onclick = (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('#aoo-modal-close')) {
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

  private buildOrderModalHtml(o: UnifiedOrder): string {
    const isOzon = o.marketplace === 'ozon';
    const isYM   = o.marketplace === 'yandex';
    const isWB   = o.marketplace === 'wb';
    const raw = o.raw as any;

    let products: Array<{ offer_id: string; name: string; quantity: number; price: number; image?: string | null }> = [];
    let warehouseName = '';
    let regionName = '';
    let address = '';
    let trackingNumber = '';
    let inProcessAt = '';
    let shipmentDate = '';
    let deliveringDate = '';
    let substatus = '';

    if (isOzon) {
      const op = raw as OzonPosting;
      products = (op.products ?? []).map(pr => ({
        offer_id: pr.offer_id, name: pr.name, quantity: pr.quantity,
        price: parseFloat(pr.price) || 0, image: undefined,
      }));
      warehouseName = op.warehouse_id?.toString() ?? '';
      regionName = op.region ?? '';
      address = op.customer_address ?? '';
      trackingNumber = op.tracking_number ?? '';
      inProcessAt = op.in_process_at ?? '';
      shipmentDate = op.shipment_date ?? '';
      deliveringDate = op.delivering_date ?? '';
    } else if (isYM) {
      const ym = raw as YandexOrder;
      products = (ym.items ?? []).map(it => ({
        offer_id: it.offer_id, name: it.name, quantity: it.count, price: it.price,
      }));
      regionName = ym.delivery_region ?? '';
      substatus = ym.substatus ?? '';
      deliveringDate = ym.delivery_date ?? '';
    } else if (isWB) {
      const wb = raw as WbOrder;
      products = (wb.items ?? []).map(it => ({
        offer_id: it.vendor_code, name: it.name, quantity: it.count, price: it.price,
      }));
      warehouseName = wb.warehouse_name ?? '';
      regionName = wb.delivery_address ?? '';
    }

    const totalItems = products.reduce((s, p) => s + p.quantity, 0);

    // ── Subtitle badges ──
    const schemeBadge = o.scheme ? `<span class="ozo-pill" style="${SCHEME_CSS[o.scheme] || ''};font-weight:700;font-size:11px">${o.scheme}</span>` : '';
    const mpLabel = isOzon ? 'Ozon' : isYM ? 'Я.Маркет' : 'WB';
    const mpBadgeClass = isOzon ? 'mp-badge-ozon' : isYM ? 'mp-badge-yandex' : 'mp-badge-wb';

    const subtitle = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        <span class="oz-badge ${o.statusCss}">${o.statusLabel}</span>
        ${substatus ? `<span class="ozo-pill">${this.esc(substatus)}</span>` : ''}
        ${schemeBadge}
        <span class="mp-badge ${mpBadgeClass}">${mpLabel}</span>
        <span class="ozo-pill" style="display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${o.storeColor}"></span>
          ${this.esc(o.storeName)}
        </span>
      </div>`;

    // ── Info cards ──
    const ICONS = {
      calendar: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6h12M5 1.5v3M11 1.5v3" stroke-linecap="round"/></svg>',
      truck:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 4h8v7h-8zM9.5 7h3.5l1.5 2v2h-5zM4 13a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM12 13a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      box:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l6 3v7l-6 3-6-3v-7l6-3z"/></svg>',
      pin:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14s5-4.5 5-9a5 5 0 0 0-10 0c0 4.5 5 9 5 9z"/><circle cx="8" cy="5" r="2"/></svg>',
      hash:     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 6h10M3 10h10M6 2l-2 12M12 2l-2 12"/></svg>',
      clock:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l2.5 1.5" stroke-linecap="round"/></svg>',
    };
    const infoCard = (icon: string, label: string, val: string | null | undefined) => {
      if (!val || val === '—') return '';
      return `<div class="ozo-info-card"><div class="ozo-info-card-ic">${icon}</div><div style="min-width:0;flex:1"><div class="ozo-info-card-lbl">${label}</div><div class="ozo-info-card-val">${val}</div></div></div>`;
    };

    const infoBlock = `<div class="ozo-info-grid">
      ${infoCard(ICONS.calendar, 'Создан', o.created_at ? fmtDateTime(o.created_at) : null)}
      ${infoCard(ICONS.clock, 'В обработке', inProcessAt ? fmtDateTime(inProcessAt) : null)}
      ${infoCard(ICONS.truck, 'Отгрузка', shipmentDate ? fmtDateTime(shipmentDate) : null)}
      ${infoCard(ICONS.truck, 'Доставка', deliveringDate ? fmtDateTime(deliveringDate) : null)}
      ${infoCard(ICONS.hash, 'Трекинг', trackingNumber ? this.esc(trackingNumber) : null)}
      ${infoCard(ICONS.box, 'Склад', warehouseName ? this.esc(warehouseName) : null)}
      ${infoCard(ICONS.pin, 'Регион', regionName ? this.esc(regionName) : null)}
      ${infoCard(ICONS.pin, 'Адрес', address ? this.esc(address) : null)}
    </div>`;

    // ── Products ──
    const productsBlock = `
      <div class="ozo-section-head">
        <div class="ozo-section-title">Состав заказа</div>
        <div class="ozo-section-meta">${products.length} поз. · ${totalItems} шт.</div>
      </div>
      <div class="ozo-products-list">
        ${products.map(p => {
          const lineTotal = p.price * p.quantity;
          const imgUrl = this.getProductImageFor(o.marketplace, p.offer_id);
          const name = p.name || this.getProductNameFor(o.marketplace, p.offer_id) || 'Без названия';
          const thumb = imgUrl
            ? `<a href="${this.esc(imgUrl)}" target="_blank" rel="noopener" class="ozo-prod-thumb"><img src="${this.esc(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='📦'"></a>`
            : `<div class="ozo-prod-thumb ozo-prod-thumb-empty">📦</div>`;
          return `<div class="ozo-prod-card">
            ${thumb}
            <div class="ozo-prod-info">
              <div class="ozo-prod-name" title="${this.esc(name)}">${this.esc(name)}</div>
              <div class="ozo-prod-sku">
                <span class="oz-sku-chip" onclick="window.allOrdersModule.copyText('${this.esc(p.offer_id)}', this)">
                  <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
                  <span class="oz-sku-chip-text">${this.esc(p.offer_id)}</span>
                </span>
              </div>
            </div>
            <div class="ozo-prod-price">
              <div class="ozo-prod-unit">${p.price.toLocaleString('ru', { minimumFractionDigits: 2 })} ${o.currency} × ${p.quantity}</div>
              <div class="ozo-prod-line">${lineTotal.toLocaleString('ru', { minimumFractionDigits: 2 })} ${o.currency}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="ozo-modal-total">
        <span class="ozo-modal-total-lbl">Итого по заказу</span>
        <span class="ozo-modal-total-val">${o.total.toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${o.currency}</span>
      </div>`;

    // ── Action buttons ──
    const actionsBlock = this.buildActionsHtml(o);

    return `
      <div class="ozo-modal">
        <div class="ozo-modal-head">
          <div style="min-width:0;flex:1">
            <div class="ozo-modal-title ozo-modal-title-copy"
              title="Скопировать номер" onclick="window.allOrdersModule.copyText('${this.esc(o.id)}', this)">
              ${this.esc(o.id)}
              <svg class="ozo-modal-title-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
            </div>
            ${subtitle}
          </div>
          <button id="aoo-modal-close" class="ozo-modal-close" title="Закрыть (Esc)">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M2 2l10 10M12 2L2 12"/></svg>
          </button>
        </div>
        <div class="ozo-modal-body"><div class="ozo-modal-content">${infoBlock}${productsBlock}${actionsBlock}</div></div>
      </div>`;
  }

  private buildActionsHtml(o: UnifiedOrder): string {
    if (o.scheme === 'FBO' || o.scheme === 'FBY') {
      return `<div style="padding:16px 0;text-align:center;color:rgba(255,255,255,0.3);font-size:13px">
        ${o.scheme === 'FBO' ? 'Ozon' : 'Яндекс'} управляет фулфилментом — действия недоступны
      </div>`;
    }

    const sid = this.esc(o.storeId);
    const oid = this.esc(o.id);
    let buttons = '';

    if (o.marketplace === 'ozon') {
      const canShip = ['awaiting_packaging', 'awaiting_deliver'].includes(o.status);
      const canLabel = !['cancelled', 'delivered'].includes(o.status);
      const canCancel = ['awaiting_packaging', 'awaiting_deliver'].includes(o.status);
      buttons = `
        ${canShip ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();window.allOrdersModule.ozonShip('${oid}','${sid}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M1.5 4h8v7h-8zM9.5 7h3.5l1.5 2v2h-5z" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Отгрузить</button>` : ''}
        ${canLabel ? `<button class="btn btn-sm" style="background:rgba(255,255,255,0.08)" onclick="event.stopPropagation();window.allOrdersModule.ozonLabel('${oid}','${sid}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M4 2h8v12H4z"/><path d="M6 5h4M6 8h4M6 11h2" stroke-linecap="round"/></svg>
          Этикетка</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm" style="background:rgba(239,68,68,0.12);color:#ef4444" onclick="event.stopPropagation();window.allOrdersModule.ozonCancel('${oid}','${sid}')">Отменить</button>` : ''}`;
    } else if (o.marketplace === 'yandex') {
      const canShip = o.status === 'PROCESSING';
      const canLabel = ['PROCESSING', 'DELIVERY'].includes(o.status);
      const canCancel = !['CANCELLED', 'DELIVERED', 'RETURNED'].includes(o.status);
      buttons = `
        ${canShip ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();window.allOrdersModule.yandexShip('${oid}','${sid}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M2 8h10M8 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Готов к отгрузке</button>` : ''}
        ${canLabel ? `<button class="btn btn-sm" style="background:rgba(255,255,255,0.08)" onclick="event.stopPropagation();window.allOrdersModule.yandexLabel('${oid}','${sid}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M4 2h8v12H4z"/><path d="M6 5h4M6 8h4M6 11h2" stroke-linecap="round"/></svg>
          Этикетка</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm" style="background:rgba(239,68,68,0.12);color:#ef4444" onclick="event.stopPropagation();window.allOrdersModule.yandexCancel('${oid}','${sid}')">Отменить</button>` : ''}`;
    } else if (o.marketplace === 'wb') {
      const canConfirm = o.status === 'new';
      const canSticker = ['new', 'confirm'].includes(o.status);
      const canCancel = ['new', 'confirm'].includes(o.status);
      buttons = `
        ${canConfirm ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();window.allOrdersModule.wbConfirm('${oid}','${sid}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Подтвердить</button>` : ''}
        ${canSticker ? `<button class="btn btn-sm" style="background:rgba(255,255,255,0.08)" onclick="event.stopPropagation();window.allOrdersModule.wbSticker('${oid}','${sid}')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><path d="M4 2h8v12H4z"/><path d="M6 5h4M6 8h4M6 11h2" stroke-linecap="round"/></svg>
          Стикер</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm" style="background:rgba(239,68,68,0.12);color:#ef4444" onclick="event.stopPropagation();window.allOrdersModule.wbCancel('${oid}','${sid}')">Отменить</button>` : ''}`;
    }

    if (!buttons.trim()) return '';

    return `
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px">Действия</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${buttons}
          <span id="aoo-action-status" style="font-size:12px;color:rgba(255,255,255,0.3)"></span>
        </div>
      </div>`;
  }

  // ── Product image/name cache ─────────────────────────────────────────────

  private _productImageCache: Map<string, string> | null = null;
  private _productNameCache: Map<string, string> | null = null;

  private async _ensureProductCache(): Promise<void> {
    if (this._productImageCache && this._productNameCache) return;
    this._productImageCache = new Map();
    this._productNameCache = new Map();
    try {
      const ozPr = await ozonDb.getProducts();
      for (const p of ozPr) {
        if (p.images?.[0]) this._productImageCache.set(`ozon|${p.offer_id}`, p.images[0]);
        if (p.name) this._productNameCache.set(`ozon|${p.offer_id}`, p.name);
      }
    } catch (e) { debug.warn('[AllOrdersModule] swallowed error', e); }
    try {
      const ymPr = await yandexDb.getProducts();
      for (const p of ymPr) {
        if (p.pictures?.[0]) this._productImageCache.set(`yandex|${p.offer_id}`, p.pictures[0]);
        if (p.name) this._productNameCache.set(`yandex|${p.offer_id}`, p.name);
      }
    } catch (e) { debug.warn('[AllOrdersModule] swallowed error', e); }
    try {
      const wbPr = await wbDb.getProducts();
      for (const p of wbPr) {
        if (p.pictures?.[0]) this._productImageCache.set(`wb|${p.vendor_code}`, p.pictures[0]);
        if (p.title) this._productNameCache.set(`wb|${p.vendor_code}`, p.title);
      }
    } catch (e) { debug.warn('[AllOrdersModule] swallowed error', e); }
  }

  private getProductImageFor(mp: string, offerId: string): string | null {
    if (!this._productImageCache) { this._ensureProductCache(); return null; }
    return this._productImageCache.get(`${mp}|${offerId}`) ?? null;
  }
  private getProductNameFor(mp: string, offerId: string): string | null {
    if (!this._productNameCache) return null;
    return this._productNameCache.get(`${mp}|${offerId}`) ?? null;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  private renderEmpty(): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 20 20" fill="none"><rect x="1" y="1" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h10M5 10h7M5 13h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="oz-brand-name">Все заказы</span>
            </div>
          </div>
        </div>
        <div class="oz-empty" style="margin-top:60px">
          <div class="oz-empty-title">Нет подключённых маркетплейсов</div>
          <div class="oz-empty-sub">Подключи Ozon или Яндекс Маркет в разделе <b>Маркетплейсы</b></div>
        </div>
      </div>`;
  }

  render(): void {
    if (!this.ozonStores.length && !this.yandexStores.length && !this.wbStores.length) { this.renderEmpty(); return; }

    const filtered = this.getFiltered();
    const totalSum = filtered.reduce((s, o) => s + o.total, 0);

    const cntByMp = (mp: Marketplace) => this.orders.filter(o => o.marketplace === mp).length;
    const cntByScheme = (s: Scheme) => this.orders.filter(o => o.scheme === s).length;
    const ozonCount = cntByMp('ozon');
    const ymCount = cntByMp('yandex');
    const wbCount = cntByMp('wb');

    // Scheme counts
    const schemes: Scheme[] = ['FBO', 'FBS', 'DBS', 'FBY'];
    const schemeCounts = schemes.map(s => ({ scheme: s, count: cntByScheme(s) })).filter(s => s.count > 0);

    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 20 20" fill="none"><rect x="1" y="1" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h10M5 10h7M5 13h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <span class="oz-brand-name">Все заказы</span>
            </div>
          </div>
          <div class="oz-topbar-right">
            ${helpBtn('orders')}
            <button class="btn btn-primary" onclick="window.allOrdersModule.refresh()" ${this.loading ? 'disabled' : ''}>
              ${this.loading ? 'Загрузка…' : 'Обновить'}
            </button>
          </div>
        </div>

        <!-- МП-фильтры -->
        <div class="ord-scheme-bar">
          <button class="oz-tab ${this.filterMps.size === 0 ? 'active' : ''}"
            onclick="window.allOrdersModule.setMarketplace('')">
            Все<span class="oz-tab-cnt">${this.orders.length}</span>
          </button>
          <button class="oz-tab ${this.filterMps.has('ozon') ? 'active' : ''}"
            onclick="window.allOrdersModule.setMarketplace('ozon')">
            ${this.filterMps.has('ozon') ? '✓ ' : ''}<span class="oz-dot" style="background:#005bff"></span>Ozon<span class="oz-tab-cnt">${ozonCount}</span>
          </button>
          <button class="oz-tab ${this.filterMps.has('yandex') ? 'active' : ''}"
            onclick="window.allOrdersModule.setMarketplace('yandex')">
            ${this.filterMps.has('yandex') ? '✓ ' : ''}<span class="oz-dot" style="background:#fc3f1d"></span>Яндекс<span class="oz-tab-cnt">${ymCount}</span>
          </button>
          <button class="oz-tab ${this.filterMps.has('wb') ? 'active' : ''}"
            onclick="window.allOrdersModule.setMarketplace('wb')">
            ${this.filterMps.has('wb') ? '✓ ' : ''}<span class="oz-dot" style="background:#cb11ab"></span>WB<span class="oz-tab-cnt">${wbCount}</span>
          </button>
        </div>

        <!-- Фильтры -->
        <div class="oz-filter-bar">
          <div class="oz-filter-group">
            <span class="oz-filter-label">Период</span>
            <div class="oz-filter-pills">
              ${['7','30','90'].map(p => `
                <button class="oz-fpill ${this.period === p ? 'active' : ''}"
                  onclick="window.allOrdersModule.setPeriod('${p}')">${p} дн</button>
              `).join('')}
            </div>
          </div>

          ${schemeCounts.length > 1 ? `
          <div class="oz-filter-sep"></div>
          <div class="oz-filter-group">
            <span class="oz-filter-label">Схема</span>
            <div class="oz-filter-pills">
              ${schemeCounts.map(s => `
                <button class="oz-fpill ${this.filterScheme === s.scheme ? 'active' : ''}"
                  style="${this.filterScheme === s.scheme ? SCHEME_CSS[s.scheme] : ''}"
                  onclick="window.allOrdersModule.setSchemeFilter('${s.scheme}')">${s.scheme}<span class="oz-tab-cnt">${s.count}</span></button>
              `).join('')}
            </div>
          </div>` : ''}

          <div class="oz-filter-sep"></div>
          <div class="search-wrap" style="width:220px">
            <span class="search-ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3" stroke-linecap="round"/></svg></span>
            <input class="search-input" placeholder="Номер, артикул…" value="${this.esc(this.search)}"
              oninput="window.allOrdersModule.setSearch(this.value)">
          </div>
          <span class="oz-filter-count">${filtered.length.toLocaleString('ru')} заказов · ${Math.round(totalSum).toLocaleString('ru')} ₽</span>
        </div>

        <!-- Контент -->
        <div class="oz-body" style="flex:1;overflow:auto;padding-bottom:90px">
          ${this.renderContent(filtered)}
        </div>
      </div>`;
  }

  private renderContent(rows: UnifiedOrder[]): string {
    if (this.loading && !this.orders.length) {
      return `
        <div class="ord-loader">
          <div class="ord-loader-spinner">
            <svg class="oz-spin" viewBox="0 0 40 40" fill="none" stroke="#005bff" stroke-width="3" stroke-linecap="round" style="width:48px;height:48px">
              <path d="M36 20A16 16 0 1 1 20 4" stroke-dasharray="60 30"/>
            </svg>
          </div>
          <div class="ord-loader-title">Загружаем заказы со всех маркетплейсов</div>
          <div class="ord-loader-sub">FBO + FBS + DBS · ${this.period} дней</div>
          <div class="ord-loader-bar"><div class="ord-loader-bar-fill"></div></div>
        </div>`;
    }
    if (!rows.length) {
      return `<div class="oz-empty"><div class="oz-empty-title">Заказов нет</div></div>`;
    }

    const tbody = rows.map(o => {
      const mpBadge = o.marketplace === 'ozon'
        ? `<span class="mp-badge mp-badge-ozon">Ozon</span>`
        : o.marketplace === 'yandex'
        ? `<span class="mp-badge mp-badge-yandex">ЯМ</span>`
        : `<span class="mp-badge mp-badge-wb">WB</span>`;
      const schemeBadge = o.scheme
        ? `<span style="display:inline-block;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;${SCHEME_CSS[o.scheme] || ''}">${o.scheme}</span>`
        : '';
      // Action indicator for FBS orders that need attention
      const needsAction = o.canAct && (o.status === 'awaiting_packaging' || o.status === 'PROCESSING' || o.status === 'new');
      const actionDot = needsAction ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-left:4px" title="Требуется действие"></span>' : '';

      return `
        <tr class="oz-row" style="cursor:pointer" onclick="window.allOrdersModule.openDetail('${o.marketplace}','${this.esc(o.id)}')">
          <td>
            <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
              ${mpBadge}${schemeBadge}
            </div>
          </td>
          <td>
            <span class="oz-sku-chip" onclick="event.stopPropagation();window.allOrdersModule.copyText('${this.esc(o.id)}', this)">
              <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
              <span class="oz-sku-chip-text">${this.esc(o.id)}</span>
            </span>
            <div class="oz-muted" style="font-size:11px;margin-top:3px;display:flex;align-items:center;gap:5px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${o.storeColor}"></span>
              ${this.esc(o.storeName)}
            </div>
          </td>
          <td><span class="oz-badge ${o.statusCss}">${o.statusLabel}</span>${actionDot}</td>
          <td class="oz-muted">${fmtDateTime(o.created_at)}</td>
          <td>
            ${o.firstOfferId
              ? `<div class="ord-product-line">
                  <span class="oz-sku-chip" onclick="event.stopPropagation();window.allOrdersModule.copyText('${this.esc(o.firstOfferId)}', this)">
                    <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1"/><path d="M2 10V2a1 1 0 0 1 1-1h7"/></svg>
                    <span class="oz-sku-chip-text">${this.esc(o.firstOfferId)}</span>
                  </span>
                </div>${o.firstName ? `<div class="oz-muted" style="font-size:11px;margin-top:2px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(o.firstName)}</div>` : ''}`
              : '—'}
          </td>
          <td style="text-align:center">${o.itemsCount}</td>
          <td class="oz-prc" style="text-align:right;white-space:nowrap;font-weight:700">${Math.round(o.total).toLocaleString('ru')} ${o.currency === 'RUB' ? '₽' : o.currency}</td>
        </tr>`;
    }).join('');

    return `
      <div class="oz-table-wrap">
        <table class="oz-table">
          <thead><tr>
            <th style="width:70px">МП</th>
            <th>Заказ</th>
            <th>Статус</th>
            <th>Дата</th>
            <th>Товар</th>
            <th style="text-align:center">Шт.</th>
            <th style="text-align:right">Сумма</th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  }

  private esc(s: string | null | undefined): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
