/**
 * ReviewsModule — отзывы WB, Ozon, Яндекс Маркет.
 * Несколько магазинов на каждом маркетплейсе поддерживаются.
 */

import { debug } from '@/utils/debug';
import { wbDb } from '@/services/wbDb';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { wbApi } from '@/services/wbApi';
import { ozonApi } from '@/services/ozonApi';
import { helpBtn } from '@/services/helpModal';
import { yandexApi } from '@/services/yandexApi';
import { autoReplyDb } from '@/services/autoReplyDb';
import { WbStore } from '@/types/wb';
import { OzonStore } from '@/types/ozon';
import { YandexStore } from '@/types/yandex';

type Mp = 'wb' | 'ozon' | 'yandex';
type FilterMode = 'all' | 'unanswered' | 'answered';
type StarFilter = 0 | 1 | 2 | 3 | 4 | 5;

const MP_COLOR: Record<Mp, string>  = { wb: '#cb11ab', ozon: '#005bff', yandex: '#fc3f1d' };
const MP_BG:    Record<Mp, string>  = { wb: '#fdf0fb', ozon: '#eef4ff', yandex: '#fff5f3' };
const MP_LABEL: Record<Mp, string>  = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

/**
 * Локальный кеш ID отзывов, на которые уже отправлен авто-ответ.
 * Яндекс API может не сразу отразить ответ в shopFeedback.text — без кеша
 * отзывы "появляются снова" при перезагрузке.
 * Запись хранится 7 дней, потом API точно подхватит ответ.
 */
const REPLIED_CACHE_KEY = 'reviews_replied_ids';
const REPLIED_TTL_MS = 7 * 24 * 3600_000; // 7 дней

function getRepliedCache(): Map<string, { text: string; ts: number }> {
  try {
    const raw = localStorage.getItem(REPLIED_CACHE_KEY);
    if (!raw) return new Map();
    const arr: [string, { text: string; ts: number }][] = JSON.parse(raw);
    const now = Date.now();
    // Чистим устаревшие
    return new Map(arr.filter(([, v]) => now - v.ts < REPLIED_TTL_MS));
  } catch { return new Map(); }
}
function addRepliedCache(reviewId: string, text: string): void {
  const cache = getRepliedCache();
  cache.set(reviewId, { text, ts: Date.now() });
  try {
    localStorage.setItem(REPLIED_CACHE_KEY, JSON.stringify([...cache.entries()]));
  } catch (e) { debug.warn('[ReviewsModule] swallowed error', e); }
}
function isRepliedCached(reviewId: string): { text: string } | null {
  const cache = getRepliedCache();
  return cache.get(reviewId) ?? null;
}


interface UnifiedReview {
  id: string;
  mp: Mp;
  storeId: string;
  storeName: string;
  campaignId?: number;
  createdAt: string;
  rating: number;
  authorName: string;
  text: string;
  advantages?: string;
  disadvantages?: string;
  productName: string;
  productPhoto?: string;     // фото товара (карточки)
  reviewPhotos?: string[];   // фото покупателя приложенные к отзыву
  reviewVideo?: string;      // ссылка на видео отзыва (если есть)
  orderId?: string;          // номер заказа
  productSku?: string;       // артикул товара
  answered: boolean;
  answerText: string | null;
  ymNoReply?: boolean;   // Yandex review API replied — used to mark unsupported reply
}

interface StoreEntry {
  mp: Mp;
  storeId: string;
  storeName: string;
  campaignId?: number;
  businessId?: number | null;   // для ЯМ — нужно для прямой ссылки в кабинет
  loading: boolean;
  error: string | null;
  reviews: UnifiedReview[];
  countUnanswered: number;
  loaded: boolean;
}

export class ReviewsModule {
  private container: HTMLElement;
  private entries: StoreEntry[] = [];
  private activeMp: Mp = 'wb';
  private activeStoreId: string | null = null;
  private filterMode: FilterMode = 'all';
  private starFilter: StarFilter = 0;
  private search = '';
  private replyingId: string | null = null;
  private replyText = '';
  private replying = false;
  private replyError = '';

