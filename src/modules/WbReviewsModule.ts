/**
 * WbReviewsModule — отзывы Wildberries с шаблонными ответами.
 * Загружает отзывы через /feedback/v1/feedbacks, позволяет отвечать.
 */

import { wbDb } from '@/services/wbDb';
import { wbApi, WbFeedback } from '@/services/wbApi';
import { WbStore } from '@/types/wb';

type FilterMode = 'all' | 'unanswered' | 'answered';
type StarFilter = 0 | 1 | 2 | 3 | 4 | 5;

const TEMPLATES: { label: string; text: string }[] = [
  {
    label: 'Спасибо (позитив)',
    text: 'Большое спасибо за ваш отзыв! Очень рады, что товар вам понравился. Будем рады видеть вас снова!',
  },
  {
    label: 'Извинение (негатив)',
    text: 'Приносим извинения за доставленные неудобства. Ваш отзыв очень важен для нас. Пожалуйста, свяжитесь с нашей службой поддержки, и мы обязательно решим вашу проблему.',
  },
  {
    label: 'Нейтральный',
    text: 'Благодарим за обратную связь! Ваше мнение помогает нам становиться лучше.',
  },
  {
    label: 'Проблема с размером',
    text: 'Спасибо за отзыв! Обратите внимание на размерную таблицу в описании товара. Если размер не подошёл, вы можете оформить бесплатный обмен.',
  },
  {
    label: 'Проблема с качеством',
    text: 'Приносим извинения за неудобства с качеством товара. Пожалуйста, свяжитесь с нами — мы обязательно заменим товар или вернём деньги.',
  },
];

interface StoreWithFeedbacks {
  store: WbStore;
  feedbacks: WbFeedback[];
  loading: boolean;
  error: string | null;
  countUnanswered: number;
}

export class WbReviewsModule {
  private container: HTMLElement;
  private stores: WbStore[] = [];
  private storeData: StoreWithFeedbacks[] = [];
  private activeStoreId: string | null = null;
  private filterMode: FilterMode = 'all';
  private starFilter: StarFilter = 0;
  private search = '';
  private replyingId: string | null = null;
  private replyText = '';
  private replying = false;
  private replyError = '';

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.stores = await wbDb.getStores();
    if (this.stores.length && !this.activeStoreId) {
      this.activeStoreId = this.stores[0].id;
    }
    this.storeData = this.stores.map(s => ({
      store: s,
      feedbacks: [],
      loading: false,
      error: null,
      countUnanswered: 0,
    }));
    this.render();
    if (this.activeStoreId) this.loadFeedbacks(this.activeStoreId);
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  private async loadFeedbacks(storeId: string): Promise<void> {
    const sd = this.storeData.find(s => s.store.id === storeId);
    if (!sd) return;
    sd.loading = true;
    sd.error = null;
    this.render();
    try {
      const res = await wbApi.getFeedbacks(sd.store.feedback_api_key || sd.store.api_key, { take: 1000 });
      sd.feedbacks = res.feedbacks;
      sd.countUnanswered = res.countUnanswered;
    } catch (e: any) {
      sd.error = e?.message ?? 'Ошибка загрузки отзывов';
    }
    sd.loading = false;
    this.render();
  }

  selectStore(id: string): void {
    this.activeStoreId = id;
    const sd = this.storeData.find(s => s.store.id === id);
    if (sd && !sd.feedbacks.length && !sd.loading) {
      this.loadFeedbacks(id);
    } else {
      this.render();
    }
  }

  setFilter(mode: FilterMode): void { this.filterMode = mode; this.render(); }
  setStar(star: StarFilter): void { this.starFilter = star; this.render(); }
  setSearch(q: string): void { this.search = q; this.render(); }

  openReply(id: string): void {
    this.replyingId = id;
    this.replyText = '';
    this.replyError = '';
    this.render();
    setTimeout(() => {
      document.getElementById(`reply-textarea-${id}`)?.focus();
    }, 50);
  }

  cancelReply(): void {
    this.replyingId = null;
    this.replyText = '';
    this.replyError = '';
    this.render();
  }

  updateReplyText(id: string, text: string): void {
    if (this.replyingId === id) this.replyText = text;
  }

  useTemplate(text: string): void {
    this.replyText = text;
    const ta = document.getElementById(`reply-textarea-${this.replyingId}`) as HTMLTextAreaElement;
    if (ta) ta.value = text;
  }

