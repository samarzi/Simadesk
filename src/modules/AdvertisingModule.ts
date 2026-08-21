import { ozonApi, ozonPerfApi } from '@/services/ozonApi';
import {
  getWbCampaigns, createWbAdCampaign, updateWbCampaign,
  getWbAdBalance, getWbCampaignDetails, getWbFullStats,
  updateWbCampaignBids, setWbExcludedKeywords,
} from '@/services/wbApi';
import {
  getYandexPromos, getYandexPromoOffers, removeYandexPromoOffers,
  getYandexBusinessBids, getYandexBidsRecommendations, updateYandexBusinessBids,
  YM_BID_MIN, YM_BID_MAX,
  type YandexBid, type YandexBidRecommendation,
} from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'overview' | 'wb' | 'ozon' | 'yandex';
type OzonSub = 'perf' | 'promo';
type YmSub   = 'promo' | 'boost';
type WbDetail = 'bids' | 'keywords';
type SortKey  = 'name' | 'status' | 'budget' | 'spent' | 'clicks' | 'views' | 'orders' | 'roi';

interface Campaign {
  id: string | number;
  storeId: string;
  storeName: string;
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

interface AiHint {
  level: 'danger' | 'warn' | 'ok';
  campaignId: string | number;
  campaignName: string;
  message: string;
  action?: string;
}

interface Store {
  id: string;
  name: string;
  api_key: string;
  client_id?: string | null;
  business_id?: string | number | null;  // number in YandexStore
  campaign_id?: string | number | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString('ru-RU');
const ctr = (v: number, c: number) => v > 0 ? (c / v * 100).toFixed(2) + '%' : '—';
const roiStr = (r: number) => (r >= 0 ? '+' : '') + r.toFixed(1) + '%';
const drrVal = (spend: number, revenue: number) => revenue > 0 && spend > 0 ? spend / revenue * 100 : null;
const drrBadge = (spend: number, revenue: number) => {
  const d = drrVal(spend, revenue);
  if (d === null) return `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;background:var(--bg3);color:var(--text3)">—</span>`;
  const [col, bg] = d < 15 ? ['#22c55e', 'rgba(34,197,94,.12)'] : d < 30 ? ['#f59e0b', 'rgba(245,158,11,.12)'] : ['#ef4444', 'rgba(239,68,68,.12)'];
  return `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${col}">${d.toFixed(1)}%</span>`;
};

function statusChip(s: string) {
  const M: Record<string, [string, string, string]> = {
    active:   ['Активна',     '#22c55e', 'rgba(34,197,94,.13)'],
    paused:   ['Пауза',       '#f59e0b', 'rgba(245,158,11,.13)'],
    stopped:  ['Остановлена', '#ef4444', 'rgba(239,68,68,.13)'],
    inactive: ['Неактивна',   '#71717a', 'var(--bg3)'],
    upcoming: ['Скоро',       '#818cf8', 'rgba(129,140,248,.13)'],
  };
  const [label, col, bg] = M[s] ?? [s, '#71717a', 'var(--bg3)'];
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;
    font-size:11px;font-weight:700;background:${bg};color:${col};white-space:nowrap">
    <span style="width:5px;height:5px;border-radius:50%;background:${col};flex-shrink:0"></span>${esc(label)}</span>`;
}

function skeleton(n = 5) {
  const r = `<div style="height:38px;border-radius:6px;background:var(--bg3);animation:adp 1.5s ease-in-out infinite"></div>`;
  return `<div style="padding:16px;display:flex;flex-direction:column;gap:6px">${Array(n).fill(r).join('')}</div>`;
}

function empty(msg: string, hint = '') {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:200px;gap:8px;padding:32px">
    <div style="font-size:32px;opacity:.15">${I.chartBar()}</div>
    <p style="margin:0;font-size:13px;font-weight:700;color:var(--text2)">${msg}</p>
    ${hint ? `<p style="margin:0;font-size:12px;color:var(--text3);text-align:center;max-width:320px;line-height:1.6">${hint}</p>` : ''}
  </div>`;
}

// ─── AI analysis ──────────────────────────────────────────────────────────────

function analyzeAi(campaigns: Campaign[]): AiHint[] {
  const hints: AiHint[] = [];
  for (const c of campaigns) {
    if (c.status !== 'active') continue;
    const cpc   = c.clicks > 0 ? c.spent / c.clicks : 0;
    const ctrV  = c.views  > 0 ? c.clicks / c.views * 100 : 0;
    const budgetUtil = c.budget > 0 ? c.spent / c.budget * 100 : 0;
    const drr   = drrVal(c.spent, c.revenue);

    if (c.spent > 500 && c.orders === 0) {
      hints.push({ level: 'danger', campaignId: c.id, campaignName: c.name,
        message: `Потрачено ${fmt(c.spent)} ₽ — ноль заказов. ДРР не определён. Рекомендуем остановить кампанию.`,
        action: 'pause' });
    } else if (drr !== null && drr > 40 && c.spent > 300) {
      hints.push({ level: 'danger', campaignId: c.id, campaignName: c.name,
        message: `ДРР ${drr.toFixed(1)}% — выше 40%, кампания съедает больше прибыли чем приносит`,
        action: 'pause' });
    } else if (drr !== null && drr > 25 && c.spent > 200) {
      hints.push({ level: 'warn', campaignId: c.id, campaignName: c.name,
        message: `ДРР ${drr.toFixed(1)}% — высоковато. Проверьте ставки и состав товаров` });
    } else if (c.roi < -10 && c.spent > 200) {
      hints.push({ level: 'warn', campaignId: c.id, campaignName: c.name,
        message: `ROI ${roiStr(c.roi)} — низкая отдача, проверьте ставки и товары` });
    }
    if (c.views > 1000 && ctrV < 0.3) {
      hints.push({ level: 'warn', campaignId: c.id, campaignName: c.name,
        message: `CTR ${ctr(c.views, c.clicks)} при ${fmt(c.views)} показах — ставки занижены или объявление нерелевантно` });
    }
    if (budgetUtil > 95 && (drr === null || drr < 25)) {
      hints.push({ level: 'ok', campaignId: c.id, campaignName: c.name,
        message: `Бюджет исчерпан на ${budgetUtil.toFixed(0)}%${drr !== null ? `, ДРР ${drr.toFixed(1)}%` : ''} — увеличьте дневной лимит для роста продаж` });
    }
    if (cpc > 200 && c.orders === 0) {
      hints.push({ level: 'danger', campaignId: c.id, campaignName: c.name,
        message: `CPC ${fmt(Math.round(cpc))} ₽ без заказов — высокая стоимость клика, нет конверсий` });
    }
  }
  return hints.slice(0, 8);
}

function buildAiText(campaigns: Campaign[], hints: AiHint[]): string {
  if (!campaigns.length) return '';
  const active = campaigns.filter(c => c.status === 'active');
  const totalSpent = campaigns.reduce((s, c) => s + c.spent, 0);
  const totalRev   = campaigns.reduce((s, c) => s + c.revenue, 0);
  const drr = drrVal(totalSpent, totalRev);
  const dangers = hints.filter(h => h.level === 'danger');
  const warns   = hints.filter(h => h.level === 'warn');
  const oks     = hints.filter(h => h.level === 'ok');

  let t = `Анализирую ${campaigns.length} кампаний, из них ${active.length} активных...\n`;
  if (totalSpent > 0) {
    t += `Расход за период: ${fmt(Math.round(totalSpent))} ₽`;
    if (totalRev > 0) t += `, выручка: ${fmt(Math.round(totalRev))} ₽, ДРР: ${drr!.toFixed(1)}%`;
    t += '.\n';
  }
  t += '\n';
  if (dangers.length) {
    t += `🔴 Критично (${dangers.length}):\n`;
    for (const h of dangers) t += `  • ${h.campaignName} — ${h.message}\n`;
    t += '\n';
  }
  if (warns.length) {
    t += `⚠️ Рекомендации (${warns.length}):\n`;
    for (const h of warns) t += `  • ${h.campaignName} — ${h.message}\n`;
    t += '\n';
  }
  if (oks.length) {
    t += `✅ Возможности (${oks.length}):\n`;
    for (const h of oks) t += `  • ${h.campaignName} — ${h.message}\n`;
    t += '\n';
  }
  if (!hints.length) {
    t += '✅ Все активные кампании работают штатно. Следите за динамикой CTR и конверсий.\n';
  } else {
    const total = dangers.length + warns.length;
    t += `Итог: ${total > 0 ? `найдено ${total} проблем${total > 4 ? '' : total > 1 ? 'ы' : 'а'}, требующих внимания` : 'серьёзных проблем нет'}${oks.length ? `, ${oks.length} возможностей для роста` : ''}.`;
  }
  return t;
}

// ─── Help content ──────────────────────────────────────────────────────────────

function buildHelpModal(): string {
  return `<div id="ad-help-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;
    display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)">
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:660px;
      max-width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 22px;
        border-bottom:1px solid var(--border);flex-shrink:0">
        <div style="font-size:16px;font-weight:800;color:var(--text)">Как работает раздел Реклама</div>
        <button onclick="document.getElementById('ad-help-overlay').remove()" style="background:none;border:none;color:var(--text2);cursor:pointer;
          font-size:20px;padding:2px 6px;border-radius:6px;line-height:1">✕</button>
      </div>
      <div style="overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:20px">

        <div style="background:var(--bg3);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:8px">
            <span style="background:rgba(124,58,237,.2);color:#a78bfa;padding:3px 10px;border-radius:20px;font-size:11px">WB</span>
            Wildberries — Рекламные кампании
          </div>
          <div style="font-size:12px;color:var(--text2);line-height:1.8;display:flex;flex-direction:column;gap:8px">
            <div><b style="color:var(--text)">Что нужно:</b> API-ключ с правами на раздел «Реклама». Создаётся в Личном кабинете WB → Настройки → Доступ к API.</div>
            <div><b style="color:var(--text)">Кампании</b> — загружаются за выбранный период. Нажмите «Загрузить» после выбора магазина и дат.</div>
            <div><b style="color:var(--text)">Баланс кабинета</b> — показывается вверху как зелёный чип. Это рекламный баланс, не торговый.</div>
            <div><b style="color:var(--text)">Бюджет строки</b> — дневной лимит. Кликните иконку карандаша в строке → введите новое значение → Enter.</div>
            <div><b style="color:var(--text)">Ставки по товарам</b> — разверните строку кампании (▽) → вкладка «Ставки». Вводите новые ставки → «Сохранить».</div>
            <div><b style="color:var(--text)">Минус-слова</b> — только для автокампаний (тип «Авто»). Разверните → «Минус-слова» → вводите по одному на строку.</div>
            <div><b style="color:var(--text)">Создание кампании</b> — кнопка «+ Кампания». Для наполнения товарами используйте ЛК WB после создания.</div>
          </div>
        </div>

        <div style="background:var(--bg3);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:8px">
            <span style="background:rgba(0,91,255,.12);color:#60a5fa;padding:3px 10px;border-radius:20px;font-size:11px">Ozon</span>
            Ozon — Performance и Акции
          </div>
          <div style="font-size:12px;color:var(--text2);line-height:1.8;display:flex;flex-direction:column;gap:8px">
            <div><b style="color:var(--text)">Что нужно:</b> Client-ID и API-ключ из кабинета Ozon Seller → Настройки → API-ключи. Тот же ключ работает и для Performance.</div>
            <div><b style="color:var(--text)">Performance-кампании</b> — продвижение через рекламный кабинет Ozon. Данные приходят через отдельный домен <code style="background:var(--bg);padding:1px 5px;border-radius:4px">performance.ozon.ru</code> (проксирован).</div>
            <div><b style="color:var(--text)">Разворот Performance-кампании</b> — показывает SKU-объявления с текущими ставками. Вкл/выкл через ▶/⏸ в строке.</div>
            <div><b style="color:var(--text)">Акции Ozon</b> — промоакции от Ozon (скидки, FlashSale). Разверните акцию чтобы увидеть участвующие товары и убрать ненужные.</div>
          </div>
        </div>

        <div style="background:var(--bg3);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:8px">
            <span style="background:rgba(252,63,29,.1);color:#f87171;padding:3px 10px;border-radius:20px;font-size:11px">ЯМ</span>
            Яндекс.Маркет — Акции и Буст
          </div>
          <div style="font-size:12px;color:var(--text2);line-height:1.8;display:flex;flex-direction:column;gap:8px">
            <div><b style="color:var(--text)">Что нужно:</b> API-ключ из Яндекс.Маркет ЛК → Настройки → Партнёрский API. Также нужны Business-ID и Campaign-ID (есть в настройках магазина).</div>
            <div><b style="color:var(--text)">Акции</b> — промоакции ЯМ (скидки, промокоды). Разверните акцию → посмотрите или уберите офферы.</div>
            <div><b style="color:var(--text)">Буст-продвижение</b> — ставки за клик по товарам в поиске ЯМ. Нажмите «Загрузить ставки» → отредактируйте значения → «Сохранить». Колонка «Рекомендованная» — подсказка от ЯМ API.</div>
            <div><b style="color:var(--text)">Важно:</b> для Буста нужен Campaign-ID в настройках магазина. Если его нет — добавьте в разделе «Магазины → Яндекс.Маркет».</div>
          </div>
        </div>

        <div style="background:var(--bg3);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:10px">
            ⚡ Автодиагностика
          </div>
          <div style="font-size:12px;color:var(--text2);line-height:1.8;display:flex;flex-direction:column;gap:6px">
            <div>После загрузки кампаний появляется панель ИИ-советника. Она автоматически анализирует:</div>
            <div style="padding-left:12px;display:flex;flex-direction:column;gap:4px">
              <div><span style="color:#ef4444">■</span> Убыточные кампании (ROI &lt; −30%) — рекомендует поставить на паузу</div>
              <div><span style="color:#f59e0b">■</span> Низкий CTR при большом охвате — рекомендует поднять ставки</div>
              <div><span style="color:#f59e0b">■</span> Высокий CPC без конверсий — рекомендует проверить релевантность</div>
              <div><span style="color:#22c55e">■</span> Бюджет исчерпан при положительном ROI — рекомендует увеличить лимит</div>
            </div>
          </div>
        </div>

        <div style="background:var(--bg3);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:10px">Все магазины</div>
          <div style="font-size:12px;color:var(--text2);line-height:1.8">
            Переключатель <b style="color:var(--text)">«Все магазины»</b> загружает кампании из всех ваших магазинов на выбранном МП одновременно.
            В таблице появляется колонка «Магазин». KPI-тайлы агрегируют данные по всем. Полезно для общего контроля рекламных расходов.
          </div>
        </div>

      </div>
    </div>
  </div>`;
}

// ─── module ───────────────────────────────────────────────────────────────────

export class AdvertisingModule {
  private el: HTMLElement;