  constructor(container: HTMLElement) { this.container = container; }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    await this.reloadStores();
    this.render();
    if (this.activeStoreId) this.loadReviews(this.activeMp, this.activeStoreId);
  }

  hide(): void { this.container.style.display = 'none'; }

  private async reloadStores(): Promise<void> {
    const [wbStores, ozonStores, ymStores] = await Promise.all([
      wbDb.getStores().catch((): WbStore[] => []),
      ozonDb.getStores().catch((): OzonStore[] => []),
      yandexDb.getStores().catch((): YandexStore[] => []),
    ]);

    // Preserve existing loaded data when re-rendering
    const existing = new Map(this.entries.map(e => [`${e.mp}:${e.storeId}`, e]));

    const newEntries: StoreEntry[] = [
      ...wbStores.map((s): StoreEntry => existing.get(`wb:${s.id}`) ?? {
        mp: 'wb', storeId: s.id, storeName: s.name,
        loading: false, error: null, reviews: [], countUnanswered: 0, loaded: false,
      }),
      ...ozonStores.map((s): StoreEntry => existing.get(`ozon:${s.id}`) ?? {
        mp: 'ozon', storeId: s.id, storeName: s.name,
        loading: false, error: null, reviews: [], countUnanswered: 0, loaded: false,
      }),
      ...ymStores.map((s): StoreEntry => existing.get(`yandex:${s.id}`) ?? {
        mp: 'yandex', storeId: s.id, storeName: s.name, campaignId: s.campaign_id ?? undefined,
        loading: false, error: null, reviews: [], countUnanswered: 0, loaded: false,
      }),
    ];
    this.entries = newEntries;

    // Auto-select first available
    const mps: Mp[] = ['wb', 'ozon', 'yandex'];
    for (const mp of mps) {
      const first = this.entries.find(e => e.mp === mp);
      if (first) {
        if (!this.activeStoreId || !this.entries.find(e => e.storeId === this.activeStoreId && e.mp === this.activeMp)) {
          this.activeMp = mp;
          this.activeStoreId = first.storeId;
        }
        break;
      }
    }
  }

  selectMp(mp: Mp): void {
    this.activeMp = mp;
    const first = this.entries.find(e => e.mp === mp);
    this.activeStoreId = first?.storeId ?? null;
    this.replyingId = null;
    this.render();
    if (this.activeStoreId) {
      const e = this.entries.find(e => e.mp === mp && e.storeId === this.activeStoreId);
      if (e && !e.loaded && !e.loading) this.loadReviews(mp, this.activeStoreId);
    }
  }

  selectStore(storeId: string): void {
    this.activeStoreId = storeId;
    this.replyingId = null;
    const e = this.entries.find(e => e.storeId === storeId && e.mp === this.activeMp);
    if (e && !e.loaded && !e.loading) this.loadReviews(this.activeMp, storeId);
    else this.render();
  }

  async loadReviews(mp: Mp, storeId: string): Promise<void> {
    const e = this.entries.find(e => e.mp === mp && e.storeId === storeId);
    if (!e || e.loading) return;
    e.loading = true; e.error = null;
    this.render();
    try {
      if (mp === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === storeId);
        if (!store) throw new Error('Магазин WB не найден');
        const res = await wbApi.getFeedbacks(store.feedback_api_key || store.api_key, { take: 1000 });
        e.reviews = res.feedbacks.map((f: any) => ({
          id: f.id, mp: 'wb' as Mp, storeId, storeName: e.storeName,
          createdAt: f.createdDate, rating: f.productValuation,
          authorName: f.userName || 'Покупатель',
          text: f.text ?? '',
          advantages: f.pros ?? '',
          disadvantages: f.cons ?? '',
          productName: f.productDetails?.productName ?? '',
          productSku: f.productDetails?.supplierArticle ?? (f.productDetails?.nmId ? String(f.productDetails.nmId) : ''),
          // WB фото товара по nmId
          productPhoto: f.productDetails?.nmId
            ? `https://basket-${Math.floor(f.productDetails.nmId / 100000 / 1000) + 1}.wbbasket.ru/vol${Math.floor(f.productDetails.nmId / 100000)}/part${Math.floor(f.productDetails.nmId / 1000)}/${f.productDetails.nmId}/images/c246x328/1.webp`
            : '',
          // Фото от покупателя
          reviewPhotos: Array.isArray(f.photoLinks)
            ? f.photoLinks.map((p: any) => p.fullSize || p.miniSize).filter(Boolean)
            : [],
          reviewVideo: f.video?.uri ?? '',
          orderId: f.orderId ?? f.order_id ?? '',
          answered: !!f.answer, answerText: f.answer?.text ?? null,
        }));
        // Применяем локальный кеш — WB API может не сразу отразить ответ
        for (const r of e.reviews) {
          if (!r.answered) {
            const cached = isRepliedCached(r.id);
            if (cached) { r.answered = true; r.answerText = cached.text; }
          }
        }
        e.countUnanswered = e.reviews.filter(r => !r.answered).length;
      } else if (mp === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === storeId);
        if (!store) throw new Error('Магазин Ozon не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const res = await ozonApi.getReviews(creds, { page_size: 100 });
        e.reviews = res.reviews.map(r => ({
          id: r.uuid, mp: 'ozon' as Mp, storeId, storeName: e.storeName,
          createdAt: r.created_at, rating: r.rating,
          authorName: r.author_name, text: r.text,
          advantages: r.pros ?? '',
          disadvantages: r.cons ?? '',
          productName: r.product_name,
          productPhoto: r.product_photo ?? '',
          productSku: r.product_sku ?? '',
          orderId: r.order_id ?? '',
          reviewPhotos: r.review_photos ?? [],
          reviewVideo: r.review_video ?? '',
          // Ozon: отзыв считаем отвеченным если есть текст ответа ИЛИ статус PROCESSED
          answered: !!r.answer_text || r.status === 'PROCESSED',
          answerText: r.answer_text,
        }));
        // Применяем локальный кеш — Ozon API может не сразу отразить ответ
        for (const r of e.reviews) {
          if (!r.answered) {
            const cached = isRepliedCached(r.id);
            if (cached) { r.answered = true; r.answerText = cached.text; }
          }
        }
        e.countUnanswered = e.reviews.filter(r => !r.answered).length;
      } else {
        const stores = await yandexDb.getStores();
        const store = stores.find(s => s.id === storeId);
        if (!store) throw new Error('Магазин ЯМ не найден');
        if (!store.campaign_id) throw new Error('Не задан campaign_id для магазина ЯМ');
        // Получаем business_id для нового API (кешируем в store если ещё нет)
        let businessId = store.business_id ?? null;
        if (!businessId) {
          businessId = await yandexApi.getBusinessId(store.api_key, store.campaign_id);
        }
        e.businessId = businessId;  // кешируем для прямой ссылки в кабинет
        const res = await yandexApi.getFeedbacks(store.api_key, store.campaign_id, undefined, undefined, businessId);
        e.reviews = res.feedbacks.map(f => ({
          id: f.id, mp: 'yandex' as Mp, storeId, storeName: e.storeName,
          campaignId: store.campaign_id ?? undefined,
          createdAt: f.createdAt, rating: f.rating,
          authorName: f.authorName, text: f.text,
          advantages: f.advantages, disadvantages: f.disadvantages,
          productName: f.productName,
          productPhoto: f.productPhoto ?? '',
          productSku: f.productSku ?? '',
          orderId: f.orderId ?? '',
          reviewPhotos: f.reviewPhotos ?? [],
          reviewVideo: f.reviewVideo ?? '',
          answered: !!f.answerText, answerText: f.answerText,
        }));
        // Применяем локальный кеш отвеченных — API может не сразу отразить ответ
        for (const r of e.reviews) {
          if (!r.answered) {
            const cached = isRepliedCached(r.id);
            if (cached) { r.answered = true; r.answerText = cached.text; }
          }
        }
        e.countUnanswered = e.reviews.filter(r => !r.answered).length;
      }
      e.loaded = true;
    } catch (err: any) {
      e.error = err?.message ?? 'Ошибка загрузки отзывов';
    }
    e.loading = false;
    this.render();
    // Авто-ответы после загрузки — пробуем ответить на новые отзывы
    if (e.loaded && !e.error) this.runAutoReply(e).catch((e) => debug.warn('[ReviewsModule] swallowed error', e));
  }

  /** Применяет авто-ответы к неотвеченным отзывам, используя случайный шаблон. */
  private async runAutoReply(e: StoreEntry): Promise<void> {
    const settings = autoReplyDb.getSettings();
    if (!settings.enabled) return;

    const unanswered = e.reviews.filter(r => !r.answered);
    if (unanswered.length === 0) return;

    // Не запускаем авто-ответ если WB в cooldown — иначе словим больше 429
    if (e.mp === 'wb') {
      const { isWbCoolingDown } = await import('@/services/wbApi');
      if (isWbCoolingDown()) {
        console.warn('[autoReply] WB в cooldown — пропускаем авто-ответы');
        return;
      }
    }

    let count = 0;
    let errors = 0;
    let lastError: string | null = null;
    for (const r of unanswered) {
      const tpl = autoReplyDb.pickTemplateFor(r.rating, r.mp);
      if (!tpl) continue;
      try {
        await this.sendAutoReply(r, tpl.text);
        r.answered = true;
        r.answerText = tpl.text;
        addRepliedCache(r.id, tpl.text);  // кеш чтобы при reload не "появлялись снова"
        count++;
        // WB чаще блокирует — увеличиваем задержку
        const delay = r.mp === 'wb' ? 3000 : 1500;
        await new Promise(res => setTimeout(res, delay));
      } catch (err: any) {
        errors++;
        lastError = err?.message ?? String(err);
        console.warn('[autoReply]', lastError);
        if (String(lastError ?? '').includes('429') || String(lastError ?? '').includes('кулдауне') || String(lastError ?? '').includes('лимит')) {
          break;
        }
      }
    }

    // Уведомления — успех ИЛИ ошибки
    if (count > 0) {
      e.countUnanswered = e.reviews.filter(r => !r.answered).length;
      this.render();
      try { window.app?.toast?.(`🤖 Авто-ответы отправлены на ${count} отзыв(ов)${errors > 0 ? `, ошибок: ${errors}` : ''}`, 'success'); } catch (e) { debug.warn('[ReviewsModule] swallowed error', e); }
      setTimeout(() => { this.loadReviews(e.mp, e.storeId).catch((e) => debug.warn('[ReviewsModule] swallowed error', e)); }, 3000);
    } else if (errors > 0 && lastError) {
      // НИ ОДНОГО успеха — показываем причину в toast и в e.error
      const shortMsg = lastError.length > 250 ? lastError.slice(0, 250) + '…' : lastError;
      try { window.app?.toast?.(`❌ Авто-ответ ${MP_LABEL[e.mp]}: ${shortMsg.split('\\n')[0]}`, 'error', 8000); } catch (e) { debug.warn('[ReviewsModule] swallowed error', e); }
      e.error = `Авто-ответ не удался для ${errors} отзыв(ов):\n${shortMsg}`;
      this.render();
    }
  }

  private async sendAutoReply(r: UnifiedReview, text: string): Promise<void> {
    // Ищем магазин сначала в this.entries (уже загружены при show()) — надёжнее чем повторный запрос к БД
    const entry = this.entries.find(e => e.mp === r.mp && e.storeId === r.storeId);
    if (!entry) {
      console.error('[sendAutoReply] entry не найден:', r.mp, r.storeId, 'entries:', this.entries.map(e => `${e.mp}:${e.storeId}`));
      throw new Error(`Магазин ${MP_LABEL[r.mp]} не найден в entries`);
    }

    if (r.mp === 'wb') {
      const wbStores = await wbDb.getStores();
      const ws = wbStores.find(s => s.id === r.storeId);
      if (!ws) throw new Error('WB магазин не найден в БД');
      await wbApi.replyFeedback(ws.feedback_api_key || ws.api_key, r.id, text);
    } else if (r.mp === 'ozon') {
      const ozStores = await ozonDb.getStores();
      const os = ozStores.find(s => s.id === r.storeId);
      if (!os) throw new Error('Ozon магазин не найден в БД');
      await ozonApi.replyReview({ client_id: os.client_id, api_key: os.api_key }, r.id, text);
    } else if (r.mp === 'yandex') {
      // Получаем api_key из БД, но campaign_id/business_id берём из entry (уже кешированы)
      const ymStores = await yandexDb.getStores();
      let ys = ymStores.find(s => s.id === r.storeId);
      // Если по id не нашли — ищем по campaign_id (на случай несовпадения UUID)
      if (!ys && entry.campaignId) {
        ys = ymStores.find(s => s.campaign_id === entry.campaignId);
        if (ys) console.warn('[sendAutoReply] ЯМ: найден по campaign_id, id не совпал:', r.storeId, '→', ys.id);
      }
      // Если БД пуста (companyId не активен?) — пробуем напрямую из review данных
      if (!ys) {
        console.error('[sendAutoReply] ЯМ магазин не найден. storeId:', r.storeId,
          'campaignId:', entry.campaignId, 'businessId:', entry.businessId,
          'ymStores:', ymStores.map(s => `${s.id}:camp=${s.campaign_id}`));
        throw new Error('ЯМ магазин не найден в БД — проверьте компанию');
      }
      const campaignId = ys.campaign_id ?? entry.campaignId;
      if (!campaignId) throw new Error('Не задан campaign_id для магазина ЯМ');
      const businessId = ys.business_id ?? entry.businessId ?? null;
      await yandexApi.replyFeedback(ys.api_key, campaignId, r.id, text, undefined, businessId);
    }
  }

  setFilter(mode: FilterMode): void { this.filterMode = mode; this.render(); }
  setStar(star: StarFilter): void { this.starFilter = star; this.render(); }
  setSearch(q: string): void { this.search = q; this.render(); }

  openReply(id: string): void {
    this.replyingId = id; this.replyText = ''; this.replyError = '';
    this.render();
    setTimeout(() => (document.getElementById(`reply-ta-${id}`) as HTMLTextAreaElement)?.focus(), 60);
  }
  cancelReply(): void { this.replyingId = null; this.replyText = ''; this.replyError = ''; this.render(); }
  updateReplyText(id: string, text: string): void { if (this.replyingId === id) this.replyText = text; }
  useTemplate(text: string): void {
    this.replyText = text;
    const ta = document.getElementById(`reply-ta-${this.replyingId}`) as HTMLTextAreaElement | null;
    if (ta) { ta.value = text; ta.focus(); }
  }

  /** Открывает lightbox для предпросмотра фото или видео отзыва. */
  openLightbox(url: string, type: 'image' | 'video' = 'image'): void {
    const existing = document.getElementById('rv-lightbox');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rv-lightbox';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    });

    const safeUrl = url.replace(/"/g, '&quot;');
    overlay.innerHTML = `
      <div style="position:relative;max-width:95vw;max-height:95vh;display:flex;align-items:center;justify-content:center">
        <button onclick="document.getElementById('rv-lightbox').remove()"
          style="position:absolute;top:-12px;right:-12px;width:36px;height:36px;border:none;background:#fff;
            border-radius:50%;cursor:pointer;font-size:18px;font-weight:700;box-shadow:0 4px 12px rgba(0,0,0,.3);
            display:flex;align-items:center;justify-content:center;z-index:2">✕</button>
        ${type === 'video' ? `
          <video src="${safeUrl}" controls autoplay
            style="max-width:95vw;max-height:90vh;border-radius:8px;background:#000">
          </video>
        ` : `
          <img src="${safeUrl}" alt="Фото отзыва"
            style="max-width:95vw;max-height:90vh;border-radius:8px;object-fit:contain;background:#000">
        `}
        <a href="${safeUrl}" target="_blank" rel="noopener"
          style="position:absolute;bottom:-40px;left:50%;transform:translateX(-50%);color:#fff;font-size:12px;
            background:rgba(255,255,255,.1);padding:6px 14px;border-radius:6px;text-decoration:none;backdrop-filter:blur(8px)">
          Открыть оригинал →
        </a>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  /** Подставить шаблон по ID — надёжнее чем передавать текст через onclick */
  useTemplateById(templateId: string): void {
    const tpl = autoReplyDb.getTemplates().find(t => t.id === templateId);
    if (!tpl) return;
    this.useTemplate(tpl.text);
  }

  /** Открыть менеджер шаблонов сразу с фильтром по рейтингу */
  openTemplatesQuick(rating: number): void {
    // Сохраняем рейтинг для подсветки и открываем модал шаблонов
    this.openAutoReplySettings();
    // Скроллим к секции шаблонов
    setTimeout(() => {
      const list = document.getElementById('ar-templates-list');
      list?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      void rating;
    }, 100);
  }

  /** Сохранить текущий текст ответа как шаблон для рейтинга */
  saveAsTemplate(reviewId: string, rating: number): void {
    const ta = document.getElementById(`reply-ta-${reviewId}`) as HTMLTextAreaElement | null;
    const text = ta?.value.trim();
    if (!text) { alert('Сначала введите текст ответа'); return; }
    autoReplyDb.addTemplate({ ratings: [rating], text });
    try { window.app?.toast?.(`✓ Шаблон сохранён для ${rating}★`, 'success'); } catch (e) { debug.warn('[ReviewsModule] swallowed error', e); }
    this.render();
  }

  async submitReply(mp: Mp, storeId: string, reviewId: string, _campaignId?: number): Promise<void> {
    if (!this.replyText.trim()) { this.replyError = 'Введите текст ответа'; this.render(); return; }
    this.replying = true; this.replyError = '';
    this.render();
    try {
      if (mp === 'wb') {
        const store = (await wbDb.getStores()).find(s => s.id === storeId);
        if (!store) throw new Error('Магазин не найден');
        await wbApi.replyFeedback(store.feedback_api_key || store.api_key, reviewId, this.replyText.trim());
      } else if (mp === 'ozon') {
        const store = (await ozonDb.getStores()).find(s => s.id === storeId);
        if (!store) throw new Error('Магазин не найден');
        await ozonApi.replyReview({ client_id: store.client_id, api_key: store.api_key }, reviewId, this.replyText.trim());
      } else {
        const store = (await yandexDb.getStores()).find(s => s.id === storeId);
        if (!store || !store.campaign_id) throw new Error('Магазин ЯМ или campaign_id не найден');
        // store.business_id может быть null в БД — берём из кеша entry (заполняется при loadReviews)
        const ymEntry = this.entries.find(e => e.mp === 'yandex' && e.storeId === storeId);
        const businessId = store.business_id ?? ymEntry?.businessId ?? null;
        debug.log('[YM reply]', { storeId, campaignId: store.campaign_id, businessId });
        await yandexApi.replyFeedback(store.api_key, store.campaign_id, reviewId, this.replyText.trim(), undefined, businessId);
      }
      const e = this.entries.find(e => e.mp === mp && e.storeId === storeId);
      if (e) {
        const rev = e.reviews.find(r => r.id === reviewId);
        if (rev) { rev.answered = true; rev.answerText = this.replyText.trim(); e.countUnanswered = Math.max(0, e.countUnanswered - 1); addRepliedCache(reviewId, this.replyText.trim()); }
        // Перезагружаем данные через 2 секунды чтобы получить актуальный статус
        const _mp = this.activeMp; const _sid = this.activeStoreId;
        if (_sid) setTimeout(() => { this.loadReviews(_mp, _sid).catch((e) => debug.warn('[ReviewsModule] swallowed error', e)); }, 2000);
      }
      this.replyingId = null; this.replyText = '';
    } catch (err: any) {
      this.replyError = err?.message ?? 'Ошибка отправки ответа';
    }
    this.replying = false;
    this.render();
  }

  private get activeEntry(): StoreEntry | null {
    return this.entries.find(e => e.mp === this.activeMp && e.storeId === this.activeStoreId) ?? null;
  }

  private get filtered(): UnifiedReview[] {
    const e = this.activeEntry;
    if (!e) return [];
    let list = [...e.reviews];
    if (this.filterMode === 'unanswered') list = list.filter(r => !r.answered);
    else if (this.filterMode === 'answered')  list = list.filter(r => r.answered);
    if (this.starFilter > 0) list = list.filter(r => r.rating === this.starFilter);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(r =>
        r.text.toLowerCase().includes(q) ||
        r.authorName.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q),
      );
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  private ratingColor(n: number): string {
    if (n >= 4) return '#16a34a';
    if (n >= 3) return '#d97706';
    return '#dc2626';
  }

  private totalUnanswered(mp: Mp): number {
    return this.entries.filter(e => e.mp === mp).reduce((s, e) => s + e.countUnanswered, 0);
  }

  private mpHasStores(mp: Mp): boolean {
    return this.entries.some(e => e.mp === mp);
  }

  render(): void {
    const ae = this.activeEntry;
    const list = this.filtered;
    const unanswered = ae?.countUnanswered ?? 0;

    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;background:var(--bg2)">

        <!-- TOP BAR -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;
          background:var(--bg);border-bottom:1px solid var(--border);gap:12px;flex-shrink:0">
          <div style="display:flex;align-items:center;gap:10px">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.27l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z"
                fill="${MP_COLOR[this.activeMp]}" opacity=".15" stroke="${MP_COLOR[this.activeMp]}" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
            <span style="font-size:18px;font-weight:700;color:var(--text)">Отзывы</span>
            ${unanswered > 0 ? `
              <span style="background:#dc2626;color:#fff;font-size:12px;font-weight:700;
                padding:2px 9px;border-radius:20px">${unanswered} без ответа</span>
            ` : ''}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${helpBtn('reviews')}
            <button onclick="window.reviewsModule.openAutoReplySettings()"
              style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);
                border-radius:8px;background:${autoReplyDb.getSettings().enabled ? '#16a34a18' : 'var(--bg)'};
                color:${autoReplyDb.getSettings().enabled ? '#16a34a' : 'var(--text)'};cursor:pointer;font-size:13px;font-weight:600">
              <span style="font-size:13px">🤖</span> Авто-ответы
              ${autoReplyDb.getSettings().enabled ? '<span style="font-size:9px;background:#16a34a;color:#fff;padding:1px 6px;border-radius:8px;font-weight:700">ВКЛ</span>' : ''}
            </button>
            ${ae && !ae.loading ? `
              <button onclick="window.reviewsModule.loadReviews('${this.activeMp}','${this.activeStoreId}')"
                style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);
                  border-radius:8px;background:var(--bg);color:var(--text);cursor:pointer;font-size:13px">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
                Обновить
              </button>
            ` : ''}
          </div>
        </div>

        <!-- MP TABS -->
        <div style="display:flex;gap:8px;padding:10px 24px;background:var(--bg);
          border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto">
          ${(['wb','ozon','yandex'] as Mp[]).map(mp => {
            const active = this.activeMp === mp;
            const hasStores = this.mpHasStores(mp);
            const cnt = this.totalUnanswered(mp);
            return `
              <button onclick="${hasStores ? `window.reviewsModule.selectMp('${mp}')` : ''}"
                style="display:flex;align-items:center;gap:7px;padding:8px 14px;border-radius:10px;cursor:${hasStores ? 'pointer' : 'default'};
                  white-space:nowrap;border:1.5px solid ${active ? MP_COLOR[mp] : 'var(--border)'};
                  background:${active ? MP_BG[mp] : 'var(--bg)'};font-size:13px;font-weight:${active ? '700' : '500'};
                  color:${active ? MP_COLOR[mp] : hasStores ? 'var(--text)' : 'var(--text2)'};
                  opacity:${hasStores ? '1' : '.35'};transition:all .15s">
                <span style="display:inline-flex;align-items:center;justify-content:center;
                  width:20px;height:20px;border-radius:5px;background:${MP_COLOR[mp]};
                  font-size:8px;font-weight:900;color:#fff;font-family:Arial">${MP_LABEL[mp]}</span>
                ${mp === 'wb' ? 'Wildberries' : mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет'}
                ${cnt > 0 ? `<span style="background:#dc2626;color:#fff;font-size:10px;font-weight:700;
                  padding:1px 6px;border-radius:20px;line-height:1.4">${cnt}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>

        ${this.renderBody(ae, list, unanswered)}
      </div>
    `;
  }

  private renderBody(ae: StoreEntry | null, list: UnifiedReview[], unanswered: number): string {
    const storesForMp = this.entries.filter(e => e.mp === this.activeMp);

    if (storesForMp.length === 0) return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text2)">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.27l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z"/></svg>
        <div style="font-size:17px;font-weight:600">Нет магазинов ${MP_LABEL[this.activeMp]}</div>
        <div style="font-size:13px;opacity:.6">Подключите магазин в разделе «Маркетплейсы»</div>
      </div>
    `;

    return `
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <!-- STORE TABS (if multiple) -->
        ${storesForMp.length > 1 ? `
          <div style="display:flex;gap:6px;padding:10px 24px;background:var(--bg);
            border-bottom:1px solid var(--border);flex-wrap:wrap;flex-shrink:0">
            ${storesForMp.map(e => `
              <button onclick="window.reviewsModule.selectStore('${e.storeId}')"
                style="display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;cursor:pointer;
                  font-size:12px;font-weight:600;border:1.5px solid ${this.activeStoreId === e.storeId ? MP_COLOR[this.activeMp] : 'var(--border)'};
                  background:${this.activeStoreId === e.storeId ? MP_BG[this.activeMp] : 'var(--bg)'};
                  color:${this.activeStoreId === e.storeId ? MP_COLOR[this.activeMp] : 'var(--text)'};transition:all .15s">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                ${e.storeName}
                ${e.countUnanswered > 0 ? `
                  <span style="background:#dc2626;color:#fff;font-size:10px;padding:1px 5px;border-radius:10px">${e.countUnanswered}</span>
                ` : ''}
                ${e.loading ? '<span style="font-size:10px;opacity:.5">…</span>' : ''}
              </button>
            `).join('')}
          </div>
        ` : ''}

        ${!ae ? '' : ae.loading ? `
          <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:12px;color:var(--text2)">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${MP_COLOR[this.activeMp]}" stroke-width="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
              </path>
            </svg>
            Загружаем отзывы…
          </div>
        ` : ae.error ? `
          <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:32px 24px">
            ${ae.mp === 'wb' && (ae.error.includes('нет доступа') || ae.error.includes('401') || ae.error.includes('403') || ae.error.includes('проверьте')) ? `
              <div style="max-width:480px;text-align:center">
                <div style="font-size:40px;margin-bottom:12px">🔑</div>
                <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px">WB: нужен специальный токен для отзывов</div>
                <div style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:16px">
                  Wildberries использует <b>отдельный API-токен</b> для доступа к отзывам.<br>
                  Стандартный токен магазина <b>не даёт доступ</b> к разделу отзывов.
                </div>
                <div style="background:#fef3c7;border:1px solid #f59e0b44;border-radius:10px;padding:14px 18px;text-align:left;font-size:12px;color:var(--text);line-height:1.8;margin-bottom:16px">
                  <b>Как получить токен с доступом к отзывам:</b><br>
                  1. Войдите в <a href="https://seller.wildberries.ru" target="_blank" style="color:#cb11ab">seller.wildberries.ru</a><br>
                  2. Настройки → Доступ к API<br>
                  3. Создайте новый токен и включите раздел <b>«Отзывы»</b><br>
                  4. Скопируйте токен и вставьте в настройках магазина WB в SimaDesk
                </div>
                <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
                  <a href="https://seller.wildberries.ru/supplier-settings/access-to-api" target="_blank"
                    style="padding:8px 18px;border-radius:8px;background:#cb11ab;color:#fff;text-decoration:none;font-size:13px;font-weight:600">
                    Открыть настройки WB →
                  </a>
                  <button onclick="window.reviewsModule.loadReviews('${this.activeMp}','${this.activeStoreId}')"
                    style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;font-size:13px">
                    ↻ Повторить
                  </button>
                </div>
              </div>
            ` : ae.error.includes('Seller Premium') || ae.error.includes('тарифным планом') || ae.error.includes('Ozon Review API') || ae.error.includes('not available with existing') || ae.error.includes('Premium Plus') ? `
              <div style="max-width:420px;text-align:center">
                <div style="font-size:40px;margin-bottom:12px">🔒</div>
                <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px">
                  API отзывов недоступен
                </div>
                <div style="font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:16px">
                  API отзывов Ozon доступен только на тарифе <b>Premium Plus</b>.<br>
                  Перейдите в кабинет Ozon → Настройки → API-ключи и пересоздайте ключ после подключения тарифа.
                </div>
                <div style="font-size:12px;color:var(--text2);background:var(--bg);border:1px solid var(--border);
                  border-radius:8px;padding:10px 14px;text-align:left;line-height:1.6">
                  Пока тариф не подключён, вы можете работать с отзывами<br>
                  напрямую в личном кабинете Ozon.
                </div>
              </div>
            ` : `
              <div style="max-width:400px;text-align:center">
                <div style="font-size:36px;margin-bottom:12px">⚠️</div>
                <div style="font-size:14px;font-weight:700;color:#dc2626;margin-bottom:8px">Ошибка загрузки отзывов</div>
                <div style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:16px;
                  background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;text-align:left">
                  ${ae.error.replace(/\n/g, '<br>')}
                </div>
                <button onclick="window.reviewsModule.loadReviews('${this.activeMp}','${this.activeStoreId}')"
                  style="padding:8px 20px;border-radius:8px;border:1px solid var(--border);
                    background:var(--bg);color:var(--text);cursor:pointer;font-size:13px">↻ Повторить</button>
              </div>
            `}
          </div>
        ` : `
          <!-- FILTER BAR -->
          <div style="display:flex;align-items:center;gap:8px;padding:10px 24px;
            background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;flex-shrink:0">
            <div style="display:flex;gap:4px;background:var(--bg2);border-radius:8px;padding:3px">
              ${(['all','unanswered','answered'] as FilterMode[]).map(m => `
                <button onclick="window.reviewsModule.setFilter('${m}')"
                  style="padding:5px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
                    background:${this.filterMode === m ? 'var(--bg)' : 'transparent'};
                    color:${this.filterMode === m ? 'var(--text)' : 'var(--text2)'};
                    box-shadow:${this.filterMode === m ? '0 1px 3px rgba(0,0,0,.08)' : 'none'};transition:all .15s">
                  ${m === 'all' ? 'Все' : m === 'unanswered' ? `Без ответа${unanswered > 0 ? ` <b style="color:#dc2626">${unanswered}</b>` : ''}` : 'С ответом'}
                </button>
              `).join('')}
            </div>
            <div style="display:flex;gap:3px">
              <button onclick="window.reviewsModule.setStar(0)"
                style="padding:5px 9px;border-radius:6px;border:1px solid var(--border);cursor:pointer;
                  background:${this.starFilter === 0 ? MP_BG[this.activeMp] : 'var(--bg)'};
                  color:${this.starFilter === 0 ? MP_COLOR[this.activeMp] : 'var(--text2)'};font-size:12px">★ Все</button>
              ${[5,4,3,2,1].map(n => `
                <button onclick="window.reviewsModule.setStar(${n})"
                  style="padding:5px 9px;border-radius:6px;border:1px solid var(--border);cursor:pointer;
                    background:${this.starFilter === n ? MP_BG[this.activeMp] : 'var(--bg)'};
                    color:${this.starFilter === n ? this.ratingColor(n) : 'var(--text2)'};font-size:12px">
                  ${n}★</button>
              `).join('')}
            </div>
            <div style="position:relative;flex:1;min-width:180px;max-width:300px">
              <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none"
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input type="text" placeholder="Поиск по отзывам…"
                value="${this.search.replace(/"/g,'&quot;')}"
                oninput="window.reviewsModule.setSearch(this.value)"
                style="width:100%;padding:7px 10px 7px 32px;border:1px solid var(--border);border-radius:8px;
                  background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box">
            </div>
            <span style="font-size:12px;color:var(--text2);margin-left:auto;white-space:nowrap">
              ${list.length.toLocaleString('ru')} отзывов
            </span>
          </div>

          <!-- REVIEWS LIST -->
          <div class="reviews-list" style="flex:1;overflow-y:auto;padding:16px 24px 100px;min-height:0">
            ${list.length === 0 ? `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
                padding:60px 20px;gap:12px;color:var(--text2)">
                <div style="font-size:40px">⭐</div>
                <div style="font-size:16px;font-weight:600">${ae.loaded ? 'Отзывов не найдено' : 'Загрузите отзывы'}</div>
                ${!ae.loaded ? `<button onclick="window.reviewsModule.loadReviews('${this.activeMp}','${this.activeStoreId}')"
                  style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);
                    background:var(--bg);cursor:pointer;font-size:13px">Загрузить</button>` : ''}
              </div>
            ` : list.map(r => this.renderCard(r)).join('')}
          </div>
        `}
      </div>
    `;
  }

  private renderCard(r: UnifiedReview): string {
    const isReplying = this.replyingId === r.id;
    const date = new Date(r.createdAt).toLocaleDateString('ru', { day:'2-digit', month:'short', year:'numeric' });
    const color = this.ratingColor(r.rating);

    const hasAdvDis = r.advantages || r.disadvantages;
    const initial = (r.authorName || '?').trim().charAt(0).toUpperCase() || '?';

    return `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;overflow:hidden;
        margin-bottom:12px;flex-shrink:0;transition:box-shadow .15s,border-color .15s"
        onmouseover="this.style.boxShadow='0 4px 18px rgba(0,0,0,.07)';this.style.borderColor='${color}40'"
        onmouseout="this.style.boxShadow='none';this.style.borderColor='var(--border)'">

        <!-- CARD HEADER -->
        <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px 10px">
          <div style="width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
            font-size:15px;font-weight:700;color:#fff;background:${MP_COLOR[r.mp]}">${this.esc(initial)}</div>

          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:13.5px;font-weight:700;color:var(--text)">${this.esc(r.authorName)}</span>
              <span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:5px;
                background:${MP_COLOR[r.mp]}15;color:${MP_COLOR[r.mp]};letter-spacing:.3px">${MP_LABEL[r.mp]}</span>
              <span style="margin-left:auto;font-size:11px;color:var(--text2);white-space:nowrap">${date}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap">
              <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:7px;
                background:${color}15;color:${color};font-size:12px;font-weight:700">★ ${r.rating}.0</span>
              ${r.answered ? `
                <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;color:#16a34a;
                  background:#16a34a15;padding:2px 8px;border-radius:7px">✓ Отвечен</span>` : `
                <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;color:#f97316;
                  background:#f9731615;padding:2px 8px;border-radius:7px">● Без ответа</span>`}
            </div>
          </div>
        </div>

        <!-- PRODUCT STRIP -->
        ${r.productName ? `
          <div style="margin:0 16px 10px;display:flex;align-items:center;gap:10px;padding:8px 10px;
            background:var(--bg2);border-radius:10px">
            ${r.productPhoto ? `
              <img src="${this.esc(r.productPhoto)}" alt="Товар"
                onerror="this.style.display='none'"
                onclick="window.reviewsModule.openLightbox('${this.esc(r.productPhoto)}')"
                style="width:36px;height:36px;border-radius:7px;object-fit:cover;flex-shrink:0;cursor:pointer;
                  border:1px solid var(--border);background:var(--bg)">
            ` : `
              <div style="width:36px;height:36px;border-radius:7px;flex-shrink:0;display:flex;align-items:center;
                justify-content:center;background:var(--bg3);font-size:14px">📦</div>
            `}
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;
                text-overflow:ellipsis" title="${this.esc(r.productName)}">${this.esc(r.productName)}</div>
              <div style="font-size:10.5px;color:var(--text2);display:flex;gap:8px;flex-wrap:wrap">
                ${r.orderId ? `<span title="Номер заказа">Заказ №${this.esc(String(r.orderId))}</span>` : ''}
                <span>${this.esc(r.storeName)}</span>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- REVIEW TEXT -->
        <div style="padding:0 16px 12px">
          ${hasAdvDis ? `
            ${r.advantages ? `
              <div style="display:flex;gap:8px;margin-bottom:6px;padding:8px 10px;background:#16a34a0c;border-radius:8px">
                <span style="font-size:11px;font-weight:700;color:#16a34a;flex-shrink:0">+</span>
                <span style="font-size:13px;color:var(--text);line-height:1.5">${this.esc(r.advantages)}</span>
              </div>` : ''}
            ${r.disadvantages ? `
              <div style="display:flex;gap:8px;margin-bottom:6px;padding:8px 10px;background:#dc26260c;border-radius:8px">
                <span style="font-size:11px;font-weight:700;color:#dc2626;flex-shrink:0">−</span>
                <span style="font-size:13px;color:var(--text);line-height:1.5">${this.esc(r.disadvantages)}</span>
              </div>` : ''}
            ${r.text ? `<div style="font-size:13px;color:var(--text);line-height:1.5;margin-top:4px">${this.esc(r.text)}</div>` : ''}
          ` : r.text ? `
            <p style="font-size:13px;color:var(--text);line-height:1.6;margin:0">${this.esc(r.text)}</p>
          ` : `<p style="font-size:13px;color:var(--text2);margin:0;font-style:italic">Без текста</p>`}
        </div>

        <!-- REVIEW PHOTOS / VIDEO -->
        ${(r.reviewPhotos && r.reviewPhotos.length > 0) || r.reviewVideo ? `
          <div style="padding:0 16px 12px">
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">
              Фото от покупателя${r.reviewPhotos && r.reviewPhotos.length > 1 ? ` (${r.reviewPhotos.length})` : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${(r.reviewPhotos ?? []).map(url => `
                <img src="${this.esc(url)}"
                  onerror="this.style.display='none'"
                  onclick="window.reviewsModule.openLightbox('${this.esc(url)}')"
                  style="width:76px;height:76px;object-fit:cover;border-radius:10px;cursor:pointer;
                    border:1px solid var(--border);background:var(--bg2);transition:transform .15s"
                  onmouseover="this.style.transform='scale(1.05)'"
                  onmouseout="this.style.transform='scale(1)'">
              `).join('')}
              ${r.reviewVideo ? `
                <div onclick="window.reviewsModule.openLightbox('${this.esc(r.reviewVideo)}', 'video')"
                  style="width:76px;height:76px;border-radius:10px;cursor:pointer;border:1px solid var(--border);
                    background:linear-gradient(135deg, #1f1f23, #2a2a30);display:flex;align-items:center;justify-content:center;position:relative">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                  <span style="position:absolute;bottom:3px;right:3px;font-size:9px;color:#fff;background:rgba(0,0,0,.7);padding:1px 4px;border-radius:3px">VIDEO</span>
                </div>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <!-- EXISTING ANSWER -->
        ${r.answered && r.answerText ? `
          <div style="margin:0 16px 12px;background:#16a34a0c;border:1px solid #16a34a30;
            border-radius:10px;padding:10px 14px">
            <div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:4px;display:flex;align-items:center;gap:5px">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#16a34a;color:#fff;font-size:9px">✓</span>
              Ваш ответ
            </div>
            <div style="font-size:13px;color:var(--text);line-height:1.5">${this.esc(r.answerText)}</div>
          </div>
        ` : ''}

        <!-- REPLY AREA -->
        ${!r.answered ? `
          <div style="padding:0 16px 14px">
            ${isReplying ? `
              <!-- TEMPLATES from autoReplyDb (matching rating) -->
              ${(() => {
                const allTpls = autoReplyDb.getTemplates();
                const matching = allTpls.filter(t => t.ratings.includes(r.rating));
                const others = allTpls.filter(t => !t.ratings.includes(r.rating));
                return `
                <div style="margin-bottom:10px">
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
                    <div style="font-size:11px;color:var(--text2);font-weight:600">
                      Шаблоны${matching.length > 0 ? ` (для ${r.rating}★)` : ''}
                    </div>
                    <button onclick="window.reviewsModule.openTemplatesQuick(${r.rating})"
                      style="padding:3px 8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);
                        border-radius:5px;cursor:pointer;font-size:10px;font-weight:600">⚙ Управление</button>
                  </div>
                  ${matching.length > 0 ? `
                    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:5px">
                      ${matching.map(t => `
                        <button onclick="window.reviewsModule.useTemplateById('${t.id}')"
                          title="${this.esc(t.text.slice(0,80))}…"
                          style="padding:5px 11px;border-radius:6px;border:1px solid ${MP_COLOR[r.mp]}40;
                            background:${MP_COLOR[r.mp]}10;cursor:pointer;font-size:11.5px;color:var(--text);max-width:240px;
                            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">
                          💬 ${this.esc(t.text.slice(0, 35))}${t.text.length > 35 ? '…' : ''}
                        </button>
                      `).join('')}
                    </div>` : `
                    <div style="font-size:11px;color:var(--text2);padding:6px 0">
                      Нет шаблонов для ${r.rating}★. <a href="#" onclick="event.preventDefault();window.reviewsModule.openTemplatesQuick(${r.rating})"
                        style="color:${MP_COLOR[r.mp]};text-decoration:underline">Создать →</a>
                    </div>`}
                  ${others.length > 0 ? `
                    <details style="margin-top:5px">
                      <summary style="font-size:10.5px;color:var(--text2);cursor:pointer;list-style:none">
                        + Другие шаблоны (${others.length})
                      </summary>
                      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px">
                        ${others.map(t => `
                          <button onclick="window.reviewsModule.useTemplateById('${t.id}')"
                            title="Для рейтингов: ${t.ratings.join(', ')}★"
                            style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);
                              background:var(--bg2);cursor:pointer;font-size:11px;color:var(--text2);max-width:240px;
                              overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                            ${t.ratings.map(rr => rr + '★').join('')} · ${this.esc(t.text.slice(0, 28))}${t.text.length > 28 ? '…' : ''}
                          </button>
                        `).join('')}
                      </div>
                    </details>` : ''}
                </div>`;
              })()}

              <textarea id="reply-ta-${r.id}"
                style="width:100%;min-height:96px;padding:10px 12px;border:1.5px solid ${MP_COLOR[r.mp]}60;
                  border-radius:8px;font-size:13px;background:var(--bg);color:var(--text);
                  resize:vertical;box-sizing:border-box;outline:none;line-height:1.5;font-family:inherit"
                placeholder="Введите ответ на отзыв (можно редактировать выбранный шаблон вручную)…"
                oninput="window.reviewsModule.updateReplyText('${r.id}',this.value)"
              >${this.replyText}</textarea>
              ${this.replyError ? `
                <div style="font-size:12px;color:#dc2626;margin-top:5px">⚠ ${this.replyError}</div>` : ''}
              <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
                <button onclick="window.reviewsModule.submitReply('${r.mp}','${r.storeId}','${r.id}',${r.campaignId ?? 'undefined'})"
                  ${this.replying ? 'disabled' : ''}
                  style="padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;
                    background:${MP_COLOR[r.mp]};color:#fff;opacity:${this.replying ? '.6' : '1'}">
                  ${this.replying ? 'Отправка…' : '📤 Отправить'}
                </button>
                <button onclick="window.reviewsModule.saveAsTemplate('${r.id}',${r.rating})"
                  style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);
                    cursor:pointer;font-size:12px;background:var(--bg2);color:var(--text);font-weight:500"
                  title="Сохранить текущий текст как шаблон для ${r.rating}★">
                  💾 В шаблоны
                </button>
                <button onclick="window.reviewsModule.cancelReply()"
                  style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);
                    cursor:pointer;font-size:12px;background:var(--bg2);color:var(--text)">
                  Отмена
                </button>
              </div>
            ` : `
              <button onclick="window.reviewsModule.openReply('${r.id}')"
                style="padding:7px 16px;border-radius:8px;border:1.5px solid #f97316;
                  cursor:pointer;font-size:12px;font-weight:600;color:#f97316;background:#f9731620">
                💬 Ответить
              </button>
            `}
          </div>
        ` : ''}
      </div>
    `;
  }

  private esc(s: string): string {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── AUTO-REPLY SETTINGS UI ────────────────────────────────────────────────
  openAutoReplySettings(): void {
    const settings = autoReplyDb.getSettings();
    const templates = autoReplyDb.getTemplates();

    const modal = document.createElement('div');
    modal.id = 'autoreply-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    const ratingsRow = (tpl: { ratings: number[] }) =>
      [1,2,3,4,5].map(r => `<span style="font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;
        background:${tpl.ratings.includes(r) ? '#f59e0b' : 'var(--bg2)'};
        color:${tpl.ratings.includes(r) ? '#fff' : 'var(--text2)'}">${r}★</span>`).join(' ');

    modal.innerHTML = `
      <div style="background:var(--bg);border-radius:16px;width:100%;max-width:680px;max-height:92vh;
        overflow:auto;padding:24px;box-shadow:0 24px 64px rgba(0,0,0,.3)">

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <div>
            <div style="font-size:18px;font-weight:700">🤖 Авто-ответы на отзывы</div>
            <div style="font-size:12px;color:var(--text2);margin-top:3px">
              Шаблоны автоматически отправляются после загрузки отзывов · выбирается случайный из подходящих
            </div>
          </div>
          <button onclick="document.getElementById('autoreply-modal').remove()"
            style="width:32px;height:32px;border:none;background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:16px">✕</button>
        </div>

        <!-- MASTER SWITCH -->
        <div style="padding:14px 16px;background:var(--bg2);border-radius:12px;margin-bottom:10px;
          display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:14px;font-weight:600">Включить авто-ответы</div>
            <div style="font-size:11px;color:var(--text2);margin-top:2px">Главный выключатель — действует после нажатия «Сохранить»</div>
          </div>
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
            <input type="checkbox" id="ar-master" ${settings.enabled ? 'checked' : ''}
              style="opacity:0;width:0;height:0"
              onchange="
                const track=this.nextElementSibling;
                const circle=track.firstElementChild;
                track.style.background=this.checked?'#16a34a':'#cbd5e1';
                circle.style.left=this.checked?'23px':'3px';
                const w=document.getElementById('ar-warning');
                if(w)w.style.display=this.checked?'flex':'none';
              ">
            <span style="position:absolute;inset:0;background:${settings.enabled ? '#16a34a' : '#cbd5e1'};border-radius:24px;transition:background .2s">
              <span style="position:absolute;height:18px;width:18px;left:${settings.enabled ? '23px' : '3px'};top:3px;background:#fff;border-radius:50%;transition:left .2s"></span>
            </span>
          </label>
        </div>

        <!-- Предупреждение при включении -->
        <div id="ar-warning" style="display:${!settings.enabled ? 'none' : 'none'};align-items:flex-start;gap:8px;
          padding:10px 14px;background:#f59e0b18;border:1px solid #f59e0b40;border-radius:10px;margin-bottom:10px;font-size:12px">
          <span style="font-size:16px;flex-shrink:0">⚠️</span>
          <div>
            <b>Авто-ответ будет применён и к уже существующим отзывам без ответа</b> в текущем списке.
            Это произойдёт при следующей загрузке отзывов. Убедитесь что шаблоны настроены правильно перед сохранением.
          </div>
        </div>

        <!-- API статусы -->
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;padding:8px 12px;background:var(--bg2);border-radius:10px;font-size:11px">
          <span style="color:var(--muted)">Статус API:</span>
          <span style="color:#f59e0b">🟡 WB — API отзывов требует тарифа с доступом (часто недоступен)</span>
          <span style="color:#f97316">🟠 Ozon — требует Seller Premium для авто-ответов</span>
          <span style="color:#16a34a">🟢 ЯМ — работает через API</span>
        </div>

        <!-- RATING TOGGLES -->
        <div style="margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
            Отвечать на отзывы с рейтингом:
          </div>
          <div style="display:flex;gap:6px">
            ${[1,2,3,4,5].map(r => `
              <label style="flex:1;cursor:pointer">
                <input type="checkbox" data-rating="${r}" ${settings.enabledByRating[r] ? 'checked' : ''}
                  style="display:none"
                  onchange="this.closest('label').querySelector('div').style.border='2px solid '+(this.checked?'#f59e0b':'var(--border)')">
                <div style="padding:10px;border:2px solid ${settings.enabledByRating[r] ? '#f59e0b' : 'var(--border)'};
                  border-radius:10px;text-align:center;background:${settings.enabledByRating[r] ? '#fff7ed' : 'var(--bg)'};
                  transition:.15s">
                  <div style="font-size:18px;font-weight:800;color:${settings.enabledByRating[r] ? '#f59e0b' : 'var(--text2)'}">${r}★</div>
                </div>
              </label>
            `).join('')}
          </div>
        </div>

        <!-- MP TOGGLES -->
        <div style="margin-bottom:18px">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
            Маркетплейсы:
          </div>
          <div style="display:flex;gap:6px">
            ${(['wb','ozon','yandex'] as Mp[]).map(mp => `
              <label style="flex:1;cursor:pointer">
                <input type="checkbox" data-mp="${mp}" ${settings.enabledByMp[mp] ? 'checked' : ''}
                  style="display:none"
                  onchange="this.closest('label').querySelector('div').style.border='2px solid '+(this.checked?'${MP_COLOR[mp]}':'var(--border)')">
                <div style="padding:10px;border:2px solid ${settings.enabledByMp[mp] ? MP_COLOR[mp] : 'var(--border)'};
                  border-radius:10px;text-align:center;background:${settings.enabledByMp[mp] ? MP_BG[mp] : 'var(--bg)'};
                  font-weight:600;color:${settings.enabledByMp[mp] ? MP_COLOR[mp] : 'var(--text2)'}">
                  ${mp === 'wb' ? 'Wildberries' : mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет'}
                </div>
              </label>
            `).join('')}
          </div>
        </div>

        <!-- TEMPLATES LIST -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">
            Шаблоны ответов (${templates.length})
          </div>
          <button onclick="window.reviewsModule.addTemplate()"
            style="padding:6px 12px;border:1px solid var(--accent);background:var(--accent);color:#000;
              border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">+ Новый шаблон</button>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:10px;line-height:1.5">
          💡 Добавляйте несколько шаблонов для одного рейтинга — система случайным образом выберет один из них при ответе.
          Это позволит избежать одинаковых ответов под разными отзывами.
        </div>

        <div id="ar-templates-list" style="display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;padding-right:4px">
          ${templates.length === 0 ? `
            <div style="padding:30px;text-align:center;color:var(--text2);font-size:13px">
              Шаблонов пока нет. Добавьте первый, чтобы система могла отвечать автоматически.
            </div>
          ` : templates.map(t => `
            <div style="padding:12px 14px;background:var(--bg2);border-radius:10px;border:1px solid var(--border)">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px">
                <div style="display:flex;gap:3px;align-items:center">${ratingsRow(t)}</div>
                <div style="display:flex;gap:4px">
                  <button onclick="window.reviewsModule.editTemplate('${t.id}')"
                    style="padding:4px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;cursor:pointer;font-size:11px">✎ Изм.</button>
                  <button onclick="window.reviewsModule.deleteTemplate('${t.id}')"
                    style="padding:4px 10px;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:6px;cursor:pointer;font-size:11px">✕ Уд.</button>
                </div>
              </div>
              <div style="font-size:12.5px;color:var(--text);line-height:1.5;white-space:pre-wrap">${this.esc(t.text)}</div>
            </div>
          `).join('')}
        </div>

        <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px">
          <button onclick="document.getElementById('autoreply-modal').remove()"
            style="padding:8px 16px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer">Отмена</button>
          <button onclick="window.reviewsModule.saveAutoReplySettings()"
            style="padding:8px 20px;border:none;background:#16a34a;color:#fff;border-radius:8px;cursor:pointer;font-weight:600">💾 Сохранить</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  toggleAutoReply(_key: string, _value: boolean): void {
    // Теперь сохранение происходит только по кнопке «Сохранить» (saveAutoReplySettings)
    // Этот метод оставлен для обратной совместимости с checkbox onchange
  }

  /** Сохранить настройки авто-ответа из модала */
  saveAutoReplySettings(): void {
    const masterEl  = document.getElementById('ar-master')  as HTMLInputElement | null;
    const enabled   = masterEl?.checked ?? false;

    // Рейтинги
    const enabledByRating: Record<number, boolean> = {};
    [1,2,3,4,5].forEach(r => {
      const el = document.querySelector<HTMLInputElement>(`input[data-rating="${r}"]`);
      enabledByRating[r] = el ? el.checked : false;
    });

    // МП
    const enabledByMp: Record<string, boolean> = {};
    ['wb','ozon','yandex'].forEach(mp => {
      const el = document.querySelector<HTMLInputElement>(`input[data-mp="${mp}"]`);
      enabledByMp[mp] = el ? el.checked : false;
    });

    autoReplyDb.setSettings({ enabled, enabledByRating: enabledByRating as any, enabledByMp: enabledByMp as any });
    document.getElementById('autoreply-modal')?.remove();
    this.render();

    if (enabled) {
      // Немедленно запускаем авто-ответ для всех уже загруженных магазинов
      for (const entry of this.entries) {
        if (entry.loaded && !entry.loading && !entry.error) {
          this.runAutoReply(entry).catch((e) => debug.warn('[ReviewsModule] swallowed error', e));
        }
      }
      // При включении — показываем что сейчас пройдёт по всем без ответа
      setTimeout(() => {
        const unanswered = this.allReviews().filter(r => !r.answered).length;
        if (unanswered > 0) {
          // Небольшое уведомление
          const toast = document.createElement('div');
          toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 20px;background:#1f2937;color:#fff;border-radius:10px;font-size:13px;z-index:9999;max-width:400px;text-align:center';
          toast.textContent = `✅ Авто-ответ включён. Будет применён к ${unanswered} отзывам без ответа при следующей загрузке.`;
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
        }
      }, 300);
    }
  }

  private allReviews(): UnifiedReview[] {
    return this.entries.flatMap(e => e.reviews || []);
  }

  addTemplate(): void {
    this.openTemplateEditor(null);
  }

  editTemplate(id: string): void {
    const tpl = autoReplyDb.getTemplates().find(t => t.id === id);
    if (tpl) this.openTemplateEditor(tpl);
  }

  private openTemplateEditor(existing: import('@/services/autoReplyDb').ReplyTemplate | null): void {
    const editorModal = document.createElement('div');
    editorModal.id = 'tpl-editor-modal';
    editorModal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1100;display:flex;align-items:center;justify-content:center;padding:20px';
    editorModal.onclick = (e) => { if (e.target === editorModal) editorModal.remove(); };

    const currentRatings = new Set(existing?.ratings ?? [5]);

    editorModal.innerHTML = `
      <div style="background:var(--bg);border-radius:14px;width:100%;max-width:500px;padding:22px;box-shadow:0 24px 64px rgba(0,0,0,.3)">
        <div style="font-size:16px;font-weight:700;margin-bottom:14px">
          ${existing ? '✎ Редактирование шаблона' : '+ Новый шаблон'}
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Применять к рейтингам</div>
          <div style="display:flex;gap:6px">
            ${[1,2,3,4,5].map(r => `
              <label style="flex:1;cursor:pointer">
                <input type="checkbox" data-rating="${r}" ${currentRatings.has(r) ? 'checked' : ''}
                  style="display:none" class="tpl-rating-chk"
                  onchange="this.parentElement.querySelector('div').style.background = this.checked ? '#f59e0b' : 'var(--bg2)';
                           this.parentElement.querySelector('div').style.color = this.checked ? '#fff' : 'var(--text2)';
                           this.parentElement.querySelector('div').style.borderColor = this.checked ? '#f59e0b' : 'var(--border)'">
                <div style="padding:10px;border:2px solid ${currentRatings.has(r) ? '#f59e0b' : 'var(--border)'};
                  border-radius:8px;text-align:center;background:${currentRatings.has(r) ? '#f59e0b' : 'var(--bg2)'};
                  color:${currentRatings.has(r) ? '#fff' : 'var(--text2)'};font-weight:800;font-size:15px">${r}★</div>
              </label>
            `).join('')}
          </div>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Текст ответа</div>
          <textarea id="tpl-text" rows="5" placeholder="Например: Спасибо за ваш отзыв! Очень рады, что товар вам понравился."
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;
              background:var(--bg);color:var(--text);font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box">${existing ? this.esc(existing.text) : ''}</textarea>
          <div style="font-size:11px;color:var(--text2);margin-top:4px">
            💡 Совет: создайте 3–4 разных шаблона для одного рейтинга — будут отправляться по очереди случайным образом.
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button onclick="document.getElementById('tpl-editor-modal').remove()"
            style="padding:8px 18px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer">Отмена</button>
          <button onclick="window.reviewsModule.saveTemplateFromEditor('${existing?.id ?? ''}')"
            style="padding:8px 18px;border:none;background:#16a34a;color:#fff;border-radius:8px;cursor:pointer;font-weight:600">Сохранить</button>
        </div>
      </div>
    `;
    document.body.appendChild(editorModal);
  }

  saveTemplateFromEditor(existingId: string): void {
    const checks = document.querySelectorAll<HTMLInputElement>('.tpl-rating-chk:checked');
    const ratings = Array.from(checks).map(c => parseInt(c.dataset.rating!));
    const text = (document.getElementById('tpl-text') as HTMLTextAreaElement)?.value.trim();

    if (ratings.length === 0) { alert('Выберите хотя бы один рейтинг'); return; }
    if (!text) { alert('Введите текст ответа'); return; }

    if (existingId) {
      autoReplyDb.updateTemplate(existingId, { ratings, text });
    } else {
      autoReplyDb.addTemplate({ ratings, text });
    }

    document.getElementById('tpl-editor-modal')?.remove();
    document.getElementById('autoreply-modal')?.remove();
    this.openAutoReplySettings();
  }

  deleteTemplate(id: string): void {
    if (!confirm('Удалить этот шаблон?')) return;
    autoReplyDb.deleteTemplate(id);
    document.getElementById('autoreply-modal')?.remove();
    this.openAutoReplySettings();
  }
}