  async submitReply(storeId: string, feedbackId: string): Promise<void> {
    if (!this.replyText.trim()) {
      this.replyError = 'Введите текст ответа';
      this.render();
      return;
    }
    const sd = this.storeData.find(s => s.store.id === storeId);
    if (!sd) return;
    this.replying = true;
    this.replyError = '';
    this.render();
    try {
      await wbApi.replyFeedback(sd.store.feedback_api_key || sd.store.api_key, feedbackId, this.replyText.trim());
      const fb = sd.feedbacks.find(f => f.id === feedbackId);
      if (fb) {
        fb.answer = { text: this.replyText.trim() };
        sd.countUnanswered = Math.max(0, sd.countUnanswered - 1);
      }
      this.replyingId = null;
      this.replyText = '';
    } catch (e: any) {
      this.replyError = e?.message ?? 'Ошибка при отправке ответа';
    }
    this.replying = false;
    this.render();
  }

  private get activeStoreData(): StoreWithFeedbacks | null {
    return this.storeData.find(s => s.store.id === this.activeStoreId) ?? null;
  }

  private get filteredFeedbacks(): WbFeedback[] {
    const sd = this.activeStoreData;
    if (!sd) return [];
    let list = [...sd.feedbacks];
    if (this.filterMode === 'unanswered') list = list.filter(f => !f.answer);
    else if (this.filterMode === 'answered') list = list.filter(f => !!f.answer);
    if (this.starFilter > 0) list = list.filter(f => f.productValuation === this.starFilter);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(f =>
        (f.text ?? '').toLowerCase().includes(q) ||
        (f.userName ?? '').toLowerCase().includes(q) ||
        (f.productDetails?.productName ?? '').toLowerCase().includes(q),
      );
    }
    return list.sort((a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime());
  }

  private starHtml(n: number): string {
    return Array.from({ length: 5 }, (_, i) =>
      `<span style="color:${i < n ? '#f59e0b' : '#d1d5db'}">★</span>`
    ).join('');
  }

  private ratingColor(n: number): string {
    return n >= 4 ? '#16a34a' : n >= 3 ? '#f97316' : '#dc2626';
  }

  render(): void {
    const sd = this.activeStoreData;
    const list = this.filteredFeedbacks;
    const unanswered = sd?.countUnanswered ?? 0;

    this.container.innerHTML = `
      <div class="oz-wrap">
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" fill="#cb11ab"/>
                <text x="12" y="16" text-anchor="middle" fill="white" font-size="7" font-weight="800" font-family="Arial">WB</text>
              </svg>
              <span class="oz-brand-name">Отзывы WB</span>
              ${unanswered > 0 ? `<span style="background:#dc2626;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:20px;margin-left:8px">${unanswered}</span>` : ''}
            </div>
          </div>
          <div class="oz-topbar-right">
            ${this.activeStoreId ? `
              <button class="btn" onclick="window.wbReviewsModule.loadFeedbacks('${this.activeStoreId}')">
                Обновить
              </button>
            ` : ''}
          </div>
        </div>

        ${this.stores.length === 0 ? `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-2);padding:40px">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <div style="font-size:16px;font-weight:600">Нет подключённых магазинов WB</div>
            <div style="font-size:13px;opacity:.6">Подключите магазин в разделе «Маркетплейсы»</div>
          </div>
        ` : `
          <!-- Store switcher -->
          ${this.stores.length > 1 ? `
            <div class="oz-toolbar" style="padding:0 24px">
              <div class="oz-tabs">
                ${this.stores.map(s => {
                  const d = this.storeData.find(x => x.store.id === s.id);
                  const cnt = d?.countUnanswered ?? 0;
                  return `
                    <button class="oz-tab ${this.activeStoreId === s.id ? 'active' : ''}"
                      onclick="window.wbReviewsModule.selectStore('${s.id}')">
                      ${s.name}
                      ${cnt > 0 ? `<span style="background:#dc2626;color:#fff;font-size:10px;padding:1px 5px;border-radius:10px;margin-left:4px">${cnt}</span>` : ''}
                    </button>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}

