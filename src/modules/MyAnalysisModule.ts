/**
 * Аудит карточек товаров:
 * – ошибки с маркетплейсов (статус, фото, название, описание, цена)
 * – оценка качества 0-100, фильтры по МП / магазину / типу ошибки
 * – редактирование названия, описания, фото прямо здесь
 * – ИИ-подсказки через OpenRouter
 */
import { dbFetch, dbFetchAll } from '../services/dbClient';
import { analysisAiFetch } from '@/services/aiProxy';
import { companyService } from '../services/companyService';
import { ozonApi } from '../services/ozonApi';
import { wbApi } from '../services/wbApi';
import { yandexApi } from '../services/yandexApi';
import { debug } from '@/utils/debug';
import { reportAiUsage } from '@/services/aiUsage';
import { IpAudit, type AuditCard } from './ipAudit';
import './ipAudit.css';
import './analysis-loading.css';
import '@/styles/analysis.css';
import { aiModelButton } from '@/components/aiModelPicker';
import { selectedAiModel } from '@/services/aiModels';

type Mp = 'ozon' | 'wb' | 'yandex';
type Severity = 'error' | 'warning' | 'info';
type IssueFilter = 'all' | 'errors' | 'few_photos' | 'blocked';
type MpFilter = 'all' | 'ozon' | 'wb' | 'yandex';

interface Issue {
  code: string;
  severity: Severity;
  label: string;
  field?: 'name' | 'description' | 'photos' | 'price' | 'status';
}

interface ProductCard {
  uid: string;
  mp: Mp;
  storeId: string;
  storeName: string;
  vendorCode: string;
  name: string;
  photoUrls: string[];
  price: number;
  rawStatus: string;
  productId?: number;
  nmId?: number;
  businessId?: number;
  campaignId?: number;
  stock?: number;
  issues: Issue[];
  score: number;
}

interface OzonStore { id: string; name: string; client_id: string; api_key: string; }
interface WbStore   { id: string; name: string; api_key: string; }
interface YaStore   { id: string; name: string; api_key: string; business_id: number|null; campaign_id: number|null; }

interface FixedItem {
  uid: string;
  mp: Mp;
  vendorCode: string;
  storeName: string;
  storeId: string;
  oldName: string;
  newName: string;
  oldPhotoCount: number;
  newPhotoCount: number;
  /** Only the issues this edit actually resolved locally (oldIssues − newIssues). */
  targetIssues: Array<{ code: string; label: string; severity: Severity }>;
  /** Codes from targetIssues that were still present at the last live verification. */
  remaining: string[];
  fixedAt: number;
  status: 'pending' | 'confirmed' | 'partial' | 'unchanged' | 'gone' | 'error';
  verifiedAt?: number;
  verifyNote?: string;
}

/** Live snapshot of a card read straight from the marketplace API. */
interface LiveSnapshot { name: string; photoUrls: string[]; price: number; rawStatus: string; }

/** One AI suggestion for a single card during bulk AI fix. */
interface AiSuggestion {
  uid: string;
  mp: Mp;
  storeId: string;
  storeName: string;
  vendorCode: string;
  currentName: string;
  suggestedName: string;
  issueLabels: string[];
  /** User has edited the suggested name in the review UI. */
  editedName: string;
  /** Whether user wants to include this card in the bulk apply. */
  selected: boolean;
  /** Result after apply: 'ok' | 'error' | null (not applied yet). */
  applyResult: 'ok' | 'error' | null;
  applyError?: string;
}

// ─── Issue detection ──────────────────────────────────────────────────────────

function auditCard(c: Omit<ProductCard,'issues'|'score'>): Issue[] {
  const iss: Issue[] = [];
  const s = (c.rawStatus || '').toLowerCase();

  if (c.mp === 'ozon') {
    if (['failed_moderation','banned','blocked','price_error','expired'].includes(s))
      iss.push({ code:'BLOCKED', severity:'error', label:'Карточка заблокирована / отклонена', field:'status' });
    else if (['not_moderated','moderating'].includes(s))
      iss.push({ code:'PENDING', severity:'info', label:'Карточка на модерации', field:'status' });
  }
  if (c.mp === 'yandex' && s === 'archived')
    iss.push({ code:'ARCHIVED', severity:'error', label:'Карточка в архиве', field:'status' });

  const photos = c.photoUrls.length;
  if (photos === 0)
    iss.push({ code:'NO_PHOTOS', severity:'error', label:'Нет фотографий', field:'photos' });
  else if (photos < 3)
    iss.push({ code:'FEW_PHOTOS', severity:'warning', label:`Мало фото: ${photos} шт. (рекомендуется ≥5)`, field:'photos' });
  else if (photos < 5)
    iss.push({ code:'LOW_PHOTOS', severity:'info', label:`Фото: ${photos} шт. (рекомендуется ≥5)`, field:'photos' });

  // ── Name length — thresholds differ per marketplace ──────────────────────
  // WB:     official minimum 40 chars; recommended 40-60
  // Ozon:   max 200 chars, each individual word ≤ 27 chars; no hard floor but
  //         very short names get poor placement → treat < 20 as warning
  // Yandex: recommended 60-120 chars; < 30 considered poor
  const name = c.name?.trim() ?? '';
  const nameLen = name.length;

  if (c.mp === 'wb') {
    if (nameLen < 40)
      iss.push({ code:'SHORT_NAME', severity:'warning',
        label:`Слишком короткое название (${nameLen} симв., минимум WB — 40)`, field:'name' });
  } else if (c.mp === 'ozon') {
    if (nameLen < 20)
      iss.push({ code:'SHORT_NAME', severity:'warning',
        label:`Слишком короткое название (${nameLen} симв., рекомендуется ≥20)`, field:'name' });
    // Single word longer than 27 chars triggers Ozon moderation
    const longWord = name.split(/\s+/).find(w => w.length > 27);
    if (longWord)
      iss.push({ code:'LONG_WORD', severity:'warning',
        label:`Слово «${longWord.slice(0,20)}…» длиннее 27 симв. — Ozon может отклонить`, field:'name' });
  } else if (c.mp === 'yandex') {
    if (nameLen < 30)
      iss.push({ code:'SHORT_NAME', severity:'warning',
        label:`Слишком короткое название (${nameLen} симв., рекомендуется ≥60)`, field:'name' });
    else if (nameLen < 60)
      iss.push({ code:'NAME_COULD_BE_LONGER', severity:'info',
        label:`Название можно удлинить (${nameLen} симв., оптимально 60-120)`, field:'name' });
  }

  if (!c.price || c.price === 0)
    iss.push({ code:'NO_PRICE', severity:'warning', label:'Нет цены', field:'price' });

  return iss;
}

function scoreCard(issues: Issue[]): number {
  let s = 100;
  for (const i of issues) {
    if (i.severity === 'error')   s -= 35;
    if (i.severity === 'warning') s -= 15;
    if (i.severity === 'info')    s -= 5;
  }
  return Math.max(0, s);
}

const MP_NAME:  Record<Mp, string> = { ozon:'Ozon', wb:'WB', yandex:'Яндекс' };
const MP_COLOR: Record<Mp, string> = { ozon:'#005bff', wb:'#6d21fc', yandex:'#f5a623' };
const SEV_ICON: Record<Severity, string> = { error:'🚫', warning:'⚠️', info:'ℹ️' };

// ─── Module ───────────────────────────────────────────────────────────────────

export class MyAnalysisModule {
  private el: HTMLElement;

  // Filters
  private mpFilter: MpFilter = 'all';
  private storeFilter = 'all';          // store id or 'all'
  private issueFilter: IssueFilter = 'all';
  private searchQ = '';
  private sortBy: 'score'|'name'|'photos'|'mp' = 'score';
  private filterByStock = false;        // только с остатками
  private filterBySelling = false;      // только продающиеся (активные)

  // State
  private loading = false;
  private loaded  = false;
  private error: string | null = null;
  private loadMsg = 'Загружаем…';
  private _raf = 0;
  private _searchTimer = 0;
  private _drawerOpen = false;   // tracks if drawer is already rendered (avoid re-animation)

  // Data
  private cards: ProductCard[] = [];
  private ozStores: OzonStore[] = [];
  private wbStores: WbStore[]   = [];
  private yaStores: YaStore[]   = [];

  // Drawer state
  private drawerCard: ProductCard | null = null;
  private drawerName = '';
  private drawerDesc = '';
  private drawerPhotos: string[] = [];
  private drawerNewPhotoUrl = '';
  private drawerSaving = false;
  private drawerAiLoading: 'name'|'desc'|null = null;
  private drawerAiNames: string[] = [];   // AI name suggestions

  // Fixed-items tab
  private activeTab: 'overview' | 'issues' | 'fixed' | 'ai' | 'settings' = 'overview';
  private analysisKind: 'quality' | 'rights' = 'quality';
  private companyId = '';
  private qualityStores: Set<string> | null = null;
  private shownCards = 30;
  private resetScroll = false;
  private ipAudit = new IpAudit(() => this.cards as AuditCard[], c => this._fetchDesc(c as ProductCard), mode => mode === 'progress' ? this._paintAuditProgress() : this._paint());
  private fixedItems: FixedItem[] = [];
  private fixedVerifying = false;

  // AI bulk fix
  private aiSuggestions: AiSuggestion[] = [];
  private aiRunning = false;
  private aiProgress = '';     // status line shown during generation
  private aiApplying = false;
  private aiCustomPrompt = '';  // extra instructions from the user

  constructor(el: HTMLElement) {
    this.el = el;
    this.el.style.cssText = 'display:none;flex-direction:column;flex:1;overflow:hidden;';
    (window as any).myAnalysisModule = this;
    // fixedItems are loaded per-company in _load() once we know the active company ID.
  }

  /** localStorage key scoped to the current company so items never bleed across companies. */
  private _fixedKey(): string {
    const cid = companyService.getActiveId() ?? 'default';
    return `sd_ca_fixed_${cid}`;
  }

