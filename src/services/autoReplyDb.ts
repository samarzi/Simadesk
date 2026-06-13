/**
 * autoReplyDb — управление шаблонами авто-ответов на отзывы.
 *
 * Хранение в localStorage:
 *   - enabled: включён ли авто-ответ (вкл/выкл по рейтингу)
 *   - templates: список шаблонов, привязанных к диапазону звёзд
 *
 * При срабатывании из всех подходящих шаблонов выбирается случайный —
 * чтобы покупатели не получали одинаковые ответы.
 */

export interface ReplyTemplate {
  id: string;
  /** К каким рейтингам применяется шаблон (например [5] или [4,5]) */
  ratings: number[];
  text: string;
  createdAt: string;
}

export interface AutoReplySettings {
  enabled: boolean;                          // мастер-выключатель
  enabledByRating: Record<number, boolean>;  // 1..5 — какие рейтинги авто-отвечать
  /** Маркетплейсы для применения авто-ответа */
  enabledByMp: { wb: boolean; ozon: boolean; yandex: boolean };
}

const STORAGE_KEY = 'auto_reply_v1';

interface Stored {
  settings: AutoReplySettings;
  templates: ReplyTemplate[];
}

const DEFAULT_SETTINGS: AutoReplySettings = {
  enabled: false,
  enabledByRating: { 1: false, 2: false, 3: false, 4: true, 5: true },
  enabledByMp: { wb: true, ozon: true, yandex: true },
};

const DEFAULT_TEMPLATES: ReplyTemplate[] = [
  {
    id: 'def-5-1', ratings: [5],
    text: 'Большое спасибо за высокую оценку! Очень рады, что товар вам понравился. Будем ждать вас снова! 😊',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'def-5-2', ratings: [5],
    text: 'Благодарим вас за прекрасный отзыв! Ваше мнение очень важно для нас. Хорошего дня!',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'def-5-3', ratings: [5],
    text: 'Спасибо, что выбрали нас! Рады, что заказ оправдал ожидания. До новых встреч!',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'def-4-1', ratings: [4],
    text: 'Спасибо за ваш отзыв! Рады, что товар вам понравился. Мы постоянно работаем над качеством — будем стараться ещё лучше!',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'def-4-2', ratings: [4],
    text: 'Благодарим за обратную связь! Учтём ваши пожелания в работе. Ждём вас снова.',
    createdAt: new Date().toISOString(),
  },
];

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { settings: { ...DEFAULT_SETTINGS }, templates: [...DEFAULT_TEMPLATES] };
    const parsed = JSON.parse(raw);
    return {
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings,
        enabledByRating: { ...DEFAULT_SETTINGS.enabledByRating, ...parsed.settings?.enabledByRating },
        enabledByMp: { ...DEFAULT_SETTINGS.enabledByMp, ...parsed.settings?.enabledByMp } },
      templates: Array.isArray(parsed.templates) ? parsed.templates : [...DEFAULT_TEMPLATES],
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, templates: [...DEFAULT_TEMPLATES] };
  }
}

function save(data: Stored): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const autoReplyDb = {
  getSettings(): AutoReplySettings { return load().settings; },
  getTemplates(): ReplyTemplate[] { return load().templates; },

  setSettings(s: Partial<AutoReplySettings>): void {
    const data = load();
    data.settings = { ...data.settings, ...s };
    save(data);
  },

  addTemplate(t: Omit<ReplyTemplate, 'id' | 'createdAt'>): ReplyTemplate {
    const data = load();
    const nt: ReplyTemplate = { ...t, id: `t-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, createdAt: new Date().toISOString() };
    data.templates.push(nt);
    save(data);
    return nt;
  },

  updateTemplate(id: string, updates: Partial<ReplyTemplate>): void {
    const data = load();
    const idx = data.templates.findIndex(t => t.id === id);
    if (idx === -1) return;
    data.templates[idx] = { ...data.templates[idx], ...updates };
    save(data);
  },

  deleteTemplate(id: string): void {
    const data = load();
    data.templates = data.templates.filter(t => t.id !== id);
    save(data);
  },

  /**
   * Выбирает случайный шаблон для указанного рейтинга.
   * Возвращает null, если нет подходящих или авто-ответ выключен.
   */
  pickTemplateFor(rating: number, mp: 'wb' | 'ozon' | 'yandex'): ReplyTemplate | null {
    const { settings, templates } = load();
    if (!settings.enabled) return null;
    if (!settings.enabledByRating[rating]) return null;
    if (!settings.enabledByMp[mp]) return null;
    const candidates = templates.filter(t => t.ratings.includes(rating));
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  },

  reset(): void {
    localStorage.removeItem(STORAGE_KEY);
  },
};