          ${sd?.loading ? `
            <div style="display:flex;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-2)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
                </path>
              </svg>
              Загружаем отзывы…
            </div>
          ` : sd?.error ? `
            <div style="padding:24px;color:#dc2626;font-size:13px">⚠ ${sd.error}</div>
          ` : `
            <!-- Filters -->
            <div style="display:flex;align-items:center;gap:8px;padding:12px 24px;border-bottom:1px solid var(--border);flex-wrap:wrap">
              <div style="display:flex;gap:4px">
                ${(['all','unanswered','answered'] as FilterMode[]).map(m => `
                  <button class="btn ${this.filterMode === m ? 'btn-primary' : ''}" style="font-size:12px;padding:4px 10px"
                    onclick="window.wbReviewsModule.setFilter('${m}')">
                    ${ m === 'all' ? 'Все' : m === 'unanswered' ? `Без ответа${unanswered > 0 ? ` (${unanswered})` : ''}` : 'С ответом'}
                  </button>
                `).join('')}
              </div>
              <div style="display:flex;gap:2px">
                <button class="btn ${this.starFilter === 0 ? 'btn-primary' : ''}" style="font-size:12px;padding:4px 8px"
                  onclick="window.wbReviewsModule.setStar(0)">Все ★</button>
                ${[1,2,3,4,5].map(n => `
                  <button class="btn ${this.starFilter === n ? 'btn-primary' : ''}" style="font-size:12px;padding:4px 8px;color:${this.ratingColor(n)}"
                    onclick="window.wbReviewsModule.setStar(${n})">${n}★</button>
                `).join('')}
              </div>
              <input type="text" class="oz-search" placeholder="Поиск по тексту, имени, товару…"
                value="${this.search}" oninput="window.wbReviewsModule.setSearch(this.value)"
                style="flex:1;min-width:200px;max-width:320px">
              <span style="font-size:12px;color:var(--text-2);margin-left:auto">${list.length.toLocaleString('ru')} отзывов</span>
            </div>

            <!-- Reviews list -->
            <div style="flex:1;overflow:auto;padding:16px 24px 100px;display:flex;flex-direction:column;gap:12px">
              ${list.length === 0 ? `
                <div style="text-align:center;padding:40px;color:var(--text-2)">
                  <div style="font-size:32px;margin-bottom:8px">💬</div>
                  <div>Отзывов не найдено</div>
                </div>
              ` : list.map(f => this.renderFeedbackCard(f)).join('')}
            </div>
          `}
        `}
      </div>
    `;
  }

  private renderFeedbackCard(f: WbFeedback): string {
    const isReplying = this.replyingId === f.id;
    const hasAnswer = !!f.answer;
    const storeId = this.activeStoreId ?? '';
    const date = new Date(f.createdDate).toLocaleDateString('ru', { day: '2-digit', month: 'short', year: 'numeric' });

    return `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px;
        ${!hasAnswer ? 'border-left:3px solid #f97316' : ''}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:50%;background:${this.ratingColor(f.productValuation)}22;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:${this.ratingColor(f.productValuation)};flex-shrink:0">
              ${f.productValuation}
            </div>
            <div>
              <div style="font-size:13px;font-weight:600">${f.userName || 'Покупатель'}</div>
              <div style="font-size:11px;color:var(--text-2)">${date}</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
            <div style="font-size:16px">${this.starHtml(f.productValuation)}</div>
            ${f.productDetails?.productName ? `
              <div style="font-size:11px;color:var(--text-2);max-width:180px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.productDetails.productName}</div>
            ` : ''}
          </div>
        </div>

        ${f.text ? `<p style="font-size:13px;line-height:1.6;margin:0 0 12px;color:var(--text-1)">${f.text}</p>` : ''}

        ${hasAnswer ? `
          <div style="background:var(--bg-2);border-radius:8px;padding:10px 14px;font-size:12px;border-left:3px solid #16a34a">
            <div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:4px">✓ Ваш ответ:</div>
            <div style="color:var(--text-1)">${f.answer!.text}</div>
          </div>
        ` : isReplying ? `
          <div style="margin-top:8px">
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              ${TEMPLATES.map((t) => `
                <button class="btn" style="font-size:11px;padding:3px 8px"
                  onclick="window.wbReviewsModule.useTemplate(${JSON.stringify(t.text)})">${t.label}</button>
              `).join('')}
            </div>
            <textarea id="reply-textarea-${f.id}"
              style="width:100%;min-height:80px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--bg);color:var(--text-1);resize:vertical;box-sizing:border-box"
              placeholder="Введите ответ на отзыв…"
              oninput="window.wbReviewsModule.updateReplyText('${f.id}', this.value)"
            >${this.replyText}</textarea>
            ${this.replyError ? `<div style="font-size:12px;color:#dc2626;margin-top:4px">${this.replyError}</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn btn-primary" style="font-size:12px" ${this.replying ? 'disabled' : ''}
                onclick="window.wbReviewsModule.submitReply('${storeId}', '${f.id}')">
                ${this.replying ? 'Отправка…' : 'Отправить ответ'}
              </button>
              <button class="btn" style="font-size:12px" onclick="window.wbReviewsModule.cancelReply()">Отмена</button>
            </div>
          </div>
        ` : `
          <div style="display:flex;justify-content:flex-end">
            <button class="btn" style="font-size:12px;color:#f97316;border-color:#f97316"
              onclick="window.wbReviewsModule.openReply('${f.id}')">
              Ответить
            </button>
          </div>
        `}
      </div>
    `;
  }
}