  private _loadFixed() {
    try {
      const raw = JSON.parse(localStorage.getItem(this._fixedKey()) || '[]') as any[];
      this.fixedItems = (Array.isArray(raw) ? raw : []).map((f: any): FixedItem => ({
        ...f,
        targetIssues:  f.targetIssues  ?? f.fixedIssues ?? [],
        remaining:     f.remaining     ?? [],
        oldPhotoCount: f.oldPhotoCount ?? 0,
        newPhotoCount: f.newPhotoCount ?? 0,
        status: ['pending','confirmed','partial','unchanged','gone','error'].includes(f.status) ? f.status : 'pending',
      }));
    } catch { this.fixedItems = []; }
  }

  async show() {
    this.el.style.display = 'flex';
    const cid = companyService.getActiveId() ?? '';
    if (cid !== this.companyId) {
      this.companyId = cid; this.loaded = false; this.cards = []; this.aiSuggestions = [];
      this.drawerCard = null;
      try { const saved = localStorage.getItem(`sd_quality_stores_${cid}`); this.qualityStores = saved ? new Set(JSON.parse(saved)) : null; } catch { this.qualityStores = null; }
    }
    if (!this.loaded && !this.loading) void this._load();
    else this._paint();
    if (this.analysisKind === 'rights') void this.ipAudit.load();
  }

  hide() { this.el.style.display = 'none'; }

  // ─── Public methods ───────────────────────────────────────────────────────

  setMp(m: MpFilter)       { this.mpFilter = m; this.storeFilter = 'all'; this._paint(); }
  setStore(id: string)     { this.storeFilter = id; this._paint(); }
  setIssueFilter(f: IssueFilter){ this.issueFilter = f; this._paint(); }
  setSort(s: typeof this.sortBy){ this.sortBy = s; this._paint(); }
  setFilterByStock(v: boolean) { this.filterByStock = v; this._paint(); }
  setFilterBySelling(v: boolean) { this.filterBySelling = v; this._paint(); }
  setSearch(v: string)     {
    this.searchQ = v; this.shownCards = 30; this.resetScroll = true;
    window.clearTimeout(this._searchTimer);
    this._searchTimer = window.setTimeout(() => this._paint(), 140);
  }
  async reload()           { this.loaded = false; await this._load(); }

  setKind(kind: 'quality' | 'rights') {
    this.analysisKind = kind; this.resetScroll = true; this._paint();
    if (kind === 'rights') void this.ipAudit.load();
  }
  setTab(t: 'overview' | 'issues' | 'fixed' | 'ai' | 'settings') { this.activeTab = t; this.resetScroll = true; this._paint(); }
  showMoreCards() { this.shownCards += 30; this._paint(); }
  private _stores() {
    return [...this.wbStores.map(s => ({ ...s, mp: 'wb' as Mp })), ...this.ozStores.map(s => ({ ...s, mp: 'ozon' as Mp })), ...this.yaStores.map(s => ({ ...s, mp: 'yandex' as Mp }))];
  }
  private _scopeCards() {
    let cards = this.cards.filter(c => !this.qualityStores || this.qualityStores.has(c.storeId));
    if (this.filterByStock) cards = cards.filter(c => (c.stock ?? 0) > 0);
    if (this.filterBySelling) cards = cards.filter(c => {
      const s = (c.rawStatus || '').toLowerCase();
      return s !== 'archived' && s !== 'banned' && s !== 'blocked' && s !== 'failed_moderation' && s !== 'expired';
    });
    return cards;
  }
  qualityToggleStore(id: string) {
    const selected = this.qualityStores ?? new Set(this._stores().map(s => s.id));
    selected.has(id) ? selected.delete(id) : selected.add(id);
    this.qualityStores = selected; this._saveScope();
  }
  qualityToggleMp(mp: Mp) {
    const selected = this.qualityStores ?? new Set(this._stores().map(s => s.id));
    const ids = this._stores().filter(s => s.mp === mp).map(s => s.id);
    const all = ids.every(id => selected.has(id));
    ids.forEach(id => all ? selected.delete(id) : selected.add(id));
    this.qualityStores = selected; this._saveScope();
  }
  qualityChooseAll(all: boolean) { this.qualityStores = all ? null : new Set(); this._saveScope(); }
  private _saveScope() {
    localStorage.setItem(`sd_quality_stores_${this.companyId}`, JSON.stringify([...(this.qualityStores ?? new Set(this._stores().map(s => s.id)))]));
    this.aiSuggestions = []; this.shownCards = 30; this._paint();
  }

  ipSection(v: 'overview' | 'results' | 'history' | 'references' | 'settings') { this.resetScroll = true; this.ipAudit.setSection(v); }
  ipFilter(v: string) { this.ipAudit.setFilter(v); }
  ipSearch(v: string) { this.ipAudit.setSearch(v); }
  ipChooseRun(v: string) { this.ipAudit.setRun(v); this.ipAudit.setSection('results'); }
  ipStart(scope: 'sample' | 'all' | 'new' | 'selected', selection = '') { 
    void this.ipAudit.start(scope, selection, { 
      onlyStock: this.ipAudit.filterByStock, 
      onlySelling: this.ipAudit.filterBySelling 
    }); 
  }
  ipResume(id: string) { void this.ipAudit.resume(id); }
ipDeleteRun(id: string) { void this.ipAudit.deleteRun(id); }
  ipStop() { this.ipAudit.requestStop(); }
  ipSkipCard() { this.ipAudit.skipCurrentCard(); }
  ipToggleStore(id: string) { this.ipAudit.toggleStore(id); }
  ipToggleMarketplace(mp: 'wb' | 'ozon' | 'yandex') { this.ipAudit.toggleMarketplace(mp); }
  ipExport(onlyRisk: boolean) { void this.ipAudit.export(onlyRisk); }
  ipAddReference(form: HTMLFormElement) { void this.ipAudit.addReference(form); }
  ipReview(id: string) {
    const status = (document.getElementById(`ip-status-${id}`) as HTMLSelectElement)?.value as Parameters<IpAudit['review']>[1];
    const comment = (document.getElementById(`ip-comment-${id}`) as HTMLInputElement)?.value ?? '';
    const evidence = (document.getElementById(`ip-evidence-${id}`) as HTMLInputElement)?.value ?? '';
    void this.ipAudit.review(id, status, comment, evidence);
  }
  ipToggleSelect(id: string) { this.ipAudit.toggleSelect(id); }
  ipSelectAll() { this.ipAudit.selectFiltered(); }
  ipChooseAll(all: boolean) { this.ipAudit.chooseAll(all); }
  ipMore() { this.ipAudit.more(); }
  async ipBulkReview() {
    const status = (document.getElementById('ip-bulk-status') as HTMLSelectElement)?.value as Parameters<IpAudit['review']>[1];
    const comment = (document.getElementById('ip-bulk-comment') as HTMLInputElement)?.value ?? '';
    await this.ipAudit.bulkReview(status, comment);
  }
  ipSearchSource(id: string) { void this.ipAudit.searchSource(id); }

  // ─── AI bulk fix ──────────────────────────────────────────────────────────

  aiToggleSuggestion(idx: number) {
    if (this.aiSuggestions[idx]) {
      this.aiSuggestions[idx].selected = !this.aiSuggestions[idx].selected;
      this._paint();
    }
  }

  aiSelectAll(v: boolean) {
    this.aiSuggestions.forEach(s => { if (s.applyResult !== 'ok') s.selected = v; });
    this._paint();
  }

  aiEditName(idx: number, v: string) {
    if (this.aiSuggestions[idx]) this.aiSuggestions[idx].editedName = v;
  }

  aiSetCustomPrompt(v: string) { this.aiCustomPrompt = v; }

  /** Loads a product description straight from the marketplace API (no drawer side-effects). */
  private async _fetchDesc(card: ProductCard): Promise<string> {
    try {
      if (card.mp === 'wb') {
        const store = this.wbStores.find(s => s.id === card.storeId);
        if (store && card.nmId) {
          const d = await wbApi.getCardDetails(store.api_key, card.nmId) as any;
          return d?.description || '';
        }
      } else if (card.mp === 'ozon') {
        const store = this.ozStores.find(s => s.id === card.storeId);
        if (store) {
          return await ozonApi.getProductDescription(card.vendorCode, card.productId ?? null,
            { client_id: store.client_id, api_key: store.api_key });
        }
      } else if (card.mp === 'yandex') {
        const store = this.yaStores.find(s => s.id === card.storeId);
        if (store?.business_id) {
          const o = await yandexApi.getOfferMapping(store.api_key, store.business_id, card.vendorCode) as any;
          return o?.description || '';
        }
      }
    } catch { /* ignore — description is optional context */ }
    return '';
  }

