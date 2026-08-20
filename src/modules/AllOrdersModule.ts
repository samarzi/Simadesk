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
import { wbApi, fetchAllWbOrders, isWbCoolingDown, wbCooldownRemaining } from '@/services/wbApi';
import { orderSyncService } from '@/services/orderSyncService';
import { helpBtn } from '@/services/helpModal';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';

type Marketplace = 'ozon' | 'yandex' | 'wb';
type Scheme = 'FBO' | 'FBS' | 'DBS' | 'FBY' | 'FBW' | 'WB' | '';
type StatusCategory = '' | 'new' | 'delivering' | 'delivered' | 'cancelled' | 'returned';

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
  awaiting_packaging:           'Ожидает сборки',
  awaiting_deliver:             'Готов к отгрузке',
  delivering:                   'Доставляется',
  delivered:                    'Доставлен',
  cancelled:                    'Отменён',
  cancelled_from_split_pending: 'Отменён (разделение)',
  arbitration:                  'Арбитраж',
  sent_by_seller:               'У перевозчика',
  driver_pickup:                'У водителя',
  not_accepted:                 'Не принят',
  awaiting_registration:        'Ожидает регистрации',
  acceptance_in_progress:       'Приёмка',
  returned:                     'Возврат',
};

const OZON_STATUS_CSS: Record<string, string> = {
  awaiting_packaging:           'ord-s-new',
  awaiting_deliver:             'ord-s-ready',
  delivering:                   'ord-s-delivering',
  sent_by_seller:               'ord-s-delivering',
  driver_pickup:                'ord-s-delivering',
  delivered:                    'ord-s-delivered',
  cancelled:                    'ord-s-cancelled',
  cancelled_from_split_pending: 'ord-s-cancelled',
  not_accepted:                 'ord-s-cancelled',
  awaiting_registration:        'ord-s-new',
  acceptance_in_progress:       'ord-s-ready',
  arbitration:                  'ord-s-arbitration',
  returned:                     'ord-s-returned',
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
  RETURNED:             'ord-s-returned',
  PARTIALLY_DELIVERED:  'ord-s-delivered',
  PARTIALLY_RETURNED:   'ord-s-returned',
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
  FBW: 'background:rgba(203,17,171,0.15);color:#cb11ab',
  WB:  'background:rgba(203,17,171,0.15);color:#cb11ab',
  '':  '',
};

// Status category mapping: raw status → category
function statusCategory(mp: Marketplace, status: string): StatusCategory {
  if (mp === 'ozon') {
    if (['awaiting_packaging', 'awaiting_deliver', 'arbitration', 'awaiting_registration', 'acceptance_in_progress'].includes(status)) return 'new';
    if (['delivering', 'sent_by_seller', 'driver_pickup'].includes(status)) return 'delivering';
    if (status === 'delivered') return 'delivered';
    if (['cancelled', 'not_accepted', 'cancelled_from_split_pending'].includes(status)) return 'cancelled';
    if (status === 'returned') return 'returned';
    return '';
  }
  if (mp === 'yandex') {
    if (['PROCESSING', 'RESERVED', 'UNPAID'].includes(status)) return 'new';
    if (['DELIVERY', 'PICKUP'].includes(status)) return 'delivering';
    if (['DELIVERED', 'PARTIALLY_DELIVERED'].includes(status)) return 'delivered';
    if (status === 'CANCELLED') return 'cancelled';
    if (['RETURNED', 'PARTIALLY_RETURNED'].includes(status)) return 'returned';
    return '';
  }
  // wb
  if (['new', 'confirm', 'arbitration'].includes(status)) return 'new';
  if (status === 'complete') return 'delivering';
  if (status === 'cancel') return 'cancelled';
  return '';
}

