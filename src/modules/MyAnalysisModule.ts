/**
 * Аудит карточек товаров:
 * – ошибки с маркетплейсов (статус, фото, название, описание, цена)
 * – оценка качества 0-100, фильтры по МП / магазину / типу ошибки
 * – редактирование названия, описания, фото прямо здесь
 * – ИИ-подсказки через OpenRouter
 */
import { dbFetch, dbFetchAll } from '../services/dbClient';
import { companyService } from '../services/companyService';
import { ozonApi } from '../services/ozonApi';
import { wbApi } from '../services/wbApi';
import { yandexApi } from '../services/yandexApi';
import { debug } from '@/utils/debug';
import { reportAiUsage } from '@/services/aiUsage';

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

  // State
  private loading = false;
  private loaded  = false;
  private error: string | null = null;
  private loadMsg = 'Загружаем…';
  private _raf = 0;
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
  private activeTab: 'issues' | 'fixed' | 'ai' = 'issues';
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
    if (!this.loaded && !this.loading) await this._load();
    else this._paint();
  }

  hide() { this.el.style.display = 'none'; }

  // ─── Public methods ───────────────────────────────────────────────────────

  setMp(m: MpFilter)       { this.mpFilter = m; this.storeFilter = 'all'; this._paint(); }
  setStore(id: string)     { this.storeFilter = id; this._paint(); }
  setIssueFilter(f: IssueFilter){ this.issueFilter = f; this._paint(); }
  setSort(s: typeof this.sortBy){ this.sortBy = s; this._paint(); }
  setSearch(v: string)     { this.searchQ = v; this._paint(); }
  async reload()           { this.loaded = false; await this._load(); }

  setTab(t: 'issues' | 'fixed' | 'ai') { this.activeTab = t; this._paint(); }

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

    const candidates = this.cards.filter(c =>
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
      this.ozStores = oz;
      this.wbStores = wb;
      this.yaStores = ya;

      const ozIds = oz.map(s => s.id);
      const wbIds = wb.map(s => s.id);
      const yaIds = ya.map(s => s.id);
      const sName = (id: string) => [...oz,...wb,...ya].find(s => s.id === id)?.name ?? id;

      this.loadMsg = 'Загружаем карточки…';
      this._paint();

      type OzP = { store_id:string; offer_id:string; product_id:number; name:string; price:number; images:string[]|null; status:string };
      type WbP = { store_id:string; nm_id:number; vendor_code:string; title:string; price:number; discount:number; pictures:string[]|null };
      type YaP = { store_id:string; offer_id:string; name:string; basic_price:number; pictures:string[]|null; archived:boolean };

      const [ozP, wbP, yaP] = await Promise.all([
        ozIds.length ? dbFetchAll<OzP>(`ozon_products?store_id=in.(${ozIds.join(',')})&select=store_id,offer_id,product_id,name,price,images,status`) : Promise.resolve<OzP[]>([]),
        wbIds.length ? dbFetchAll<WbP>(`wb_products?store_id=in.(${wbIds.join(',')})&select=store_id,nm_id,vendor_code,title,price,discount,pictures`) : Promise.resolve<WbP[]>([]),
        yaIds.length ? dbFetchAll<YaP>(`yandex_products?store_id=in.(${yaIds.join(',')})&select=store_id,offer_id,name,basic_price,pictures,archived`) : Promise.resolve<YaP[]>([]),
      ]);

      const cards: ProductCard[] = [];

      for (const p of ozP) {
        const base = { uid:`ozon:${p.store_id}:${p.offer_id}`, mp:'ozon' as Mp,
          storeId:p.store_id, storeName:sName(p.store_id), vendorCode:p.offer_id,
          name:p.name||p.offer_id, photoUrls:p.images||[], price:Number(p.price)||0,
          rawStatus:p.status||'', productId:Number(p.product_id)||undefined };
        cards.push({ ...base, issues:auditCard(base), score:scoreCard(auditCard(base)) });
      }
      for (const p of wbP) {
        const base = { uid:`wb:${p.store_id}:${p.vendor_code}`, mp:'wb' as Mp,
          storeId:p.store_id, storeName:sName(p.store_id), vendorCode:p.vendor_code,
          name:p.title||p.vendor_code, photoUrls:p.pictures||[],
          price:Number(p.price)*(1-(Number(p.discount)||0)/100), rawStatus:'active',
          nmId:Number(p.nm_id)||undefined };
        cards.push({ ...base, issues:auditCard(base), score:scoreCard(auditCard(base)) });
      }
      for (const p of yaP) {
        const ys = ya.find(s=>s.id===p.store_id);
        const base = { uid:`yandex:${p.store_id}:${p.offer_id}`, mp:'yandex' as Mp,
          storeId:p.store_id, storeName:sName(p.store_id), vendorCode:p.offer_id,
          name:p.name||p.offer_id, photoUrls:p.pictures||[], price:Number(p.basic_price)||0,
          rawStatus:p.archived?'archived':'active',
          businessId:ys?.business_id??undefined, campaignId:ys?.campaign_id??undefined };
        cards.push({ ...base, issues:auditCard(base), score:scoreCard(auditCard(base)) });
      }

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
    const key   = (window as any).sdAssistantModule?.aiKey || sessionStorage.getItem('sd_ai_key') || '';
    const model = localStorage.getItem('sd_ai_model') || 'anthropic/claude-haiku-4-5';
    if (!key) throw new Error('Нет AI-ключа. Добавьте его в настройках Ассистента.');
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${key}`,
        'HTTP-Referer':window.location.origin, 'X-Title':'SimaDesk' },
      body: JSON.stringify({ model, messages:[{role:'user',content:prompt}], max_tokens:800, temperature:0.7 }),
    });
    const d = await r.json();
    reportAiUsage('Мой анализ', d);
    const t = d.choices?.[0]?.message?.content;
    if (!t) throw new Error('Пустой ответ');
    return t;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private _paint() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      // Preserve focused textarea state before wiping innerHTML
      const activeEl = document.activeElement;
      let restoreTaId: string | null = null;
      let restoreSel = [0, 0];
      if (activeEl instanceof HTMLTextAreaElement && this.el.contains(activeEl) && activeEl.id) {
        restoreTaId = activeEl.id;
        restoreSel = [activeEl.selectionStart ?? 0, activeEl.selectionEnd ?? 0];
      }

      const hadDrawer = this._drawerOpen;
      this._drawerOpen = !!this.drawerCard;
      this.el.innerHTML =
        this._styles(hadDrawer) +
        `<div class="ca-root">${this._head()}${this._body()}</div>` +
        this._drawer(hadDrawer);

      // Restore focus and cursor position
      if (restoreTaId) {
        const ta = this.el.querySelector<HTMLTextAreaElement>(`#${restoreTaId}`);
        if (ta) { ta.focus(); ta.setSelectionRange(restoreSel[0], restoreSel[1]); }
      }
    });
  }

  private _head() {
    const allStores = [
      ...this.ozStores.map(s=>({id:s.id,name:s.name,mp:'ozon' as Mp})),
      ...this.wbStores.map(s=>({id:s.id,name:s.name,mp:'wb' as Mp})),
      ...this.yaStores.map(s=>({id:s.id,name:s.name,mp:'yandex' as Mp})),
    ].filter(s => this.mpFilter === 'all' || s.mp === this.mpFilter);

    const mps: [MpFilter,string][] = [['all','Все МП'],['ozon','Ozon'],['wb','WB'],['yandex','Яндекс']];
    const iFilters: [IssueFilter,string][] = [['all','Все'],['errors','Ошибки'],['blocked','Заблокированные'],['few_photos','Мало фото']];

    const total = this.cards.length;
    const errN  = this.cards.filter(c=>c.issues.some(i=>i.severity==='error')).length;
    const warnN = this.cards.filter(c=>!c.issues.some(i=>i.severity==='error') && c.issues.some(i=>i.severity==='warning')).length;

    const fixedCount = this.fixedItems.length;
    return `<div class="ca-head">
      <div class="ca-head-top">
        <div class="ca-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Анализ карточек
        </div>
        ${total ? `<div class="ca-chips">
          <span class="ca-chip">${total} товаров</span>
          ${errN  ? `<span class="ca-chip err">${errN} ошибок</span>` : ''}
          ${warnN ? `<span class="ca-chip warn">${warnN} предупреждений</span>` : ''}
        </div>` : ''}
        <button class="ca-icon-btn${this.loading?' spin':''}" onclick="window.myAnalysisModule?.reload()" title="Обновить">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>

      <div class="ca-tabs">
        <button class="ca-tab${this.activeTab==='issues'?' on':''}" onclick="window.myAnalysisModule?.setTab('issues')">Проблемы</button>
        <button class="ca-tab${this.activeTab==='fixed'?' on':''}" onclick="window.myAnalysisModule?.setTab('fixed')">
          Исправленные${fixedCount ? `<span class="ca-tab-badge">${fixedCount}</span>` : ''}
        </button>
        <button class="ca-tab ca-tab-ai${this.activeTab==='ai'?' on':''}" onclick="window.myAnalysisModule?.setTab('ai')">
          ✨ ИИ Исправление
        </button>
      </div>

      ${this.activeTab === 'issues' ? `<div class="ca-filters">
        <div class="ca-search-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="ca-search" placeholder="Поиск по названию или артикулу…" value="${this._e(this.searchQ)}"
            oninput="window.myAnalysisModule?.setSearch(this.value)">
        </div>

        <div class="ca-filter-row">
          <span class="ca-filter-label">МП:</span>
          <div class="ca-pills">
            ${mps.map(([m,l])=>`<button class="ca-pill${this.mpFilter===m?' on':''}" onclick="window.myAnalysisModule?.setMp('${m}')">${l}</button>`).join('')}
          </div>
        </div>

        ${allStores.length > 1 ? `
        <div class="ca-filter-row">
          <span class="ca-filter-label">Магазин:</span>
          <div class="ca-pills">
            <button class="ca-pill${this.storeFilter==='all'?' on':''}" onclick="window.myAnalysisModule?.setStore('all')">Все</button>
            ${allStores.map(s=>`<button class="ca-pill${this.storeFilter===s.id?' on':''}" onclick="window.myAnalysisModule?.setStore('${s.id}')"
              style="--mp-c:${MP_COLOR[s.mp]}">${s.name}</button>`).join('')}
          </div>
        </div>` : ''}

        <div class="ca-filter-row">
          <span class="ca-filter-label">Проблемы:</span>
          <div class="ca-pills">
            ${iFilters.map(([f,l])=>`<button class="ca-pill${this.issueFilter===f?' on':''}" onclick="window.myAnalysisModule?.setIssueFilter('${f}')">${l}</button>`).join('')}
          </div>
        </div>

        <div class="ca-filter-row">
          <span class="ca-filter-label">Сортировка:</span>
          <div class="ca-pills">
            ${(['score','name','photos','mp'] as const).map(s=>`<button class="ca-pill${this.sortBy===s?' on':''}" onclick="window.myAnalysisModule?.setSort('${s}')">${{score:'Оценка',name:'Название',photos:'Фото',mp:'МП'}[s]}</button>`).join('')}
          </div>
        </div>
      </div>` : ''}
    </div>`;
  }

  private _body() {
    if (this.activeTab === 'fixed') return this._fixedBody();
    if (this.activeTab === 'ai')    return this._aiBody();

    if (this.loading && !this.loaded)
      return `<div class="ca-body ca-ctr"><div class="ca-spin"></div><span class="ca-hint">${this.loadMsg}</span></div>`;
    if (this.error)
      return `<div class="ca-body ca-ctr"><div style="font-size:36px">⚠️</div><div class="ca-hint">${this._e(this.error)}</div>
        <button class="ca-btn" onclick="window.myAnalysisModule?.reload()">Повторить</button></div>`;
    if (!this.cards.length)
      return `<div class="ca-body ca-ctr"><div style="font-size:40px">🛍️</div>
        <div class="ca-hint">Нет товаров. Сначала добавьте магазины и запустите синхронизацию.</div></div>`;

    const list = this._filtered();
    if (!list.length)
      return `<div class="ca-body ca-ctr"><div style="font-size:36px">✅</div>
        <div class="ca-hint">По выбранным фильтрам всё в порядке</div>
        <button class="ca-btn" onclick="window.myAnalysisModule?.setIssueFilter('all');window.myAnalysisModule?.setMp('all');window.myAnalysisModule?.setStore('all')">Сбросить фильтры</button></div>`;

    return `<div class="ca-body"><div class="ca-list">${list.map(c=>this._row(c)).join('')}</div></div>`;
  }

  private _aiBody(): string {
    const nameIssueCards = this.loaded
      ? this.cards.filter(c => c.issues.some(i => i.field === 'name' || i.code === 'LONG_WORD'))
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
    const chips = c.issues.slice(0,3).map(i=>`<span class="ca-ic sev-${i.severity}">${SEV_ICON[i.severity]} ${i.label}</span>`).join('');
    const more  = c.issues.length > 3 ? `<span class="ca-ic-more">+${c.issues.length-3}</span>` : '';
    return `<div class="ca-row" onclick="window.myAnalysisModule?.openDrawer('${this._e(c.uid)}')">
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
    <div class="ca-dw${noAnim?' noanim':''}">
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

      <div class="ca-ds">
        ${/* Issues block */ c.issues.length ? `
        <div class="ca-sec">
          <div class="ca-sec-t">Проблемы (${c.issues.length})</div>
          ${c.issues.map(i=>`<div class="ca-iss sev-${i.severity}">${SEV_ICON[i.severity]} ${i.label}</div>`).join('')}
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
    let list = this.cards;
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

  // ─── Styles ───────────────────────────────────────────────────────────────

  private _styles(_drawerAlreadyOpen: boolean) {
    // Dock is fixed bottom: 10px + ~60px height → reserve ~80px
    const dockH = (document.getElementById('app-dock')?.offsetHeight ?? 60) + 14;
    return `<style>
.ca-root{display:flex;flex-direction:column;height:100%;background:var(--bg);}

/* Head */
.ca-head{padding:14px 20px 0;border-bottom:1px solid var(--border);flex-shrink:0;}
.ca-head-top{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.ca-title{font-size:16px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;}
.ca-title svg{color:var(--accent-text);}
.ca-chips{display:flex;gap:5px;}
.ca-chip{font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:var(--bg3);color:var(--text2);}
.ca-chip.err{background:var(--red-dim);color:var(--red);}
.ca-chip.warn{background:rgba(251,191,36,.12);color:#fbbf24;}
.ca-icon-btn{margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:7px;color:var(--text2);cursor:pointer;padding:6px 9px;display:flex;align-items:center;transition:all .15s;}
.ca-icon-btn:hover{color:var(--text);}
.ca-icon-btn.spin svg,.ca-spin-sm{animation:ca-spin .7s linear infinite;}

.ca-filters{display:flex;flex-direction:column;gap:8px;padding-bottom:12px;}
.ca-search-row{display:flex;align-items:center;gap:7px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 12px;}
.ca-search-row svg{color:var(--text3);flex-shrink:0;}
.ca-search{background:transparent;border:none;outline:none;color:var(--text);font-size:13px;flex:1;}
.ca-search::placeholder{color:var(--text3);}
.ca-filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ca-filter-label{font-size:11px;font-weight:700;color:var(--text3);white-space:nowrap;min-width:64px;}
.ca-pills{display:flex;flex-wrap:wrap;gap:4px;}
.ca-pill{background:var(--bg3);border:1px solid transparent;color:var(--text2);font-size:12px;padding:4px 12px;border-radius:20px;cursor:pointer;transition:all .15s;font-weight:500;}
.ca-pill.on{background:var(--bg5);color:var(--text);font-weight:700;border-color:var(--border2);}
.ca-pill:hover:not(.on){color:var(--text);background:var(--bg4);}

/* Body */
.ca-body{flex:1;overflow:auto;padding:14px 20px;}
.ca-ctr{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;min-height:300px;}
.ca-spin{width:28px;height:28px;border:3px solid var(--bg3);border-top-color:var(--accent);border-radius:50%;animation:ca-spin .8s linear infinite;}
.ca-hint{color:var(--text2);font-size:13px;text-align:center;line-height:1.6;}
.ca-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:13px;padding:8px 18px;border-radius:8px;cursor:pointer;}
@keyframes ca-spin{to{transform:rotate(360deg);}}

/* Row */
.ca-list{display:flex;flex-direction:column;gap:7px;}
.ca-row{display:flex;align-items:center;gap:13px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:11px 14px;cursor:pointer;transition:border-color .15s,background .15s;}
.ca-row:hover{border-color:var(--border2);background:var(--bg3);}
.ca-thumb{width:54px;height:54px;border-radius:8px;overflow:hidden;flex-shrink:0;background:var(--bg3);display:flex;align-items:center;justify-content:center;}
.ca-thumb img{width:100%;height:100%;object-fit:cover;}
.ca-nophoto{font-size:20px;color:var(--text3);}
.ca-info{flex:1;min-width:0;}
.ca-nm{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;}
.ca-meta{display:flex;align-items:center;gap:7px;margin-bottom:5px;flex-wrap:wrap;}
.ca-mp-b{font-size:10px;font-weight:800;padding:2px 7px;border-radius:4px;border:1px solid;}
.ca-vc{font-family:'JetBrains Mono','SF Mono',monospace;font-size:11px;color:var(--text3);}
.ca-sn{font-size:11px;color:var(--text3);}
.ca-ic-row{display:flex;flex-wrap:wrap;gap:4px;}
.ca-ic{font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;}
.ca-ic.sev-error{background:var(--red-dim);color:var(--red);}
.ca-ic.sev-warning{background:rgba(251,191,36,.12);color:#fbbf24;}
.ca-ic.sev-info{background:var(--bg3);color:var(--text3);}
.ca-ic-more{font-size:11px;color:var(--text3);font-weight:700;padding:2px 4px;}
.ca-right{display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0;}
.ca-score{position:relative;display:flex;align-items:center;justify-content:center;width:46px;height:46px;}
.ca-score span{position:absolute;font-size:11px;font-weight:800;}
.ca-score.good{color:var(--green);}
.ca-score.med{color:#fbbf24;}
.ca-score.bad{color:var(--red);}
.ca-ph-cnt{font-size:11px;color:var(--text3);font-weight:600;}

/* Drawer */
.ca-bd{position:fixed;inset:0;background:rgba(0,0,0,.4);backdrop-filter:blur(2px);z-index:100;animation:ca-fi .2s;}
.ca-dw{position:fixed;top:0;right:0;bottom:${dockH}px;width:490px;max-width:100vw;background:var(--bg2);border-left:1px solid var(--border2);z-index:101;display:flex;flex-direction:column;}
.ca-dw:not(.noanim){animation:ca-si .25s cubic-bezier(.4,0,.2,1);}
@keyframes ca-fi{from{opacity:0}to{opacity:1}}
@keyframes ca-si{from{transform:translateX(100%)}to{transform:translateX(0)}}
.ca-dh{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--border);flex-shrink:0;}
.ca-dt{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--text);flex:1;min-width:0;}
.ca-ext{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:var(--text2);text-decoration:none;padding:5px 9px;border:1px solid var(--border);border-radius:7px;}
.ca-ext:hover{color:var(--text);}
.ca-cl{background:transparent;border:none;color:var(--text2);cursor:pointer;padding:5px;border-radius:6px;display:flex;align-items:center;}
.ca-cl:hover{color:var(--text);background:var(--hover);}
.ca-ds{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px;}
.ca-df{padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:9px;flex-shrink:0;}
.ca-save{flex:1;background:var(--accent);color:#0a0a0a;border:none;border-radius:10px;font-size:13px;font-weight:700;padding:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;}
.ca-save.busy{opacity:.65;pointer-events:none;}
.ca-cancel{background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:10px;font-size:13px;font-weight:600;padding:11px 18px;cursor:pointer;}
.ca-cancel:hover{color:var(--text);}

/* Drawer sections */
.ca-sec{display:flex;flex-direction:column;gap:7px;}
.ca-sec-t{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);}
.ca-ok{background:rgba(68,221,136,.08);border:1px solid rgba(68,221,136,.2);color:var(--green);border-radius:10px;padding:11px 14px;font-size:13px;font-weight:600;}
.ca-iss{display:flex;align-items:center;gap:8px;font-size:13px;padding:8px 11px;border-radius:8px;}
.ca-iss.sev-error{background:var(--red-dim);color:var(--red);}
.ca-iss.sev-warning{background:rgba(251,191,36,.10);color:#fbbf24;}
.ca-iss.sev-info{background:var(--bg3);color:var(--text2);}

/* Photos */
.ca-ph-grid{display:flex;flex-wrap:wrap;gap:8px;}
.ca-ph-item{position:relative;width:72px;height:72px;}
.ca-ph-item img{width:100%;height:100%;object-fit:cover;border-radius:8px;border:1px solid var(--border);}
.ca-ph-del{position:absolute;top:3px;right:3px;background:rgba(0,0,0,.7);border:none;color:#fff;border-radius:50%;width:18px;height:18px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;}
.ca-empty-ph{background:var(--bg3);border-radius:8px;padding:20px;text-align:center;color:var(--text3);font-size:13px;}
.ca-add-ph{display:flex;gap:7px;}
.ca-url-in{flex:1;padding:7px 10px;height:auto;}
.ca-add-ph-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:12px;font-weight:700;padding:7px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;}
.ca-add-ph-btn:hover{background:var(--bg4);}
.ca-hint-sm{font-size:11px;color:var(--text3);}
.ca-hint-sm a{color:var(--accent-text);text-decoration:none;}

/* Fields */
.ca-field{background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:9px 11px;resize:vertical;outline:none;font-family:inherit;width:100%;box-sizing:border-box;transition:border-color .15s;}
.ca-field:focus{border-color:var(--border2);}
.ca-ai-btn{display:flex;align-items:center;gap:6px;background:rgba(212,240,0,.08);border:1px solid rgba(212,240,0,.2);color:var(--accent-text);font-size:12px;font-weight:700;padding:7px 12px;border-radius:8px;cursor:pointer;align-self:flex-start;transition:all .15s;}
.ca-ai-btn:hover{background:rgba(212,240,0,.16);}
.ca-ai-btn.busy{opacity:.65;pointer-events:none;}
.ca-spin-sm{width:12px;height:12px;border:2px solid transparent;border-top-color:currentColor;border-radius:50%;flex-shrink:0;}
.ca-ai-sug{background:rgba(212,240,0,.05);border:1px solid rgba(212,240,0,.15);border-radius:10px;padding:10px;}
.ca-ai-sug-t{font-size:11px;font-weight:700;color:var(--accent-text);margin-bottom:7px;}
.ca-ai-item{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;color:var(--text);padding:8px 10px;border-radius:7px;background:var(--bg3);cursor:pointer;margin-bottom:5px;transition:background .15s;}
.ca-ai-item:last-child{margin-bottom:0;}
.ca-ai-item:hover{background:var(--bg4);}
.ca-pick{font-size:11px;font-weight:800;color:var(--accent-text);flex-shrink:0;}
.ca-vc-row{display:flex;align-items:center;gap:7px;font-size:12px;}
.ca-vc-l{color:var(--text3);}

/* Tabs */
.ca-tabs{display:flex;gap:4px;padding:10px 20px 0;}
.ca-tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text3);font-size:13px;font-weight:600;padding:7px 14px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:color .15s;}
.ca-tab.on{color:var(--text);border-bottom-color:var(--accent);}
.ca-tab:hover:not(.on){color:var(--text2);}
.ca-tab-badge{background:var(--accent);color:#0a0a0a;font-size:10px;font-weight:800;padding:1px 6px;border-radius:20px;}

/* Fixed items */
.ca-fx-head{padding:10px 0 12px;display:flex;justify-content:flex-end;}
.ca-fx-all-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);font-size:12px;font-weight:700;padding:7px 14px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:6px;}
.ca-fx-all-btn:hover:not(.busy){color:var(--text);border-color:var(--border2);}
.ca-fx-all-btn.busy{opacity:.65;pointer-events:none;}
.ca-fx-list{display:flex;flex-direction:column;gap:8px;}
.ca-fx-row{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:13px 16px;display:flex;flex-direction:column;gap:8px;}
.ca-fx-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ca-fx-store{font-size:12px;color:var(--text2);font-weight:500;}
.ca-fx-date{font-size:11px;color:var(--text3);white-space:nowrap;margin-left:auto;}
.ca-fx-vc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ca-fx-vc-label{font-size:11px;color:var(--text3);}
.ca-fx-vc{font-size:13px;font-weight:700;color:var(--text);font-family:monospace;letter-spacing:.3px;}
.ca-fx-copy{display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border);color:var(--text3);font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;cursor:pointer;}
.ca-fx-copy:hover{color:var(--accent);border-color:var(--accent);}
.ca-fx-rename-block{background:var(--bg);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:3px;}
.ca-fx-rename-label{font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;}
.ca-fx-rename-old{font-size:12px;color:var(--text3);text-decoration:line-through;}
.ca-fx-rename-new{font-size:12px;color:var(--text);font-weight:600;}
.ca-fx-curname{font-size:13px;font-weight:600;color:var(--text);}
.ca-fx-issues{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px;color:var(--text3);}
.ca-fx-status{font-size:12px;font-weight:700;padding:5px 10px;border-radius:20px;align-self:flex-start;}
.ca-fx-status.confirmed{background:rgba(68,221,136,.1);color:var(--green);}
.ca-fx-status.partial{background:rgba(96,165,250,.12);color:#60a5fa;}
.ca-fx-status.unchanged{background:rgba(251,191,36,.1);color:#fbbf24;}
.ca-fx-status.gone{background:rgba(148,163,184,.12);color:var(--text3);}
.ca-fx-status.error{background:rgba(248,113,113,.12);color:#f87171;}
.ca-fx-status.pending{background:var(--bg3);color:var(--text3);}
.ca-fx-photos{font-size:12px;color:var(--text2);}
.ca-fx-note{font-size:11px;color:var(--text3);line-height:1.45;}
.ca-ic.still{opacity:.75;}
.ca-fx-actions{display:flex;gap:8px;flex-wrap:wrap;}
.ca-fx-btn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);font-size:12px;font-weight:700;padding:6px 13px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:5px;}
.ca-fx-btn:hover:not(.busy){color:var(--text);}
.ca-fx-btn.busy{opacity:.65;pointer-events:none;}
.ca-fx-retry{background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.25);color:#6366f1;font-size:12px;font-weight:700;padding:6px 13px;border-radius:8px;cursor:pointer;}
.ca-fx-retry:hover{background:rgba(99,102,241,.18);}
.ca-fx-del{background:transparent;border:none;color:var(--text3);font-size:12px;cursor:pointer;padding:6px 10px;border-radius:8px;}
.ca-fx-del:hover{color:var(--red);}
/* ─── AI tab ─────────────────────────────────────────────── */
.ca-tab-ai{position:relative;}
.ca-ai-intro-title{font-size:20px;font-weight:800;color:var(--text);margin:12px 0 8px;}
.ca-ai-intro-text{font-size:13px;color:var(--text2);line-height:1.6;max-width:420px;text-align:center;margin-bottom:20px;}
.ca-ai-run-btn{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;border:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:12px;cursor:pointer;display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(99,102,241,.35);}
.ca-ai-run-btn:hover:not(.busy){opacity:.9;}
.ca-ai-run-btn.busy{opacity:.65;pointer-events:none;}
.ca-ai-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg2);}
.ca-ai-selall{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer;}
.ca-ai-stats{display:flex;gap:8px;font-size:12px;}
.ca-ai-stat.ok{color:var(--green);}
.ca-ai-stat.err{color:#f87171;}
.ca-ai-apply-btn{margin-left:auto;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;border:none;font-size:13px;font-weight:700;padding:8px 20px;border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:6px;}
.ca-ai-apply-btn.busy,.ca-ai-apply-btn[disabled]{opacity:.55;pointer-events:none;}
.ca-ai-rerun{background:var(--bg3);border:1px solid var(--border);color:var(--text3);font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;}
.ca-ai-rerun:hover{color:var(--text);}
.ca-ai-list{display:flex;flex-direction:column;gap:8px;padding:12px 16px;overflow-y:auto;flex:1;}
.ca-ai-row{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;transition:opacity .2s;}
.ca-ai-row.ai-ok{border-color:rgba(68,221,136,.3);background:rgba(68,221,136,.05);}
.ca-ai-row.ai-err{border-color:rgba(248,113,113,.3);background:rgba(248,113,113,.05);}
.ca-ai-row-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ca-ai-chk{width:16px;height:16px;cursor:pointer;flex-shrink:0;}
.ca-ai-chk.ai-done{font-size:16px;}
.ca-ai-store{font-size:12px;color:var(--text2);}
.ca-ai-vc{font-size:12px;font-weight:700;color:var(--text);font-family:monospace;background:var(--bg3);padding:2px 6px;border-radius:5px;}
.ca-ai-err-badge{font-size:11px;font-weight:700;color:#f87171;background:rgba(248,113,113,.12);padding:2px 8px;border-radius:20px;}
.ca-ai-names{display:flex;flex-direction:column;gap:5px;}
.ca-ai-old{font-size:12px;color:var(--text3);}
.ca-ai-new{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ca-ai-new-done{font-size:13px;color:var(--green);font-weight:600;}
.ca-ai-lbl{font-size:11px;color:var(--text3);font-weight:600;white-space:nowrap;}
.ca-ai-inp{flex:1;min-width:200px;background:var(--bg);border:1px solid var(--border);color:var(--text);font-size:13px;font-weight:600;padding:6px 10px;border-radius:8px;outline:none;}
.ca-ai-inp:focus{border-color:var(--accent);}
.ca-ai-err-msg{font-size:12px;color:#f87171;}
.ca-ai-issues{display:flex;flex-wrap:wrap;gap:4px;}
.ca-ai-prompt-block{width:100%;max-width:480px;display:flex;flex-direction:column;gap:6px;margin-bottom:18px;}
.ca-ai-prompt-label{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}
.ca-ai-prompt-ta{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-size:13px;padding:8px 12px;border-radius:10px;resize:vertical;outline:none;line-height:1.5;font-family:inherit;}
.ca-ai-prompt-ta:focus{border-color:var(--accent);}
.ca-ai-prompt-inline{display:flex;align-items:flex-start;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--bg);}
.ca-ai-prompt-sm{flex:1;min-height:40px;max-height:80px;}
.ca-ai-rerun.busy{opacity:.65;pointer-events:none;display:flex;align-items:center;gap:5px;}
</style>`;
  }
}
