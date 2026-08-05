import { ozonApi, ozonPerfApi } from '@/services/ozonApi';
import {
  getWbCampaigns,
  createWbAdCampaign,
  updateWbCampaign,
  getWbAdBalance,
  getWbCampaignDetails,
  getWbFullStats,
  updateWbCampaignBids,
  setWbExcludedKeywords,
} from '@/services/wbApi';
import {
  getYandexPromos,
  getYandexPromoOffers,
  removeYandexPromoOffers,
  getYandexCampaignBids,
  updateYandexCampaignBids,
  getYandexRecommendedBids,
} from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'wb' | 'ozon' | 'yandex';
type OzonSubTab = 'perf' | 'promo';
type YmSubTab   = 'promo' | 'boost';
type WbDetail   = 'bids' | 'keywords';

interface Campaign {
  id: string | number;
  name: string;
  status: string;
  type: string;
  typeCode?: number;
  budget: number;
  spent: number;
  clicks: number;
  views: number;
  orders: number;
  revenue: number;
  roi: number;
  actionId?: number;
  promoId?: string;
  dateFrom?: string;
  dateTo?: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function fmt(n: number): string { return n.toLocaleString('ru-RU'); }

function ctr(views: number, clicks: number): string {
  return views > 0 ? (clicks / views * 100).toFixed(2) + '%' : '—';
}

function roiStr(roi: number): string {
  return (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
}

function statusChip(s: string): string {
  const map: Record<string, [string, string, string]> = {
    active:   ['Активна',     '#22c55e', 'rgba(34,197,94,.12)'],
    paused:   ['Пауза',       '#f59e0b', 'rgba(245,158,11,.12)'],
    stopped:  ['Остановлена', '#ef4444', 'rgba(239,68,68,.12)'],
    inactive: ['Неактивна',   '#71717a', 'var(--bg3)'],
    upcoming: ['Скоро',       '#818cf8', 'rgba(129,140,248,.12)'],
  };
  const [label, color, bg] = map[s] ?? [s, '#71717a', 'var(--bg3)'];
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;background:${bg};color:${color};white-space:nowrap">
    <span style="width:5px;height:5px;border-radius:50%;background:${color};flex-shrink:0"></span>${esc(label)}
  </span>`;
}

function skeleton(rows = 5): string {
  const row = `<div style="height:38px;border-radius:6px;background:var(--bg3);animation:ad-pulse 1.5s ease-in-out infinite"></div>`;
  return `<div style="padding:16px;display:flex;flex-direction:column;gap:6px">${Array(rows).fill(row).join('')}</div>`;
}

function emptyState(msg: string, hint = ''): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:180px;gap:8px;color:var(--text2)">
    <div style="font-size:28px;opacity:.2">${I.chartBar()}</div>
    <p style="margin:0;font-size:13px;font-weight:600;color:var(--text2)">${msg}</p>
    ${hint ? `<p style="margin:0;font-size:12px;opacity:.6">${hint}</p>` : ''}
  </div>`;
}

// ── Module ────────────────────────────────────────────────────────────────────

export class AdvertisingModule {
  private el: HTMLElement;

  // MP selection
  private tab: Tab = 'wb';
  private ozonSubTab: OzonSubTab = 'perf';
  private ymSubTab: YmSubTab = 'promo';

  // Store
  private storeId = '';
  private stores: Array<{ id: string; name: string; [k: string]: any }> = [];

  // Data
  private campaigns: Campaign[] = [];
  private loading = false;
  private adBalance: number | null = null;

  // Date range (WB only)
  private dateFrom: string;
  private dateTo: string;

  // Expanded rows state
  private expanded = new Set<string | number>();
  private wbDetailTab = new Map<string | number, WbDetail>(); // per-campaign
  private detailLoading = new Set<string | number>();
  private detailCache   = new Map<string | number, any>();    // bids/kw/offers

  // Inline budget editing (WB)
  private budgetEditing = new Set<string | number>();

  // YM Boost tab state
  private ymBids: any[] = [];
  private ymRecommended: any[] = [];
  private ymBidsLoading = false;
  private ymBidEdits = new Map<string, string>(); // offerId → new bid string

  // Event cleanup
  private eventsAC = new AbortController();

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden';
    const now = new Date();
    this.dateTo   = now.toISOString().slice(0, 10);
    this.dateFrom = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    this.injectStyles();
    this.buildShell();
    this.loadStores();
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private injectStyles(): void {
    if (document.getElementById('ad-module-styles')) return;
    const s = document.createElement('style');
    s.id = 'ad-module-styles';
    s.textContent = `
      @keyframes ad-pulse { 0%,100%{opacity:.4} 50%{opacity:.9} }

      .ad-wrap { display:flex;flex-direction:column;height:100%;background:var(--bg2);font-family:inherit }

      /* Header */
      .ad-header {
        display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;
        padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);
        gap:10px;flex-shrink:0;min-height:52px
      }
      .ad-header-left  { display:flex;align-items:center;gap:10px;flex-wrap:wrap }
      .ad-header-right { display:flex;align-items:center;gap:8px;flex-wrap:wrap }
      .ad-logo-icon {
        width:30px;height:30px;border-radius:8px;flex-shrink:0;
        background:linear-gradient(135deg,#6366f1,#8b5cf6);
        display:flex;align-items:center;justify-content:center;color:#fff
      }
      .ad-title { font-size:15px;font-weight:800;color:var(--text);letter-spacing:-.3px }

      /* MP tabs */
      .ad-mp-tabs { display:flex;gap:2px }
      .ad-mp-tab {
        padding:5px 14px;border-radius:8px;border:none;cursor:pointer;font-size:12px;
        font-weight:700;font-family:inherit;transition:all .15s;
        background:transparent;color:var(--text2)
      }
      .ad-mp-tab:hover { background:var(--bg2);color:var(--text) }
      .ad-mp-tab.active-wb     { background:rgba(124,58,237,.15);color:#a78bfa }
      .ad-mp-tab.active-ozon   { background:rgba(0,91,255,.12);color:#60a5fa }
      .ad-mp-tab.active-yandex { background:rgba(252,63,29,.1);color:#f87171 }

      /* Sub-controls bar */
      .ad-sub {
        display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;
        padding:8px 20px;background:var(--bg);border-bottom:1px solid var(--border);
        gap:8px;flex-shrink:0
      }
      .ad-sub-left  { display:flex;align-items:center;gap:8px;flex-wrap:wrap }
      .ad-sub-right { display:flex;align-items:center;gap:8px;flex-wrap:wrap }

      /* Balance chip */
      .ad-balance {
        display:inline-flex;align-items:center;gap:6px;
        padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;
        background:rgba(34,197,94,.12);color:#22c55e;cursor:default
      }

      /* Sub-tabs (Ozon: Performance/Акции, YM: Акции/Буст) */
      .ad-subtabs { display:flex;gap:2px }
      .ad-subtab {
        padding:4px 14px;border-radius:8px;border:none;cursor:pointer;
        font-size:12px;font-weight:600;font-family:inherit;
        background:transparent;color:var(--text2);transition:all .15s
      }
      .ad-subtab:hover { background:var(--bg2);color:var(--text) }
      .ad-subtab.active { background:var(--bg2);color:var(--text);font-weight:700 }

      /* Period inputs */
      .ad-period { display:flex;align-items:center;gap:4px }
      .ad-period input {
        padding:4px 8px;background:var(--bg3);border:1px solid var(--border);
        border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none
      }
      .ad-period span { font-size:12px;color:var(--text3) }

      /* Stats tiles */
      .ad-stats {
        display:flex;gap:8px;padding:12px 20px;flex-wrap:nowrap;overflow-x:auto;
        border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)
      }
      .ad-stat {
        flex:1;min-width:100px;background:var(--bg2);border:1px solid var(--border);
        border-radius:10px;padding:10px 14px;
      }
      .ad-stat-label {
        font-size:10px;text-transform:uppercase;letter-spacing:.5px;
        color:var(--text3);margin-bottom:3px;white-space:nowrap
      }
      .ad-stat-value {
        font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;
        white-space:nowrap;line-height:1.2
      }

      /* Body / scroll area */
      .ad-body { flex:1;min-height:0;overflow:auto }

      /* Campaign table */
      .ad-table { width:100%;border-collapse:collapse;font-size:12px }
      .ad-table thead { position:sticky;top:0;z-index:3;background:var(--bg) }
      .ad-table thead th {
        padding:9px 14px;text-align:left;font-size:10px;font-weight:700;
        color:var(--text3);text-transform:uppercase;letter-spacing:.5px;
        border-bottom:1px solid var(--border);white-space:nowrap
      }
      .ad-table thead th.r { text-align:right }
      .ad-table tbody tr.ad-row { border-bottom:1px solid var(--border);transition:background .08s }
      .ad-table tbody tr.ad-row:hover { background:var(--bg2) }
      .ad-table tbody tr.ad-row.expanded-row { background:var(--bg2) }
      .ad-table td { padding:10px 14px;color:var(--text);vertical-align:middle }
      .ad-table td.r { text-align:right;font-variant-numeric:tabular-nums }
      .ad-table td.dim { color:var(--text2) }

      /* Expanded detail row */
      .ad-detail-row td {
        padding:0;background:var(--bg2);border-bottom:2px solid var(--border)
      }
      .ad-detail-inner {
        padding:14px 20px 16px;border-top:1px solid var(--border)
      }

      /* Detail sub-tabs (Ставки / Ключевые слова) */
      .ad-detail-tabs { display:flex;gap:2px;margin-bottom:12px }
      .ad-detail-tab {
        padding:4px 12px;border-radius:6px;border:none;cursor:pointer;
        font-size:11px;font-weight:600;font-family:inherit;
        background:var(--bg3);color:var(--text2);transition:all .15s
      }
      .ad-detail-tab.active { background:var(--accent);color:#000 }

      /* Bid table inside expanded row */
      .ad-bid-table { width:100%;border-collapse:collapse;font-size:12px }
      .ad-bid-table th {
        padding:6px 10px;text-align:left;font-size:10px;font-weight:700;
        color:var(--text3);text-transform:uppercase;letter-spacing:.4px;
        border-bottom:1px solid var(--border);background:var(--bg)
      }
      .ad-bid-table th.r { text-align:right }
      .ad-bid-table td { padding:7px 10px;border-bottom:1px solid var(--border);color:var(--text) }
      .ad-bid-table tr:last-child td { border-bottom:none }
      .ad-bid-table tr:hover td { background:var(--bg3) }

      /* Budget inline edit */
      .ad-budget-cell { display:flex;align-items:center;gap:6px }
      .ad-budget-val  { font-variant-numeric:tabular-nums }
      .ad-budget-pen  {
        opacity:0;transition:opacity .15s;cursor:pointer;color:var(--text3);
        display:flex;align-items:center
      }
      .ad-table tbody tr:hover .ad-budget-pen { opacity:1 }
      .ad-budget-inp {
        width:80px;padding:3px 7px;background:var(--bg);border:1px solid var(--accent);
        border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none
      }
      .ad-budget-acts { display:flex;gap:4px }
      .ad-budget-ok, .ad-budget-x {
        padding:2px 6px;border-radius:5px;border:none;cursor:pointer;
        font-size:11px;font-weight:700;font-family:inherit
      }
      .ad-budget-ok { background:var(--accent);color:#000 }
      .ad-budget-x  { background:var(--bg3);color:var(--text2) }

      /* Expand chevron */
      .ad-expand-btn {
        padding:3px 6px;border-radius:5px;border:none;cursor:pointer;
        background:transparent;color:var(--text3);transition:all .15s;
        display:flex;align-items:center
      }
      .ad-expand-btn:hover { background:var(--bg3);color:var(--text) }
      .ad-expand-btn.open { color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent) }
      .ad-expand-chevron { transition:transform .2s }
      .ad-expand-btn.open .ad-expand-chevron { transform:rotate(180deg) }

      /* Minus-words editor */
      .ad-minus-area {
        width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);
        border-radius:8px;color:var(--text);font-size:12px;font-family:inherit;
        outline:none;resize:vertical;min-height:70px
      }
      .ad-minus-area:focus { border-color:var(--accent) }

      /* Nginx setup guide */
      .ad-nginx-guide {
        margin:16px;padding:18px;background:var(--bg);border:1px solid var(--border);
        border-radius:12px
      }
      .ad-nginx-guide pre {
        background:var(--bg3);border:1px solid var(--border);border-radius:8px;
        padding:12px;font-size:11px;overflow-x:auto;color:var(--text2);margin:8px 0 0
      }

      /* Boost bids table */
      .ad-boost-input {
        width:80px;padding:4px 7px;background:var(--bg);border:1px solid var(--border);
        border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none
      }
      .ad-boost-input:focus { border-color:var(--accent) }
      .ad-boost-input.changed { border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--bg)) }

      /* Select */
      .ad-select {
        padding:5px 10px;background:var(--bg3);border:1px solid var(--border);
        border-radius:8px;color:var(--text);font-size:12px;font-family:inherit;outline:none;
        min-width:160px;height:30px
      }
    `;
    document.head.appendChild(s);
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  private buildShell(): void {
    this.el.innerHTML = `
      <div class="ad-wrap">
        <div class="ad-header">
          <div class="ad-header-left">
            <div class="ad-logo-icon">${I.zap()}</div>
            <span class="ad-title">Реклама</span>
            <div class="ad-mp-tabs">
              ${(['wb','ozon','yandex'] as Tab[]).map(t => `
                <button class="ad-mp-tab ${this.tab === t ? 'active-'+t : ''}" data-mp="${t}">
                  ${t === 'wb' ? 'Wildberries' : t === 'ozon' ? 'Ozon' : 'Яндекс.Маркет'}
                </button>`).join('')}
            </div>
          </div>
          <div class="ad-header-right">
            <select class="ad-select" id="ad-store">
              <option value="">Загрузка...</option>
            </select>
            <button class="rpr-btn rpr-btn-ghost" id="ad-refresh" style="display:flex;align-items:center;gap:5px">
              ${I.refresh()} Загрузить
            </button>
          </div>
        </div>

        <div id="ad-sub"></div>
        <div id="ad-stats"></div>
        <div class="ad-body" id="ad-body">${skeleton()}</div>
      </div>`;

    this.bindAll();
    this.renderSub();
  }

  // ── Sub-controls ───────────────────────────────────────────────────────────

  private renderSub(): void {
    const el = this.el.querySelector('#ad-sub') as HTMLElement;
    if (!el) return;

    if (this.tab === 'wb') {
      const balHtml = this.adBalance !== null
        ? `<span class="ad-balance">${I.wallet()} Кабинет: ${fmt(this.adBalance)} ₽</span>`
        : '';
      el.innerHTML = `
        <div class="ad-sub">
          <div class="ad-sub-left">
            ${balHtml}
            <div class="ad-period">
              <input type="date" id="ad-from" value="${this.dateFrom}">
              <span>—</span>
              <input type="date" id="ad-to" value="${this.dateTo}">
            </div>
          </div>
          <div class="ad-sub-right">
            <button class="rpr-btn rpr-btn-green" id="ad-create" style="display:flex;align-items:center;gap:5px">
              ${I.plus()} Кампания
            </button>
          </div>
        </div>`;
    } else if (this.tab === 'ozon') {
      el.innerHTML = `
        <div class="ad-sub">
          <div class="ad-sub-left">
            <div class="ad-subtabs">
              <button class="ad-subtab ${this.ozonSubTab==='perf'?'active':''}" data-osub="perf">Performance</button>
              <button class="ad-subtab ${this.ozonSubTab==='promo'?'active':''}" data-osub="promo">Акции Ozon</button>
            </div>
          </div>
        </div>`;
    } else {
      el.innerHTML = `
        <div class="ad-sub">
          <div class="ad-sub-left">
            <div class="ad-subtabs">
              <button class="ad-subtab ${this.ymSubTab==='promo'?'active':''}" data-ymsub="promo">Акции</button>
              <button class="ad-subtab ${this.ymSubTab==='boost'?'active':''}" data-ymsub="boost">Буст-продвижение</button>
            </div>
          </div>
          ${this.ymSubTab === 'boost' && this.storeId ? `
            <div class="ad-sub-right">
              <button class="rpr-btn rpr-btn-ghost" id="ym-load-bids" style="display:flex;align-items:center;gap:5px">
                ${I.refresh()} Загрузить ставки
              </button>
            </div>` : ''}
        </div>`;
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private bindAll(): void {
    this.eventsAC.abort();
    this.eventsAC = new AbortController();
    const { signal } = this.eventsAC;

    this.el.addEventListener('click', async (e) => {
      const tgt = e.target as HTMLElement;
      const btn = tgt.closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      // ── MP tab ──
      const mp = btn.dataset.mp as Tab | undefined;
      if (mp && mp !== this.tab) {
        this.tab = mp;
        this.campaigns = [];
        this.storeId = '';
        this.expanded.clear();
        this.detailCache.clear();
        this.ymBids = [];
        this.ymRecommended = [];
        this.buildShell();
        this.loadStores();
        return;
      }

      // ── Ozon sub-tab ──
      const osub = btn.dataset.osub as OzonSubTab | undefined;
      if (osub && osub !== this.ozonSubTab) {
        this.ozonSubTab = osub;
        this.campaigns = [];
        this.expanded.clear();
        this.detailCache.clear();
        this.renderSub();
        this.flushBody();
        return;
      }

      // ── YM sub-tab ──
      const ymsub = btn.dataset.ymsub as YmSubTab | undefined;
      if (ymsub && ymsub !== this.ymSubTab) {
        this.ymSubTab = ymsub;
        this.campaigns = [];
        this.expanded.clear();
        this.ymBids = [];
        this.renderSub();
        this.flushBody();
        return;
      }

      // ── Global actions ──
      if (btn.id === 'ad-refresh')   { await this.loadCampaigns(); return; }
      if (btn.id === 'ad-create')    { this.showCreateDialog(); return; }
      if (btn.id === 'ym-load-bids') { await this.loadYmBids(); return; }

      // ── WB: budget inline edit ──
      if (btn.dataset.action === 'edit-budget') {
        this.budgetEditing.add(btn.dataset.id!);
        this.flushBody();
        setTimeout(() => (this.el.querySelector(`#ad-b-inp-${btn.dataset.id}`) as HTMLInputElement)?.focus(), 0);
        return;
      }
      if (btn.dataset.action === 'cancel-budget') {
        this.budgetEditing.delete(btn.dataset.id!);
        this.flushBody();
        return;
      }
      if (btn.dataset.action === 'save-budget') {
        const id = btn.dataset.id!;
        const inp = this.el.querySelector(`#ad-b-inp-${id}`) as HTMLInputElement | null;
        if (inp) await this.saveBudget(Number(id), Number(inp.value));
        return;
      }

      // ── WB: pause/resume ──
      if (btn.dataset.action === 'pause')  { await this.toggleWbCampaign(Number(btn.dataset.id), 11); return; }
      if (btn.dataset.action === 'resume') { await this.toggleWbCampaign(Number(btn.dataset.id), 9);  return; }

      // ── WB: expand row ──
      if (btn.dataset.action === 'expand') {
        const id = btn.dataset.id!;
        if (this.expanded.has(id)) { this.expanded.delete(id); } else { this.expanded.add(id); }
        this.flushBody();
        if (this.expanded.has(id)) this.loadDetail(id);
        return;
      }

      // ── WB detail: sub-tab switch ──
      if (btn.dataset.action === 'detail-tab') {
        const id = btn.dataset.id!;
        this.wbDetailTab.set(id, btn.dataset.tab as WbDetail);
        this.flushBody();
        return;
      }

      // ── WB: save bids ──
      if (btn.dataset.action === 'save-bids') {
        await this.saveBids(btn.dataset.id!);
        return;
      }

      // ── WB: save minus-words ──
      if (btn.dataset.action === 'save-excluded') {
        const id = btn.dataset.id!;
        const ta = this.el.querySelector(`#ad-excl-${id}`) as HTMLTextAreaElement | null;
        if (!ta) return;
        const words = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
        try {
          const store = this.stores.find(s => s.id === this.storeId) as any;
          await setWbExcludedKeywords(store.api_key, Number(id), words);
          showToast('Минус-слова сохранены', 'success');
        } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
        return;
      }

      // ── Ozon: expand promo row ──
      if (btn.dataset.action === 'expand-promo') {
        const id = btn.dataset.id!;
        if (this.expanded.has(id)) { this.expanded.delete(id); } else { this.expanded.add(id); }
        this.flushBody();
        if (this.expanded.has(id)) this.loadOzonPromoProducts(id, Number(btn.dataset.actionid));
        return;
      }

      // ── Ozon: remove promo product ──
      if (btn.dataset.action === 'rm-promo-product') {
        await this.removeOzonPromoProduct(
          btn.dataset.promoid!,
          Number(btn.dataset.actionid),
          Number(btn.dataset.productid),
        );
        return;
      }

      // ── Ozon Perf: expand ──
      if (btn.dataset.action === 'expand-perf') {
        const id = btn.dataset.id!;
        if (this.expanded.has(id)) { this.expanded.delete(id); } else { this.expanded.add(id); }
        this.flushBody();
        if (this.expanded.has(id)) this.loadOzonPerfObjects(id);
        return;
      }

      // ── Ozon Perf: toggle ──
      if (btn.dataset.action === 'toggle-perf') {
        await this.toggleOzonPerfCampaign(btn.dataset.id!, btn.dataset.status === 'active');
        return;
      }

      // ── YM: expand promo ──
      if (btn.dataset.action === 'expand-ym-promo') {
        const id = btn.dataset.id!;
        if (this.expanded.has(id)) { this.expanded.delete(id); } else { this.expanded.add(id); }
        this.flushBody();
        if (this.expanded.has(id)) this.loadYmPromoOffers(id, btn.dataset.promoid!);
        return;
      }

      // ── YM: remove promo offer ──
      if (btn.dataset.action === 'rm-ym-offer') {
        await this.removeYmPromoOffer(btn.dataset.promoid!, btn.dataset.offerid!);
        return;
      }

      // ── YM: save boost bids ──
      if (btn.id === 'ym-save-bids') {
        await this.saveYmBids();
        return;
      }
    }, { signal });

    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement | HTMLInputElement;
      if (t.id === 'ad-store') {
        this.storeId = t.value;
        this.campaigns = [];
        this.expanded.clear();
        this.detailCache.clear();
        this.ymBids = [];
        this.flushBody();
        if (this.tab === 'wb' && this.storeId) this.loadBalance();
      }
      if (t.id === 'ad-from') this.dateFrom = t.value;
      if (t.id === 'ad-to')   this.dateTo   = t.value;
    }, { signal });

    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.boostid) {
        const cur = this.ymBids.find(b => (b.offerId ?? b.offer_id) === t.dataset.boostid);
        const curVal = cur?.bid ?? 0;
        t.classList.toggle('changed', t.value !== '' && Number(t.value) !== curVal);
        this.ymBidEdits.set(t.dataset.boostid, t.value);
      }
    }, { signal });

    // Budget input: Enter to save, Escape to cancel
    this.el.addEventListener('keydown', async (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.id?.startsWith('ad-b-inp-')) return;
      const id = t.id.replace('ad-b-inp-', '');
      if (e.key === 'Enter')  { e.preventDefault(); await this.saveBudget(Number(id), Number(t.value)); }
      if (e.key === 'Escape') { this.budgetEditing.delete(id); this.flushBody(); }
    }, { signal });
  }

  // ── Flush helpers ──────────────────────────────────────────────────────────

  private flushBody(): void {
    const body = this.el.querySelector('#ad-body');
    if (body) body.innerHTML = this.renderBody();
    this.renderStats();
  }

  private renderStats(): void {
    const el = this.el.querySelector('#ad-stats') as HTMLElement | null;
    if (!el) return;
    if (!this.campaigns.length) { el.innerHTML = ''; return; }
    const budget  = this.campaigns.reduce((s, c) => s + c.budget,  0);
    const spent   = this.campaigns.reduce((s, c) => s + c.spent,   0);
    const revenue = this.campaigns.reduce((s, c) => s + c.revenue, 0);
    const orders  = this.campaigns.reduce((s, c) => s + c.orders,  0);
    const views   = this.campaigns.reduce((s, c) => s + c.views,   0);
    const clicks  = this.campaigns.reduce((s, c) => s + c.clicks,  0);
    const roi     = spent > 0 ? (revenue - spent) / spent * 100 : 0;
    const tiles = this.tab === 'wb'
      ? [
          ['Бюджет/д',  fmt(budget)  + ' ₽', '#818cf8'],
          ['Потрачено', fmt(spent)   + ' ₽', '#f59e0b'],
          ['Выручка',   fmt(revenue) + ' ₽', '#22c55e'],
          ['Заказы',    String(orders),       '#3b82f6'],
          ['CTR',       ctr(views, clicks),   '#a78bfa'],
          ['ROI',       roiStr(roi),          roi >= 0 ? '#22c55e' : '#ef4444'],
        ]
      : [
          ['Кампаний',  String(this.campaigns.length), '#818cf8'],
          ['Активных',  String(this.campaigns.filter(c => c.status === 'active').length), '#22c55e'],
          ['Показы',    fmt(views),  '#3b82f6'],
          ['Клики',     fmt(clicks), '#a78bfa'],
          ['Потрачено', fmt(spent) + ' ₽', '#f59e0b'],
          ['CTR',       ctr(views, clicks), '#6366f1'],
        ];
    el.innerHTML = `<div class="ad-stats">${
      tiles.map(([label, val, color]) => `
        <div class="ad-stat">
          <div class="ad-stat-label">${label}</div>
          <div class="ad-stat-value" style="color:${color}">${val}</div>
        </div>`).join('')
    }</div>`;
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private async loadStores(): Promise<void> {
    const sel = this.el.querySelector('#ad-store') as HTMLSelectElement | null;
    if (!sel) return;
    try {
      if (this.tab === 'wb')      this.stores = await wbDb.getStores();
      else if (this.tab === 'ozon') this.stores = await ozonDb.getStores();
      else                          this.stores = await yandexDb.getStores();
    } catch { this.stores = []; }

    if (!this.stores.length) {
      sel.innerHTML = '<option value="">Нет магазинов</option>';
      this.storeId = '';
      this.flushBody();
      return;
    }
    sel.innerHTML = '<option value="">— Магазин —</option>' +
      this.stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if (this.stores.length === 1) {
      this.storeId = this.stores[0].id;
      sel.value = this.storeId;
      if (this.tab === 'wb') await this.loadBalance();
    }
    this.flushBody();
  }

  private async loadBalance(): Promise<void> {
    if (this.tab !== 'wb') return;
    const store = this.stores.find(s => s.id === this.storeId) as any;
    if (!store) return;
    this.adBalance = await getWbAdBalance(store.api_key);
    this.renderSub();
  }

  private async loadCampaigns(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    this.loading = true;
    this.campaigns = [];
    this.expanded.clear();
    this.flushBody();

    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;

      if (this.tab === 'wb') {
        await this._loadWbCampaigns(store);
      } else if (this.tab === 'ozon') {
        if (this.ozonSubTab === 'perf') await this._loadOzonPerfCampaigns(store);
        else await this._loadOzonPromos(store);
      } else {
        await this._loadYmPromos(store);
      }

      showToast(`Загружено: ${this.campaigns.length}`, 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.flushBody();
    }
  }

  private async _loadWbCampaigns(store: any): Promise<void> {
    const list = await getWbCampaigns(store.api_key);
    const campaignIds = list.map((c: any) => ({
      id: c.advertId,
      interval: { begin: this.dateFrom, end: this.dateTo },
    }));

    let fullStats: any[] = [];
    if (campaignIds.length) {
      fullStats = await getWbFullStats(store.api_key, campaignIds);
    }

    const statMap = new Map<number, any>();
    for (const row of fullStats) {
      statMap.set(row.advertId ?? row.id, row);
    }

    for (const c of list) {
      const st = statMap.get(c.advertId) ?? {};
      const views  = st.views  ?? st.shows ?? 0;
      const clicks = st.clicks ?? 0;
      const spent  = st.sum    ?? 0;
      const orders = st.orders ?? 0;
      const revenue = orders * (st.avgPrice ?? 0);
      this.campaigns.push({
        id: c.advertId,
        name: c.name ?? `Кампания ${c.advertId}`,
        status: c.status === 9 ? 'active' : c.status === 11 ? 'paused' : 'stopped',
        type: c.type === 8 ? 'Авто' : c.type === 6 ? 'Поиск' : c.type === 7 ? 'Каталог' : 'Карточка',
        typeCode: c.type,
        budget: c.dailyBudget ?? 0,
        spent,
        clicks,
        views,
        orders,
        revenue,
        roi: spent > 0 ? (revenue - spent) / spent * 100 : 0,
      });
    }
  }

  private async _loadOzonPerfCampaigns(store: any): Promise<void> {
    const list = await ozonPerfApi.getCampaigns(store.client_id, store.api_key);
    const ids = list.map((c: any) => String(c.id));
    const stats = ids.length
      ? await ozonPerfApi.getStats(store.client_id, store.api_key, {
          campaigns: ids,
          dateFrom: this.dateFrom,
          dateTo: this.dateTo,
        })
      : [];
    const statMap = new Map<string, any>();
    for (const s of stats) statMap.set(String(s.campaign?.id ?? s.id), s);

    for (const c of list) {
      const st = statMap.get(String(c.id)) ?? {};
      const spent  = st.moneySpent ?? st.money_spent ?? 0;
      const views  = st.views      ?? st.impressions ?? 0;
      const clicks = st.clicks     ?? 0;
      this.campaigns.push({
        id: String(c.id),
        name: c.title ?? c.name ?? `Кампания ${c.id}`,
        status: c.state === 'RUNNING' || c.state === 'ACTIVE' ? 'active' : c.state === 'STOPPED' ? 'paused' : 'inactive',
        type: c.advObjectType ?? c.type ?? 'SKU',
        budget: c.dailyBudget ?? c.budget ?? 0,
        spent,
        clicks,
        views,
        orders: st.orders ?? 0,
        revenue: 0,
        roi: 0,
      });
    }
  }

  private async _loadOzonPromos(store: any): Promise<void> {
    const list = await ozonApi.getPromotions({ client_id: store.client_id, api_key: store.api_key });
    for (const p of list) {
      this.campaigns.push({
        id: String(p.action_id ?? p.id),
        name: p.title ?? p.name ?? 'Акция Ozon',
        status: p.is_active ? 'active' : 'inactive',
        type: p.action_type ?? 'Промо',
        budget: 0, spent: 0, clicks: 0, views: 0, orders: 0, revenue: 0, roi: 0,
        actionId: p.action_id ?? p.id,
        dateFrom: p.date_start,
        dateTo: p.date_end,
      });
    }
  }

  private async _loadYmPromos(store: any): Promise<void> {
    const businessId = store.business_id ? Number(store.business_id) : 0;
    const list = await getYandexPromos(store, businessId);
    for (const p of list) {
      this.campaigns.push({
        id: p.id,
        name: p.name ?? 'Акция',
        status: p.status === 'ACTIVE' ? 'active' : p.status === 'UPCOMING' ? 'upcoming' : 'inactive',
        type: p.promoType ?? 'PROMO',
        budget: 0, spent: 0, clicks: 0, views: 0, orders: 0, revenue: 0, roi: 0,
        promoId: p.id,
        dateFrom: p.startDate,
        dateTo: p.endDate,
      });
    }
  }

  // ── WB detail (bids + keywords) ────────────────────────────────────────────

  private async loadDetail(campaignId: string | number): Promise<void> {
    if (this.detailCache.has(campaignId) || this.detailLoading.has(campaignId)) return;
    this.detailLoading.add(campaignId);
    this.flushBody();
    const store = this.stores.find(s => s.id === this.storeId) as any;
    const details = await getWbCampaignDetails(store.api_key, Number(campaignId));
    this.detailCache.set(campaignId, details ?? {});
    this.detailLoading.delete(campaignId);
    this.flushBody();
  }

  private async saveBids(campaignId: string | number): Promise<void> {
    const nmList: Array<{ nm: number; bid: number }> = [];

    const rows = this.el.querySelectorAll<HTMLInputElement>(`[data-bidsave="${campaignId}"]`);
    rows.forEach(inp => {
      const val = Number(inp.value);
      if (!isNaN(val) && val > 0) nmList.push({ nm: Number(inp.dataset.nm), bid: val });
    });

    if (!nmList.length) { showToast('Нет изменений', 'warning'); return; }
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await updateWbCampaignBids(store.api_key, Number(campaignId), nmList);
      showToast(`Ставки обновлены (${nmList.length})`, 'success');
      this.detailCache.delete(campaignId);
      await this.loadDetail(campaignId);
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private async saveBudget(campaignId: number, budget: number): Promise<void> {
    if (!budget || budget < 50) { showToast('Минимальный бюджет 50 ₽', 'warning'); return; }
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await updateWbCampaign(store.api_key, campaignId, { dailyBudget: budget * 100 });
      const camp = this.campaigns.find(c => c.id === campaignId);
      if (camp) camp.budget = budget;
      this.budgetEditing.delete(String(campaignId));
      showToast('Бюджет обновлён', 'success');
      this.flushBody();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private async toggleWbCampaign(advertId: number, status: 9 | 11): Promise<void> {
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await updateWbCampaign(store.api_key, advertId, { status });
      const camp = this.campaigns.find(c => c.id === advertId);
      if (camp) camp.status = status === 9 ? 'active' : 'paused';
      this.flushBody();
      showToast(status === 11 ? 'Кампания на паузе' : 'Кампания запущена', 'success');
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  // ── Ozon Performance objects ───────────────────────────────────────────────

  private async loadOzonPerfObjects(campaignId: string): Promise<void> {
    if (this.detailCache.has(campaignId) || this.detailLoading.has(campaignId)) return;
    this.detailLoading.add(campaignId);
    this.flushBody();
    const store = this.stores.find(s => s.id === this.storeId) as any;
    const objects = await ozonPerfApi.getCampaignObjects(store.client_id, store.api_key, campaignId);
    this.detailCache.set(campaignId, objects);
    this.detailLoading.delete(campaignId);
    this.flushBody();
  }

  private async toggleOzonPerfCampaign(campaignId: string, isActive: boolean): Promise<void> {
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await ozonPerfApi.toggleCampaign(store.client_id, store.api_key, campaignId, !isActive);
      const camp = this.campaigns.find(c => c.id === campaignId);
      if (camp) camp.status = isActive ? 'paused' : 'active';
      this.flushBody();
      showToast(isActive ? 'Кампания приостановлена' : 'Кампания запущена', 'success');
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  // ── Ozon Promo product management ─────────────────────────────────────────

  private async loadOzonPromoProducts(promoKey: string, actionId: number): Promise<void> {
    if (this.detailCache.has(promoKey) || this.detailLoading.has(promoKey)) return;
    this.detailLoading.add(promoKey);
    this.flushBody();
    const store = this.stores.find(s => s.id === this.storeId) as any;
    const data = await ozonApi.getPromoProducts({ client_id: store.client_id, api_key: store.api_key }, actionId);
    this.detailCache.set(promoKey, data);
    this.detailLoading.delete(promoKey);
    this.flushBody();
  }

  private async removeOzonPromoProduct(promoKey: string, actionId: number, productId: number): Promise<void> {
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await ozonApi.deactivatePromoProducts({ client_id: store.client_id, api_key: store.api_key }, actionId, [productId]);
      const data = this.detailCache.get(promoKey);
      if (data) data.activated = data.activated.filter((p: any) => p.id !== productId);
      this.flushBody();
      showToast('Товар убран из акции', 'success');
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  // ── YM Promo offer management ──────────────────────────────────────────────

  private async loadYmPromoOffers(key: string, promoId: string): Promise<void> {
    if (this.detailCache.has(key) || this.detailLoading.has(key)) return;
    this.detailLoading.add(key);
    this.flushBody();
    const store = this.stores.find(s => s.id === this.storeId) as any;
    const businessId = Number(store.business_id ?? 0);
    const offers = await getYandexPromoOffers(store.api_key, businessId, promoId);
    this.detailCache.set(key, offers);
    this.detailLoading.delete(key);
    this.flushBody();
  }

  private async removeYmPromoOffer(promoId: string, offerId: string): Promise<void> {
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      const businessId = Number(store.business_id ?? 0);
      await removeYandexPromoOffers(store.api_key, businessId, promoId, [offerId]);
      // Remove from cache
      for (const [k, v] of this.detailCache) {
        if (Array.isArray(v)) {
          this.detailCache.set(k, v.filter((o: any) => (o.offerId ?? o.offer_id) !== offerId));
        }
      }
      this.flushBody();
      showToast('Оффер убран из акции', 'success');
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  // ── YM Boost bids ──────────────────────────────────────────────────────────

  private async loadYmBids(): Promise<void> {
    const store = this.stores.find(s => s.id === this.storeId) as any;
    if (!store?.campaign_id) { showToast('Нет campaign_id в настройках магазина', 'warning'); return; }
    this.ymBidsLoading = true;
    this.flushBody();
    const [bids, rec] = await Promise.all([
      getYandexCampaignBids(store.api_key, Number(store.campaign_id)),
      getYandexRecommendedBids(store.api_key, Number(store.campaign_id)),
    ]);
    this.ymBids = bids;
    this.ymRecommended = rec;
    this.ymBidsLoading = false;
    this.flushBody();
  }

  private async saveYmBids(): Promise<void> {
    const store = this.stores.find(s => s.id === this.storeId) as any;
    if (!store?.campaign_id) return;
    const bids: Array<{ offerId: string; bid: number }> = [];
    this.ymBidEdits.forEach((val, offerId) => {
      const n = Number(val);
      if (!isNaN(n) && n > 0) bids.push({ offerId, bid: n });
    });
    if (!bids.length) { showToast('Нет изменений', 'warning'); return; }
    try {
      await updateYandexCampaignBids(store.api_key, Number(store.campaign_id), bids);
      this.ymBidEdits.clear();
      showToast(`Ставки сохранены (${bids.length})`, 'success');
      await this.loadYmBids();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private renderBody(): string {
    if (this.loading) return skeleton(6);
    if (!this.storeId) return emptyState('Выберите магазин', 'для загрузки данных рекламы');

    if (this.tab === 'wb')      return this.renderWbTable();
    if (this.tab === 'ozon')    return this.ozonSubTab === 'perf' ? this.renderOzonPerfTable() : this.renderOzonPromoTable();
    if (this.tab === 'yandex')  return this.ymSubTab === 'boost' ? this.renderYmBoostTable() : this.renderYmPromoTable();
    return '';
  }

  // ── WB table ───────────────────────────────────────────────────────────────

  private renderWbTable(): string {
    if (!this.campaigns.length)
      return emptyState('Нет кампаний', 'Нажмите «Загрузить» или создайте первую кампанию');

    const rows = this.campaigns.map(c => {
      const isExpanded = this.expanded.has(String(c.id));
      const detailTab  = this.wbDetailTab.get(String(c.id)) ?? 'bids';
      const isAuto     = c.typeCode === 8;
      const roiColor   = c.roi >= 0 ? '#22c55e' : '#ef4444';
      const isBudgEdit = this.budgetEditing.has(String(c.id));

      const budgetCell = isBudgEdit
        ? `<div class="ad-budget-cell">
            <input class="ad-budget-inp" id="ad-b-inp-${c.id}" type="number" min="50" value="${c.budget}" placeholder="₽">
            <div class="ad-budget-acts">
              <button class="ad-budget-ok" data-action="save-budget" data-id="${c.id}">${I.check()}</button>
              <button class="ad-budget-x"  data-action="cancel-budget" data-id="${c.id}">✕</button>
            </div>
          </div>`
        : `<div class="ad-budget-cell">
            <span class="ad-budget-val">${c.budget ? fmt(c.budget) + ' ₽' : '—'}</span>
            <span class="ad-budget-pen" data-action="edit-budget" data-id="${c.id}">${I.edit()}</span>
          </div>`;

      const pauseBtn = c.status === 'active'
        ? `<button class="rpr-btn rpr-btn-ghost" style="padding:3px 8px;font-size:11px" data-action="pause"  data-id="${c.id}">⏸</button>`
        : `<button class="rpr-btn rpr-btn-ghost" style="padding:3px 8px;font-size:11px" data-action="resume" data-id="${c.id}">▶</button>`;

      const expandBtn = `<button class="ad-expand-btn ${isExpanded ? 'open' : ''}" data-action="expand" data-id="${c.id}">
        <span class="ad-expand-chevron">${I.chevronDown()}</span>
      </button>`;

      const mainRow = `<tr class="ad-row ${isExpanded ? 'expanded-row' : ''}">
        <td style="font-weight:600;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim" style="font-size:11px">${esc(c.type)}</td>
        <td>${budgetCell}</td>
        <td class="r dim">${c.spent ? fmt(c.spent) + ' ₽' : '—'}</td>
        <td class="r dim">${fmt(c.views)}</td>
        <td class="r dim">${fmt(c.clicks)}</td>
        <td class="r dim">${c.orders}</td>
        <td class="r" style="font-weight:700;color:${roiColor}">${roiStr(c.roi)}</td>
        <td style="white-space:nowrap">${pauseBtn} ${expandBtn}</td>
      </tr>`;

      if (!isExpanded) return mainRow;

      const detailHtml = this.detailLoading.has(String(c.id))
        ? skeleton(3)
        : this._renderWbDetail(c, detailTab);

      const tabButtons = `
        <div class="ad-detail-tabs">
          <button class="ad-detail-tab ${detailTab==='bids'?'active':''}" data-action="detail-tab" data-id="${c.id}" data-tab="bids">Ставки по товарам</button>
          <button class="ad-detail-tab ${detailTab==='keywords'?'active':''}" data-action="detail-tab" data-id="${c.id}" data-tab="keywords">
            ${isAuto ? 'Минус-слова' : 'Ключевые слова'}
          </button>
        </div>`;

      const detailRow = `<tr class="ad-detail-row">
        <td colspan="10">
          <div class="ad-detail-inner">${tabButtons}${detailHtml}</div>
        </td>
      </tr>`;

      return mainRow + detailRow;
    }).join('');

    return `<table class="ad-table">
      <thead><tr>
        <th>Кампания</th>
        <th>Статус</th>
        <th>Тип</th>
        <th>Бюджет/д</th>
        <th class="r">Потрачено</th>
        <th class="r">Показы</th>
        <th class="r">Клики</th>
        <th class="r">Заказы</th>
        <th class="r">ROI</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private _renderWbDetail(c: Campaign, tab: WbDetail): string {
    const detail = this.detailCache.get(String(c.id));
    if (!detail) return `<p style="color:var(--text2);font-size:12px">Нет данных. Разверните строку снова.</p>`;

    if (tab === 'bids') {
      const nms: any[] = detail.params?.nms ?? detail.nms ?? [];
      if (!nms.length) return `<p style="color:var(--text2);font-size:12px">Нет товаров в кампании.</p>`;
      return `
        <div style="overflow-x:auto">
          <table class="ad-bid-table">
            <thead><tr>
              <th>nmId</th>
              <th>Ставка сейчас</th>
              <th>Новая ставка, ₽</th>
            </tr></thead>
            <tbody>
              ${nms.map((nm: any) => `<tr>
                <td><code style="font-size:11px;color:var(--accent)">${nm.nm ?? nm.nmId ?? nm}</code></td>
                <td>${nm.bid ?? nm.cpm ?? '—'} ₽</td>
                <td>
                  <input type="number" min="1" placeholder="Новая ставка"
                    class="ad-boost-input" style="width:110px"
                    data-bidsave="${c.id}" data-nm="${nm.nm ?? nm.nmId ?? nm}">
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:10px">
          <button class="rpr-btn rpr-btn-green" style="display:flex;align-items:center;gap:5px" data-action="save-bids" data-id="${c.id}">
            ${I.check()} Сохранить ставки
          </button>
        </div>`;
    }

    // keywords / minus-words tab
    const isAuto = c.typeCode === 8;
    if (isAuto) {
      const excluded: string[] = detail.autoParams?.excludedKeywords ?? [];
      return `
        <p style="font-size:12px;color:var(--text2);margin-bottom:6px">
          Минус-слова для автокампании — каждое слово с новой строки
        </p>
        <textarea class="ad-minus-area" id="ad-excl-${c.id}" placeholder="телефон&#10;чехол&#10;...">${excluded.join('\n')}</textarea>
        <div style="margin-top:8px">
          <button class="rpr-btn rpr-btn-green" style="display:flex;align-items:center;gap:5px" data-action="save-excluded" data-id="${c.id}">
            ${I.check()} Сохранить минус-слова
          </button>
        </div>`;
    }

    const kws: any[] = detail.keywords ?? [];
    if (!kws.length) return `<p style="color:var(--text2);font-size:12px">Нет ключевых слов.</p>`;
    return `
      <div style="overflow-x:auto">
        <table class="ad-bid-table">
          <thead><tr>
            <th>Ключевое слово</th>
            <th class="r">Клики</th>
            <th class="r">Показы</th>
            <th class="r">Расход</th>
          </tr></thead>
          <tbody>
            ${kws.map((k: any) => `<tr>
              <td>${esc(k.keyword ?? k.word ?? '')}</td>
              <td style="text-align:right">${k.clicks ?? 0}</td>
              <td style="text-align:right">${fmt(k.views ?? k.shows ?? 0)}</td>
              <td style="text-align:right">${k.sum ? fmt(k.sum) + ' ₽' : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ── Ozon Performance table ─────────────────────────────────────────────────

  private renderOzonPerfTable(): string {
    if (!this.campaigns.length)
      return `
        <div class="ad-nginx-guide">
          <div style="font-size:14px;font-weight:700;margin-bottom:8px;color:var(--text)">
            ${I.zap()} Ozon Performance API
          </div>
          <p style="font-size:12px;color:var(--text2);line-height:1.7;margin-bottom:10px">
            Performance-кампании работают через отдельный домен <code>performance.ozon.ru</code>.
            Прокси уже добавлен в nginx — нажмите «Загрузить» чтобы проверить подключение.
          </p>
          <p style="font-size:12px;color:var(--text2);line-height:1.7">
            Если видите ошибку — проверьте, что nginx перезапущен после последнего деплоя.
          </p>
          <div style="margin-top:10px">
            <button class="rpr-btn rpr-btn-green" id="ad-refresh" style="display:flex;align-items:center;gap:5px">
              ${I.refresh()} Загрузить кампании
            </button>
          </div>
        </div>`;

    const rows = this.campaigns.map(c => {
      const isExpanded = this.expanded.has(String(c.id));
      const toggleBtn = c.status === 'active'
        ? `<button class="rpr-btn rpr-btn-ghost" style="padding:3px 8px;font-size:11px" data-action="toggle-perf" data-id="${c.id}" data-status="active">⏸</button>`
        : `<button class="rpr-btn rpr-btn-ghost" style="padding:3px 8px;font-size:11px" data-action="toggle-perf" data-id="${c.id}" data-status="inactive">▶</button>`;

      const expandBtn = `<button class="ad-expand-btn ${isExpanded?'open':''}" data-action="expand-perf" data-id="${c.id}">
        <span class="ad-expand-chevron">${I.chevronDown()}</span>
      </button>`;

      const mainRow = `<tr class="ad-row ${isExpanded?'expanded-row':''}">
        <td style="font-weight:600">${esc(c.name)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim" style="font-size:11px">${esc(c.type)}</td>
        <td class="r dim">${c.budget ? fmt(c.budget) + ' ₽' : '—'}</td>
        <td class="r dim">${c.spent ? fmt(c.spent) + ' ₽' : '—'}</td>
        <td class="r dim">${fmt(c.views)}</td>
        <td class="r dim">${fmt(c.clicks)}</td>
        <td class="r dim">${ctr(c.views, c.clicks)}</td>
        <td style="white-space:nowrap">${toggleBtn} ${expandBtn}</td>
      </tr>`;

      if (!isExpanded) return mainRow;

      const detailContent = this.detailLoading.has(String(c.id))
        ? skeleton(2)
        : this._renderOzonPerfObjects(String(c.id));

      const detailRow = `<tr class="ad-detail-row"><td colspan="9">
        <div class="ad-detail-inner">${detailContent}</div>
      </td></tr>`;

      return mainRow + detailRow;
    }).join('');

    return `<table class="ad-table">
      <thead><tr>
        <th>Кампания</th><th>Статус</th><th>Тип</th>
        <th class="r">Бюджет</th><th class="r">Потрачено</th>
        <th class="r">Показы</th><th class="r">Клики</th><th class="r">CTR</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private _renderOzonPerfObjects(campaignId: string): string {
    const objects: any[] = this.detailCache.get(campaignId) ?? [];
    if (!objects.length) return `<p style="color:var(--text2);font-size:12px">Нет объявлений или данные не загружены.</p>`;
    return `
      <div style="overflow-x:auto">
        <table class="ad-bid-table">
          <thead><tr>
            <th>SKU</th><th>Статус</th><th class="r">Ставка</th>
          </tr></thead>
          <tbody>${objects.map((o: any) => `<tr>
            <td><code style="font-size:11px;color:var(--accent)">${o.sku ?? o.id ?? '—'}</code></td>
            <td>${statusChip(o.state === 'ACTIVE' ? 'active' : 'inactive')}</td>
            <td style="text-align:right">${o.bid ? fmt(o.bid) + ' ₽' : '—'}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ── Ozon Promo table ───────────────────────────────────────────────────────

  private renderOzonPromoTable(): string {
    if (!this.campaigns.length)
      return emptyState('Нет акций', 'Нажмите «Загрузить»');

    const rows = this.campaigns.map(c => {
      const isExpanded = this.expanded.has(String(c.id));
      const expandBtn = `<button class="ad-expand-btn ${isExpanded?'open':''}" data-action="expand-promo" data-id="${c.id}" data-actionid="${c.actionId ?? ''}">
        <span class="ad-expand-chevron">${I.chevronDown()}</span>
      </button>`;

      const mainRow = `<tr class="ad-row ${isExpanded?'expanded-row':''}">
        <td><code style="font-size:11px;color:var(--text3)">${esc(String(c.id))}</code></td>
        <td style="font-weight:600">${esc(c.name)}</td>
        <td class="dim" style="font-size:11px">${esc(c.type)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim" style="font-size:11px">${c.dateFrom ? c.dateFrom.slice(0,10) + ' — ' + (c.dateTo ?? '').slice(0,10) : '—'}</td>
        <td>${expandBtn}</td>
      </tr>`;

      if (!isExpanded) return mainRow;

      const detailContent = this.detailLoading.has(String(c.id))
        ? skeleton(2)
        : this._renderOzonPromoProducts(String(c.id), c.actionId);

      const detailRow = `<tr class="ad-detail-row"><td colspan="6">
        <div class="ad-detail-inner">${detailContent}</div>
      </td></tr>`;

      return mainRow + detailRow;
    }).join('');

    return `<table class="ad-table">
      <thead><tr>
        <th>ID</th><th>Акция</th><th>Тип</th><th>Статус</th><th>Период</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private _renderOzonPromoProducts(promoKey: string, actionId?: number): string {
    const data = this.detailCache.get(promoKey) as { activated: any[]; available: any[] } | undefined;
    if (!data) return `<p style="color:var(--text2);font-size:12px">Нет данных.</p>`;
    if (!data.activated.length) return `<p style="color:var(--text2);font-size:12px">В акции нет активных товаров.</p>`;
    return `
      <p style="font-size:11px;color:var(--text3);margin-bottom:8px">
        Участвует в акции: ${data.activated.length} товаров
      </p>
      <div style="overflow-x:auto">
        <table class="ad-bid-table">
          <thead><tr>
            <th>ID товара</th><th class="r">Промо-цена</th><th></th>
          </tr></thead>
          <tbody>${data.activated.map((p: any) => `<tr>
            <td><code style="font-size:11px;color:var(--accent)">${p.id ?? p.product_id}</code></td>
            <td style="text-align:right">${p.price ? fmt(p.price) + ' ₽' : '—'}</td>
            <td>
              <button class="rpr-btn rpr-btn-ghost" style="padding:2px 8px;font-size:11px;color:var(--err)"
                data-action="rm-promo-product" data-promoid="${promoKey}" data-actionid="${actionId ?? ''}" data-productid="${p.id ?? p.product_id}">
                Убрать
              </button>
            </td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ── YM Promo table ─────────────────────────────────────────────────────────

  private renderYmPromoTable(): string {
    if (!this.campaigns.length)
      return emptyState('Нет акций', 'Нажмите «Загрузить»');

    const rows = this.campaigns.map(c => {
      const isExpanded = this.expanded.has(String(c.id));
      const expandBtn = `<button class="ad-expand-btn ${isExpanded?'open':''}" data-action="expand-ym-promo" data-id="${c.id}" data-promoid="${esc(String(c.promoId ?? c.id))}">
        <span class="ad-expand-chevron">${I.chevronDown()}</span>
      </button>`;

      const mainRow = `<tr class="ad-row ${isExpanded?'expanded-row':''}">
        <td style="font-weight:600;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</td>
        <td class="dim" style="font-size:11px">${esc(c.type)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim" style="font-size:11px">${c.dateFrom ? c.dateFrom.slice(0,10) + ' — ' + (c.dateTo ?? '').slice(0,10) : '—'}</td>
        <td>${expandBtn}</td>
      </tr>`;

      if (!isExpanded) return mainRow;

      const detailContent = this.detailLoading.has(String(c.id))
        ? skeleton(2)
        : this._renderYmPromoOffers(String(c.id), String(c.promoId ?? c.id));

      const detailRow = `<tr class="ad-detail-row"><td colspan="5">
        <div class="ad-detail-inner">${detailContent}</div>
      </td></tr>`;

      return mainRow + detailRow;
    }).join('');

    return `<table class="ad-table">
      <thead><tr>
        <th>Акция</th><th>Тип</th><th>Статус</th><th>Период</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private _renderYmPromoOffers(key: string, promoId: string): string {
    const offers: any[] = this.detailCache.get(key) ?? [];
    if (!Array.isArray(offers)) return `<p style="color:var(--text2);font-size:12px">Нет данных.</p>`;
    if (!offers.length) return `<p style="color:var(--text2);font-size:12px">В акции нет офферов.</p>`;
    return `
      <p style="font-size:11px;color:var(--text3);margin-bottom:8px">
        Офферов в акции: ${offers.length}
      </p>
      <div style="overflow-x:auto">
        <table class="ad-bid-table">
          <thead><tr>
            <th>Offer ID</th><th class="r">Промо-цена</th><th></th>
          </tr></thead>
          <tbody>${offers.map((o: any) => {
            const oid = o.offerId ?? o.offer_id ?? '';
            return `<tr>
              <td><code style="font-size:11px;color:var(--accent)">${esc(oid)}</code></td>
              <td style="text-align:right">${o.promoPrice ?? o.promo_price ? fmt(o.promoPrice ?? o.promo_price) + ' ₽' : '—'}</td>
              <td>
                <button class="rpr-btn rpr-btn-ghost" style="padding:2px 8px;font-size:11px;color:var(--err)"
                  data-action="rm-ym-offer" data-promoid="${esc(promoId)}" data-offerid="${esc(oid)}">
                  Убрать
                </button>
              </td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ── YM Boost bids table ────────────────────────────────────────────────────

  private renderYmBoostTable(): string {
    if (this.ymBidsLoading) return skeleton(6);
    if (!this.storeId)
      return emptyState('Выберите магазин', 'для загрузки ставок');

    if (!this.ymBids.length)
      return `<div style="padding:16px">
        ${emptyState('Нет данных по ставкам', 'Нажмите «Загрузить ставки»')}
      </div>`;

    const recMap = new Map<string, any>();
    for (const r of this.ymRecommended) recMap.set(r.offerId ?? r.offer_id ?? '', r);

    const rows = this.ymBids.map(b => {
      const oid = b.offerId ?? b.offer_id ?? '';
      const rec = recMap.get(oid);
      const curBid = b.bid ?? 0;
      const recBid = rec?.bid ?? rec?.recommendedBid ?? null;
      const edited = this.ymBidEdits.get(oid) ?? '';

      return `<tr>
        <td><code style="font-size:11px;color:var(--accent)">${esc(oid)}</code></td>
        <td class="r">${curBid ? fmt(curBid) + ' ₽' : '—'}</td>
        <td class="r dim">${recBid ? fmt(recBid) + ' ₽' : '—'}</td>
        <td>
          <input type="number" min="0" placeholder="${curBid || ''}"
            class="ad-boost-input ${edited && Number(edited) !== curBid ? 'changed' : ''}"
            value="${edited}"
            data-boostid="${esc(oid)}">
        </td>
      </tr>`;
    }).join('');

    return `<div style="padding:0 0 12px">
      <div style="overflow-x:auto">
        <table class="ad-table">
          <thead><tr>
            <th>Offer ID</th>
            <th class="r">Текущая</th>
            <th class="r">Рекомендованная</th>
            <th>Новая ставка, ₽</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border)">
        <button class="rpr-btn rpr-btn-green" id="ym-save-bids" style="display:flex;align-items:center;gap:5px">
          ${I.check()} Сохранить ставки
        </button>
      </div>
    </div>`;
  }

  // ── Create campaign dialog (WB) ────────────────────────────────────────────

  private showCreateDialog(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:24px;width:400px;max-width:100%">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div style="font-size:15px;font-weight:800;color:var(--text)">Новая кампания WB</div>
          <button id="ad-dlg-x" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;line-height:1">✕</button>
        </div>
        <form id="ad-dlg-form" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);display:block;margin-bottom:5px">Название</label>
            <input name="name" required placeholder="Название кампании" style="width:100%;box-sizing:border-box;padding:9px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;font-family:inherit;outline:none">
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);display:block;margin-bottom:5px">Дневной бюджет, ₽</label>
            <input name="budget" type="number" min="100" required placeholder="500" style="width:100%;box-sizing:border-box;padding:9px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;font-family:inherit;outline:none">
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);display:block;margin-bottom:5px">Тип кампании</label>
            <select name="type" style="width:100%;box-sizing:border-box;padding:9px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;font-family:inherit;outline:none">
              <option value="8">Автоматическая</option>
              <option value="6">Поиск</option>
              <option value="7">Каталог</option>
            </select>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
            <button type="button" id="ad-dlg-cancel" class="rpr-btn rpr-btn-ghost">Отмена</button>
            <button type="submit" class="rpr-btn rpr-btn-green" style="display:flex;align-items:center;gap:5px">${I.plus()} Создать</button>
          </div>
        </form>
      </div>`;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#ad-dlg-x')?.addEventListener('click', close);
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