  private tab: Tab = 'overview';
  private ozonSub: OzonSub = 'perf';
  private ymSub: YmSub = 'promo';

  private storeId = '';           // '' = all stores
  private stores: Store[] = [];

  private campaigns: Campaign[] = [];
  private filtered: Campaign[] = [];
  private loading = false;
  private balances = new Map<string, number>(); // storeId → balance

  private dateFrom: string;
  private dateTo: string;

  private searchQ = '';
  private filterStatus = 'all';
  private sortKey: SortKey = 'spent';
  private sortDir: 1 | -1 = -1;
  private isFilterActive = false;    // true when search or status filter applied
  private opInProgress = new Set<string>(); // locked campaign IDs during API ops

  // Expanded rows
  private expanded = new Set<string>();
  private wbDetailTab = new Map<string, WbDetail>();
  private detailLoading = new Set<string>();
  private detailCache = new Map<string, any>();

  // Budget inline edit
  private budgetEditing = new Set<string>();

  // Bulk selection
  private selected = new Set<string>();

  // YM boost (уровень бизнеса: FBS+FBY одного бизнеса = один рекламный кабинет)
  private ymBids: YandexBid[] = [];
  private ymRec:  YandexBidRecommendation[] = [];
  private ymBidsLoading = false;
  private ymBidEdits = new Map<string, string>();   // sku → введённый процент, строкой
  private ymBidsSearch = '';
  private ymBoostBusiness: { businessId: number; apiKey: string; label: string } | null = null;
  private ymBoostLoaded = false;

  // AI
  private aiHints: AiHint[] = [];
  private aiOpen = false;
  private aiStreamText = '';
  private aiStreamDisplayed = '';
  private aiStreamTimer: ReturnType<typeof setInterval> | null = null;

  // Errors per store
  private loadErrors: Array<{ storeName: string; message: string }> = [];

  // Which marketplaces have stores connected
  private mpAvailable: Record<'wb' | 'ozon' | 'yandex', boolean> = { wb: true, ozon: true, yandex: true };
  private mpAvailableLoaded = false;

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
    this.loadMpAvailability();
  }

  // ─── styles ──────────────────────────────────────────────────────────────────

  private injectStyles() {
    if (document.getElementById('ad-sty')) return;
    const s = document.createElement('style');
    s.id = 'ad-sty';
    s.textContent = `
@keyframes adp{0%,100%{opacity:.4}50%{opacity:.9}}

.adw{display:flex;flex-direction:column;height:100%;background:var(--bg2)}

/* header */
.adh{display:flex;align-items:center;flex-wrap:wrap;padding:9px 18px;background:var(--bg);
  border-bottom:1px solid var(--border);gap:8px;flex-shrink:0;min-height:50px}
.adh-l{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1}
.adh-r{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ad-logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);
  display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0}
.ad-title{font-size:14px;font-weight:800;color:var(--text);letter-spacing:-.2px}

/* MP tabs */
.ad-mptabs{display:flex;gap:2px}
.ad-mptab{padding:4px 12px;border-radius:8px;border:none;cursor:pointer;font-size:12px;
  font-weight:700;font-family:inherit;transition:all .15s;background:transparent;color:var(--text2)}
.ad-mptab:hover{background:var(--bg2);color:var(--text)}
.ad-mptab.ad-mptab-ov{background:rgba(99,102,241,.15);color:#818cf8}
.ad-mptab.awb{background:rgba(124,58,237,.15);color:#a78bfa}
.ad-mptab.aozon{background:rgba(0,91,255,.12);color:#60a5fa}
.ad-mptab.aym{background:rgba(252,63,29,.1);color:#f87171}
.ad-mptab.ad-mptab-locked{opacity:.35;cursor:not-allowed !important;pointer-events:none}
.ad-mptab.ad-mptab-locked:hover{background:transparent !important;color:var(--text2) !important}

/* store select */
.ad-sel{padding:4px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;
  color:var(--text);font-size:12px;font-family:inherit;outline:none;min-width:140px;height:28px}

/* all-stores toggle */
.ad-all-tog{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;
  border:1px solid var(--border);cursor:pointer;font-size:11px;font-weight:700;font-family:inherit;
  background:transparent;color:var(--text2);transition:all .15s}
.ad-all-tog:hover{background:var(--bg2)}
.ad-all-tog.on{background:color-mix(in srgb,var(--accent) 12%,transparent);
  color:var(--accent);border-color:color-mix(in srgb,var(--accent) 30%,transparent)}

/* help btn */
.ad-help-btn{width:26px;height:26px;border-radius:50%;border:1px solid var(--border);
  background:var(--bg3);color:var(--text2);font-size:12px;font-weight:800;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
.ad-help-btn:hover{background:var(--accent);color:#000;border-color:var(--accent)}

/* sub bar */
.ads{display:flex;align-items:center;flex-wrap:wrap;padding:7px 18px;background:var(--bg);
  border-bottom:1px solid var(--border);gap:8px;flex-shrink:0}
.ads-l{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1}
.ads-r{display:flex;align-items:center;gap:6px;flex-wrap:wrap}

/* balance chip */
.ad-bal{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
  font-size:11px;font-weight:700;background:rgba(34,197,94,.12);color:#22c55e}

/* period presets */
.ad-preset{padding:3px 9px;border-radius:6px;border:1px solid var(--border);cursor:pointer;
  font-size:11px;font-weight:600;font-family:inherit;background:transparent;color:var(--text2);transition:all .12s}
.ad-preset:hover{background:var(--bg3);color:var(--text)}
.ad-period input{padding:3px 7px;background:var(--bg3);border:1px solid var(--border);
  border-radius:6px;color:var(--text);font-size:11px;font-family:inherit;outline:none}
.ad-period-sep{font-size:11px;color:var(--text3)}

/* sub-tabs */
.ad-stabs{display:flex;gap:2px}
.ad-stab{padding:3px 12px;border-radius:8px;border:none;cursor:pointer;font-size:11px;
  font-weight:600;font-family:inherit;background:transparent;color:var(--text2);transition:all .12s}
.ad-stab:hover{background:var(--bg2);color:var(--text)}
.ad-stab.on{background:var(--bg2);color:var(--text);font-weight:800}

/* filter bar */
.adf{display:flex;align-items:center;flex-wrap:wrap;padding:7px 18px;background:var(--bg2);
  border-bottom:1px solid var(--border);gap:8px;flex-shrink:0}
.adf-search{flex:1;min-width:160px;padding:5px 10px;background:var(--bg);
  border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;
  font-family:inherit;outline:none}
.adf-search:focus{border-color:var(--accent)}
.adf-status{padding:4px 8px;background:var(--bg3);border:1px solid var(--border);
  border-radius:8px;color:var(--text);font-size:12px;font-family:inherit;outline:none;height:28px}
.adf-sort{padding:4px 8px;background:var(--bg3);border:1px solid var(--border);
  border-radius:8px;color:var(--text);font-size:12px;font-family:inherit;outline:none;height:28px}
.adf-ai{display:flex;align-items:center;gap:5px;padding:3px 10px;border-radius:8px;
  border:1px solid transparent;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit;
  transition:all .15s}
.adf-ai.has-danger{background:rgba(239,68,68,.12);color:#ef4444;border-color:rgba(239,68,68,.25)}
.adf-ai.has-warn{background:rgba(245,158,11,.12);color:#f59e0b;border-color:rgba(245,158,11,.25)}
.adf-ai.has-ok{background:rgba(34,197,94,.1);color:#22c55e;border-color:rgba(34,197,94,.2)}

/* bulk bar */
.ad-bulk{display:flex;align-items:center;gap:8px;padding:6px 18px;
  background:color-mix(in srgb,var(--accent) 8%,var(--bg));
  border-bottom:1px solid color-mix(in srgb,var(--accent) 20%,var(--border));flex-shrink:0}
.ad-bulk span{font-size:12px;font-weight:700;color:var(--text)}

/* stats tiles */
.ad-tiles{display:flex;gap:6px;padding:10px 18px;flex-wrap:nowrap;overflow-x:auto;
  border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)}
.ad-tile{flex:1;min-width:90px;background:var(--bg2);border:1px solid var(--border);
  border-radius:10px;padding:9px 12px}
.ad-tile-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);
  margin-bottom:2px;white-space:nowrap}
.ad-tile-v{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.2}

/* body */
.ad-body{flex:1;min-height:0;overflow:auto}

/* table */
.adt{width:100%;border-collapse:collapse;font-size:12px}
.adt thead{position:sticky;top:0;z-index:3;background:var(--bg)}
.adt thead th{padding:8px 12px;text-align:left;font-size:10px;font-weight:700;
  color:var(--text3);text-transform:uppercase;letter-spacing:.5px;
  border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none}
.adt thead th:hover{color:var(--text)}
.adt thead th.r{text-align:right}
.adt tbody tr.adr{border-bottom:1px solid var(--border);transition:background .08s}
.adt tbody tr.adr:hover{background:var(--bg3)}
.adt tbody tr.adr.sel{background:color-mix(in srgb,var(--accent) 6%,var(--bg2))}
.adt tbody tr.adr.exp{background:var(--bg2)}
.adt td{padding:9px 12px;color:var(--text);vertical-align:middle}
.adt td.r{text-align:right;font-variant-numeric:tabular-nums}
.adt td.dim{color:var(--text2)}
.adt td.nm{font-size:10px;color:var(--text3)}

/* detail row */
.ad-drow td{padding:0;background:var(--bg2);border-bottom:2px solid var(--border)}
.ad-dinn{padding:14px 18px 16px;border-top:1px solid var(--border)}
.ad-dtabs{display:flex;gap:2px;margin-bottom:10px}
.ad-dtab{padding:3px 11px;border-radius:6px;border:none;cursor:pointer;font-size:11px;
  font-weight:600;font-family:inherit;background:var(--bg3);color:var(--text2);transition:all .12s}
.ad-dtab.on{background:var(--accent);color:#000}

/* mini table inside detail */
.adm{width:100%;border-collapse:collapse;font-size:12px}
.adm th{padding:5px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--text3);
  text-transform:uppercase;border-bottom:1px solid var(--border);background:var(--bg)}
.adm th.r{text-align:right}
.adm td{padding:6px 10px;border-bottom:1px solid var(--border);color:var(--text)}
.adm tr:last-child td{border-bottom:none}
.adm tr:hover td{background:var(--bg3)}

/* inline budget */
.ad-bud{display:flex;align-items:center;gap:5px}
.ad-bud-v{font-variant-numeric:tabular-nums}
.ad-bud-pen{opacity:0;cursor:pointer;color:var(--text3);transition:opacity .12s;display:flex;align-items:center}
.adr:hover .ad-bud-pen{opacity:1}
.ad-bud-inp{width:76px;padding:3px 6px;background:var(--bg);border:1px solid var(--accent);
  border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none}
.ad-bok,.ad-bx{padding:2px 6px;border-radius:5px;border:none;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit}
.ad-bok{background:var(--accent);color:#000}
.ad-bx{background:var(--bg3);color:var(--text2)}

/* expand btn */
.ad-exp{padding:3px 5px;border-radius:5px;border:none;cursor:pointer;background:transparent;
  color:var(--text3);transition:all .12s;display:flex;align-items:center}
.ad-exp:hover{background:var(--bg3);color:var(--text)}
.ad-exp.on{color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.ad-chev{transition:transform .2s}
.ad-exp.on .ad-chev{transform:rotate(180deg)}

/* boost input */
.ad-bi{width:80px;padding:4px 7px;background:var(--bg);border:1px solid var(--border);
  border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;outline:none}
.ad-bi:focus{border-color:var(--accent)}
.ad-bi.ch{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--bg))}

/* minus textarea */
.ad-minus{width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);
  border-radius:8px;color:var(--text);font-size:12px;font-family:inherit;outline:none;
  resize:vertical;min-height:68px;box-sizing:border-box}
.ad-minus:focus{border-color:var(--accent)}

/* AI panel */
.ad-ai-panel{padding:12px 18px;border-bottom:1px solid var(--border);flex-shrink:0;
  display:flex;flex-direction:column;gap:6px}
.ad-ai-row{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:8px;
  font-size:12px;background:var(--bg3)}
.ad-ai-row.d{background:rgba(239,68,68,.07);border-left:3px solid #ef4444}
.ad-ai-row.w{background:rgba(245,158,11,.07);border-left:3px solid #f59e0b}
.ad-ai-row.o{background:rgba(34,197,94,.07);border-left:3px solid #22c55e}
.ad-ai-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:3px}

/* checkbox */
.ad-cb{width:14px;height:14px;accent-color:var(--accent);cursor:pointer;flex-shrink:0}

/* sort indicator */
.ad-sort-i{font-size:9px;opacity:.6;margin-left:3px}

/* overview */
.ad-ov{padding:16px 18px;display:flex;flex-direction:column;gap:16px}
.ad-ov-kpi{display:flex;gap:8px;flex-wrap:wrap}
.ad-ov-kpi-tile{flex:1;min-width:110px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.ad-ov-kpi-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:3px}
.ad-ov-kpi-v{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
.ad-ov-sec{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.ad-ov-plats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.ad-ov-plat{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.ad-ov-plat-name{font-size:12px;font-weight:700;margin-bottom:6px}
.ad-ov-plat-amt{font-size:16px;font-weight:800;margin-bottom:4px}
.ad-ov-bar-bg{height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;margin-bottom:5px}
.ad-ov-bar{height:3px;border-radius:2px}
.ad-ov-plat-meta{font-size:11px;color:var(--text3)}

/* AI panel in overview */
.ad-ai-full{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.ad-ai-full-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg3)}
.ad-ai-full-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--text)}
.ad-ai-full-badge{padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
.ad-ai-stream-wrap{padding:12px 14px;font-size:12px;line-height:1.8;color:var(--text2);white-space:pre-wrap;font-family:var(--font-mono, monospace);min-height:80px;max-height:200px;overflow-y:auto}
.ad-ai-stream-cursor{display:inline-block;width:7px;height:12px;background:var(--accent);vertical-align:middle;animation:adp .7s step-end infinite;margin-left:1px}
.ad-ai-actions{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-top:1px solid var(--border)}
.ad-ai-action-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:8px;font-size:12px}
.ad-ai-action-row.d{background:rgba(239,68,68,.07);border-left:3px solid #ef4444}
.ad-ai-action-row.w{background:rgba(245,158,11,.07);border-left:3px solid #f59e0b}
.ad-ai-action-row.o{background:rgba(34,197,94,.07);border-left:3px solid #22c55e}
.ad-ai-action-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:4px}
`;
    document.head.appendChild(s);
  }

