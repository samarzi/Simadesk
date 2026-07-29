/**
 * Аудит карточек товаров:
 * – ошибки с маркетплейсов (статус, фото, название, описание, цена)
 * – оценка качества 0-100, фильтры по МП / магазину / типу ошибки
 * – редактирование названия, описания, фото прямо здесь
 * – ИИ-подсказки через OpenRouter
 */
import { dbFetchAll } from '../services/dbClient';
import { companyService } from '../services/companyService';
import { ozonApi } from '../services/ozonApi';
import { wbApi } from '../services/wbApi';
import { yandexApi } from '../services/yandexApi';
import { debug } from '@/utils/debug';

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

  if (!c.name || c.name.trim().length < 20)
    iss.push({ code:'SHORT_NAME', severity:'warning', label:`Короткое название (${c.name?.trim().length ?? 0} симв.)`, field:'name' });

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

  constructor(el: HTMLElement) {
    this.el = el;
    this.el.style.cssText = 'display:none;flex-direction:column;flex:1;overflow:hidden;';
    (window as any).myAnalysisModule = this;
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

      } else if (card.mp === 'wb') {
        const store = this.wbStores.find(s => s.id === card.storeId)!;
        await wbApi.updateCard(store.api_key, card.nmId!, {
          title: this.drawerName,
          ...(this.drawerDesc ? { description: this.drawerDesc } : {}),
        });

      } else if (card.mp === 'yandex') {
        const store = this.yaStores.find(s => s.id === card.storeId)!;
        await yandexApi.updateOffer(store.api_key, store.business_id!, {
          offerId: card.vendorCode,
          name: this.drawerName,
          ...(this.drawerDesc ? { description: this.drawerDesc } : {}),
        });
      }

      // Update in-memory card
      const idx = this.cards.findIndex(c => c.uid === card.uid);
      if (idx >= 0) {
        this.cards[idx].name      = this.drawerName;
        this.cards[idx].photoUrls = [...this.drawerPhotos];
        this.cards[idx].issues    = auditCard(this.cards[idx]);
        this.cards[idx].score     = scoreCard(this.cards[idx].issues);
        this.drawerCard           = this.cards[idx];
      }
      (window as any).app?.toast?.('Карточка обновлена', 'success');
    } catch (e: unknown) {
      (window as any).app?.toast?.('Ошибка сохранения: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) || e), 'error');
    }

    this.drawerSaving = false;
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
    } catch (e: unknown) {
      this.error = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) || String(e);
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
          const o = await yandexApi.getOfferMapping(store.api_key, store.business_id, card.vendorCode) as any;
          desc = o?.offer?.description || '';
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
    const t = d.choices?.[0]?.message?.content;
    if (!t) throw new Error('Пустой ответ');
    return t;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private _paint() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const hadDrawer = this._drawerOpen;
      this._drawerOpen = !!this.drawerCard;
      this.el.innerHTML =
        this._styles(hadDrawer) +
        `<div class="ca-root">${this._head()}${this._body()}</div>` +
        this._drawer(hadDrawer);
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

      <div class="ca-filters">
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
      </div>
    </div>`;
  }

  private _body() {
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
          <textarea class="ca-field" rows="2"
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
</style>`;
  }
}