  async aiRunAnalysis() {
    if (this.aiRunning) return;
    if (!this.loaded) await this._load();

    const candidates = this._scopeCards().filter(c =>
      (this.mpFilter === 'all' || c.mp === this.mpFilter) &&
      (this.storeFilter === 'all' || c.storeId === this.storeFilter) &&
      c.issues.some(i => i.field === 'name' || i.code === 'LONG_WORD'),
    );
    if (!candidates.length) {
      (window as any).app?.toast?.('Нет карточек с проблемами в названии', 'info');
      return;
    }

    this.aiRunning   = true;
    this.aiProgress  = `Анализируем 0 / ${candidates.length}…`;
    this.aiSuggestions = [];
    this._paint();

    const BATCH = 5;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      this.aiProgress = `Загружаем описания ${Math.min(i + BATCH, candidates.length)} / ${candidates.length}…`;
      this._paint();

      // Load descriptions in parallel — they give the AI real facts to work with.
      const descs = await Promise.all(batch.map(c => this._fetchDesc(c)));

      this.aiProgress = `Анализируем ${Math.min(i + BATCH, candidates.length)} / ${candidates.length}…`;
      this._paint();

      const lines = batch.map((c, bi) => {
        const nameIssues = c.issues
          .filter(x => x.field === 'name' || x.code === 'LONG_WORD')
          .map(x => x.label).join('; ');
        const desc = descs[bi] ? `\n   Описание: "${descs[bi].slice(0, 400)}"` : '';
        return `${bi + 1}. Маркетплейс: ${MP_NAME[c.mp]} | Текущее название: "${c.name}" | Проблемы: ${nameIssues}${desc}`;
      }).join('\n\n');

      const mpRules =
        `• WB: строго 40-60 символов; бренд/тип товара/материал/цвет/ключевые характеристики; без лишних слов\n` +
        `• Ozon: 50-120 символов; каждое слово ≤27 символов; тип товара + ключевые параметры; без воды\n` +
        `• Яндекс Маркет: 60-120 символов; тип товара + бренд + ключевые характеристики`;

      const customSection = this.aiCustomPrompt.trim()
        ? `\nДополнительные пожелания от продавца:\n${this.aiCustomPrompt.trim()}\n`
        : '';

      try {
        const resp = await this._callAi(
          `Ты SEO-специалист по российским маркетплейсам.\n` +
          `Задача: придумать продающее название для каждой карточки товара ниже.\n\n` +
          `ТРЕБОВАНИЯ:\n` +
          `1. Используй ТОЛЬКО факты из текущего названия и описания — НЕ придумывай несуществующие свойства.\n` +
          `2. Применяй знания о том, какие ключевые слова реально ищут покупатели на этом маркетплейсе.\n` +
          `3. НЕ добавляй в начало название маркетплейса в скобках (Ozon/WB/Яндекс и т.п.).\n` +
          `4. Соблюдай правила платформы:\n${mpRules}\n` +
          `${customSection}\n` +
          `Ответь ТОЛЬКО в таком формате (одна строка = одна карточка, номер совпадает со входом):\n` +
          `1. Новое название\n` +
          `2. Новое название\n` +
          `...\n\n` +
          `Карточки:\n${lines}`,
        );

        // Parse: strip leading "N. " and any stray [Ozon]/[WB]/[Яндекс] prefixes the AI might add.
        const answers = resp.split('\n')
          .map(l => l.replace(/^\d+\.\s*/, '').replace(/^\[(?:Ozon|WB|Яндекс(?:\s*Маркет)?|Wildberries)\]\s*/i, '').trim())
          .filter(Boolean);

        for (let bi = 0; bi < batch.length; bi++) {
          const c = batch[bi];
          const suggested = answers[bi] ?? c.name;
          this.aiSuggestions.push({
            uid: c.uid, mp: c.mp, storeId: c.storeId, storeName: c.storeName,
            vendorCode: c.vendorCode, currentName: c.name, suggestedName: suggested,
            editedName: suggested,
            issueLabels: c.issues.filter(x => x.field === 'name' || x.code === 'LONG_WORD').map(x => x.label),
            selected: true, applyResult: null,
          });
        }
      } catch (e: unknown) {
        for (const c of batch) {
          this.aiSuggestions.push({
            uid: c.uid, mp: c.mp, storeId: c.storeId, storeName: c.storeName,
            vendorCode: c.vendorCode, currentName: c.name, suggestedName: '',
            editedName: '', issueLabels: [], selected: false,
            applyResult: 'error', applyError: (e instanceof Error ? e.message : String(e)).slice(0, 100),
          });
        }
      }

      this._paint();
    }

