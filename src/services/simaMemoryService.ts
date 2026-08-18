/**
 * Сервис памяти Симы — структурированные знания о маркетплейсах.
 * Память загружается один раз при старте и кешируется в памяти.
 * Поиск происходит на клиенте по ключевым словам — без лишних API-вызовов.
 */

import { REST_URL, getAuthHeaders } from './dbClient';

export interface SimaMemoryEntry {
  id: string;
  mp: string;
  category: string;
  title: string;
  content: string;
  keywords: string[];
  updated_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  fees:         'Комиссии и тарифы',
  logistics:    'Логистика и доставка',
  requirements: 'Требования к товарам',
  promotions:   'Акции и продвижение',
  tech:         'Технические изменения',
  payments:     'Выплаты и финансы',
  other:        'Прочее',
};

export const MEMORY_CATEGORY_LABELS = CATEGORY_LABELS;

const MP_KEYWORDS: Record<string, string[]> = {
  wb:      ['wb', 'wildberries', 'вб', 'вайлдберриз', 'wildberry'],
  ozon:    ['ozon', 'озон'],
  yandex:  ['яндекс', 'yandex', 'маркет', 'ям', 'market'],
  general: ['маркетплейс', 'площадка'],
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  fees:         ['комиссия', 'тариф', 'процент', 'сбор', 'ставка', 'fee'],
  logistics:    ['логистика', 'доставка', 'склад', 'фбо', 'фбс', 'приёмка', 'хранение', 'возврат', 'коробка'],
  requirements: ['требования', 'правила', 'маркировка', 'сертификат', 'документ', 'запрет', 'ограничение'],
  promotions:   ['акция', 'скидка', 'продвижение', 'реклама', 'баллы', 'кешбэк', 'промо'],
  tech:         ['api', 'кабинет', 'личный кабинет', 'обновление', 'интеграция', 'отчёт', 'аналитика'],
  payments:     ['выплата', 'деньги', 'перечисление', 'штраф', 'удержание', 'оплата'],
};

let _cache: SimaMemoryEntry[] | null = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

export async function loadSimaMemory(force = false): Promise<SimaMemoryEntry[]> {
  if (!force && _cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  try {
    const res = await fetch(`${REST_URL}/sima_memory?select=*&order=updated_at.desc`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return _cache ?? [];
    _cache = await res.json();
    _cacheTs = Date.now();
    return _cache!;
  } catch {
    return _cache ?? [];
  }
}

export function invalidateMemoryCache(): void {
  _cache = null;
  _cacheTs = 0;
}

/**
 * Ищет релевантные записи памяти по тексту вопроса.
 * Возвращает до 5 записей, отсортированных по релевантности.
 */
export function searchMemory(query: string, memory: SimaMemoryEntry[]): SimaMemoryEntry[] {
  if (!memory.length) return [];
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);

  // Определяем упомянутые МП
  const mentionedMp = new Set<string>();
  for (const [mp, kws] of Object.entries(MP_KEYWORDS)) {
    if (kws.some(kw => q.includes(kw))) mentionedMp.add(mp);
  }

  // Определяем упомянутые категории
  const mentionedCat = new Set<string>();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => q.includes(kw))) mentionedCat.add(cat);
  }

  return memory
    .map(e => {
      let score = 0;
      const eKw = e.keywords.map(k => k.toLowerCase());
      const eTitle = e.title.toLowerCase();

      // МП совпадает
      if (mentionedMp.has(e.mp)) score += 3;
      if (mentionedMp.size === 0 && e.mp === 'general') score += 1;

      // Категория совпадает
      if (mentionedCat.has(e.category)) score += 2;

      // Ключевые слова запроса совпадают с keywords записи
      for (const w of words) {
        if (eKw.some(k => k.includes(w))) score += 2;
        if (eTitle.includes(w)) score += 1;
      }

      return { e, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(x => x.e);
}

/**
 * Формирует фрагмент для системного промпта из найденных записей.
 */
export function formatMemoryForPrompt(entries: SimaMemoryEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map(e => {
    const mpLabel = e.mp === 'general' ? 'Общее' : e.mp.toUpperCase();
    const catLabel = CATEGORY_LABELS[e.category] ?? e.category;
    return `### ${mpLabel} — ${e.title} (${catLabel})\n${e.content}`;
  });
  return `\n\n---\nИЗ ПАМЯТИ СИМЫ (актуальные знания о маркетплейсах):\n${lines.join('\n\n')}`;
}
