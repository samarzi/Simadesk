import { debug } from '@/utils/debug';
import * as XLSX from 'xlsx';
import {
  OzonStore,
  OzonPosting,
  OzonReturn,
  DeliveryScheme,
  OrderFilters,
} from '@/types/ozon';
import { ozonDb } from '@/services/ozonDb';
import { ozonOrdersApi, fetchAllPages, fetchAllPagesByCursor } from '@/services/ozonOrdersApi';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { showToast } from '@/utils/toast';

// ── Статусы заказов ──────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  awaiting_packaging:             'Ожидает упаковки',
  awaiting_deliver:               'Ожидает отгрузки',
  delivering:                     'Доставляется',
  delivered:                      'Доставлен',
  cancelled:                      'Отменён',
  cancelled_from_split_pending:   'Отменён (разделение)',
  arbitration:                    'Арбитраж',
  not_accepted:                   'Не принят',
  sent_by_seller:                 'Передан перевозчику',
  driver_pickup:                  'У водителя',
  awaiting_registration:          'Ожидает регистрации',
  acceptance_in_progress:         'Приёмка',
  returned:                       'Возврат',
};

const STATUS_CSS: Record<string, string> = {
  awaiting_packaging:           'ord-s-new',
  awaiting_deliver:             'ord-s-ready',
  delivering:                   'ord-s-delivering',
  delivered:                    'ord-s-delivered',
  cancelled:                    'ord-s-cancelled',
  cancelled_from_split_pending: 'ord-s-cancelled',
  arbitration:                  'ord-s-arbitration',
  not_accepted:                 'ord-s-cancelled',
  sent_by_seller:               'ord-s-delivering',
  driver_pickup:                'ord-s-delivering',
  awaiting_registration:        'ord-s-new',
  acceptance_in_progress:       'ord-s-ready',
  returned:                     'ord-s-cancelled',
};

function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}
function statusCss(s: string): string {
  return STATUS_CSS[s] ?? 'ord-s-cancelled';
}

// ── Форматирование дат ───────────────────────────────────────────────────────

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });
}

// ── Итог заказа ──────────────────────────────────────────────────────────────

function calcTotal(products: OzonPosting['products']): number {
  return products.reduce((s, p) => {
    const price = parseFloat(p.price);
    const qty = Number(p.quantity);
    if (!isFinite(price) || !isFinite(qty)) return s;
    return s + price * qty;
  }, 0);
}

/**
 * Точное форматирование денежной суммы: "1 234 567 ₽".
 * Без сокращений — пользователю нужны точные значения.
 */