  // ─── shell ────────────────────────────────────────────────────────────────────

  private buildShell() {
    const tabs: { id: Tab; label: string; cls: string }[] = [
      { id: 'overview', label: '⚡ Обзор',       cls: '' },
      { id: 'wb',       label: 'Wildberries',    cls: 'awb' },
      { id: 'ozon',     label: 'Ozon',            cls: 'aozon' },
      { id: 'yandex',   label: 'Яндекс.Маркет',  cls: 'aym' },
    ];
    this.el.innerHTML = `<div class="adw">
      <div class="adh">
        <div class="adh-l">
          <div class="ad-logo">${I.zap()}</div>
          <span class="ad-title">Реклама</span>
          <div class="ad-mptabs">
            ${tabs.map(t =>
              `<button class="ad-mptab ${this.tab===t.id?t.cls||'ad-mptab-ov':''}" data-mp="${t.id}">
                ${t.label}
              </button>`).join('')}
          </div>
        </div>
        <div class="adh-r">
          <select class="ad-sel" id="ad-store"><option value="">Загрузка…</option></select>
          <button class="ad-all-tog ${this.storeId===''?'on':''}" id="ad-all-tog">
            ${I.eye()} Все
          </button>
          <button class="rpr-btn rpr-btn-ghost" id="ad-refresh" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 10px;font-size:12px">
            ${I.refresh()} Загрузить
          </button>
          <button class="ad-help-btn" id="ad-help">?</button>
        </div>
      </div>
      <div id="ad-sub"></div>
      <div id="ad-filter" style="display:none"></div>
      <div id="ad-bulk"  style="display:none"></div>
      <div id="ad-tiles" style="display:none"></div>
      <div id="ad-ai"    style="display:none"></div>
      <div class="ad-body" id="ad-body">${empty('Выберите платформу и нажмите «Загрузить»','или включите «Все» чтобы загрузить данные по всем магазинам')}</div>
    </div>`;
    this.bindAll();
    this.renderSub();
  }

  // ─── sub bar ──────────────────────────────────────────────────────────────────

  private renderSub() {
    const el = this.el.querySelector('#ad-sub') as HTMLElement;
    if (!el) return;

    const balHtml = [...this.balances.entries()]
      .map(([sid, b]) => {
        const s = this.stores.find(x => x.id === sid);
        const label = this.stores.length > 1 && s ? esc(s.name.slice(0, 12)) + ': ' : '';
        return `<span class="ad-bal">${I.wallet()} ${label}${fmt(b)} ₽</span>`;
      }).join('');

    if (this.tab === 'overview') {
      el.innerHTML = `<div class="ads">
        <div class="ads-l">
          <span style="font-size:12px;color:var(--text2)">Выберите платформу и нажмите «Загрузить» — обзор покажет агрегированные данные</span>
        </div>
        <div class="ads-r">
          <button class="rpr-btn rpr-btn-ghost" id="ad-refresh" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 10px;font-size:12px">
            ${I.refresh()} Обновить
          </button>
        </div>
      </div>`;
      return;
    }

    if (this.tab === 'wb') {
      el.innerHTML = `<div class="ads">
        <div class="ads-l">
          ${balHtml}
          <div style="display:flex;align-items:center;gap:4px" class="ad-period">
            <button class="ad-preset" data-days="7">7д</button>
            <button class="ad-preset" data-days="30">30д</button>
            <button class="ad-preset" data-days="90">90д</button>
            <input type="date" id="ad-from" value="${this.dateFrom}">
            <span class="ad-period-sep">—</span>
            <input type="date" id="ad-to" value="${this.dateTo}">
          </div>
        </div>
        <div class="ads-r">
          <button class="rpr-btn rpr-btn-green" id="ad-create" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 12px;font-size:12px">
            ${I.plus()} Кампания
          </button>
        </div>
      </div>`;
    } else if (this.tab === 'ozon') {
      el.innerHTML = `<div class="ads">
        <div class="ads-l">
          <div class="ad-stabs">
            <button class="ad-stab ${this.ozonSub==='perf'?'on':''}" data-osub="perf">Performance</button>
            <button class="ad-stab ${this.ozonSub==='promo'?'on':''}" data-osub="promo">Акции Ozon</button>
          </div>
          ${balHtml}
        </div>
      </div>`;
    } else {
      // И акции, и буст в ЯМ живут на уровне бизнеса: FBS и FBY одного бизнеса —
      // это один рекламный кабинет, поэтому объясняем это прямо в интерфейсе.
      const businesses = this.ymBusinesses();
      const merged = businesses.length > 0 && businesses.length < this.stores.length;
      const ymScope = merged
        ? `<span class="ad-scope" title="FBS и FBY одного бизнеса используют общую рекламу — данные загружаются один раз">
             ${I.info('', 12)} ${this.stores.length} магазина → ${businesses.length} рекл. кабинет${businesses.length > 1 ? 'а' : ''}
           </span>`
        : '';

      const boostTarget = this.ymSub === 'boost' && this.ymBoostBusiness
        ? `<span class="ad-scope">кабинет: <b>${esc(this.ymBoostBusiness.label)}</b></span>`
        : '';

      el.innerHTML = `<div class="ads">
        <div class="ads-l">
          <div class="ad-stabs">
            <button class="ad-stab ${this.ymSub==='promo'?'on':''}" data-ymsub="promo">Акции</button>
            <button class="ad-stab ${this.ymSub==='boost'?'on':''}" data-ymsub="boost">Буст продаж</button>
          </div>
          ${ymScope}
          ${boostTarget}
        </div>
        ${this.ymSub==='boost'?`<div class="ads-r">
          <button class="rpr-btn rpr-btn-ghost" id="ym-load-bids" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 10px;font-size:12px">
            ${I.refresh()} Загрузить ставки
          </button>
        </div>`:''}
      </div>`;
    }
  }

  // ─── AI stream ────────────────────────────────────────────────────────────────

  private startAiStream(text: string) {
    this.aiStreamText = text;
    this.aiStreamDisplayed = '';
    if (this.aiStreamTimer) { clearInterval(this.aiStreamTimer); this.aiStreamTimer = null; }
    const speed = Math.max(3, Math.floor(text.length / 80));
    this.aiStreamTimer = setInterval(() => {
      const el = document.getElementById('ad-ai-stream-text');
      if (!el) { this.stopAiStream(); return; }
      const remaining = this.aiStreamText.length - this.aiStreamDisplayed.length;
      if (remaining <= 0) { this.stopAiStream(); this.flushBody(); return; }
      const add = Math.min(speed, remaining);
      this.aiStreamDisplayed += this.aiStreamText.slice(this.aiStreamDisplayed.length, this.aiStreamDisplayed.length + add);
      el.textContent = this.aiStreamDisplayed;
    }, 25);
  }

  private stopAiStream() {
    if (this.aiStreamTimer) { clearInterval(this.aiStreamTimer); this.aiStreamTimer = null; }
    this.aiStreamDisplayed = this.aiStreamText;
  }

  // ─── events ───────────────────────────────────────────────────────────────────

  // ─── generic expand toggle ────────────────────────────────────────────────────

  private _toggleExpand(id: string, loader?: () => void) {
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    this.flushBody();
    if (this.expanded.has(id) && loader) loader();
  }

  // ─── click dispatch ───────────────────────────────────────────────────────────

