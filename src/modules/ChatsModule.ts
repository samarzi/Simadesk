/**
 * ChatsModule — чаты с покупателями WB и Ozon.
 *
 * ВАЖНО: переписки НЕ хранятся в нашей БД — список чатов и сообщения
 * каждый раз запрашиваются напрямую через API маркетплейса (live).
 * Локально храним только in-memory кеш на время открытой вкладки.
 */

import { debug } from '@/utils/debug';
import { wbDb } from '@/services/wbDb';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { wbApi, WbChat, WbChatMessage } from '@/services/wbApi';
import { ozonApi, OzonChat, OzonChatMessage } from '@/services/ozonApi';
import { yandexApi, YandexChat, YandexChatMessage } from '@/services/yandexApi';
import { helpBtn } from '@/services/helpModal';
import { WbStore } from '@/types/wb';
import { OzonStore } from '@/types/ozon';
import { YandexStore } from '@/types/yandex';
import { esc } from '@/utils/format';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';

type Mp = 'wb' | 'ozon' | 'yandex';

const MP_COLOR: Record<Mp, string> = { wb: '#cb11ab', ozon: '#005bff', yandex: '#fc3f1d' };
const MP_LABEL: Record<Mp, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

/** Полупрозрачная подложка цвета маркетплейса — читаема и в тёмной, и в светлой теме. */
const mpBg = (mp: Mp): string => `${MP_COLOR[mp]}22`;

// Личные пометки по чатам (статус-флаг + заметка) — хранятся локально в браузере,
// т.к. переписки и так не сохраняются в нашей БД (см. шапку файла).
type ChatStatus = 'none' | 'yellow' | 'red';
interface ChatMeta { status: ChatStatus; note: string; }
const CHAT_META_KEY = 'simadesk_chat_meta_v1';
const STATUS_COLOR: Record<Exclude<ChatStatus, 'none'>, string> = { yellow: '#eab308', red: '#ef4444' };

interface UnifiedChat {
  id: string;
  mp: Mp;
  storeId: string;
  storeName: string;
  title: string;       // имя/идентификатор покупателя
  lastMessage: string;
  lastTime: string;
  unread: number;
  replySign?: string;  // WB: подпись чата, нужна для отправки сообщений
  empty?: boolean;     // Ozon/Yandex: чат без единого сообщения (создан автоматически API) — скрываем из списка
}

interface UnifiedMessage {
  id: string;
  fromMe: boolean;
  isSystem?: boolean;
  senderLabel?: string;
  text: string;
  attachments?: { name: string; url: string }[];
  time: string;
}

interface StoreEntry {
  mp: Mp;
  storeId: string;
  storeName: string;
  campaignId?: number | null;
  loading: boolean;
  error: string | null;
  chats: UnifiedChat[];
  loaded: boolean;
}

export class ChatsModule {
  private container: HTMLElement;
  private entries: StoreEntry[] = [];
  private activeMp: Mp = 'wb';
  private activeStoreId: string | null = null;
  private activeChatId: string | null = null;
  private messages: UnifiedMessage[] = [];
  private messagesLoading = false;
  private messagesError: string | null = null;
  private sending = false;
  private search = '';
  private storesError: string | null = null;
  private previewImage: string | null = null;
  private shouldScrollToBottom = false;
  // Ozon: вложения чата требуют авторизованного запроса (Client-Id/Api-Key) —
  // картинки скачиваются как blob и кэшируются здесь по исходному URL.
  private ozonCreds: { client_id: string; api_key: string } | null = null;
  private ozonImageUrls = new Map<string, string>();
  // Вложение, выбранное для отправки, но ещё не отправленное.
  private pendingAttachment: { name: string; mime: string; base64: string; dataUrl: string; file: File } | null = null;
  private notesOpen = false;