/** Скачивание Blob как файла. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function formatMoney(n: number): string {
  if (!isFinite(n) || n === 0) return '0 ₽';
  return Math.round(n).toLocaleString('ru') + ' ₽';
}

// ═══════════════════════════════════════════════════════════════════════════════

export class OzonOrdersModule {
  private stores: OzonStore[] = [];
  private activeTab: DeliveryScheme = 'fbs';
  private activeSubTab: 'postings' | 'returns' = 'postings';
  private postings: Map<DeliveryScheme, OzonPosting[]> = new Map();
  private returns: Map<DeliveryScheme, OzonReturn[]> = new Map();
  private detailsCache: Map<string, OzonPosting> = new Map();
  /** Карта offer_id → URL первого изображения товара (из ozon_products). */
  private productImages: Map<string, string> = new Map();

  private loading = false;
  private abortController: AbortController | null = null;
  private lastUpdated: Date | null = null;

  // Фильтры
  private filters: OrderFilters = { status: '', dateFrom: '', dateTo: '', search: '' };
  private period = '7';              // '7' | '30' | '90' | 'custom' — по умолчанию неделя
  private selectedStoreId: string | null = null;

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.render();
    try {
      // Магазины и фото товаров — параллельно. Фото не блокирующее.
      const [stores] = await Promise.all([
        ozonDb.getStores(),
        ozonDb.getProducts().then(products => {
          for (const p of products) {
            const img = p.images?.[0];
            if (img && !this.productImages.has(p.offer_id)) {
              this.productImages.set(p.offer_id, img);
            }
          }
          debug.log(`[Orders] Загружено фото товаров: ${this.productImages.size}`);
        }).catch(() => { /* фото не критичны */ }),
      ]);
      this.stores = stores;
    } catch {
      this.renderFatal('Не удалось загрузить список магазинов');
      return;
    }
    if (this.stores.length === 0) {
      this.renderFatal('Нет подключённых магазинов — добавьте магазин в разделе Ozon');
      return;
    }

    // Загружаем все схемы параллельно и сразу автовыбираем ту, где есть заказы
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;
    const { since, to } = this.getPeriodRange();

    debug.log(`[Orders] Запрос периода: ${since} → ${to}`);
    debug.log(`[Orders] Магазинов: ${this.stores.length}`, this.stores.map(s => s.name));

    this.loading = true;
    this.render();

    // Грузим FBS (все схемы: fbs+rfbs+dbs) и FBO параллельно.
    const [fbsErr, fboErr] = await Promise.all([
      this._fetchFbsData(since, to, signal).then(() => null).catch((e: Error) => { console.error('[Orders] FBS error:', e); return e; }),
      this._fetchFboData(since, to, signal).then(() => null).catch((e: Error) => { console.error('[Orders] FBO error:', e); return e; }),
    ]);
    const rfbsErr = null;

    // КРИТИЧНО: если этот цикл загрузки уже устарел (пользователь сменил период) —
    // не трогаем общее состояние, чтобы не сбить новый цикл.
    if (this.abortController !== ac || signal.aborted) {
      debug.log('[Orders] init: цикл загрузки устарел, выходим без рендера');
      return;
    }

    // Производный RFBS-список — фильтр от FBS по схеме
    const fbsAll = this.postings.get('fbs') ?? [];
    this.postings.set('rfbs', fbsAll.filter(p => p.delivery_scheme === 'rfbs'));

    this.loading = false;
    this.lastUpdated = new Date();

    // Автовыбор схемы с наибольшим количеством заказов
    const counts: [DeliveryScheme, number][] = [
      ['fbs',  this.postings.get('fbs')?.length  ?? 0],
      ['fbo',  this.postings.get('fbo')?.length  ?? 0],
      ['rfbs', this.postings.get('rfbs')?.length ?? 0],
    ];
    debug.log('[Orders] Загружено заказов:', { fbs: counts[0][1], fbo: counts[1][1], rfbs: counts[2][1] });

    const best = counts.reduce((a, b) => b[1] > a[1] ? b : a);
    if (best[1] > 0) this.activeTab = best[0];

    this.render();

    const totalLoaded = counts.reduce((s, [, c]) => s + c, 0);
    if (totalLoaded === 0) {
      const firstErr = fbsErr ?? fboErr ?? rfbsErr;
      if (firstErr && firstErr.name !== 'AbortError') {
        const errEl = document.getElementById('ord-content');
        if (errEl) errEl.innerHTML = `
          <div class="oz-empty">
            <div class="oz-empty-title" style="color:#ef4444">
              Ошибка загрузки: ${this.esc(firstErr.message ?? String(firstErr))}
            </div>
            <div class="oz-empty-sub">Проверьте Client-ID и API-ключ в настройках магазина</div>
          </div>`;
      }
    }
  }

  show(): void {
    this.container.style.display = 'block';
    this.init();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render(): void {
    const updLabel = this.lastUpdated
      ? `<span class="ord-updated">Обновлено: ${fmtDateTime(this.lastUpdated.toISOString())}</span>`
      : '';

    this.container.innerHTML = `
      <div class="oz-wrap">

        <!-- ── Topbar ── -->
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 20 20" fill="none">
                <rect x="1" y="1" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.5"/>
                <path d="M5 7h10M5 10h7M5 13h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <span class="oz-brand-name">Заказы</span>
            </div>
            ${updLabel}
          </div>
          <div class="oz-topbar-right">
            ${this.loading
              ? `<button class="btn btn-danger" style="padding:4px 10px;font-size:12px"
                   onclick="window.ozonOrdersModule.stopLoading()">✕ Стоп</button>`
              : `<button class="btn" onclick="window.ozonOrdersModule.exportExcel()">
                   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px">
                     <path d="M8 10V2M4 6l4 4 4-4M2 12v2h12v-2"/>
                   </svg>
                   Экспорт
                 </button>`}
            <button class="btn btn-primary" onclick="window.ozonOrdersModule.refresh()" ${this.loading ? 'disabled' : ''}>
              ${this.loading
                ? `<svg class="oz-spin" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M11 6A5 5 0 1 1 6.2 1.2M11 1v3H8"/></svg>
                   Загрузка…`
                : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M14 8A6 6 0 1 1 8.5 2.1M14 2v4h-4"/></svg>
                   Обновить`}
            </button>
          </div>
        </div>

        ${this.stores.length === 0 ? '' : `

          <!-- ── Схемы доставки (FBS / FBO / RealFBS) ── -->
          <div class="ord-scheme-bar">
            ${(['fbs', 'fbo', 'rfbs'] as DeliveryScheme[]).map(sc => {
              const list = this.postings.get(sc);
              const cnt = list != null ? list.length.toLocaleString('ru') : '—';
              const lbl = sc === 'fbo' ? 'FBO' : sc === 'fbs' ? 'FBS / DBS' : 'RealFBS';
              return `<button class="oz-tab ${this.activeTab === sc ? 'active' : ''}"
                onclick="window.ozonOrdersModule.selectTab('${sc}')">
                ${lbl}<span class="oz-tab-cnt">${cnt}</span>
              </button>`;
            }).join('')}
          </div>

          <!-- ── Панель фильтров ── -->
          ${this.buildFilterBar()}

          <!-- ── Статистика ── -->
          ${this.buildStatsBar()}

          <!-- ── Контент ── -->
          <div class="oz-body" id="ord-content">
            ${this.renderContent()}
          </div>
        `}
      </div>
    `;
  }

  // ── Панель фильтров ──────────────────────────────────────────────────────────

  private buildFilterBar(): string {
    const f = this.filters;
    const periods = [
      { v: '7',  l: '7 дней' },
      { v: '30', l: '30 дней' },
      { v: '90', l: '90 дней' },
      { v: 'custom', l: 'Период' },
    ];

    const storeOpts = this.stores.map(s =>
      `<option value="${this.esc(s.id)}" ${this.selectedStoreId === s.id ? 'selected' : ''}>${this.esc(s.name)}</option>`
    ).join('');

    const statusOpts = [
      ['', 'Все статусы'],
      ['awaiting_packaging', 'Ожидает упаковки'],
      ['awaiting_deliver', 'Ожидает отгрузки'],
      ['delivering', 'Доставляется'],
      ['delivered', 'Доставлен'],
      ['cancelled', 'Отменён'],
      ['arbitration', 'Арбитраж'],
      ['sent_by_seller', 'Передан перевозчику'],
    ].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('');

    const customDates = this.period === 'custom' ? `
      <input type="date" class="oz-filter-inp" value="${this.esc(f.dateFrom)}"
        onchange="window.ozonOrdersModule.setFilter('dateFrom',this.value)">
      <span class="oz-filter-dash">—</span>
      <input type="date" class="oz-filter-inp" value="${this.esc(f.dateTo)}"
        onchange="window.ozonOrdersModule.setFilter('dateTo',this.value)">
    ` : '';

    return `
      <div class="oz-filter-bar">

        <!-- Период -->
        <div class="oz-filter-group">
          <span class="oz-filter-label">Период</span>
          <div class="oz-filter-pills">
            ${periods.map(p => `
              <button class="oz-fpill ${this.period === p.v ? 'active' : ''}"
                onclick="window.ozonOrdersModule.setPeriod('${p.v}')">${p.l}</button>
            `).join('')}
          </div>
          ${customDates}
        </div>

        <div class="oz-filter-sep"></div>

        <!-- Магазин -->
        ${this.stores.length > 1 ? `
          <div class="oz-filter-group">
            <span class="oz-filter-label">Магазин</span>
            <select class="oz-filter-sel"
              onchange="window.ozonOrdersModule.setStoreFilter(this.value)">
              <option value="" ${!this.selectedStoreId ? 'selected' : ''}>Все магазины</option>
              ${storeOpts}
            </select>
          </div>
          <div class="oz-filter-sep"></div>
        ` : ''}

        <!-- Статус -->
        <div class="oz-filter-group">
          <span class="oz-filter-label">Статус</span>
          <select class="oz-filter-sel"
            onchange="window.ozonOrdersModule.setFilter('status',this.value)">
            ${statusOpts}
          </select>
        </div>

        <div class="oz-filter-sep"></div>

        <!-- Поиск -->
        <div class="search-wrap" style="width:220px">
          <span class="search-ic">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6.5" cy="6.5" r="4.5"/>
              <path d="M10 10l3 3" stroke-linecap="round"/>
            </svg>
          </span>
          <input class="search-input" placeholder="Номер отправления, артикул…"
            value="${this.esc(f.search)}"
            oninput="window.ozonOrdersModule.setFilter('search',this.value)">
        </div>

        ${this.hasActiveFilters() ? `
          <button class="oz-filter-reset"
            onclick="window.ozonOrdersModule.resetFilters()">✕ Сбросить</button>
        ` : ''}

        <span class="oz-filter-count">${this.getFilteredPostings().length.toLocaleString('ru')} заказов</span>

      </div>
    `;
  }

  // ── Статистика ───────────────────────────────────────────────────────────────

  private buildStatsBar(): string {
    const all = this.getFilteredPostings();
    if (!all.length) return '';

    // Группируем по статусу и считаем количество + сумму для каждого
    const byStatus = (st: string) => all.filter(p => p.status === st);
    const sumOf = (list: OzonPosting[]) => calcTotal(list.flatMap(p => p.products));

    const newList       = byStatus('awaiting_packaging');
    const readyList     = byStatus('awaiting_deliver');
    const deliveringList = all.filter(p => ['delivering', 'sent_by_seller', 'driver_pickup'].includes(p.status));
    const deliveredList = byStatus('delivered');
    const cancelledList = all.filter(p => ['cancelled', 'cancelled_from_split_pending', 'not_accepted'].includes(p.status));

    const stats = [
      { label: 'Всего',      count: all.length,            sum: sumOf(all),            cls: '' },
      { label: 'Новых',      count: newList.length,        sum: sumOf(newList),        cls: 'ord-stat-new' },
      { label: 'Отгрузить',  count: readyList.length,      sum: sumOf(readyList),      cls: 'ord-stat-ready' },
      { label: 'В доставке', count: deliveringList.length, sum: sumOf(deliveringList), cls: 'ord-stat-del' },
      { label: 'Доставлено', count: deliveredList.length,  sum: sumOf(deliveredList),  cls: 'ord-stat-ok' },
      { label: 'Отменено',   count: cancelledList.length,  sum: sumOf(cancelledList),  cls: 'ord-stat-cancel' },
    ];

    return `
      <div class="ord-stats-bar">
        ${stats.map(s => `
          <div class="ord-stat ${s.cls}">
            <span class="ord-stat-val">${s.count.toLocaleString('ru')}</span>
            <span class="ord-stat-lbl">${s.label}</span>
            <span class="ord-stat-sum" title="${s.sum.toLocaleString('ru', { maximumFractionDigits: 0 })} ₽">${formatMoney(s.sum)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ── Контент (отправления / возвраты) ────────────────────────────────────────

  private renderContent(): string {
    const hasReturns = this.activeTab === 'rfbs' ||
                       (this.activeTab === 'fbs' && (this.returns.get('fbs')?.length ?? 0) > 0);

    const subTabs = hasReturns ? `
      <div class="ord-subtab-bar">
        <button class="oz-tab ${this.activeSubTab === 'postings' ? 'active' : ''}"
          onclick="window.ozonOrdersModule.selectSubTab('postings')">
          Отправления
          <span class="oz-tab-cnt">${(this.postings.get(this.activeTab)?.length ?? 0).toLocaleString('ru')}</span>
        </button>
        <button class="oz-tab ${this.activeSubTab === 'returns' ? 'active' : ''}"
          onclick="window.ozonOrdersModule.selectSubTab('returns')">
          Возвраты
          <span class="oz-tab-cnt">${(this.returns.get(this.activeTab)?.length ?? 0).toLocaleString('ru')}</span>
        </button>
      </div>
    ` : '';

    const body = this.activeSubTab === 'returns'
      ? this.renderReturnsTable()
      : this.renderPostingsTable();

    return subTabs + body;
  }

  // ── Таблица отправлений ──────────────────────────────────────────────────────

  private renderPostingsTable(): string {
    if (this.loading && !this.postings.has(this.activeTab)) {
      return this.renderLoader();
    }

    const rows = this.getFilteredPostings();

    if (rows.length === 0) {
      return `
        <div class="oz-empty">
          <div class="oz-empty-title">${this.hasActiveFilters() ? 'Нет заказов по фильтрам' : 'Заказов нет'}</div>
          <div class="oz-empty-sub">Попробуйте изменить период или сбросить фильтры</div>
        </div>`;
    }

    const scheme = this.activeTab;
    const thead = this.buildThead(scheme);
    const tbody = rows.map(p => this.buildRow(p, scheme)).join('');

    return `
      <div class="oz-table-wrap">
        <table class="oz-table">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  }

  private buildThead(scheme: DeliveryScheme): string {
    const base = `
      <th style="width:32px"></th>
      <th>Отправление</th>
      <th>Статус</th>
      <th>Создан</th>
      <th style="width:50px"></th>
      <th>Состав</th>
      <th style="text-align:right">Сумма</th>
    `;
    if (scheme === 'fbs') {
      return base + `<th>Срок отгрузки</th><th>Склад</th>`;
    }
    if (scheme === 'fbo') {
      return base + `<th>Дата отгрузки</th>`;
    }
    return base + `<th>Доставка</th><th>Адрес</th>`;
  }

  /** Получить URL первого изображения товара по offer_id (или fallback-плейсхолдер). */
  private getProductImage(offerId: string): string | null {
    return this.productImages.get(offerId) ?? null;
  }

  /** HTML миниатюры товара (с lazy-loading) или плейсхолдер. */
  private productThumb(offerId: string, size = 38): string {
    const img = this.getProductImage(offerId);
    if (img) {
      return `<img src="${this.esc(img)}" alt="" loading="lazy"
        style="width:${size}px;height:${size}px;border-radius:6px;object-fit:cover;border:1px solid var(--border);background:var(--bg2)"
        onerror="this.style.display='none'">`;
    }
    return `<div style="width:${size}px;height:${size}px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px">${I.package('',16)}</div>`;
  }

  private buildRow(p: OzonPosting, scheme: DeliveryScheme): string {
    const isNew = p.status === 'awaiting_packaging';
    const total = calcTotal(p.products).toLocaleString('ru', { maximumFractionDigits: 0 });
    const currency = p.products[0]?.currency_code ?? 'RUB';
    const storeName = this.stores.find(s => s.id === p.store_id)?.name ?? '—';

    // Схема-бейдж (DBS vs FBS)
    const schemeBadge = scheme === 'fbs' && p.delivery_scheme === 'rfbs'
      ? `<span class="ord-scheme-badge ord-dbs">DBS</span>`
      : '';

    // Первый товар + «и ещё N»
    const first = p.products[0];
    const moreCount = p.products.length - 1;
    // Стек миниатюр (до 3-х товаров)
    const thumbsHtml = p.products.slice(0, 3).map((pr, i) => {
      const offset = i * 16;
      return `<div style="position:absolute;left:${offset}px;top:0;z-index:${10 - i}">${this.productThumb(pr.offer_id, 36)}</div>`;
    }).join('');
    const thumbsCount = Math.min(p.products.length, 3);
    const thumbsCell = `<div style="position:relative;width:${36 + (thumbsCount - 1) * 16}px;height:36px">${thumbsHtml}</div>`;

    const productsCell = first
      ? `<div class="ord-product-line">
           ${this.skuChip(first.offer_id)}
           <span class="ord-qty">× ${first.quantity}</span>
           ${first.name ? `<span class="ord-pname">${this.esc(first.name.slice(0, 40))}${first.name.length > 40 ? '…' : ''}</span>${copyButton(first.name, 'Копировать название')}` : ''}
         </div>
         ${moreCount > 0 ? `<span class="ord-more">+${moreCount} ещё</span>` : ''}`
      : '—';

    let schemeCols = '';
    if (scheme === 'fbo') {
      schemeCols = `<td class="oz-muted">${fmtDate(p.in_process_at)}</td>`;
    } else if (scheme === 'fbs') {
      schemeCols = `
        <td class="ord-deadline ${isNew ? 'ord-deadline-urgent' : ''}">${fmtDate(p.shipment_date)}</td>
        <td class="oz-muted">${p.warehouse_id ? `<span class="ord-warehouse">${p.warehouse_id}</span>` : '—'}</td>
      `;
    } else {
      const addr = p.customer_address
        ? `<span class="ord-addr" title="${this.esc(p.customer_address)}">${this.esc(p.customer_address.slice(0, 30))}${p.customer_address.length > 30 ? '…' : ''}</span>`
        : '—';
      schemeCols = `<td class="oz-muted">${fmtDate(p.shipment_date)}</td><td>${addr}</td>`;
    }

    return `
      <tr class="oz-row" onclick="window.ozonOrdersModule.openPostingModal('${this.esc(p.posting_number)}','${p.delivery_scheme}')">
        <td onclick="event.stopPropagation()" style="padding:8px 10px">
          <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
            <span class="ord-store-dot" title="${this.esc(storeName)}"
              style="background:${this.storeColor(p.store_id)}"></span>
          </div>
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            ${this.skuChip(p.posting_number)}
            ${schemeBadge}
            ${isNew ? `<span class="ord-new-badge">Новый</span>` : ''}
          </div>
          <div class="oz-muted" style="font-size:11px;margin-top:3px;display:flex;align-items:center;gap:4px">${this.esc(storeName)}${copyButton(storeName, 'Копировать название магазина')}</div>
        </td>
        <td><span class="oz-badge ${statusCss(p.status)}">${statusLabel(p.status)}</span></td>
        <td class="oz-muted">${fmtDateTime(p.created_at)}</td>
        <td style="padding:6px 8px">${thumbsCell}</td>
        <td>${productsCell}</td>
        <td class="oz-prc" style="text-align:right;white-space:nowrap">${total} ${currency}</td>
        ${schemeCols}
      </tr>`;
  }

  // ── Таблица возвратов ────────────────────────────────────────────────────────

  private renderReturnsTable(): string {
    if (this.loading) return this.renderLoader();

    const list = this.returns.get(this.activeTab) ?? [];
    if (!list.length) {
      return `<div class="oz-empty"><div class="oz-empty-title">Возвратов нет</div></div>`;
    }

    const rows = list.map(r => {
      const productsHtml = r.products
        .map(pr => `<div class="ord-product-line"><span class="oz-sku">${this.esc(pr.offer_id)}</span> × ${pr.quantity}</div>`)
        .join('');
      return `
        <tr class="oz-row">
          <td class="oz-sku">${r.id}</td>
          <td class="oz-sku">${this.esc(r.posting_number)}</td>
          <td><span class="oz-badge ${statusCss(r.status)}">${statusLabel(r.status)}</span></td>
          <td class="oz-muted">${fmtDateTime(r.created_at)}</td>
          <td>${productsHtml}</td>
          <td class="oz-muted">${this.esc(r.reason_name ?? '—')}</td>
        </tr>`;
    }).join('');

    return `
      <div class="oz-table-wrap">
        <table class="oz-table">
          <thead><tr>
            <th>ID</th><th>Отправление</th><th>Статус</th>
            <th>Дата</th><th>Состав</th><th>Причина</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Загрузчик ────────────────────────────────────────────────────────────────

  private renderLoader(): string {
    const periodLabel = this.period === '7' ? '7 дней'
      : this.period === '30' ? '30 дней'
      : this.period === '90' ? '90 дней'
      : 'выбранный период';
    return `
      <div class="ord-loader">
        <div class="ord-loader-spinner">
          <svg class="oz-spin" viewBox="0 0 40 40" fill="none" stroke="#005bff"
            stroke-width="3" stroke-linecap="round" style="width:48px;height:48px">
            <path d="M36 20A16 16 0 1 1 20 4" stroke-dasharray="60 30"/>
          </svg>
        </div>
        <div class="ord-loader-title">Загружаем заказы</div>
        <div class="ord-loader-sub">Период: ${periodLabel}</div>
        <div class="ord-loader-bar"><div class="ord-loader-bar-fill"></div></div>
      </div>`;
  }

  private renderFatal(msg: string): void {
    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-empty" style="margin-top:60px">
          <div class="oz-empty-title">${this.esc(msg)}</div>
          <button class="btn btn-primary" style="margin-top:12px"
            onclick="window.ozonOrdersModule.init()">Повторить</button>
        </div>
      </div>`;
  }

  // ── Модальное окно отправления ───────────────────────────────────────────────

  openPostingModal(postingNumber: string, scheme: DeliveryScheme): void {
    let modal = document.getElementById('ozo-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ozo-modal';
      modal.className = 'ozo-modal-backdrop';
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    modal.innerHTML = this.modalShell(postingNumber, '', this.renderLoader());
    this.bindModalClose(modal);

    const cached = this.detailsCache.get(postingNumber);
    if (cached) { this.fillModal(modal, cached); return; }

    const postingMeta = [...this.postings.values()].flat().find(p => p.posting_number === postingNumber);
    const store = this.stores.find(s => s.id === postingMeta?.store_id) ?? this.stores[0];
    if (!store) { this.fillModalError(modal, 'Нет доступных магазинов'); return; }

    const creds = { client_id: store.client_id, api_key: store.api_key };
    const fetcher = scheme === 'fbo'
      ? ozonOrdersApi.getFboPostingDetail(creds, postingNumber)
      : ozonOrdersApi.getFbsPostingDetail(creds, postingNumber);

    fetcher
      .then(posting => {
        this.detailsCache.set(postingNumber, posting);
        if (modal!.style.display !== 'none') this.fillModal(modal!, posting);
      })
      .catch((err: unknown) => {
        if (modal!.style.display !== 'none')
          this.fillModalError(modal!, err instanceof Error ? err.message : String(err));
      });
  }

  private modalShell(title: string, subtitle: string, body: string): string {
    const escTitle = this.esc(title);
    const titleClickable = title !== 'Ошибка' && title.length > 0;
    return `
      <div class="ozo-modal">
        <div class="ozo-modal-head">
          <div style="min-width:0;flex:1">
            <div class="ozo-modal-title ${titleClickable ? 'ozo-modal-title-copy' : ''}"
              ${titleClickable ? `title="Скопировать номер" onclick="window.ozonOrdersModule.copyArticle('${escTitle}', this)"` : ''}>
              ${escTitle}
              ${titleClickable ? `<svg class="ozo-modal-title-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="4" width="8" height="9" rx="1"/>
                <path d="M2 10V2a1 1 0 0 1 1-1h7"/>
              </svg>` : ''}
            </div>
            ${subtitle ? `<div class="ozo-modal-sub">${subtitle}</div>` : ''}
          </div>
          <button id="ozo-modal-close" class="ozo-modal-close" title="Закрыть (Esc)">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              style="width:14px;height:14px"><path d="M2 2l10 10M12 2L2 12"/></svg>
          </button>
        </div>
        <div id="ozo-modal-body" class="ozo-modal-body">${body}</div>
      </div>`;
  }

  private fillModal(modal: HTMLElement, p: OzonPosting): void {
    const schemeNames: Record<DeliveryScheme, string> = { fbo: 'FBO', fbs: 'FBS', rfbs: 'RealFBS / DBS' };
    const storeName = this.stores.find(s => s.id === p.store_id)?.name ?? '—';
    const storeColor = this.storeColor(p.store_id);
    const currency = p.products[0]?.currency_code ?? 'RUB';
    const totalNum = calcTotal(p.products);
    const total = totalNum.toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const itemsCount = p.products.reduce((s, pr) => s + pr.quantity, 0);
    const isNew = p.status === 'awaiting_packaging';

    // Подзаголовок: статус + схема + магазин
    const subtitle = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        <span class="oz-badge ${statusCss(p.status)}">${statusLabel(p.status)}</span>
        <span class="ozo-pill">${schemeNames[p.delivery_scheme] ?? p.delivery_scheme}</span>
        <span class="ozo-pill" style="display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${storeColor}"></span>
          ${this.esc(storeName)}
          ${copyButton(storeName, 'Копировать название магазина')}
        </span>
        ${isNew ? '<span class="ord-new-badge">Новый</span>' : ''}
      </div>`;

    // Грид-карточки с инфой — 2 колонки на десктопе
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
    };

    const infoBlock = `
      <div class="ozo-info-grid">
        ${infoCard(ICONS.calendar, 'Создан',       fmtDateTime(p.created_at))}
        ${infoCard(ICONS.clock,    'В обработке',  fmtDateTime(p.in_process_at))}
        ${infoCard(ICONS.truck,    'Отгрузка',     fmtDate(p.shipment_date))}
        ${infoCard(ICONS.truck,    'Доставка',     fmtDate(p.delivering_date))}
        ${infoCard(ICONS.hash,     'Трекинг',      p.tracking_number ? this.skuChip(p.tracking_number) : null)}
        ${infoCard(ICONS.box,      'Склад',        p.warehouse_id?.toString())}
        ${infoCard(ICONS.pin,      'Регион',       p.region ? this.esc(p.region) : null)}
        ${infoCard(ICONS.pin,      'Адрес',        p.customer_address ? this.esc(p.customer_address) : null)}
      </div>`;

    // Карточки товаров вместо таблицы — лучше для мобилки и красивее
    const productsBlock = `
      <div class="ozo-section-head">
        <div class="ozo-section-title">Состав заказа</div>
        <div class="ozo-section-meta">${p.products.length} позиц${p.products.length === 1 ? 'ия' : p.products.length < 5 ? 'ии' : 'ий'} · ${itemsCount} шт.</div>
      </div>
      <div class="ozo-products-list">
        ${p.products.map(pr => {
          const price = parseFloat(pr.price) || 0;
          const lineTotal = price * pr.quantity;
          const imgUrl = this.getProductImage(pr.offer_id);
          const thumb = imgUrl
            ? `<a href="${this.esc(imgUrl)}" target="_blank" rel="noopener" class="ozo-prod-thumb">
                 <img src="${this.esc(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='${I.package('',16)}'">
               </a>`
            : `<div class="ozo-prod-thumb ozo-prod-thumb-empty">${I.package('',16)}</div>`;
          return `<div class="ozo-prod-card">
            ${thumb}
            <div class="ozo-prod-info">
              <div style="display:flex;align-items:flex-start;gap:4px">
                <div class="ozo-prod-name" style="min-width:0" title="${this.esc(pr.name)}">${this.esc(pr.name) || 'Без названия'}</div>
                ${pr.name ? copyButton(pr.name, 'Копировать название') : ''}
              </div>
              <div class="ozo-prod-sku">${this.skuChip(pr.offer_id)}</div>
            </div>
            <div class="ozo-prod-price">
              <div class="ozo-prod-unit">${price.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency} × ${pr.quantity}</div>
              <div class="ozo-prod-line">${lineTotal.toLocaleString('ru', { minimumFractionDigits: 2 })} ${currency}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="ozo-modal-total">
        <span class="ozo-modal-total-lbl">Итого по заказу</span>
        <span class="ozo-modal-total-val">${total} ${currency}</span>
      </div>`;

    // Блок действий FBS (только для FBS/RFBS заказов)
    const isFbs = p.delivery_scheme === 'fbs' || p.delivery_scheme === 'rfbs';
    const canShip = isFbs && (p.status === 'awaiting_packaging' || p.status === 'awaiting_deliver');
    const canCancel = isFbs && p.status !== 'cancelled' && p.status !== 'delivered';
    const actionsBlock = isFbs ? `
      <div class="ozo-actions-block">
        <div class="ozo-actions-title">Действия с заказом</div>
        <div class="ozo-actions-row">
          ${canShip ? `<button class="btn btn-primary" onclick="window.ozonOrdersModule.shipPosting('${this.esc(p.posting_number)}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M1 5h10v6H1zM11 7h3l1 1v3h-4zM4 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM13 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>
            Отгрузить
          </button>` : ''}
          <button class="btn" onclick="window.ozonOrdersModule.downloadLabel('${this.esc(p.posting_number)}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M3 2h10v12H3zM5 6h6M5 9h6M5 12h4"/></svg>
            Этикетка PDF
          </button>
          ${canCancel ? `<button class="btn btn-danger" onclick="window.ozonOrdersModule.cancelPosting('${this.esc(p.posting_number)}')" style="margin-left:auto">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M2 2l10 10M12 2L2 12"/></svg>
            Отменить заказ
          </button>` : ''}
        </div>
        <div class="ozo-actions-hint">Этикетка — PDF файл для печати при отгрузке. Отгрузка переводит статус в «Передан перевозчику».</div>
      </div>
    ` : '';

    const body = `<div class="ozo-modal-content">${infoBlock}${productsBlock}${actionsBlock}</div>`;
    modal.innerHTML = this.modalShell(p.posting_number, subtitle, body);
    this.bindModalClose(modal);
  }

  // ── FBS Actions ────────────────────────────────────────────────────

  /** Получить store + creds для заказа. */
  private findStoreForPosting(postingNumber: string): { creds: { client_id: string; api_key: string }; product_ids: Map<string, number> } | null {
    const posting = [...this.postings.values()].flat().find(p => p.posting_number === postingNumber);
    if (!posting) return null;
    const store = this.stores.find(s => s.id === posting.store_id);
    if (!store) return null;
    // Маппинг offer_id → product_id (нужен для ship API)
    const product_ids = new Map<string, number>();
    for (const prod of posting.products) {
      // У OzonPostingProduct нет product_id напрямую; используем offer_id для quantity-маппинга
      // Ship API на самом деле принимает product_id, но если детали есть в detailsCache —
      // там есть sku/product_id. Пока попробуем через detail-эндпоинт.
      product_ids.set(prod.offer_id, 0);
    }
    return { creds: { client_id: store.client_id, api_key: store.api_key }, product_ids };
  }

  async shipPosting(postingNumber: string): Promise<void> {
    if (!confirm(`Отгрузить заказ ${postingNumber}?\n\nПосле отгрузки статус изменится на «Передан перевозчику».`)) return;
    const ctx = this.findStoreForPosting(postingNumber);
    if (!ctx) { showToast('Не найден магазин для заказа', 'error'); return; }
    try {
      // Загружаем детали чтобы получить product_id
      const detail = this.detailsCache.get(postingNumber) ?? await ozonOrdersApi.getFbsPostingDetail(ctx.creds, postingNumber);
      const products = (detail.products ?? []).map((pr: any) => ({
        product_id: pr.sku ?? pr.product_id ?? 0,
        quantity: pr.quantity,
      })).filter((p: any) => p.product_id);
      if (products.length === 0) {
        showToast('Не удалось получить product_id товаров для отгрузки. Попробуйте через кабинет Ozon.', 'error');
        return;
      }
      await ozonOrdersApi.shipFbsPosting(ctx.creds, postingNumber, [{ products }]);
      showToast('✓ Заказ отгружен', 'success');
      this.refresh();
    } catch (err: unknown) {
      showToast(`Ошибка отгрузки: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async downloadLabel(postingNumber: string): Promise<void> {
    const ctx = this.findStoreForPosting(postingNumber);
    if (!ctx) { showToast('Не найден магазин для заказа', 'error'); return; }
    try {
      const blob = await ozonOrdersApi.getFbsPackageLabelPdf(ctx.creds, [postingNumber]);
      downloadBlob(blob, `ozon-label-${postingNumber}.pdf`);
    } catch (err: unknown) {
      showToast(`Не удалось получить этикетку: ${err instanceof Error ? err.message : String(err)}. Возможные причины: заказ ещё не собран, у магазина нет прав или истекли.`, 'error');
    }
  }

  async cancelPosting(postingNumber: string): Promise<void> {
    const ctx = this.findStoreForPosting(postingNumber);
    if (!ctx) { showToast('Не найден магазин для заказа', 'error'); return; }
    try {
      const reasons = await ozonOrdersApi.getFbsCancelReasons(ctx.creds);
      if (!reasons.length) { showToast('Не удалось получить список причин отмены', 'error'); return; }
      // Простое prompt с первыми вариантами
      const list = reasons.slice(0, 10).map((r, i) => `${i + 1}. ${r.title}`).join('\n');
      const choice = prompt(`Выбери причину отмены (1-${Math.min(reasons.length, 10)}):\n\n${list}`);
      const idx = parseInt(choice ?? '');
      if (!isFinite(idx) || idx < 1 || idx > reasons.length) return;
      const reason = reasons[idx - 1];
      const message = prompt('Комментарий (необязательно):') ?? '';
      await ozonOrdersApi.cancelFbsPosting(ctx.creds, postingNumber, reason.id, message);
      showToast('✓ Заказ отменён', 'success');
      this.refresh();
    } catch (err: unknown) {
      showToast(`Не удалось отменить: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
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

  private bindModalClose(modal: HTMLElement): void {
    modal.onclick = (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('#ozo-modal-close')) {
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

  // ── Загрузка данных ──────────────────────────────────────────────────────────

  /**
   * Получить данные по FBS + RealFBS + DBS (без рендера).
   * Использует cursor-based пагинацию Ozon API v4 — offset игнорируется в новой версии API.
   */
  private async _fetchFbsData(since: string, to: string, signal: AbortSignal): Promise<void> {
    const allFbs: OzonPosting[] = [];
    const allReturns: OzonReturn[] = [];
    const seen = new Set<string>();  // защита от дублей по posting_number

    await Promise.all(this.stores.map(async store => {
      if (this.selectedStoreId && store.id !== this.selectedStoreId) return;
      const creds = { client_id: store.client_id, api_key: store.api_key };
      // КУРСОР-пагинация: передаём cursor (строку) вместо offset
      const all = await fetchAllPagesByCursor(
        (lim, cursor, sig) => ozonOrdersApi.getFbsPostings(creds, since, to, null, lim, cursor, sig),
        50, signal,
      );
      // Удаляем потенциальные дубли (на случай если Ozon вернёт пересечения)
      for (const p of all) {
        if (!seen.has(p.posting_number)) {
          seen.add(p.posting_number);
          p.store_id = store.id;
          allFbs.push(p);
        }
      }
      // Возвраты — параллельно и без блокировки
      fetchAllPages(
        (lim, off, sig) => ozonOrdersApi.getRfbsReturns(creds, lim, off as number, sig),
        50, signal,
      ).then(rets => { allReturns.push(...rets); this.returns.set('fbs', [...allReturns]); })
       .catch((e) => debug.warn('[OzonOrdersModule] rfbs returns error:', e));
    }));
    this.postings.set('fbs', allFbs.sort((a, b) =>
      (b.created_at ?? '').localeCompare(a.created_at ?? '')));
  }

  /** Получить данные по FBO (без рендера). */
  private async _fetchFboData(since: string, to: string, signal: AbortSignal): Promise<void> {
    const all: OzonPosting[] = [];
    await Promise.all(this.stores.map(async store => {
      if (this.selectedStoreId && store.id !== this.selectedStoreId) return;
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const ps = await fetchAllPages(
        (lim, off, sig) => ozonOrdersApi.getFboPostings(creds, since, to, lim, off as number, sig),
        50, signal,
      );
      ps.forEach(p => { p.store_id = store.id; });
      all.push(...ps);
    }));
    this.postings.set('fbo', all.sort((a, b) =>
      (b.created_at ?? '').localeCompare(a.created_at ?? '')));
  }

  /**
   * Загружает только возвраты RealFBS (заказы получаем из _fetchFbsData).
   * Сами RFBS-отправления — это подмножество FBS-данных, фильтруются на клиенте.
   */
  private async _fetchRfbsData(since: string, to: string, signal: AbortSignal): Promise<void> {
    // since/to не нужны для возвратов — Ozon API возвращает все RFBS-возвраты
    void since; void to;
    const allReturns: OzonReturn[] = [];
    await Promise.all(this.stores.map(async store => {
      if (this.selectedStoreId && store.id !== this.selectedStoreId) return;
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const rets = await fetchAllPages(
        (lim, off, sig) => ozonOrdersApi.getRfbsReturns(creds, lim, off as number, sig),
        50, signal,
      ).catch(() => [] as OzonReturn[]);
      allReturns.push(...rets);
    }));
    this.returns.set('rfbs', allReturns);
  }

  /**
   * Перегрузить конкретную схему (вызывается при смене вкладки, если нет кэша).
   * Рендерит состояние загрузки и результат.
   */
  private async loadTab(scheme: DeliveryScheme): Promise<void> {
    if (!this.stores.length) return;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.loading = true;
    this.render();

    const { since, to } = this.getPeriodRange();

    try {
      if (scheme === 'fbo') {
        await this._fetchFboData(since, to, signal);
      } else if (scheme === 'rfbs') {
        // RFBS — это подмножество FBS. Грузим FBS целиком, потом фильтруем.
        await this._fetchFbsData(since, to, signal);
        await this._fetchRfbsData(since, to, signal);
        const fbsAll = this.postings.get('fbs') ?? [];
        this.postings.set('rfbs', fbsAll.filter(p => p.delivery_scheme === 'rfbs'));
      } else {
        await this._fetchFbsData(since, to, signal);
        // Сразу обновляем и rfbs-производный массив
        const fbsAll = this.postings.get('fbs') ?? [];
        this.postings.set('rfbs', fbsAll.filter(p => p.delivery_scheme === 'rfbs'));
      }
      this.lastUpdated = new Date();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') { this.loading = false; this.render(); return; }
      this.loading = false;
      this.render();
      const errEl = document.getElementById('ord-content');
      if (errEl) errEl.innerHTML = `
        <div class="oz-empty">
          <div class="oz-empty-title" style="color:#ef4444">
            Ошибка: ${this.esc((err instanceof Error ? err.message : String(err)) ?? String(err))}
          </div>
          <div class="oz-empty-sub">Проверьте Client-ID и API-ключ в настройках магазина</div>
        </div>`;
      return;
    }
    this.loading = false;
    this.render();
  }

  // ── Фильтрация ───────────────────────────────────────────────────────────────

  private getFilteredPostings(): OzonPosting[] {
    let list = this.postings.get(this.activeTab) ?? [];

    if (this.selectedStoreId)
      list = list.filter(p => p.store_id === this.selectedStoreId);

    if (this.filters.status)
      list = list.filter(p => p.status === this.filters.status);

    if (this.filters.dateFrom) {
      const from = new Date(this.filters.dateFrom).getTime();
      list = list.filter(p => new Date(p.created_at).getTime() >= from);
    }

    if (this.filters.dateTo) {
      const to = new Date(this.filters.dateTo).getTime() + 86_400_000;
      list = list.filter(p => new Date(p.created_at).getTime() <= to);
    }

    if (this.filters.search) {
      const q = this.filters.search.toLowerCase();
      list = list.filter(p =>
        p.posting_number.toLowerCase().includes(q) ||
        p.products.some(pr => pr.offer_id.toLowerCase().includes(q) || pr.name.toLowerCase().includes(q))
      );
    }

    return list;
  }

  private hasActiveFilters(): boolean {
    return !!(this.filters.status || this.filters.dateFrom || this.filters.dateTo || this.filters.search);
  }

  // ── Период ───────────────────────────────────────────────────────────────────

  private getPeriodRange(): { since: string; to: string } {
    const now = new Date();
    const to = now.toISOString();
    let days = 30;
    if (this.period === '7') days = 7;
    else if (this.period === '90') days = 90;
    else if (this.period === 'custom') {
      const since = this.filters.dateFrom
        ? new Date(this.filters.dateFrom).toISOString()
        : new Date(now.getTime() - 30 * 86_400_000).toISOString();
      const customTo = this.filters.dateTo
        ? new Date(new Date(this.filters.dateTo).getTime() + 86_400_000).toISOString()
        : to;
      return { since, to: customTo };
    }
    return { since: new Date(now.getTime() - days * 86_400_000).toISOString(), to };
  }

  // ── Экспорт Excel ────────────────────────────────────────────────────────────

  exportExcel(): void {
    const rows = this.getFilteredPostings();
    if (!rows.length) { showToast('Нет данных для экспорта', 'error'); return; }

    const data = rows.map(p => ({
      'Номер отправления': p.posting_number,
      'Схема':             p.delivery_scheme.toUpperCase(),
      'Статус':            statusLabel(p.status),
      'Магазин':           this.stores.find(s => s.id === p.store_id)?.name ?? '',
      'Создан':            fmtDateTime(p.created_at),
      'Срок отгрузки':     fmtDate(p.shipment_date),
      'Артикулы':          p.products.map(pr => pr.offer_id).join(', '),
      'Состав':            p.products.map(pr => `${pr.offer_id} × ${pr.quantity}`).join('; '),
      'Кол-во позиций':    p.products.length,
      'Итого, ₽':          calcTotal(p.products),
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = Object.keys(data[0]).map(k => ({ wch: Math.min(Math.max(k.length + 2, 14), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Заказы');
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `orders_${this.activeTab}_${date}.xlsx`);
  }

  // ── Публичные методы ─────────────────────────────────────────────────────────

  selectTab(scheme: DeliveryScheme): void {
    this.activeTab = scheme;
    this.activeSubTab = 'postings';
    // Данные уже загружены при init — просто переключаем вкладку
    if (this.postings.has(scheme)) {
      this.render();
    } else {
      // Схема ещё не загружалась (ручное переключение до завершения init)
      this.loadTab(scheme);
    }
  }

  selectSubTab(sub: 'postings' | 'returns'): void {
    this.activeSubTab = sub;
    this.render();
  }

  setPeriod(p: string): void {
    if (this.period === p) return;       // тот же период — ничего не делаем
    this.period = p;
    // Сразу прерываем текущую загрузку, чистим данные и показываем спиннер
    this.abortController?.abort();
    this.postings.clear();
    this.returns.clear();
    this.detailsCache.clear();
    this.loading = true;
    this.render();
    this._reloadAll();
  }

  setStoreFilter(storeId: string): void {
    this.selectedStoreId = storeId || null;
    this.render();
  }

  setFilter(key: keyof OrderFilters, value: string): void {
    this.filters[key] = value;
    this.render();
  }

  resetFilters(): void {
    this.filters = { status: '', dateFrom: '', dateTo: '', search: '' };
    this.render();
  }

  refresh(): void {
    this.postings.clear();
    this.returns.clear();
    this.detailsCache.clear();
    this._reloadAll();
  }

  /** Перезагрузить все схемы параллельно (без сброса stores). */
  private async _reloadAll(): Promise<void> {
    if (!this.stores.length) return;
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;
    const { since, to } = this.getPeriodRange();

    debug.log(`[Orders] _reloadAll: период ${since} → ${to}`);

    this.loading = true;
    this.render();

    await Promise.all([
      this._fetchFbsData(since, to, signal).catch((e: Error) => { console.warn('[Orders] FBS:', (e instanceof Error ? e.message : String(e))); }),
      this._fetchFboData(since, to, signal).catch((e: Error) => { console.warn('[Orders] FBO:', (e instanceof Error ? e.message : String(e))); }),
      this._fetchRfbsData(since, to, signal).catch((e: Error) => { console.warn('[Orders] RFBS:', (e instanceof Error ? e.message : String(e))); }),
    ]);

    // Если нас уже сменил новый _reloadAll — выходим без побочных эффектов
    if (this.abortController !== ac) {
      debug.log('[Orders] _reloadAll: цикл устарел, новый цикл активен — выходим');
      return;
    }
    if (signal.aborted) {
      this.loading = false;
      this.render();
      return;
    }

    // Производный RFBS — фильтр из FBS
    const fbsAll = this.postings.get('fbs') ?? [];
    this.postings.set('rfbs', fbsAll.filter(p => p.delivery_scheme === 'rfbs'));

    this.loading = false;
    this.lastUpdated = new Date();
    debug.log('[Orders] _reloadAll: завершено', {
      fbs: this.postings.get('fbs')?.length ?? 0,
      fbo: this.postings.get('fbo')?.length ?? 0,
      rfbs: this.postings.get('rfbs')?.length ?? 0,
    });
    this.render();
  }

  stopLoading(): void {
    this.abortController?.abort();
    this.loading = false;
    this.render();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private storeColor(storeId: string): string {
    const COLORS = ['#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
    const idx = this.stores.findIndex(s => s.id === storeId);
    return COLORS[idx % COLORS.length] ?? '#888';
  }

  private esc(s: string | null | undefined): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * HTML кликабельного артикула с копированием в буфер.
   * Используется в таблице, модалке и других местах.
   */
  private skuChip(offerId: string): string {
    const id = this.esc(offerId);
    if (!id) return '<span class="oz-sku-chip oz-sku-chip-empty">—</span>';
    return `<span class="oz-sku-chip" title="Скопировать артикул"
      onclick="event.stopPropagation();window.ozonOrdersModule.copyArticle('${id}', this)">
      <svg class="oz-sku-chip-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="4" width="8" height="9" rx="1"/>
        <path d="M2 10V2a1 1 0 0 1 1-1h7"/>
      </svg>
      <span class="oz-sku-chip-text">${id}</span>
    </span>`;
  }

  /** Скопировать артикул в буфер обмена, показать визуальный feedback. */
  copyArticle(article: string, el?: HTMLElement): void {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = article;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { debug.warn('[OzonOrdersModule] swallowed error', e); }
      document.body.removeChild(ta);
    };

    const copyPromise = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(article).catch(() => fallback())
      : (fallback(), Promise.resolve());

    copyPromise.then(() => {
      if (el) {
        el.classList.add('oz-sku-chip-copied');
        setTimeout(() => el.classList.remove('oz-sku-chip-copied'), 1200);
      }
      this.showToast(`Артикул скопирован: ${article}`);
    });
  }

  private showToast(msg: string): void {
    showToast(msg, 'success', 1800);
  }

  /** @deprecated kept for backward compat */
  selectStore(_id: string | null): void {}
}