    this.aiRunning  = false;
    this.aiProgress = '';
    this._paint();
  }

  async aiApplyAll() {
    if (this.aiApplying) return;
    const toApply = this.aiSuggestions.filter(s => s.selected && s.applyResult !== 'ok');
    if (!toApply.length) return;

    this.aiApplying = true;
    this._paint();

    for (const s of toApply) {
      const card = this.cards.find(c => c.uid === s.uid);
      if (!card) { s.applyResult = 'error'; s.applyError = 'Карточка не найдена'; continue; }

      try {
        const finalName = s.editedName.trim() || s.suggestedName;

        if (card.mp === 'ozon') {
          const store = this.ozStores.find(st => st.id === card.storeId)!;
          const creds = { client_id: store.client_id, api_key: store.api_key };
          const item  = (await ozonApi.getFullProductInfo(card.vendorCode, card.productId ?? null, creds) as any) ?? {};
          await ozonApi.updateProduct(creds, {
            offer_id: card.vendorCode, name: finalName,
            description_category_id: item.description_category_id, type_id: item.type_id,
          });
          await dbFetch(`ozon_products?store_id=eq.${card.storeId}&offer_id=eq.${encodeURIComponent(card.vendorCode)}`, {
            method: 'PATCH', body: JSON.stringify({ name: finalName }),
          });
        } else if (card.mp === 'wb') {
          const store = this.wbStores.find(st => st.id === card.storeId)!;
          await wbApi.updateCard(store.api_key, card.nmId!, { title: finalName });
          await dbFetch(`wb_products?store_id=eq.${card.storeId}&nm_id=eq.${card.nmId}`, {
            method: 'PATCH', body: JSON.stringify({ title: finalName }),
          });
        } else {
          const store = this.yaStores.find(st => st.id === card.storeId)!;
          await yandexApi.updateOffer(store.api_key, store.business_id!, {
            offerId: card.vendorCode, name: finalName,
          });
          await dbFetch(`yandex_products?store_id=eq.${card.storeId}&offer_id=eq.${encodeURIComponent(card.vendorCode)}`, {
            method: 'PATCH', body: JSON.stringify({ name: finalName }),
          });
        }

        // Update in-memory card and track as fixed
        const idx = this.cards.findIndex(c => c.uid === card.uid);
        const oldIssues     = card.issues.slice();
        const oldName       = card.name;
        if (idx >= 0) {
          this.cards[idx].name   = finalName;
          this.cards[idx].issues = auditCard(this.cards[idx]);
          this.cards[idx].score  = scoreCard(this.cards[idx].issues);
        }
        const newIssues = idx >= 0 ? this.cards[idx].issues : oldIssues;
        const resolved  = oldIssues.filter(oi => !newIssues.some(ni => ni.code === oi.code));
        if (resolved.length > 0) {
          const fixed: FixedItem = {
            uid: card.uid, mp: card.mp, vendorCode: card.vendorCode,
            storeName: card.storeName, storeId: card.storeId,
            oldName, newName: finalName,
            oldPhotoCount: card.photoUrls.length, newPhotoCount: card.photoUrls.length,
            targetIssues: resolved.map(i => ({ code: i.code, label: i.label, severity: i.severity })),
            remaining: [], fixedAt: Date.now(), status: 'pending',
          };
          this.fixedItems = [fixed, ...this.fixedItems.filter(f => f.uid !== card.uid)];
        }

        s.applyResult = 'ok';
        s.suggestedName = finalName;
      } catch (e: unknown) {
        s.applyResult = 'error';
        s.applyError  = (e instanceof Error ? e.message : String(e)).slice(0, 120);
      }

      this._paint();
    }

    this._saveFixed();
    this.aiApplying = false;
    const ok  = toApply.filter(s => s.applyResult === 'ok').length;
    const err = toApply.filter(s => s.applyResult === 'error').length;
    (window as any).app?.toast?.(
      err ? `Применено ${ok}, ошибок ${err}` : `Применено ${ok} карточек`,
      err ? 'info' : 'success',
    );
    this._paint();
  }

  async verifyFixed(uid: string) {
    const fixed = this.fixedItems.find(f => f.uid === uid);
    if (!fixed || this.fixedVerifying) return;
    this.fixedVerifying = true;
    this._paint();
    await this._verifyOne(fixed);
    this.fixedVerifying = false;
    this._saveFixed();
    this._paint();
  }

  async verifyAllFixed() {
    if (this.fixedVerifying) return;
    this.fixedVerifying = true;
    this._paint();
    for (const fixed of this.fixedItems) {
      if (fixed.status === 'confirmed') continue;
      await this._verifyOne(fixed);
    }
    this.fixedVerifying = false;
    this._saveFixed();
    this._paint();
  }

  /**
   * Re-reads the card straight from the marketplace and re-audits it. Verifying against
   * the local DB cache would only confirm our own optimistic write, not that the
   * marketplace actually accepted the edit.
   */
  private async _verifyOne(fixed: FixedItem) {
    fixed.verifiedAt = Date.now();
    fixed.verifyNote = undefined;

    let live: LiveSnapshot | null;
    try {
      live = await this._fetchLive(fixed);
    } catch (e: unknown) {
      fixed.status = 'error';
      fixed.verifyNote = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      return;
    }

    if (!live) {
      fixed.status = 'gone';
      fixed.verifyNote = 'Товар не найден на маркетплейсе';
      return;
    }

    const liveIssues = auditCard({
      uid: fixed.uid, mp: fixed.mp, storeId: fixed.storeId, storeName: fixed.storeName,
      vendorCode: fixed.vendorCode, name: live.name, photoUrls: live.photoUrls,
      price: live.price, rawStatus: live.rawStatus,
    });

    fixed.remaining = fixed.targetIssues
      .filter(t => liveIssues.some(li => li.code === t.code))
      .map(t => t.code);

    fixed.status = fixed.remaining.length === 0            ? 'confirmed'
                 : fixed.remaining.length < fixed.targetIssues.length ? 'partial'
                 : 'unchanged';

    // Live data wins over our optimistic write — keeps the Issues tab honest whether or
    // not the marketplace accepted the edit.
    const idx = this.cards.findIndex(c => c.uid === fixed.uid);
    if (idx >= 0) {
      this.cards[idx].name      = live.name;
      this.cards[idx].photoUrls = live.photoUrls;
      this.cards[idx].price     = live.price;
      this.cards[idx].rawStatus = live.rawStatus;
      this.cards[idx].issues    = liveIssues;
      this.cards[idx].score     = scoreCard(liveIssues);
    }
  }

  /** Reads one card live from its marketplace. Returns null when the card no longer exists. */
  private async _fetchLive(f: FixedItem): Promise<LiveSnapshot | null> {
    const cached = this.cards.find(c => c.uid === f.uid);

    if (f.mp === 'ozon') {
      const store = this.ozStores.find(s => s.id === f.storeId);
      if (!store) throw new Error('Магазин Ozon не найден');
      const item = await ozonApi.getFullProductInfo(
        f.vendorCode, cached?.productId ?? null,
        { client_id: store.client_id, api_key: store.api_key },
      ) as any;
      if (!item) return null;
      // images come back either as plain URLs or as objects with file_name/url
      const photoUrls: string[] = (item.images ?? [])
        .map((im: any) => typeof im === 'string' ? im : (im?.file_name ?? im?.url ?? ''))
        .filter(Boolean);
      // status is either a plain string or an object describing the moderation state
      const st = item.status;
      const rawStatus = typeof st === 'string' ? st
                      : (st?.state ?? st?.status ?? item.state ?? '');
      return { name: item.name ?? '', photoUrls, price: Number(item.price) || 0, rawStatus: String(rawStatus) };
    }

    if (f.mp === 'wb') {
      const store = this.wbStores.find(s => s.id === f.storeId);
      if (!store) throw new Error('Магазин WB не найден');
      const nmId = cached?.nmId;
      if (!nmId) throw new Error('Не найден nm_id товара');
      const card = await wbApi.getCardFull(store.api_key, nmId);
      if (!card) return null;
      // WB's card endpoint carries no price — keep the synced one, the editor never changes it
      return { name: card.title, photoUrls: card.photoUrls, price: cached?.price ?? 0, rawStatus: 'active' };
    }

    const store = this.yaStores.find(s => s.id === f.storeId);
    if (!store?.business_id) throw new Error('Магазин Яндекса не найден');
    const offer = await yandexApi.getOfferMapping(store.api_key, store.business_id, f.vendorCode) as any;
    if (!offer) return null;
    return {
      name: offer.name ?? '',
      photoUrls: offer.pictures ?? [],
      price: Number(offer.basicPrice?.value ?? offer.basic_price ?? cached?.price ?? 0) || 0,
      rawStatus: offer.archived ? 'archived' : 'active',
    };
  }

  removeFixed(uid: string) {
    this.fixedItems = this.fixedItems.filter(f => f.uid !== uid);
    this._saveFixed();
    this._paint();
  }

  /** Re-sends the same edit to the marketplace, then re-opens the editor pre-filled with it. */
  async retryFixed(uid: string) {
    if (this.drawerSaving) return;
    if (!this.loaded) await this._load();
    const fixed = this.fixedItems.find(f => f.uid === uid);
    if (!fixed) return;
    const card = this.cards.find(c => c.uid === uid);
    if (!card) {
      (window as any).app?.toast?.('Карточка не найдена на маркетплейсе', 'error');
      return;
    }
    this.openDrawer(uid);
    this.drawerName   = fixed.newName;
    this.drawerPhotos = fixed.newPhotoCount > 0 ? [...card.photoUrls] : [];
    this._paint();
    await this.drawerSave();
  }

  /** Takes an index, not the code itself — vendor codes may contain quotes that would
   *  break the inline onclick string. */
  async copyVendorCode(idx: number) {
    const vc = this.fixedItems[idx]?.vendorCode;
    if (!vc) return;
    try {
      await navigator.clipboard.writeText(vc);
      (window as any).app?.toast?.('Артикул скопирован', 'success');
    } catch {
      (window as any).app?.toast?.('Не удалось скопировать', 'error');
    }
  }

  private _saveFixed() {
    localStorage.setItem(this._fixedKey(), JSON.stringify(this.fixedItems));
  }

  openDrawer(uid: string) {
    const card = this.cards.find(c => c.uid === uid);
    if (!card) return;
    this.drawerCard   = card;
    this.drawerName   = card.name;
    this.drawerDesc   = '';
    this.drawerPhotos = [...card.photoUrls];
    this.drawerNewPhotoUrl = '';
    this.drawerAiNames = [];
    this.drawerAiLoading = null;
    this._drawerOpen = false;   // fresh open → play animation
    this._paint();
    this._loadDesc(card);
  }

  closeDrawer() {
    this.drawerCard  = null;
    this._drawerOpen = false;
    this._paint();
  }

  drawerSetName(v: string)       { this.drawerName = v; }
  drawerSetDesc(v: string)       { this.drawerDesc = v; }
  drawerSetNewUrl(v: string)     { this.drawerNewPhotoUrl = v; }

  drawerAddPhoto() {
    const url = this.drawerNewPhotoUrl.trim();
    if (!url) return;
    if (!this.drawerPhotos.includes(url)) this.drawerPhotos.push(url);
    this.drawerNewPhotoUrl = '';
    this._paint();
  }

  drawerRemovePhoto(idx: number) {
    this.drawerPhotos.splice(idx, 1);
    this._paint();
  }

  // AI name — use index to avoid serialization issues with special chars
  pickAiName(idx: number) {
    const name = this.drawerAiNames[idx];
    if (!name) return;
    this.drawerName = name;
    this.drawerAiNames = [];
    this._paint();
  }

  async aiSuggestName() {
    if (!this.drawerCard) return;
    this.drawerAiLoading = 'name';
    this._paint();
    try {
      const res = await this._callAi(
        `Ты эксперт по контенту для российских маркетплейсов Ozon, WB и Яндекс.Маркет.\n` +
        `Текущее название товара: "${this.drawerName}".\n` +
        `Предложи 3 улучшенных варианта названия: с ключевыми словами, чёткими характеристиками, без воды. ` +
        `Каждый вариант с новой строки, без нумерации и тире.`
      );
      this.drawerAiNames = res.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3);
    } catch { this.drawerAiNames = []; }
    this.drawerAiLoading = null;
    this._paint();
  }

  async aiImproveDesc() {
    if (!this.drawerCard) return;
    this.drawerAiLoading = 'desc';
    this._paint();
    try {
      const res = await this._callAi(
        `Ты эксперт по контенту для российских маркетплейсов.\n` +
        `Название товара: "${this.drawerCard.name}".\n` +
        `Текущее описание: "${this.drawerDesc || 'отсутствует'}".\n` +
        `Напиши продающее SEO-описание: 3-4 абзаца, ключевые слова, преимущества. Без вводных фраз — сразу текст.`
      );
      this.drawerDesc = res.trim();
    } catch { /* keep */ }
    this.drawerAiLoading = null;
    this._paint();
  }

  async drawerSave() {
    const card = this.drawerCard;
    if (!card || this.drawerSaving) return;
    this.drawerSaving = true;
    this._paint();

    try {
      if (card.mp === 'ozon') {
        const store = this.ozStores.find(s => s.id === card.storeId)!;
        const creds = { client_id: store.client_id, api_key: store.api_key };

        // Must include description_category_id & type_id for /v3/product/import
        // getFullProductInfo already returns the unwrapped first item
        const item = (await ozonApi.getFullProductInfo(card.vendorCode, card.productId ?? null, creds) as any) ?? {};

        await ozonApi.updateProduct(creds, {
          offer_id: card.vendorCode,
          name: this.drawerName,
          description_category_id: item.description_category_id,
          type_id: item.type_id,
          images: this.drawerPhotos.length ? this.drawerPhotos : undefined,
        });

        // Sync local DB cache so verifyFixed sees the updated values
        await dbFetch(`ozon_products?store_id=eq.${card.storeId}&offer_id=eq.${encodeURIComponent(card.vendorCode)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: this.drawerName, ...(this.drawerPhotos.length ? { images: this.drawerPhotos } : {}) }),
        });

      } else if (card.mp === 'wb') {
        const store = this.wbStores.find(s => s.id === card.storeId)!;
        await wbApi.updateCard(store.api_key, card.nmId!, {
          title: this.drawerName,
          ...(this.drawerDesc ? { description: this.drawerDesc } : {}),
        });

        // Sync local DB cache
        await dbFetch(`wb_products?store_id=eq.${card.storeId}&nm_id=eq.${card.nmId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: this.drawerName, ...(this.drawerPhotos.length ? { pictures: this.drawerPhotos } : {}) }),
        });

      } else if (card.mp === 'yandex') {
        const store = this.yaStores.find(s => s.id === card.storeId)!;
        await yandexApi.updateOffer(store.api_key, store.business_id!, {
          offerId: card.vendorCode,
          name: this.drawerName,
          ...(this.drawerDesc ? { description: this.drawerDesc } : {}),
        });

        // Sync local DB cache
        await dbFetch(`yandex_products?store_id=eq.${card.storeId}&offer_id=eq.${encodeURIComponent(card.vendorCode)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: this.drawerName, ...(this.drawerPhotos.length ? { pictures: this.drawerPhotos } : {}) }),
        });
      }

      // Snapshot the "before" state BEFORE mutating — `card` is the same object as
      // this.cards[idx], so reading card.name after the mutation returns the new name.
      const oldIssues     = card.issues.slice();
      const oldName       = card.name;
      const oldPhotoCount = card.photoUrls.length;

      // Update in-memory card
      const idx = this.cards.findIndex(c => c.uid === card.uid);
      if (idx >= 0) {
        this.cards[idx].name      = this.drawerName;
        this.cards[idx].photoUrls = [...this.drawerPhotos];
        this.cards[idx].issues    = auditCard(this.cards[idx]);
        this.cards[idx].score     = scoreCard(this.cards[idx].issues);
        this.drawerCard           = this.cards[idx];
      }

      // Only the issues this edit actually resolved are worth verifying. Tracking every
      // pre-existing issue made verification report "не изменилось" whenever an unrelated
      // issue (few photos, no price…) was still open.
      const newIssues = idx >= 0 ? this.cards[idx].issues : oldIssues;
      const resolved  = oldIssues.filter(oi => !newIssues.some(ni => ni.code === oi.code));

      if (resolved.length > 0) {
        const fixed: FixedItem = {
          uid: card.uid, mp: card.mp, vendorCode: card.vendorCode,
          storeName: card.storeName, storeId: card.storeId,
          oldName, newName: this.drawerName,
          oldPhotoCount, newPhotoCount: this.drawerPhotos.length,
          targetIssues: resolved.map(i => ({ code: i.code, label: i.label, severity: i.severity })),
          remaining: [],
          fixedAt: Date.now(), status: 'pending',
        };
        this.fixedItems = [fixed, ...this.fixedItems.filter(f => f.uid !== card.uid)];
        this._saveFixed();
        (window as any).app?.toast?.(
          card.mp === 'ozon'
            ? 'Отправлено в Ozon. Изменения применяются в течение нескольких минут'
            : 'Карточка обновлена', 'success');
      } else if (newIssues.length > 0) {
        // Saved fine, but nothing got resolved — say why instead of silently doing nothing.
        (window as any).app?.toast?.(
          `Сохранено, но проблемы остались: ${newIssues.map(i => i.label).join(', ')}`, 'info');
      } else {
        (window as any).app?.toast?.('Карточка обновлена', 'success');
      }
    } catch (e: unknown) {
      (window as any).app?.toast?.('Ошибка сохранения: ' + ((e instanceof Error ? e.message : String(e)) || e), 'error');
    }

    this.drawerSaving = false;
    // Always close the drawer after a save attempt so the user sees the updated card list.
    this.drawerCard  = null;
    this._drawerOpen = false;
    this._paint();
  }

  // ─── Data loading ─────────────────────────────────────────────────────────

  private async _load() {
    const cid = companyService.getActiveId();
    if (!cid) return;
    this.loading = true;
    this.error   = null;
    this.loadMsg = 'Загружаем магазины…';
    this._paint();

    try {
      const [oz, wb, ya] = await Promise.all([
        dbFetchAll<OzonStore>(`ozon_stores?company_id=eq.${cid}&select=id,name,client_id,api_key`),
        dbFetchAll<WbStore>  (`wb_stores?company_id=eq.${cid}&select=id,name,api_key`),
        dbFetchAll<YaStore>  (`yandex_stores?company_id=eq.${cid}&select=id,name,api_key,business_id,campaign_id`),
      ]);
      if (cid !== companyService.getActiveId()) return;
      this.ozStores = oz;
      this.wbStores = wb;
      this.yaStores = ya;

      const ozIds = oz.map(s => s.id);
      const wbIds = wb.map(s => s.id);
      const yaIds = ya.map(s => s.id);
      const sName = (id: string) => [...oz,...wb,...ya].find(s => s.id === id)?.name ?? id;

      this.loadMsg = 'Загружаем карточки…';
      this._paint();

      type OzP = { store_id:string; offer_id:string; product_id:number; name:string; price:number; images:string[]|null; status:string; stock_fbs:number|null; stock_fbo:number|null };
      type WbP = { store_id:string; nm_id:number; vendor_code:string; title:string; price:number; discount:number; pictures:string[]|null; stock_total:number|null; stock_fbs:number|null };
      type YaP = { store_id:string; offer_id:string; name:string; basic_price:number; pictures:string[]|null; archived:boolean; stock_total:number|null; stock_available:number|null };

      const [ozP, wbP, yaP] = await Promise.all([
        ozIds.length ? dbFetchAll<OzP>(`ozon_products?store_id=in.(${ozIds.join(',')})&select=store_id,offer_id,product_id,name,price,images,status,stock_fbs,stock_fbo`) : Promise.resolve<OzP[]>([]),
        wbIds.length ? dbFetchAll<WbP>(`wb_products?store_id=in.(${wbIds.join(',')})&select=store_id,nm_id,vendor_code,title,price,discount,pictures,stock_total,stock_fbs`) : Promise.resolve<WbP[]>([]),
        yaIds.length ? dbFetchAll<YaP>(`yandex_products?store_id=in.(${yaIds.join(',')})&select=store_id,offer_id,name,basic_price,pictures,archived,stock_total,stock_available`) : Promise.resolve<YaP[]>([]),
      ]);

      const cards: ProductCard[] = [];

      for (const p of ozP) {
        const stock = (Number(p.stock_fbs) || 0) + (Number(p.stock_fbo) || 0);
        const base = { uid:`ozon:${p.store_id}:${p.offer_id}`, mp:'ozon' as Mp,
          storeId:p.store_id, storeName:sName(p.store_id), vendorCode:p.offer_id,
          name:p.name||p.offer_id, photoUrls:p.images||[], price:Number(p.price)||0,
          rawStatus:p.status||'', productId:Number(p.product_id)||undefined, stock };
        const issues = auditCard(base);
        cards.push({ ...base, issues, score:scoreCard(issues) });
      }
      for (const p of wbP) {
        const stock = (Number(p.stock_total) || 0) + (Number(p.stock_fbs) || 0);
        const base = { uid:`wb:${p.store_id}:${p.vendor_code}`, mp:'wb' as Mp,
          storeId:p.store_id, storeName:sName(p.store_id), vendorCode:p.vendor_code,
          name:p.title||p.vendor_code, photoUrls:p.pictures||[],
          price:Number(p.price)*(1-(Number(p.discount)||0)/100), rawStatus:'active',
          nmId:Number(p.nm_id)||undefined, stock };
        const issues = auditCard(base);
        cards.push({ ...base, issues, score:scoreCard(issues) });
      }
      for (const p of yaP) {
        const ys = ya.find(s=>s.id===p.store_id);
        const stock = (Number(p.stock_total) || 0) + (Number(p.stock_available) || 0);
        const base = { uid:`yandex:${p.store_id}:${p.offer_id}`, mp:'yandex' as Mp,
          storeId:p.store_id, storeName:sName(p.store_id), vendorCode:p.offer_id,
          name:p.name||p.offer_id, photoUrls:p.pictures||[], price:Number(p.basic_price)||0,
          rawStatus:p.archived?'archived':'active',
          businessId:ys?.business_id??undefined, campaignId:ys?.campaign_id??undefined, stock };
        const issues = auditCard(base);
        cards.push({ ...base, issues, score:scoreCard(issues) });
      }

      if (cid !== companyService.getActiveId()) return;
      this.cards = cards;
      this.loaded = true;
      this._loadFixed();   // reload per-company list every time data is refreshed
    } catch (e: unknown) {
      this.error = (e instanceof Error ? e.message : String(e)) || String(e);
      debug.warn('[CardAudit]', e);
    } finally {
      this.loading = false;
      this._paint();
    }
  }

  /** Loads description without re-triggering full paint animation */
  private async _loadDesc(card: ProductCard) {
    try {
      let desc = '';
      if (card.mp === 'wb') {
        const store = this.wbStores.find(s => s.id === card.storeId);
        if (store && card.nmId) {
          const d = await wbApi.getCardDetails(store.api_key, card.nmId) as any;
          desc = d?.description || '';
        }
      } else if (card.mp === 'ozon') {
        const store = this.ozStores.find(s => s.id === card.storeId);
        if (store) {
          // getProductDescription returns a string directly
          desc = await ozonApi.getProductDescription(card.vendorCode, card.productId ?? null,
            { client_id: store.client_id, api_key: store.api_key });
        }
      } else if (card.mp === 'yandex') {
        const store = this.yaStores.find(s => s.id === card.storeId);
        if (store?.business_id) {
          // getOfferMapping already returns the unwrapped offer
          const o = await yandexApi.getOfferMapping(store.api_key, store.business_id, card.vendorCode) as any;
          desc = o?.description || '';
        }
      }

      if (this.drawerCard?.uid !== card.uid) return; // drawer changed while loading

      // Patch only the textarea — no full repaint (avoids re-animation #4)
      this.drawerDesc = desc;
      const ta = this.el.querySelector<HTMLTextAreaElement>('#ca-desc-ta');
      if (ta) {
        ta.value = desc;
        ta.placeholder = desc ? '' : 'Описание не найдено';
      } else {
        // drawer not rendered yet (race), full paint
        this._paint();
      }
    } catch { /* ignore */ }
  }

  private async _callAi(prompt: string): Promise<string> {
    const model = selectedAiModel('quality');
    const r = await analysisAiFetch({ model, messages:[{role:'user',content:prompt}], max_tokens:800 });
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(String(detail.error?.message ?? `ИИ ответил HTTP ${r.status}`));
    }
    const d = await r.json();
    reportAiUsage('Мой анализ', d, { model: r.headers.get('x-sima-model') || d?.model || model });
    const t = d.choices?.[0]?.message?.content;
    if (!t) throw new Error('Пустой ответ');
    return t;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private _paint() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      const focused = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
      const focusId = focused && this.el.contains(focused) ? focused.id : '';
      const selection = focused ? [focused.selectionStart, focused.selectionEnd] : [];
      const scroll = this.resetScroll ? 0 : this.el.querySelector<HTMLElement>('.ca-body')?.scrollTop ?? 0;
      this.resetScroll = false;
      const drafts = [...this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.ip-review input,.ip-review select,.ip-ref-form input,#ip-bulk-comment,#ip-bulk-status,#ip-article,#ip-scope')]
        .map(input => ({ id: input.id, name: input.name, value: input.value }));
      const openDetails = [...this.el.querySelectorAll<HTMLDetailsElement>('details[open][data-key]')].map(d => d.dataset.key);
      const hadDrawer = this._drawerOpen; this._drawerOpen = !!this.drawerCard;
      const activeWork = this.loading || this.ipAudit.loading || this.ipAudit.busy || this.aiRunning || this.aiApplying || this.fixedVerifying;
      this.el.innerHTML = `<div class="ca-root${activeWork ? ' ca-is-busy' : ''}">${activeWork ? '<div class="ca-activity" role="progressbar" aria-label="Идёт обработка"><span></span></div>' : ''}${this._head()}${this._body()}</div>${this._drawer(hadDrawer)}`;
      const body = this.el.querySelector<HTMLElement>('.ca-body'); if (body) body.scrollTop = scroll;
      this.el.querySelectorAll<HTMLDetailsElement>('details[data-key]').forEach(d => { if (openDetails.includes(d.dataset.key)) d.open = true; });
      for (const draft of drafts) {
        const next = this.el.querySelector<HTMLInputElement | HTMLSelectElement>(draft.id ? `#${CSS.escape(draft.id)}` : `.ip-ref-form [name="${CSS.escape(draft.name)}"]`);
        if (next) next.value = draft.value;
      }
      if (focusId) {
        const next = this.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(focusId)}`);
        if (next) { next.focus({ preventScroll: true }); try { next.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0); } catch { /* selects / number inputs */ } }
      }
    });
  }

  /** Update the active audit row without rebuilding a potentially large result list. */
  private _paintAuditProgress() {
    const stage = this.el.querySelector<HTMLElement>('.ip-current-stage');
    if (stage) stage.textContent = this.ipAudit.currentStage || 'Выполняю проверку карточки';
    const notice = this.el.querySelector<HTMLElement>('.ip-notice');
    if (this.ipAudit.message) {
      if (notice) notice.textContent = this.ipAudit.message;
      else { this._paint(); return; }
    }
    const run = this.ipAudit.runs.find(item => item.id === this.ipAudit.selectedRun);
    const progress = this.el.querySelector<HTMLElement>('.ip-progress progress');
    if (run && progress instanceof HTMLProgressElement) {
      progress.max = Math.max(1, run.total);
      progress.value = run.processed;
      const label = this.el.querySelector<HTMLElement>('.ip-progress > div span');
      if (label) label.textContent = `${run.processed} из ${run.total} карточек · ${this.ipAudit.findings.filter(f => f.run_id === run.id).length} результатов · ошибок ${run.errors}`;
    }
  }

  private _head(): string {
    const rights = this.analysisKind === 'rights';
    const qualityTabs = [['overview','Обзор'],['issues','Проблемы'],['ai','ИИ-улучшение'],['fixed','Исправленные'],['settings','Настройки']];
    const rightsTabs = [['overview','Проверка'],['results','Результаты'],['history','История'],['references','Эталоны'],['settings','Настройки']];
    const tabs = rights ? rightsTabs : qualityTabs;
    const active = rights ? this.ipAudit.section : this.activeTab;
    return `<header class="ca-head"><div class="ca-topline"><div class="ca-brand"><span class="ca-brand-symbol">◈</span><span>Анализ</span></div>
      <div class="ca-mode-island" role="tablist" aria-label="Вид анализа">
        <button role="tab" aria-selected="${!rights}" class="${!rights ? 'on' : ''}" onclick="window.myAnalysisModule?.setKind('quality')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 19h16M7 15V9m5 6V5m5 10v-3"/></svg>Анализ качества</button>
        <button role="tab" aria-selected="${rights}" class="${rights ? 'on' : ''}" onclick="window.myAnalysisModule?.setKind('rights')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></svg>Анализ прав</button>
      </div><button class="ca-refresh${this.loading ? ' busy' : ''}" title="Обновить товары" onclick="window.myAnalysisModule?.reload()" ${this.loading ? 'disabled' : ''}>↻</button></div>
      <div class="ca-section-line"><nav class="ca-subnav">${tabs.map(([id, label]) => `<button class="${active === id ? 'on' : ''}" onclick="window.myAnalysisModule?.${rights ? 'ipSection' : 'setTab'}('${id}')">${label}${id === 'fixed' && this.fixedItems.length ? `<small>${this.fixedItems.length}</small>` : ''}</button>`).join('')}</nav>${aiModelButton(rights ? 'rights' : 'quality', { vision: rights })}</div></header>`;
  }

  private _qualityScope(): string {
    const stores = this._stores();
    const selected = this.qualityStores ?? new Set(stores.map(s => s.id));
    const cardsByStore = new Map<string, number>();
    for (const card of this.cards) cardsByStore.set(card.storeId, (cardsByStore.get(card.storeId) ?? 0) + 1);
    return `<div class="ca-scope-head"><div><b>Магазины для проверки</b><p>Будут обработаны только отмеченные магазины.</p></div><div><button class="ca-text-btn" onclick="window.myAnalysisModule?.qualityChooseAll(true)">Все</button><button class="ca-text-btn" onclick="window.myAnalysisModule?.qualityChooseAll(false)">Снять выбор</button></div></div>
      <div class="ca-scope-grid">${(['wb','ozon','yandex'] as const).map(mp => {
        const list = stores.filter(s => s.mp === mp); if (!list.length) return '';
        return `<div class="ca-scope-group"><label class="ca-scope-mp"><input type="checkbox" ${list.every(s => selected.has(s.id)) ? 'checked' : ''} onchange="window.myAnalysisModule?.qualityToggleMp('${mp}')"><span class="ca-mp-dot" style="background:${MP_COLOR[mp]}"></span>${MP_NAME[mp]}</label>${list.map(s => `<label><input type="checkbox" ${selected.has(s.id) ? 'checked' : ''} onchange="window.myAnalysisModule?.qualityToggleStore('${s.id}')"><span>${this._e(s.name)}</span><small>${cardsByStore.get(s.id) ?? 0}</small></label>`).join('')}</div>`;
      }).join('') || '<p class="ca-muted">Подключённых магазинов пока нет.</p>'}</div>`;
  }

  private _qualityOverview(): string {
    const cards = this._scopeCards();
    const errors = cards.filter(c => c.issues.some(i => i.severity === 'error')).length;
    const warnings = cards.filter(c => !c.issues.some(i => i.severity === 'error') && c.issues.length > 0).length;
    const average = cards.length ? Math.round(cards.reduce((n,c) => n + c.score, 0) / cards.length) : 0;
    return `<div class="ca-body"><div class="ca-intro"><div><span class="ca-eyebrow">КАРТОЧКИ ТОВАРОВ</span><h1>Качество, которое видно</h1><p>Найдите пропущенные фото, слабые названия и ошибки карточек. ИИ поможет подготовить улучшения.</p></div><div class="ca-overall"><b>${average}</b><span>из 100 · средняя оценка</span></div></div>
      <div class="ca-metrics"><div><span>В выбранных магазинах</span><b>${cards.length}</b></div><div><span>С ошибками</span><b class="ca-error">${errors}</b></div><div><span>Требуют улучшения</span><b class="ca-warning">${warnings}</b></div><div><span>Без замечаний</span><b class="ca-success">${cards.filter(c => !c.issues.length).length}</b></div></div>
      <section class="ca-surface">${this._qualityScope()}<div class="ca-filter-row"><label><input type="checkbox" ${this.filterByStock ? 'checked' : ''} onchange="window.myAnalysisModule?.setFilterByStock(this.checked)"> Только с остатками</label><label><input type="checkbox" ${this.filterBySelling ? 'checked' : ''} onchange="window.myAnalysisModule?.setFilterBySelling(this.checked)"> Только продающиеся</label></div><div class="ca-launch"><span>Статус, фото, название и цена · без обращения к ИИ</span><button class="ca-primary" onclick="window.myAnalysisModule?.setTab('issues')" ${!cards.length ? 'disabled' : ''}>Проверить качество <span>→</span></button></div></section>
      <div class="ca-help-grid"><button class="ca-help-card" onclick="window.myAnalysisModule?.setTab('ai')"><span>✦</span><b>Улучшить с ИИ</b><small>Предложения названий с учётом описания товара</small><i>→</i></button><button class="ca-help-card" onclick="window.myAnalysisModule?.setTab('fixed')"><span>↻</span><b>Проверить изменения</b><small>Убедиться, что маркетплейс принял правки</small><i>→</i></button></div></div>`;
  }

  private _qualityToolbar(): string {
    const stores = this._stores().filter(s => !this.qualityStores || this.qualityStores.has(s.id));
    return `<div class="ca-quality-toolbar"><input id="ca-quality-search" class="ca-search" type="search" placeholder="Название или артикул…" value="${this._e(this.searchQ)}" oninput="window.myAnalysisModule?.setSearch(this.value)">
      <select class="ca-search" aria-label="Маркетплейс" onchange="window.myAnalysisModule?.setMp(this.value)">${[['all','Все площадки'],['wb','Wildberries'],['ozon','Ozon'],['yandex','Яндекс Маркет']].map(([id,n]) => `<option value="${id}" ${this.mpFilter === id ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <select class="ca-search" aria-label="Магазин" onchange="window.myAnalysisModule?.setStore(this.value)"><option value="all">Все выбранные магазины</option>${stores.filter(st => this.mpFilter === 'all' || st.mp === this.mpFilter).map(st => `<option value="${st.id}" ${this.storeFilter === st.id ? 'selected' : ''}>${this._e(st.name)}</option>`).join('')}</select>
      ${this.activeTab === 'issues' ? `<select class="ca-search" aria-label="Тип проблемы" onchange="window.myAnalysisModule?.setIssueFilter(this.value)">${[['all','Все карточки'],['errors','С ошибками'],['blocked','Заблокированы'],['few_photos','Мало фото']].map(([id,n]) => `<option value="${id}" ${this.issueFilter === id ? 'selected' : ''}>${n}</option>`).join('')}</select>` : ''}</div>`;
  }

  private _body(): string {
    if (this.analysisKind === 'rights') return this.ipAudit.render();
    if (this.loading && !this.loaded) return `<div class="ca-body ca-empty"><div class="ca-spin"></div><p>${this._e(this.loadMsg)}</p></div>`;
    if (this.error) return `<div class="ca-body ca-empty"><p>${this._e(this.error)}</p><button class="ca-btn" onclick="window.myAnalysisModule?.reload()">Повторить загрузку</button></div>`;
    if (this.activeTab === 'overview') return this._qualityOverview();
    if (this.activeTab === 'settings') return `<div class="ca-body"><section class="ca-surface"><div class="ca-setting-line"><div><h2>Модель для улучшения карточек</h2><p>Авто подбирает бесплатную модель. Базовая проверка качества выполняется без ИИ.</p></div>${aiModelButton('quality')}</div></section><section class="ca-surface">${this._qualityScope()}</section><p class="ca-footnote">Оценка качества помогает найти неполные карточки. Правки отправляются на маркетплейс после вашего подтверждения.</p></div>`;
    if (this.activeTab === 'fixed') return this._fixedBody();
    if (this.activeTab === 'ai') return `<div class="ca-workspace">${this._qualityToolbar()}${this._aiBody()}</div>`;
    const list = this._filtered();
    return `<div class="ca-workspace">${this._qualityToolbar()}<div class="ca-body"><div class="ca-results-caption"><span>${list.length} карточек</span><select aria-label="Сортировка карточек" onchange="window.myAnalysisModule?.setSort(this.value)">${[['score','Сначала низкая оценка'],['name','По названию'],['photos','По числу фото'],['mp','По площадке']].map(([id,n]) => `<option value="${id}" ${this.sortBy === id ? 'selected' : ''}>${n}</option>`).join('')}</select></div><div class="ca-list">${list.slice(0, this.shownCards).map(c => this._row(c)).join('') || '<div class="ca-empty"><b>Карточки не найдены</b><p>Измените фильтры или выберите магазины в обзоре.</p></div>'}</div>${list.length > this.shownCards ? '<button class="ca-btn ca-more" onclick="window.myAnalysisModule?.showMoreCards()">Показать ещё 30</button>' : ''}</div></div>`;
  }

  private _aiBody(): string {
    const nameIssueCards = this.loaded
      ? this._scopeCards().filter(c => (this.mpFilter === 'all' || c.mp === this.mpFilter) && (this.storeFilter === 'all' || c.storeId === this.storeFilter) && c.issues.some(i => i.field === 'name' || i.code === 'LONG_WORD'))
      : [];

    // ── Empty / loading states ─────────────────────────────────────────────
    if (!this.loaded && !this.aiSuggestions.length) {
      return `<div class="ca-body ca-ctr">
        <div style="font-size:36px">✨</div>
        <div class="ca-hint">Сначала загрузите карточки на вкладке «Проблемы».</div>
        <button class="ca-btn" onclick="window.myAnalysisModule?.setTab('issues')">Перейти к проблемам</button>
      </div>`;
    }

    if (!this.aiSuggestions.length) {
      const n = nameIssueCards.length;
      return `<div class="ca-body ca-ctr">
        <div style="font-size:48px">✨</div>
        <div class="ca-ai-intro-title">ИИ-исправление названий</div>
        <div class="ca-ai-intro-text">
          ИИ прочитает описание каждого товара, использует реальные факты и SEO-знания
          по маркетплейсам — и предложит продающее название без выдуманных характеристик.
        </div>
        <div class="ca-ai-prompt-block">
          <label class="ca-ai-prompt-label">Дополнительные пожелания (промпт):</label>
          <textarea class="ca-ai-prompt-ta" rows="3"
            placeholder="Например: все названия должны начинаться с бренда, использовать размер и цвет, без слова «качественный»…"
            oninput="window.myAnalysisModule?.aiSetCustomPrompt(this.value)"
          >${this._e(this.aiCustomPrompt)}</textarea>
        </div>
        ${n === 0
          ? `<div class="ca-hint">Нет карточек с проблемами в названиях — всё хорошо!</div>`
          : `<button class="ca-ai-run-btn${this.aiRunning?' busy':''}" onclick="window.myAnalysisModule?.aiRunAnalysis()">
              ${this.aiRunning
                ? `<div class="ca-spin-sm"></div> ${this.aiProgress || 'Анализируем…'}`
                : `✨ Запустить анализ (${n} карточ${n===1?'ка':n<5?'ки':'ек'})`}
            </button>`}
      </div>`;
    }

    // ── Review + apply UI ─────────────────────────────────────────────────
    const ok      = this.aiSuggestions.filter(s => s.applyResult === 'ok').length;
    const errored = this.aiSuggestions.filter(s => s.applyResult === 'error').length;
    const pending = this.aiSuggestions.filter(s => s.selected && s.applyResult !== 'ok').length;
    const allSel  = this.aiSuggestions.filter(s => s.applyResult !== 'ok').every(s => s.selected);

    const rows = this.aiSuggestions.map((s, i) => {
      const isOk  = s.applyResult === 'ok';
      const isErr = s.applyResult === 'error';
      return `
      <div class="ca-ai-row${isOk?' ai-ok':isErr?' ai-err':''}">
        <div class="ca-ai-row-top">
          ${isOk
            ? `<span class="ca-ai-chk ai-done">✅</span>`
            : `<input type="checkbox" class="ca-ai-chk" ${s.selected?'checked':''} onchange="window.myAnalysisModule?.aiToggleSuggestion(${i})">`}
          <span class="ca-mp-b" style="color:${MP_COLOR[s.mp]};border-color:${MP_COLOR[s.mp]}22;background:${MP_COLOR[s.mp]}14">${MP_NAME[s.mp]}</span>
          <span class="ca-ai-store">${this._e(s.storeName)}</span>
          <span class="ca-ai-vc">${this._e(s.vendorCode)}</span>
          ${isErr ? `<span class="ca-ai-err-badge">Ошибка</span>` : ''}
        </div>
        <div class="ca-ai-names">
          <div class="ca-ai-old"><span class="ca-ai-lbl">Было:</span> ${this._e(s.currentName)}</div>
          ${isOk
            ? `<div class="ca-ai-new-done"><span class="ca-ai-lbl">Применено:</span> ${this._e(s.suggestedName)}</div>`
            : isErr
              ? `<div class="ca-ai-err-msg">${this._e(s.applyError ?? 'Неизвестная ошибка')}</div>`
              : `<div class="ca-ai-new">
                  <span class="ca-ai-lbl">ИИ предлагает:</span>
                  <input class="ca-ai-inp" value="${this._e(s.editedName)}"
                    oninput="window.myAnalysisModule?.aiEditName(${i},this.value)" placeholder="Отредактируйте название…">
                </div>`}
        </div>
        ${s.issueLabels.length ? `<div class="ca-ai-issues">${s.issueLabels.map(l=>`<span class="ca-ic sev-warning">⚠️ ${this._e(l)}</span>`).join('')}</div>` : ''}
      </div>`;
    }).join('');

    return `<div class="ca-body">
      <div class="ca-ai-toolbar">
        <label class="ca-ai-selall">
          <input type="checkbox" ${allSel?'checked':''} onchange="window.myAnalysisModule?.aiSelectAll(this.checked)">
          Выбрать все
        </label>
        <div class="ca-ai-stats">
          ${ok      ? `<span class="ca-ai-stat ok">✅ Применено: ${ok}</span>` : ''}
          ${errored ? `<span class="ca-ai-stat err">🚫 Ошибок: ${errored}</span>` : ''}
        </div>
        <button class="ca-ai-apply-btn${(!pending||this.aiApplying)?' busy':''}"
          onclick="window.myAnalysisModule?.aiApplyAll()"
          ${!pending||this.aiApplying ? 'disabled' : ''}>
          ${this.aiApplying ? '<div class="ca-spin-sm"></div> Применяем…' : `Применить изменения (${pending})`}
        </button>
        <button class="ca-ai-rerun${this.aiRunning?' busy':''}" onclick="window.myAnalysisModule?.aiRunAnalysis()">
          ${this.aiRunning ? `<div class="ca-spin-sm"></div> ${this.aiProgress}` : '↻ Пересчитать'}
        </button>
      </div>
      <div class="ca-ai-prompt-inline">
        <span class="ca-ai-prompt-label">Пожелания к следующему пересчёту:</span>
        <textarea class="ca-ai-prompt-ta ca-ai-prompt-sm" rows="2"
          placeholder="Уточните формат, добавьте требования…"
          oninput="window.myAnalysisModule?.aiSetCustomPrompt(this.value)"
        >${this._e(this.aiCustomPrompt)}</textarea>
      </div>
      <div class="ca-ai-list">${rows}</div>
    </div>`;
  }

  private _fixedBody(): string {
    if (!this.fixedItems.length)
      return `<div class="ca-body ca-ctr"><div style="font-size:40px">✅</div>
        <div class="ca-hint">Здесь появятся товары после того, как вы сохраните изменения в карточке.<br>Мы отследим, приняли ли маркетплейсы ваши правки.</div></div>`;

    const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const ICON: Record<FixedItem['status'], string> = {
      confirmed:'✅', partial:'◐', unchanged:'⚠️', gone:'🗑', error:'🚫', pending:'🔄',
    };
    const LABEL: Record<FixedItem['status'], string> = {
      confirmed:'Применено на маркетплейсе',
      partial:  'Применено частично',
      unchanged:'Маркетплейс ещё не применил',
      gone:     'Товар не найден',
      error:    'Ошибка проверки',
      pending:  'Ожидает проверки',
    };

    const rows = this.fixedItems.map((f, fi) => `
      <div class="ca-fx-row">
        <div class="ca-fx-top">
          <span class="ca-mp-b" style="color:${MP_COLOR[f.mp]};border-color:${MP_COLOR[f.mp]}22;background:${MP_COLOR[f.mp]}14">${MP_NAME[f.mp]}</span>
          <span class="ca-fx-store">${this._e(f.storeName)}</span>
          <span class="ca-fx-date">${fmtDate(f.fixedAt)}</span>
        </div>
        <div class="ca-fx-vc-row">
          <span class="ca-fx-vc-label">Артикул:</span>
          <span class="ca-fx-vc">${this._e(f.vendorCode)}</span>
          <button class="ca-fx-copy" title="Скопировать артикул" onclick="window.myAnalysisModule?.copyVendorCode(${fi})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Скопировать
          </button>
        </div>
        ${f.oldName !== f.newName ? `
        <div class="ca-fx-rename-block">
          <div class="ca-fx-rename-label">Изменение названия:</div>
          <div class="ca-fx-rename-old">До: «${this._e(f.oldName)}»</div>
          <div class="ca-fx-rename-new">После: «${this._e(f.newName)}»</div>
        </div>` : `<div class="ca-fx-curname">${this._e(f.newName || f.oldName)}</div>`}
        ${f.oldPhotoCount !== f.newPhotoCount ? `
        <div class="ca-fx-photos">Фото: ${f.oldPhotoCount} → <b>${f.newPhotoCount}</b></div>` : ''}
        <div class="ca-fx-issues">
          Исправлено: ${f.targetIssues.map(i => {
            const still = f.remaining.includes(i.code);
            return `<span class="ca-ic sev-${i.severity}${still?' still':''}">${still?'⏳':'✔'} ${this._e(i.label)}</span>`;
          }).join('')}
        </div>
        <div class="ca-fx-status ${f.status}">${ICON[f.status]} ${LABEL[f.status]}${f.verifiedAt ? ` · ${fmtDate(f.verifiedAt)}` : ''}</div>
        ${f.verifyNote ? `<div class="ca-fx-note">${this._e(f.verifyNote)}</div>` : ''}
        ${f.status === 'unchanged' && f.mp === 'ozon' ? `<div class="ca-fx-note">Ozon применяет правки не мгновенно — проверьте ещё раз через несколько минут.</div>` : ''}
        <div class="ca-fx-actions">
          <button class="ca-fx-btn${this.fixedVerifying?' busy':''}" onclick="window.myAnalysisModule?.verifyFixed('${this._e(f.uid)}')">
            ${this.fixedVerifying?'<div class="ca-spin-sm"></div>':''} Проверить
          </button>
          ${f.status === 'unchanged' || f.status === 'partial' || f.status === 'error'
            ? `<button class="ca-fx-retry" onclick="window.myAnalysisModule?.retryFixed('${this._e(f.uid)}')">↩ Отправить повторно</button>` : ''}
          <button class="ca-fx-del" onclick="window.myAnalysisModule?.removeFixed('${this._e(f.uid)}')">Удалить</button>
        </div>
      </div>`).join('');

    const verifyAllBtn = `<button class="ca-fx-all-btn${this.fixedVerifying?' busy':''}" onclick="window.myAnalysisModule?.verifyAllFixed()">
      ${this.fixedVerifying?'<div class="ca-spin-sm"></div> Проверяем…':'↻ Обновить и проверить все'}
    </button>`;

    return `<div class="ca-body"><div class="ca-fx-head">${verifyAllBtn}</div><div class="ca-fx-list">${rows}</div></div>`;
  }

  private _row(c: ProductCard) {
    const thumb = c.photoUrls[0] || '';
    const cls = c.score >= 80 ? 'good' : c.score >= 50 ? 'med' : 'bad';
    const chips = c.issues.slice(0,3).map(i=>`<span class="ca-ic sev-${i.severity}">${SEV_ICON[i.severity]} ${this._e(i.label)}</span>`).join('');
    const more  = c.issues.length > 3 ? `<span class="ca-ic-more">+${c.issues.length-3}</span>` : '';
    return `<div class="ca-row" role="button" tabindex="0" onkeydown="if(event.key==='Enter')this.click()" onclick="window.myAnalysisModule?.openDrawer('${this._e(c.uid)}')">
      <div class="ca-thumb">${thumb?`<img src="${this._e(thumb)}" loading="lazy" alt="">`:'<span class="ca-nophoto">📷</span>'}</div>
      <div class="ca-info">
        <div class="ca-nm">${this._e(c.name)}</div>
        <div class="ca-meta">
          <span class="ca-mp-b" style="color:${MP_COLOR[c.mp]};border-color:${MP_COLOR[c.mp]}22;background:${MP_COLOR[c.mp]}14">${MP_NAME[c.mp]}</span>
          <span class="ca-vc">${this._e(c.vendorCode)}</span>
          <span class="ca-sn">${this._e(c.storeName)}</span>
        </div>
        <div class="ca-ic-row">${chips}${more}</div>
      </div>
      <div class="ca-right">
        <div class="ca-score ${cls}">
          <svg viewBox="0 0 36 36" width="46" height="46">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--bg3)" stroke-width="3"/>
            <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" stroke-width="3"
              stroke-dasharray="${(c.score*94.2/100).toFixed(1)} 94.2"
              stroke-linecap="round" transform="rotate(-90 18 18)"/>
          </svg>
          <span>${c.score}</span>
        </div>
        <div class="ca-ph-cnt">${c.photoUrls.length} фото</div>
      </div>
    </div>`;
  }

  private _drawer(noAnim: boolean) {
    const c = this.drawerCard;
    if (!c) return '';

    const mpLink: Record<Mp, string> = {
      ozon:    `https://seller.ozon.ru/app/products`,
      wb:      `https://seller.wildberries.ru/product-list`,
      yandex:  `https://partner.market.yandex.ru/business/${c.businessId || 0}/assortment`,
    };

    return `
    <div class="ca-bd" onclick="window.myAnalysisModule?.closeDrawer()"></div>
    <div role="dialog" aria-modal="true" aria-label="Редактирование карточки" class="ca-dw${noAnim?' noanim':''}">
      <div class="ca-dh">
        <div class="ca-dt">
          <span class="ca-mp-b" style="color:${MP_COLOR[c.mp]};border-color:${MP_COLOR[c.mp]}22;background:${MP_COLOR[c.mp]}14">${MP_NAME[c.mp]}</span>
          <span>${this._e(c.storeName)}</span>
        </div>
        <a class="ca-ext" href="${mpLink[c.mp]}" target="_blank" rel="noopener" title="Открыть на маркетплейсе">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          МП
        </a>
        <button class="ca-cl" onclick="window.myAnalysisModule?.closeDrawer()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="ca-ds"><div class="ca-setting-line"><span>Модель ИИ</span>${aiModelButton('quality')}</div>
        ${/* Issues block */ c.issues.length ? `
        <div class="ca-sec">
          <div class="ca-sec-t">Проблемы (${c.issues.length})</div>
          ${c.issues.map(i=>`<div class="ca-iss sev-${i.severity}">${SEV_ICON[i.severity]} ${this._e(i.label)}</div>`).join('')}
        </div>` : `<div class="ca-ok">✅ Проблем не найдено</div>`}

        ${/* Photos section */`
        <div class="ca-sec">
          <div class="ca-sec-t">Фотографии (${this.drawerPhotos.length})</div>
          ${this.drawerPhotos.length ? `
          <div class="ca-ph-grid">
            ${this.drawerPhotos.map((u,i)=>`
              <div class="ca-ph-item">
                <img src="${this._e(u)}" loading="lazy" alt="">
                <button class="ca-ph-del" onclick="event.stopPropagation();window.myAnalysisModule?.drawerRemovePhoto(${i})" title="Удалить">✕</button>
              </div>`).join('')}
          </div>` : `<div class="ca-empty-ph">📷 Нет фотографий</div>`}
          ${c.mp === 'ozon' ? `
          <div class="ca-add-ph">
            <input class="ca-field ca-url-in" placeholder="URL фото (https://...)" value="${this._e(this.drawerNewPhotoUrl)}"
              oninput="window.myAnalysisModule?.drawerSetNewUrl(this.value)"
              onkeydown="if(event.key==='Enter')window.myAnalysisModule?.drawerAddPhoto()">
            <button class="ca-add-ph-btn" onclick="window.myAnalysisModule?.drawerAddPhoto()">Добавить</button>
          </div>
          <div class="ca-hint-sm">Ozon скачает фото по URL автоматически после сохранения</div>` : `
          <div class="ca-hint-sm">
            <a href="${mpLink[c.mp]}" target="_blank" rel="noopener">Управление фото — в кабинете ${MP_NAME[c.mp]} →</a>
          </div>`}
        </div>`}

        <div class="ca-sec">
          <div class="ca-sec-t">Название</div>
          <textarea id="ca-name-ta" class="ca-field" rows="2"
            oninput="window.myAnalysisModule?.drawerSetName(this.value)">${this._e(this.drawerName)}</textarea>
          <button class="ca-ai-btn${this.drawerAiLoading==='name'?' busy':''}"
            onclick="window.myAnalysisModule?.aiSuggestName()">
            ${this.drawerAiLoading==='name'?'<div class="ca-spin-sm"></div>':'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'}
            ИИ: предложить варианты
          </button>
          ${this.drawerAiNames.length ? `
          <div class="ca-ai-sug">
            <div class="ca-ai-sug-t">Варианты от ИИ — нажмите чтобы выбрать:</div>
            ${this.drawerAiNames.map((n,i)=>`
              <div class="ca-ai-item" onclick="window.myAnalysisModule?.pickAiName(${i})">
                ${this._e(n)}<span class="ca-pick">Выбрать</span>
              </div>`).join('')}
          </div>` : ''}
        </div>

        <div class="ca-sec">
          <div class="ca-sec-t">Описание</div>
          <textarea id="ca-desc-ta" class="ca-field" rows="7"
            placeholder="Загружаем описание…"
            oninput="window.myAnalysisModule?.drawerSetDesc(this.value)">${this._e(this.drawerDesc)}</textarea>
          <button class="ca-ai-btn${this.drawerAiLoading==='desc'?' busy':''}"
            onclick="window.myAnalysisModule?.aiImproveDesc()">
            ${this.drawerAiLoading==='desc'?'<div class="ca-spin-sm"></div>':'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'}
            ИИ: улучшить описание
          </button>
        </div>

        <div class="ca-vc-row"><span class="ca-vc-l">Артикул:</span><span class="ca-vc">${this._e(c.vendorCode)}</span></div>
      </div>

      <div class="ca-df">
        <button class="ca-save${this.drawerSaving?' busy':''}" onclick="window.myAnalysisModule?.drawerSave()">
          ${this.drawerSaving?'<div class="ca-spin-sm"></div> Сохраняем…':'Сохранить изменения'}
        </button>
        <button class="ca-cancel" onclick="window.myAnalysisModule?.closeDrawer()">Отмена</button>
      </div>
    </div>`;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private _filtered(): ProductCard[] {
    let list = this._scopeCards();
    if (this.mpFilter !== 'all')     list = list.filter(c => c.mp === this.mpFilter);
    if (this.storeFilter !== 'all')  list = list.filter(c => c.storeId === this.storeFilter);
    if (this.issueFilter === 'errors')    list = list.filter(c => c.issues.some(i=>i.severity==='error'));
    if (this.issueFilter === 'blocked')   list = list.filter(c => c.issues.some(i=>i.code==='BLOCKED'||i.code==='ARCHIVED'));
    if (this.issueFilter === 'few_photos')list = list.filter(c => c.issues.some(i=>i.field==='photos'));
    if (this.searchQ.trim()) {
      const q = this.searchQ.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.vendorCode.toLowerCase().includes(q));
    }
    return [...list].sort((a,b) => {
      if (this.sortBy==='score')  return a.score-b.score;
      if (this.sortBy==='name')   return a.name.localeCompare(b.name,'ru');
      if (this.sortBy==='photos') return a.photoUrls.length-b.photoUrls.length;
      if (this.sortBy==='mp')     return a.mp.localeCompare(b.mp);
      return 0;
    });
  }

  private _e(s: string|number|undefined) {
    return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

}