  private readonly _escHandler = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && this.previewImage) this.closeImagePreview();
  };

  constructor(container: HTMLElement) {
    this.container = container;
    document.addEventListener('keydown', this._escHandler);
  }

  destroy(): void {
    document.removeEventListener('keydown', this._escHandler);
  }

  openImagePreview(url: string): void {
    // Не вызываем render() — полная пересборка DOM сбрасывает скролл переписки
    // в начало (это становится заметно при закрытии превью). Добавляем оверлей
    // напрямую в DOM, не трогая остальной интерфейс.
    this.previewImage = url;
    if (!document.getElementById('chat-img-preview-overlay')) {
      this.container.insertAdjacentHTML('beforeend', this.renderImagePreviewOverlay());
    }
  }

  closeImagePreview(): void {
    this.previewImage = null;
    document.getElementById('chat-img-preview-overlay')?.remove();
  }

  /** HTML полноэкранного превью изображения из чата (оверлей поверх остального интерфейса). */
  private renderImagePreviewOverlay(): string {
    if (!this.previewImage) return '';
    return `
      <div id="chat-img-preview-overlay" onclick="window.chatsModule.closeImagePreview()"
        style="position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1000;
          display:flex;align-items:center;justify-content:center;cursor:zoom-out">
        <img src="${esc(this.previewImage)}" onclick="event.stopPropagation()"
          style="max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5)">
        <button onclick="window.chatsModule.closeImagePreview()"
          style="position:absolute;top:20px;right:24px;width:38px;height:38px;border-radius:50%;
            border:none;background:rgba(255,255,255,.12);color:#fff;font-size:20px;cursor:pointer;
            display:flex;align-items:center;justify-content:center;line-height:1">×</button>
      </div>
    `;
  }

  // ── Личные пометки по чатам (статус-флаг + заметка) ───────────────────────

  private loadAllMeta(): Record<string, ChatMeta> {
    try { return JSON.parse(localStorage.getItem(CHAT_META_KEY) || '{}'); } catch { return {}; }
  }

  private metaKey(mp: Mp, storeId: string, chatId: string): string {
    return `${mp}:${storeId}:${chatId}`;
  }

  private getChatMeta(mp: Mp, storeId: string, chatId: string): ChatMeta {
    return this.loadAllMeta()[this.metaKey(mp, storeId, chatId)] ?? { status: 'none', note: '' };
  }

  /** Переключить статус-флаг текущего чата (повторный клик по тому же флагу снимает его). */
  setChatStatus(status: ChatStatus): void {
    if (!this.activeChatId || !this.activeStoreId) return;
    const all = this.loadAllMeta();
    const key = this.metaKey(this.activeMp, this.activeStoreId, this.activeChatId);
    const cur = all[key] ?? { status: 'none', note: '' };
    all[key] = { ...cur, status: cur.status === status ? 'none' : status };
    localStorage.setItem(CHAT_META_KEY, JSON.stringify(all));
    this.render();
  }

  /** Сохранить личную заметку к текущему чату (не вызывает render, чтобы не сбивать курсор в textarea). */
  setChatNote(note: string): void {
    if (!this.activeChatId || !this.activeStoreId) return;
    const all = this.loadAllMeta();
    const key = this.metaKey(this.activeMp, this.activeStoreId, this.activeChatId);
    const cur = all[key] ?? { status: 'none', note: '' };
    all[key] = { ...cur, note };
    localStorage.setItem(CHAT_META_KEY, JSON.stringify(all));
  }

  toggleNotes(): void {
    this.notesOpen = !this.notesOpen;
    this.render();
  }

  // ── Вложения для отправки ──────────────────────────────────────────────

  async handleAttachmentSelect(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      try { window.app?.toast?.('Файл слишком большой (макс. 10 МБ)', 'error'); } catch (e) { debug.warn('[ChatsModule] swallowed error', e); }
      return;
    }
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.split(',')[1] || '';
    this.pendingAttachment = { name: file.name, mime: file.type, base64, dataUrl, file };
    this.render();
  }

  clearAttachment(): void {
    this.pendingAttachment = null;
    this.render();
  }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    await this.reloadStores();
    this.render();
    if (this.activeStoreId) this.loadChats(this.activeMp, this.activeStoreId);
  }

  hide(): void { this.container.style.display = 'none'; }

  private async reloadStores(): Promise<void> {
    const results = await Promise.allSettled([
      wbDb.getStores(),
      ozonDb.getStores(),
      yandexDb.getStores(),
    ]);

    const errMsgs: string[] = [];
    const pick = <T>(r: PromiseSettledResult<T[]>, label: string): T[] => {
      if (r.status === 'fulfilled') return r.value;
      errMsgs.push(`${label}: ${r.reason?.message ?? r.reason}`);
      return [];
    };
    const wbStores = pick<WbStore>(results[0] as any, 'WB');
    const ozonStores = pick<OzonStore>(results[1] as any, 'Ozon');
    const yandexStores = pick<YandexStore>(results[2] as any, 'Яндекс.Маркет');
    this.storesError = errMsgs.length ? errMsgs.join('\n') : null;

    const existing = new Map(this.entries.map(e => [`${e.mp}:${e.storeId}`, e]));

    this.entries = [
      ...wbStores.map((s): StoreEntry => existing.get(`wb:${s.id}`) ?? {
        mp: 'wb', storeId: s.id, storeName: s.name,
        loading: false, error: null, chats: [], loaded: false,
      }),
      ...ozonStores.map((s): StoreEntry => existing.get(`ozon:${s.id}`) ?? {
        mp: 'ozon', storeId: s.id, storeName: s.name,
        loading: false, error: null, chats: [], loaded: false,
      }),
      ...yandexStores.filter(s => s.campaign_id).map((s): StoreEntry => existing.get(`yandex:${s.id}`) ?? {
        mp: 'yandex', storeId: s.id, storeName: s.name, campaignId: s.campaign_id,
        loading: false, error: null, chats: [], loaded: false,
      }),
    ];

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
    this.activeChatId = null;
    this.messages = [];
    this.render();
    if (this.activeStoreId) {
      const e = this.entries.find(e => e.mp === mp && e.storeId === this.activeStoreId);
      if (e && !e.loaded && !e.loading) this.loadChats(mp, this.activeStoreId);
    }
  }

  selectStore(storeId: string): void {
    this.activeStoreId = storeId;
    this.activeChatId = null;
    this.messages = [];
    const e = this.entries.find(e => e.storeId === storeId && e.mp === this.activeMp);
    if (e && !e.loaded && !e.loading) this.loadChats(this.activeMp, storeId);
    else this.render();
  }

  setSearch(q: string): void { this.search = q; this.render(); }

  /** Закрыть переписку и вернуться к списку чатов (используется на мобильной раскладке). */
  backToList(): void {
    this.activeChatId = null;
    this.render();
  }

  async loadChats(mp: Mp, storeId: string): Promise<void> {
    const e = this.entries.find(e => e.mp === mp && e.storeId === storeId);
    if (!e || e.loading) return;
    e.loading = true; e.error = null;
    this.render();
    try {
      if (mp === 'wb') {
        const stores = await wbDb.getStores();
        const store = stores.find(s => s.id === storeId);
        if (!store) throw new Error('Магазин WB не найден');
        const chats = await wbApi.getChats(store.feedback_api_key || store.api_key);
        e.chats = chats.map((c: WbChat): UnifiedChat => ({
          id: c.chatId, mp: 'wb', storeId, storeName: e.storeName,
          title: c.clientId ? `Покупатель ${c.clientId}` : 'Покупатель',
          lastMessage: c.lastMessageText, lastTime: c.lastMessageTime,
          unread: c.unreadCount, replySign: c.replySign, empty: false,
        }));
      } else if (mp === 'ozon') {
        const stores = await ozonDb.getStores();
        const store = stores.find(s => s.id === storeId);
        if (!store) throw new Error('Магазин Ozon не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const chats = await ozonApi.getChatList(creds, { limit: 100 });
        // chat_type приходит в верхнем регистре (BUYER_SELLER / UNSPECIFIED / SELLER_SUPPORT / SELLER_API_UPDATES).
        // Старые чаты (до введения типизации) помечены UNSPECIFIED, но это тоже переписки с покупателями —
        // исключаем только служебные чаты поддержки и системные уведомления.
        const HIDDEN_TYPES = new Set(['SELLER_SUPPORT', 'SELLER_API_UPDATES']);
        const filtered = chats.filter((c: OzonChat) => !HIDDEN_TYPES.has((c.chat_type ?? '').toUpperCase()));
        // Ozon не отдаёт имя покупателя — показываем хвост chat_id как стабильный идентификатор.
        e.chats = filtered.map((c: OzonChat): UnifiedChat => ({
          id: c.chat_id, mp: 'ozon', storeId, storeName: e.storeName,
          title: `Покупатель #${c.chat_id.slice(-8)}`,
          lastMessage: '', lastTime: c.updated_at ?? c.created_at ?? '',
          unread: c.unread_count,
          // Скрываем чат, пока не подгрузим превью и не убедимся, что в нём есть
          // настоящее сообщение — иначе мелькают пустые автосозданные чаты.
          empty: true,
        }));
        // /v3/chat/list не отдаёт текст последнего сообщения — подгружаем превью
        // отдельными запросами в фоне (не блокируя отображение списка чатов).
        this.loadOzonPreviews(e, creds);
      } else {
        const stores = await yandexDb.getStores();
        const store = stores.find(s => s.id === storeId);
        if (!store) throw new Error('Магазин Яндекс.Маркет не найден');
        if (!store.campaign_id) throw new Error('Не задан campaign_id для магазина ЯМ');
        const chats = await yandexApi.getChats(store.api_key, store.campaign_id);
        e.chats = chats.map((c: YandexChat): UnifiedChat => ({
          id: c.chatId, mp: 'yandex', storeId, storeName: e.storeName,
          title: c.topic || (c.orderId ? `Заказ ${c.orderId}` : 'Покупатель'),
          lastMessage: c.lastMessageText, lastTime: c.lastMessageTime,
          unread: c.unreadCount,
          // Если последнее сообщение уже известно — чат сразу видимый, иначе скрываем
          // до подгрузки превью (см. loadYandexPreviews).
          empty: !c.lastMessageText,
        }));
        // Список чатов Яндекс.Маркета не всегда отдаёт lastMessage — подгружаем превью
        // последнего сообщения отдельными запросами в фоне (не блокируя отображение списка чатов).
        this.loadYandexPreviews(e, store.api_key, store.campaign_id);
      }
      e.chats.sort((a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime());
      e.loaded = true;
    } catch (err: unknown) {
      e.error = (err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) ?? 'Ошибка загрузки чатов';
    }
    e.loading = false;
    this.render();
  }

  /** Фоновая подгрузка превью последнего сообщения для чатов Ozon (не блокирует список). */
  private async loadOzonPreviews(e: StoreEntry, creds: { client_id: string; api_key: string }): Promise<void> {
    const chats = e.chats;
    const CONCURRENCY = 8;
    let nextIdx = 0;
    let completed = 0;
    let previewErrors = 0;
    const worker = async () => {
      while (nextIdx < chats.length) {
        const chat = chats[nextIdx++];
        try {
          const msgs = await ozonApi.getChatHistory(creds, chat.id, 1);
          const last = msgs[msgs.length - 1];
          if (last) {
            chat.lastMessage = last.text || (last.attachments?.length ? `${I.paperclip('', 14)} Фото` : '');
            if (!chat.lastTime && last.created_at) chat.lastTime = last.created_at;
          }
          // Ozon создаёт чат автоматически на каждый заказ — показываем его только
          // если нашли настоящее сообщение (текст или вложение), иначе он остаётся скрытым.
          chat.empty = !chat.lastMessage;
        } catch (err) {
          if (previewErrors++ === 0) debug.warn('[Ozon chat] не удалось загрузить превью последнего сообщения:', err);
        }
        // Обновляем список постепенно, не дожидаясь загрузки всех превью — так
        // чаты «появляются» с превью по мере загрузки, а не все разом в конце.
        // Используем точечное обновление (refreshChatList), а не полный render(),
        // чтобы не сбрасывать открытую переписку и заметку, которую пользователь печатает.
        if (++completed % 5 === 0) this.refreshChatList();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chats.length) }, worker));
    this.refreshChatList();
  }

  /** Фоновая подгрузка превью последнего сообщения для чатов Яндекс.Маркета (не блокирует список). */
  private async loadYandexPreviews(e: StoreEntry, apiKey: string, campaignId: number): Promise<void> {
    const toFill = e.chats.filter(c => !c.lastMessage);
    const CONCURRENCY = 5;
    let nextIdx = 0;
    let completed = 0;
    let previewErrors = 0;
    const worker = async () => {
      while (nextIdx < toFill.length) {
        const chat = toFill[nextIdx++];
        try {
          const msgs = await yandexApi.getChatHistory(apiKey, campaignId, chat.id, undefined, 1);
          const last = msgs[msgs.length - 1];
          if (last) {
            chat.lastMessage = last.text || (last.attachments?.length ? `${I.paperclip('', 14)} Фото` : '');
            if (!chat.lastTime && last.createdAt) chat.lastTime = last.createdAt;
          }
          // Показываем чат, только если нашли настоящее сообщение — иначе он
          // остаётся скрытым как пустой автосозданный чат.
          chat.empty = !chat.lastMessage;
        } catch (err) {
          if (previewErrors++ === 0) debug.warn('[Yandex chat] не удалось загрузить превью последнего сообщения:', err);
        }
        if (++completed % 5 === 0) this.refreshChatList();
      }
    };
    if (toFill.length === 0) return;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toFill.length) }, worker));
    this.refreshChatList();
  }

  /** Точечно обновляет только список чатов (без полного render), чтобы не сбрасывать
   * открытую переписку, заметку в textarea и фокус во время фоновой подгрузки превью. */
  private refreshChatList(): void {
    const el = document.getElementById('chat-list-items');
    if (el) el.innerHTML = this.renderChatList();
    else this.render();
  }

  async openChat(chatId: string): Promise<void> {
    this.activeChatId = chatId;
    this.messages = [];
    this.messagesError = null;
    this.messagesLoading = true;
    this.ozonCreds = null;
    this.pendingAttachment = null;
    this.notesOpen = false;
    this.render();

    const e = this.activeEntry;
    const chat = e?.chats.find(c => c.id === chatId);
    if (!e || !chat) { this.messagesLoading = false; this.render(); return; }

    try {
      if (e.mp === 'wb') {
        const store = (await wbDb.getStores()).find(s => s.id === e.storeId);
        if (!store) throw new Error('Магазин не найден');
        const msgs = await wbApi.getChatMessages(store.feedback_api_key || store.api_key, chatId);
        if (this.activeChatId !== chatId) return;
        this.messages = msgs.map((m: WbChatMessage): UnifiedMessage => ({
          id: m.messageId, fromMe: m.sender !== 'client',
          text: m.text, time: m.createdAt,
        }));
      } else if (e.mp === 'ozon') {
        const store = (await ozonDb.getStores()).find(s => s.id === e.storeId);
        if (!store) throw new Error('Магазин не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        this.ozonCreds = creds;
        const msgs = await ozonApi.getChatHistory(creds, chatId, 100);
        if (this.activeChatId !== chatId) return;
        this.messages = msgs.map((m: OzonChatMessage): UnifiedMessage => ({
          id: m.message_id, fromMe: m.user_type === 'Seller',
          attachments: m.attachments, text: m.text, time: m.created_at,
        }));
        // Ozon не отдаёт имя покупателя — если в истории есть номер заказа, используем его как заголовок чата.
        const orderNumber = msgs.find(m => m.orderNumber)?.orderNumber;
        if (orderNumber) chat.title = `Заказ ${orderNumber}`;
        ozonApi.markChatRead(creds, chatId).catch((e) => debug.warn('[ChatsModule] swallowed error', e));
      } else {
        const store = (await yandexDb.getStores()).find(s => s.id === e.storeId);
        if (!store) throw new Error('Магазин не найден');
        if (!store.campaign_id) throw new Error('Не задан campaign_id для магазина ЯМ');
        const msgs = await yandexApi.getChatHistory(store.api_key, store.campaign_id, chatId);
        if (this.activeChatId !== chatId) return;
        this.messages = msgs.map((m: YandexChatMessage): UnifiedMessage => ({
          id: m.messageId, fromMe: m.fromSeller, isSystem: m.isSystem, senderLabel: m.senderLabel,
          attachments: m.attachments, text: m.text, time: m.createdAt,
        }));
      }
      // Сбросить счётчик непрочитанных в локальном списке
      chat.unread = 0;
    } catch (err: unknown) {
      if (this.activeChatId !== chatId) return;
      this.messagesError = (err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) ?? 'Ошибка загрузки сообщений';
    }
    if (this.activeChatId !== chatId) return;
    this.messagesLoading = false;
    this.shouldScrollToBottom = true;
    this.render();
  }

  async sendMessage(): Promise<void> {
    const ta = document.getElementById('chat-msg-input') as HTMLTextAreaElement | null;
    const text = ta?.value.trim() || '';
    const attachment = this.pendingAttachment;
    if ((!text && !attachment) || !this.activeChatId || this.sending) return;

    const e = this.activeEntry;
    if (!e) return;
    const activeChat = e.chats.find(c => c.id === this.activeChatId);

    this.sending = true;
    this.render();
    try {
      if (e.mp === 'wb') {
        const store = (await wbDb.getStores()).find(s => s.id === e.storeId);
        if (!store) throw new Error('Магазин не найден');
        const apiKey = store.feedback_api_key || store.api_key;
        const replySign = activeChat?.replySign || '';
        if (attachment) {
          await wbApi.sendChatFile(apiKey, replySign, attachment.file, text || undefined);
        } else {
          await wbApi.sendChatMessage(apiKey, replySign, text);
        }
      } else if (e.mp === 'ozon') {
        const store = (await ozonDb.getStores()).find(s => s.id === e.storeId);
        if (!store) throw new Error('Магазин не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        if (attachment) {
          await ozonApi.sendChatFile(creds, this.activeChatId, { name: attachment.name, base64: attachment.base64 });
        }
        if (text) {
          await ozonApi.sendChatMessage(creds, this.activeChatId, text);
        }
      } else {
        if (attachment) throw new Error('Яндекс.Маркет не поддерживает отправку файлов через API');
        const store = (await yandexDb.getStores()).find(s => s.id === e.storeId);
        if (!store) throw new Error('Магазин не найден');
        if (!store.campaign_id) throw new Error('Не задан campaign_id для магазина ЯМ');
        await yandexApi.sendChatMessage(store.api_key, store.campaign_id, this.activeChatId, text);
      }
      this.messages.push({
        id: `local-${Date.now()}`, fromMe: true, text,
        attachments: attachment ? [{ name: attachment.name, url: attachment.dataUrl }] : undefined,
        time: new Date().toISOString(),
      });
      this.shouldScrollToBottom = true;
      if (ta) ta.value = '';
      this.pendingAttachment = null;
    } catch (err: unknown) {
      const msg = String((err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) ?? err);
      const friendly = /premium plus subscription/i.test(msg)
        ? 'Отправка сообщений в чат Ozon доступна только с подпиской Premium Plus'
        : 'Ошибка отправки: ' + msg;
      try { window.app?.toast?.(friendly, 'error'); } catch (e) { debug.warn('[ChatsModule] swallowed error', e); }
    }
    this.sending = false;
    this.render();
    setTimeout(() => document.getElementById('chat-msg-input')?.focus(), 50);
  }

  private get activeEntry(): StoreEntry | null {
    return this.entries.find(e => e.mp === this.activeMp && e.storeId === this.activeStoreId) ?? null;
  }

  private get filteredChats(): UnifiedChat[] {
    const e = this.activeEntry;
    if (!e) return [];
    let list = e.chats.filter(c => !c.empty);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(c => c.title.toLowerCase().includes(q) || c.lastMessage.toLowerCase().includes(q));
    }
    return list;
  }

  private totalUnread(mp: Mp): number {
    return this.entries.filter(e => e.mp === mp).reduce((s, e) => s + e.chats.reduce((s2, c) => s2 + c.unread, 0), 0);
  }

  private mpHasStores(mp: Mp): boolean {
    return this.entries.some(e => e.mp === mp);
  }

  private fmtTime(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  /** Время сообщения HH:MM — всегда показывается, независимо от даты. */
  private fmtMsgTime(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  /** Подпись для разделителя дат: «Сегодня», «Вчера» или «20 мая 2026». */
  private fmtDateLabel(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Сегодня';
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString('ru-RU', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  }

  render(): void {
    const ae = this.activeEntry;

    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;background:var(--bg2)">

        <!-- TOP BAR -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;
          background:var(--bg);border-bottom:1px solid var(--border);gap:12px;flex-shrink:0">
          <div style="display:flex;align-items:center;gap:10px">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                fill="${MP_COLOR[this.activeMp]}" opacity=".15" stroke="${MP_COLOR[this.activeMp]}" stroke-width="1.5"/>
            </svg>
            <span style="font-size:18px;font-weight:700;color:var(--text)">Чаты</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${helpBtn('chats')}
            ${ae && !ae.loading ? `
              <button onclick="window.chatsModule.loadChats('${this.activeMp}','${this.activeStoreId}')"
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
            const cnt = this.totalUnread(mp);
            const mpName = mp === 'wb' ? 'Wildberries' : mp === 'ozon' ? 'Ozon' : 'Яндекс.Маркет';
            return `
              <button onclick="${hasStores ? `window.chatsModule.selectMp('${mp}')` : ''}"
                style="display:flex;align-items:center;gap:7px;padding:8px 14px;border-radius:10px;cursor:${hasStores ? 'pointer' : 'default'};
                  white-space:nowrap;border:1.5px solid ${active ? MP_COLOR[mp] : 'var(--border)'};
                  background:${active ? mpBg(mp) : 'var(--bg)'};font-size:13px;font-weight:${active ? '700' : '500'};
                  color:${active ? MP_COLOR[mp] : hasStores ? 'var(--text)' : 'var(--text2)'};
                  opacity:${hasStores ? '1' : '.35'};transition:all .15s">
                <span style="display:inline-flex;align-items:center;justify-content:center;
                  width:20px;height:20px;border-radius:5px;background:${MP_COLOR[mp]};
                  font-size:8px;font-weight:900;color:#fff;font-family:Arial">${MP_LABEL[mp]}</span>
                ${mpName}
                ${cnt > 0 ? `<span style="background:#dc2626;color:#fff;font-size:10px;font-weight:700;
                  padding:1px 6px;border-radius:20px;line-height:1.4">${cnt}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>

        ${this.storesError ? `
          <div style="padding:10px 24px;background:rgba(239,68,68,.08);border-bottom:1px solid rgba(239,68,68,.2);
            font-size:12px;color:#ef4444;white-space:pre-wrap;flex-shrink:0">
            Не удалось загрузить список магазинов:\n${esc(this.storesError)}
          </div>
        ` : ''}

        ${this.renderBody(ae)}
      </div>

      ${this.renderImagePreviewOverlay()}
    `;

    // Enter для отправки сообщения (Shift+Enter — перенос строки)
    const ta = document.getElementById('chat-msg-input') as HTMLTextAreaElement | null;
    if (ta) {
      ta.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          this.sendMessage();
        }
      };
    }
    // Прокрутить чат вниз (только при открытии чата / новых сообщениях, не при каждом render)
    if (this.shouldScrollToBottom) {
      const msgList = document.getElementById('chat-messages-list');
      if (msgList) msgList.scrollTop = msgList.scrollHeight;
      this.shouldScrollToBottom = false;
    }
    this.loadOzonChatImages();
  }

  /** Догружает вложения чата Ozon как blob (требуют авторизованного запроса) и подставляет в <img>. */
  private loadOzonChatImages(): void {
    const creds = this.ozonCreds;
    if (!creds) return;
    const imgs = document.querySelectorAll<HTMLImageElement>('#chat-messages-list img[data-ozon-src]');
    imgs.forEach(img => {
      const url = img.dataset.ozonSrc!;
      const cached = this.ozonImageUrls.get(url);
      if (cached) {
        img.src = cached;
        img.style.opacity = '1';
        img.onclick = () => this.openImagePreview(cached);
        return;
      }
      ozonApi.fetchChatFile(creds, url).then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        this.ozonImageUrls.set(url, blobUrl);
        img.src = blobUrl;
        img.style.opacity = '1';
        img.onclick = () => this.openImagePreview(blobUrl);
      }).catch(err => debug.warn('[Ozon chat] не удалось загрузить вложение:', err));
    });
  }

  private renderBody(ae: StoreEntry | null): string {
    const storesForMp = this.entries.filter(e => e.mp === this.activeMp);

    if (storesForMp.length === 0) return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text2)">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <div style="font-size:17px;font-weight:600">Нет магазинов ${MP_LABEL[this.activeMp]}</div>
        <div style="font-size:13px;opacity:.6">Подключите магазин в разделе «Маркетплейсы»</div>
      </div>
    `;

    return `
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        ${storesForMp.length > 1 ? `
          <div style="display:flex;gap:6px;padding:10px 24px;background:var(--bg);
            border-bottom:1px solid var(--border);flex-wrap:wrap;flex-shrink:0">
            ${storesForMp.map(e => `
              <button onclick="window.chatsModule.selectStore('${e.storeId}')"
                style="display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;cursor:pointer;
                  font-size:12px;font-weight:600;border:1.5px solid ${this.activeStoreId === e.storeId ? MP_COLOR[this.activeMp] : 'var(--border)'};
                  background:${this.activeStoreId === e.storeId ? mpBg(this.activeMp) : 'var(--bg)'};
                  color:${this.activeStoreId === e.storeId ? MP_COLOR[this.activeMp] : 'var(--text)'};transition:all .15s">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                ${esc(e.storeName)}
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
            Загружаем чаты…
          </div>
        ` : ae.error ? `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center">
            <div style="font-size:32px">${I.alertTriangle('', 32)}</div>
            <div style="font-size:14px;font-weight:600;color:var(--text)">Не удалось загрузить чаты</div>
            <div style="font-size:12px;color:var(--text2);max-width:480px;white-space:pre-wrap">${esc(ae.error)}</div>
            ${ae.mp === 'wb' ? `
              <div style="font-size:12px;color:var(--text2);max-width:480px;margin-top:6px">
                Для чатов WB нужен токен со скоупом «Вопросы и отзывы» — создайте его в
                <a href="https://seller.wildberries.ru/supplier-settings/access-to-api" target="_blank" style="color:#cb11ab">seller.wildberries.ru → Доступ к API</a>.
              </div>
            ` : ''}
            ${ae.mp === 'yandex' ? `
              <div style="font-size:12px;color:var(--text2);max-width:480px;margin-top:6px">
                Для чатов ЯМ API-ключ должен иметь право «Общение с покупателями» (communication) —
                проверьте права токена в личном кабинете Яндекс.Маркета.
              </div>
            ` : ''}
            <button onclick="window.chatsModule.loadChats('${this.activeMp}','${this.activeStoreId}')"
              style="margin-top:8px;padding:8px 18px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;font-size:13px">
              ↻ Повторить
            </button>
          </div>
        ` : `
          <div class="chat-split" data-active="${this.activeChatId ? '1' : '0'}" style="flex:1;display:flex;overflow:hidden">
            <!-- CHAT LIST -->
            <div class="chat-list-pane" style="width:300px;flex-shrink:0;border-right:1px solid var(--border);background:var(--bg);display:flex;flex-direction:column;overflow:hidden">
              <div style="padding:10px;border-bottom:1px solid var(--border)">
                <div style="position:relative">
                  <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none"
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input type="text" placeholder="Поиск по чатам…" value="${esc(this.search)}"
                    oninput="window.chatsModule.setSearch(this.value)"
                    style="width:100%;padding:7px 10px 7px 32px;border:1px solid var(--border);border-radius:8px;
                      background:var(--bg2);color:var(--text);font-size:12px;box-sizing:border-box">
                </div>
              </div>
              <div id="chat-list-items" style="flex:1;overflow-y:auto;padding:6px">
                ${this.renderChatList()}
              </div>
            </div>
            <!-- CONVERSATION -->
            <div class="chat-conv-pane" style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg2);min-width:0">
              ${this.renderConversation()}
            </div>
          </div>

          <style>
            @keyframes chat-unread-pulse {
              0%, 100% { opacity: 1; transform: scale(1); }
              50% { opacity: .5; transform: scale(.8); }
            }
            @media (max-width: 760px) {
              .chat-split[data-active="0"] .chat-conv-pane { display: none !important; }
              .chat-split[data-active="1"] .chat-list-pane { display: none !important; }
              .chat-split .chat-list-pane { width: 100% !important; border-right: none !important; }
              .chat-back-btn { display: flex !important; }
            }
          </style>
        `}
      </div>
    `;
  }

  private renderChatList(): string {
    const list = this.filteredChats;
    if (list.length === 0) return `
      <div style="padding:32px 16px;text-align:center;color:var(--text2);font-size:13px">
        Нет чатов с покупателями
      </div>
    `;
    return list.map(c => {
      const active = c.id === this.activeChatId;
      const initial = c.title.trim().charAt(0).toUpperCase() || '?';
      const meta = this.getChatMeta(c.mp, c.storeId, c.id);
      // Фон, выбранный пользователем для статуса (желтый/красный), показываем всегда —
      // он важнее подсветки активного чата, поэтому имеет приоритет над mpBg.
      const statusBg = meta.status !== 'none' ? `${STATUS_COLOR[meta.status]}40` : null;
      const idleBg = statusBg ?? (active ? mpBg(c.mp) : 'transparent');
      const accentBorder = active ? `border-left:3px solid ${MP_COLOR[c.mp]};` : `border-left:3px solid transparent;`;
      return `
        <div onclick="window.chatsModule.openChat('${c.id}')"
          style="display:flex;gap:10px;padding:10px 10px 10px 7px;border-radius:10px;cursor:pointer;margin-bottom:2px;
            ${accentBorder}background:${idleBg};transition:background .1s"
          onmouseover="if(!${active}) this.style.background='var(--bg2)'"
          onmouseout="this.style.background='${idleBg}'">
          <div style="position:relative;flex-shrink:0">
            <div style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;
              font-size:14px;font-weight:700;color:#fff;background:${MP_COLOR[c.mp]}">${esc(initial)}</div>
            ${c.unread > 0 ? `<span style="position:absolute;top:-2px;right:-2px;width:12px;height:12px;border-radius:50%;
              background:#dc2626;border:2px solid var(--bg);animation:chat-unread-pulse 1.6s ease-in-out infinite"></span>` : ''}
            ${meta.status !== 'none' ? `<span title="${meta.status === 'yellow' ? 'Не завершено' : 'Проблема'}"
              style="position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;border-radius:50%;
                background:${STATUS_COLOR[meta.status]};border:2px solid var(--bg)"></span>` : ''}
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px">
              <div style="display:flex;align-items:center;gap:4px;min-width:0">
                <div style="min-width:0;font-size:13px;font-weight:${c.unread > 0 ? '700' : '600'};color:var(--text);
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.title)}</div>
                ${copyButton(c.title, 'Копировать название')}
              </div>
              <div style="font-size:11px;color:var(--text2);flex-shrink:0">${this.fmtTime(c.lastTime)}</div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <div style="font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                ${esc(c.lastMessage) || '&nbsp;'}
              </div>
              ${c.unread > 0 ? `<span style="background:${MP_COLOR[c.mp]};color:#fff;font-size:10px;font-weight:700;
                padding:1px 6px;border-radius:20px;flex-shrink:0">${c.unread}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /** Убирает лишние пустые строки/пробелы, чтобы пузырь не «раздувался» от форматирования API. */
  private cleanText(text: string): string {
    return text
      .replace(/\r\n?/g, '\n')              // \r\n и одиночные \r -> \n (иначе остаются "пустые" переносы)
      .replace(/[\u00A0\u200B\u2000-\u200A\u202F\u3000]/g, ' ') // nbsp и невидимые пробелы -> обычный пробел
      .replace(/[ \t]+/g, ' ')              // схлопнуть повторяющиеся пробелы/табы
      .replace(/[ \t]*\n[ \t]*/g, '\n')     // убрать пробелы вокруг переносов строк
      .replace(/\n{2,}/g, '\n')             // убрать пустые строки внутри текста
      .trim();
  }

  private renderConversation(): string {
    if (!this.activeChatId) return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text2)">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <div style="font-size:13px">Выберите чат слева</div>
      </div>
    `;

    if (this.messagesLoading) return `
      <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text2);font-size:13px">
        Загружаем сообщения…
      </div>
    `;

    if (this.messagesError) return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center">
        <div style="font-size:28px">${I.alertTriangle('', 28)}</div>
        <div style="font-size:13px;color:var(--text2);max-width:420px;white-space:pre-wrap">${esc(this.messagesError)}</div>
        <button onclick="window.chatsModule.openChat('${this.activeChatId}')"
          style="margin-top:6px;padding:7px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;font-size:12px">
          ↻ Повторить
        </button>
      </div>
    `;

    const chat = this.activeEntry?.chats.find(c => c.id === this.activeChatId);
    const customerName = chat?.title || 'Покупатель';
    const customerInitial = customerName.trim().charAt(0).toUpperCase() || '?';
    const mpColor = MP_COLOR[this.activeMp];

    const IMG_RE = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i;
    const DATA_IMG_RE = /^data:image\//i;
    // Файлы чата Ozon (api-seller.ozon.ru) требуют авторизованного запроса —
    // их нельзя открыть прямым <img src>, грузим как blob после рендера (см. loadOzonChatImages).
    const OZON_FILE_RE = /^https?:\/\/api-seller\.ozon\.ru\//;
    const renderAttachments = (atts?: { name: string; url: string }[], imgRadius = '12px'): string => {
      if (!atts || atts.length === 0) return '';
      const items = atts.map(a => {
        if (!IMG_RE.test(a.url) && !IMG_RE.test(a.name) && !DATA_IMG_RE.test(a.url)) {
          return `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.06);font-size:12px;color:inherit;text-decoration:none">${I.paperclip('', 12)} ${esc(a.name || 'Файл')}</a>`;
        }
        if (OZON_FILE_RE.test(a.url)) {
          // Без авторизованного запроса картинка по прямому URL не загрузится — показываем
          // прозрачный placeholder, пока loadOzonChatImages() не подменит src на blob.
          const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
          const cached = this.ozonImageUrls.get(a.url);
          const src = cached || TRANSPARENT_PX;
          const clickUrl = (cached || a.url).replace(/'/g, "\\'");
          return `<img data-ozon-src="${esc(a.url)}" src="${esc(src)}" alt="${esc(a.name)}" onclick="window.chatsModule.openImagePreview('${clickUrl}')" style="width:160px;height:160px;border-radius:${imgRadius};display:block;object-fit:cover;background:rgba(0,0,0,.06);cursor:zoom-in${cached ? '' : ';opacity:.4'}">`;
        }
        return `<img src="${esc(a.url)}" alt="${esc(a.name)}" onclick="window.chatsModule.openImagePreview('${esc(a.url).replace(/'/g, "\\'")}')" style="width:160px;height:160px;border-radius:${imgRadius};display:block;object-fit:cover;background:rgba(0,0,0,.06);cursor:zoom-in">`;
      });
      return `<div style="display:flex;flex-wrap:wrap;gap:6px">${items.join('')}</div>`;
    };

    // Группируем последовательные сообщения одного отправителя — компактнее, как в мессенджерах.
    const sameGroup = (a: UnifiedMessage, b: UnifiedMessage): boolean =>
      a.fromMe === b.fromMe && !!a.isSystem === !!b.isSystem && (a.senderLabel || '') === (b.senderLabel || '')
      && !!a.time && !!b.time && Math.abs(new Date(a.time).getTime() - new Date(b.time).getTime()) < 5 * 60 * 1000;

    let lastDay = '';
    const itemsHtml = this.messages.map((m, i) => {
      const prev = this.messages[i - 1];
      const next = this.messages[i + 1];
      const day = m.time ? new Date(m.time).toDateString() : '';

      let divider = '';
      if (day && day !== lastDay) {
        divider = `
          <div style="display:flex;align-items:center;gap:10px;margin:16px 0 10px">
            <div style="flex:1;height:1px;background:var(--border)"></div>
            <span style="font-size:11px;font-weight:700;color:var(--text2);background:var(--bg2);
              padding:3px 14px;border:1px solid var(--border);border-radius:20px;white-space:nowrap">${this.fmtDateLabel(m.time)}</span>
            <div style="flex:1;height:1px;background:var(--border)"></div>
          </div>
        `;
        lastDay = day;
      }

      const isFirst = !prev || day !== (prev.time ? new Date(prev.time).toDateString() : '') || !sameGroup(prev, m);
      const isLast = !next || day !== (next.time ? new Date(next.time).toDateString() : '') || !sameGroup(m, next);
      const groupGap = isFirst ? '10px' : '3px';

      if (m.isSystem) {
        // Собираем содержимое пузыря без лишних переносов/отступов между блоками —
        // иначе при white-space:pre-wrap они рендерятся как пустые строки.
        const sysParts: string[] = [];
        if (m.text) sysParts.push(`ⓘ ${esc(this.cleanText(m.text))}`);
        if (m.attachments?.length) sysParts.push(`<div style="display:flex;justify-content:center;${m.text ? 'margin-top:6px' : ''}">${renderAttachments(m.attachments)}</div>`);
        sysParts.push(`<div style="font-size:10px;opacity:.6;margin-top:4px">${this.fmtMsgTime(m.time)}</div>`);
        return divider + `
          <div style="display:flex;justify-content:center;margin-top:${groupGap}">
            <div style="max-width:80%;box-sizing:border-box;padding:7px 14px;border-radius:12px;font-size:11.5px;line-height:1.5;
              text-align:center;white-space:pre-wrap;word-break:break-word;
              background:var(--bg);color:var(--text2);border:1px solid var(--border)">${sysParts.join('')}</div>
          </div>
        `;
      }

      // «Хвостик» только у последнего сообщения в группе.
      const tailRadius = m.fromMe ? '18px 18px 4px 18px' : '18px 18px 18px 4px';
      const midRadius = '18px';
      const radius = isLast ? tailRadius : midRadius;

      const avatarHtml = !m.fromMe && isLast ? `
              <div style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                font-size:11px;font-weight:700;color:#fff;background:${m.senderLabel ? 'var(--text2)' : mpColor}">${m.senderLabel ? 'МП' : esc(customerInitial)}</div>
            ` : '';

      // Сообщение-«только вложения» (без текста) рисуем без пузыря — просто
      // картинки/файлы со временем под ними, как в обычных мессенджерах.
      const isMediaOnly = !m.text && !!m.attachments?.length;

      // Собираем содержимое пузыря без лишних переносов/отступов между блоками —
      // иначе при white-space:pre-wrap они рендерятся как пустые строки внутри пузыря.
      const bubbleParts: string[] = [];
      if (m.text) bubbleParts.push(esc(this.cleanText(m.text)));
      if (m.attachments?.length) bubbleParts.push(`<div style="${m.text ? 'margin-top:6px' : ''}">${renderAttachments(m.attachments, isMediaOnly ? radius : '12px')}</div>`);
      if (!isMediaOnly) bubbleParts.push(`<div style="font-size:10px;opacity:${m.fromMe ? '.8' : '.6'};margin-top:3px;text-align:right">${this.fmtMsgTime(m.time)}</div>`);

      const bubbleStyle = isMediaOnly
        ? `max-width:400px;box-sizing:border-box;border-radius:${radius};font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;`
        : `max-width:400px;box-sizing:border-box;padding:8px 12px;border-radius:${radius};font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;${m.fromMe
            ? `background:linear-gradient(135deg, ${mpColor}, ${mpColor}dd);color:#fff;`
            : `background:var(--bg);color:var(--text);border:1px solid var(--border);`}box-shadow:0 1px 2px rgba(0,0,0,.05);`;

      const timeHtml = isMediaOnly
        ? `<div style="font-size:10px;opacity:.6;color:var(--text2);margin-top:3px;${m.fromMe ? 'text-align:right' : 'text-align:left'}">${this.fmtMsgTime(m.time)}</div>`
        : '';

      return divider + `
        <div style="display:flex;align-items:flex-end;gap:8px;margin-top:${groupGap};flex-direction:${m.fromMe ? 'row-reverse' : 'row'}">
          <div style="width:26px;flex-shrink:0">${avatarHtml}</div>
          <div style="max-width:72%;min-width:0;display:flex;flex-direction:column;align-items:${m.fromMe ? 'flex-end' : 'flex-start'}">
            ${isFirst && !m.fromMe ? `<div style="font-size:11px;font-weight:600;color:var(--text2);margin:0 6px 3px">${esc(m.senderLabel || customerName)}</div>` : ''}
            <div style="${bubbleStyle}">${bubbleParts.join('')}</div>${timeHtml}
          </div>
        </div>
      `;
    }).join('');

    const chatMeta = this.activeStoreId ? this.getChatMeta(this.activeMp, this.activeStoreId, this.activeChatId) : { status: 'none' as ChatStatus, note: '' };
    const flagBtn = (status: Exclude<ChatStatus, 'none'>, title: string): string => {
      const isOn = chatMeta.status === status;
      return `
        <button onclick="window.chatsModule.setChatStatus('${status}')" title="${title}"
          style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex-shrink:0;
            border:1px solid ${isOn ? STATUS_COLOR[status] : 'var(--border)'};border-radius:50%;
            background:${isOn ? STATUS_COLOR[status] + '22' : 'var(--bg)'};color:${STATUS_COLOR[status]};cursor:pointer;font-size:14px">
          ${status === 'yellow' ? I.yandex('', 14) : I.alertCircle('', 14)}
        </button>
      `;
    };

    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);
        background:var(--bg);flex-shrink:0">
        <button class="chat-back-btn" onclick="window.chatsModule.backToList()"
          style="display:none;align-items:center;justify-content:center;width:32px;height:32px;flex-shrink:0;
            border:none;border-radius:50%;background:transparent;color:var(--text);cursor:pointer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div style="width:38px;height:38px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
          font-size:14px;font-weight:700;color:#fff;background:${mpColor}">${esc(customerInitial)}</div>
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:4px;min-width:0">
            <span style="min-width:0;font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(customerName)}</span>
            ${copyButton(customerName, 'Копировать имя клиента')}
          </div>
          <div style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:5px">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:4px;
              background:${mpColor};font-size:7px;font-weight:900;color:#fff;font-family:Arial">${MP_LABEL[this.activeMp]}</span>
            ${esc(chat?.storeName ?? '')}
            ${chat?.storeName ? copyButton(chat.storeName, 'Копировать название магазина') : ''}
          </div>
        </div>
        ${flagBtn('yellow', 'Не завершено — пометить желтым')}
        ${flagBtn('red', 'Проблема — пометить красным')}
        <button onclick="window.chatsModule.toggleNotes()" title="Заметка к чату"
          style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex-shrink:0;
            border:1px solid ${this.notesOpen || chatMeta.note ? mpColor : 'var(--border)'};border-radius:50%;
            background:${this.notesOpen ? mpBg(this.activeMp) : 'var(--bg)'};color:${chatMeta.note ? mpColor : 'var(--text2)'};cursor:pointer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button onclick="window.chatsModule.openChat('${this.activeChatId}')"
          title="Обновить переписку"
          style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex-shrink:0;
            border:1px solid var(--border);border-radius:50%;background:var(--bg);color:var(--text2);cursor:pointer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
        </button>
      </div>
      ${this.notesOpen ? `
        <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg);flex-shrink:0">
          <textarea placeholder="Личная заметка к чату (видна только вам)…" rows="2"
            oninput="window.chatsModule.setChatNote(this.value)"
            style="width:100%;resize:vertical;padding:8px 12px;border:1px solid var(--border);border-radius:8px;
              background:var(--bg2);color:var(--text);font-size:12.5px;font-family:inherit;box-sizing:border-box">${esc(chatMeta.note)}</textarea>
        </div>
      ` : ''}
      <div id="chat-messages-list" style="flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column">
        ${this.messages.length === 0 ? `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text2)">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <div style="font-size:13px">Нет сообщений</div>
          </div>
        ` : itemsHtml}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;padding:12px 16px calc(12px + 90px) 16px;border-top:1px solid var(--border);background:var(--bg);flex-shrink:0">
        ${this.pendingAttachment ? `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg2);max-width:280px">
            ${this.pendingAttachment.mime.startsWith('image/')
              ? `<img src="${esc(this.pendingAttachment.dataUrl)}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;flex-shrink:0">`
              : `<span style="font-size:16px;flex-shrink:0">${I.paperclip('', 16)}</span>`}
            <span style="font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">${esc(this.pendingAttachment.name)}</span>
            <button onclick="window.chatsModule.clearAttachment()" title="Убрать вложение"
              style="display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;
                border:none;border-radius:50%;background:var(--border);color:var(--text2);cursor:pointer;font-size:13px;line-height:1">×</button>
          </div>
        ` : ''}
        <div style="display:flex;gap:8px;align-items:flex-end">
          <input type="file" id="chat-attach-input" style="display:none" accept="image/*,.pdf,.doc,.docx"
            onchange="window.chatsModule.handleAttachmentSelect(this)">
          <button onclick="document.getElementById('chat-attach-input').click()"
            title="${this.activeMp === 'yandex' ? 'Яндекс.Маркет не поддерживает отправку файлов' : 'Прикрепить файл'}"
            ${this.activeMp === 'yandex' || this.sending ? 'disabled' : ''}
            style="display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex-shrink:0;
              border:1px solid var(--border);border-radius:50%;background:var(--bg2);color:var(--text2);
              cursor:${this.activeMp === 'yandex' ? 'default' : 'pointer'};opacity:${this.activeMp === 'yandex' ? '.4' : '1'}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <textarea id="chat-msg-input" placeholder="Напишите сообщение… (Enter — отправить, Shift+Enter — новая строка)"
            rows="1" ${this.sending ? 'disabled' : ''}
            style="flex:1;resize:none;padding:10px 16px;border:1px solid var(--border);border-radius:20px;
              background:var(--bg2);color:var(--text);font-size:13.5px;font-family:inherit;max-height:120px"></textarea>
          <button onclick="window.chatsModule.sendMessage()" ${this.sending ? 'disabled' : ''}
            style="display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex-shrink:0;
              border:none;border-radius:50%;background:${mpColor};
              color:#fff;cursor:${this.sending ? 'default' : 'pointer'};
              opacity:${this.sending ? '.6' : '1'}">
            ${this.sending ? '…' : `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>`}
          </button>
        </div>
      </div>
    `;
  }
}