const STATUS_CAT_LABELS: Record<StatusCategory, string> = {
  '':          'Все статусы',
  'new':       'Новые',
  'delivering':'В доставке',
  'delivered': 'Доставлено',
  'cancelled': 'Отменено',
  'returned':  'Возврат',
};
const STATUS_CAT_COLORS: Record<StatusCategory, string> = {
  '':          '',
  'new':       '#fbbf24',
  'delivering':'#60a5fa',
  'delivered': '#22c55e',
  'cancelled': '#94a3b8',
  'returned':  '#f87171',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function parseDateTs(d: string | null | undefined): number {
  if (!d) return 0;
  // DD-MM-YYYY или DD.MM.YYYY — Яндекс возвращает московское время без timezone.
  // Используем локальный конструктор Date (не Date.UTC), иначе +3ч смещение.
  const ddmm = d.match(/^(\d{2})[.\-](\d{2})[.\-](\d{4})(?:[\sT](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (ddmm) {
    const [, dd, mm, yyyy, h='0', mi='0', s='0'] = ddmm;
    return new Date(+yyyy, +mm - 1, +dd, +h, +mi, +s).getTime();
  }
  // ISO 8601 и прочие форматы (WB, Ozon — с таймзоной, парсятся корректно)
  const iso = Date.parse(d);
  if (!isNaN(iso)) return iso;
  return 0;
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  const ts = parseDateTs(d);
  if (!ts) return String(d);
  return new Date(ts).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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

/** Сегодняшняя дата в YYYY-MM-DD по ЛОКАЛЬНОМУ времени.
 *  toISOString() отдаёт UTC — вечером по МСК это уже вчерашний день,
 *  из-за чего фильтр «Сегодня» переставал подсвечиваться и блокировался `max`. */
function todayLocal(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
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
  private filterStatus: StatusCategory = '';
  private search = '';
  private dateFrom: string | null = null;
  private dateTo: string | null = null;
  private abortController: AbortController | null = null;
  private actionLoading = false; // prevent double-clicks on action buttons
  private wbWarning = ''; // WB rate-limit / error message

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
      debug.warn('[AllOrders] init err:', err);
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
      wbFrom: from.toISOString().slice(0, 19) + '+00:00',
    };
  }

  private async loadAll(): Promise<void> {
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;

    this.loading = true;
    this.orders = [];
    this.render();

    const { since, to } = this.getPeriod();
    const startTs = new Date(since).getTime();
    const endTs   = new Date(to).getTime();
    const days    = (endTs - startTs) / 86_400_000;

    // 7 дней — прямой API (нужны активные заказы в реальном времени).
    // 30/90 дней — через кэш (прошлые месяцы из Supabase + текущий из API).
    if (days <= 8) {
      await this._loadFromApi(ac, signal);
    } else {
      await this._loadFromCache(ac, signal, new Date(since), new Date(to));
    }
  }

  /** Прямая загрузка из API (7-дневный период, операционный режим). */
  private async _loadFromApi(ac: AbortController, signal: AbortSignal): Promise<void> {
    const { since, to, ymFrom, ymTo, wbFrom } = this.getPeriod();

    let remaining = this.ozonStores.length + this.yandexStores.length + this.wbStores.length;
    if (remaining === 0) { this.loading = false; this.render(); return; }

    const addBatch = (batch: UnifiedOrder[]) => {
      if (this.abortController !== ac || !batch.length) return;
      this.orders = [...this.orders, ...batch].sort(
        (a, b) => parseDateTs(b.created_at) - parseDateTs(a.created_at),
      );
    };
    const storeComplete = () => {
      if (this.abortController !== ac) return;
      remaining--;
      if (remaining <= 0) this.loading = false;
      this.render();
    };

    // ── Ozon: FBS + FBO ─────────────────────────────────────────
    const ozonPromises = this.ozonStores.map(async (store, idx) => {
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const color = this.ozonColors[idx % this.ozonColors.length];
      const seen = new Set<string>();
      const batch: UnifiedOrder[] = [];

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
          batch.push(this.toUnified(p, 'ozon', store.name, store.id, color, scheme, canAct));
        }
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) debug.warn(`[AllOrders] Ozon FBS ${store.name}:`, (err instanceof Error ? err.message : String(err)));
      }

      try {
        const fboPostings = await fetchAllPages(
          (lim, offset, sig) => ozonOrdersApi.getFboPostings(creds, since, to, lim, offset as number, sig),
          50, signal,
        );
        for (const p of fboPostings) {
          if (seen.has(p.posting_number)) continue;
          seen.add(p.posting_number);
          p.store_id = store.id;
          batch.push(this.toUnified(p, 'ozon', store.name, store.id, color, 'FBO', false));
        }
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) debug.warn(`[AllOrders] Ozon FBO ${store.name}:`, (err instanceof Error ? err.message : String(err)));
      }

      addBatch(batch);
      storeComplete();
    });

    // ── Yandex ──────────────────────────────────────────────────
    const yandexPromises = this.yandexStores.map(async (store, idx) => {
      const color = this.ymColors[idx % this.ymColors.length];
      const scheme = detectYandexScheme(store);
      const batch: UnifiedOrder[] = [];
      try {
        const orders = await fetchAllYandexOrders(store, ymFrom, ymTo, signal);
        for (const o of orders) {
          const canAct = scheme !== 'FBY' && ['PROCESSING', 'DELIVERY'].includes(o.status);
          const first = o.items[0];
          batch.push({
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
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) debug.warn(`[AllOrders] Yandex ${store.name}:`, (err instanceof Error ? err.message : String(err)));
      }
      addBatch(batch);
      storeComplete();
    });

    // ── WB ──────────────────────────────────────────────────────
    const wbPromises = this.wbStores.map(async (store, idx) => {
      const color = this.wbColors[idx % this.wbColors.length];
      if (isWbCoolingDown()) {
        const sec = wbCooldownRemaining();
        this.wbWarning = `WB rate-limit — подождите ещё ${sec} сек`;
        storeComplete(); return;
      }
      const batch: UnifiedOrder[] = [];
      try {
        const orders = await fetchAllWbOrders(store, wbFrom, signal);
        this.wbWarning = '';
        for (const o of orders) {
          const first = o.items[0];
          const canAct = ['new', 'confirm'].includes(o.status);
          batch.push({
            marketplace: 'wb',
            id: String(o.id),
            status: o.status,
            statusLabel: WB_STATUS_LABELS[o.status] ?? o.status,
            statusCss: WB_STATUS_CSS[o.status] ?? 'ord-s-cancelled',
            scheme: 'FBW',
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
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          this.wbWarning = `WB: ${(err instanceof Error ? err.message : String(err)) ?? 'ошибка загрузки'}`;
          debug.warn(`[AllOrders] WB ${store.name}:`, (err instanceof Error ? err.message : String(err)));
        }
      }
      addBatch(batch);
      storeComplete();
    });

    await Promise.all([...ozonPromises, ...yandexPromises, ...wbPromises]);
  }

  /** Загрузка через кэш (30/90-дневные периоды — кэш + текущий месяц из API). */
  private async _loadFromCache(
    ac: AbortController,
    signal: AbortSignal,
    start: Date,
    end: Date,
  ): Promise<void> {
    try {
      const { ozonPostings, yandexOrders, wbOrders } = await orderSyncService.queryOrders(
        null, start, end, signal,
      );

      if (this.abortController !== ac) return;

      const startTs = start.getTime();
      const endTs   = end.getTime();

      const batch: UnifiedOrder[] = [];

      // Ozon
      const seenOzon = new Set<string>();
      for (const store of this.ozonStores) {
        const idx = this.ozonStores.indexOf(store);
        const color = this.ozonColors[idx % this.ozonColors.length];
        for (const p of ozonPostings) {
          if (p.store_id !== store.id) continue;
          if (seenOzon.has(p.posting_number)) continue;
          seenOzon.add(p.posting_number);
          const ts = new Date(p.created_at).getTime();
          if (ts < startTs || ts > endTs) continue;
          const scheme = ozonSchemeToLabel(p.delivery_scheme);
          const canAct = scheme !== 'FBO' && ['awaiting_packaging', 'awaiting_deliver'].includes(p.status);
          batch.push(this.toUnified(p, 'ozon', store.name, store.id, color, scheme, canAct));
        }
      }

      // Yandex
      for (const store of this.yandexStores) {
        const idx = this.yandexStores.indexOf(store);
        const color = this.ymColors[idx % this.ymColors.length];
        const scheme = detectYandexScheme(store);
        for (const o of yandexOrders) {
          if ((o as any).store_id && (o as any).store_id !== store.id) continue;
          const ts = parseDateTs(o.creation_date);
          if (ts < startTs || ts > endTs) continue;
          const canAct = scheme !== 'FBY' && ['PROCESSING', 'DELIVERY'].includes(o.status);
          const first = o.items[0];
          batch.push({
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
      }

      // WB
      for (const store of this.wbStores) {
        const idx = this.wbStores.indexOf(store);
        const color = this.wbColors[idx % this.wbColors.length];
        for (const o of wbOrders) {
          if (o.store_id !== store.id) continue;
          const ts = parseDateTs(o.created_at);
          if (ts < startTs || ts > endTs) continue;
          const first = o.items[0];
          const canAct = ['new', 'confirm'].includes(o.status);
          batch.push({
            marketplace: 'wb',
            id: String(o.id),
            status: o.status,
            statusLabel: WB_STATUS_LABELS[o.status] ?? o.status,
            statusCss: WB_STATUS_CSS[o.status] ?? 'ord-s-cancelled',
            scheme: 'FBW',
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
      }

      this.orders = batch.sort((a, b) => parseDateTs(b.created_at) - parseDateTs(a.created_at));

      // Show WB warning if WB stores exist but no WB orders loaded (cooldown or error)
      if (this.wbStores.length > 0 && !batch.some(o => o.marketplace === 'wb')) {
        if (isWbCoolingDown()) {
          this.wbWarning = `WB rate-limit — подождите ещё ${wbCooldownRemaining()} сек`;
        } else if (!this.wbWarning) {
          this.wbWarning = 'WB: заказы не загружены';
        }
      } else if (batch.some(o => o.marketplace === 'wb')) {
        this.wbWarning = '';
      }
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) debug.warn('[AllOrders] cache load:', (err instanceof Error ? err.message : String(err)));
    } finally {
      if (this.abortController === ac) {
        this.loading = false;
        this.render();
      }
    }
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

  setStatusFilter(s: StatusCategory): void {
    this.filterStatus = this.filterStatus === s ? '' : s;
    this.render();
  }

  setSearch(q: string): void {
    this.search = q;
    const body = this.container.querySelector<HTMLElement>('#ord-body');
    if (body) {
      const filtered = this.getFiltered();
      body.innerHTML = this.renderContent(filtered);
      const countEl = this.container.querySelector<HTMLElement>('#ord-count-str');
      if (countEl) {
        const total = filtered.reduce((s, o) => s + o.total, 0);
        countEl.textContent = `${filtered.length.toLocaleString('ru')} заказов · ${Math.round(total).toLocaleString('ru')} ₽`;
      }
    } else {
      this.render();
    }
  }

  setDateFrom(v: string): void { this.dateFrom = v || null; this.render(); }
  setDateTo(v: string): void   { this.dateTo   = v || null; this.render(); }
  setToday(): void {
    const d = todayLocal();
    this.dateFrom = d; this.dateTo = d; this.render();
  }
  clearDateFilter(): void { this.dateFrom = null; this.dateTo = null; this.render(); }

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
    if (this.filterStatus) list = list.filter(o => statusCategory(o.marketplace, o.status) === this.filterStatus);
    if (this.dateFrom || this.dateTo) {
      const fromTs = this.dateFrom ? new Date(this.dateFrom + 'T00:00:00').getTime() : 0;
      const toTs   = this.dateTo   ? new Date(this.dateTo   + 'T23:59:59').getTime() : Infinity;
      list = list.filter(o => { const t = parseDateTs(o.created_at); return t >= fromTs && t <= toTs; });
    }
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
    } catch (e: unknown) {
      alert('Ошибка отгрузки: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка загрузки этикетки: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка отмены: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка загрузки этикетки: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка отмены: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка загрузки стикера: ' + ((e instanceof Error ? e.message : String(e)) || e));
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
    } catch (e: unknown) {
      alert('Ошибка отмены: ' + ((e instanceof Error ? e.message : String(e)) || e));
    }
    this.actionLoading = false;
  }

  private updateActionBar(text: string): void {
    const el = document.getElementById('aoo-action-status');
    if (el) el.textContent = text;
  }

  // ── Modal ────────────────────────────────────────────────────────────────

  openLightbox(images: string[], startIndex: number): void {
    let idx = startIndex;
    const show = () => {
      const lb = document.getElementById('aoo-lightbox')!;
      lb.querySelector<HTMLImageElement>('.aoo-lb-img')!.src = images[idx];
      lb.querySelector('.aoo-lb-counter')!.textContent = `${idx + 1} / ${images.length}`;
      lb.querySelector<HTMLButtonElement>('.aoo-lb-prev')!.style.display = images.length > 1 ? '' : 'none';
      lb.querySelector<HTMLButtonElement>('.aoo-lb-next')!.style.display = images.length > 1 ? '' : 'none';
    };
    let lb = document.getElementById('aoo-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'aoo-lightbox';
      lb.style.cssText = 'position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85);backdrop-filter:blur(8px)';
      lb.innerHTML = `
        <button class="aoo-lb-prev" style="position:absolute;left:20px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.12);border:none;color:#fff;font-size:28px;width:48px;height:48px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center">‹</button>
        <button class="aoo-lb-next" style="position:absolute;right:20px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.12);border:none;color:#fff;font-size:28px;width:48px;height:48px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center">›</button>
        <button class="aoo-lb-close" style="position:absolute;top:16px;right:20px;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:20px;width:36px;height:36px;border-radius:50%;cursor:pointer">×</button>
        <span class="aoo-lb-counter" style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.7);font-size:13px;font-weight:600"></span>
        <img class="aoo-lb-img" style="max-width:min(90vw,600px);max-height:80vh;object-fit:contain;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.6)">`;
      document.body.appendChild(lb);
      const hideLb = () => { lb!.style.display = 'none'; };
      const lbKeydown = (e: KeyboardEvent) => {
        if (lb!.style.display === 'none') return;
        if (e.key === 'Escape') hideLb();
        if (e.key === 'ArrowLeft') { idx = (idx - 1 + images.length) % images.length; show(); }
        if (e.key === 'ArrowRight') { idx = (idx + 1) % images.length; show(); }
      };
      lb.querySelector('.aoo-lb-close')!.addEventListener('click', hideLb);
      lb.querySelector('.aoo-lb-prev')!.addEventListener('click', (e) => { e.stopPropagation(); idx = (idx - 1 + images.length) % images.length; show(); });
      lb.querySelector('.aoo-lb-next')!.addEventListener('click', (e) => { e.stopPropagation(); idx = (idx + 1) % images.length; show(); });
      lb.addEventListener('click', (e) => { if (e.target === lb) hideLb(); });
      document.addEventListener('keydown', lbKeydown);
      (lb as any)._lbKeydown = lbKeydown;
    } else { lb.style.display = 'flex'; }
    show();
  }

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
          ${copyButton(o.storeName, 'Копировать название магазина')}
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
    const allImages = products.map(p => this.getProductImageFor(o.marketplace, p.offer_id)).filter(Boolean) as string[];
    const productsBlock = `
      <div class="ozo-section-head">
        <div class="ozo-section-title">Состав заказа</div>
        <div class="ozo-section-meta">${products.length} поз. · ${totalItems} шт.</div>
      </div>
      <div class="ozo-products-list">
        ${products.map((p) => {
          const lineTotal = p.price * p.quantity;
          const imgUrl = this.getProductImageFor(o.marketplace, p.offer_id);
          const name = p.name || this.getProductNameFor(o.marketplace, p.offer_id) || 'Без названия';
          const imgIdx = allImages.indexOf(imgUrl ?? '');
          const allImagesJson = JSON.stringify(allImages).replace(/"/g, '&quot;');
          const thumb = imgUrl
            ? `<div class="ozo-prod-thumb" style="cursor:zoom-in" onclick="event.stopPropagation();window.allOrdersModule.openLightbox(JSON.parse(this.dataset.imgs),${Math.max(0,imgIdx)})" data-imgs="${allImagesJson}"><img src="${this.esc(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='${I.package('',14)}'"></div>`
            : `<div class="ozo-prod-thumb ozo-prod-thumb-empty">${I.package('',14)}</div>`;
          return `<div class="ozo-prod-card">
            ${thumb}
            <div class="ozo-prod-info">
              <div style="display:flex;align-items:flex-start;gap:4px">
                <div class="ozo-prod-name" style="min-width:0" title="${this.esc(name)}">${this.esc(name)}</div>
                ${copyButton(name, 'Копировать название')}
              </div>
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
      <div class="ozo-modal" data-mp="${o.marketplace}">
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
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px"><path d="M2 2l10 10M12 2L2 12"/></svg>
          </button>
        </div>
        <div class="ozo-modal-body"><div class="ozo-modal-content">${infoBlock}${productsBlock}${actionsBlock}</div></div>
      </div>`;
  }

  private buildActionsHtml(o: UnifiedOrder): string {
    if (o.scheme === 'FBO' || o.scheme === 'FBY') {
      return `<div style="padding:16px 24px 20px;font-size:13px;color:var(--muted);border-top:1px solid var(--border)">
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
      <div class="ozo-modal-actions">
        <div class="ozo-modal-actions-label">Действия</div>
        <div class="ozo-modal-actions-row">
          ${buttons}
          <span id="aoo-action-status" class="ozo-modal-actions-status"></span>
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

    // Сохраняем фокус поиска до пересоздания DOM
    const activeEl = document.activeElement as HTMLInputElement | null;
    const searchFocused = activeEl?.classList.contains('search-input') && this.container.contains(activeEl);
    const selStart = searchFocused ? activeEl!.selectionStart : null;
    const selEnd   = searchFocused ? activeEl!.selectionEnd   : null;

    const filtered = this.getFiltered();
    const totalSum = filtered.reduce((s, o) => s + o.total, 0);

    const cntByMp = (mp: Marketplace) => this.orders.filter(o => o.marketplace === mp).length;
    const ozonCount = cntByMp('ozon');
    const ymCount = cntByMp('yandex');
    const wbCount = cntByMp('wb');

    // Список с учётом МП/схемы/поиска, но БЕЗ фильтра статуса — для корректных счётчиков на вкладках статусов
    const ordersForStatusCounts = (() => {
      let list = this.orders;
      if (this.filterMps.size > 0) list = list.filter(o => this.filterMps.has(o.marketplace));
      if (this.filterScheme) list = list.filter(o => o.scheme === this.filterScheme);
      if (this.search) {
        const q = this.search.toLowerCase();
        list = list.filter(o =>
          o.id.toLowerCase().includes(q) ||
          o.firstOfferId.toLowerCase().includes(q) ||
          o.firstName.toLowerCase().includes(q),
        );
      }
      return list;
    })();

    // Scheme counts — БЕЗ схема-фильтра, чтобы кнопка сброса оставалась видна
    const ordersForSchemeCounts = (() => {
      let list = this.orders;
      if (this.filterMps.size > 0) list = list.filter(o => this.filterMps.has(o.marketplace));
      if (this.search) {
        const q2 = this.search.toLowerCase();
        list = list.filter(o => o.id.toLowerCase().includes(q2) || o.firstOfferId.toLowerCase().includes(q2) || o.firstName.toLowerCase().includes(q2));
      }
      return list;
    })();
    const schemes: Scheme[] = ['FBO', 'FBS', 'FBW', 'DBS', 'FBY'];
    const schemeCounts = schemes.map(s => ({ scheme: s, count: ordersForSchemeCounts.filter(o => o.scheme === s).length })).filter(s => s.count > 0);

    // Status category counts — только по текущему МП/схеме/поиску
    const statusCats: StatusCategory[] = ['new', 'delivering', 'delivered', 'cancelled', 'returned'];
    const statusCounts = statusCats.map(c => ({
      cat: c,
      count: ordersForStatusCounts.filter(o => statusCategory(o.marketplace, o.status) === c).length,
    })).filter(s => s.count > 0);

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
            ${this.wbWarning ? `<span style="font-size:11px;padding:4px 10px;border-radius:8px;background:rgba(251,191,36,.12);color:#fbbf24;font-weight:600;margin-right:8px">${this.esc(this.wbWarning)}</span>` : ''}
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

        <!-- Статус-фильтры -->
        ${statusCounts.length > 0 || this.filterStatus ? `
        <div class="ord-scheme-bar" style="margin-top:2px">
          <button class="oz-tab ${this.filterStatus === '' ? 'active' : ''}"
            onclick="window.allOrdersModule.setStatusFilter('')">
            Все статусы<span class="oz-tab-cnt">${this.orders.length}</span>
          </button>
          ${statusCounts.map(s => `
            <button class="oz-tab ${this.filterStatus === s.cat ? 'active' : ''}"
              onclick="window.allOrdersModule.setStatusFilter('${s.cat}')">
              <span class="oz-dot" style="background:${STATUS_CAT_COLORS[s.cat]}"></span>${STATUS_CAT_LABELS[s.cat]}<span class="oz-tab-cnt">${s.count}</span>
            </button>
          `).join('')}
        </div>` : ''}

        <!-- Фильтры -->
        <div class="oz-filter-bar" style="flex-wrap:wrap;gap:6px 12px">
          <!-- Дата: быстрые кнопки -->
          <div class="oz-filter-group">
            <span class="oz-filter-label">Дата</span>
            <div class="oz-filter-pills" style="gap:4px">
              <button class="oz-fpill ${!this.dateFrom && !this.dateTo ? 'active' : ''}"
                onclick="window.allOrdersModule.clearDateFilter()">Все</button>
              <button class="oz-fpill ${this.dateFrom === this.dateTo && this.dateFrom === todayLocal() ? 'active' : ''}"
                onclick="window.allOrdersModule.setToday()">Сегодня</button>
            </div>
          </div>
          <!-- Дата: произвольный диапазон -->
          <div class="oz-filter-group">
            <span class="oz-filter-label">С</span>
            <input type="date" value="${this.dateFrom ?? ''}" max="${todayLocal()}"
              oninput="window.allOrdersModule.setDateFrom(this.value)"
              style="padding:4px 8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;height:28px">
          </div>
          <div class="oz-filter-group">
            <span class="oz-filter-label">По</span>
            <input type="date" value="${this.dateTo ?? ''}" max="${todayLocal()}"
              oninput="window.allOrdersModule.setDateTo(this.value)"
              style="padding:4px 8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;height:28px">
          </div>

          <div class="oz-filter-sep"></div>

          <!-- Загрузка: период -->
          <div class="oz-filter-group">
            <span class="oz-filter-label">Загрузить</span>
            <div class="oz-filter-pills">
              ${['7','30','90'].map(p => `
                <button class="oz-fpill ${this.period === p ? 'active' : ''}"
                  onclick="window.allOrdersModule.setPeriod('${p}')">${p} дн</button>
              `).join('')}
            </div>
          </div>

          ${schemeCounts.length > 1 || this.filterScheme ? `
          <div class="oz-filter-sep"></div>
          <div class="oz-filter-group">
            <span class="oz-filter-label">Схема</span>
            <div class="oz-filter-pills">
              <button class="oz-fpill ${this.filterScheme === '' ? 'active' : ''}"
                onclick="window.allOrdersModule.setSchemeFilter('')">Все</button>
              ${schemeCounts.map(s => `
                <button class="oz-fpill ${this.filterScheme === s.scheme ? 'active' : ''}"
                  style="${this.filterScheme === s.scheme ? SCHEME_CSS[s.scheme] : ''}"
                  onclick="window.allOrdersModule.setSchemeFilter('${s.scheme}')">${s.scheme}<span class="oz-tab-cnt">${s.count}</span></button>
              `).join('')}
            </div>
          </div>` : ''}

          <div class="oz-filter-sep"></div>
          <div class="search-wrap" style="width:200px">
            <span class="search-ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3" stroke-linecap="round"/></svg></span>
            <input class="search-input" placeholder="Номер, артикул…" value="${this.esc(this.search)}"
              oninput="window.allOrdersModule.setSearch(this.value)">
          </div>
          <span class="oz-filter-count" id="ord-count-str">${filtered.length.toLocaleString('ru')} заказов · ${Math.round(totalSum).toLocaleString('ru')} ₽</span>
        </div>

        <!-- Контент -->
        <div class="oz-body" id="ord-body" style="flex:1;overflow:auto;padding-bottom:90px">
          ${this.renderContent(filtered)}
        </div>
      </div>`;

    // Восстанавливаем фокус поиска после пересоздания DOM
    if (searchFocused) {
      const inp = this.container.querySelector<HTMLInputElement>('.search-input');
      if (inp) {
        inp.focus();
        if (selStart !== null && selEnd !== null) inp.setSelectionRange(selStart, selEnd);
      }
    }
  }

  private _dateGroupLabel(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const sameDay = (a: Date, b: Date) => a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    if (sameDay(d, today)) return 'Сегодня';
    if (sameDay(d, yesterday)) return 'Вчера';
    return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  }
  private _dateGroupKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
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
          <div class="ord-loader-sub">FBO + FBS + FBW · ${this.period} дней</div>
          <div class="ord-loader-bar"><div class="ord-loader-bar-fill"></div></div>
        </div>`;
    }
    if (!rows.length) {
      if (this.wbWarning && this.filterMps.size === 0) {
        return `<div class="oz-empty"><div class="oz-empty-title">Заказов нет</div><div class="oz-empty-sub">${this.esc(this.wbWarning)}</div></div>`;
      }
      return `<div class="oz-empty"><div class="oz-empty-title">Заказов нет</div></div>`;
    }

    let lastGroup = '';
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

      const ts = parseDateTs(o.created_at);
      const grpKey = this._dateGroupKey(ts);
      let grpRow = '';
      if (grpKey !== lastGroup) {
        lastGroup = grpKey;
        const grpLabel = this._dateGroupLabel(ts);
        grpRow = `<tr class="ord-date-group-row"><td colspan="7"><span class="ord-date-group-label">${grpLabel}</span></td></tr>`;
      }
      return grpRow + `
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