  private bindAll() {
    this.eventsAC.abort();
    this.eventsAC = new AbortController();
    const { signal } = this.eventsAC;

    this.el.addEventListener('click', async (e) => {
      const t   = e.target as HTMLElement;
      const btn = t.closest('button') as HTMLButtonElement | null;
      const th  = t.closest('th[data-sort]') as HTMLElement | null;

      if (th) {
        const k = th.dataset.sort as SortKey;
        if (k === this.sortKey) this.sortDir = (this.sortDir === 1 ? -1 : 1) as 1 | -1;
        else { this.sortKey = k; this.sortDir = -1; }
        this.applyFilter(); return;
      }

      if (!btn) return;

      // ── Navigation: MP tab / sub-tabs / presets / store toggle ──────────────

      const mp = btn.dataset.mp as Tab | undefined;
      if (mp && mp !== this.tab) {
        if (mp !== 'overview' && this.mpAvailableLoaded && !this.mpAvailable[mp as 'wb' | 'ozon' | 'yandex']) {
          showToast('Магазины этой платформы не подключены. Перейдите в Настройки → Магазины.', 'warning');
          return;
        }
        this.tab = mp;
        if (mp === 'overview') {
          // overview just re-renders whatever is already loaded
          this.buildShell();
          this.loadStores();
          return;
        }
        this.campaigns = []; this.filtered = []; this.isFilterActive = false;
        this.expanded.clear(); this.detailCache.clear();
        this.ymBids = []; this.ymRec = []; this.ymBidsSearch = '';
        this.aiHints = []; this.loadErrors = [];
        this.balances.clear(); this.selected.clear();
        this.buildShell(); this.loadStores(); return;
      }

      const os = btn.dataset.osub as OzonSub | undefined;
      if (os && os !== this.ozonSub) {
        this.ozonSub = os; this.campaigns = []; this.filtered = [];
        this.isFilterActive = false;
        this.expanded.clear(); this.detailCache.clear(); this.aiHints = [];
        this.renderSub(); this.renderFilterBar(); this.renderTiles();
        this.renderAi(); this.flushBody(); return;
      }

      const ys = btn.dataset.ymsub as YmSub | undefined;
      if (ys && ys !== this.ymSub) {
        this.ymSub = ys; this.campaigns = []; this.filtered = [];
        this.isFilterActive = false;
        this.ymBids = []; this.ymRec = []; this.ymBidsSearch = ''; this.aiHints = [];
        this.renderSub(); this.renderFilterBar(); this.renderTiles();
        this.renderAi(); this.flushBody(); return;
      }

      if (btn.dataset.days) {
        const d   = Number(btn.dataset.days);
        const now = new Date();
        this.dateTo   = now.toISOString().slice(0, 10);
        this.dateFrom = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
        (this.el.querySelector('#ad-from') as HTMLInputElement).value = this.dateFrom;
        (this.el.querySelector('#ad-to')   as HTMLInputElement).value = this.dateTo;
        return;
      }

      if (btn.id === 'ad-all-tog') {
        const isAll = this.storeId === '';
        if (isAll) {
          this.storeId = this.stores[0]?.id ?? '';
          const sel = this.el.querySelector('#ad-store') as HTMLSelectElement;
          if (sel) sel.value = this.storeId;
        } else { this.storeId = ''; }
        btn.classList.toggle('on', this.storeId === '');
        this.campaigns = []; this.filtered = []; this.isFilterActive = false;
        this.aiHints = []; this.expanded.clear(); this.detailCache.clear();
        this.selected.clear(); this.balances.clear();
        this.renderSub(); this.renderTiles(); this.renderAi(); this.flushBody();
        if (this.tab === 'wb') await this.loadBalance();
        return;
      }

      // ── Named button IDs ─────────────────────────────────────────────────────

      switch (btn.id) {
        case 'ad-refresh':    await this.loadCampaigns(); return;
        case 'ad-create':     this.showCreateDialog(); return;
        case 'ym-load-bids':  await this.loadYmBids(); return;
        case 'ad-help':       this.showHelp(); return;
        case 'ad-ai-tog':     this.aiOpen = !this.aiOpen; this.renderAi(); return;
        case 'ad-ai-rerun': {
          if (this.campaigns.length) {
            this.aiHints = analyzeAi(this.campaigns);
            this.startAiStream(buildAiText(this.campaigns, this.aiHints));
            this.renderFilterBar(); this.renderAi(); this.flushBody();
          } else {
            await this.loadCampaigns();
          }
          return;
        }
        case 'ad-bulk-pause': await this.bulkPause(11); return;
        case 'ad-bulk-resume':await this.bulkPause(9);  return;
        case 'ad-bulk-clear': this.selected.clear(); this.flushBody(); this.renderBulk(); return;
        case 'ym-save-bids':  await this.saveYmBids(); return;
      }

      // ── data-action dispatch ─────────────────────────────────────────────────

      const action = btn.dataset.action;
      const id     = btn.dataset.id ?? '';

      switch (action) {
        case 'check': {
          if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
          this.renderBulk(); this.flushBody(); return;
        }
        case 'edit-budget': {
          this.budgetEditing.add(id); this.flushBody();
          setTimeout(() => (this.el.querySelector(`#ad-bi-${id}`) as HTMLInputElement)?.focus(), 10);
          return;
        }
        case 'cancel-budget':  this.budgetEditing.delete(id); this.flushBody(); return;
        case 'save-budget': {
          const inp = this.el.querySelector(`#ad-bi-${id}`) as HTMLInputElement | null;
          if (inp) await this.saveBudget(id, Number(inp.value));
          return;
        }
        case 'pause':    await this.toggleWb(id, 11); return;
        case 'resume':   await this.toggleWb(id, 9);  return;
        case 'ai-pause': await this.toggleWb(id, 11); return;

        case 'expand':
          this._toggleExpand(id, () => this.loadDetail(id)); return;
        case 'dtab':
          this.wbDetailTab.set(id, btn.dataset.tab as WbDetail); this.flushBody(); return;
        case 'save-bids':     await this.saveBids(id); return;
        case 'save-excluded': await this.saveExcluded(id); return;

        case 'exp-perf':
          this._toggleExpand(id, () => this.loadPerfObjects(id)); return;
        case 'tog-perf':
          await this.toggleOzonPerf(id, btn.dataset.status === 'active'); return;

        case 'exp-promo':
          this._toggleExpand(id, () => this.loadOzonPromoProducts(id, Number(btn.dataset.aid))); return;
        case 'rm-promo-product':
          await this.rmOzonPromoProduct(btn.dataset.pid!, Number(btn.dataset.aid), Number(btn.dataset.prodid)); return;

        case 'exp-ympromo':
          this._toggleExpand(id, () => this.loadYmPromoOffers(id, btn.dataset.promoid!)); return;
        case 'rm-ym-offer':
          await this.rmYmOffer(btn.dataset.promoid!, btn.dataset.offerid!); return;
      }
    }, { signal });

    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement | HTMLInputElement;
      if (t.id === 'ad-store') {
        this.storeId = t.value;
        const allBtn = this.el.querySelector('#ad-all-tog');
        allBtn?.classList.toggle('on', this.storeId === '');
        this.campaigns = []; this.filtered = []; this.isFilterActive = false;
        this.aiHints = []; this.loadErrors = [];
        this.expanded.clear(); this.detailCache.clear(); this.selected.clear();
        this.balances.clear();
        this.renderSub(); this.renderTiles(); this.renderAi(); this.flushBody();
        if (this.tab === 'wb' && this.storeId) this.loadBalance();
      }
      if (t.id === 'ad-from') this.dateFrom = t.value;
      if (t.id === 'ad-to')   this.dateTo   = t.value;
      if (t.id === 'adf-status') { this.filterStatus = (t as HTMLSelectElement).value; this.applyFilter(); }
      if (t.id === 'adf-sort') {
        const val = (t as HTMLSelectElement).value;
        const [k, d] = val.split(':');
        this.sortKey = k as SortKey; this.sortDir = (d === 'asc' ? 1 : -1) as 1 | -1;
        this.applyFilter();
      }
    }, { signal });

    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'adf-search')   { this.searchQ = t.value; this.applyFilter(); }
      if (t.id === 'boost-search') {
        this.ymBidsSearch = t.value;
        // Полный ре-рендер сбросил бы фокус и каретку прямо во время набора —
        // восстанавливаем их после перерисовки.
        const pos = t.selectionStart;
        this.flushBody();
        const next = this.el.querySelector<HTMLInputElement>('#boost-search');
        if (next) { next.focus(); if (pos != null) next.setSelectionRange(pos, pos); }
      }
      if (t.dataset.boostid) {
        const sku = t.dataset.boostid;
        const cur = this.ymBids.find(b => b.sku === sku);
        const pct = t.value.trim() ? Number(t.value.replace(',', '.')) : null;
        const changed = pct !== null && !isNaN(pct) && Math.round(pct * 100) !== (cur?.bid ?? 0);
        t.classList.toggle('ch', changed);
        if (t.value.trim()) this.ymBidEdits.set(sku, t.value);
        else this.ymBidEdits.delete(sku);
      }
    }, { signal });

    this.el.addEventListener('keydown', async (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.id?.startsWith('ad-bi-')) return;
      const id = t.id.replace('ad-bi-', '');
      if (e.key === 'Enter')  { e.preventDefault(); await this.saveBudget(id, Number(t.value)); }
      if (e.key === 'Escape') { this.budgetEditing.delete(id); this.flushBody(); }
    }, { signal });
  }

  // ─── render helpers ───────────────────────────────────────────────────────────

  private flushBody() {
    const el = this.el.querySelector('#ad-body');
    if (el) el.innerHTML = this.renderBody();
  }

  private renderTiles() {
    const el = this.el.querySelector('#ad-tiles') as HTMLElement;
    if (!el) return;
    if (!this.campaigns.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const c = this.filtered.length ? this.filtered : this.campaigns;
    const budget  = c.reduce((s, x) => s + x.budget, 0);
    const spent   = c.reduce((s, x) => s + x.spent,  0);
    const revenue = c.reduce((s, x) => s + x.revenue,0);
    const orders  = c.reduce((s, x) => s + x.orders, 0);
    const views   = c.reduce((s, x) => s + x.views,  0);
    const clicks  = c.reduce((s, x) => s + x.clicks, 0);
    const roi     = spent > 0 ? (revenue - spent) / spent * 100 : 0;

    const drr = drrVal(spent, revenue);
    const drrColor = drr === null ? '#71717a' : drr < 15 ? '#22c55e' : drr < 30 ? '#f59e0b' : '#ef4444';
    const tiles = this.tab === 'wb'
      ? [
          ['Бюджет/д',  fmt(Math.round(budget))  + ' ₽', '#818cf8'],
          ['Потрачено', fmt(Math.round(spent))    + ' ₽', '#f59e0b'],
          ['Выручка',   fmt(Math.round(revenue))  + ' ₽', '#22c55e'],
          ['Заказы',    String(orders),                    '#3b82f6'],
          ['ДРР',       drr !== null ? drr.toFixed(1) + '%' : '—', drrColor],
          ['ROI',       roiStr(roi), roi >= 0 ? '#22c55e' : '#ef4444'],
        ]
      : [
          ['Всего',    String(c.length), '#818cf8'],
          ['Активных', String(c.filter(x => x.status==='active').length), '#22c55e'],
          ['Показы',   fmt(views),   '#3b82f6'],
          ['Клики',    fmt(clicks),  '#a78bfa'],
          ['Расход',   fmt(spent) + ' ₽', '#f59e0b'],
          ['CTR',      ctr(views, clicks), '#6366f1'],
        ];
    el.innerHTML = `<div class="ad-tiles">${tiles.map(([l,v,col]) =>
      `<div class="ad-tile"><div class="ad-tile-l">${l}</div>
       <div class="ad-tile-v" style="color:${col}">${v}</div></div>`).join('')}</div>`;
  }

  private renderFilterBar() {
    const el = this.el.querySelector('#ad-filter') as HTMLElement;
    if (!el) return;
    if (!this.campaigns.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const aiLevel = this.aiHints.some(h => h.level==='danger') ? 'has-danger'
      : this.aiHints.some(h => h.level==='warn') ? 'has-warn'
      : this.aiHints.length ? 'has-ok' : '';
    el.innerHTML = `<div class="adf">
      <input class="adf-search" id="adf-search" placeholder="Поиск по названию…" value="${esc(this.searchQ)}">
      <select class="adf-status" id="adf-status">
        <option value="all" ${this.filterStatus==='all'?'selected':''}>Все статусы</option>
        <option value="active"   ${this.filterStatus==='active'?'selected':''}>Активные</option>
        <option value="paused"   ${this.filterStatus==='paused'?'selected':''}>На паузе</option>
        <option value="inactive" ${this.filterStatus==='inactive'?'selected':''}>Неактивные</option>
      </select>
      <select class="adf-sort" id="adf-sort">
        <option value="spent:-1"  ${this.sortKey==='spent'&&this.sortDir===-1?'selected':''}>Расход ↓</option>
        <option value="roi:-1"    ${this.sortKey==='roi'  &&this.sortDir===-1?'selected':''}>ROI ↓</option>
        <option value="views:-1"  ${this.sortKey==='views'&&this.sortDir===-1?'selected':''}>Показы ↓</option>
        <option value="clicks:-1" ${this.sortKey==='clicks'&&this.sortDir===-1?'selected':''}>Клики ↓</option>
        <option value="orders:-1" ${this.sortKey==='orders'&&this.sortDir===-1?'selected':''}>Заказы ↓</option>
        <option value="name:1"    ${this.sortKey==='name' &&this.sortDir===1?'selected':''}>Название А-Я</option>
      </select>
      ${aiLevel ? `<button class="adf-ai ${aiLevel}" id="ad-ai-tog">
        ⚡ Диагностика (${this.aiHints.length})
      </button>` : ''}
    </div>`;
  }

  private renderAi() {
    const el = this.el.querySelector('#ad-ai') as HTMLElement;
    if (!el) return;
    if (!this.aiHints.length || !this.aiOpen) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = `<div class="ad-ai-panel">${this.aiHints.map(h => {
      const cls = h.level === 'danger' ? 'd' : h.level === 'warn' ? 'w' : 'o';
      const col  = h.level === 'danger' ? '#ef4444' : h.level === 'warn' ? '#f59e0b' : '#22c55e';
      return `<div class="ad-ai-row ${cls}">
        <div class="ad-ai-dot" style="background:${col}"></div>
        <div style="flex:1">
          <div style="font-weight:700;color:var(--text);margin-bottom:2px;font-size:11px">${esc(h.campaignName)}</div>
          <div style="color:var(--text2)">${h.message}</div>
        </div>
        ${h.action==='pause'&&this.tab==='wb' ? `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 8px;font-size:11px;flex-shrink:0" data-action="ai-pause" data-id="${h.campaignId}">⏸ Пауза</button>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  private renderBulk() {
    const el = this.el.querySelector('#ad-bulk') as HTMLElement;
    if (!el) return;
    if (!this.selected.size || this.tab !== 'wb') { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = `<div class="ad-bulk">
      <span>Выбрано: ${this.selected.size}</span>
      <button class="rpr-btn rpr-btn-ghost" id="ad-bulk-pause"  style="height:26px;padding:0 10px;font-size:11px">⏸ Пауза</button>
      <button class="rpr-btn rpr-btn-ghost" id="ad-bulk-resume" style="height:26px;padding:0 10px;font-size:11px">▶ Запустить</button>
      <button class="rpr-btn rpr-btn-ghost" id="ad-bulk-clear"  style="height:26px;padding:0 10px;font-size:11px">✕ Сбросить</button>
    </div>`;
  }

  private applyFilter() {
    this.isFilterActive = this.searchQ.trim() !== '' || this.filterStatus !== 'all';
    let data = [...this.campaigns];
    if (this.searchQ.trim()) {
      const q = this.searchQ.toLowerCase();
      data = data.filter(c => c.name.toLowerCase().includes(q));
    }
    if (this.filterStatus !== 'all') {
      data = data.filter(c => c.status === this.filterStatus);
    }
    const k = this.sortKey;
    data.sort((a, b) => {
      const va = (a as any)[k] ?? 0;
      const vb = (b as any)[k] ?? 0;
      if (typeof va === 'string') return this.sortDir * va.localeCompare(vb);
      return this.sortDir * (va - vb);
    });
    this.filtered = data;
    this.renderTiles();
    this.flushBody();
  }

  // ─── loading stores ───────────────────────────────────────────────────────────

  private async loadStores() {
    const sel = this.el.querySelector('#ad-store') as HTMLSelectElement | null;
    try {
      if (this.tab === 'wb')     this.stores = await wbDb.getStores();
      else if (this.tab === 'ozon') this.stores = await ozonDb.getStores();
      else                           this.stores = await yandexDb.getStores();
    } catch { this.stores = []; }

    if (!sel) return;
    if (!this.stores.length) {
      sel.innerHTML = '<option value="">Нет магазинов</option>';
      this.storeId = '';
      this.flushBody(); return;
    }

    // Строим лейблы с учётом типа МП
    const storeLabel = (s: Store): string => {
      let label = s.name;
      if (this.tab === 'yandex') {
        const pt = (s as any).placement_type as string | undefined;
        if (pt) label += ` [${pt}]`;
      }
      return label;
    };

    // Детектируем дубли (одинаковый api_key/client_id/business_id)
    const hasDuplicates = this.tab === 'wb'
      ? new Set(this.stores.map(s => s.api_key)).size < this.stores.length
      : this.tab === 'ozon'
        ? new Set(this.stores.map(s => s.client_id)).size < this.stores.length
        : false;

    sel.innerHTML = this.stores.map(s =>
      `<option value="${esc(s.id)}">${esc(storeLabel(s))}</option>`).join('');

    if (!this.storeId && this.stores.length === 1) {
      this.storeId = this.stores[0].id;
      sel.value = this.storeId;
    } else if (this.storeId) {
      sel.value = this.storeId;
    }
    const allBtn = this.el.querySelector('#ad-all-tog');
    allBtn?.classList.toggle('on', this.storeId === '');

    if (hasDuplicates) {
      showToast('Обнаружены магазины с одинаковым API-ключом. Данные будут загружены один раз.', 'warning');
    }

    if (this.tab === 'wb') await this.loadBalance();
    this.flushBody();
  }

  private async loadMpAvailability(): Promise<void> {
    try {
      const [wb, ozon, ym] = await Promise.allSettled([
        wbDb.getStores(),
        ozonDb.getStores(),
        yandexDb.getStores(),
      ]);
      this.mpAvailable = {
        wb:     wb.status === 'fulfilled' && wb.value.length > 0,
        ozon:   ozon.status === 'fulfilled' && ozon.value.length > 0,
        yandex: ym.status === 'fulfilled' && ym.value.length > 0,
      };
    } catch {
      this.mpAvailable = { wb: true, ozon: true, yandex: true };
    }
    this.mpAvailableLoaded = true;
    this.updateMpTabStates();
    // If current tab became unavailable — redirect to overview
    if (this.tab !== 'overview' && !this.mpAvailable[this.tab as 'wb' | 'ozon' | 'yandex']) {
      this.tab = 'overview';
      this.buildShell(); this.loadStores();
    }
  }

  private updateMpTabStates(): void {
    const mps: Array<'wb' | 'ozon' | 'yandex'> = ['wb', 'ozon', 'yandex'];
    for (const mp of mps) {
      const btn = this.el.querySelector<HTMLButtonElement>(`[data-mp="${mp}"]`);
      if (!btn) continue;
      const available = this.mpAvailable[mp];
      btn.disabled = !available;
      btn.classList.toggle('ad-mptab-locked', !available);
      btn.title = available ? '' : 'Магазины не подключены — откройте Настройки';
    }
  }

  private async loadBalance() {
    if (this.tab !== 'wb') return;
    this.balances.clear();
    const targets = this.storeId
      ? this.stores.filter(s => s.id === this.storeId)
      : this.stores;
    await Promise.allSettled(targets.map(async (s: any) => {
      const b = await getWbAdBalance(s.api_key);
      if (b > 0) this.balances.set(s.id, b);
    }));
    this.renderSub();
  }

  // ─── load campaigns ───────────────────────────────────────────────────────────

  /** Дедуплицирует stores по уникальному идентификатору аккаунта чтобы не дублировать данные. */
  private deduplicateStores(stores: Store[]): Store[] {
    // WB: один api_key = один рекламный кабинет
    if (this.tab === 'wb') {
      const seen = new Set<string>();
      return stores.filter(s => {
        if (seen.has(s.api_key)) return false;
        seen.add(s.api_key); return true;
      });
    }
    // Ozon: один client_id = один Performance-кабинет
    if (this.tab === 'ozon') {
      const seen = new Set<string>();
      return stores.filter(s => {
        const key = s.client_id ?? s.api_key;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }
    // ЯМ: и Акции, и Буст работают на уровне БИЗНЕСА. FBS и FBY одного бизнеса —
    // это один рекламный кабинет, поэтому грузим один раз на business_id.
    if (this.tab === 'yandex') {
      const seen = new Set<number>();
      return stores.filter(s => {
        const bid = Number(s.business_id);
        if (!bid || seen.has(bid)) return false;
        seen.add(bid); return true;
      });
    }
    return stores;
  }

  /** Уникальные бизнесы ЯМ (FBS+FBY одного бизнеса = один рекламный кабинет). */
  private ymBusinesses(): Array<{ businessId: number; apiKey: string; label: string }> {
    const map = new Map<number, { businessId: number; apiKey: string; label: string }>();
    for (const s of this.stores) {
      const bid = Number(s.business_id);
      if (!bid) continue;
      const existing = map.get(bid);
      if (existing) {
        // Тот же бизнес под другой схемой — показываем оба размещения в подписи
        const pt = (s as any).placement_type as string | undefined;
        if (pt && !existing.label.includes(pt)) existing.label += ` + ${pt}`;
      } else {
        const pt = (s as any).placement_type as string | undefined;
        map.set(bid, { businessId: bid, apiKey: s.api_key, label: s.name + (pt ? ` [${pt}]` : '') });
      }
    }
    return [...map.values()];
  }

  private async loadCampaigns() {
    const rawTargets = this.storeId
      ? this.stores.filter(s => s.id === this.storeId)
      : this.stores;
    const targets = this.deduplicateStores(rawTargets);
    if (!targets.length) { showToast('Нет магазинов', 'warning'); return; }

    this.loading = true; this.campaigns = []; this.filtered = [];
    this.isFilterActive = false; this.searchQ = ''; this.filterStatus = 'all';
    this.loadErrors = [];
    this.expanded.clear(); this.detailCache.clear(); this.aiHints = [];
    this.selected.clear();
    this.renderFilterBar(); this.renderTiles(); this.renderAi(); this.renderBulk();
    this.flushBody();

    try {
      const results = await Promise.allSettled(targets.map(s => this.loadForStore(s)));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          this.campaigns.push(...r.value);
        } else {
          const msg = (r.reason as any)?.message ?? String(r.reason);
          this.loadErrors.push({ storeName: targets[i].name, message: msg });
          console.warn('[Ads] store load failed:', r.reason);
        }
      }
      this.aiHints = analyzeAi(this.campaigns);
      this.aiStreamDisplayed = '';
      this.applyFilter();
      this.renderFilterBar();
      this.renderAi();
      this.renderBulk();
      if (this.campaigns.length) {
        const aiText = buildAiText(this.campaigns, this.aiHints);
        this.startAiStream(aiText);
        showToast(`Загружено: ${this.campaigns.length}`, 'success');
      } else if (this.loadErrors.length) {
        showToast(`Ошибка загрузки: ${this.loadErrors[0].message.slice(0, 80)}`, 'error');
      }
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.flushBody();
    }
  }

  private async loadForStore(store: any): Promise<Campaign[]> {
    if (this.tab === 'wb')     return this._wbStore(store);
    if (this.tab === 'ozon')   return this.ozonSub === 'perf' ? this._ozonPerfStore(store) : this._ozonPromoStore(store);
    if (this.ymSub === 'boost') return [];
    return this._ymPromoStore(store);
  }

  private async _wbStore(store: any): Promise<Campaign[]> {
    const list = await getWbCampaigns(store.api_key);
    const ids = list.map((c: any) => ({ id: c.advertId, interval: { begin: this.dateFrom, end: this.dateTo } }));
    const fullStats = ids.length ? await getWbFullStats(store.api_key, ids) : [];
    const statMap = new Map<number, any>();
    for (const r of fullStats) statMap.set(r.advertId ?? r.id, r);

    return list.map((c: any) => {
      const st = statMap.get(c.advertId) ?? {};
      const views = st.views ?? st.shows ?? 0;
      const clicks = st.clicks ?? 0;
      const spent  = st.sum ?? 0;
      const orders = st.orders ?? 0;
      const revenue = orders * (st.avgPrice ?? 0);
      return {
        id: c.advertId, storeId: store.id, storeName: store.name,
        name: c.name ?? `Кампания ${c.advertId}`,
        status: c.status === 9 ? 'active' : c.status === 11 ? 'paused' : 'stopped',
        type: c.type === 8 ? 'Авто' : c.type === 6 ? 'Поиск' : c.type === 7 ? 'Каталог' : 'Карточка',
        typeCode: c.type, budget: c.dailyBudget ?? 0,
        spent, clicks, views, orders, revenue,
        roi: spent > 0 ? (revenue - spent) / spent * 100 : 0,
      } as Campaign;
    });
  }

  private async _ozonPerfStore(store: any): Promise<Campaign[]> {
    const list = await ozonPerfApi.getCampaigns(store.client_id, store.api_key);
    const ids = list.map((c: any) => String(c.id));
    const stats = ids.length
      ? await ozonPerfApi.getStats(store.client_id, store.api_key, { campaigns: ids, dateFrom: this.dateFrom, dateTo: this.dateTo })
      : [];
    const sm = new Map<string, any>();
    for (const s of stats) sm.set(String(s.campaign?.id ?? s.id), s);
    return list.map((c: any) => {
      const st = sm.get(String(c.id)) ?? {};
      return {
        id: String(c.id), storeId: store.id, storeName: store.name,
        name: c.title ?? c.name ?? `Кампания ${c.id}`,
        status: c.state === 'RUNNING' || c.state === 'ACTIVE' ? 'active' : c.state === 'STOPPED' ? 'paused' : 'inactive',
        type: c.advObjectType ?? c.type ?? 'SKU',
        budget: c.dailyBudget ?? c.budget ?? 0,
        spent: st.moneySpent ?? st.money_spent ?? 0,
        clicks: st.clicks ?? 0, views: st.views ?? st.impressions ?? 0,
        orders: st.orders ?? 0, revenue: 0, roi: 0,
      } as Campaign;
    });
  }

  private async _ozonPromoStore(store: any): Promise<Campaign[]> {
    const list = await ozonApi.getPromotions({ client_id: store.client_id, api_key: store.api_key });
    return list.map((p: any) => ({
      id: String(p.action_id ?? p.id), storeId: store.id, storeName: store.name,
      name: p.title ?? p.name ?? 'Акция Ozon',
      status: p.is_active ? 'active' : 'inactive',
      type: p.action_type ?? 'Промо',
      budget: 0, spent: 0, clicks: 0, views: 0, orders: 0, revenue: 0, roi: 0,
      actionId: p.action_id ?? p.id,
      dateFrom: p.date_start, dateTo: p.date_end,
    }) as Campaign);
  }

  private async _ymPromoStore(store: any): Promise<Campaign[]> {
    const businessId = store.business_id ? Number(store.business_id) : 0;
    const list = await getYandexPromos(store.api_key, businessId);
    return list.map((p: any) => ({
      id: p.id, storeId: store.id, storeName: store.name,
      name: p.name ?? 'Акция',
      status: p.status === 'ACTIVE' ? 'active' : p.status === 'UPCOMING' ? 'upcoming' : 'inactive',
      type: p.promoType ?? 'PROMO',
      budget: 0, spent: 0, clicks: 0, views: 0, orders: 0, revenue: 0, roi: 0,
      promoId: p.id, dateFrom: p.startDate, dateTo: p.endDate,
    }) as Campaign);
  }

  // ─── render body ──────────────────────────────────────────────────────────────

  private renderOverview(): string {
    const campaigns = this.campaigns;
    const totalSpend = campaigns.reduce((s, c) => s + c.spent, 0);
    const totalRev   = campaigns.reduce((s, c) => s + c.revenue, 0);
    const totalActive = campaigns.filter(c => c.status === 'active').length;
    const drr = drrVal(totalSpend, totalRev);
    const drrDisplay = drr !== null
      ? `<span style="color:${drr < 15 ? '#22c55e' : drr < 30 ? '#f59e0b' : '#ef4444'}">${drr.toFixed(1)}%</span>`
      : `<span style="color:var(--text3)">—</span>`;

    const kpiHtml = `<div class="ad-ov-kpi">
      <div class="ad-ov-kpi-tile">
        <div class="ad-ov-kpi-l">Расход</div>
        <div class="ad-ov-kpi-v" style="color:#f59e0b">${totalSpend ? fmt(Math.round(totalSpend)) + ' ₽' : '—'}</div>
      </div>
      <div class="ad-ov-kpi-tile">
        <div class="ad-ov-kpi-l">Выручка</div>
        <div class="ad-ov-kpi-v" style="color:#22c55e">${totalRev ? fmt(Math.round(totalRev)) + ' ₽' : '—'}</div>
      </div>
      <div class="ad-ov-kpi-tile">
        <div class="ad-ov-kpi-l">ДРР</div>
        <div class="ad-ov-kpi-v">${drrDisplay}</div>
      </div>
      <div class="ad-ov-kpi-tile">
        <div class="ad-ov-kpi-l">Активных</div>
        <div class="ad-ov-kpi-v" style="color:#818cf8">${totalActive}</div>
      </div>
    </div>`;

    const noDanger = this.aiHints.filter(h => h.level === 'danger').length;
    const noWarn   = this.aiHints.filter(h => h.level === 'warn').length;
    const noOk     = this.aiHints.filter(h => h.level === 'ok').length;
    const badgeCol = noDanger ? '#ef4444' : noWarn ? '#f59e0b' : '#22c55e';
    const badgeBg  = noDanger ? 'rgba(239,68,68,.12)' : noWarn ? 'rgba(245,158,11,.12)' : 'rgba(34,197,94,.1)';
    const badgeTxt = noDanger ? `${noDanger} критично` : noWarn ? `${noWarn} предупреждений` : noOk ? `всё хорошо` : '—';

    const streamDone = !this.aiStreamTimer;
    const streamHtml = `<div class="ad-ai-full">
      <div class="ad-ai-full-hd">
        <div class="ad-ai-full-title">
          ⚡ ИИ-анализ рекламы
          ${this.aiHints.length ? `<span class="ad-ai-full-badge" style="background:${badgeBg};color:${badgeCol}">${badgeTxt}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${!streamDone ? `<span style="font-size:11px;color:var(--text3)">анализирует…</span>` : ''}
          <button class="rpr-btn rpr-btn-ghost" id="ad-ai-rerun" style="height:24px;padding:0 8px;font-size:11px">↺ Перезапустить</button>
        </div>
      </div>
      <div class="ad-ai-stream-wrap">
        <span id="ad-ai-stream-text">${this.aiStreamDisplayed || (!this.campaigns.length ? 'Загрузите кампании любой платформы — ИИ проанализирует показатели и предложит действия.' : '')}</span>${!streamDone ? '<span class="ad-ai-stream-cursor"></span>' : ''}
      </div>
      ${this.aiHints.length ? `<div class="ad-ai-actions">
        ${this.aiHints.map(h => {
          const cls = h.level === 'danger' ? 'd' : h.level === 'warn' ? 'w' : 'o';
          const col = h.level === 'danger' ? '#ef4444' : h.level === 'warn' ? '#f59e0b' : '#22c55e';
          const actionBtn = h.action === 'pause' && this.tab !== 'ozon' && this.tab !== 'yandex'
            ? `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 9px;font-size:11px;flex-shrink:0;color:#ef4444" data-action="ai-pause" data-id="${h.campaignId}">⏸ Пауза</button>`
            : '';
          return `<div class="ad-ai-action-row ${cls}">
            <div class="ad-ai-action-dot" style="background:${col}"></div>
            <div style="flex:1">
              <div style="font-weight:700;color:var(--text);font-size:11px;margin-bottom:2px">${esc(h.campaignName)}</div>
              <div style="color:var(--text2)">${h.message}</div>
            </div>
            ${actionBtn}
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>`;

    const hint = !campaigns.length
      ? `<div style="font-size:12px;color:var(--text3);text-align:center;padding:12px 0">
          Переключитесь на вкладку Wildberries, Ozon или Яндекс.Маркет и нажмите «Загрузить» чтобы увидеть данные здесь.
        </div>`
      : '';

    return `<div class="ad-ov">
      ${kpiHtml}
      ${hint}
      ${streamHtml}
    </div>`;
  }

  private renderBody(): string {
    if (this.tab === 'overview') return this.renderOverview();
    if (this.loading) return skeleton(6);
    if (!this.stores.length)
      return empty('Нет магазинов', 'Добавьте магазин в раздел «Магазины» и вернитесь сюда');

    if (!this.campaigns.length && this.loadErrors.length) {
      const scopeHint = this.tab === 'wb'
        ? 'Токен WB должен иметь право <b>«Реклама»</b> (создаётся отдельно в ЛК WB → Настройки → Доступ к API → Рекламная статистика).'
        : this.tab === 'ozon'
        ? 'Клиент Ozon Performance использует отдельный ключ — проверьте <b>client_id</b> и <b>api_key</b> в настройках магазина.'
        : 'Для ЯМ нужен <b>business_id</b> в настройках магазина (ЯМ → Настройки → О магазине → Идентификатор бизнеса).';
      return `<div style="padding:20px;display:flex;flex-direction:column;gap:12px">
        ${this.loadErrors.map(e => `
          <div style="background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.25);border-radius:12px;padding:16px">
            <div style="font-size:12px;font-weight:800;color:#ef4444;margin-bottom:6px">
              ⚠️ Ошибка загрузки: ${esc(e.storeName)}
            </div>
            <div style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:8px;word-break:break-word">${esc(e.message)}</div>
            <div style="font-size:11px;color:var(--text3);line-height:1.6">${scopeHint}</div>
          </div>`).join('')}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="rpr-btn rpr-btn-ghost" id="ad-refresh" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 12px;font-size:12px">
            ${I.refresh()} Попробовать снова
          </button>
          <button class="ad-help-btn" id="ad-help" style="width:auto;height:28px;border-radius:8px;padding:0 12px;font-size:12px">
            ? Инструкция
          </button>
        </div>
      </div>`;
    }

    if (!this.campaigns.length && !this.loading)
      return empty('Нажмите «Загрузить»', 'Выберите магазин или включите «Все», затем нажмите кнопку «Загрузить»');
    const data = this.isFilterActive ? this.filtered : this.campaigns;
    if (!data.length) return empty('Ничего не найдено', 'Попробуйте изменить фильтр или сбросить поиск');

    const multiStore = !this.storeId || this.stores.length > 1;

    if (this.tab === 'wb')    return this.renderWbTable(data, multiStore);
    if (this.tab === 'ozon')  return this.ozonSub === 'perf'
      ? this.renderPerfTable(data, multiStore)
      : this.renderPromoTable(data, multiStore, 'ozon');
    // yandex
    if (this.ymSub === 'boost') return this.renderBoostTable();
    return this.renderPromoTable(data, multiStore, 'ym');
  }

  // ─── WB table ────────────────────────────────────────────────────────────────

  private renderWbTable(data: Campaign[], ms: boolean): string {
    const rows = data.map(c => {
      const key = String(c.id);
      const isExp = this.expanded.has(key);
      const isSel = this.selected.has(key);
      const dtab  = this.wbDetailTab.get(key) ?? 'bids';
      const isAuto = c.typeCode === 8;
      const roiCol = c.roi >= 0 ? '#22c55e' : '#ef4444';
      const isBE   = this.budgetEditing.has(key);

      const budCell = isBE
        ? `<div class="ad-bud">
            <input class="ad-bud-inp" id="ad-bi-${key}" type="number" min="50" value="${c.budget}">
            <button class="ad-bok" data-action="save-budget" data-id="${key}">${I.check()}</button>
            <button class="ad-bx"  data-action="cancel-budget" data-id="${key}">✕</button>
          </div>`
        : `<div class="ad-bud">
            <span class="ad-bud-v">${c.budget ? fmt(c.budget) + ' ₽' : '—'}</span>
            <button class="ad-bud-pen" data-action="edit-budget" data-id="${key}" style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center">${I.edit()}</button>
          </div>`;

      const isLocked = this.opInProgress.has(key);
      const pauseBtn = isLocked
        ? `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 7px;font-size:11px;opacity:.4" disabled>…</button>`
        : c.status === 'active'
          ? `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 7px;font-size:11px" data-action="pause"  data-id="${key}">⏸</button>`
          : `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 7px;font-size:11px" data-action="resume" data-id="${key}">▶</button>`;

      const expBtn = `<button class="ad-exp ${isExp?'on':''}" data-action="expand" data-id="${key}">
        <span class="ad-chev">${I.chevronDown()}</span></button>`;

      const cb = `<input type="checkbox" class="ad-cb" data-action="check" data-id="${key}" ${isSel?'checked':''} style="pointer-events:none">`;

      const main = `<tr class="adr ${isSel?'sel':''} ${isExp?'exp':''}">
        <td style="width:32px"><button data-action="check" data-id="${key}" style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center">${cb}</button></td>
        ${ms ? `<td class="nm" style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.storeName)}</td>` : ''}
        <td style="font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim nm">${esc(c.type)}</td>
        <td>${budCell}</td>
        <td class="r dim">${c.spent ? fmt(Math.round(c.spent)) + ' ₽' : '—'}</td>
        <td class="r dim">${fmt(c.views)}</td>
        <td class="r dim">${fmt(c.clicks)}</td>
        <td class="r dim">${c.orders}</td>
        <td class="r">${drrBadge(c.spent, c.revenue)}</td>
        <td class="r" style="font-weight:700;color:${roiCol}">${roiStr(c.roi)}</td>
        <td style="white-space:nowrap">${pauseBtn} ${expBtn}</td>
      </tr>`;

      if (!isExp) return main;

      const detail = this.detailLoading.has(key) ? skeleton(2) : this._wbDetail(c, dtab, isAuto);
      const dtabHtml = `<div class="ad-dtabs">
        <button class="ad-dtab ${dtab==='bids'?'on':''}" data-action="dtab" data-id="${key}" data-tab="bids">Ставки по товарам</button>
        <button class="ad-dtab ${dtab==='keywords'?'on':''}" data-action="dtab" data-id="${key}" data-tab="keywords">
          ${isAuto ? 'Минус-слова' : 'Ключевые слова'}</button>
      </div>`;

      const detRow = `<tr class="ad-drow"><td colspan="${ms?13:12}">
        <div class="ad-dinn">${dtabHtml}${detail}</div>
      </td></tr>`;

      return main + detRow;
    }).join('');

    return `<table class="adt"><thead><tr>
      <th style="width:32px"></th>
      ${ms?'<th>Магазин</th>':''}
      <th data-sort="name">Кампания</th>
      <th>Статус</th>
      <th>Тип</th>
      <th data-sort="budget">Бюджет/д</th>
      <th class="r" data-sort="spent">Потрачено</th>
      <th class="r" data-sort="views">Показы</th>
      <th class="r" data-sort="clicks">Клики</th>
      <th class="r" data-sort="orders">Заказы</th>
      <th class="r">ДРР</th>
      <th class="r" data-sort="roi">ROI</th>
      <th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  private _wbDetail(c: Campaign, tab: WbDetail, isAuto: boolean): string {
    const key = String(c.id);
    const d = this.detailCache.get(key);
    if (!d) return `<p style="font-size:12px;color:var(--text2)">Данные загружаются…</p>`;

    if (tab === 'bids') {
      const nms: any[] = d.params?.nms ?? d.nms ?? [];
      if (!nms.length) return `<p style="font-size:12px;color:var(--text2)">Нет товаров в кампании.</p>`;
      return `<div style="overflow-x:auto"><table class="adm">
        <thead><tr><th>nmId</th><th>Текущая ставка</th><th>Новая ставка, ₽</th></tr></thead>
        <tbody>${nms.map((n: any) =>
          `<tr><td><code style="font-size:11px;color:var(--accent)">${n.nm ?? n.nmId ?? n}</code></td>
           <td>${n.bid ?? n.cpm ?? '—'} ₽</td>
           <td><input type="number" min="1" class="ad-bi" style="width:100px"
             data-bidsave="${key}" data-nm="${n.nm ?? n.nmId ?? n}" placeholder="Ставка"></td>
          </tr>`).join('')}
        </tbody></table></div>
        <div style="margin-top:10px">
          <button class="rpr-btn rpr-btn-green" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 12px;font-size:12px"
            data-action="save-bids" data-id="${key}">${I.check()} Сохранить ставки</button>
        </div>`;
    }

    if (isAuto) {
      const excl: string[] = d.autoParams?.excludedKeywords ?? [];
      return `<p style="font-size:12px;color:var(--text2);margin-bottom:6px">По одному слову на строку:</p>
        <textarea class="ad-minus" id="ad-excl-${key}">${excl.join('\n')}</textarea>
        <div style="margin-top:8px">
          <button class="rpr-btn rpr-btn-green" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 12px;font-size:12px"
            data-action="save-excluded" data-id="${key}">${I.check()} Сохранить</button>
        </div>`;
    }

    const kws: any[] = d.keywords ?? [];
    if (!kws.length) return `<p style="font-size:12px;color:var(--text2)">Нет ключевых слов.</p>`;
    return `<div style="overflow-x:auto"><table class="adm">
      <thead><tr><th>Слово</th><th class="r">Клики</th><th class="r">Показы</th><th class="r">Расход</th></tr></thead>
      <tbody>${kws.map((k: any) =>
        `<tr><td>${esc(k.keyword ?? k.word ?? '')}</td>
         <td class="r">${k.clicks ?? 0}</td>
         <td class="r">${fmt(k.views ?? k.shows ?? 0)}</td>
         <td class="r">${k.sum ? fmt(k.sum) + ' ₽' : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ─── Ozon Perf table ──────────────────────────────────────────────────────────

  private renderPerfTable(data: Campaign[], ms: boolean): string {
    const rows = data.map(c => {
      const key = String(c.id);
      const isExp = this.expanded.has(key);
      const togBtn = c.status === 'active'
        ? `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 7px;font-size:11px" data-action="tog-perf" data-id="${key}" data-status="active">⏸</button>`
        : `<button class="rpr-btn rpr-btn-ghost" style="padding:2px 7px;font-size:11px" data-action="tog-perf" data-id="${key}" data-status="inactive">▶</button>`;
      const expBtn = `<button class="ad-exp ${isExp?'on':''}" data-action="exp-perf" data-id="${key}">
        <span class="ad-chev">${I.chevronDown()}</span></button>`;

      const main = `<tr class="adr ${isExp?'exp':''}">
        ${ms?`<td class="nm">${esc(c.storeName)}</td>`:''}
        <td style="font-weight:600">${esc(c.name)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim nm">${esc(c.type)}</td>
        <td class="r dim">${c.budget?fmt(c.budget)+' ₽':'—'}</td>
        <td class="r dim">${c.spent?fmt(c.spent)+' ₽':'—'}</td>
        <td class="r dim">${fmt(c.views)}</td>
        <td class="r dim">${fmt(c.clicks)}</td>
        <td class="r dim">${ctr(c.views,c.clicks)}</td>
        <td style="white-space:nowrap">${togBtn} ${expBtn}</td>
      </tr>`;

      if (!isExp) return main;
      const detail = this.detailLoading.has(key) ? skeleton(2) : this._perfObjects(key);
      return main + `<tr class="ad-drow"><td colspan="${ms?10:9}">
        <div class="ad-dinn">${detail}</div>
      </td></tr>`;
    }).join('');

    return `<table class="adt"><thead><tr>
      ${ms?'<th>Магазин</th>':''}
      <th data-sort="name">Кампания</th><th>Статус</th><th>Тип</th>
      <th class="r" data-sort="budget">Бюджет</th>
      <th class="r" data-sort="spent">Потрачено</th>
      <th class="r" data-sort="views">Показы</th>
      <th class="r" data-sort="clicks">Клики</th>
      <th class="r">CTR</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  private _perfObjects(key: string): string {
    const obs: any[] = this.detailCache.get(key) ?? [];
    if (!obs.length) return `<p style="font-size:12px;color:var(--text2)">Нет объявлений.</p>`;
    return `<div style="overflow-x:auto"><table class="adm">
      <thead><tr><th>SKU</th><th>Статус</th><th class="r">Ставка</th></tr></thead>
      <tbody>${obs.map((o: any) =>
        `<tr><td><code style="font-size:11px;color:var(--accent)">${o.sku??o.id??'—'}</code></td>
         <td>${statusChip(o.state==='ACTIVE'?'active':'inactive')}</td>
         <td class="r">${o.bid?fmt(o.bid)+' ₽':'—'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ─── Promo table (Ozon + YM) ──────────────────────────────────────────────────

  private renderPromoTable(data: Campaign[], ms: boolean, src: 'ozon' | 'ym'): string {
    const rows = data.map(c => {
      const key = String(c.id);
      const isExp = this.expanded.has(key);
      const isOzon = src === 'ozon';
      const act  = isOzon ? 'exp-promo' : 'exp-ympromo';
      const extra = isOzon ? `data-aid="${c.actionId??''}"` : `data-promoid="${esc(String(c.promoId??c.id))}"`;

      const expBtn = `<button class="ad-exp ${isExp?'on':''}" data-action="${act}" data-id="${key}" ${extra}>
        <span class="ad-chev">${I.chevronDown()}</span></button>`;

      const main = `<tr class="adr ${isExp?'exp':''}">
        ${ms?`<td class="nm">${esc(c.storeName)}</td>`:''}
        <td style="font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</td>
        <td class="dim nm">${esc(c.type)}</td>
        <td>${statusChip(c.status)}</td>
        <td class="dim nm">${c.dateFrom?c.dateFrom.slice(0,10)+' — '+(c.dateTo??'').slice(0,10):'—'}</td>
        <td>${expBtn}</td>
      </tr>`;

      if (!isExp) return main;
      const cols = ms ? 6 : 5;
      const detail = this.detailLoading.has(key) ? skeleton(2)
        : isOzon ? this._ozonPromoProducts(key, c.actionId)
        : this._ymPromoOffers(key, String(c.promoId ?? c.id));
      return main + `<tr class="ad-drow"><td colspan="${cols}">
        <div class="ad-dinn">${detail}</div>
      </td></tr>`;
    }).join('');

    return `<table class="adt"><thead><tr>
      ${ms?'<th>Магазин</th>':''}
      <th data-sort="name">Акция</th><th>Тип</th><th>Статус</th><th>Период</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  private _ozonPromoProducts(key: string, actionId?: number): string {
    const d = this.detailCache.get(key) as { activated: any[]; available: any[] } | undefined;
    if (!d) return `<p style="font-size:12px;color:var(--text2)">Нет данных.</p>`;
    if (!d.activated.length) return `<p style="font-size:12px;color:var(--text2)">В акции нет товаров.</p>`;
    return `<p style="font-size:11px;color:var(--text3);margin-bottom:8px">Участвует: ${d.activated.length} товаров</p>
      <div style="overflow-x:auto"><table class="adm">
        <thead><tr><th>ID</th><th class="r">Промо-цена</th><th></th></tr></thead>
        <tbody>${d.activated.map((p: any) =>
          `<tr><td><code style="color:var(--accent);font-size:11px">${p.id??p.product_id}</code></td>
           <td class="r">${p.price?fmt(p.price)+' ₽':'—'}</td>
           <td><button class="rpr-btn rpr-btn-ghost" style="padding:1px 8px;font-size:11px;color:#ef4444"
             data-action="rm-promo-product" data-pid="${key}" data-aid="${actionId??''}" data-prodid="${p.id??p.product_id}">Убрать</button></td>
          </tr>`).join('')}
        </tbody></table></div>`;
  }

  private _ymPromoOffers(key: string, promoId: string): string {
    const offers: any[] = this.detailCache.get(key) ?? [];
    if (!Array.isArray(offers)) return `<p style="font-size:12px;color:var(--text2)">Нет данных.</p>`;
    if (!offers.length) return `<p style="font-size:12px;color:var(--text2)">В акции нет офферов.</p>`;
    return `<p style="font-size:11px;color:var(--text3);margin-bottom:8px">Офферов: ${offers.length}</p>
      <div style="overflow-x:auto"><table class="adm">
        <thead><tr><th>Offer ID</th><th class="r">Промо-цена</th><th></th></tr></thead>
        <tbody>${offers.map((o: any) => {
          const oid = o.offerId ?? o.offer_id ?? '';
          return `<tr><td><code style="color:var(--accent);font-size:11px">${esc(oid)}</code></td>
            <td class="r">${(o.promoPrice??o.promo_price)?fmt(o.promoPrice??o.promo_price)+' ₽':'—'}</td>
            <td><button class="rpr-btn rpr-btn-ghost" style="padding:1px 8px;font-size:11px;color:#ef4444"
              data-action="rm-ym-offer" data-promoid="${esc(promoId)}" data-offerid="${esc(oid)}">Убрать</button></td>
          </tr>`;
        }).join('')}
        </tbody></table></div>`;
  }

  // ─── YM Boost table ───────────────────────────────────────────────────────────

  /** Ставка ЯМ хранится как процент × 100 → показываем человеку как проценты. */
  private static bidPct(bid: number): string {
    return (bid / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  }

  private renderBoostTable(): string {
    if (this.ymBidsLoading && !this.ymBoostLoaded) return skeleton(6);

    if (!this.ymBusinesses().length) {
      return `<div style="padding:20px">
        <div class="ad-note ad-note-warn">
          <div class="ad-note-t">Нужен Business ID</div>
          <p class="ad-note-p">
            Буст продаж в Яндекс.Маркете работает на уровне <b>бизнеса</b> — одна рекламная
            кампания на все магазины (и FBS, и FBY). Чтобы управлять ставками, укажите
            <b>Business ID</b> в разделе <b>Магазины → Яндекс.Маркет</b>.
          </p>
          <p class="ad-note-s">
            Business ID есть в кабинете ЯМ: Настройки → О компании, либо в URL
            <code>partner.market.yandex.ru/business/<b>12345678</b></code>
          </p>
        </div>
      </div>`;
    }

    if (!this.ymBoostLoaded) {
      return empty('Ставки буста не загружены', 'Нажмите «Загрузить ставки» — данные придут по всему бизнесу сразу');
    }

    if (!this.ymBids.length) {
      return `<div style="padding:20px">
        <div class="ad-note">
          <div class="ad-note-t">В бусте пока нет товаров</div>
          <p class="ad-note-p">
            По бизнесу <b>${esc(this.ymBoostBusiness?.label ?? '')}</b> не найдено ни одной ставки.
            Это значит, что буст продаж ещё не запускался через API или все товары сняты с продвижения.
          </p>
          <p class="ad-note-s">
            Ставка в ЯМ — это <b>процент от цены товара</b> (от 0,5% до 99,99%), который вы платите
            за продажу через продвижение. Запустить буст на новые товары можно в кабинете ЯМ,
            после чего ставки появятся здесь.
          </p>
        </div>
      </div>`;
    }

    const recMap = new Map<string, YandexBidRecommendation>();
    for (const r of this.ymRec) recMap.set(r.sku, r);

    const q = this.ymBidsSearch.toLowerCase().trim();
    const visibleBids = q ? this.ymBids.filter(b => b.sku.toLowerCase().includes(q)) : this.ymBids;

    const rows = visibleBids.map(b => {
      const rec = recMap.get(b.sku);
      const recV = rec?.bid ?? null;
      const edited = this.ymBidEdits.get(b.sku) ?? '';
      const editedNum = edited.trim() ? Number(edited.replace(',', '.')) : null;
      const changed = editedNum !== null && !isNaN(editedNum) && Math.round(editedNum * 100) !== b.bid;

      // Прогноз доли показов для рекомендованной ставки
      const showPct = rec?.bidRecommendations?.find(r => r.bid === recV)?.showPercent;

      // Сравнение текущей ставки с рекомендацией
      let verdict = '<span class="ad-bv ad-bv-none">—</span>';
      if (recV && b.bid) {
        const delta = (b.bid - recV) / recV * 100;
        if (delta < -20)      verdict = `<span class="ad-bv ad-bv-low">ниже реком. на ${Math.abs(delta).toFixed(0)}%</span>`;
        else if (delta > 20)  verdict = `<span class="ad-bv ad-bv-high">выше реком. на ${delta.toFixed(0)}%</span>`;
        else                  verdict = `<span class="ad-bv ad-bv-ok">в норме</span>`;
      } else if (!b.bid) {
        verdict = `<span class="ad-bv ad-bv-off">не продвигается</span>`;
      }

      return `<tr>
        <td><code class="ad-sku">${esc(b.sku)}</code></td>
        <td class="r"><b style="color:var(--text)">${b.bid ? AdvertisingModule.bidPct(b.bid) : '—'}</b></td>
        <td class="r dim">
          ${recV ? AdvertisingModule.bidPct(recV) : '—'}
          ${showPct != null ? `<span class="ad-shp" title="Прогноз доли показов при рекомендованной ставке">${showPct}% показов</span>` : ''}
        </td>
        <td>${verdict}</td>
        <td>
          <div class="ad-bi-wrap">
            <input type="number" min="0" max="99.99" step="0.1" class="ad-bi ${changed ? 'ch' : ''}"
              value="${esc(edited)}" placeholder="${b.bid ? (b.bid / 100).toString() : '0'}" data-boostid="${esc(b.sku)}">
            <span class="ad-bi-suf">%</span>
          </div>
        </td>
      </tr>`;
    }).join('');

    const emptyRow = !visibleBids.length
      ? `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text3);font-size:12px">Ничего не найдено</td></tr>`
      : '';

    const pending = this.ymBidEdits.size;
    const activeCount = this.ymBids.filter(b => b.bid > 0).length;

    return `<div>
      <div class="ad-boost-bar">
        <input id="boost-search" value="${esc(this.ymBidsSearch)}" placeholder="Поиск по SKU…" class="ad-boost-search">
        <span class="ad-boost-stat">${visibleBids.length} из ${this.ymBids.length}</span>
        <span class="ad-boost-stat">·</span>
        <span class="ad-boost-stat">продвигается ${activeCount}</span>
        ${this.ymBidsLoading ? `<span class="ad-boost-stat" style="color:var(--accent)">рекомендации загружаются…</span>` : ''}
      </div>
      <div style="overflow-x:auto"><table class="adt">
        <thead><tr>
          <th>SKU</th>
          <th class="r">Ставка</th>
          <th class="r">Рекомендация ЯМ</th>
          <th>Оценка</th>
          <th style="min-width:130px">Новая ставка</th>
        </tr></thead>
        <tbody>${rows}${emptyRow}</tbody>
      </table></div>
      <div class="ad-boost-foot">
        <button class="rpr-btn rpr-btn-green" id="ym-save-bids" style="display:flex;align-items:center;gap:5px;height:28px;padding:0 14px;font-size:12px">
          ${I.check()} Сохранить${pending ? ` (${pending})` : ''}
        </button>
        <span class="ad-boost-hint">
          Ставка — процент от цены товара за продажу через продвижение (0,5–99,99%). Ставка <b>0</b> снимает товар с буста.
        </span>
      </div>
    </div>`;
  }

  // ─── data ops ────────────────────────────────────────────────────────────────

  private async loadDetail(key: string) {
    if (this.detailCache.has(key) || this.detailLoading.has(key)) return;
    this.detailLoading.add(key); this.flushBody();
    try {
      const c = this.campaigns.find(x => String(x.id) === key);
      if (!c) return;
      const store = this.stores.find(s => s.id === c.storeId);
      if (!store) return;
      const d = await getWbCampaignDetails(store.api_key, Number(c.id));
      this.detailCache.set(key, d ?? {});
    } finally {
      this.detailLoading.delete(key); this.flushBody();
    }
  }

  private async loadPerfObjects(key: string) {
    if (this.detailCache.has(key) || this.detailLoading.has(key)) return;
    this.detailLoading.add(key); this.flushBody();
    try {
      const c = this.campaigns.find(x => String(x.id) === key);
      if (!c) return;
      const store = this.stores.find(s => s.id === c.storeId);
      if (!store) return;
      const obs = await ozonPerfApi.getCampaignObjects(store.client_id ?? '', store.api_key, key);
      this.detailCache.set(key, obs);
    } finally {
      this.detailLoading.delete(key); this.flushBody();
    }
  }

  private async loadOzonPromoProducts(key: string, actionId: number) {
    if (this.detailCache.has(key) || this.detailLoading.has(key)) return;
    this.detailLoading.add(key); this.flushBody();
    try {
      const c = this.campaigns.find(x => String(x.id) === key);
      if (!c) return;
      const store = this.stores.find(s => s.id === c.storeId);
      if (!store) return;
      const d = await ozonApi.getPromoProducts({ client_id: store.client_id ?? '', api_key: store.api_key }, actionId);
      this.detailCache.set(key, d);
    } finally {
      this.detailLoading.delete(key); this.flushBody();
    }
  }

  private async loadYmPromoOffers(key: string, promoId: string) {
    if (this.detailCache.has(key) || this.detailLoading.has(key)) return;
    this.detailLoading.add(key); this.flushBody();
    try {
      const c = this.campaigns.find(x => String(x.id) === key);
      if (!c) return;
      const store = this.stores.find(s => s.id === c.storeId);
      if (!store) return;
      const offers = await getYandexPromoOffers(store.api_key, Number(store.business_id ?? 0), promoId);
      this.detailCache.set(key, offers);
    } finally {
      this.detailLoading.delete(key); this.flushBody();
    }
  }

  private async loadYmBids() {
    // Буст в ЯМ — на уровне бизнеса. Если выбран конкретный магазин, берём его бизнес,
    // иначе (режим «Все») — первый бизнес из списка.
    const businesses = this.ymBusinesses();
    if (!businesses.length) {
      showToast('У магазина не заполнен Business ID — добавьте его в Настройках магазина', 'warning');
      return;
    }
    const selected = this.stores.find(s => s.id === this.storeId);
    const target = selected && Number(selected.business_id)
      ? businesses.find(b => b.businessId === Number(selected.business_id)) ?? businesses[0]
      : businesses[0];

    this.ymBoostBusiness = target;
    this.ymBidsLoading = true; this.ymBidsSearch = ''; this.ymBidEdits.clear();
    this.ymBids = []; this.ymRec = []; this.ymBoostLoaded = false;
    this.flushBody();
    try {
      const sig = this.eventsAC.signal;
      const bids = await getYandexBusinessBids(target.apiKey, target.businessId, sig);
      this.ymBids = bids;
      this.ymBoostLoaded = true;
      this.flushBody();   // показываем ставки сразу, рекомендации догружаем следом

      if (bids.length) {
        // Рекомендации требуют явный список SKU — запрашиваем по уже известным ставкам.
        this.ymRec = await getYandexBidsRecommendations(
          target.apiKey, target.businessId, bids.map(b => b.sku), sig,
        );
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      showToast(`Ошибка загрузки ставок: ${err.message}`, 'error');
    } finally {
      this.ymBidsLoading = false; this.flushBody();
    }
  }

  private async toggleWb(key: string, status: 9 | 11) {
    if (this.opInProgress.has(key)) return;
    const c = this.campaigns.find(x => String(x.id) === key);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    this.opInProgress.add(key);
    this.flushBody();
    try {
      await updateWbCampaign(store.api_key, Number(c.id), { status });
      c.status = status === 9 ? 'active' : 'paused';
      this.applyFilter();
      showToast(status === 11 ? 'Пауза' : 'Запущена', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.opInProgress.delete(key);
      this.flushBody();
    }
  }

  private async bulkPause(status: 9 | 11) {
    const ids = [...this.selected];
    await Promise.allSettled(ids.map(id => this.toggleWb(id, status)));
    this.selected.clear(); this.renderBulk();
    showToast(`${ids.length} кампаний: ${status===11?'пауза':'запущены'}`, 'success');
  }

  private async saveBudget(key: string, budget: number) {
    if (!budget || budget < 50) { showToast('Минимум 50 ₽', 'warning'); return; }
    if (this.opInProgress.has(key)) return;
    const c = this.campaigns.find(x => String(x.id) === key);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    this.opInProgress.add(key);
    this.flushBody();
    try {
      // WB API принимает бюджет в копейках → умножаем на 100
      await updateWbCampaign(store.api_key, Number(c.id), { dailyBudget: budget * 100 });
      c.budget = budget;
      this.budgetEditing.delete(key);
      showToast('Бюджет обновлён', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.opInProgress.delete(key);
      this.flushBody();
    }
  }

  private async saveBids(key: string) {
    const nmList: Array<{ nm: number; bid: number }> = [];
    this.el.querySelectorAll<HTMLInputElement>(`[data-bidsave="${key}"]`).forEach(inp => {
      const v = Number(inp.value);
      if (!isNaN(v) && v > 0) nmList.push({ nm: Number(inp.dataset.nm), bid: v });
    });
    if (!nmList.length) { showToast('Нет изменений', 'warning'); return; }
    const c = this.campaigns.find(x => String(x.id) === key);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    try {
      await updateWbCampaignBids(store.api_key, Number(c.id), nmList);
      showToast(`Ставки обновлены: ${nmList.length}`, 'success');
      this.detailCache.delete(key); await this.loadDetail(key);
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async saveExcluded(key: string) {
    const ta = this.el.querySelector(`#ad-excl-${key}`) as HTMLTextAreaElement | null;
    if (!ta) return;
    const words = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
    const c = this.campaigns.find(x => String(x.id) === key);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    try {
      await setWbExcludedKeywords(store.api_key, Number(c.id), words);
      showToast('Минус-слова сохранены', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async toggleOzonPerf(key: string, isActive: boolean) {
    const c = this.campaigns.find(x => String(x.id) === key);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    try {
      await ozonPerfApi.toggleCampaign(store.client_id ?? '', store.api_key, key, !isActive);
      c.status = isActive ? 'paused' : 'active';
      this.applyFilter();
      showToast(isActive ? 'Приостановлена' : 'Запущена', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async rmOzonPromoProduct(promoKey: string, actionId: number, productId: number) {
    const c = this.campaigns.find(x => String(x.id) === promoKey);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    try {
      await ozonApi.deactivatePromoProducts({ client_id: store.client_id ?? '', api_key: store.api_key }, actionId, [productId]);
      const d = this.detailCache.get(promoKey);
      if (d) d.activated = d.activated.filter((p: any) => p.id !== productId);
      this.flushBody(); showToast('Убран из акции', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async rmYmOffer(promoId: string, offerId: string) {
    const c = this.campaigns.find(x => String(x.promoId ?? x.id) === promoId);
    if (!c) return;
    const store = this.stores.find(s => s.id === c.storeId);
    if (!store) return;
    try {
      await removeYandexPromoOffers(store.api_key, Number(store.business_id ?? 0), promoId, [offerId]);
      for (const [k, v] of this.detailCache) {
        if (Array.isArray(v)) this.detailCache.set(k, v.filter((o: any) => (o.offerId ?? o.offer_id) !== offerId));
      }
      this.flushBody(); showToast('Убран из акции', 'success');
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  private async saveYmBids() {
    const target = this.ymBoostBusiness;
    if (!target) { showToast('Сначала загрузите ставки', 'warning'); return; }

    const bids: YandexBid[] = [];
    const invalid: string[] = [];
    this.ymBidEdits.forEach((val, sku) => {
      const raw = val.trim().replace(',', '.');
      if (!raw) return;
      const pct = Number(raw);
      if (isNaN(pct) || pct < 0) { invalid.push(sku); return; }
      // Ставка 0 = снять товар с продвижения (разрешено API).
      if (pct === 0) { bids.push({ sku, bid: 0 }); return; }
      const bid = Math.round(pct * 100);
      if (bid < YM_BID_MIN || bid > YM_BID_MAX) { invalid.push(sku); return; }
      bids.push({ sku, bid });
    });

    if (invalid.length) {
      showToast(`Ставка должна быть 0 или ${YM_BID_MIN / 100}–${YM_BID_MAX / 100}% (${invalid.length} с ошибкой)`, 'error');
      return;
    }
    if (!bids.length) { showToast('Нет изменений', 'warning'); return; }

    try {
      await updateYandexBusinessBids(target.apiKey, target.businessId, bids, this.eventsAC.signal);
      this.ymBidEdits.clear();
      const removed = bids.filter(b => b.bid === 0).length;
      showToast(
        removed
          ? `Сохранено: ${bids.length - removed} ставок, снято с продвижения ${removed}`
          : `Ставки сохранены: ${bids.length}`,
        'success',
      );
      await this.loadYmBids();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    }
  }

  // ─── help & create dialog ─────────────────────────────────────────────────────

  private showHelp() {
    document.getElementById('ad-help-overlay')?.remove();
    document.body.insertAdjacentHTML('beforeend', buildHelpModal());
    const overlay = document.getElementById('ad-help-overlay')!;

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

    // Backdrop click — replaces inline onclick in buildHelpModal
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
  }

  private showCreateDialog() {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
    ov.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:420px;max-width:100%">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div style="font-size:15px;font-weight:800;color:var(--text)">Новая WB-кампания</div>
          <button id="dlg-x" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;padding:2px 8px">✕</button>
        </div>
        <form id="dlg-form" style="display:flex;flex-direction:column;gap:14px">
          ${[
            ['name',   'Название кампании', 'text',   '', 'Летняя кампания'],
            ['budget', 'Дневной бюджет, ₽', 'number', 'min="100"', '1000'],
          ].map(([n,l,t,a,p]) => `<div>
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:5px">${l}</label>
            <input name="${n}" type="${t}" ${a} required placeholder="${p}" style="width:100%;box-sizing:border-box;padding:9px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;font-family:inherit;outline:none">
          </div>`).join('')}
          <div>
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:5px">Тип</label>
            <select name="type" style="width:100%;box-sizing:border-box;padding:9px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;font-family:inherit;outline:none">
              <option value="8">Автоматическая</option>
              <option value="6">Поиск</option>
              <option value="7">Каталог</option>
            </select>
          </div>
          <div style="padding:10px;background:rgba(99,102,241,.08);border-radius:8px;font-size:11px;color:var(--text2);line-height:1.6">
            💡 После создания добавьте товары (nmId) через Личный кабинет WB или разверните строку кампании здесь.
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" id="dlg-cancel" class="rpr-btn rpr-btn-ghost">Отмена</button>
            <button type="submit" class="rpr-btn rpr-btn-green" style="display:flex;align-items:center;gap:5px">${I.plus()} Создать</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('#dlg-x')?.addEventListener('click', close);
    ov.querySelector('#dlg-cancel')?.addEventListener('click', close);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });

    (ov.querySelector('#dlg-form') as HTMLFormElement).addEventListener('submit', async e => {
      e.preventDefault();
      const fd   = new FormData(e.target as HTMLFormElement);
      const store = this.stores.find(s => s.id === this.storeId) ?? this.stores[0];
      if (!store) return;

      const submitBtn = ov.querySelector('[type=submit]') as HTMLButtonElement;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Создание…';

      try {
        await createWbAdCampaign(store.api_key, {
          name: fd.get('name') as string,
          subjectId: 0,  // WB требует subjectId; 0 = без категории (товары добавляются через ЛК)
          type: Number(fd.get('type')),
          nms: [],
          dailyBudget: Number(fd.get('budget')) * 100,
        });
        close();
        showToast('Кампания создана', 'success');
        await this.loadCampaigns();
      } catch (err: any) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${I.plus()} Создать`;
        showToast(`Ошибка создания: ${err.message}`, 'error');
      }
    });
  }

  show() { this.el.style.display = 'flex'; }
  hide() { this.el.style.display = 'none'; }
}
